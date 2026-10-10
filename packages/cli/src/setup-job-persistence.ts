import type { DurableJournal, JournalRecoveryState } from "@claudexor/journal";
import {
  parseSetupBinding as parseBinding,
  setupIdempotencyConflict as idempotencyConflict,
  type SetupCreateBinding,
  type StoreEvent,
} from "@claudexor/daemon";
export { parseBinding, idempotencyConflict };
export type { SetupCreateBinding };

export type SetupOperation = "setup.job.create" | "setup.job.extend";
export interface SetupCreateIdempotency {
  key: string;
  client: string;
  request: unknown;
}
export type SetupJournalPayload = {
  job?: unknown;
  jobId?: unknown;
  line?: unknown;
  binding?: unknown;
};

/** Setup uses only logical persistence, cursor and binding authority, never a journal path. */
export interface SetupJobPersistence {
  state(): JournalRecoveryState;
  append(type: string, payload: SetupJournalPayload, operation?: SetupOperation): void;
  records(afterSeq: number, types: readonly string[]): StoreEvent<SetupJournalPayload>[];
  savedEvents(jobId: string, afterSeq: number): StoreEvent<SetupJournalPayload>[];
  currentCursor(): string;
  currentSequence(): number;
  sequenceAfter(cursor?: string | null): number;
  cursorFor(record: Pick<StoreEvent, "partition" | "epoch" | "seq">): string;
  resolveBinding(binding: SetupCreateBinding): SetupCreateBinding | undefined;
  rememberBinding(binding: SetupCreateBinding, record?: Pick<StoreEvent, "epoch" | "seq">): void;
}

/** Retains the legacy replay authority; SQL implements the same small port separately. */
export class LegacySetupPersistence implements SetupJobPersistence {
  private readonly bindings = new Map<string, SetupCreateBinding>();
  constructor(private readonly journal: DurableJournal) {}
  state() {
    return this.journal.state();
  }
  append(type: string, payload: SetupJournalPayload) {
    this.journal.append(type, payload);
  }
  records(afterSeq: number, types: readonly string[]) {
    return this.journal.records<SetupJournalPayload>(afterSeq, types);
  }
  savedEvents(_jobId: string, afterSeq: number) {
    return this.records(afterSeq, ["setup.job.saved"]);
  }
  currentCursor() {
    return this.journal.currentCursor();
  }
  currentSequence() {
    return this.journal.currentSequence();
  }
  sequenceAfter(cursor?: string | null) {
    return this.journal.sequenceAfter(cursor);
  }
  cursorFor(record: Pick<StoreEvent, "partition" | "epoch" | "seq">) {
    return this.journal.cursorFor(record);
  }
  resolveBinding(binding: SetupCreateBinding) {
    return this.bindings.get(binding.keyDigest);
  }
  rememberBinding(binding: SetupCreateBinding): void {
    const prior = this.resolveBinding(binding);
    if (prior && (prior.requestDigest !== binding.requestDigest || prior.jobId !== binding.jobId))
      throw idempotencyConflict();
    this.bindings.set(binding.keyDigest, { ...binding });
  }
}
