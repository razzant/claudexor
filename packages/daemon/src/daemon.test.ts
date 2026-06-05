import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DaemonClient } from "./client.js";
import { DaemonServer } from "./server.js";

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
});
