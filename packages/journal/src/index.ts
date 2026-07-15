import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ensureCanonicalPrivateDirectory } from "@claudexor/util";
import {
  COMPACTED_SNAPSHOT,
  HASH_BYTES,
  MAX_PAYLOAD_BYTES,
  ZERO_HASH,
  encodeFrame,
  replayFrames,
  type CompactedRecord,
  type CompactedSnapshotPayload,
  type FrameHeader,
  type JournalRecord,
} from "./frame-codec.js";
export type { JournalRecord } from "./frame-codec.js";
export type JournalRecoveryLocation =
  | { kind: "byte"; byteOffset: number }
  | { kind: "cursor"; epoch: string; seq: number };

export type JournalRecoveryState =
  | { status: "ready"; discardedTailBytes: number }
  | {
      status: "recovery_required";
      location: JournalRecoveryLocation;
      reason: string;
      discardedTailBytes: number;
    };
export interface DurableJournalOptions {
  rootDir: string;
  partition: string;
  now?: () => Date;
  epochFactory?: () => string;
  appendAndSync?: (fd: number, bytes: Buffer) => void;
  compactionThresholdBytes?: number;
}

export function journalPartitionDirectory(rootDir: string, partition: string): string {
  if (!partition.trim()) throw new Error("journal partition must not be empty");
  const slug = partition.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 48) || "partition";
  return join(rootDir, `${slug}-${sha256(Buffer.from(partition)).slice(0, 12)}`);
}

interface AppendIntent {
  v: 1;
  offset: number;
  length: number;
}

export class JournalRecoveryRequiredError extends Error {
  readonly code: string = "journal_recovery_required";
  readonly status = 503;
  readonly retryable = false;
  readonly requiredActions = ["inspect_recovery", "export_recovery", "quarantine_partition"];
  readonly evidenceRefs: string[] = [];
  readonly recovery: Extract<JournalRecoveryState, { status: "recovery_required" }>;

  constructor(recovery: Extract<JournalRecoveryState, { status: "recovery_required" }>) {
    const safe = Object.freeze({ ...recovery, location: Object.freeze({ ...recovery.location }) });
    const where =
      safe.location.kind === "byte"
        ? `byte ${safe.location.byteOffset}`
        : `cursor ${safe.location.epoch}:${safe.location.seq}`;
    super(`journal partition requires recovery at ${where}: ${safe.reason}`);
    this.name = "JournalRecoveryRequiredError";
    this.recovery = safe;
  }
}

export class JournalAppendUncertainError extends JournalRecoveryRequiredError {
  override readonly code = "journal_append_uncertain";

  constructor(
    recovery: Extract<JournalRecoveryState, { status: "recovery_required" }>,
    options?: ErrorOptions,
  ) {
    super(recovery);
    this.name = "JournalAppendUncertainError";
    if (options?.cause !== undefined)
      Object.defineProperty(this, "cause", { value: options.cause });
  }
}

export class JournalCursorError extends Error {
  readonly code = "journal_cursor_invalid";
  readonly status = 409;
  readonly retryable = true;
  readonly requiredActions = ["resnapshot"];
}

/** Single-writer, checksummed journal. A returned append has reached fsync. */
export class DurableJournal {
  readonly options: Readonly<DurableJournalOptions>;
  readonly partitionDir: string;
  readonly path: string;
  private readonly now: () => Date;
  private readonly appendFrame: (fd: number, bytes: Buffer) => void;
  private fd: number;
  private readonly entries: JournalRecord[] = [];
  private epoch: string;
  private nextSeq = 1;
  private previousFrameHash = ZERO_HASH;
  private knownFileBytes = 0;
  private recovery: JournalRecoveryState = { status: "ready", discardedTailBytes: 0 };
  private closed = false;

  constructor(options: DurableJournalOptions) {
    if (!options.partition.trim()) throw new Error("journal partition must not be empty");
    this.options = Object.freeze({ ...options });
    this.now = options.now ?? (() => new Date());
    this.appendFrame = options.appendAndSync ?? appendAndSync;
    ensureCanonicalPrivateDirectory(options.rootDir);
    this.partitionDir = journalPartitionDirectory(options.rootDir, options.partition);
    ensureCanonicalPrivateDirectory(this.partitionDir);
    this.path = join(this.partitionDir, "journal.bin");
    ensurePrivateFile(this.path);
    this.fd = openSync(this.path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
    const stat = fstatSync(this.fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("journal file is not privately owned");
    if ((stat.mode & 0o777) !== 0o600) {
      fchmodSync(this.fd, 0o600);
      fsyncSync(this.fd);
    }
    this.epoch = (options.epochFactory ?? randomUUID)();
    this.recover();
    if (
      this.recovery.status === "ready" &&
      this.knownFileBytes >= (options.compactionThresholdBytes ?? 8 * 1024 * 1024)
    ) {
      this.compact();
    }
  }

  state(): JournalRecoveryState {
    this.assertOpen();
    return structuredClone(this.recovery);
  }

  records<T = unknown>(afterSeq = 0): JournalRecord<T>[] {
    this.assertReadable();
    return this.entries
      .filter((record) => record.seq > afterSeq)
      .map((record) => ({ ...record, payload: cloneJson(record.payload) as T }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }

  currentCursor(): string {
    this.assertReadable();
    return encodeCursor(this.options.partition, this.epoch, this.nextSeq - 1);
  }

  cursorAt(seq: number): string {
    this.assertReadable();
    if (!Number.isSafeInteger(seq) || seq < 0 || seq >= this.nextSeq) {
      throw new JournalCursorError("journal cursor sequence is outside the current epoch");
    }
    return encodeCursor(this.options.partition, this.epoch, seq);
  }

  currentSequence(): number {
    this.assertReadable();
    return this.nextSeq - 1;
  }

  currentEpoch(): string {
    this.assertReadable();
    return this.epoch;
  }

  physicalBytes(): number {
    this.assertOpen();
    return this.knownFileBytes;
  }

  /** Atomically replace physical frames with one checksummed compressed frame. */
  compact(): { beforeBytes: number; afterBytes: number; records: number } | null {
    this.assertReadable();
    if (this.entries.length === 0) return null;
    const logical: CompactedRecord[] = this.entries.map((record) => ({
      time: record.time,
      type: record.type,
      payload: cloneJson(record.payload),
    }));
    const compressed = gzipSync(Buffer.from(JSON.stringify(logical)));
    const payload: CompactedSnapshotPayload = {
      version: 1,
      count: logical.length,
      encoding: "gzip-base64",
      data: compressed.toString("base64"),
    };
    const payloadBytes = encodeJson(payload);
    if (payloadBytes.length > MAX_PAYLOAD_BYTES) {
      throw new Error("journal compaction snapshot exceeds the maximum frame payload");
    }
    const epoch = randomUUID();
    const header: FrameHeader = {
      partition: this.options.partition,
      epoch,
      seq: 1,
      previousFrameHash: ZERO_HASH,
      time: this.now().toISOString(),
      type: COMPACTED_SNAPSHOT,
      logicalSpan: logical.length,
    };
    const frame = encodeFrame(header, payloadBytes);
    if (frame.length >= this.knownFileBytes) return null;
    const temp = `${this.path}.${randomUUID()}.compact`;
    const tempFd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      appendAndSync(tempFd, frame);
    } finally {
      closeSync(tempFd);
    }
    const beforeBytes = this.knownFileBytes;
    renameSync(temp, this.path);
    fsyncDirectory(dirname(this.path));
    closeSync(this.fd);
    this.fd = openSync(this.path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
    const frameHash = frame.subarray(frame.length - HASH_BYTES).toString("hex");
    this.entries.splice(
      0,
      this.entries.length,
      ...logical.map((record, index) => ({
        partition: this.options.partition,
        epoch,
        seq: index + 1,
        previousFrameHash: index === 0 ? ZERO_HASH : frameHash,
        frameHash,
        time: record.time,
        type: record.type,
        payload: cloneJson(record.payload),
        byteOffset: 0,
      })),
    );
    this.epoch = epoch;
    this.nextSeq = logical.length + 1;
    this.previousFrameHash = frameHash;
    this.knownFileBytes = frame.length;
    return { beforeBytes, afterBytes: frame.length, records: logical.length };
  }

  sequenceAfter(cursor: string | null | undefined): number {
    this.assertReadable();
    if (!cursor) return 0;
    if (!/^[A-Za-z0-9_-]{1,4096}$/.test(cursor)) throw cursorError("malformed");
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    } catch {
      throw cursorError("malformed");
    }
    if (!isRecord(value) || Object.keys(value).sort().join(",") !== "e,p,s,v" || value.v !== 1) {
      throw cursorError("unsupported");
    }
    if (value.p !== this.options.partition || value.e !== this.epoch)
      throw cursorError("stale epoch");
    if (!Number.isSafeInteger(value.s) || Number(value.s) < 0 || Number(value.s) >= this.nextSeq) {
      throw cursorError("ahead of the durable partition");
    }
    if (encodeCursor(value.p as string, value.e as string, value.s as number) !== cursor) {
      throw cursorError("not canonically encoded");
    }
    return value.s as number;
  }

  cursorFor(record: Pick<JournalRecord, "partition" | "epoch" | "seq">): string {
    this.assertReadable();
    if (record.partition !== this.options.partition || record.epoch !== this.epoch) {
      throw new JournalCursorError("cannot encode a cursor for another partition or epoch");
    }
    return encodeCursor(record.partition, record.epoch, record.seq);
  }

  append<T>(type: string, payload: T): JournalRecord<T> {
    this.assertReadable();
    if (!type.trim()) throw new Error("journal record type must not be empty");
    const actualBytes = Number(fstatSync(this.fd, { bigint: true }).size);
    if (actualBytes !== this.knownFileBytes) {
      throw new JournalRecoveryRequiredError(
        this.requireRecovery(this.knownFileBytes, "journal changed outside its single writer"),
      );
    }
    const payloadBytes = encodeJson(payload);
    if (payloadBytes.length > MAX_PAYLOAD_BYTES) throw new Error("journal payload is too large");
    const header: FrameHeader = {
      partition: this.options.partition,
      epoch: this.epoch,
      seq: this.nextSeq,
      previousFrameHash: this.previousFrameHash,
      time: this.now().toISOString(),
      type,
    };
    const frame = encodeFrame(header, payloadBytes);
    const byteOffset = this.knownFileBytes;
    writeIntent(this.intentPath(), { v: 1, offset: byteOffset, length: frame.length });
    try {
      this.appendFrame(this.fd, frame);
      if (Number(fstatSync(this.fd, { bigint: true }).size) !== byteOffset + frame.length) {
        throw new Error("journal append did not write exactly one frame");
      }
      removeFile(this.intentPath());
    } catch (error) {
      const recovery = this.requireRecovery(
        byteOffset,
        "append/fsync completion is uncertain; restart and inspect before further mutations",
      );
      throw new JournalAppendUncertainError(recovery, { cause: error });
    }
    const frameHash = frame.subarray(frame.length - HASH_BYTES).toString("hex");
    const record: JournalRecord<T> = {
      partition: header.partition,
      epoch: header.epoch,
      seq: header.seq,
      previousFrameHash: header.previousFrameHash,
      frameHash,
      time: header.time,
      type: header.type,
      payload: JSON.parse(payloadBytes.toString("utf8")) as T,
      byteOffset,
    };
    this.entries.push(record as JournalRecord);
    this.nextSeq += 1;
    this.previousFrameHash = frameHash;
    this.knownFileBytes += frame.length;
    return { ...record, payload: cloneJson(record.payload) };
  }

  private recover(): void {
    let bytes = readDescriptor(this.fd);
    let discardedBytes = 0;
    try {
      const intent = readIntent(this.intentPath());
      if (intent) {
        const prefix = replayFrames(bytes.subarray(0, intent.offset), this.options.partition);
        if (
          intent.offset > bytes.length ||
          bytes.length > intent.offset + intent.length ||
          prefix.error ||
          prefix.incompleteOffset !== null
        ) {
          this.requireRecovery(intent.offset, "append intent does not match the journal prefix");
          return;
        }
        discardedBytes = bytes.length - intent.offset;
        if (discardedBytes > 0) {
          ftruncateSync(this.fd, intent.offset);
          fsyncSync(this.fd);
          bytes = bytes.subarray(0, intent.offset);
        }
        removeFile(this.intentPath());
      }
    } catch (error) {
      this.requireRecovery(0, `append intent is malformed: ${String(error)}`);
      return;
    }
    const decoded = replayFrames(bytes, this.options.partition);
    if (decoded.incompleteOffset !== null) {
      this.requireRecovery(decoded.incompleteOffset, "unexplained suffix without append intent");
      return;
    }
    if (decoded.error) {
      this.requireRecovery(decoded.error.offset, decoded.error.reason);
      return;
    }
    this.entries.push(...decoded.records);
    const last = this.entries.at(-1);
    if (last) {
      this.epoch = last.epoch;
      this.nextSeq = last.seq + 1;
      this.previousFrameHash = last.frameHash;
    }
    this.knownFileBytes = bytes.length;
    if (discardedBytes > 0) {
      this.recovery = { status: "ready", discardedTailBytes: discardedBytes };
      this.append("journal.recovery_tail_discarded", {
        recoveryId: randomUUID(),
        discardedBytes,
        validBytes: bytes.length,
        originalBytes: bytes.length + discardedBytes,
        detectedAt: this.now().toISOString(),
      });
    }
  }

  private intentPath(): string {
    return join(this.partitionDir, "append.pending.json");
  }

  private requireRecovery(
    byteOffset: number,
    reason: string,
  ): Extract<JournalRecoveryState, { status: "recovery_required" }> {
    const value = {
      status: "recovery_required" as const,
      location: { kind: "byte" as const, byteOffset },
      reason,
      discardedTailBytes: 0,
    };
    this.recovery = value;
    return value;
  }

  private assertReadable(): void {
    this.assertOpen();
    if (this.recovery.status === "recovery_required") {
      throw new JournalRecoveryRequiredError(this.recovery);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("journal writer is closed");
  }
}

function appendAndSync(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
  fsyncSync(fd);
}

function ensurePrivateFile(path: string): void {
  if (!existsSync(path)) {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDirectory(dirname(path));
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error("journal path is not a private regular file");
  }
}

function readDescriptor(fd: number): Buffer {
  const size = Number(fstatSync(fd, { bigint: true }).size);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("journal file size is invalid");
  const bytes = readFileSync(fd);
  if (bytes.length !== size) throw new Error("journal changed while being read");
  return bytes;
}

function readIntent(path: string): AppendIntent | null {
  if (!existsSync(path)) return null;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024) throw new Error("unsafe file");
    const value = JSON.parse(readFileSync(fd, "utf8")) as unknown;
    if (
      !isRecord(value) ||
      value.v !== 1 ||
      !Number.isSafeInteger(value.offset) ||
      Number(value.offset) < 0 ||
      !Number.isSafeInteger(value.length) ||
      Number(value.length) <= 0
    )
      throw new Error("invalid shape");
    return value as unknown as AppendIntent;
  } finally {
    closeSync(fd);
  }
}

function writeIntent(path: string, value: AppendIntent): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  fsyncDirectory(dirname(path));
}

function removeFile(path: string): void {
  if (!existsSync(path)) return;
  rmSync(path);
  fsyncDirectory(dirname(path));
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function encodeCursor(partition: string, epoch: string, seq: number): string {
  return Buffer.from(JSON.stringify({ v: 1, p: partition, e: epoch, s: seq })).toString(
    "base64url",
  );
}

function cursorError(detail: string): JournalCursorError {
  return new JournalCursorError(`journal cursor is ${detail}; resnapshot is required`);
}

function encodeJson(value: unknown): Buffer {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("journal value is not JSON serializable");
  return Buffer.from(encoded);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
