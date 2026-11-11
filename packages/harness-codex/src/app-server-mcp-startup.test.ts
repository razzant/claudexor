import type { spawnProcess } from "@claudexor/core";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServerController, runCodexAppServer } from "./app-server-run.js";

const THREAD = "thread-browser-start";
type Frame = Record<string, unknown>;
type Request = { id?: number; method: string; params?: Record<string, unknown> | null };

const status = (name: string, value: string, extra: Frame = {}): Frame => ({
  method: "mcpServer/startupStatus/updated",
  params: { threadId: THREAD, name, status: value, error: null, failureReason: null, ...extra },
});

/**
 * A scriptable app-server: answers the run's RPCs, holds back whatever the test
 * has not released, and records the exact order of what Claudexor wrote.
 */
function fakeAppServer(opts: {
  afterThreadReply?: Frame[];
  beforeThreadReply?: Frame[];
  beforeTurnReply?: Frame[];
  threadMethod?: string;
  threadStatus?: string;
  dieWithCode?: () => number | null;
}) {
  const writes: Request[] = [];
  const replies: string[] = [];
  let wake: (() => void) | undefined;
  let stopped = false;
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
        else if (request.method === (opts.threadMethod ?? "thread/start")) {
          for (const frame of opts.beforeThreadReply ?? []) push(frame);
          push({ id: request.id, result: { thread: { id: THREAD } } });
          for (const frame of opts.afterThreadReply ?? []) push(frame);
        } else if (request.method === "turn/start") {
          for (const frame of opts.beforeTurnReply ?? []) push(frame);
          push({ id: request.id, result: { turn: { id: "turn-1" } } });
          push({ method: "turn/started", params: { threadId: THREAD, turn: { id: "turn-1" } } });
          push({
            method: "item/completed",
            params: {
              threadId: THREAD,
              turnId: "turn-1",
              item: { type: "agentMessage", id: "m1", text: "done with what was available" },
            },
          });
          push({
            method: "turn/completed",
            params: { threadId: THREAD, turn: { id: "turn-1", status: "completed" } },
          });
        } else if (request.method === "thread/read") {
          push({
            id: request.id,
            result: { thread: { id: THREAD, status: { type: opts.threadStatus ?? "idle" } } },
          });
        } else if (request.method === "thread/goal/get") {
          push({ id: request.id, result: { goal: null } });
        } else if (request.method === "thread/backgroundTerminals/list") {
          push({ id: request.id, result: { data: [], nextCursor: null } });
        }
      },
      end() {
        stopped = true;
        wake?.();
      },
      closed: Promise.resolve(),
    });
    options.abortSignal?.addEventListener(
      "abort",
      () => {
        stopped = true;
        wake?.();
      },
      { once: true },
    );
    while (!stopped || replies.length) {
      if (replies.length) yield { type: "stdout", line: replies.shift()! };
      else {
        const code = opts.dieWithCode?.();
        if (code !== undefined && code !== null) {
          yield { type: "exit", code, signal: null, drain: "complete" } as never;
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (opts.dieWithCode) setTimeout(resolve, 5);
        });
      }
    }
  };
  return { spawn, writes, push };
}

const browserSpec = (overrides: Record<string, unknown> = {}) =>
  HarnessRunSpec.parse({
    session_id: "session-browser-start",
    intent: "implement",
    prompt: "Open the page",
    cwd: process.cwd(),
    access: "full",
    browser: { output_dir: null, headless: true },
    ...overrides,
  });

async function collect(
  iterable: AsyncIterable<HarnessEvent>,
  onEvent?: (event: HarnessEvent) => void,
): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
    onEvent?.(event);
  }
  return events;
}

const methods = (writes: Request[]): string[] => writes.map((write) => write.method);
const until = async (predicate: () => boolean): Promise<void> => {
  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 5_000, interval: 2 });
};
const startup = (events: HarnessEvent[]): HarnessEvent[] =>
  events.filter((event) => event.payload?.["code"] === "codex_browser_startup");

describe("Codex selected Browser startup (claudexor#215)", () => {
  it("holds turn/start until Browser is ready, then records it in the started run", async () => {
    const server = fakeAppServer({ afterThreadReply: [status("browser", "starting")] });
    const run = collect(
      runCodexAppServer({
        bin: "codex",
        args: [],
        spec: browserSpec(),
        env: {},
        spawn: server.spawn,
      }),
    );
    await until(() => methods(server.writes).includes("thread/start"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    // The turn is the only step that must not start before the model can see Browser.
    expect(methods(server.writes)).not.toContain("turn/start");
    server.push(status("browser", "ready"));
    const events = await run;
    expect(methods(server.writes)).toContain("turn/start");
    expect(events.map((event) => event.type).slice(0, 2)).toEqual(["started", "status"]);
    expect(startup(events)).toHaveLength(1);
    expect(startup(events)[0]?.payload).toMatchObject({
      code: "codex_browser_startup",
      status: "ready",
    });
    expect(startup(events)[0]?.text).toContain("Browser MCP ready");
    expect(events.at(-1)?.payload?.["harness_reported_error"]).toBeUndefined();
  });

  it("does not wait when Codex reported ready together with the thread reply", async () => {
    const server = fakeAppServer({
      beforeThreadReply: [status("browser", "starting"), status("browser", "ready")],
    });
    const events = await collect(
      runCodexAppServer({
        bin: "codex",
        args: [],
        spec: browserSpec(),
        env: {},
        spawn: server.spawn,
        browserStartupDeadlineMs: 60_000,
      }),
    );
    expect(startup(events)[0]?.payload?.["status"]).toBe("ready");
    expect(startup(events)[0]?.payload?.["waited_ms"]).toBeLessThan(1_000);
  });

  it.each(["failed", "cancelled"])(
    "continues the run on Browser %s, with Codex's own reason masked, and never as a run failure",
    async (outcome) => {
      const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
      const server = fakeAppServer({
        afterThreadReply: [
          status("browser", "starting"),
          status("browser", outcome, { error: `handshake closed; key ${secret}` }),
        ],
      });
      const events = await collect(
        runCodexAppServer({
          bin: "codex",
          args: [],
          spec: browserSpec(),
          env: {},
          spawn: server.spawn,
        }),
      );
      expect(methods(server.writes)).toContain("turn/start");
      const receipt = startup(events)[0];
      expect(receipt?.type).toBe("status");
      expect(receipt?.payload?.["status"]).toBe(outcome);
      expect(receipt?.text).toContain("the run continues without Browser tools");
      expect(receipt?.text).toContain("handshake closed");
      expect(JSON.stringify(receipt)).not.toContain(secret);
      expect(events.some((event) => event.type === "error")).toBe(false);
      const completed = events.at(-1);
      expect(completed?.type).toBe("completed");
      expect(completed?.aborted).toBeUndefined();
      expect(completed?.payload?.["harness_reported_error"]).toBeUndefined();
      expect(events.some((event) => event.final === true)).toBe(true);
    },
  );

  it("starts the turn at the deadline when no outcome arrives, and says so", async () => {
    const server = fakeAppServer({ afterThreadReply: [status("browser", "starting")] });
    const events = await collect(
      runCodexAppServer({
        bin: "codex",
        args: [],
        spec: browserSpec(),
        env: {},
        spawn: server.spawn,
        browserStartupDeadlineMs: 20,
      }),
    );
    expect(methods(server.writes)).toContain("turn/start");
    expect(startup(events)[0]?.payload).toMatchObject({ status: "starting" });
    expect(startup(events)[0]?.text).toContain("reported no startup result");
  });

  it("keeps what was known when the turn was allowed, whatever arrives after it", async () => {
    const server = fakeAppServer({
      afterThreadReply: [status("browser", "starting")],
      beforeTurnReply: [status("browser", "ready")],
    });
    const events = await collect(
      runCodexAppServer({
        bin: "codex",
        args: [],
        spec: browserSpec(),
        env: {},
        spawn: server.spawn,
        browserStartupDeadlineMs: 20,
      }),
    );
    expect(startup(events)).toHaveLength(1);
    expect(startup(events)[0]?.payload?.["status"]).toBe("starting");
    expect(startup(events)[0]?.text).not.toContain("ready before");
  });

  it("names a total absence of startup frames as not observed", async () => {
    const server = fakeAppServer({});
    const events = await collect(
      runCodexAppServer({
        bin: "codex",
        args: [],
        spec: browserSpec(),
        env: {},
        spawn: server.spawn,
        browserStartupDeadlineMs: 20,
      }),
    );
    expect(startup(events)[0]?.payload).toMatchObject({ status: "not_observed" });
  });

  it.each([
    ["no Browser selected", { browser: null }],
    ["web off, so Browser is not injected", { external_context_policy: "off" }],
  ])("adds no wait and no receipt with %s", async (_label, overrides) => {
    // Another server named browser in the stream must not start a wait either.
    const server = fakeAppServer({ afterThreadReply: [status("browser", "starting")] });
    const events = await collect(
      runCodexAppServer({
        bin: "codex",
        args: [],
        spec: browserSpec(overrides),
        env: {},
        spawn: server.spawn,
        browserStartupDeadlineMs: 60_000,
      }),
    );
    expect(methods(server.writes)).toContain("turn/start");
    expect(startup(events)).toHaveLength(0);
  });

  it("does not wait on other optional servers, only the selected Browser", async () => {
    const server = fakeAppServer({
      beforeThreadReply: [status("browser", "ready"), status("codex_apps", "starting")],
    });
    const events = await collect(
      runCodexAppServer({
        bin: "codex",
        args: [],
        spec: browserSpec(),
        env: {},
        spawn: server.spawn,
        browserStartupDeadlineMs: 60_000,
      }),
    );
    expect(methods(server.writes)).toContain("turn/start");
    expect(startup(events)[0]?.payload?.["status"]).toBe("ready");
    expect(JSON.stringify(startup(events))).not.toContain("codex_apps");
  });

  it("ignores a sub-agent thread's Browser frame while the root's Browser is still starting", async () => {
    const server = fakeAppServer({
      afterThreadReply: [
        status("browser", "starting"),
        {
          method: "mcpServer/startupStatus/updated",
          params: { threadId: "thread-child", name: "browser", status: "ready" },
        },
      ],
    });
    const run = collect(
      runCodexAppServer({
        bin: "codex",
        args: [],
        spec: browserSpec(),
        env: {},
        spawn: server.spawn,
      }),
    );
    await until(() => methods(server.writes).includes("thread/start"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(methods(server.writes)).not.toContain("turn/start");
    server.push(status("browser", "ready"));
    await run;
    expect(methods(server.writes)).toContain("turn/start");
  });

  it("waits the same way after thread/resume, whose startup frames arrive under the bound thread", async () => {
    const server = fakeAppServer({
      threadMethod: "thread/resume",
      afterThreadReply: [status("browser", "starting")],
    });
    const run = collect(
      runCodexAppServer({
        bin: "codex",
        args: [],
        spec: browserSpec({ resume_session_id: THREAD }),
        env: {},
        spawn: server.spawn,
      }),
    );
    await until(() => methods(server.writes).includes("thread/resume"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(methods(server.writes)).not.toContain("turn/start");
    server.push(status("browser", "ready"));
    const events = await run;
    expect(methods(server.writes)).toContain("turn/start");
    expect(startup(events)[0]?.payload?.["status"]).toBe("ready");
  });

  it("Stop during the wait ends as user_cancelled without ever starting the turn", async () => {
    const server = fakeAppServer({ afterThreadReply: [status("browser", "starting")] });
    const controller = new CodexAppServerController();
    const run = collect(
      runCodexAppServer({
        bin: "codex",
        args: [],
        spec: browserSpec(),
        env: {},
        spawn: server.spawn,
        controller,
      }),
    );
    await until(() => methods(server.writes).includes("thread/start"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stoppedAt = Date.now();
    await controller.cancel();
    const events = await run;
    expect(Date.now() - stoppedAt).toBeLessThan(5_000);
    expect(methods(server.writes)).not.toContain("turn/start");
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      aborted: true,
      payload: { code: "user_cancelled" },
    });
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("the external abort signal also stops the wait", async () => {
    const server = fakeAppServer({ afterThreadReply: [status("browser", "starting")] });
    const abort = new AbortController();
    const spec = browserSpec();
    spec.extra["abortSignal"] = abort.signal;
    const run = collect(
      runCodexAppServer({ bin: "codex", args: [], spec, env: {}, spawn: server.spawn }),
    );
    await until(() => methods(server.writes).includes("thread/start"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    abort.abort();
    const events = await run;
    expect(methods(server.writes)).not.toContain("turn/start");
    expect(events.at(-1)).toMatchObject({ aborted: true, payload: { code: "user_cancelled" } });
  });

  it("a Browser ready frame racing Stop still does not start the turn", async () => {
    const server = fakeAppServer({ afterThreadReply: [status("browser", "starting")] });
    const controller = new CodexAppServerController();
    const run = collect(
      runCodexAppServer({
        bin: "codex",
        args: [],
        spec: browserSpec(),
        env: {},
        spawn: server.spawn,
        controller,
      }),
    );
    await until(() => methods(server.writes).includes("thread/start"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cancelled = controller.cancel();
    server.push(status("browser", "ready"));
    await cancelled;
    const events = await run;
    expect(methods(server.writes)).not.toContain("turn/start");
    expect(events.at(-1)).toMatchObject({ aborted: true, payload: { code: "user_cancelled" } });
  });

  it("process loss during the wait is a terminal failure, never a hang or a started turn", async () => {
    let die: number | null = null;
    const server = fakeAppServer({
      afterThreadReply: [status("browser", "starting")],
      dieWithCode: () => die,
    });
    const run = collect(
      runCodexAppServer({
        bin: "codex",
        args: [],
        spec: browserSpec(),
        env: {},
        spawn: server.spawn,
      }),
    );
    await until(() => methods(server.writes).includes("thread/start"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    die = 1;
    const events = await run;
    expect(methods(server.writes)).not.toContain("turn/start");
    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      payload: { code: "codex_app_server_failure" },
    });
  });

  it("a native thread failure during the wait ends the wait instead of idling to the deadline", async () => {
    const server = fakeAppServer({ afterThreadReply: [status("browser", "starting")] });
    const run = collect(
      runCodexAppServer({
        bin: "codex",
        args: [],
        spec: browserSpec(),
        env: {},
        spawn: server.spawn,
        browserStartupDeadlineMs: 60_000,
      }),
    );
    await until(() => methods(server.writes).includes("thread/start"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    server.push({
      method: "thread/status/changed",
      params: { threadId: THREAD, status: { type: "systemError" } },
    });
    await until(() => methods(server.writes).includes("turn/start"));
    const events = await run;
    expect(startup(events)[0]?.text).toContain("reported no startup result");
  });

  it("a required server's failure still fails the run while Browser is still starting", async () => {
    const server = fakeAppServer({
      afterThreadReply: [
        status("browser", "starting"),
        status("required_one", "starting"),
        status("required_one", "failed", { error: "unavailable" }),
      ],
    });
    const events = await collect(
      runCodexAppServer({
        bin: "codex",
        args: [],
        spec: browserSpec({
          extra_mcp_servers: [
            { name: "required_one", command: "/bin/echo", args: [], env: {}, required: true },
          ],
        }),
        env: {},
        spawn: server.spawn,
        browserStartupDeadlineMs: 60_000,
      }),
    );
    expect(methods(server.writes)).not.toContain("turn/start");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "error",
        payload: {
          code: "required_mcp_startup_failed",
          mcp_servers: [{ name: "required_one", status: "failed" }],
        },
      }),
    );
    expect(events.at(-1)?.payload?.["harness_reported_error"]).toBe(true);
  });

  it("Stop during a required server's wait no longer hangs after the process stops", async () => {
    const server = fakeAppServer({ afterThreadReply: [status("required_one", "starting")] });
    const controller = new CodexAppServerController();
    const run = collect(
      runCodexAppServer({
        bin: "codex",
        args: [],
        spec: HarnessRunSpec.parse({
          session_id: "session-required-stop",
          intent: "implement",
          prompt: "work",
          cwd: process.cwd(),
          extra_mcp_servers: [
            { name: "required_one", command: "/bin/echo", args: [], env: {}, required: true },
          ],
        }),
        env: {},
        spawn: server.spawn,
        controller,
      }),
    );
    await until(() => methods(server.writes).includes("thread/start"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await controller.cancel();
    const events = await Promise.race([
      run,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
    ]);
    expect(events, "the run stayed parked in the required-server wait after Stop").not.toBeNull();
    expect(events?.at(-1)).toMatchObject({ aborted: true, payload: { code: "user_cancelled" } });
  });
});
