import { closeSync, fstatSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fsyncDirectory } from "../util/index.js";
import { ZERO_HASH, type JournalRecord } from "./frame-codec.js";
import type { JournalCompactionOutcome, JournalCompactionResult } from "./journal-compaction.js";
import { appendAndSync, openJournalWriter, reopenOriginalWriter } from "./journal-files.js";
import type { JournalFold } from "./journal-fold.js";
import { journalPartitionDirectory } from "./journal-partition.js";
import { recoverJournal } from "./journal-recovery.js";
import {
  JournalRecoveryRequiredError,
  journalRecoveryAt,
  type JournalRecoveryState,
} from "./journal-recovery-state.js";
import type { JournalPreparationReceipt } from "./read-only-preparation.js";

export interface DurableJournalOptions {
  rootDir: string;
  partition: string;
  now?: () => Date;
  epochFactory?: () => string;
  appendAndSync?: (fd: number, bytes: Buffer) => void;
  /** Growth since the last completed maintenance pass that arms a crossing:
   * the file bytes appended after the last background pass that reached the
   * data (an install, a real decline or a failed pass), never the absolute
   * file size, so a partition whose retained set alone exceeds the threshold
   * is compacted once per threshold of new bytes rather than on every append.
   * Under a fold the
   * replay at open is the first completed pass: the baseline starts at the
   * file size minus what the fold retired while replaying, so a restart on an
   * already-compacted partition waits for a threshold of new bytes while a
   * legacy partition whose replay retires a threshold's worth fires at once.
   * Without a fold the baseline starts at zero and the inline open-time
   * compaction keeps its absolute-size trigger. */
  compactionThresholdBytes?: number;
  /** The daemon opts into after-admission maintenance; standalone callers keep inline compaction. */
  deferCompaction?: boolean;
  /** Applied at replay and at background compaction; the retained set is what
   * `records()` sees while epoch/seq/chain state always follow the disk. */
  fold?: JournalFold;
  /** Fired at most once per threshold crossing after an append — a crossing
   * being `compactionThresholdBytes` of growth since the last completed pass —
   * and re-armed when a maintenance pass completes (install, typed decline or
   * a failed pass), so a daemon that dedupes in-flight requests sees every
   * new crossing and a
   * file that stays large never re-fires on every append. Never fires after
   * `close()`. No timers, no persisted state. */
  onCompactionThreshold?: () => void;
}

const DEFAULT_COMPACTION_THRESHOLD_BYTES = 8 * 1024 * 1024;

/** Writer state, recovery and physical installation shared by the public
 * `DurableJournal` surface. Not exported from the package entry. */
export abstract class JournalCore {
  readonly options: Readonly<DurableJournalOptions>;
  readonly partitionDir: string;
  readonly path: string;
  protected readonly now: () => Date;
  protected readonly appendFrame: (fd: number, bytes: Buffer) => void;
  protected fd = -1;
  protected entries: JournalRecord[] = [];
  protected background: {
    controller: AbortController;
    promise: Promise<JournalCompactionOutcome>;
  } | null = null;
  protected epoch = "";
  protected nextSeq = 1;
  protected previousFrameHash = ZERO_HASH;
  protected knownFileBytes = 0;
  protected recovery: JournalRecoveryState = { status: "ready", discardedTailBytes: 0 };
  protected preparationState: JournalPreparationReceipt | null = null;
  protected writable = false;
  protected closed = false;
  protected thresholdNotified = false;
  /** File size at the last completed pass over the data: a folded replay
   * sets it to the size minus what it retired (0 without a fold), an install
   * to the installed size, and any other settled background pass — a real
   * decline or a failure — to the size it settled at. `atCompactionThreshold`
   * measures growth from it. */
  protected compactionBaselineBytes = 0;
  protected replayRetired = { count: 0, bytes: 0 };

  protected constructor(options: DurableJournalOptions) {
    if (!options.partition.trim()) throw new Error("journal partition must not be empty");
    this.options = Object.freeze({ ...options });
    this.now = options.now ?? (() => new Date());
    this.appendFrame = options.appendAndSync ?? appendAndSync;
    this.partitionDir = journalPartitionDirectory(options.rootDir, options.partition);
    this.path = join(this.partitionDir, "journal.bin");
  }

  /** Growth-since-last-pass edge: true once the file grew by the threshold
   * beyond the size the last completed pass left (or observed). */
  atCompactionThreshold(): boolean {
    return (
      this.knownFileBytes - this.compactionBaselineBytes >=
      (this.options.compactionThresholdBytes ?? DEFAULT_COMPACTION_THRESHOLD_BYTES)
    );
  }

  /** Replay the file into the retained set and disk chain state. Returns the
   * pending-suffix bytes recovery discarded; the caller journals that fact. */
  protected recover(): number {
    let result: ReturnType<typeof recoverJournal>;
    try {
      result = recoverJournal(this.fd, this.path, this.options, this.intentPath());
    } catch (error) {
      if (!(error instanceof JournalRecoveryRequiredError)) throw error;
      this.recovery = error.recovery;
      return 0;
    }
    this.entries = result.retained;
    this.replayRetired = { count: result.retiredCount, bytes: result.retiredBytes };
    this.epoch = result.epoch ?? this.epoch;
    this.nextSeq = result.nextSeq;
    this.previousFrameHash = result.previousFrameHash;
    this.knownFileBytes = result.knownFileBytes;
    this.compactionBaselineBytes = this.replayBaselineBytes();
    if (result.discardedBytes > 0)
      this.recovery = { status: "ready", discardedTailBytes: result.discardedBytes };
    return result.discardedBytes;
  }

  /** A folded replay is a completed pass: what it retired is the growth still
   * to reclaim (the retired bytes are logical sizes, so the result is clamped
   * at zero). Without a fold nothing was evaluated and the baseline stays 0. */
  protected replayBaselineBytes(): number {
    if (!this.options.fold) return 0;
    return Math.max(0, this.knownFileBytes - this.replayRetired.bytes);
  }

  protected intentPath(): string {
    return join(this.partitionDir, "append.pending.json");
  }

  protected openWriter(): void {
    this.fd = openJournalWriter(this.path);
    this.writable = true;
  }

  /** One physical install owner for both producers; no serialization or await. */
  protected installCompaction(result: JournalCompactionResult): void {
    const original = fstatSync(this.fd);
    if (result.knownFileBytes >= this.knownFileBytes)
      throw new Error("compaction did not reclaim bytes");
    let renamed = false;
    let closed = false;
    const fd = this.fd;
    this.fd = -1;
    this.writable = false;
    try {
      closeSync(fd);
      closed = true;
      renameSync(result.path, this.path);
      renamed = true;
      fsyncDirectory(dirname(this.path));
      this.openWriter();
    } catch (error) {
      this.closeWriter();
      if (closed && !renamed) {
        this.fd = reopenOriginalWriter(this.path, original);
        this.writable = this.fd >= 0;
      }
      if (!this.writable)
        throw new JournalRecoveryRequiredError(
          this.requireRecovery(
            0,
            `journal compaction install failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      throw error;
    }
    this.entries = result.records;
    this.epoch = result.epoch;
    this.nextSeq = result.nextSeq;
    this.previousFrameHash = result.previousFrameHash;
    this.knownFileBytes = result.knownFileBytes;
    this.compactionBaselineBytes = result.knownFileBytes;
    this.thresholdNotified = false;
  }

  protected closeWriter(): void {
    const fd = this.fd;
    this.fd = -1;
    this.writable = false;
    if (fd < 0) return;
    try {
      closeSync(fd);
    } catch {
      /* best-effort revocation: the handle number is never reused by this writer */
    }
  }

  protected failPreparedActivation(error: unknown): never {
    this.closeWriter();
    this.entries.length = 0;
    this.nextSeq = 1;
    this.previousFrameHash = ZERO_HASH;
    this.knownFileBytes = 0;
    this.compactionBaselineBytes = 0;
    const recovery =
      error instanceof JournalRecoveryRequiredError
        ? error.recovery
        : this.requireRecovery(
            0,
            `prepared activation failed: ${error instanceof Error ? error.message : String(error)}`,
          );
    this.recovery = structuredClone(recovery);
    throw new JournalRecoveryRequiredError(recovery);
  }

  protected requireRecovery(
    byteOffset: number,
    reason: string,
  ): Extract<JournalRecoveryState, { status: "recovery_required" }> {
    this.recovery = journalRecoveryAt(byteOffset, reason);
    this.background?.controller.abort();
    return this.recovery;
  }

  protected assertReadable(): void {
    this.assertOpen();
    if (this.recovery.status === "recovery_required") {
      throw new JournalRecoveryRequiredError(this.recovery);
    }
  }

  protected assertWritable(): void {
    if (!this.writable) throw new Error("journal preparation is not activated");
  }

  protected assertOpen(): void {
    if (this.closed) throw new Error("journal writer is closed");
  }
}
