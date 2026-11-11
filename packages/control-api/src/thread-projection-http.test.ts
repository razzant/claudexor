import { request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ControlThreadDetail } from "@claudexor/schema";
import { expect, it, vi } from "vitest";
import { BulkExecutor } from "./bulk-executor.js";
import { projectBulkJob } from "./bulk-worker.js";
import { DaemonControlApiServer } from "./daemon-server.js";
import type { DaemonRunRecord } from "./run-record.js";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Observe server-side close and handler completion; no elapsed-time assertion.
type Probe = {
  server: Server;
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  runNeedsAttention(record: DaemonRunRecord): boolean;
};

it.each([false, true])(
  "thread detail stops scheduling on close and completes connected cards (disconnect=%s)",
  async (disconnect) => {
    const runs: DaemonRunRecord[] = Array.from({ length: 3 }, (_, i) => ({
      id: `job-${i}`,
      runId: `run-${i}`,
      state: "succeeded",
      params: { mode: "ask" },
    }));
    const timestamp = "2026-10-28T00:00:00Z";
    const entered = latch(),
      release = latch(),
      closed = latch(),
      done = latch();
    const summaries: string[] = [];
    const execute = vi.spyOn(BulkExecutor.prototype, "execute").mockImplementation(async (job) => {
      if (job.kind === "summary") {
        summaries.push(job.input.record.id);
        if (summaries.length === 1) {
          entered.resolve();
          await release.promise;
        }
      }
      return (await projectBulkJob(job, async () => null)) as never;
    });
    const server = new DaemonControlApiServer({
      token: "turn-cards",
      daemon: {
        list: async () => runs,
        status: async () => runs[0]!,
        enqueue: async () => ({ id: "unused", state: "queued" }),
        cancel: async () => ({}),
      },
      services: {
        threadDetail: async () => ({
          thread: {
            id: "thread",
            head_run_id: "run-2",
            mode: "ask",
            created_at: timestamp,
            updated_at: timestamp,
          },
          sessions: [],
          turns: runs.map((run, i) => ({
            id: `turn-${i}`,
            thread_id: "thread",
            run_id: run.runId,
            created_at: timestamp,
          })),
        }),
      },
    });
    const probe = server as unknown as Probe;
    const handle = probe.handle.bind(server);
    const handler = vi.spyOn(probe, "handle").mockImplementation(async (req, res) => {
      try {
        await handle(req, res);
      } finally {
        done.resolve();
      }
    });
    const attention = vi.spyOn(probe, "runNeedsAttention");
    let client: ReturnType<typeof request> | undefined;
    try {
      const { host, port } = await server.start();
      probe.server.once("request", (_req, res) => res.once("close", closed.resolve));
      const response = new Promise<{ status: number; body: string } | null>((resolve, reject) => {
        client = request(
          `http://${host}:${port}/v2/threads/thread`,
          {
            headers: { authorization: "Bearer turn-cards", "X-Claudexor-Protocol-Major": "3" },
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
              body += chunk;
            });
            res.on("end", () => resolve({ status: res.statusCode!, body }));
          },
        );
        client.on("error", (error) => (disconnect ? resolve(null) : reject(error)));
        client.end();
      });
      await entered.promise;
      if (disconnect) {
        client!.destroy();
        await closed.promise;
      }
      release.resolve();
      await done.promise;
      if (disconnect) {
        expect(summaries).toEqual(["job-0"]);
        expect(attention).not.toHaveBeenCalled();
        expect(await response).toBeNull();
      } else {
        const received = (await response)!;
        expect(received.status).toBe(200);
        const detail = ControlThreadDetail.parse(JSON.parse(received.body));
        expect(detail.turns.map((turn) => [turn.runId, turn.run?.state])).toEqual(
          runs.map((r) => [r.runId, "succeeded"]),
        );
        expect(summaries).toEqual(runs.map((r) => r.id));
        expect(detail.thread.needsHuman).toBe(false);
        expect(attention).toHaveBeenCalledOnce();
      }
    } finally {
      release.resolve();
      client?.destroy();
      await server.stop();
      handler.mockRestore();
      attention.mockRestore();
      execute.mockRestore();
    }
  },
);
