import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DurableJournal, type DurableJournalOptions } from "./fixtures/legacy/journal/index.js";

export interface LogicalFixture {
  partition: string;
  epoch: string;
  now: string;
  records: Array<{ type: string; payload: unknown }>;
}

/** Small portable bytes are checked in; framing still goes through the pinned journal. */
export function writeLogicalFixture(target: string, fixture: LogicalFixture): void {
  mkdirSync(target, { mode: 0o700 });
  const journal = new DurableJournal({
    rootDir: join(target, "journal"),
    partition: fixture.partition,
    epochFactory: () => fixture.epoch,
    now: () => new Date(fixture.now),
    deferCompaction: true,
  });
  try {
    journal.appendBatch(fixture.records);
  } finally {
    journal.close();
  }
}

/** Callers name their corpus explicitly. Never open an original fixture for writing. */
export function copyFixture(source: string, target: string): void {
  if (existsSync(target)) throw new Error("fixture working copy already exists");
  cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
}

export function readLogicalFixture(path: string): LogicalFixture {
  return JSON.parse(readFileSync(path, "utf8")) as LogicalFixture;
}

/** No recovery callbacks: M0 inspects the legacy projection before startup mutations. */
export function openFixtureJournal(
  workingCopy: string,
  fixture: Pick<LogicalFixture, "partition" | "now">,
  fold?: DurableJournalOptions["fold"],
): DurableJournal {
  return new DurableJournal({
    rootDir: join(workingCopy, "journal"),
    partition: fixture.partition,
    now: () => new Date(fixture.now),
    deferCompaction: true,
    fold,
  });
}
