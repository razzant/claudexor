import type { JournalRecoveryState } from "@claudexor/daemon";
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
