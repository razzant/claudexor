import type { DurableJournal } from "@claudexor/journal";

export interface JournalProjectionDescriptor<T> {
  name: string;
  create(journal: DurableJournal): T;
  validate(projection: T): void;
}

export interface JournalProjectionSlot<T> {
  current(): T;
  generation(): number;
}
