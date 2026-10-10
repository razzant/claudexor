import { unlinkSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { BlobFiles } from "./blob-files.js";
import { StoreCorruptError, StoreError } from "./errors.js";
import { STORE_WORKER_DATA_KEY, resolveStoreWorkerEntry } from "./flusher-protocol.js";
import type { EngineStore } from "./store.js";
import { cleanupUploadPart } from "./uploads.js";
// Static import: the worker module must be part of this module graph so the
// single-file daemon bundle embeds it (its self-start is inert on the main thread).
import "./maintenance-worker.js";

export interface MaintenanceWorkerData {
  [STORE_WORKER_DATA_KEY]: "maintenance";
  dbPath: string;
}

/** Requests are a discriminated union: the importer (PR-D) adds its kind here
 * and a handler in the worker; nothing else changes. */
export type MaintenanceRequest =
  | { id: number; kind: "integrity_check" }
  | { id: number; kind: "vacuum_into"; target: string }
  | {
      id: number;
      kind: "sweep_candidates";
      blobsDir: string;
      uploadsDir: string;
      /** Files whose mtime is at or after this epoch-ms instant are left alone. */
      olderThanMs: number;
    };

export interface IntegrityReport {
  ok: boolean;
  problems: string[];
  durationMs: number;
}

export interface ExportReport {
  target: string;
  bytes: number;
  durationMs: number;
}

/** What the worker enumerates (R5_AMENDMENTS A4/C2); the decision is made on main. */
export type SweepCandidate =
  | { kind: "blob"; path: string; sha: string }
  | { kind: "part"; path: string; uploadId: string }
  | { kind: "tmp"; path: string };

export interface SweepCandidates {
  scanned: number;
  keptYoung: number;
  keptOwned: number;
  candidates: SweepCandidate[];
  durationMs: number;
}

export interface SweepReport extends Omit<SweepCandidates, "candidates"> {
  removedBlobs: string[];
  removedTemps: string[];
  removedParts: string[];
  keptBlobs: string[];
  keptParts: string[];
  decisionMs: number;
}

export type MaintenanceResponse =
  | { id: number; ok: true; result: IntegrityReport | ExportReport | SweepCandidates }
  | { id: number; ok: false; error: string; code?: "store_corrupt" };

export interface MaintenanceControllerOptions {
  workerEntry?: string;
  log?: (line: string) => void;
  /** Epoch ms of this process's start: the sweep's deterministic age bound. */
  processStartedAt?: number;
  /** The store's blob owner (one per store: it holds the unref generations). */
  blobs?: BlobFiles;
}

interface Pending {
  request: MaintenanceRequest;
  resolve: (value: never) => void;
  reject: (error: Error) => void;
}

/**
 * Maintenance (SYNTHESIS_R5 §2, §6.5, §7 p.6; R5_AMENDMENTS A4, C2, C9):
 * long operations that must not touch the flusher's pass — `integrity_check`
 * after admission and on request, `VACUUM INTO` export, and the orphan sweep.
 * The worker owns a separate read-only connection, never shares a thread or
 * connection with the flusher, never writes a row, and only ENUMERATES sweep
 * candidates older than the process start; every removal is decided on the
 * main thread through the one owner-generation unlink rule (C10).
 */
export class MaintenanceController {
  private readonly entry: string;
  private readonly processStartedAt: number;
  private readonly blobs: BlobFiles;
  private worker: Worker | null = null;
  private readonly queue: Pending[] = [];
  private inFlight: Pending | null = null;
  private nextId = 1;
  private closing = false;

  constructor(
    private readonly store: EngineStore,
    private readonly options: MaintenanceControllerOptions = {},
  ) {
    this.entry =
      options.workerEntry ?? resolveStoreWorkerEntry(import.meta.url, "maintenance-worker.js");
    this.processStartedAt =
      options.processStartedAt ?? Date.now() - Math.round(process.uptime() * 1000);
    this.blobs = options.blobs ?? new BlobFiles(store);
  }

  /** `PRAGMA integrity_check` on the worker; the verdict becomes the `integrity` fact. */
  async integrityCheck(): Promise<IntegrityReport> {
    const report = await this.run<IntegrityReport>({ id: 0, kind: "integrity_check" });
    this.store.recordIntegrity(report.ok ? "ok" : "failed", report.problems.join("; "));
    return report;
  }

  /** `VACUUM INTO target`: a consistent snapshot copy, written by the worker. */
  exportTo(target: string): Promise<ExportReport> {
    return this.run<ExportReport>({ id: 0, kind: "vacuum_into", target });
  }

  /** The worker's candidate list for files older than the process start (test seam). */
  sweepCandidates(): Promise<SweepCandidates> {
    return this.run<SweepCandidates>({
      id: 0,
      kind: "sweep_candidates",
      blobsDir: this.store.paths.blobs,
      uploadsDir: this.store.paths.uploads,
      olderThanMs: this.processStartedAt,
    });
  }

  /**
   * Enumerate on the worker, decide on main: a blob goes through `gc(sha)`
   * (barrier + synchronous owner recheck); a `.part` stays while its upload
   * is open/uploaded/finalizing or its publish obligation is open, goes when
   * the upload is published and unobligated, and — with no `upload` row —
   * goes only through the owner-generation unlink rule (a barrier covering the
   * latest change of its row still shows no row, C10); a `.tmp` older than
   * the process start goes at once.
   */
  async sweepOrphans(): Promise<SweepReport> {
    const listed = await this.sweepCandidates();
    const started = performance.now();
    const report: SweepReport = {
      scanned: listed.scanned,
      keptYoung: listed.keptYoung,
      keptOwned: listed.keptOwned,
      durationMs: listed.durationMs,
      removedBlobs: [],
      removedTemps: [],
      removedParts: [],
      keptBlobs: [],
      keptParts: [],
      decisionMs: 0,
    };
    for (const candidate of listed.candidates) {
      if (candidate.kind === "tmp") {
        unlinkTolerant(candidate.path);
        report.removedTemps.push(candidate.path);
        continue;
      }
      if (candidate.kind === "blob") {
        const outcome = await this.blobs.gc(candidate.sha);
        (outcome === "removed" ? report.removedBlobs : report.keptBlobs).push(candidate.sha);
        continue;
      }
      const decision = await cleanupUploadPart(this.store, candidate.uploadId, candidate.path);
      (decision === "removed" ? report.removedParts : report.keptParts).push(candidate.path);
    }
    if (report.removedTemps.length > 0 || report.removedParts.length > 0) {
      this.store.registerExternal(this.store.paths.uploads);
      this.store.registerExternal(this.store.paths.blobs);
    }
    report.decisionMs = performance.now() - started;
    return report;
  }

  async stop(): Promise<void> {
    this.closing = true;
    const failure = new StoreError("store_closed", 503, false, "engine store is closing");
    for (const pending of this.queue.splice(0)) pending.reject(failure);
    this.inFlight?.reject(failure);
    this.inFlight = null;
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
  }

  private run<T>(request: MaintenanceRequest): Promise<T> {
    if (this.closing) {
      return Promise.reject(new StoreError("store_closed", 503, false, "engine store is closing"));
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        request: { ...request, id: this.nextId++ },
        resolve: resolve as (value: never) => void,
        reject,
      });
      this.pump();
    });
  }

  private pump(): void {
    if (this.inFlight || this.queue.length === 0 || this.closing) return;
    const pending = this.queue.shift()!;
    this.inFlight = pending;
    this.ensureWorker().postMessage(pending.request);
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const data: MaintenanceWorkerData = {
      [STORE_WORKER_DATA_KEY]: "maintenance",
      dbPath: this.store.paths.database,
    };
    const worker = new Worker(this.entry, {
      workerData: data,
      name: "claudexor-store-maintenance",
    });
    this.worker = worker;
    worker.on("message", (response: MaintenanceResponse) => {
      const current = this.inFlight;
      if (!current || current.request.id !== response.id) return;
      this.inFlight = null;
      if (response.ok) current.resolve(response.result as never);
      else {
        const error =
          response.code === "store_corrupt"
            ? new StoreCorruptError(response.error)
            : new StoreError("store_maintenance_failed", 503, true, response.error);
        current.reject(this.store.failure(error, "maintenance worker") as Error);
      }
      this.pump();
    });
    worker.on("error", (error) => {
      if (this.worker !== worker || this.closing) return;
      const failure = this.store.failure(error, "maintenance worker");
      if (failure instanceof StoreCorruptError) {
        this.inFlight?.reject(failure);
        this.inFlight = null;
      }
      this.options.log?.(`store maintenance worker error: ${error.message}`);
    });
    worker.on("exit", (code) => {
      if (this.worker !== worker) return;
      this.worker = null;
      if (this.closing) return;
      const failure = new StoreError(
        "store_maintenance_unavailable",
        503,
        true,
        `the maintenance worker exited with code ${code}`,
      );
      this.inFlight?.reject(failure);
      this.inFlight = null;
      // The next request spawns a fresh worker; queued requests continue on it.
      this.pump();
    });
    return worker;
  }
}

function unlinkTolerant(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
