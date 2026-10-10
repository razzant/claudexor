import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ControlJournalExportReceipt,
  ControlJournalInspection,
  ControlJournalQuarantineReceipt,
  ControlJournalValidation,
  type ControlJournalEvent,
} from "@claudexor/schema";
import type { JournalRecoveryState } from "./errors.js";
import { ensureCanonicalPrivateDirectory, fsyncDirectory } from "@claudexor/util";
import {
  cloneRecovery,
  copyOwnedFile,
  sha256,
  sha256File,
  writeAtomicPrivateJson,
  writeExclusiveFile,
} from "../journal-recovery-files.js";
import {
  conflict,
  matchingReceipt,
  quarantineRequestDigest,
  readOperation,
  typedError,
  validateRequest,
  type JournalQuarantineRequest,
  type QuarantineOperation,
} from "../journal-recovery-operation.js";
import type { PartitionControlPort } from "../store-contracts.js";
import {
  engineFileEvidence,
  engineFingerprint,
  parseEngineFiles,
  syncEngineFiles,
  type EngineFileEvidence,
} from "./engine-recovery-files.js";

const PARTITION = "engine-state";
const PREFIX = "engine";
type Phase = "intent" | "closed" | "archived" | "completed";
interface EngineOperation extends QuarantineOperation {
  phase: Phase;
  newEpoch: string;
  closedFiles?: EngineFileEvidence[];
}
export interface EngineRecoveryLifecycle {
  state(): { generation: number; recovery: JournalRecoveryState };
  validate(): Promise<{ ok: boolean; detail: string | null }>;
  /** Fence ingress and close every SQL connection/worker, preserving root authority. */
  close(): Promise<void>;
  /** Durably create/verify this exact fresh generation and prepare its graph.
   * Parent opens normal admission only after the final receipt. Never import legacy. */
  createFresh(input: { operationId: string; newEpoch: string }): Promise<void>;
}
export interface EngineRecoveryOptions {
  now?: () => Date;
  /** Fault injection around real durable transitions; no runtime policy. */
  fault?(
    stage:
      "intent" | "closed" | "closed_record" | "renamed" | "archived_record" | "fresh" | "receipt",
    name?: string,
  ): void;
}

/** Existing recovery API's physical target. Its one external operation record
 * survives corruption/replacement of the database whose recovery it authorizes. */
export class EngineStateRecovery implements PartitionControlPort {
  readonly partition = PARTITION;
  private readonly operationsDir: string;
  private readonly quarantineDir: string;
  private readonly now: () => Date;
  private tail: Promise<void> = Promise.resolve();
  constructor(
    readonly rootDir: string,
    private readonly lifecycle: EngineRecoveryLifecycle,
    private readonly options: EngineRecoveryOptions = {},
  ) {
    if (realpathSync(rootDir) !== rootDir)
      throw new Error("engine recovery requires its canonical data root");
    this.operationsDir = join(rootDir, "recovery-operations", PARTITION);
    this.quarantineDir = join(rootDir, "journal-quarantine");
    this.now = options.now ?? (() => new Date());
  }

  inspect(): ControlJournalInspection {
    const { generation, recovery } = this.lifecycle.state();
    const fingerprint = engineFingerprint(engineFileEvidence(this.rootDir));
    return ControlJournalInspection.parse({
      schemaVersion: 1,
      partition: PARTITION,
      generation,
      status: recovery.status,
      recovery: cloneRecovery(recovery),
      fingerprint,
      observedAt: this.now().toISOString(),
      evidenceRefs: [`recovery:${PARTITION}:${fingerprint}`],
    });
  }
  async validate(): Promise<ControlJournalValidation> {
    let result;
    try {
      result = await this.lifecycle.validate();
    } catch (error) {
      result = { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
    const inspected = this.inspect();
    const recovery = result.ok
      ? inspected.recovery
      : {
          status: "recovery_required" as const,
          location: { kind: "byte" as const, byteOffset: 0 },
          reason: result.detail ?? "engine state could not be validated",
          discardedTailBytes: 0,
        };
    return ControlJournalValidation.parse({
      ...inspected,
      status: recovery.status,
      recovery,
      projectionStatus: [
        {
          name: "sqlite.integrity",
          status: result.ok ? "valid" : "invalid",
          detail: result.detail,
        },
      ],
    });
  }
  events(): ControlJournalEvent[] {
    throw typedError(
      "recovery_events_unavailable",
      409,
      "engine-state is a physical diagnostic target; journal events belong to logical partitions",
    );
  }

  exportRecovery(): ControlJournalExportReceipt {
    const inspection = this.inspect();
    const files = engineFileEvidence(this.rootDir);
    if (engineFingerprint(files) !== inspection.fingerprint)
      throw conflict("recovery_fingerprint_mismatch");
    const exportId = `engine-export-${this.now().getTime().toString(36)}-${randomUUID()}`;
    const exportsRoot = join(this.rootDir, "recovery-exports");
    ensureCanonicalPrivateDirectory(exportsRoot);
    const bundlePath = join(exportsRoot, exportId);
    mkdirSync(bundlePath, { mode: 0o700 });
    try {
      for (const file of files) {
        if (file.sha256 === null) continue;
        if (
          copyOwnedFile(join(this.rootDir, file.name), join(bundlePath, file.name), 0o400) !==
          file.sha256
        )
          throw conflict("recovery_fingerprint_mismatch");
      }
      if (engineFingerprint(engineFileEvidence(this.rootDir)) !== inspection.fingerprint)
        throw conflict("recovery_fingerprint_mismatch");
      const createdAt = this.now().toISOString();
      const path = join(bundlePath, "manifest.json");
      writeExclusiveFile(
        path,
        Buffer.from(
          `${JSON.stringify({ schemaVersion: 1, exportId, partition: PARTITION, fingerprint: inspection.fingerprint, recovery: inspection.recovery, createdAt, diagnosticOnly: true, integrity: "not_verified", entries: files, externalEvidence: "SQL body blobs, uploads, per-run and setup artifacts remain in their existing locations; this is a raw corruption diagnostic, not a restorable complete store snapshot." }, null, 2)}\n`,
        ),
        0o400,
      );
      fsyncDirectory(bundlePath);
      fsyncDirectory(exportsRoot);
      fsyncDirectory(this.rootDir);
      return ControlJournalExportReceipt.parse({
        schemaVersion: 1,
        exportId,
        partition: PARTITION,
        fingerprint: inspection.fingerprint,
        bundlePath,
        manifestSha256: sha256File(path),
        createdAt,
      });
    } catch (error) {
      rmSync(bundlePath, { recursive: true, force: true });
      throw error;
    }
  }

  preflightQuarantine(input: JournalQuarantineRequest) {
    validateRequest(input);
    const operation = this.read(this.operationPath(sha256(Buffer.from(input.idempotencyKey))));
    if (operation) {
      if (operation.requestDigest !== quarantineRequestDigest(PARTITION, input))
        throw conflict("idempotency_conflict");
      return operation.status === "completed"
        ? {
            disposition: "completed",
            receipt: matchingReceipt(operation, undefined, PARTITION, PREFIX),
          }
        : { disposition: "prepared", receipt: null };
    }
    if (this.pending().length)
      throw typedError(
        "recovery_operation_pending",
        409,
        "an earlier engine-state recovery operation must finish first",
      );
    const current = this.inspect();
    if (current.status !== "recovery_required")
      throw typedError(
        "journal_partition_ready",
        409,
        "only corrupt engine state can be quarantined",
      );
    if (current.fingerprint !== input.expectedFingerprint)
      throw conflict("recovery_fingerprint_mismatch");
    return { disposition: "new", receipt: null };
  }

  quarantineAndStartFresh(
    input: JournalQuarantineRequest,
  ): Promise<ControlJournalQuarantineReceipt> {
    return this.exclusive(async () => {
      const preflight = this.preflightQuarantine(input);
      if (preflight.disposition === "completed") {
        this.syncOperationCustody("completed");
        return preflight.receipt!;
      }
      const keyDigest = sha256(Buffer.from(input.idempotencyKey));
      const path = this.operationPath(keyDigest);
      let operation = this.read(path);
      if (!operation) {
        const operationId = randomUUID();
        operation = {
          schemaVersion: 1,
          operationId,
          keyDigest,
          requestDigest: quarantineRequestDigest(PARTITION, input),
          expectedFingerprint: input.expectedFingerprint,
          quarantinePath: join(this.quarantineDir, `${PREFIX}-${operationId}`),
          status: "prepared",
          receipt: null,
          phase: "intent",
          newEpoch: randomUUID().replaceAll("-", ""),
        };
        ensureCanonicalPrivateDirectory(dirname(this.operationsDir));
        writeAtomicPrivateJson(path, operation, true);
        this.syncOperationCustody("intent");
        this.options.fault?.("intent");
      }
      return this.resume(operation, path);
    });
  }

  /** Startup reconciles accepted intent before any ordinary open/import choice. */
  resumePending(): Promise<ControlJournalQuarantineReceipt | null> {
    return this.exclusive(async () => {
      const pending = this.pending();
      if (pending.length > 1)
        throw typedError(
          "recovery_operation_ambiguous",
          503,
          "multiple pending engine-state recovery operations",
        );
      return pending[0] ? this.resume(pending[0], this.operationPath(pending[0].keyDigest)) : null;
    });
  }

  private async resume(
    operation: EngineOperation,
    path: string,
  ): Promise<ControlJournalQuarantineReceipt> {
    this.syncOperationCustody(operation.phase);
    await this.lifecycle.close();
    this.options.fault?.("closed");
    if (operation.phase === "intent") {
      const closedFiles = engineFileEvidence(this.rootDir);
      syncEngineFiles(this.rootDir, closedFiles);
      fsyncDirectory(this.rootDir);
      operation = { ...operation, phase: "closed", closedFiles };
      writeAtomicPrivateJson(path, operation, false);
      this.options.fault?.("closed_record");
    }
    if (operation.phase === "closed") {
      ensureCanonicalPrivateDirectory(this.quarantineDir);
      ensureCanonicalPrivateDirectory(operation.quarantinePath);
      // Persist the destination directory name before source entries disappear.
      fsyncDirectory(operation.quarantinePath);
      fsyncDirectory(this.quarantineDir);
      fsyncDirectory(this.rootDir);
      for (const file of operation.closedFiles!) {
        const source = join(this.rootDir, file.name),
          target = join(operation.quarantinePath, file.name);
        if (existsSync(target)) {
          if (file.sha256 === null || existsSync(source) || sha256File(target) !== file.sha256)
            throw typedError(
              "recovery_quarantine_mismatch",
              503,
              "archived engine file differs from the closed source inventory",
            );
          continue;
        }
        if (file.sha256 === null) {
          if (existsSync(source)) throw conflict("recovery_fingerprint_mismatch");
          continue;
        }
        if (!existsSync(source) || sha256File(source) !== file.sha256)
          throw conflict("recovery_fingerprint_mismatch");
        renameSync(source, target);
        fsyncDirectory(operation.quarantinePath);
        fsyncDirectory(this.rootDir);
        this.options.fault?.("renamed", file.name);
      }
      operation = { ...operation, phase: "archived" };
      writeAtomicPrivateJson(path, operation, false);
      this.options.fault?.("archived_record");
    }
    await this.lifecycle.createFresh({
      operationId: operation.operationId,
      newEpoch: operation.newEpoch,
    });
    this.options.fault?.("fresh");
    const receipt = ControlJournalQuarantineReceipt.parse({
      schemaVersion: 1,
      operationId: operation.operationId,
      partition: PARTITION,
      previousFingerprint: operation.expectedFingerprint,
      quarantineArtifactId: `${PREFIX}-${operation.operationId}`,
      quarantinePath: operation.quarantinePath,
      newEpoch: operation.newEpoch,
      completedAt: this.now().toISOString(),
    });
    writeAtomicPrivateJson(
      path,
      { ...operation, status: "completed", phase: "completed", receipt },
      false,
    );
    this.options.fault?.("receipt");
    return receipt;
  }

  private operationPath(keyDigest: string): string {
    return join(this.operationsDir, `${keyDigest}.json`);
  }
  private syncOperationCustody(phase: Phase): void {
    // A failed directory sync can leave renamed JSON visible but not yet durable.
    fsyncDirectory(this.operationsDir);
    if (phase === "intent") {
      fsyncDirectory(dirname(this.operationsDir));
      fsyncDirectory(this.rootDir);
    }
  }
  private read(path: string): EngineOperation | null {
    const base = readOperation(path, this.quarantineDir, PARTITION, PREFIX);
    if (!base) return null;
    const op = base as EngineOperation;
    if (
      !/^[a-f0-9]{32}$/.test(op.newEpoch) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(op.operationId) ||
      !["intent", "closed", "archived", "completed"].includes(op.phase) ||
      (op.status === "completed") !== (op.phase === "completed")
    )
      throw typedError(
        "recovery_operation_malformed",
        503,
        "engine recovery operation has invalid progress metadata",
      );
    if (op.phase !== "intent") op.closedFiles = parseEngineFiles(op.closedFiles);
    if (op.receipt && op.receipt.newEpoch !== op.newEpoch)
      throw typedError(
        "recovery_receipt_mismatch",
        503,
        "engine recovery receipt has another epoch",
      );
    return op;
  }
  private pending(): EngineOperation[] {
    if (!existsSync(this.operationsDir)) return [];
    return readdirSync(this.operationsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.read(join(this.operationsDir, name)))
      .filter((op): op is EngineOperation => op !== null && op.status !== "completed");
  }
  private async exclusive<T>(body: () => Promise<T>): Promise<T> {
    const before = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((done) => {
      release = done;
    });
    await before;
    try {
      return await body();
    } finally {
      release();
    }
  }
}
