import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeOutcomeFacts } from "@claudexor/schema";
import { CLAUDEXOR_VERSION } from "@claudexor/util";
import { CliError, controlProblemError, renderCliFailure } from "./cli-error.js";
import { ENGINE_STOP_REMEDY, observedEngineSkew, recordEngineSkew } from "./engine-skew.js";
import {
  controlApiAddress,
  controlApiFetch,
  createRunEventLineFormatter,
  followRun,
  formatRunEventLine,
  handshakeControlApi,
  collectInteractionAnswers,
} from "./live.js";

/** Stub control API speaking just enough SSE for the follow contract. */
function sseServer(
  handler: (lastEventId: number, res: import("node:http").ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v2/handshake") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            protocolMajor: 3,
            compatible: true,
            operationsPath: "/v2/operations",
            engine: { version: "0.0.0-test", sha: "unknown", entry: "/test" },
          }),
        );
        return;
      }
      expect(req.url).toBe("/v2/runs/run-f/events");
      expect(req.headers["x-claudexor-protocol-major"]).toBe("3");
      const lastEventId = Number(req.headers["last-event-id"] ?? 0);
      res.writeHead(200, { "content-type": "text/event-stream" });
      handler(lastEventId, res);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as { port: number }).port });
    });
  });
}

function frame(seq: number, type: string, payload: Record<string, unknown> = {}): string {
  const ev = { seq, ts: new Date().toISOString(), run_id: "run-f", task_id: "t", type, payload };
  return `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify(ev)}\n\n`;
}

describe("claudexor follow", () => {
  let dir: string;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(realpathSync(tmpdir()), "claudexor-follow-"));
    prevConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
  });
  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = prevConfigDir;
    rmSync(dir, { recursive: true, force: true });
  });

  function writeControlApiInfo(port: number): void {
    const daemonDir = join(dir, "daemon");
    mkdirSync(daemonDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(daemonDir, "control-api.json"),
      JSON.stringify({ host: "127.0.0.1", port }),
      {
        mode: 0o600,
      },
    );
    writeFileSync(join(daemonDir, "token"), "tkn-follow", { mode: 0o600 });
  }

  it("renders per-lane browser effectiveness from the engine receipt", () => {
    expect(
      formatRunEventLine({
        type: "harness.started",
        payload: {
          harness_id: "cursor",
          attempt_id: "a02",
          external_context_policy: "auto",
          request_requirement: {
            capability: "browser",
            requested: true,
            effective: false,
            reason: "manifest_unsupported",
          },
        },
      }),
    ).toContain("browser=unavailable:manifest_unsupported");
  });

  it("renders partial Git initialization as incomplete rather than a baseline success", () => {
    expect(
      formatRunEventLine({
        type: "project.git.initialized",
        payload: {
          repo_root: "/tmp/project",
          initialized: false,
          baseline_committed: false,
          partial: true,
          failed_stage: "init",
        },
      }),
    ).toBe("git repository setup stopped during init at /tmp/project; partial metadata may remain");
  });

  it("renders deadline and operator cancellation from canonical terminal facts", () => {
    expect(
      formatRunEventLine({
        type: "run.failed",
        payload: {
          lifecycle: "cancelled",
          facts: makeOutcomeFacts("cancelled", { reason: "wall_clock_exceeded" }),
        },
      }),
    ).toBe("run ended: Time limit reached");
    expect(
      formatRunEventLine({
        type: "run.failed",
        payload: {
          lifecycle: "cancelled",
          facts: makeOutcomeFacts("cancelled", { reason: "user_cancelled" }),
        },
      }),
    ).toBe("run ended: Cancelled");
  });

  it("discloses ignored_settings as a WARNING suffix on harness.started (QA-070)", () => {
    const line = formatRunEventLine({
      type: "harness.started",
      payload: {
        harness_id: "codex",
        attempt_id: "a01",
        external_context_policy: "auto",
        ignored_settings: ["max_turns=5 (manifest capabilities.max_turns=false for codex)"],
      },
    });
    expect(line).toContain("WARNING ignored: max_turns=5");
    // An ordinary start (nothing dropped) stays quiet — no false warning.
    expect(
      formatRunEventLine({
        type: "harness.started",
        payload: { harness_id: "codex", attempt_id: "a01", external_context_policy: "auto" },
      }),
    ).not.toContain("WARNING");
  });

  it("renders zero configured gates as n/a, never a vacuous 'gates passed'", () => {
    // gatesPassed([]) === true upstream, so the payload says passed: true —
    // the wording must still not claim verification that never ran.
    expect(
      formatRunEventLine({
        type: "gate.completed",
        payload: { attempt_id: "a01", gates: [], passed: true },
      }),
    ).toBe("[a01] gates n/a (none configured)");
    expect(
      formatRunEventLine({
        type: "gate.completed",
        payload: { attempt_id: "a01", gates: [{ id: "tests", status: "passed" }], passed: true },
      }),
    ).toBe("[a01] gates passed");
    expect(
      formatRunEventLine({
        type: "gate.completed",
        payload: { attempt_id: "a01", gates: [{ id: "tests", status: "failed" }], passed: false },
      }),
    ).toBe("[a01] gates failed");
  });

  it("renders an automatic interaction expiry as elapsed time", () => {
    expect(
      formatRunEventLine({
        type: "interaction.timeout",
        payload: { harness_id: "claude", attempt_id: "a01" },
      }),
    ).toBe("[a01/claude] no answer in time — continuing with assumptions");
  });

  it("does not relabel a cancelled interaction wait as an automatic expiry", () => {
    expect(
      formatRunEventLine({
        type: "interaction.timeout",
        payload: { harness_id: "claude", attempt_id: "a01", reason: "cancelled" },
      }),
    ).toBe("[a01/claude] question wait cancelled");
  });

  it("renders a harness-withdrawn interaction without expiry or cancellation wording", () => {
    expect(
      formatRunEventLine({
        type: "interaction.withdrawn",
        payload: { harness_id: "codex", attempt_id: "a01", interaction_id: "int-1" },
      }),
    ).toBe("[a01/codex] question withdrawn by the agent — no answer needed");
  });

  it("renders plan.brief.materialized with source run + short sha (QA-046)", () => {
    expect(
      formatRunEventLine({
        type: "plan.brief.materialized",
        payload: {
          plan_run_id: "run-47882099f27b",
          sha256: "00a73aeac4e4a11b81cb2d82fb94ac7f7c1fe086ff516972ebfb28c02f358511",
          path: "context/PLAN.md",
        },
      }),
    ).toBe("plan materialized from run-47882099f27b · sha256 00a73aeac4e4 → context/PLAN.md");
  });

  it("renders run.continuation, delegation.belt.unavailable, and route.pool.degraded", () => {
    expect(
      formatRunEventLine({
        type: "run.continuation",
        payload: {
          from_attempt: "a01",
          cause: "context_capacity_exhausted",
          continuation_count: 1,
          packet_turns: 3,
        },
      }),
    ).toBe("[a01] continuing in a fresh session (context_capacity_exhausted, continuation 1)");

    expect(
      formatRunEventLine({
        type: "delegation.belt.unavailable",
        payload: {
          attempt_id: "a02",
          harness_id: "claude",
          server_name: "belt-mcp",
          reason: "mcp_server_failed_to_start",
        },
      }),
    ).toBe("[a02/claude] delegation belt unavailable (belt-mcp: mcp_server_failed_to_start)");

    expect(
      formatRunEventLine({
        type: "delegation.belt.degraded",
        payload: { harness_id: "cursor", effective: true, reason: "manifest_unsupported" },
      }),
    ).toContain("another effective Delegate lane remains");
    expect(
      formatRunEventLine({
        type: "delegation.belt.degraded",
        payload: { harness_id: "cursor", effective: false, reason: "manifest_unsupported" },
      }),
    ).toContain("continued without Delegate");

    expect(
      formatRunEventLine({
        type: "route.pool.degraded",
        payload: {
          requested_harnesses: ["claude", "codex", "cursor"],
          effective_harnesses: ["claude", "codex"],
          requested_n: 3,
          effective_n: 2,
          dropped_lanes: [{ harness_id: "cursor", stage: "readiness", detail: "logged out" }],
        },
      }),
    ).toBe("route pool degraded: 2/3 lanes (dropped cursor)");

    expect(
      formatRunEventLine({
        type: "workspace.settlement_failed",
        payload: {
          attempt_id: "a01",
          envelope_id: "env-1",
          root: "/kept/tree",
          stage: "retain",
          cause: "EACCES: permission denied",
        },
      }),
    ).toBe(
      "[a01] WARNING: workspace settlement failed (retain): EACCES: permission denied; the run outcome stands and the tree may remain at /kept/tree",
    );
  });

  it("renders workspace.prepared with a warning only when nothing was copied or a selected path was not found (#563)", () => {
    const prepared = (scope: string[], files: number, missing: string[]) =>
      formatRunEventLine({
        type: "workspace.prepared",
        payload: {
          attempt_id: "a01",
          source_root: "/work/project",
          scope_paths: scope,
          copied: { files, directories: 0, symlinks: 0 },
          missing_paths: missing,
        },
      });
    expect(prepared([], 0, [])).toBe(
      "[a01] WARNING: Isolated copy prepared from /work/project: nothing copied (no input paths were selected).",
    );
    expect(prepared(["input.txt", "new.txt"], 1, ["new.txt"])).toBe(
      '[a01] WARNING: Isolated copy prepared from /work/project: 1 file copied from "input.txt", "new.txt".' +
        ' Not found there when the copy was prepared: "new.txt" (absent in the copy; may be created as new output).',
    );
    expect(prepared(["input.txt"], 1, [])).toBe(
      '[a01] Isolated copy prepared from /work/project: 1 file copied from "input.txt".',
    );
    // A malformed payload is not rendered as a fact.
    expect(formatRunEventLine({ type: "workspace.prepared", payload: { attempt_id: "a01" } })).toBe(
      null,
    );
  });

  it("resumes after a mid-stream drop via Last-Event-ID and exits 0 on the terminal", async () => {
    let connections = 0;
    const { server, port } = await sseServer((lastEventId, res) => {
      connections += 1;
      if (connections === 1) {
        // First connection: two events, then a hard drop (no end frame).
        res.write(frame(1, "run.created"));
        res.write(frame(2, "harness.started"));
        setTimeout(() => res.destroy(), 50);
        return;
      }
      // Reconnect must carry the resume cursor.
      expect(lastEventId).toBe(2);
      res.write(frame(3, "run.completed", { lifecycle: "succeeded" }));
      res.write("event: end\ndata: {}\n\n");
      res.end();
    });
    writeControlApiInfo(port);
    try {
      const code = await followRun("run-f", true);
      expect(code).toBe(0);
      expect(connections).toBe(2);
    } finally {
      server.close();
    }
  }, 20_000);

  it.each(["failed", "cancelled", "interrupted"])(
    "exits 1 when the stream ends on a non-succeeded lifecycle (%s)",
    async (lifecycle) => {
      const eventType =
        lifecycle === "cancelled" || lifecycle === "failed" ? "run.failed" : "run.failed";
      const { server, port } = await sseServer((_last, res) => {
        res.write(frame(1, eventType, { lifecycle }));
        res.write("event: end\ndata: {}\n\n");
        res.end();
      });
      writeControlApiInfo(port);
      try {
        expect(await followRun("run-f", true)).toBe(1);
      } finally {
        server.close();
      }
    },
  );

  it("exits 0 when a run.blocked stream ends on a succeeded lifecycle (Done · needs review)", async () => {
    // D8: run.blocked fires on a SUCCEEDED lifecycle (needs review) → exit 0.
    const { server, port } = await sseServer((_last, res) => {
      res.write(frame(1, "run.blocked", { lifecycle: "succeeded" }));
      res.write("event: end\ndata: {}\n\n");
      res.end();
    });
    writeControlApiInfo(port);
    try {
      expect(await followRun("run-f", true)).toBe(0);
    } finally {
      server.close();
    }
  });

  it("exits 1 with 'stream lost' when the stream keeps ending without a terminal event", async () => {
    const { server, port } = await sseServer((_last, res) => {
      res.write(frame(1, "run.created"));
      setTimeout(() => res.destroy(), 20);
    });
    writeControlApiInfo(port);
    try {
      const code = await followRun("run-f", true);
      expect(code).toBe(1);
    } finally {
      server.close();
    }
  }, 30_000);

  it("treats a server 'end' without any terminal event as a loss (interrupted run), not success", async () => {
    const { server, port } = await sseServer((_last, res) => {
      res.write(frame(1, "run.created"));
      res.write("event: end\ndata: {}\n\n");
      res.end();
    });
    writeControlApiInfo(port);
    try {
      const code = await followRun("run-f", true);
      expect(code).toBe(1);
    } finally {
      server.close();
    }
  });
});

describe("interactive TTY prompt lifetime", () => {
  it("selects only exact numeric grammar and preserves invalid single picks as prose", async () => {
    const inputs = ["1Password is required", "1,2", "1, 2"];
    let index = 0;
    const result = await collectInteractionAnswers(
      "int-choice-grammar",
      [
        {
          id: "q-prefix",
          question: "Prefix?",
          header: null,
          options: [
            { label: "A", description: null },
            { label: "B", description: null },
          ],
          multi_select: false,
        },
        {
          id: "q-single",
          question: "Single?",
          header: null,
          options: [
            { label: "A", description: null },
            { label: "B", description: null },
          ],
          multi_select: false,
        },
        {
          id: "q-multi",
          question: "Multi?",
          header: null,
          options: [
            { label: "A", description: null },
            { label: "B", description: null },
          ],
          multi_select: true,
        },
      ] as never,
      {
        reader: {
          question: async () => inputs[index++] ?? "",
          close: () => {},
        },
      },
    );

    expect(result?.answers).toEqual([
      { question_id: "q-prefix", selected_labels: [], free_text: "1Password is required" },
      { question_id: "q-single", selected_labels: [], free_text: "1,2" },
      { question_id: "q-multi", selected_labels: ["A", "B"], free_text: null },
    ]);
  });

  it("is abortable without a deadline when the run terminates", async () => {
    const controller = new AbortController();
    let closed = false;
    const pending = collectInteractionAnswers(
      "int-disabled",
      [
        {
          id: "q1",
          question: "Continue?",
          header: "Choice",
          options: [],
          multi_select: false,
        },
      ] as never,
      {
        signal: controller.signal,
        reader: {
          question: (_prompt, options) =>
            new Promise<string>((_resolve, reject) => {
              options?.signal?.addEventListener(
                "abort",
                () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
                { once: true },
              );
            }),
          close: () => {
            closed = true;
          },
        },
      },
    );

    controller.abort();
    await expect(pending).resolves.toBeNull();
    expect(closed).toBe(true);
  });

  it("closes a prompt resolved by an interaction event without calling it a run ending", async () => {
    const controller = new AbortController();
    const written: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const pending = collectInteractionAnswers(
        "int-resolved",
        [
          {
            id: "q1",
            question: "Continue?",
            header: "Choice",
            options: [],
            multi_select: false,
          },
        ] as never,
        {
          signal: controller.signal,
          reader: {
            question: (_prompt, options) =>
              new Promise<string>((_resolve, reject) => {
                options?.signal?.addEventListener(
                  "abort",
                  () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
                  { once: true },
                );
              }),
            close: () => undefined,
          },
        },
      );

      controller.abort({ kind: "interaction_resolved", event: "interaction.answered" });
      await expect(pending).resolves.toBeNull();
    } finally {
      write.mockRestore();
    }
    expect(written.join("\n")).toContain("question resolved");
    expect(written.join("\n")).not.toContain("run ended");
  });

  it("chunks deadlines above Node's single-timer ceiling instead of expiring immediately", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:00:00.000Z"));
    let closed = false;
    try {
      const pending = collectInteractionAnswers(
        "int-large",
        [
          {
            id: "q1",
            question: "Continue?",
            header: "Choice",
            options: [],
            multi_select: false,
          },
        ] as never,
        {
          timeoutAt: new Date(Date.now() + 2_147_483_647 + 5_000).toISOString(),
          reader: {
            question: (_prompt, options) =>
              new Promise<string>((_resolve, reject) => {
                options?.signal?.addEventListener(
                  "abort",
                  () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
                  { once: true },
                );
              }),
            close: () => {
              closed = true;
            },
          },
        },
      );

      await vi.advanceTimersByTimeAsync(2_147_483_647);
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBeNull();
      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("live formatter typed-final dedup", () => {
  const message = (
    attemptId: string,
    text: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    type: "harness.event",
    payload: {
      type: "message",
      harness_id: "codex",
      attempt_id: attemptId,
      text,
      title: text,
      ...extra,
    },
  });

  it("prints the codex answer once when the typed final repeats the narration", () => {
    const format = createRunEventLineFormatter();
    expect(format(message("a01", "The bug is in the retry loop."))).toBe(
      "[a01/codex] The bug is in the retry loop.",
    );
    expect(
      format(
        message("a01", "The bug is in the retry loop.", {
          final: true,
          final_source: "codex_last_agent_message",
        }),
      ),
    ).toBeNull();
  });

  it("prints a final that carries text the narration never showed", () => {
    const format = createRunEventLineFormatter();
    format(message("a01", "Looking at the retry loop…"));
    expect(format(message("a01", "The bug is in the retry loop.", { final: true }))).toBe(
      "[a01/codex] The bug is in the retry loop.",
    );
  });

  it("prints a final with no narration before it (claude/cursor result)", () => {
    const format = createRunEventLineFormatter();
    expect(format(message("a01", "Done.", { final: true }))).toBe("[a01/codex] Done.");
  });

  it("keeps a genuine repeat when neither copy is typed final", () => {
    const format = createRunEventLineFormatter();
    format(message("a01", "Retrying."));
    expect(format(message("a01", "Retrying."))).toBe("[a01/codex] Retrying.");
  });

  it("dedups per lane: a final never suppresses another attempt's identical text", () => {
    const format = createRunEventLineFormatter();
    format(message("a01", "Same answer."));
    expect(format(message("a02", "Same answer.", { final: true }))).toBe(
      "[a02/codex] Same answer.",
    );
  });

  it("leaves non-message events untouched", () => {
    const format = createRunEventLineFormatter();
    expect(format({ type: "run.completed", payload: { lifecycle: "succeeded" } })).toBe(
      "run completed: succeeded",
    );
  });

  it("dedups on the rendered line: texts diverging past the 160-char cut never double-print", () => {
    // sol review of 00448bd8 (major): the printer truncates to 160 chars, so a
    // final whose full text differs only past the cut would render a line
    // byte-identical to the narration already on screen.
    const format = createRunEventLineFormatter();
    const first = format(message("a01", `${"A".repeat(200)}x`));
    expect(first).not.toBeNull();
    expect(format(message("a01", `${"A".repeat(200)}y`, { final: true }))).toBeNull();
  });

  it("dedups a whitespace-only final against its whitespace-only narration", () => {
    // sol review of 00448bd8 (minor): whitespace normalized to an empty
    // identity and skipped dedup entirely; line equality has no such hole.
    const format = createRunEventLineFormatter();
    const first = format(message("a01", "   "));
    expect(first).not.toBeNull();
    expect(format(message("a01", "   ", { final: true }))).toBeNull();
  });

  it("keeps per-lane state bounded to one rendered line, not full message bodies", () => {
    // sol review of 00448bd8 (minor): the dedup key is the rendered line
    // (≤160-char title cut), so a multi-megabyte narration body is never
    // retained — pinned here via the truncation marker in the stored line.
    const format = createRunEventLineFormatter();
    const line = format(message("a01", "B".repeat(1_000_000)));
    expect(line).not.toBeNull();
    expect(line!.length).toBeLessThan(200);
    expect(format(message("a01", "B".repeat(1_000_000), { final: true }))).toBeNull();
  });
});

describe("claudexor follow text mode", () => {
  let dir: string;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(realpathSync(tmpdir()), "claudexor-follow-text-"));
    prevConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
  });
  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = prevConfigDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints the doubled codex answer once on the live stream", async () => {
    const answer = "The bug is in the retry loop.";
    const { server, port } = await sseServer((_last, res) => {
      res.write(
        frame(1, "harness.event", {
          type: "message",
          harness_id: "codex",
          attempt_id: "a01",
          text: answer,
          title: answer,
        }),
      );
      res.write(
        frame(2, "harness.event", {
          type: "message",
          harness_id: "codex",
          attempt_id: "a01",
          text: answer,
          title: answer,
          final: true,
          final_source: "codex_last_agent_message",
        }),
      );
      res.write(frame(3, "run.completed", { lifecycle: "succeeded" }));
      res.write("event: end\ndata: {}\n\n");
      res.end();
    });
    const daemonDir = join(dir, "daemon");
    mkdirSync(daemonDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(daemonDir, "control-api.json"),
      JSON.stringify({ host: "127.0.0.1", port }),
      {
        mode: 0o600,
      },
    );
    writeFileSync(join(daemonDir, "token"), "tkn-follow", { mode: 0o600 });
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      expect(await followRun("run-f", false)).toBe(0);
    } finally {
      spy.mockRestore();
      server.close();
    }
    expect(written.filter((line) => line.includes(answer))).toHaveLength(1);
  });
});

describe("controlApiFetch create idempotency", () => {
  it.each(["/v2/threads", "/v2/setup/jobs"])("injects a key for %s", async (path) => {
    const server = createServer((req, res) => {
      expect(req.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const response = await controlApiFetch(
        { baseUrl: `http://127.0.0.1:${port}`, token: "token" },
        path,
        { method: "POST", body: "{}" },
      );
      expect(response.status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

/** Canonical ControlHandshakeResponse body for a serving engine identity. */
function handshakeBody(version: string, sha = "unknown"): string {
  return JSON.stringify({
    protocolMajor: 3,
    compatible: true,
    operationsPath: "/v2/operations",
    engine: { version, sha, entry: "/e" },
  });
}

function jsonServer(
  handler: (req: import("node:http").IncomingMessage) => {
    status: number;
    body: string;
  },
): Promise<{ server: Server; port: number; requests: string[] }> {
  const requests: string[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      requests.push(req.url ?? "");
      const out = handler(req);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(out.body);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as { port: number }).port, requests });
    });
  });
}

describe("handshake engine identity (v3.0.3 S4c)", () => {
  afterEach(() => recordEngineSkew(null));

  it("discloses a daemon/CLI version skew on stderr once per handshake AND records the skew", async () => {
    const { server, port, requests } = await jsonServer(() => ({
      status: 200,
      body: handshakeBody("9.9.9", "x"),
    }));
    const chunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (c: unknown) => {
      chunks.push(String(c));
      return true;
    };
    try {
      await handshakeControlApi({ baseUrl: `http://127.0.0.1:${port}`, token: "t" });
      await handshakeControlApi({ baseUrl: `http://127.0.0.1:${port}`, token: "t" });
    } finally {
      (process.stderr as unknown as { write: unknown }).write = origWrite;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(requests.filter((u) => u === "/v2/handshake")).toHaveLength(2);
    const warned = chunks.join("");
    expect(warned).toContain("daemon is engine 9.9.9");
    expect(warned).toContain("claudexor daemon stop");
    expect(warned.match(/daemon is engine 9\.9\.9/g)).toHaveLength(2);
    // The observed skew is recorded for the typed failure envelope (#93); the
    // malformed "x" sha never rides along (echo hygiene).
    expect(observedEngineSkew()).toEqual({
      daemonVersion: "9.9.9",
      cliVersion: CLAUDEXOR_VERSION,
    });
  });

  it("overwrites a prior skew record on every successful handshake (clears when matching)", async () => {
    const { server, port } = await jsonServer(() => ({
      status: 200,
      body: handshakeBody(CLAUDEXOR_VERSION),
    }));
    recordEngineSkew({ daemonVersion: "9.9.9", cliVersion: CLAUDEXOR_VERSION });
    try {
      const identity = await handshakeControlApi({
        baseUrl: `http://127.0.0.1:${port}`,
        token: "t",
      });
      expect(identity).toEqual({
        engineVersion: CLAUDEXOR_VERSION,
        engineBuildSha: "unknown",
        servingMode: "normal",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // A long-lived MCP/ACP process that reconnects to a FIXED daemon must not
    // keep annotating failures with the stale pre-fix skew.
    expect(observedEngineSkew()).toBeNull();
  });
});

/** Every projection-visible CliError field, for byte-identity comparisons. */
function projectCliError(e: CliError): Record<string, unknown> {
  return {
    category: e.category,
    message: e.message,
    code: e.code,
    retryable: e.retryable,
    fieldErrors: e.fieldErrors,
    requiredActions: e.requiredActions,
    details: e.details,
    context: e.context,
  };
}

describe("typed handshake refusal (#93)", () => {
  afterEach(() => recordEngineSkew(null));

  it("preserves the server's typed 426 problem and appends the stop remedy", async () => {
    const { server, port } = await jsonServer(() => ({
      status: 426,
      body: JSON.stringify({
        code: "incompatible_protocol_major",
        message: "control protocol major 3 is incompatible; server requires 4",
        retryable: false,
        fieldErrors: {},
        requiredActions: ["use control protocol major 4"],
        evidenceRefs: [],
      }),
    }));
    // A stale same-major record from an earlier daemon must NOT annotate the
    // refusal of a daemon this handshake can no longer identify.
    recordEngineSkew({ daemonVersion: "3.2.1", cliVersion: CLAUDEXOR_VERSION });
    const stderrChunks: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown): boolean => {
        stderrChunks.push(String(chunk));
        return true;
      });
    try {
      const err = await handshakeControlApi({
        baseUrl: `http://127.0.0.1:${port}`,
        token: "t",
      }).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(err).toBeInstanceOf(CliError);
      const problem = err as CliError;
      // The WIRE code rides intact — no parallel CLI-minted code.
      expect(problem.code).toBe("incompatible_protocol_major");
      expect(problem.message).toBe("control protocol major 3 is incompatible; server requires 4");
      expect(problem.category).toBe("operational");
      expect(problem.retryable).toBe(false);
      expect(problem.requiredActions).toEqual(["use control protocol major 4", ENGINE_STOP_REMEDY]);
      expect(problem.context?.["engineSkew"]).toBeUndefined();
      expect(observedEngineSkew()).toBeNull();
      // R1 C-C1: the typed problem's own message wins in the human projector,
      // so the remedy must ALSO reach human stderr as one bounded advisory
      // line (same voice as the same-major skew advisory).
      const advisory = stderrChunks.join("");
      expect(advisory).toContain("refused the control API handshake (HTTP 426)");
      expect(advisory).toContain(ENGINE_STOP_REMEDY);
      expect(advisory).not.toContain("server requires 4"); // bounded: no server text
    } finally {
      stderrSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(["daemon_stopping", "route_quarantined"])(
    "passes a typed %s problem through UNCHANGED — no advisory, no appended remedy (R2)",
    async (code) => {
      // Only an ACTUAL protocol mismatch earns the mismatch treatment. A typed
      // non-mismatch refusal (a healthy MATCHING daemon answering the handshake
      // with daemon_stopping mid-shutdown, or any other typed problem) must be
      // byte-identical to the plain controlProblemError projection of the same
      // wire body: its own actions already say what to do, and the mismatch
      // remedy would be a false diagnosis.
      const wireBody = {
        code,
        message: "the daemon declined this handshake for its own typed reason",
        retryable: true,
        fieldErrors: {},
        requiredActions: ["reconnect"],
        evidenceRefs: [],
      };
      const { server, port } = await jsonServer(() => ({
        status: 503,
        body: JSON.stringify(wireBody),
      }));
      const stderrChunks: string[] = [];
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation((chunk: unknown): boolean => {
          stderrChunks.push(String(chunk));
          return true;
        });
      try {
        const err = await handshakeControlApi({
          baseUrl: `http://127.0.0.1:${port}`,
          token: "t",
        }).then(
          () => null,
          (thrown: unknown) => thrown,
        );
        expect(err).toBeInstanceOf(CliError);
        const expected = controlProblemError(
          503,
          wireBody,
          "the daemon refused the control API handshake (HTTP 503)",
        );
        expect(projectCliError(err as CliError)).toEqual(projectCliError(expected));
        expect((err as CliError).requiredActions).toEqual(["reconnect"]);
        expect(stderrChunks.join("")).toBe("");
      } finally {
        stderrSpy.mockRestore();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it("names the daemon and the stop remedy for an ancient daemon without /v2/handshake", async () => {
    const { server, port } = await jsonServer(() => ({
      status: 404,
      body: "<html>not found</html>",
    }));
    const stderrChunks: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown): boolean => {
        stderrChunks.push(String(chunk));
        return true;
      });
    try {
      const err = await handshakeControlApi({
        baseUrl: `http://127.0.0.1:${port}`,
        token: "t",
      }).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(err).toBeInstanceOf(CliError);
      const problem = err as CliError;
      // Never the CLAUDEXOR_NO_CONTROL_API flatten, never echoed response text.
      expect(problem.message).toContain("daemon");
      expect(problem.message).toContain("claudexor daemon stop");
      expect(problem.message).not.toContain("<html>");
      expect(problem.requiredActions).toEqual([ENGINE_STOP_REMEDY]);
      // The untyped fallback's own message names the remedy, so the human
      // projector already shows it — no doubled advisory line (R1 C-C1).
      expect(stderrChunks.join("")).toBe("");
    } finally {
      stderrSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("follow surfaces typed refusals through the projector (#93 R1)", () => {
  let dir: string;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(realpathSync(tmpdir()), "claudexor-follow-r1-"));
    prevConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    recordEngineSkew(null);
  });
  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = prevConfigDir;
    recordEngineSkew(null);
    rmSync(dir, { recursive: true, force: true });
  });

  function writePointer(content: string): void {
    const daemonDir = join(dir, "daemon");
    mkdirSync(daemonDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(daemonDir, "control-api.json"), content, { mode: 0o600 });
    writeFileSync(join(daemonDir, "token"), "tkn-r1", { mode: 0o600 });
  }

  function captureStderr(): { chunks: string[]; restore: () => void } {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
      chunks.push(String(chunk));
      return true;
    });
    return { chunks, restore: () => spy.mockRestore() };
  }

  it("rethrows the typed 426 and `follow --json` renders the canonical envelope", async () => {
    const { server, port } = await jsonServer(() => ({
      status: 426,
      body: JSON.stringify({
        code: "incompatible_protocol_major",
        message: "control protocol major 3 is incompatible; server requires 4",
        retryable: false,
        fieldErrors: {},
        requiredActions: ["use control protocol major 4"],
        evidenceRefs: [],
      }),
    }));
    writePointer(JSON.stringify({ host: "127.0.0.1", port }));
    const stderr = captureStderr();
    try {
      const err: unknown = await followRun("run-r1", true).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      // The typed CliError reaches the top-level projector intact — never the
      // pre-fix `claudexor follow: <message>` flatten (return 1).
      expect(err).toBeInstanceOf(CliError);
      // Exactly what `claudexor follow --json` prints: renderCliFailure is the
      // one projector the top-level catch feeds every thrown CliError into.
      const stdoutChunks: string[] = [];
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk: unknown): boolean => {
          stdoutChunks.push(String(chunk));
          return true;
        });
      let exitCode: number;
      try {
        exitCode = renderCliFailure(true, err);
      } finally {
        stdoutSpy.mockRestore();
      }
      expect(exitCode).toBe(1);
      const envelope = JSON.parse(stdoutChunks.join("")) as Record<string, unknown>;
      expect(envelope["ok"]).toBe(false);
      expect(envelope["code"]).toBe("incompatible_protocol_major");
      expect(envelope["message"]).toBe(
        "control protocol major 3 is incompatible; server requires 4",
      );
      expect(envelope["retryable"]).toBe(false);
      expect(envelope["requiredActions"]).toEqual([
        "use control protocol major 4",
        ENGINE_STOP_REMEDY,
      ]);
    } finally {
      stderr.restore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("human path: the stop-remedy advisory reaches stderr before the rethrow", async () => {
    const { server, port } = await jsonServer(() => ({
      status: 426,
      body: JSON.stringify({
        code: "incompatible_protocol_major",
        message: "control protocol major 3 is incompatible; server requires 4",
        retryable: false,
        fieldErrors: {},
        requiredActions: [],
        evidenceRefs: [],
      }),
    }));
    writePointer(JSON.stringify({ host: "127.0.0.1", port }));
    const stderr = captureStderr();
    try {
      const err: unknown = await followRun("run-r1", false).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(err).toBeInstanceOf(CliError);
      const advisory = stderr.chunks.join("");
      expect(advisory).toContain("refused the control API handshake (HTTP 426)");
      expect(advisory).toContain(ENGINE_STOP_REMEDY);
      // The rethrow means follow itself no longer prints the flatten line.
      expect(advisory).not.toContain("claudexor follow:");
    } finally {
      stderr.restore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps the message-only fallback for UNTYPED transport errors (connect refused)", async () => {
    // A pointer naming a port nobody listens on: fetch rejects with an untyped
    // transport error — follow's bounded flatten stays, exit 1, no throw.
    const probe = await jsonServer(() => ({ status: 200, body: "{}" }));
    const deadPort = probe.port;
    await new Promise<void>((resolve) => probe.server.close(() => resolve()));
    writePointer(JSON.stringify({ host: "127.0.0.1", port: deadPort }));
    const stderr = captureStderr();
    try {
      const code = await followRun("run-r1", false);
      expect(code).toBe(1);
      expect(stderr.chunks.join("")).toContain("claudexor follow:");
    } finally {
      stderr.restore();
    }
  });

  it("is LOUD and bounded on a corrupt control-api pointer (R1 C-C3a)", async () => {
    writePointer("{corrupt-not-json");
    const stderr = captureStderr();
    try {
      const err: unknown = await followRun("run-r1", false).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(err).toBeInstanceOf(CliError);
      const problem = err as CliError;
      expect(problem.code).toBe("control_pointer_invalid");
      expect(problem.category).toBe("operational");
      // Bounded: names the pointer path and the remedy, never the raw bytes.
      expect(problem.message).toContain("control-api.json");
      expect(problem.message).toContain("claudexor daemon stop");
      expect(problem.message).not.toContain("{corrupt-not-json");
      expect(problem.context).toEqual({ pointer: join(dir, "daemon", "control-api.json") });
    } finally {
      stderr.restore();
    }
  });
});

describe("control-api pointer structural validation (#93 R2)", () => {
  let dir: string;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(realpathSync(tmpdir()), "claudexor-pointer-r2-"));
    prevConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
  });
  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = prevConfigDir;
    rmSync(dir, { recursive: true, force: true });
  });

  function writePointer(content: string): void {
    const daemonDir = join(dir, "daemon");
    mkdirSync(daemonDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(daemonDir, "control-api.json"), content, { mode: 0o600 });
    writeFileSync(join(daemonDir, "token"), "tkn-r2", { mode: 0o600 });
  }

  function thrownBy(fn: () => unknown): unknown {
    try {
      fn();
      return null;
    } catch (err) {
      return err;
    }
  }

  it.each([
    ["an empty object", "{}"],
    ["a JSON null literal", "null"],
    ["an empty host", '{"host":"","port":1}'],
    ["a string port", '{"host":"127.0.0.1","port":"80"}'],
    ["a non-integer port", '{"host":"127.0.0.1","port":80.5}'],
    ["an out-of-range port", '{"host":"127.0.0.1","port":0}'],
  ])("is LOUD control_pointer_invalid on %s (nonempty structural corruption)", (_name, content) => {
    writePointer(content);
    const err = thrownBy(() => controlApiAddress());
    expect(err).toBeInstanceOf(CliError);
    const problem = err as CliError;
    expect(problem.code).toBe("control_pointer_invalid");
    expect(problem.category).toBe("operational");
    // Bounded: the pointer path and a short cause ride along — never the raw
    // file content (the '"port"' key would only appear via a raw dump).
    expect(problem.message).toContain("control-api.json");
    expect(problem.message).toContain("structurally invalid");
    expect(problem.message).toContain("claudexor daemon stop");
    expect(problem.message).not.toContain('"port"');
    expect(problem.context).toEqual({ pointer: join(dir, "daemon", "control-api.json") });
  });

  it.each([
    ["zero-byte", ""],
    ["whitespace-only", " \n\t"],
  ])("keeps %s content as ABSENCE (adjudicated mid-write race window)", (_name, content) => {
    writePointer(content);
    const err = thrownBy(() => controlApiAddress());
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CliError);
    expect((err as Error).message).toContain("daemon control API is not available");
  });
});
