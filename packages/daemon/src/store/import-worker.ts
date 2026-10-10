import { totalmem } from "node:os";
import { Worker } from "node:worker_threads";
import { STORE_WORKER_DATA_KEY, resolveStoreWorkerEntry } from "./flusher-protocol.js";
import type { ImportProgress, LegacyImportOptions, LegacyImportReceipt } from "./importer.js";
// The existing maintenance role is also the import owner in a bundled runtime.
import "./maintenance-worker.js";

export interface LegacyImportWorkerData {
  [STORE_WORKER_DATA_KEY]: "maintenance";
  import: Omit<LegacyImportOptions, "onProgress" | "now" | "partitions"> & {
    partitions?: LegacyImportOptions["partitions"];
  };
}

/** One maintenance worker and one temporary writer. The main thread observes
 * postMessage progress and never opens a reader against the temporary DB.
 * Cancellation resolves only after that exact worker has exited. */
export function importLegacyInWorker(
  input: LegacyImportWorkerData["import"],
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: ImportProgress) => void;
    workerEntry?: string;
  } = {},
): Promise<LegacyImportReceipt> {
  options.signal?.throwIfAborted();
  const worker = new Worker(
    options.workerEntry ?? resolveStoreWorkerEntry(import.meta.url, "maintenance-worker.js"),
    {
      workerData: {
        [STORE_WORKER_DATA_KEY]: "maintenance",
        import: input,
      } satisfies LegacyImportWorkerData,
      resourceLimits: {
        maxOldGenerationSizeMb: Math.floor(Math.min(4096, totalmem() / 2 / 1024 / 1024)),
      },
    },
  );
  return new Promise((resolve, reject) => {
    let receipt: LegacyImportReceipt | null = null;
    let failure: unknown = null;
    const abort = () => {
      failure = Object.assign(
        new Error("legacy import worker was cancelled; saved markers remain resumable"),
        {
          code: "store_import_interrupted",
          status: 503,
          retryable: true,
        },
      );
      void worker.terminate();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.on(
      "message",
      (message: {
        type: "progress" | "imported" | "import_failed";
        progress?: ImportProgress;
        receipt?: LegacyImportReceipt;
        error?: { message: string; code?: string; status?: number; retryable?: boolean };
      }) => {
        if (failure) return;
        if (message.type === "imported") receipt = message.receipt!;
        else if (message.type === "import_failed")
          failure = Object.assign(new Error(message.error!.message), message.error);
        else {
          try {
            options.onProgress?.(message.progress!);
          } catch (error) {
            failure = error;
            void worker.terminate();
          }
        }
      },
    );
    worker.once("error", (error) => {
      failure = error;
    });
    worker.once("exit", (code) => {
      options.signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code === 0 && receipt) resolve(receipt);
      else
        reject(
          Object.assign(
            new Error(`legacy import worker exited ${code} without a completed receipt`),
            {
              code: "store_import_interrupted",
              status: 503,
              retryable: true,
            },
          ),
        );
    });
    if (options.signal?.aborted) abort();
  });
}
