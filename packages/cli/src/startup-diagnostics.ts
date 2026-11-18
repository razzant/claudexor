/** Private, bounded diagnostics for the daemon that already owns the data root. */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { logPath as canonicalLogPath } from "@claudexor/daemon";
import { redactSecrets, safeProblemMessage } from "@claudexor/util";
import { quotaObservationJson, type QuotaRefreshDiagnostic } from "./quota-refresh-diagnostics.js";

const DEFAULT_CURRENT_BYTES = 256 * 1024;
const DEFAULT_RECORD_BYTES = 16 * 1024;
const MAX_TAIL_BYTES = DEFAULT_CURRENT_BYTES;
const MAX_TAIL_LINES = 200;
const MIN_RECORD_BYTES = 256;
const EXIT_LINE_BYTES = 160; // one timestamp and either shutdown timer's reason
const EXIT_SLOT_LINE = /^ *\[exit-slot [0-9a-f-]{36}\]$/;
const SAFE_LABEL = /^[a-z0-9][a-z0-9._-]{0,127}$/;
/** Open in-process owners by target identity; `claimedTargets` also keeps targets this
 * process refused or already closed, so no unbounded append can bypass the bound. */
const activeWriters = new Map<string, DaemonStartupDiagnostics>();
const claimedTargets = new Set<string>();

export interface DaemonStartupDiagnosticContext {
  runtimeVersion: string;
  buildSha: string;
  entryPath: string;
  pid: number;
  dataRoot: string;
  launchSource: string;
}

export interface DaemonStartupDiagnosticRecord {
  stage: string;
  message: string;
  error?: unknown;
  at?: Date;
}

export interface DaemonStartupDiagnostics {
  readonly path: string;
  readonly rotatedPath: string;
  record(record: DaemonStartupDiagnosticRecord): boolean;
  /** One plain `[timestamp] message` line (the historical operator format), redacted
   * and bounded like a record, through the same rotation. */
  appendLine(message: string): boolean;
  appendQuotaObservation(record: QuotaRefreshDiagnostic): boolean;
  /** Close all descriptors, optionally reserving space for one late timer receipt. */
  close(reserveExit?: boolean): ((reason: string) => void) | undefined;
  lastFailure(): string | null;
}

export interface DaemonStartupDiagnosticOptions {
  path?: string;
  maxCurrentBytes?: number;
  maxRecordBytes?: number;
  platform?: NodeJS.Platform;
  uid?: number;
  now?: () => Date;
}

interface SafeFileOptions {
  platform: NodeJS.Platform;
  uid: number | undefined;
  repairMode: boolean;
  create: boolean;
  exclusiveCreate?: { fd?: number };
  access?: number;
}

function boundedPositiveInt(value: number, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function diagnosticError(message: string, error?: unknown): Error {
  const detail = error === undefined ? "" : `: ${safeProblemMessage(error)}`;
  return new Error(
    `daemon diagnostic target is not safe and owner-controlled (${message})${detail}`,
  );
}

function validatePrivateParent(path: string, platform: NodeJS.Platform, uid?: number): void {
  const parent = dirname(path);
  try {
    const stat = lstatSync(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw diagnosticError("parent is not a regular directory");
    }
    if (platform !== "win32" && uid !== undefined) {
      if (stat.uid !== uid) throw diagnosticError("parent has a foreign uid");
      if ((stat.mode & 0o077) !== 0) throw diagnosticError("parent permissions are not private");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("daemon diagnostic target")) throw error;
    throw diagnosticError("parent cannot be proven", error);
  }
}

function validateOpenedPath(path: string, fd: number, options: SafeFileOptions) {
  const opened = fstatSync(fd);
  const named = lstatSync(path);
  if (
    named.isSymbolicLink() ||
    !opened.isFile() ||
    !named.isFile() ||
    opened.nlink !== 1 ||
    named.nlink !== 1 ||
    opened.dev !== named.dev ||
    opened.ino !== named.ino
  ) {
    throw diagnosticError("target is not a singly-linked regular file");
  }
  if (
    options.platform !== "win32" &&
    options.uid !== undefined &&
    (opened.uid !== options.uid || named.uid !== options.uid)
  ) {
    throw diagnosticError("target has a foreign uid");
  }
  if (options.platform !== "win32" && options.repairMode && (opened.mode & 0o777) !== 0o600) {
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
  }
  return opened;
}

function openSafeFile(path: string, options: SafeFileOptions): number {
  validatePrivateParent(path, options.platform, options.uid);
  const access = options.access ?? (constants.O_RDWR | constants.O_APPEND);
  const create = options.create ? constants.O_CREAT : 0;
  const creation = options.exclusiveCreate;
  const flags = access | create | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0);
  let fd: number | undefined;
  try {
    // Recheck the created inode by name. Only a vacant name permits a fresh creation.
    if (creation?.fd !== undefined && !lstatSync(path, { throwIfNoEntry: false })) {
      closeQuietly(creation.fd);
      delete creation.fd;
    }
    fd = creation?.fd ?? openSync(path, creation ? flags | constants.O_EXCL : flags, 0o600);
    if (creation) creation.fd = fd;
    validateOpenedPath(path, fd, options);
    return fd;
  } catch (error) {
    if (!creation && fd !== undefined) closeSync(fd);
    throw diagnosticError("file proof failed", error);
  }
}

function closeQuietly(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    /* diagnostics never own lifecycle success */
  }
}

function openExistingSafe(path: string, options: SafeFileOptions): number | undefined {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return openSafeFile(path, { ...options, create: false });
}

function writerIdentity(path: string): string {
  try {
    return join(realpathSync.native(dirname(path)), basename(path));
  } catch {
    return path;
  }
}

function writeAll(fd: number, bytes: Buffer, position?: number): void {
  let offset = 0;
  while (offset < bytes.length) {
    const at = position === undefined ? null : position + offset;
    const written = writeSync(fd, bytes, offset, bytes.length - offset, at);
    if (written === 0) throw new Error("diagnostic write made no progress");
    offset += written;
  }
}

function readAt(fd: number, position: number, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = readSync(fd, bytes, offset, length - offset, position + offset);
    if (read === 0) break;
    offset += read;
  }
  return bytes.subarray(0, offset);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const marker = "[redacted]";
  const markerAt = value.indexOf(marker);
  const markerSuffix = `…${marker}`;
  const preserveMarker = markerAt >= 0 && Buffer.byteLength(markerSuffix) <= maxBytes;
  const source = preserveMarker ? value.slice(0, markerAt) : value;
  const suffix = preserveMarker ? markerSuffix : maxBytes >= 3 ? "…" : "";
  const suffixBytes = Buffer.byteLength(suffix);
  let low = 0;
  let high = source.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(source.slice(0, mid)) + suffixBytes <= maxBytes) low = mid;
    else high = mid - 1;
  }
  let prefix = source.slice(0, low);
  if (/\p{Surrogate}$/u.test(prefix)) prefix = prefix.slice(0, -1);
  return `${prefix}${suffix}`;
}

function redactedString(value: unknown, maxBytes: number): string {
  return truncateUtf8(redactSecrets(String(value)), maxBytes);
}

function diagnosticLine(
  context: DaemonStartupDiagnosticContext,
  input: DaemonStartupDiagnosticRecord,
  now: () => Date,
  maxRecordBytes: number,
): Buffer {
  const error = input.error;
  const failureClass =
    error instanceof Error
      ? error.name || error.constructor?.name || "Error"
      : error === undefined
        ? undefined
        : "NonErrorThrown";
  const stack =
    error instanceof Error
      ? error.stack || `${failureClass}: ${error.message}`
      : error === undefined
        ? undefined
        : String(error);
  const perField = maxRecordBytes;
  const record: Record<string, string | number> = {
    timestamp: redactedString((input.at ?? now()).toISOString(), perField),
    runtimeVersion: redactedString(context.runtimeVersion, perField),
    buildSha: redactedString(context.buildSha, perField),
    entryPath: redactedString(context.entryPath, perField),
    pid: context.pid,
    dataRoot: redactedString(context.dataRoot, perField),
    launchSource: redactedString(context.launchSource, perField),
    stage: redactedString(input.stage, perField),
    message: redactedString(input.message, perField),
  };
  if (failureClass !== undefined) record.failureClass = redactedString(failureClass, 128);
  if (stack !== undefined) record.stack = redactedString(stack, perField);

  let encoded = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  const shrinkOrder = ["message", "entryPath", "dataRoot", "stack", "runtimeVersion", "buildSha"];
  const minimumBytes: Record<string, number> = {
    message: 8,
    entryPath: 16,
    dataRoot: 16,
    stack: 160,
    runtimeVersion: 8,
    buildSha: 8,
  };
  while (encoded.length > maxRecordBytes) {
    const key = shrinkOrder.find((candidate) => {
      const value = record[candidate];
      return typeof value === "string" && Buffer.byteLength(value) > (minimumBytes[candidate] ?? 8);
    });
    if (!key) throw new Error("diagnostic record metadata exceeds the configured bound");
    const value = record[key] as string;
    const currentBytes = Buffer.byteLength(value);
    const nextBytes = Math.max(
      minimumBytes[key] ?? 8,
      currentBytes - Math.max(16, encoded.length - maxRecordBytes),
    );
    record[key] = truncateUtf8(value, nextBytes);
    encoded = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  }
  return encoded;
}

function plainLine(message: string, now: () => Date, maxRecordBytes: number): Buffer {
  const prefix = `[${now().toISOString()}] `;
  const room = maxRecordBytes - Buffer.byteLength(prefix) - 1;
  return Buffer.from(`${prefix}${redactedString(message || "unknown error", room)}\n`, "utf8");
}

/** Coerce an environment-supplied launch source into a SAFE_LABEL value —
 * "unknown" when absent or unsafe. Diagnostics never fail daemon startup, so
 * a malformed environment must degrade to a safe label, not a throw. */
export function safeDaemonLaunchSource(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return SAFE_LABEL.test(trimmed) ? trimmed : "unknown";
}

/** Open the canonical writer only after a separate root-authority owner won. */
export function openDaemonStartupDiagnosticsAfterAuthority(
  context: DaemonStartupDiagnosticContext,
  options: DaemonStartupDiagnosticOptions = {},
): DaemonStartupDiagnostics {
  if (!Number.isSafeInteger(context.pid) || context.pid <= 0) throw new Error("invalid daemon pid");
  if (!SAFE_LABEL.test(context.launchSource)) throw new Error("invalid daemon launch source");
  const path = resolve(options.path ?? canonicalLogPath());
  const rotatedPath = `${path}.1`;
  const maxCurrentBytes = boundedPositiveInt(
    options.maxCurrentBytes ?? DEFAULT_CURRENT_BYTES,
    "maxCurrentBytes",
    MIN_RECORD_BYTES,
  );
  const maxRecordBytes = boundedPositiveInt(
    options.maxRecordBytes ?? DEFAULT_RECORD_BYTES,
    "maxRecordBytes",
    MIN_RECORD_BYTES,
  );
  if (maxRecordBytes > maxCurrentBytes) {
    throw new Error("maxRecordBytes must not exceed maxCurrentBytes");
  }
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? process.getuid?.();
  const existingFile = { platform, uid, repairMode: true, create: false };
  const now = options.now ?? (() => new Date());
  const writerKey = writerIdentity(path);
  if (activeWriters.has(writerKey))
    throw new Error(`one diagnostic writer is already active for ${path}`);
  claimedTargets.add(writerKey);

  let fd: number | undefined;
  let closed = false;
  let failure: string | null = null;
  let openWith: SafeFileOptions = { ...existingFile, create: true };
  let partial: { start: number; bytes: Buffer; cause: string } | undefined;
  function boundLegacyGeneration(file: number): void {
    if (fstatSync(file).size <= maxCurrentBytes) return;
    const receipt = diagnosticLine(
      context,
      {
        stage: "diagnostic_legacy_log_discarded",
        message:
          "an oversized legacy diagnostic generation was discarded without copying its bytes",
      },
      now,
      maxRecordBytes,
    );
    ftruncateSync(file, 0);
    writeAll(file, receipt);
    fsyncSync(file);
  }
  // A new event resumes at the last completed rename and proves both generations.
  const currentFile = (): number => {
    if (fd !== undefined) return fd;
    const current = openSafeFile(path, openWith);
    let rotated: number | undefined;
    try {
      rotated = openExistingSafe(rotatedPath, existingFile);
      if (rotated !== undefined) boundLegacyGeneration(rotated);
      boundLegacyGeneration(current);
      fd = current;
    } finally {
      closeQuietly(rotated);
      if (fd === undefined && !openWith.exclusiveCreate) closeQuietly(current);
    }
    return current;
  };
  currentFile();

  const rotate = (current: number): number => {
    validateOpenedPath(path, current, existingFile);
    closeQuietly(openExistingSafe(rotatedPath, existingFile));
    fd = undefined;
    openWith = existingFile;
    closeSync(current);
    renameSync(path, rotatedPath);
    openWith = { ...existingFile, create: true, exclusiveCreate: {} };
    fd = openSafeFile(path, openWith);
    return fd;
  };

  function discardPartial(file: number): void {
    if (!partial) return;
    validatePrivateParent(path, platform, uid);
    const { start, bytes } = partial;
    const length = validateOpenedPath(path, file, existingFile).size - start;
    if (length < 0 || length > bytes.length) throw diagnosticError("append size changed");
    if (!readAt(file, start, length).equals(bytes.subarray(0, length))) {
      throw diagnosticError("file changed after an incomplete append");
    }
    if (length > 0) ftruncateSync(file, start);
    partial = undefined;
  }

  /** Every byte this process appends to `path` passes here, so a generation never
   * exceeds `maxCurrentBytes`: one line is at most `maxRecordBytes`. */
  const writeBounded = (line: () => Buffer): boolean => {
    if (closed) {
      failure = "diagnostic writer is closed";
      return false;
    }
    try {
      const bytes = line();
      if (bytes.length > maxRecordBytes) throw new Error("diagnostic line exceeds its byte limit");
      let current = currentFile();
      discardPartial(current);
      let start = fstatSync(current).size;
      if (start + bytes.length > maxCurrentBytes) {
        current = rotate(current);
        start = 0;
      }
      try {
        writeAll(current, bytes);
      } catch (error) {
        partial = { start, bytes, cause: safeProblemMessage(error) };
        discardPartial(current);
        throw error;
      }
      return true;
    } catch (error) {
      failure = safeProblemMessage(partial ? `${partial.cause}. ${String(error)}` : error);
      return false;
    }
  };

  function reserveForcedExitLine() {
    // Positional writes need a descriptor without O_APPEND on Linux.
    const slotFile = { ...existingFile, repairMode: false, access: constants.O_RDWR };
    validatePrivateParent(path, platform, uid);
    validateOpenedPath(path, currentFile(), slotFile);
    // A new file can reuse an evicted inode. The unique suffix identifies our
    // bytes and stays on its own hidden line even after the timer fills the prefix.
    const slot = Buffer.from(`${" ".repeat(EXIT_LINE_BYTES)}[exit-slot ${randomUUID()}]\n`);
    if (!writeBounded(() => slot) || fd === undefined) return;
    const { dev, ino, size } = fstatSync(fd, { bigint: true });
    const position = Number(size) - slot.length;
    const matches = (stat: BigIntStats | undefined) =>
      stat?.dev === dev &&
      stat.ino === ino &&
      stat.isFile() &&
      stat.nlink === 1n &&
      (platform === "win32" || (stat.mode & 0o077n) === 0n);
    function openReservedSlot(): number | undefined {
      for (const generation of [path, rotatedPath]) {
        let target: number | undefined;
        try {
          if (!matches(lstatSync(generation, { bigint: true, throwIfNoEntry: false }))) continue;
          target = openSafeFile(generation, slotFile);
          if (
            matches(fstatSync(target, { bigint: true })) &&
            readAt(target, position, slot.length).equals(slot)
          ) {
            return target;
          }
        } catch (error) {
          failure = safeProblemMessage(error);
        }
        closeQuietly(target);
      }
    }
    let used = false;
    return (reason: string) => {
      if (used) return;
      used = true;
      let target: number | undefined;
      try {
        const line = plainLine(reason, now, EXIT_LINE_BYTES);
        target = openReservedSlot();
        if (target === undefined) return;
        writeAll(target, line, position);
      } catch (error) {
        failure = safeProblemMessage(error);
      } finally {
        closeQuietly(target);
      }
    };
  }

  const writer: DaemonStartupDiagnostics = {
    path,
    rotatedPath,
    record: (input) =>
      writeBounded(() => {
        if (!SAFE_LABEL.test(input.stage)) throw new Error("invalid diagnostic stage");
        return diagnosticLine(context, input, now, maxRecordBytes);
      }),
    appendLine: (message) => writeBounded(() => plainLine(message, now, maxRecordBytes)),
    appendQuotaObservation: (record) =>
      writeBounded(() => {
        const prefix = `[${now().toISOString()}] quota.observation `;
        const json = quotaObservationJson(record, maxRecordBytes - Buffer.byteLength(prefix) - 1);
        return Buffer.from(`${prefix}${json}\n`);
      }),
    close(reserveExit) {
      if (closed) return;
      try {
        if (fd !== undefined) discardPartial(fd);
        if (reserveExit) return reserveForcedExitLine();
      } catch (error) {
        failure = safeProblemMessage(error);
      } finally {
        closed = true;
        activeWriters.delete(writerKey);
        closeQuietly(fd ?? openWith.exclusiveCreate?.fd);
        fd = undefined;
      }
    },
    lastFailure: () => failure,
  };
  activeWriters.set(writerKey, writer);
  return writer;
}

/** The in-process bounded owner of `path`. `claimed` without a writer means this
 * process refused or closed that target: callers drop the line instead of opening it. */
export function daemonLogOwner(path: string): {
  writer?: DaemonStartupDiagnostics;
  claimed: boolean;
} {
  if (claimedTargets.size === 0) return { claimed: false };
  const resolved = resolve(path);
  for (const writer of activeWriters.values())
    if (writer.path === resolved) return { writer, claimed: true };
  const key = writerIdentity(resolved);
  const writer = activeWriters.get(key);
  return writer ? { writer, claimed: true } : { claimed: claimedTargets.has(key) };
}

export interface ReadDaemonDiagnosticTailOptions {
  path?: string;
  lines?: number;
  platform?: NodeJS.Platform;
  uid?: number;
}

export type DaemonDiagnosticTailRead =
  | {
      kind: "retained";
      text: string;
    }
  | {
      kind: "oversize_omitted";
      observedBytes: number;
      limitBytes: number;
      text: string;
    };

/** Prove the inode and redact the entire bounded generation before selecting lines.
 * For oversized files return an omission without reading any bytes: slicing first
 * could sever a token prefix or the header of a multiline private key. */
export function readDaemonDiagnosticTail(
  options: ReadDaemonDiagnosticTailOptions = {},
): DaemonDiagnosticTailRead {
  const path = resolve(options.path ?? canonicalLogPath());
  const lines = boundedPositiveInt(options.lines ?? 40, "lines", 1);
  if (lines > MAX_TAIL_LINES) throw new Error(`lines must not exceed ${MAX_TAIL_LINES}`);
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? process.getuid?.();
  const fd = openSafeFile(path, {
    platform,
    uid,
    repairMode: false,
    create: false,
    access: constants.O_RDONLY,
  });
  try {
    const size = fstatSync(fd).size;
    if (size > MAX_TAIL_BYTES) {
      return {
        kind: "oversize_omitted",
        observedBytes: size,
        limitBytes: MAX_TAIL_BYTES,
        text: `[daemon diagnostic tail omitted (${safeProblemMessage(basename(path))}): oversize_omitted; ${size} bytes exceeds the ${MAX_TAIL_BYTES}-byte safe read limit]\n`,
      };
    }
    const text = redactSecrets(readAt(fd, 0, size).toString("utf8"));
    const split = text.split("\n").filter((line) => !EXIT_SLOT_LINE.test(line));
    const terminated = split.at(-1) === "";
    if (terminated) split.pop();
    const tail = split.slice(-lines).join("\n");
    return { kind: "retained", text: terminated && tail ? `${tail}\n` : tail };
  } finally {
    closeSync(fd);
  }
}
