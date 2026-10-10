import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  fingerprintPreparedJournal,
  inspectPreparedJournal,
  type PreparedJournalInspection,
} from "./legacy-journal/read-only-preparation.js";
import { readFrames } from "./legacy-journal/frame-reader.js";
import type { JournalRecord } from "./legacy-journal/frame-codec.js";
import { hashJson } from "@claudexor/util";
import { journalFoldPolicy } from "../journal-fold-policy.js";
import { importError } from "./import-context.js";

export interface ImportPartitionSource {
  name: string;
  directory: string;
}
export interface ImportSource {
  source: ImportPartitionSource;
  size: number;
  mtime: string;
  fingerprint: string;
  epoch: string;
  nextSeq: number;
  previousFrameHash: string;
  records: JournalRecord[];
  digest: string;
  recovery: PreparedJournalInspection["recovery"];
  discardedTailBytes: number;
}

/** No writer activation, truncation or source metadata rewrite is permitted here. */
export function readImportSource(
  journalRoot: string,
  source: ImportPartitionSource,
  emptyEpoch: string = randomUUID(),
): ImportSource {
  const path = join(source.directory, "journal.bin");
  const stat = existsSync(path) ? statSync(path, { bigint: true }) : null;
  const inspected = inspectPreparedJournal({
    rootDir: journalRoot,
    partitionDir: source.directory,
    journalPath: path,
    intentPath: join(source.directory, "append.pending.json"),
    partition: source.name,
    initialEpoch: emptyEpoch,
    fold: journalFoldPolicy,
  });
  let { records, epoch, nextSeq, previousFrameHash } = inspected;
  // A damaged non-intent tail is not served, but the validated prefix remains
  // inspectable evidence. The ordinary read-only preparation deliberately hides it.
  if (
    stat &&
    inspected.recovery.status === "recovery_required" &&
    !existsSync(join(source.directory, "append.pending.json"))
  ) {
    const fd = openSync(path, "r");
    try {
      const prefix = readFrames(fd, source.name, { fold: journalFoldPolicy });
      records = prefix.retained;
      epoch = prefix.epoch ?? emptyEpoch;
      nextSeq = prefix.nextSeq;
      previousFrameHash = prefix.previousFrameHash;
    } finally {
      closeSync(fd);
    }
  }
  assertImportSourceUnchanged(journalRoot, source, inspected.receipt.fingerprint);
  return {
    source,
    size: Number(stat?.size ?? 0),
    mtime: String(stat?.mtimeNs ?? 0),
    fingerprint: inspected.receipt.fingerprint,
    epoch,
    nextSeq,
    previousFrameHash,
    records,
    digest: importRecordsDigest(records),
    recovery: inspected.recovery,
    discardedTailBytes: inspected.receipt.deferredRepair?.discardedBytes ?? 0,
  };
}

export function importRecordsDigest(records: readonly JournalRecord[]): string {
  const hash = createHash("sha256");
  for (const { seq, time, type, payload } of records)
    hash.update(hashJson({ seq, time, type, payload })).update("\n");
  return hash.digest("hex");
}

export function assertImportSourceUnchanged(
  journalRoot: string,
  source: ImportPartitionSource,
  fingerprint: string,
): void {
  if (fingerprintPreparedJournal(journalRoot, source.directory).fingerprint !== fingerprint)
    throw importError("store_import_source_changed", `journal source changed: ${source.name}`);
}
