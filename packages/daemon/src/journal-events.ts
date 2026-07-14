import {
  DurableJournal,
  JournalRecoveryRequiredError,
  type JournalRecoveryState,
} from "@claudexor/journal";
import type { ControlJournalEvent } from "@claudexor/schema";

export function journalEvents(
  journal: DurableJournal | null,
  recovery: JournalRecoveryState,
  afterCursor?: string,
): ControlJournalEvent[] {
  if (!journal || recovery.status === "recovery_required") {
    throw new JournalRecoveryRequiredError(
      recovery.status === "recovery_required"
        ? recovery
        : {
            status: "recovery_required",
            location: { kind: "byte", byteOffset: 0 },
            reason: "journal partition is unavailable",
            discardedTailBytes: 0,
          },
    );
  }
  const afterSeq = afterCursor ? journal.sequenceAfter(afterCursor) : 0;
  return journal.records(afterSeq).map((record) => ({
    schemaVersion: 1,
    cursor: journal.cursorAt(record.seq),
    partition: record.partition,
    type: record.type,
    observedAt: record.time,
    payload: record.payload,
  }));
}
