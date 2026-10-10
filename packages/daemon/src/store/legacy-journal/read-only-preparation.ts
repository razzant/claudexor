import { createHash } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { ZERO_HASH, type JournalRecord } from "./frame-codec.js";
import { readFrames, type FrameReadResult } from "./frame-reader.js";
import type { JournalFold } from "./journal-fold.js";

export interface JournalPreparationReceipt {
  fingerprint: string;
  preparationIdentity: string;
  virtual: boolean;
  deferredRepair: null | {
    kind: "discard_unacknowledged_append";
    discardedBytes: number;
  };
}

export type PreparedJournalRecovery =
  | { status: "ready"; discardedTailBytes: number }
  | {
      status: "recovery_required";
      location: { kind: "byte"; byteOffset: number };
      reason: string;
      discardedTailBytes: number;
    };

/** Chain state (`epoch`/`nextSeq`/`previousFrameHash`) is the disk state after
 * the last frame; `records` is the retained set after the optional fold, and
 * `retiredCount`/`retiredBytes` say what that fold dropped while replaying. */
export interface PreparedJournalInspection {
  receipt: JournalPreparationReceipt;
  recovery: PreparedJournalRecovery;
  records: JournalRecord[];
  epoch: string;
  nextSeq: number;
  previousFrameHash: string;
  knownFileBytes: number;
  retiredCount: number;
  retiredBytes: number;
}

interface AppendIntent {
  v: 1;
  offset: number;
  length: number;
}

/** Bytes are retained only for files small enough to be an append intent; the
 * journal itself is hashed in chunks and later decoded positionally. */
const RETAINED_FILE_BYTES = 1024;
const HASH_CHUNK_BYTES = 1024 * 1024;

interface FileObservation {
  size: number;
  observation: string;
  bytes?: Buffer;
}

interface TreeSnapshot {
  fingerprint: string;
  preparationIdentity: string;
  rootExists: boolean;
  partitionExists: boolean;
  entries: Set<string>;
  files: Map<string, FileObservation>;
  problems: string[];
}

export function inspectPreparedJournal(input: {
  rootDir: string;
  partitionDir: string;
  journalPath: string;
  intentPath: string;
  partition: string;
  initialEpoch: string;
  fold?: JournalFold;
}): PreparedJournalInspection {
  const tree = snapshotTree(input.rootDir, input.partitionDir);
  const journal = tree.files.get(input.journalPath);
  const intent = tree.files.get(input.intentPath);
  const unexpected = [...tree.entries].filter(
    (path) => path !== input.journalPath && path !== input.intentPath,
  );
  let problem = tree.problems[0] ?? null;
  let byteOffset = 0;
  let deferredRepair: JournalPreparationReceipt["deferredRepair"] = null;

  if (!problem && journal === undefined && (intent !== undefined || tree.partitionExists)) {
    if (intent !== undefined || unexpected.length > 0) {
      problem = "journal file is missing while partition state exists";
    }
  }

  const size = journal?.size ?? 0;
  let prefix: AppendIntent | null = null;
  if (!problem && intent !== undefined) {
    try {
      prefix = parseIntent(intent);
      if (prefix.offset > size || size > prefix.offset + prefix.length) {
        problem = "append intent does not match the journal prefix";
        byteOffset = prefix.offset;
      }
    } catch (error) {
      problem = `append intent is malformed: ${safeMessage(error)}`;
    }
  }

  let decoded: FrameReadResult | null = null;
  if (!problem && journal !== undefined) {
    try {
      decoded = readObservedJournal(input.journalPath, journal, input.partition, {
        limit: prefix?.offset,
        fold: input.fold,
      });
    } catch (error) {
      problem = `journal cannot be read safely: ${safeMessage(error)}`;
    }
  }
  if (!problem && prefix && decoded) {
    if (decoded.error || decoded.incompleteOffset !== null) {
      problem = "append intent does not match the journal prefix";
      byteOffset = prefix.offset;
    } else {
      deferredRepair = {
        kind: "discard_unacknowledged_append",
        discardedBytes: size - prefix.offset,
      };
    }
  }
  if (!problem && decoded?.incompleteOffset != null) {
    problem = "unexplained suffix without append intent";
    byteOffset = decoded.incompleteOffset;
  }
  if (!problem && decoded?.error) {
    problem = decoded.error.reason;
    byteOffset = decoded.error.offset;
  }

  const ready = !problem && decoded ? decoded : null;
  const virtual = !tree.rootExists || !tree.partitionExists || journal === undefined;
  return {
    receipt: {
      fingerprint: tree.fingerprint,
      preparationIdentity: tree.preparationIdentity,
      virtual,
      deferredRepair,
    },
    recovery: problem
      ? {
          status: "recovery_required",
          location: { kind: "byte", byteOffset },
          reason: problem,
          discardedTailBytes: 0,
        }
      : { status: "ready", discardedTailBytes: 0 },
    records: ready?.retained ?? [],
    epoch: ready?.epoch ?? input.initialEpoch,
    nextSeq: ready?.nextSeq ?? 1,
    previousFrameHash: ready?.previousFrameHash ?? ZERO_HASH,
    knownFileBytes: deferredRepair ? (prefix as AppendIntent).offset : size,
    retiredCount: ready?.retiredCount ?? 0,
    retiredBytes: ready?.retiredBytes ?? 0,
  };
}

/** Decode the journal that the tree walk already observed: the descriptor must
 * still be the same file before and after the positional read. */
function readObservedJournal(
  path: string,
  observed: FileObservation,
  partition: string,
  options: { limit: number | undefined; fold: JournalFold | undefined },
): FrameReadResult {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (observationMetadata(fstatSync(fd, { bigint: true })) !== observed.observation) {
      throw new Error("journal changed since it was inspected");
    }
    const decoded = readFrames(fd, partition, options);
    if (observationMetadata(fstatSync(fd, { bigint: true })) !== observed.observation) {
      throw new Error("journal changed while being decoded");
    }
    return decoded;
  } finally {
    closeSync(fd);
  }
}

export function fingerprintPreparedJournal(
  rootDir: string,
  partitionDir: string,
): Pick<JournalPreparationReceipt, "fingerprint" | "preparationIdentity"> {
  const observed = snapshotTree(rootDir, partitionDir);
  return {
    fingerprint: observed.fingerprint,
    preparationIdentity: observed.preparationIdentity,
  };
}

function snapshotTree(rootDir: string, partitionDir: string): TreeSnapshot {
  const contentHash = createHash("sha256");
  const identityHash = createHash("sha256");
  const files = new Map<string, FileObservation>();
  const entries = new Set<string>();
  const problems: string[] = [];
  if (!inspectTrustedParent(dirname(resolve(rootDir)), identityHash, problems)) {
    contentHash.update("root\0unreachable\0");
    return finishSnapshot({
      contentHash,
      identityHash,
      rootExists: false,
      partitionExists: false,
      entries,
      files,
      problems,
    });
  }
  const root = inspectEntry(rootDir, "root", contentHash, identityHash, files, problems, false);
  if (root.kind !== "directory") {
    contentHash.update("partition\0unreachable\0");
    identityHash.update("partition\0unreachable\0");
    return finishSnapshot({
      contentHash,
      identityHash,
      rootExists: root.kind !== "missing",
      partitionExists: false,
      entries,
      files,
      problems,
    });
  }
  const partition = inspectEntry(
    partitionDir,
    "partition",
    contentHash,
    identityHash,
    files,
    problems,
    false,
  );
  if (partition.kind === "directory") {
    walkPartition(
      partitionDir,
      partitionDir,
      partition.stat,
      contentHash,
      identityHash,
      files,
      entries,
      problems,
    );
  }
  assertDirectoryUnchanged(rootDir, root.stat, problems, "root");
  return finishSnapshot({
    contentHash,
    identityHash,
    rootExists: true,
    partitionExists: partition.kind !== "missing",
    entries,
    files,
    problems,
  });
}

function walkPartition(
  path: string,
  partitionDir: string,
  before: BigIntStats,
  contentHash: ReturnType<typeof createHash>,
  identityHash: ReturnType<typeof createHash>,
  files: Map<string, FileObservation>,
  entries: Set<string>,
  problems: string[],
): void {
  let names: string[];
  try {
    names = readdirSync(path).sort();
  } catch (error) {
    problems.push(`journal partition cannot be listed: ${safeMessage(error)}`);
    contentHash.update(`list-error\0${safeMessage(error)}\0`);
    identityHash.update(`list-error\0${safeMessage(error)}\0`);
    return;
  }
  for (const name of names) {
    const child = join(path, name);
    // `join` so the map keys match what callers look up (a `/`-built key never
    // matched on Windows). The hashed LABEL is separator-normalized with
    // `sep`, not a blanket backslash strip: on POSIX a backslash is an
    // ordinary filename character and must stay distinct.
    const relative = child
      .slice(partitionDir.length + 1)
      .split(sep)
      .join("/");
    entries.add(child);
    const inspected = inspectEntry(
      child,
      relative,
      contentHash,
      identityHash,
      files,
      problems,
      true,
    );
    if (inspected.kind === "directory") {
      walkPartition(
        child,
        partitionDir,
        inspected.stat,
        contentHash,
        identityHash,
        files,
        entries,
        problems,
      );
    }
  }
  try {
    if (readdirSync(path).sort().join("\0") !== names.join("\0")) {
      problems.push(`journal directory entries changed while being read: ${path}`);
    }
  } catch (error) {
    problems.push(`journal partition cannot be relisted: ${safeMessage(error)}`);
  }
  assertDirectoryUnchanged(path, before, problems, path);
}

function inspectEntry(
  path: string,
  label: string,
  contentHash: ReturnType<typeof createHash>,
  identityHash: ReturnType<typeof createHash>,
  files: Map<string, FileObservation>,
  problems: string[],
  allowFile: boolean,
): { kind: "missing" | "other" } | { kind: "directory" | "file"; stat: BigIntStats } {
  let stat: BigIntStats;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      contentHash.update(`${label}\0missing\0`);
      identityHash.update(`${label}\0missing\0`);
      assertStillMissing(path, problems, label);
      return { kind: "missing" };
    }
    problems.push(`${label} cannot be inspected: ${safeMessage(error)}`);
    contentHash.update(`${label}\0error\0${safeMessage(error)}\0`);
    identityHash.update(`${label}\0error\0${safeMessage(error)}\0`);
    return { kind: "other" };
  }
  contentHash.update(`${label}\0${semanticMetadata(stat)}\0`);
  identityHash.update(`${label}\0${identityMetadata(stat)}\0`);
  if (stat.isSymbolicLink()) {
    try {
      const target = readlinkSync(path);
      contentHash.update(`symlink\0${target}\0`);
      identityHash.update(`symlink\0${target}\0`);
    } catch (error) {
      problems.push(`${label} symbolic-link target cannot be read: ${safeMessage(error)}`);
    }
    problems.push(`${label} is a symbolic link`);
    return { kind: "other" };
  }
  if (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid())) {
    problems.push(`${label} is not owned by the current user`);
  }
  if (stat.isDirectory()) {
    let safe = true;
    try {
      if (realpathSync.native(path) !== resolve(path)) {
        problems.push(`${label} is not canonical`);
        safe = false;
      }
    } catch (error) {
      problems.push(`${label} cannot be resolved canonically: ${safeMessage(error)}`);
      safe = false;
    }
    if (process.platform !== "win32" && Number(stat.mode & 0o777n) !== 0o700) {
      problems.push(`${label} is not private`);
      safe = false;
    }
    if (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid())) safe = false;
    return safe ? { kind: "directory", stat } : { kind: "other" };
  }
  if (!allowFile || !stat.isFile() || stat.nlink !== 1n) {
    problems.push(`${label} is not a private regular file`);
    return { kind: "other" };
  }
  if (process.platform !== "win32" && Number(stat.mode & 0o777n) !== 0o600) {
    problems.push(`${label} is not private`);
  }
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (
        opened.dev !== stat.dev ||
        opened.ino !== stat.ino ||
        !opened.isFile() ||
        observationMetadata(opened) !== observationMetadata(stat)
      ) {
        throw new Error("pathname identity changed while being read");
      }
      const retain = opened.size <= BigInt(RETAINED_FILE_BYTES);
      const bytes = hashDescriptor(fd, contentHash, retain);
      const after = fstatSync(fd, { bigint: true });
      if (
        BigInt(bytes.length) !== opened.size ||
        observationMetadata(opened) !== observationMetadata(after)
      ) {
        throw new Error("file changed while being read");
      }
      const namedAfter = lstatSync(path, { bigint: true });
      if (observationMetadata(stat) !== observationMetadata(namedAfter)) {
        throw new Error("pathname identity changed after being read");
      }
      files.set(path, {
        size: Number(opened.size),
        observation: observationMetadata(opened),
        ...(retain ? { bytes: bytes.retained } : {}),
      });
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    problems.push(`${label} cannot be read safely: ${safeMessage(error)}`);
    contentHash.update(`read-error\0${safeMessage(error)}\0`);
    identityHash.update(`read-error\0${safeMessage(error)}\0`);
  }
  return { kind: "file", stat };
}

/** Stream the descriptor through the content hash in bounded chunks. The
 * fingerprint is the digest of the same byte sequence a whole-file read would
 * hash, without retaining the file. */
function hashDescriptor(
  fd: number,
  contentHash: ReturnType<typeof createHash>,
  retain: boolean,
): { length: number; retained: Buffer } {
  const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  const kept: Buffer[] = [];
  let length = 0;
  for (;;) {
    const read = readSync(fd, chunk, 0, chunk.length, length);
    if (read === 0) break;
    contentHash.update(chunk.subarray(0, read));
    if (retain) kept.push(Buffer.from(chunk.subarray(0, read)));
    length += read;
  }
  return { length, retained: retain ? Buffer.concat(kept) : Buffer.alloc(0) };
}

function finishSnapshot(input: {
  contentHash: ReturnType<typeof createHash>;
  identityHash: ReturnType<typeof createHash>;
  rootExists: boolean;
  partitionExists: boolean;
  entries: Set<string>;
  files: Map<string, FileObservation>;
  problems: string[];
}): TreeSnapshot {
  const fingerprint = input.contentHash.digest("hex");
  input.identityHash.update(`content\0${fingerprint}\0`);
  return {
    fingerprint,
    preparationIdentity: input.identityHash.digest("hex"),
    rootExists: input.rootExists,
    partitionExists: input.partitionExists,
    entries: input.entries,
    files: input.files,
    problems: input.problems,
  };
}

function inspectTrustedParent(
  path: string,
  identityHash: ReturnType<typeof createHash>,
  problems: string[],
): boolean {
  try {
    const before = lstatSync(path, { bigint: true });
    identityHash.update(`trusted-parent\0${identityMetadata(before)}\0`);
    if (
      before.isSymbolicLink() ||
      !before.isDirectory() ||
      realpathSync.native(path) !== path ||
      (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid())) ||
      (process.platform !== "win32" && Number(before.mode & 0o777n) !== 0o700)
    ) {
      problems.push("journal root parent is not canonical and private");
      return false;
    }
    const after = lstatSync(path, { bigint: true });
    if (observationMetadata(before) !== observationMetadata(after)) {
      problems.push("journal root parent changed while being inspected");
      return false;
    }
    return true;
  } catch (error) {
    problems.push(`journal root parent cannot be inspected: ${safeMessage(error)}`);
    identityHash.update(`trusted-parent-error\0${safeMessage(error)}\0`);
    return false;
  }
}

function assertDirectoryUnchanged(
  path: string,
  before: BigIntStats,
  problems: string[],
  label: string,
): void {
  try {
    const after = lstatSync(path, { bigint: true });
    if (observationMetadata(before) !== observationMetadata(after)) {
      problems.push(`${label} changed while being inspected`);
    }
  } catch (error) {
    problems.push(`${label} became unavailable while being inspected: ${safeMessage(error)}`);
  }
}

function assertStillMissing(path: string, problems: string[], label: string): void {
  try {
    lstatSync(path);
    problems.push(`${label} appeared while being inspected`);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      problems.push(`${label} missing state is ambiguous: ${safeMessage(error)}`);
    }
  }
}

function semanticMetadata(stat: BigIntStats): string {
  const base = [entryType(stat), stat.mode & 0o777n, stat.uid, stat.gid];
  if (!stat.isDirectory()) base.push(stat.nlink, stat.size);
  return base.join(":");
}

function identityMetadata(stat: BigIntStats): string {
  const base = [stat.dev, stat.ino, entryType(stat), stat.mode & 0o777n, stat.uid, stat.gid];
  if (!stat.isDirectory()) base.push(stat.nlink);
  return base.join(":");
}

function observationMetadata(stat: BigIntStats): string {
  return [identityMetadata(stat), stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

function entryType(stat: BigIntStats): string {
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  if (stat.isSymbolicLink()) return "symlink";
  return "other";
}

function parseIntent(intent: FileObservation): AppendIntent {
  if (!intent.bytes || intent.size > RETAINED_FILE_BYTES) throw new Error("unsafe file");
  const value = JSON.parse(intent.bytes.toString("utf8")) as unknown;
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    !Number.isSafeInteger(value.offset) ||
    Number(value.offset) < 0 ||
    !Number.isSafeInteger(value.length) ||
    Number(value.length) <= 0
  ) {
    throw new Error("invalid shape");
  }
  return value as unknown as AppendIntent;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
