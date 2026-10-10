import {
  SqlEventLedger,
  bindSetupInTx,
  lookupIdempotency,
  runMutation,
  currentGeneration,
  encodeJournalCursor,
  decodeJournalCursor,
  type EngineStore,
  type StoreEvent,
} from "@claudexor/daemon";
import { JournalRecoveryRequiredError, type JournalRecoveryState } from "@claudexor/journal";
import { SetupJobProjection } from "./setup-job-projection.js";
import {
  idempotencyConflict,
  parseBinding,
  type SetupCreateBinding,
  type SetupJobPersistence,
  type SetupJournalPayload,
  type SetupOperation,
} from "./setup-job-persistence.js";

/** The existing setup projection over a supplied SQL global generation. No journal is opened. */
export class SqlSetupJobStore extends SetupJobProjection {
  constructor(rootDir: string, store: EngineStore, ledger: SqlEventLedger) {
    super(rootDir, () => new SqlSetupPersistence(store, ledger), store.now);
  }
}

class SqlSetupPersistence implements SetupJobPersistence {
  constructor(
    private readonly store: EngineStore,
    private readonly ledger: SqlEventLedger,
  ) {
    if (ledger.generation.name !== "global")
      throw new Error("setup lifecycle requires the global SQL generation");
  }

  state(): JournalRecoveryState {
    const current = currentGeneration(this.store, "global");
    if (current?.pid === this.ledger.generation.pid)
      return { status: "ready", discardedTailBytes: 0 };
    return {
      status: "recovery_required",
      location: { kind: "cursor", epoch: this.ledger.generation.epoch, seq: 0 },
      reason: "setup SQL generation is not the current global generation",
      discardedTailBytes: 0,
    };
  }

  append(type: string, payload: SetupJournalPayload, operation?: SetupOperation): void {
    const prepared = this.ledger.prepare(type, payload);
    runMutation(this.store, (tx) => {
      if (payload.binding !== undefined) {
        const binding = parseBinding(payload.binding);
        if (!binding || !operation) throw new Error("invalid setup binding mutation");
        bindSetupInTx(tx, this.ledger.generation.pid, binding, operation, prepared.time);
      }
      this.ledger.appendInTx(tx, prepared);
    });
  }

  records(afterSeq: number, types: readonly string[]) {
    return this.ledger.records<SetupJournalPayload>(afterSeq, types);
  }
  savedEvents(jobId: string, afterSeq: number) {
    return this.ledger.recordsInGroup<SetupJournalPayload>(`s:${jobId}:saved`, afterSeq, [
      "setup.job.saved",
    ]);
  }
  currentSequence(): number {
    const row = this.store
      .prepare("SELECT next_seq FROM partition WHERE id = ?")
      .get(this.ledger.generation.pid) as { next_seq: number };
    return Number(row.next_seq) - 1;
  }
  currentCursor(): string {
    const { name, epoch } = this.ledger.generation;
    return encodeJournalCursor(name, epoch, this.currentSequence());
  }
  sequenceAfter(cursor?: string | null): number {
    const { name, epoch } = this.ledger.generation;
    return decodeJournalCursor(cursor, name, epoch, this.currentSequence() + 1);
  }
  cursorFor(record: Pick<StoreEvent, "partition" | "epoch" | "seq">): string {
    return this.ledger.cursorFor(record);
  }
  resolveBinding(binding: SetupCreateBinding): SetupCreateBinding | undefined {
    let prior;
    try {
      prior = lookupIdempotency(
        this.store,
        { owner: "setup", pid: this.ledger.generation.pid, keyDigest: binding.keyDigest },
        binding.requestDigest,
      );
    } catch (error) {
      if ((error as { code?: string }).code === "idempotency_conflict") throw idempotencyConflict();
      throw error;
    }
    return prior
      ? { keyDigest: prior.keyDigest, requestDigest: prior.requestDigest, jobId: prior.targetId }
      : undefined;
  }
  rememberBinding(binding: SetupCreateBinding, record?: Pick<StoreEvent, "epoch" | "seq">): void {
    // The SQL row is the replay authority; constructor replay validates it and
    // never synthesizes missing bindings from saved events.
    try {
      const prior = this.resolveBinding(binding);
      if (!prior || prior.jobId !== binding.jobId)
        throw new Error("setup event has no matching SQL binding");
    } catch (error) {
      if (!record) throw error;
      throw new JournalRecoveryRequiredError({
        status: "recovery_required",
        location: { kind: "cursor", epoch: record.epoch, seq: record.seq },
        reason: `invalid setup SQL binding: ${error instanceof Error ? error.message : String(error)}`,
        discardedTailBytes: 0,
      });
    }
  }
}
