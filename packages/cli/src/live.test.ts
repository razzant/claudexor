import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { followRun } from "./live.js";

/** Stub control API speaking just enough SSE for the follow contract. */
function sseServer(
  handler: (lastEventId: number, res: import("node:http").ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v2/handshake") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ protocolMajor: 2, compatible: true, operationsPath: "/v2/operations" }),
        );
        return;
      }
      expect(req.url).toBe("/v2/runs/run-f/events");
      expect(req.headers["x-claudexor-protocol-major"]).toBe("2");
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
      res.write(frame(3, "run.completed", { status: "success" }));
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
