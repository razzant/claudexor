import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  ControlDaemonStatus,
  ControlThreadListResponse,
  RunWaitManyResult,
  RunWaitManySummary,
} from "@claudexor/schema";
import { expect, it } from "vitest";
import { BulkExecutor } from "./bulk-executor.js";
import { BULK_WORKER_ROLE } from "./bulk-protocol.js";
import { DaemonControlApiServer } from "./daemon-server.js";
import type { DaemonFacadeClient, DaemonRunRecord } from "./run-record.js";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("serves admission, inbox attention and control requests, then stops while a real bulk worker is blocked", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudexor-worker-isolation-"));
  const barrier = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
  let server: DaemonControlApiServer | undefined;
  let worker: Worker | undefined;
  let detector: ReturnType<typeof setTimeout> | undefined;
  try {
    const timestamp = "2026-10-27T00:00:00.000Z";
    writeFileSync(
      join(root, "events.jsonl"),
      `${JSON.stringify({
        seq: 1,
        ts: timestamp,
        run_id: "run-one",
        task_id: "task-one",
        type: "run.created",
        payload: {},
      })}\n`,
    );
    const record: DaemonRunRecord = {
      id: "job-one",
      runId: "run-one",
      taskId: "task-one",
      state: "running",
      runDir: root,
      params: { mode: "ask", scope: { kind: "project", root } },
    };
    const heads = ["blocked", "clean"].map((id): DaemonRunRecord => {
      const runDir = join(root, id);
      mkdirSync(join(runDir, "arbitration"), { recursive: true });
      writeFileSync(
        join(runDir, "arbitration/decision.yaml"),
        JSON.stringify({
          winner: "a01",
          facts: {
            lifecycle: "succeeded",
            review: id === "blocked" ? "blocked" : "approved",
            checks: "passed",
            noChanges: false,
          },
        }),
      );
      return { id, runId: id, state: "succeeded", runDir, params: { mode: "agent" } };
    });
    const records = [record, ...heads];
    let admissions = 0;
    const daemon: DaemonFacadeClient = {
      enqueue: async () => {
        admissions += 1;
        return { id: record.id, state: "queued" };
      },
      status: async () => structuredClone(record),
      list: async (query) =>
        structuredClone(
          "delegatedFromRunId" in query
            ? []
            : "ids" in query
              ? records.filter((r) => query.ids.includes(r.runId!))
              : records,
        ),
      fenceDelegationParent: async () => ({}),
      cancel: async () => {
        record.state = "cancelled";
        return { ok: true };
      },
      health: async () =>
        ControlDaemonStatus.parse({
          ok: true,
          uptime_ms: 1,
          queue: 0,
          running: true,
          active: 1,
          jobs: 1,
          stopping: false,
          servingMode: "normal",
          capacity: { maxConcurrent: 1 },
          loop: null,
          memory: {
            heapUsedBytes: 0,
            heapLimitBytes: 0,
            rssBytes: 0,
            externalBytes: 0,
            nodeHeapArgs: [],
            atAdmission: null,
            sampledAt: timestamp,
          },
        }),
    };
    const ready = latch();
    const entered = latch();
    let failWorker!: (error: Error) => void;
    const failed = new Promise<never>((_resolve, reject) => {
      failWorker = reject;
    });
    worker = new Worker(new URL("./test-support/bulk-worker-barrier.mjs", import.meta.url), {
      workerData: { role: BULK_WORKER_ROLE, barrier: barrier.buffer },
    });
    worker.on("message", (message: { type?: string }) => {
      if (message.type === "test:ready") ready.resolve();
      if (message.type === "test:detail-blocked") entered.resolve();
    });
    worker.on("error", failWorker);
    const actualWorker = worker;
    const executor = new BulkExecutor(() => actualWorker);
    server = new DaemonControlApiServer({
      token: "worker-isolation",
      daemon,
      services: {
        listThreads: async () => ({
          threads: records.map((r) => ({
            id: `thread-${r.id}`,
            head_run_id: r.runId,
            run_ids: [r.runId],
            mode: "agent",
            created_at: timestamp,
            updated_at: timestamp,
          })),
        }),
      },
      runObservations: async (ids) =>
        ids.map((id) =>
          RunWaitManySummary.parse(
            id === record.runId
              ? { status: record.state, pending: true, token: "A".repeat(43), problem: null }
              : { status: null, pending: null, token: null, problem: "not_found" },
          ),
        ),
    });
    // Test-only injection keeps the production construction/configuration unchanged.
    (server as unknown as { bulk: BulkExecutor }).bulk = executor;
    const actualServer = server;
    const hung = new Promise<never>((_resolve, reject) => {
      // A hang detector, not a latency assertion. The proof is barrier ordering.
      detector = setTimeout(() => reject(new Error("worker isolation fixture hung")), 20_000);
    });
    const exercise = async () => {
      await ready.promise;
      const { host, port } = await actualServer.start();
      const base = `http://${host}:${port}`;
      const headers = {
        authorization: "Bearer worker-isolation",
        "X-Claudexor-Protocol-Major": "3",
      };
      const get = (path: string) => fetch(`${base}${path}`, { headers });
      const post = (path: string, body: unknown) =>
        fetch(`${base}${path}`, {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
            "Idempotency-Key": "worker-isolation",
          },
          body: JSON.stringify(body),
        });
      let detailSettled = false;
      const detail = get("/v2/runs/run-one")
        .then(async (response) => ({ status: response.status, body: await response.json() }))
        .then(
          (value) => {
            detailSettled = true;
            return { value };
          },
          (error: unknown) => {
            detailSettled = true;
            return { error };
          },
        );
      await entered.promise;
      expect(Atomics.load(barrier, 0)).toBe(1);
      const controls = await Promise.all([
        get("/healthz"),
        get("/v2/daemon/status"),
        post("/v2/handshake", { protocolMajor: 3, client: "worker-isolation" }),
      ]);
      expect(controls.map((response) => response.status)).toEqual([200, 200, 200]);
      await Promise.all(controls.map((response) => response.arrayBuffer()));
      const admitted = await post("/v2/runs", {
        mode: "ask",
        prompt: "fixture",
        scope: { kind: "project", root },
      });
      expect(admitted.status).toBe(200);
      expect(await admitted.json()).toMatchObject({ jobId: record.id, runId: record.runId });
      expect(admissions).toBe(1);
      const threads = await get("/v2/threads");
      expect(threads.status).toBe(200);
      expect(
        ControlThreadListResponse.parse(await threads.json()).threads.map((t) => [
          t.id,
          t.needsHuman,
        ]),
      ).toEqual([
        ["thread-job-one", false],
        ["thread-blocked", true],
        ["thread-clean", false],
      ]);
      const attention = await post("/v2/runs/wait-many", {
        targets: [{ runId: "run-one" }],
        waitMs: 0,
      });
      expect(attention.status).toBe(200);
      expect(RunWaitManyResult.parse(await attention.json())).toEqual({
        wakeReason: "attention",
        attention: [0],
        summaries: [{ status: "running", pending: true, token: "A".repeat(43), problem: null }],
      });
      const cancelled = await post("/v2/runs/run-one/control", { control: { kind: "cancel" } });
      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toMatchObject({ accepted: true });
      expect(record.state).toBe("cancelled");
      expect(detailSettled).toBe(false);
      expect(Atomics.load(barrier, 1)).toBe(0);

      await actualServer.stop();
      expect(Atomics.load(barrier, 1)).toBe(0);
      expect(Atomics.load(barrier, 0)).toBe(1);
      expect(await detail).toMatchObject({
        value: { status: 503, body: { code: "daemon_stopping", retryable: true } },
      });
    };
    await Promise.race([exercise(), failed, hung]);
  } finally {
    clearTimeout(detector);
    // Release only after the proof finishes, or to clean up a failed assertion.
    Atomics.store(barrier, 1, 1);
    Atomics.notify(barrier, 1);
    if (worker) await worker.terminate();
    if (server) await server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
