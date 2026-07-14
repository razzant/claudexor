import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  DurableJournal,
  JournalRecoveryRequiredError,
  journalPartitionDirectory,
  type JournalRecoveryState,
} from "@claudexor/journal";
import {
  ControlJournalQuarantineReceipt as QuarantineReceiptSchema,
  type ControlJournalExportReceipt,
  type ControlJournalInspection,
  type ControlJournalQuarantineReceipt,
  type ControlJournalQuarantineRequest,
  type ControlJournalValidation,
} from "@claudexor/schema";
import { ensureCanonicalPrivateDirectory } from "@claudexor/util";
import {
  exportPartitionEntries,
  fingerprintPartition,
  fsyncDirectory,
  readOwnedFile,
  sha256,
  sha256File,
  writeAtomicPrivateJson,
  writeExclusiveFile,
} from "./journal-recovery-files.js";

export type JournalInspection = ControlJournalInspection;
export type JournalValidation = ControlJournalValidation;
export type JournalExportReceipt = ControlJournalExportReceipt;
export type JournalQuarantineReceipt = ControlJournalQuarantineReceipt;
export type JournalQuarantineRequest = ControlJournalQuarantineRequest & {
  idempotencyKey: string;
};

export interface JournalProjectionDescriptor<T> {
  name: string;
  create(journal: DurableJournal): T;
  validate(projection: T): void;
}

export interface JournalProjectionSlot<T> {
  current(): T;
  generation(): number;
}

export type JournalQuarantinePreflight =
  | { disposition: "new" | "prepared"; receipt: null }
  | { disposition: "completed"; receipt: JournalQuarantineReceipt };

interface ProjectionRegistration<T = unknown> {
  descriptor: JournalProjectionDescriptor<T>;
  slot: ProjectionSlot<T>;
}

interface QuarantineOperation {
  schemaVersion: 1;
  operationId: string;
  keyDigest: string;
  requestDigest: string;
  expectedFingerprint: string;
  quarantinePath: string;
  status: "prepared" | "completed";
  receipt: JournalQuarantineReceipt | null;
}

export interface JournalManagerFaults {
  afterQuarantineRename?: () => void;
  afterQuarantineReceipt?: () => void;
}

/** Owns the Phase-0 global journal writer and its replaceable projections. */
export class JournalManager {
  readonly journalRoot: string;
  readonly partitionDir: string;
  private readonly operationsDir: string;
  private readonly quarantineDir: string;
  private readonly registrations = new Map<string, ProjectionRegistration>();
  private journal: DurableJournal | null = null;
  private recovery: JournalRecoveryState = { status: "ready", discardedTailBytes: 0 };
  private generationValue = 0;
  private started = false;
  private closed = false;

  constructor(
    readonly rootDir: string,
    private readonly now: () => Date = () => new Date(),
    private readonly faults: JournalManagerFaults = {},
  ) {
    ensureCanonicalPrivateDirectory(rootDir);
    this.journalRoot = join(realpathSync(rootDir), "journal");
    ensureCanonicalPrivateDirectory(this.journalRoot);
    this.partitionDir = journalPartitionDirectory(this.journalRoot, "global");
    this.operationsDir = join(this.rootDir, "recovery-operations");
    this.quarantineDir = join(this.rootDir, "journal-quarantine");
  }

  registerProjection<T>(descriptor: JournalProjectionDescriptor<T>): JournalProjectionSlot<T> {
    this.assertOpen();
    if (this.started) throw new Error("journal projection registration is closed");
    if (!/^[A-Za-z0-9._-]+$/.test(descriptor.name) || this.registrations.has(descriptor.name)) {
      throw new Error(`invalid or duplicate journal projection '${descriptor.name}'`);
    }
    const slot = new ProjectionSlot<T>(() => this.recovery);
    this.registrations.set(descriptor.name, { descriptor, slot } as ProjectionRegistration);
    return slot;
  }

  start(): JournalInspection {
    this.assertOpen();
    if (this.started) return this.inspect();
    if (this.registrations.size === 0) throw new Error("global journal requires a projection");
    this.started = true;
    if (!this.reconcilePrepared()) this.openGeneration();
    return this.inspect();
  }

  inspect(): JournalInspection {
    this.assertStarted();
    if (this.journal && this.recovery.status === "ready") {
      const state = this.journal.state();
      if (state.status === "recovery_required") this.enterRecovery(state);
    }
    return this.inspection(fingerprintPartition(this.partitionDir));
  }

  validate(): JournalValidation {
    this.assertStarted();
    const before = fingerprintPartition(this.partitionDir);
    const projectionStatus: JournalValidation["projectionStatus"] = [];
    for (const registration of this.registrations.values()) {
      try {
        const projection = registration.slot.current();
        registration.descriptor.validate(projection);
        projectionStatus.push({
          name: registration.descriptor.name,
          status: "valid",
          detail: null,
        });
      } catch (error) {
        this.enterRecovery(
          recoveryFrom(error, `projection '${registration.descriptor.name}' failed`),
        );
        projectionStatus.push({
          name: registration.descriptor.name,
          status: "invalid",
          detail: safeMessage(error),
        });
      }
    }
    const after = fingerprintPartition(this.partitionDir);
    if (before !== after) this.enterRecovery(recoveryAt(0, "journal changed during validation"));
    return { ...this.inspection(after), projectionStatus };
  }

  exportRecovery(): JournalExportReceipt {
    this.assertStarted();
    const fingerprint = fingerprintPartition(this.partitionDir);
    const exportId = `journal-export-${this.now().getTime().toString(36)}-${randomUUID()}`;
    const exportsRoot = join(this.rootDir, "recovery-exports");
    ensureCanonicalPrivateDirectory(exportsRoot);
    const bundlePath = join(exportsRoot, exportId);
    ensureCanonicalPrivateDirectory(bundlePath);
    try {
      const entries = exportPartitionEntries(this.partitionDir, bundlePath);
      const createdAt = this.now().toISOString();
      const manifestPath = join(bundlePath, "manifest.json");
      writeExclusiveFile(
        manifestPath,
        Buffer.from(
          `${JSON.stringify(
            {
              schemaVersion: 1,
              exportId,
              partition: "global",
              fingerprint,
              recovery: this.recovery,
              createdAt,
              entries,
            },
            null,
            2,
          )}\n`,
        ),
        0o400,
      );
      fsyncDirectory(bundlePath);
      if (fingerprintPartition(this.partitionDir) !== fingerprint) {
        throw new Error("journal changed during recovery export");
      }
      return {
        schemaVersion: 1,
        exportId,
        partition: "global",
        fingerprint,
        bundlePath,
        manifestSha256: sha256File(manifestPath),
        createdAt,
      };
    } catch (error) {
      rmSync(bundlePath, { recursive: true, force: true });
      fsyncDirectory(exportsRoot);
      throw error;
    }
  }

  preflightQuarantine(input: JournalQuarantineRequest): JournalQuarantinePreflight {
    this.assertStarted();
    validateRequest(input);
    const keyDigest = sha256(Buffer.from(input.idempotencyKey));
    const path = join(this.operationsDir, `${keyDigest}.json`);
    const existing = readOperation(path, this.quarantineDir);
    const requestDigest = quarantineRequestDigest(input);
    if (existing) {
      if (existing.requestDigest !== requestDigest) throw conflict("idempotency_conflict");
      if (existing.status === "completed") {
        return { disposition: "completed", receipt: matchingReceipt(existing) };
      }
      return { disposition: "prepared", receipt: null };
    }
    if (this.recovery.status !== "recovery_required") {
      throw typedError(
        "journal_partition_ready",
        409,
        "only a corrupt partition can be quarantined",
      );
    }
    if (fingerprintPartition(this.partitionDir) !== input.expectedFingerprint) {
      throw conflict("recovery_fingerprint_mismatch");
    }
    return { disposition: "new", receipt: null };
  }

  quarantineAndStartFresh(input: JournalQuarantineRequest): JournalQuarantineReceipt {
    const preflight = this.preflightQuarantine(input);
    if (preflight.disposition === "completed") return preflight.receipt;
    ensureCanonicalPrivateDirectory(this.operationsDir);
    ensureCanonicalPrivateDirectory(this.quarantineDir);
    const keyDigest = sha256(Buffer.from(input.idempotencyKey));
    const operationPath = join(this.operationsDir, `${keyDigest}.json`);
    let operation = readOperation(operationPath, this.quarantineDir);
    if (!operation) {
      const operationId = randomUUID();
      operation = {
        schemaVersion: 1,
        operationId,
        keyDigest,
        requestDigest: quarantineRequestDigest(input),
        expectedFingerprint: input.expectedFingerprint,
        quarantinePath: join(this.quarantineDir, `global-${operationId}`),
        status: "prepared",
        receipt: null,
      };
      writeAtomicPrivateJson(operationPath, operation, true);
    }
    return this.resume(operation, operationPath);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearSlots();
    this.journal?.close();
    this.journal = null;
  }

  private openGeneration(): void {
    this.assertOpen();
    this.journal?.close();
    this.journal = null;
    this.clearSlots();
    this.generationValue += 1;
    try {
      this.journal = new DurableJournal({
        rootDir: this.journalRoot,
        partition: "global",
        now: this.now,
      });
      this.recovery = this.journal.state();
      if (this.recovery.status === "recovery_required") return;
      for (const registration of this.registrations.values()) {
        const projection = registration.descriptor.create(this.journal);
        registration.descriptor.validate(projection);
        registration.slot.bind(projection, this.generationValue);
      }
    } catch (error) {
      const failed = this.journal;
      this.journal = null;
      try {
        failed?.close();
      } catch {
        /* preserve the projection/open failure */
      }
      this.enterRecovery(recoveryFrom(error, "global journal could not be opened"));
    }
    if (this.recovery.status === "recovery_required") this.clearSlots();
  }

  private resume(operation: QuarantineOperation, operationPath: string): JournalQuarantineReceipt {
    const sourceExists = existsSync(this.partitionDir);
    const targetExists = existsSync(operation.quarantinePath);
    if (sourceExists && targetExists) return this.completeFromReceipt(operation, operationPath);
    if (sourceExists) {
      if (fingerprintPartition(this.partitionDir) !== operation.expectedFingerprint) {
        throw conflict("recovery_fingerprint_mismatch");
      }
      this.clearSlots();
      this.journal?.close();
      this.journal = null;
      renameSync(this.partitionDir, operation.quarantinePath);
      fsyncDirectory(this.journalRoot);
      fsyncDirectory(dirname(operation.quarantinePath));
      if (fingerprintPartition(operation.quarantinePath) !== operation.expectedFingerprint) {
        throw typedError("recovery_quarantine_mismatch", 503, "quarantined bytes changed");
      }
      this.faults.afterQuarantineRename?.();
    } else if (!targetExists) {
      throw typedError("recovery_operation_missing", 503, "recovery source and target are missing");
    } else if (fingerprintPartition(operation.quarantinePath) !== operation.expectedFingerprint) {
      throw typedError("recovery_quarantine_mismatch", 503, "quarantined bytes changed");
    }

    this.openGeneration();
    if (!this.journal || this.recovery.status === "recovery_required") {
      throw new JournalRecoveryRequiredError(
        this.recovery.status === "recovery_required"
          ? this.recovery
          : recoveryAt(0, "fresh journal failed to initialize"),
      );
    }
    if (this.journal.records().length !== 0) {
      throw typedError("recovery_operation_ambiguous", 503, "fresh journal is not empty");
    }
    const receipt: JournalQuarantineReceipt = {
      schemaVersion: 1,
      operationId: operation.operationId,
      partition: "global",
      previousFingerprint: operation.expectedFingerprint,
      quarantineArtifactId: `global-${operation.operationId}`,
      quarantinePath: operation.quarantinePath,
      newEpoch: this.journal.currentEpoch(),
      completedAt: this.now().toISOString(),
    };
    this.journal.append("journal.partition_quarantined", receipt);
    this.faults.afterQuarantineReceipt?.();
    writeAtomicPrivateJson(operationPath, { ...operation, status: "completed", receipt }, false);
    return receipt;
  }

  private completeFromReceipt(
    operation: QuarantineOperation,
    operationPath: string,
  ): JournalQuarantineReceipt {
    if (fingerprintPartition(operation.quarantinePath) !== operation.expectedFingerprint) {
      throw typedError("recovery_quarantine_mismatch", 503, "quarantined bytes changed");
    }
    if (!this.journal) this.openGeneration();
    if (!this.journal || this.recovery.status === "recovery_required") {
      throw typedError("recovery_operation_ambiguous", 503, "fresh journal is unreadable");
    }
    const records = this.journal.records();
    if (records.length !== 1 || records[0]?.type !== "journal.partition_quarantined") {
      throw typedError("recovery_operation_ambiguous", 503, "fresh receipt is missing");
    }
    const receipt = matchingReceipt(operation, records[0].payload);
    writeAtomicPrivateJson(operationPath, { ...operation, status: "completed", receipt }, false);
    return receipt;
  }

  private reconcilePrepared(): boolean {
    if (!existsSync(this.operationsDir)) return false;
    try {
      const prepared = readdirSync(this.operationsDir)
        .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
        .map((name) => {
          const path = join(this.operationsDir, name);
          return { path, operation: readOperation(path, this.quarantineDir) };
        })
        .filter(
          (entry): entry is { path: string; operation: QuarantineOperation } =>
            entry.operation?.status === "prepared",
        );
      if (prepared.length === 0) return false;
      if (prepared.length !== 1) throw new Error("multiple prepared recovery operations");
      const pending = prepared[0]!;
      if (existsSync(this.partitionDir) && !existsSync(pending.operation.quarantinePath)) {
        this.openGeneration();
      } else {
        this.resume(pending.operation, pending.path);
      }
    } catch (error) {
      this.enterRecovery(recoveryFrom(error, "prepared quarantine reconciliation failed"));
    }
    return true;
  }

  private inspection(fingerprint: string): JournalInspection {
    return {
      schemaVersion: 1,
      partition: "global",
      generation: this.generationValue,
      status: this.recovery.status,
      recovery: cloneRecovery(this.recovery),
      fingerprint,
      observedAt: this.now().toISOString(),
      evidenceRefs: [`recovery:global:${fingerprint}`],
    };
  }

  private enterRecovery(state: Extract<JournalRecoveryState, { status: "recovery_required" }>) {
    this.recovery = cloneRecovery(state) as typeof state;
    this.clearSlots();
  }

  private clearSlots(): void {
    for (const registration of this.registrations.values()) registration.slot.clear();
  }

  private assertStarted(): void {
    this.assertOpen();
    if (!this.started) throw new Error("journal manager is not running");
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("journal manager is closed");
  }
}

class ProjectionSlot<T> implements JournalProjectionSlot<T> {
  private value: T | null = null;
  private generationValue = 0;

  constructor(private readonly recovery: () => JournalRecoveryState) {}

  current(): T {
    if (this.value !== null) return this.value;
    const state = this.recovery();
    throw new JournalRecoveryRequiredError(
      state.status === "recovery_required"
        ? state
        : recoveryAt(0, "journal projection is unavailable"),
    );
  }

  generation(): number {
    return this.generationValue;
  }

  bind(value: T, generation: number): void {
    this.value = value;
    this.generationValue = generation;
  }

  clear(): void {
    this.value = null;
  }
}

function readOperation(path: string, quarantineDir: string): QuarantineOperation | null {
  if (!existsSync(path)) return null;
  const value = JSON.parse(readOwnedFile(path).toString("utf8")) as unknown;
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.operationId !== "string" ||
    typeof value.keyDigest !== "string" ||
    basename(path) !== `${value.keyDigest}.json` ||
    typeof value.requestDigest !== "string" ||
    typeof value.expectedFingerprint !== "string" ||
    typeof value.quarantinePath !== "string" ||
    value.quarantinePath !== join(quarantineDir, `global-${value.operationId}`) ||
    (value.status !== "prepared" && value.status !== "completed")
  ) {
    throw new Error("recovery operation is malformed");
  }
  const operation = value as unknown as QuarantineOperation;
  if (operation.status === "prepared" && operation.receipt !== null) {
    throw new Error("prepared recovery operation contains a receipt");
  }
  if (operation.status === "completed") matchingReceipt(operation);
  return operation;
}

function matchingReceipt(
  operation: QuarantineOperation,
  value: unknown = operation.receipt,
): JournalQuarantineReceipt {
  const receipt = QuarantineReceiptSchema.parse(value);
  if (
    receipt.operationId !== operation.operationId ||
    receipt.previousFingerprint !== operation.expectedFingerprint ||
    receipt.quarantinePath !== operation.quarantinePath ||
    receipt.quarantineArtifactId !== `global-${operation.operationId}`
  ) {
    throw typedError("recovery_receipt_mismatch", 503, "quarantine receipt does not match intent");
  }
  return receipt;
}

function validateRequest(input: JournalQuarantineRequest): void {
  if (!input.idempotencyKey || input.idempotencyKey.length > 256) {
    throw typedError(
      "invalid_idempotency_key",
      400,
      "Idempotency-Key must contain 1-256 characters",
    );
  }
  if (input.confirmation !== "quarantine_and_start_fresh") {
    throw typedError("quarantine_confirmation_required", 400, "explicit confirmation is required");
  }
  if (!/^[a-f0-9]{64}$/.test(input.expectedFingerprint)) {
    throw typedError("invalid_recovery_fingerprint", 400, "expectedFingerprint must be SHA-256");
  }
}

function quarantineRequestDigest(input: JournalQuarantineRequest): string {
  return sha256(
    Buffer.from(
      JSON.stringify({
        partition: "global",
        expectedFingerprint: input.expectedFingerprint,
        confirmation: input.confirmation,
      }),
    ),
  );
}

function recoveryFrom(
  error: unknown,
  fallback: string,
): Extract<JournalRecoveryState, { status: "recovery_required" }> {
  if (error instanceof JournalRecoveryRequiredError) return cloneRecovery(error.recovery) as any;
  return recoveryAt(0, `${fallback}: ${safeMessage(error)}`);
}

function recoveryAt(
  byteOffset: number,
  reason: string,
): Extract<JournalRecoveryState, { status: "recovery_required" }> {
  return {
    status: "recovery_required",
    location: { kind: "byte", byteOffset },
    reason,
    discardedTailBytes: 0,
  };
}

function cloneRecovery(value: JournalRecoveryState): JournalRecoveryState {
  return value.status === "ready" ? { ...value } : { ...value, location: { ...value.location } };
}

function conflict(code: string): Error & { code: string; status: number } {
  return typedError(code, 409, code.replaceAll("_", " "));
}

function typedError(code: string, status: number, message: string) {
  return Object.assign(new Error(message), { code, status });
}

function safeMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
