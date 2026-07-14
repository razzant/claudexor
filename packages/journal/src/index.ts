import { createHash, randomUUID } from "node:crypto";
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
const MAGIC = Buffer.from([0x43, 0x4c, 0x58, 0x4a, 0x4e, 0x4c, 0x32, 0x00]);
const VERSION = 1;
const PREFIX_CORE_BYTES = MAGIC.length + 2 + 4 + 4;
const PREFIX_CHECKSUM_BYTES = 8;
const PREFIX_BYTES = PREFIX_CORE_BYTES + PREFIX_CHECKSUM_BYTES;
const HASH_BYTES = 32;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const ZERO_HASH = "0".repeat(64);
export interface JournalRecord<T = unknown> {
  partition: string;
  epoch: string;
  seq: number;
  previousFrameHash: string;
  frameHash: string;
  time: string;
  type: string;
  payload: T;
  byteOffset: number;
}
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
}

export function journalPartitionDirectory(rootDir: string, partition: string): string {
  if (!partition.trim()) throw new Error("journal partition must not be empty");
  const slug = partition.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 48) || "partition";
  return join(rootDir, `${slug}-${sha256(Buffer.from(partition)).slice(0, 12)}`);
}

interface FrameHeader {
  partition: string;
  epoch: string;
  seq: number;
  previousFrameHash: string;
  time: string;
  type: string;
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
  private readonly fd: number;
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
        const prefix = replay(bytes.subarray(0, intent.offset), this.options.partition);
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
    const decoded = replay(bytes, this.options.partition);
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

interface ReplayResult {
  records: JournalRecord[];
  incompleteOffset: number | null;
  error: { offset: number; reason: string } | null;
}

function replay(bytes: Buffer, partition: string): ReplayResult {
  const records: JournalRecord[] = [];
  let offset = 0;
  let epoch: string | null = null;
  let expectedSeq = 1;
  let previous = ZERO_HASH;
  while (offset < bytes.length) {
    const remaining = bytes.length - offset;
    if (remaining < PREFIX_BYTES) return { records, incompleteOffset: offset, error: null };
    if (!bytes.subarray(offset, offset + MAGIC.length).equals(MAGIC)) {
      return corrupt(records, offset, "frame magic mismatch");
    }
    const prefix = bytes.subarray(offset, offset + PREFIX_BYTES);
    const expectedPrefix = createHash("sha256")
      .update(prefix.subarray(0, PREFIX_CORE_BYTES))
      .digest()
      .subarray(0, PREFIX_CHECKSUM_BYTES);
    if (!prefix.subarray(PREFIX_CORE_BYTES).equals(expectedPrefix)) {
      return corrupt(records, offset, "frame prefix checksum mismatch");
    }
    const version = bytes.readUInt16BE(offset + MAGIC.length);
    const headerLength = bytes.readUInt32BE(offset + MAGIC.length + 2);
    const payloadLength = bytes.readUInt32BE(offset + MAGIC.length + 6);
    if (version !== VERSION)
      return corrupt(records, offset, `unsupported frame version ${version}`);
    if (
      headerLength === 0 ||
      headerLength > MAX_HEADER_BYTES ||
      payloadLength > MAX_PAYLOAD_BYTES
    ) {
      return corrupt(records, offset, "invalid frame lengths");
    }
    const frameLength = PREFIX_BYTES + headerLength + payloadLength + HASH_BYTES;
    if (frameLength > remaining) return { records, incompleteOffset: offset, error: null };
    const headerStart = offset + PREFIX_BYTES;
    const payloadStart = headerStart + headerLength;
    const bodyEnd = payloadStart + payloadLength;
    const body = bytes.subarray(offset, bodyEnd);
    const frameHashBytes = createHash("sha256").update(body).digest();
    if (!bytes.subarray(bodyEnd, bodyEnd + HASH_BYTES).equals(frameHashBytes)) {
      return corrupt(records, offset, "frame checksum mismatch");
    }
    let header: FrameHeader;
    let payload: unknown;
    try {
      header = JSON.parse(
        bytes.subarray(headerStart, payloadStart).toString("utf8"),
      ) as FrameHeader;
      payload = JSON.parse(bytes.subarray(payloadStart, bodyEnd).toString("utf8"));
    } catch {
      return corrupt(records, offset, "frame JSON is malformed");
    }
    const semantic = validateHeader(header, partition, epoch, expectedSeq, previous);
    if (semantic) return corrupt(records, offset, semantic);
    const frameHash = frameHashBytes.toString("hex");
    records.push({
      partition,
      epoch: header.epoch,
      seq: header.seq,
      previousFrameHash: header.previousFrameHash,
      frameHash,
      time: header.time,
      type: header.type,
      payload,
      byteOffset: offset,
    });
    epoch ??= header.epoch;
    expectedSeq += 1;
    previous = frameHash;
    offset += frameLength;
  }
  return { records, incompleteOffset: null, error: null };
}

function corrupt(records: JournalRecord[], offset: number, reason: string): ReplayResult {
  return { records, incompleteOffset: null, error: { offset, reason } };
}

function validateHeader(
  header: FrameHeader,
  partition: string,
  epoch: string | null,
  seq: number,
  previous: string,
): string | null {
  if (!header || typeof header !== "object") return "frame header is not an object";
  if (header.partition !== partition) return "frame partition mismatch";
  if (typeof header.epoch !== "string" || !header.epoch) return "frame epoch is invalid";
  if (epoch !== null && header.epoch !== epoch) return "frame epoch changed";
  if (header.seq !== seq) return "frame sequence mismatch";
  if (header.previousFrameHash !== previous) return "frame hash-chain mismatch";
  if (typeof header.time !== "string" || !header.time) return "frame timestamp is invalid";
  if (typeof header.type !== "string" || !header.type) return "frame type is invalid";
  return null;
}

function encodeFrame(header: FrameHeader, payload: Buffer): Buffer {
  const headerBytes = encodeJson(header);
  if (headerBytes.length > MAX_HEADER_BYTES) throw new Error("journal header is too large");
  const prefix = Buffer.alloc(PREFIX_BYTES);
  MAGIC.copy(prefix);
  prefix.writeUInt16BE(VERSION, MAGIC.length);
  prefix.writeUInt32BE(headerBytes.length, MAGIC.length + 2);
  prefix.writeUInt32BE(payload.length, MAGIC.length + 6);
  createHash("sha256")
    .update(prefix.subarray(0, PREFIX_CORE_BYTES))
    .digest()
    .subarray(0, PREFIX_CHECKSUM_BYTES)
    .copy(prefix, PREFIX_CORE_BYTES);
  const body = Buffer.concat([prefix, headerBytes, payload]);
  return Buffer.concat([body, createHash("sha256").update(body).digest()]);
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
