import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DaemonClient } from "./client.js";
import { DaemonServer, type JobRecord } from "./server.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("daemon", () => {
  it("health, enqueue -> run via injected runner, status, auth, shutdown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudex-daemon-"));
    const socketPath = join(dir, "s.sock");
    const token = "tkn-123";
    let ran = 0;
    const server = new DaemonServer({
      socketPath,
      token,
      runner: async (params) => {
        ran += 1;
        return { echoed: (params as { x: number }).x * 2 };
      },
    });
    await server.start();
    try {
      const client = new DaemonClient(socketPath, token);
      const health = (await client.health()) as { ok: boolean };
      expect(health.ok).toBe(true);

      const job = await client.enqueue({ x: 21 });
      expect(job.state).toBe("queued");

      let st = await client.status(job.id);
      for (let i = 0; i < 100 && (st.state === "queued" || st.state === "running"); i++) {
        await sleep(10);
        st = await client.status(job.id);
      }
      expect(st.state).toBe("succeeded");
      expect((st.result as { echoed: number }).echoed).toBe(42);
      expect(ran).toBe(1);

      const bad = new DaemonClient(socketPath, "wrong-token");
      await expect(bad.health()).rejects.toThrow(/unauthorized/);
    } finally {
      await server.stop();
    }
  });

  it("runs jobs concurrently up to the limit, surfaces runId, and cancels a running job via signal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudex-daemon-"));
    const socketPath = join(dir, "s.sock");
    const token = "tkn-abc";
    let active = 0;
    let maxActive = 0;
    const server = new DaemonServer({
      socketPath,
      token,
      maxConcurrent: 2,
      runner: async (params, ctx) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        ctx.onRunStart({ runId: `run-${(params as { x: number }).x}`, taskId: "t", runDir: "/tmp/x" });
        try {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 1000);
            ctx.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              resolve();
            });
          });
          return { ok: true };
        } finally {
          active -= 1;
        }
      },
    });
    await server.start();
    try {
      const client = new DaemonClient(socketPath, token);
      const j1 = await client.enqueue({ x: 1 });
      const j2 = await client.enqueue({ x: 2 });
      for (let i = 0; i < 100 && maxActive < 2; i++) await sleep(10);
      expect(maxActive).toBe(2);

      const st1 = await client.status(j1.id);
      expect(st1.state).toBe("running");
      expect((st1 as { runId?: string }).runId).toBe("run-1");

      await client.cancel(j1.id);
      let s = await client.status(j1.id);
      for (let i = 0; i < 100 && s.state === "running"; i++) {
        await sleep(10);
        s = await client.status(j1.id);
      }
      expect(s.state).toBe("cancelled");

      await client.cancel(j2.id);
    } finally {
      await server.stop();
    }
  }, 20000);

  it("persists the job registry across restart (durable run list)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudex-daemon-"));
    const socketPath = join(dir, "s.sock");
    const persistPath = join(dir, "jobs.json");
    const token = "tkn-persist";
    const mk = () =>
      new DaemonServer({
        socketPath,
        token,
        persistPath,
        runner: async (params) => ({ echoed: (params as { x: number }).x }),
      });

    const a = mk();
    await a.start();
    let jobId = "";
    try {
      const client = new DaemonClient(socketPath, token);
      const job = await client.enqueue({ x: 7 });
      jobId = job.id;
      let st = await client.status(job.id);
      for (let i = 0; i < 100 && st.state !== "succeeded"; i++) {
        await sleep(10);
        st = await client.status(job.id);
      }
      expect(st.state).toBe("succeeded");
    } finally {
      await a.stop();
    }

    const b = mk();
    await b.start();
    try {
      const client = new DaemonClient(socketPath, token);
      const list = (await client.list()) as JobRecord[];
      expect(list.some((r) => r.id === jobId && r.state === "succeeded")).toBe(true);
    } finally {
      await b.stop();
    }
  }, 20000);
});
