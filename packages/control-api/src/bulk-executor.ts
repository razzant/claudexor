import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { processTiming } from "@claudexor/util";
import { RetainedOutputPublisher } from "./retained-output.js";
import {
  BULK_WORKER_ROLE,
  type BulkJob,
  type BulkKind,
  type BulkResults,
  type WorkerReply,
  type WorkerRequest,
} from "./bulk-protocol.js";
// Keep the role in single-file bundles. Its guarded entry is inert on the main thread.
import "./bulk-worker.js";

function workerEntry(): URL {
  const adjacent = new URL("./bulk-worker.js", import.meta.url);
  if (existsSync(adjacent)) return adjacent;
  // Source tests/dev use the built worker; production packages ship adjacent dist files.
  if (import.meta.url.endsWith(".ts")) return new URL("../dist/bulk-worker.js", import.meta.url);
  // esbuild defines import.meta.url to the containing CJS/ESM bundle URL.
  return new URL(import.meta.url);
}

export function bulkUnavailable(
  code: "bulk_worker_failed" | "bulk_read_cancelled" | "daemon_stopping",
): Error {
  return Object.assign(
    new Error(
      code === "daemon_stopping"
        ? "control API is stopping"
        : code === "bulk_read_cancelled"
          ? "observation read cancelled"
          : "bulk observation worker stopped; retry the read",
    ),
    { status: 503, code, retryable: true },
  );
}

interface Pending {
  id: number;
  job: BulkJob;
  enqueuedAt: number;
  resolve(value: BulkResults[BulkKind]): void;
  reject(error: unknown): void;
  cleanup(): void;
  cancelled: boolean;
}

/** One lazy worker, owned by this server. No admission policy or persistent data cache. */
export class BulkExecutor {
  private worker: Worker | undefined;
  private readonly queue: Pending[] = [];
  private running: Pending | undefined;
  private nextId = 0;
  private stopped = false;
  private readonly publication = new RetainedOutputPublisher();

  constructor(
    private readonly createWorker: () => Worker = () =>
      new Worker(fileURLToPath(workerEntry()), {
        workerData: { role: BULK_WORKER_ROLE },
        name: "claudexor-control-bulk",
      }),
  ) {}

  execute<K extends BulkKind>(job: BulkJob<K>, signal?: AbortSignal): Promise<BulkResults[K]> {
    if (this.stopped) return Promise.reject(bulkUnavailable("daemon_stopping"));
    if (signal?.aborted) return Promise.reject(bulkUnavailable("bulk_read_cancelled"));
    return new Promise<BulkResults[K]>((resolve, reject) => {
      const entry: Pending = {
        id: ++this.nextId,
        job: job as BulkJob,
        enqueuedAt: performance.timeOrigin + performance.now(),
        resolve: (value) => resolve(value as BulkResults[K]),
        reject,
        cancelled: false,
        cleanup: () => signal?.removeEventListener("abort", abort),
      };
      const abort = () => {
        entry.cancelled = true;
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        entry.cleanup();
        reject(bulkUnavailable("bulk_read_cancelled"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(entry);
      this.dispatch();
    });
  }

  /** Reject receipts immediately. Never join a projection or wait for its file reads. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.fail(bulkUnavailable("daemon_stopping"));
  }

  private fail(error: Error): void {
    const worker = this.worker;
    this.worker = undefined;
    const all = this.running ? [this.running, ...this.queue] : [...this.queue];
    this.running = undefined;
    this.queue.length = 0;
    for (const entry of all) {
      entry.cleanup();
      entry.reject(error);
    }
    if (worker) {
      worker.unref();
      void worker.terminate().catch(() => {});
    }
  }

  private dispatch(): void {
    if (this.running || this.stopped || !this.queue.length) return;
    if (!this.worker) {
      let worker: Worker;
      try {
        worker = this.createWorker();
      } catch {
        this.fail(bulkUnavailable("bulk_worker_failed"));
        return;
      }
      this.worker = worker;
      worker.on("message", (message: WorkerReply) => this.receive(worker, message));
      const failed = () => {
        if (this.worker === worker) this.fail(bulkUnavailable("bulk_worker_failed"));
      };
      worker.on("error", failed);
      worker.on("exit", failed);
      worker.unref();
    }
    this.running = this.queue.shift()!;
    this.worker.ref();
    try {
      this.worker.postMessage({
        type: "run",
        id: this.running.id,
        job: this.running.job,
        enqueuedAt: this.running.enqueuedAt,
      } satisfies WorkerRequest);
    } catch {
      this.fail(bulkUnavailable("bulk_worker_failed"));
    }
  }

  private receive(worker: Worker, message: WorkerReply): void {
    const entry = this.running;
    if (this.worker !== worker || !entry || entry.id !== message.id) return;
    if (message.type === "publish-retained") {
      if (entry.job.kind !== "detail") {
        this.fail(bulkUnavailable("bulk_worker_failed"));
        return;
      }
      const write = entry.cancelled
        ? Promise.resolve(null)
        : this.publication.publish(entry.job.input.record, message.bytes);
      void write.then((problem) => {
        if (this.worker === worker)
          worker.postMessage({ type: "published", id: entry.id, problem } satisfies WorkerRequest);
      });
      return;
    }
    // Route-health fact reads stay out of the status timing facts: their bulk
    // kinds are a closed set that older strict clients validate.
    if (entry.job.kind !== "route-facts")
      processTiming.recordBulk(entry.job.kind, message.queueMs, message.projectionMs);
    this.running = undefined;
    entry.cleanup();
    if (!entry.cancelled) {
      if (message.type === "result") entry.resolve(message.value);
      else entry.reject(Object.assign(new Error(message.error.message), message.error));
    }
    worker.unref();
    this.dispatch();
  }
}
