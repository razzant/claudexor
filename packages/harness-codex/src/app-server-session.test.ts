import type { spawnProcess } from "@claudexor/core";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reviewPath } from "./app-server-approvals.js";
import { CodexAutoReview } from "./app-server-auto-review.js";
import { runCodexAppServer } from "./app-server-run.js";
import { codexTurnSandboxPolicy } from "./app-server-session.js";
import { CODEX_CAPABILITY_PROFILE } from "./capability-profile.js";
import { assertCodexExecSpec } from "./sandbox.js";

type Request = { id?: number; method: string; params?: Record<string, unknown> };

const ECHO = {
  type: "workspaceWrite",
  writableRoots: ["/native/default"],
  networkAccess: false,
  excludeTmpdirEnvVar: true,
  excludeSlashTmp: false,
};

function spec(extra: Record<string, unknown> = {}): HarnessRunSpec {
  return HarnessRunSpec.parse({
    session_id: "session-aux",
    intent: "implement",
    prompt: "work",
    cwd: process.cwd(),
    access: "workspace_write",
    ...extra,
  });
}

/** One native turn answered by a scripted app-server; returns every client frame. */
async function run(
  runSpec: HarnessRunSpec,
  sandbox: unknown = ECHO,
): Promise<{ writes: Request[]; events: HarnessEvent[] }> {
  const writes: Request[] = [];
  const replies: string[] = [];
  let wake: (() => void) | undefined;
  let stop = false;
  const push = (message: unknown): void => {
    replies.push(JSON.stringify(message));
    wake?.();
    wake = undefined;
  };
  const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
    options.onSpawn?.({
      write(data) {
        const request = JSON.parse(data) as Request;
        writes.push(request);
        if (request.method === "initialize") push({ id: request.id, result: {} });
        else if (request.method === "thread/start" || request.method === "thread/resume")
          push({ id: request.id, result: { thread: { id: "thread-aux" }, sandbox } });
        else if (request.method === "turn/start") {
          push({ id: request.id, result: { turn: { id: "turn-aux" } } });
          push({
            method: "turn/started",
            params: { threadId: "thread-aux", turn: { id: "turn-aux" } },
          });
          push({
            method: "item/completed",
            params: {
              threadId: "thread-aux",
              turnId: "turn-aux",
              item: { type: "agentMessage", id: "msg", text: "done" },
            },
          });
          push({
            method: "turn/completed",
            params: {
              threadId: "thread-aux",
              turn: { id: "turn-aux", status: "completed", items: [] },
            },
          });
        } else if (request.method === "thread/read")
          push({ id: request.id, result: { thread: { status: { type: "idle" } } } });
        else if (request.method === "thread/goal/get")
          push({ id: request.id, result: { goal: null } });
        else if (request.method === "thread/backgroundTerminals/list")
          push({ id: request.id, result: { data: [] } });
      },
      end() {
        stop = true;
        wake?.();
      },
      closed: Promise.resolve(),
    });
    options.abortSignal?.addEventListener(
      "abort",
      () => {
        stop = true;
        wake?.();
      },
      { once: true },
    );
    while (!stop || replies.length) {
      if (replies.length) yield { type: "stdout", line: replies.shift()! };
      else await new Promise<void>((resolve) => (wake = resolve));
    }
  };
  const events: HarnessEvent[] = [];
  for await (const event of runCodexAppServer({
    bin: "codex",
    args: [],
    spec: runSpec,
    env: {},
    spawn,
    pollIntervalMs: 0,
  }))
    events.push(event);
  return { writes, events };
}

const params = (writes: Request[], method: string) =>
  writes.find((request) => request.method === method)?.params;

describe("Codex auxiliary writable roots", () => {
  it("declares the capability only for this adapter's native turn policy", () => {
    expect(CODEX_CAPABILITY_PROFILE.access_control.auxiliary_writable_roots).toBe(true);
  });

  it.each([
    ["thread/start", {}],
    ["thread/resume", { resume_session_id: "thread-aux" }],
  ])("grants through the %s turn policy while thread params stay legacy", async (method, extra) => {
    const granted = await run(
      spec({ ...extra, auxiliary_writable_roots: ["/srv/cache", "/native/default"] }),
    );
    const legacy = await run(spec(extra));
    // No writable root ever enters thread config: Codex would persist it as an
    // irrevocable runtime workspace root of the native thread.
    expect(params(granted.writes, method)).toEqual(params(legacy.writes, method));
    expect(JSON.stringify(params(granted.writes, method))).not.toContain("writable_roots");
    expect(params(granted.writes, "turn/start")).toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandboxPolicy: { ...ECHO, writableRoots: ["/native/default", "/srv/cache"] },
    });
    // Omission (and []) keeps the legacy turn byte-for-byte: native defaults,
    // and nothing a previous run granted survives into this process.
    expect(params(legacy.writes, "turn/start")).not.toHaveProperty("sandboxPolicy");
    expect(granted.events.filter((event) => event.type === "error")).toEqual([]);
  });

  it("refuses typed, before any turn, when the native thread is not workspaceWrite", async () => {
    const { writes, events } = await run(spec({ auxiliary_writable_roots: ["/srv/cache"] }), {
      type: "readOnly",
      networkAccess: false,
    });
    expect(writes.map((request) => request.method)).not.toContain("turn/start");
    expect(events.find((event) => event.type === "error")?.payload).toMatchObject({
      code: "codex_auxiliary_roots_unavailable",
    });
  });

  it("never applies a grant to a non-workspace_write spec", () => {
    expect(codexTurnSandboxPolicy(spec({ access: "readonly" }), ECHO)).toBeUndefined();
    expect(() =>
      codexTurnSandboxPolicy(spec({ access: "full", auxiliary_writable_roots: ["/srv"] }), ECHO),
    ).toThrow(/workspaceWrite/);
  });

  it("repeats the run's turn policy on an authorized auto-review retry turn", async () => {
    const sent: Request[] = [];
    const review = new CodexAutoReview({
      spec: spec({ auxiliary_writable_roots: ["/srv/cache"] }),
      threadId: () => "thread-aux",
      turnId: () => null,
      live: () => true,
    });
    const sandboxPolicy = { ...ECHO, writableRoots: ["/native/default", "/srv/cache"] };
    const retried = await review.retry(
      [{ id: "review-1", action: { type: "command", command: "uv sync", cwd: "/srv/cache" } }],
      async (method, requestParams) => {
        sent.push({ method, params: requestParams });
        return {};
      },
      async () => ({
        threadStatus: "idle",
        threadSettled: true,
        goalActive: false,
        ownedBackground: [],
      }),
      sandboxPolicy,
    );
    expect(retried).toBe(true);
    expect(params(sent, "turn/start")).toMatchObject({ sandboxPolicy });
  });

  it("offers a granted root for controller review without widening past it", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-aux-review-")));
    const workspace = join(base, "workspace");
    const cache = join(base, "cache");
    mkdirSync(workspace);
    mkdirSync(cache);
    expect(reviewPath(join(cache, "wheel"), workspace)).toBe(false);
    expect(reviewPath(join(cache, "wheel"), workspace, [cache])).toBe(true);
    expect(reviewPath(join(base, "sibling"), workspace, [cache])).toBe(false);
    expect(reviewPath("src/a.ts", workspace, [cache])).toBe(true);
  });

  it("refuses the exec transport, whose -c roots could not be revoked later", () => {
    expect(() => assertCodexExecSpec(spec())).not.toThrow();
    expect(() => assertCodexExecSpec(spec({ auxiliary_writable_roots: ["/srv/cache"] }))).toThrow(
      /app-server/,
    );
  });
});
