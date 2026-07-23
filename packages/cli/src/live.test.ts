import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  controlApiFetch,
  createRunEventLineFormatter,
  followRun,
  formatRunEventLine,
  handshakeControlApi,
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

describe("handshake engine identity (v3.0.3 S4c)", () => {
  it("discloses a daemon/CLI version skew from the handshake body on stderr, once", async () => {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? "");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, engine: { version: "9.9.9", sha: "x", entry: "/e" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
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
  });
});
