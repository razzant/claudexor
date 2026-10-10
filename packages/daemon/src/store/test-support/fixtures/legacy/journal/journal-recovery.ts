import { descriptorSize, readFrames, type FrameReadResult } from "./frame-reader.js";
import {
  readIntent,
  removeFile,
  truncatePendingSuffix,
  type AppendIntent,
} from "./journal-files.js";
import type { JournalFold } from "./journal-fold.js";
import { JournalRecoveryRequiredError, journalRecoveryAt } from "./journal-recovery-state.js";

export interface RecoveredJournal {
  retained: FrameReadResult["retained"];
  epoch: string | null;
  nextSeq: number;
  previousFrameHash: string;
  knownFileBytes: number;
  discardedBytes: number;
  retiredCount: number;
  retiredBytes: number;
}

/** Recover only the original canonical file. A compaction candidate is never
 * consulted as recovery authority. Returns the retained ACK history for its
 * writer plus the chain state of the last frame on disk. A positional-read
 * failure propagates with its own message; only intent handling is labelled. */
export function recoverJournal(
  fd: number,
  path: string,
  options: { partition: string; fold?: JournalFold },
  intentPath: string,
): RecoveredJournal {
  const size = descriptorSize(fd);
  let intent: AppendIntent | null;
  try {
    intent = readIntent(intentPath);
  } catch (error) {
    throw required(0, `append intent is malformed: ${String(error)}`);
  }
  if (!intent) {
    const decoded = readFrames(fd, options.partition, { fold: options.fold });
    if (decoded.incompleteOffset !== null)
      throw required(decoded.incompleteOffset, "unexplained suffix without append intent");
    if (decoded.error) throw required(decoded.error.offset, decoded.error.reason);
    return recovered(decoded, size, 0);
  }
  if (intent.offset > size || size > intent.offset + intent.length) {
    throw required(intent.offset, "append intent does not match the journal prefix");
  }
  const decoded = readFrames(fd, options.partition, { limit: intent.offset, fold: options.fold });
  if (decoded.error || decoded.incompleteOffset !== null) {
    throw required(intent.offset, "append intent does not match the journal prefix");
  }
  const discardedBytes = size - intent.offset;
  try {
    if (discardedBytes > 0) truncatePendingSuffix(fd, path, intent.offset, size);
    removeFile(intentPath);
  } catch (error) {
    throw required(intent.offset, `append intent recovery failed: ${String(error)}`);
  }
  return recovered(decoded, intent.offset, discardedBytes);
}

function recovered(
  decoded: FrameReadResult,
  knownFileBytes: number,
  discardedBytes: number,
): RecoveredJournal {
  return {
    retained: decoded.retained,
    epoch: decoded.epoch,
    nextSeq: decoded.nextSeq,
    previousFrameHash: decoded.previousFrameHash,
    knownFileBytes,
    discardedBytes,
    retiredCount: decoded.retiredCount,
    retiredBytes: decoded.retiredBytes,
  };
}

function required(byteOffset: number, reason: string): JournalRecoveryRequiredError {
  return new JournalRecoveryRequiredError(journalRecoveryAt(byteOffset, reason));
}
