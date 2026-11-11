import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BulkExecutor } from "./bulk-executor.js";
import type { BulkJob, WorkerReply, WorkerRequest } from "./bulk-protocol.js";
import type { EventReplayResult } from "./event-replay-batch.js";

/** Deterministic worker barrier: no daemon, disk read, thread, or timer. */
class HeldWorker extends EventEmitter {
  posts: WorkerRequest[] = [];
  ref = vi.fn();
  unref = vi.fn();
  terminate = vi.fn(() => new Promise<number>(() => {}));
  postMessage(message: WorkerRequest) {
    this.posts.push(message);
  }
  reply(message: WorkerReply) {
    this.emit("message", message);
  }
  complete(index: number, value: EventReplayResult = emptyBatch()) {
    const post = this.posts[index]!;
    if (post.type !== "run") throw new Error("expected a work request");
    this.reply({ type: "result", id: post.id, value, queueMs: 1, projectionMs: 2 });
  }
}
const emptyBatch = (): EventReplayResult => ({
  frames: [],
  terminalSeen: false,
  progressed: false,
});
const job = (path: string): BulkJob<"event-replay"> => ({
  kind: "event-replay",
  input: { path, lastEventId: 0 },
});
const executors: BulkExecutor[] = [];
afterEach(() => {
  for (const executor of executors.splice(0)) executor.stop();
});
function executor(factory: () => HeldWorker) {
  const instance = new BulkExecutor(() => factory() as unknown as Worker);
  executors.push(instance);
  return instance;
}

describe("server-owned bulk executor lifecycle", () => {
  it("creates no worker for an unused server, including Stop", async () => {
    const factory = vi.fn(() => new HeldWorker());
    const bulk = executor(factory);
    expect(factory).not.toHaveBeenCalled();
    bulk.stop();
    expect(factory).not.toHaveBeenCalled();
    await expect(bulk.execute(job("after-stop"))).rejects.toMatchObject({
      code: "daemon_stopping",
      status: 503,
      retryable: true,
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it("reuses one lazy worker and keeps at most one finite job in flight", async () => {
    const worker = new HeldWorker();
    const factory = vi.fn(() => worker);
    const bulk = executor(factory);
    const first = bulk.execute(job("first"));
    const second = bulk.execute(job("second"));
    expect(factory).toHaveBeenCalledTimes(1);
    expect(worker.posts).toHaveLength(1);
    worker.complete(0);
    await expect(first).resolves.toEqual(emptyBatch());
    expect(worker.posts).toHaveLength(2);
    worker.complete(1);
    await expect(second).resolves.toEqual(emptyBatch());
    const third = bulk.execute(job("third"));
    expect(factory).toHaveBeenCalledTimes(1);
    worker.complete(2);
    await expect(third).resolves.toEqual(emptyBatch());
  });

  it("rejects an already cancelled read without creating a worker", async () => {
    const factory = vi.fn(() => new HeldWorker());
    const bulk = executor(factory);
    const abort = new AbortController();
    abort.abort();
    await expect(bulk.execute(job("never-posted"), abort.signal)).rejects.toMatchObject({
      code: "bulk_read_cancelled",
      status: 503,
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it("drops a cancelled queued read while keeping the unrelated running read", async () => {
    const worker = new HeldWorker();
    const bulk = executor(() => worker);
    const first = bulk.execute(job("first"));
    const abort = new AbortController();
    const cancelled = bulk.execute(job("never-posted"), abort.signal);
    const rejected = expect(cancelled).rejects.toMatchObject({ code: "bulk_read_cancelled" });
    const last = bulk.execute(job("last"));
    abort.abort();
    await rejected;
    expect(worker.posts).toHaveLength(1);
    worker.complete(0);
    await first;
    expect(worker.posts).toHaveLength(2);
    expect(worker.posts[1]).toMatchObject({ type: "run", job: { input: { path: "last" } } });
    worker.complete(1);
    await last;
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it("settles a cancelled running read immediately and discards its eventual result", async () => {
    const worker = new HeldWorker();
    const bulk = executor(() => worker);
    const abort = new AbortController();
    const first = bulk.execute(job("cancelled"), abort.signal);
    const rejected = expect(first).rejects.toMatchObject({ code: "bulk_read_cancelled" });
    const next = bulk.execute(job("next"));
    abort.abort();
    await rejected; // No worker reply is needed to release the HTTP request.
    expect(worker.posts).toHaveLength(1);
    worker.complete(0, { ...emptyBatch(), terminalSeen: true });
    expect(worker.posts).toHaveLength(2);
    worker.complete(1);
    await expect(next).resolves.toEqual(emptyBatch());
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it("Stop rejects running and queued reads without waiting for worker termination", async () => {
    const worker = new HeldWorker();
    const factory = vi.fn(() => worker);
    const bulk = executor(factory);
    const first = bulk.execute(job("running"));
    const second = bulk.execute(job("queued"));
    const firstRejected = expect(first).rejects.toMatchObject({
      code: "daemon_stopping",
      status: 503,
    });
    const secondRejected = expect(second).rejects.toMatchObject({
      code: "daemon_stopping",
      status: 503,
    });
    expect(bulk.stop()).toBeUndefined();
    await Promise.all([firstRejected, secondRejected]);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.posts).toHaveLength(1);
    worker.complete(0);
    await expect(bulk.execute(job("later"))).rejects.toMatchObject({ code: "daemon_stopping" });
    bulk.stop();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it.each(["error", "exit"])(
    "returns typed 503 on worker %s and respawns only on a later read",
    async (event) => {
      const oldWorker = new HeldWorker();
      const newWorker = new HeldWorker();
      const factory = vi.fn().mockReturnValueOnce(oldWorker).mockReturnValue(newWorker);
      const bulk = executor(factory);
      const running = bulk.execute(job("running"));
      const queued = bulk.execute(job("queued"));
      const rejected = [running, queued].map((promise) =>
        expect(promise).rejects.toMatchObject({
          code: "bulk_worker_failed",
          status: 503,
          retryable: true,
        }),
      );
      oldWorker.emit(event, event === "error" ? new Error("crashed") : 1);
      await Promise.all(rejected);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(oldWorker.posts).toHaveLength(1);
      const later = bulk.execute(job("later"));
      expect(factory).toHaveBeenCalledTimes(2);
      const newPost = newWorker.posts[0]!;
      if (newPost.type !== "run") throw new Error("expected work");
      oldWorker.reply({
        type: "result",
        id: newPost.id,
        value: { ...emptyBatch(), terminalSeen: true },
        queueMs: 0,
        projectionMs: 0,
      });
      oldWorker.emit("exit", 1); // A late old-generation notification cannot kill its replacement.
      newWorker.complete(0);
      await expect(later).resolves.toEqual(emptyBatch());
    },
  );

  it("classifies a worker construction failure and permits a later lazy retry", async () => {
    const worker = new HeldWorker();
    const factory = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("cannot create thread");
      })
      .mockReturnValue(worker);
    const bulk = executor(factory);
    await expect(bulk.execute(job("first"))).rejects.toMatchObject({
      code: "bulk_worker_failed",
      status: 503,
    });
    expect(factory).toHaveBeenCalledTimes(1);
    const next = bulk.execute(job("next"));
    worker.complete(0);
    await next;
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("propagates a typed job failure while retaining the healthy worker for the next read", async () => {
    const worker = new HeldWorker();
    const factory = vi.fn(() => worker);
    const bulk = executor(factory);
    const first = bulk.execute(job("missing"));
    const rejected = expect(first).rejects.toMatchObject({
      code: "artifact_unavailable",
      status: 404,
      retryable: false,
    });
    const next = bulk.execute(job("next"));
    const post = worker.posts[0]!;
    worker.reply({
      type: "failed",
      id: post.id,
      error: { message: "gone", code: "artifact_unavailable", status: 404, retryable: false },
      queueMs: 1,
      projectionMs: 2,
    });
    await rejected;
    worker.complete(1);
    await next;
    expect(factory).toHaveBeenCalledTimes(1);
    expect(worker.terminate).not.toHaveBeenCalled();
  });
});
