import { randomUUID } from "node:crypto";
import {
  ControlJournalQuarantineReceipt,
  ControlJournalValidation,
  type ControlJournalInspection,
} from "@claudexor/schema";
import {
  conflict,
  quarantineRequestDigest,
  typedError,
  validateRequest,
  type JournalQuarantineRequest,
} from "../journal-recovery-operation.js";
import { sha256 } from "../journal-recovery-files.js";
import type { PartitionControlPort } from "../store-contracts.js";
import type { BlobFiles } from "./blob-files.js";
import { readJournalEvents } from "./cursors.js";
import { StoreError } from "./errors.js";
import { quarantineGeneration, setGenerationStatusInTx } from "./generations.js";
import type { MaintenanceController } from "./maintenance.js";
import { runMutation } from "./mutation.js";
import { partitionById, type PartitionGeneration } from "./partitions.js";
import type { EngineStore } from "./store.js";
import { exportSqlRecovery } from "./sql-recovery-export.js";
import {
  assertPartitionReadable,
  inspection,
  partitionEvidence,
  recoveryGeneration,
} from "./sql-recovery-inspection.js";

/** The composition root supplies its existing pure/stateful projection validators.
 * Validation must be synchronous and side-effect free; no substitute reducers. */
export interface SqlRecoveryProjection {
  name: string;
  validate(generation: PartitionGeneration): void;
}
export interface SqlRecoveryOptions {
  projections(generation: PartitionGeneration): readonly SqlRecoveryProjection[];
  onQuarantined?(
    receipt: ControlJournalQuarantineReceipt,
    previous: PartitionGeneration,
    current: PartitionGeneration,
  ): void;
  onPhysicalCorruption?(problem: StoreError): void;
}

/** Logical partition recovery over one supplied store. Physical SQLite repair
 * remains the owning application's whole-store engine-state lifecycle. */
export class SqlPartitionRecovery implements PartitionControlPort {
  constructor(
    private readonly store: EngineStore,
    private readonly blobs: BlobFiles,
    private readonly maintenance: Pick<MaintenanceController, "integrityCheck" | "exportTo">,
    readonly partition: string,
    private readonly options: SqlRecoveryOptions,
  ) {}

  inspect(): ControlJournalInspection {
    this.assertPhysicalHealthy();
    const generation = recoveryGeneration(this.store, this.partition);
    return inspection(
      this.store,
      partitionEvidence(this.store, generation),
      this.store.now().toISOString(),
    );
  }

  async validate(): Promise<ControlJournalValidation> {
    const integrity = await this.maintenance.integrityCheck();
    if (!integrity.ok) this.physicalCorruption(integrity.problems.join("; "));
    const generation = recoveryGeneration(this.store, this.partition);
    const before = partitionEvidence(this.store, generation);
    const statuses: ControlJournalValidation["projectionStatus"] = [
      {
        name: "sqlite.integrity",
        status: "valid",
        detail: "Whole engine database integrity_check passed.",
      },
    ];
    const projections = this.options.projections(generation);
    if (projections.length === 0)
      throw new StoreError(
        "recovery_validation_unavailable",
        503,
        false,
        "no projection validators are registered for this partition",
      );
    let failed = false;
    for (const projection of projections) {
      try {
        const result: unknown = projection.validate(generation);
        if (result && typeof (result as { then?: unknown }).then === "function")
          throw new Error("SQL recovery projection validation must be synchronous");
        statuses.push({ name: projection.name, status: "valid", detail: null });
      } catch (error) {
        if ((error as { code?: string }).code === "store_corrupt")
          this.physicalCorruption(error instanceof Error ? error.message : String(error));
        failed = true;
        statuses.push({
          name: projection.name,
          status: "invalid",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const after = partitionEvidence(this.store, recoveryGeneration(this.store, this.partition));
    if (before.fingerprint !== after.fingerprint)
      throw new StoreError(
        "recovery_validation_changed",
        409,
        true,
        "partition changed during projection validation",
      );
    if (failed)
      runMutation(this.store, (tx) =>
        setGenerationStatusInTx(tx, generation.pid, "recovery_required"),
      );
    return ControlJournalValidation.parse({ ...this.inspect(), projectionStatus: statuses });
  }

  events(afterCursor?: string) {
    this.assertPhysicalHealthy();
    assertPartitionReadable(this.store, recoveryGeneration(this.store, this.partition));
    return readJournalEvents(this.store, this.partition, afterCursor, this.blobs);
  }

  exportRecovery() {
    this.assertPhysicalHealthy();
    recoveryGeneration(this.store, this.partition);
    return exportSqlRecovery(this.store, this.blobs, this.maintenance, this.partition);
  }

  preflightQuarantine(input: JournalQuarantineRequest) {
    validateRequest(input);
    this.assertPhysicalHealthy();
    const prior = this.replay(input);
    if (prior) return { disposition: "completed", receipt: prior };
    const current = this.inspect();
    if (recoveryGeneration(this.store, this.partition).status !== "recovery_required")
      throw typedError(
        "journal_partition_ready",
        409,
        "only a corrupt partition can be quarantined",
      );
    if (current.fingerprint !== input.expectedFingerprint)
      throw conflict("recovery_fingerprint_mismatch");
    return { disposition: "new", receipt: null };
  }

  quarantineAndStartFresh(input: JournalQuarantineRequest): ControlJournalQuarantineReceipt {
    const preflight = this.preflightQuarantine(input);
    if (preflight.disposition === "completed") return preflight.receipt!;
    const previous = recoveryGeneration(this.store, this.partition);
    const operationId = randomUUID();
    const epoch = randomUUID().replaceAll("-", "");
    const receipt = ControlJournalQuarantineReceipt.parse({
      schemaVersion: 1,
      operationId,
      partition: this.partition,
      previousFingerprint: input.expectedFingerprint,
      quarantineArtifactId: `partition-${previous.pid}-${operationId}`,
      quarantinePath: `partition:${this.partition}@${previous.epoch}`,
      newEpoch: epoch,
      completedAt: this.store.now().toISOString(),
    });
    const outcome = quarantineGeneration(this.store, this.blobs, {
      oldPid: previous.pid,
      keyDigest: sha256(Buffer.from(input.idempotencyKey)),
      requestDigest: quarantineRequestDigest(this.partition, input),
      operationId,
      payload: receipt,
      epoch,
    });
    if (outcome.replay) return this.replay(input)!;
    this.options.onQuarantined?.(receipt, previous, outcome.generation!);
    return receipt;
  }

  private replay(input: JournalQuarantineRequest): ControlJournalQuarantineReceipt | null {
    // The old generation is the key's scope. Search its addressed binding before
    // current-registry preconditions; global recovery may have hidden the project.
    const rows = this.store
      .prepare(
        `SELECT i.pid,i.request_digest,i.target_id FROM partition p JOIN idempotency i
      ON i.pid=p.id AND i.owner='quarantine' AND i.key_digest=? WHERE p.name=? LIMIT 2`,
      )
      .all(sha256(Buffer.from(input.idempotencyKey)), this.partition) as Array<{
      pid: number;
      request_digest: string;
      target_id: string;
    }>;
    if (rows.length === 0) return null;
    if (rows.length !== 1)
      throw typedError(
        "recovery_operation_ambiguous",
        503,
        "multiple quarantine bindings match this key",
      );
    const binding = rows[0]!;
    if (binding.request_digest !== quarantineRequestDigest(this.partition, input))
      throw conflict("idempotency_conflict");
    const old = partitionById(this.store, binding.pid)!;
    // Receipts are small, retained event rows. Never use today's current epoch
    // to manufacture a receipt for an earlier successfully committed operation.
    const records = this.store
      .prepare(
        `SELECT e.payload FROM partition p JOIN event e ON e.pid=p.id
      WHERE p.name=? AND e.type='journal.partition_quarantined'
      AND json_extract(CAST(e.payload AS TEXT),'$.operationId')=?`,
      )
      .all(this.partition, binding.target_id) as Array<{ payload: Uint8Array }>;
    if (records.length !== 1)
      throw typedError(
        "recovery_operation_missing",
        503,
        "original quarantine receipt is unavailable",
      );
    const receipt = ControlJournalQuarantineReceipt.parse(
      JSON.parse(Buffer.from(records[0]!.payload).toString("utf8")),
    );
    if (
      receipt.partition !== this.partition ||
      receipt.operationId !== binding.target_id ||
      receipt.previousFingerprint !== input.expectedFingerprint ||
      receipt.quarantinePath !== `partition:${this.partition}@${old.epoch}`
    )
      throw typedError(
        "recovery_receipt_mismatch",
        503,
        "quarantine receipt does not match intent",
      );
    return receipt;
  }

  private assertPhysicalHealthy(): void {
    if (this.store.facts().integrity === "failed")
      this.physicalCorruption("engine store integrity check failed");
  }
  private physicalCorruption(detail: string): never {
    const problem = new StoreError(
      "store_corrupt",
      503,
      false,
      `physical SQLite recovery requires the whole engine-state owner: ${detail}`,
    );
    this.options.onPhysicalCorruption?.(problem);
    throw problem;
  }
}
