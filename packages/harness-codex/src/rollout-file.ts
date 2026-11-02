/**
 * The checked boundary every Claudexor reader of a Codex session rollout
 * shares: the transcript facts (model, quota, vendor failure) and the
 * continuity locator and copy. The run's selected `CODEX_HOME` is
 * canonicalized once, so a home that is itself a link or sits under one
 * (macOS `/var`, `/tmp`) stays usable. Below it nothing is read through a
 * link: `sessions`, its date directories and the part must be plain, and a
 * part is opened without following a link and must still name the inode it
 * was opened as. Reads go in fixed chunks up to an end captured at open,
 * carrying at most one bounded line, so memory never scales with the file.
 */
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
  type Dirent,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

const DEFAULT_LIMITS = { chunkBytes: 1 << 20, maxLineBytes: 8 << 20 };
let limits = DEFAULT_LIMITS;
const stats = { bytes: 0, reads: 0, peakCarryBytes: 0 };

/** Test seam: shrink the read chunk and the carried-line bound; null restores the defaults. */
export function setRolloutReadLimitsForTests(next: Partial<typeof DEFAULT_LIMITS> | null): void {
  limits = next ? { ...DEFAULT_LIMITS, ...next } : DEFAULT_LIMITS;
}

/** Bytes and read calls the scanner issued, and the largest line it carried, since the last reset. */
export function rolloutReadStatsForTests(): Readonly<typeof stats> {
  return { ...stats };
}

export function resetRolloutReadStatsForTests(): void {
  Object.assign(stats, { bytes: 0, reads: 0, peakCarryBytes: 0 });
}

export interface CodexRolloutPart {
  path: string;
  /** A regular file reached with no link at or below `sessions`; anything else is never read. */
  plain: boolean;
}

/**
 * Every part of a thread found by name (`.jsonl` and `.jsonl.zst`) under the
 * canonical home, newest day first. A linked directory is still listed so a
 * detected session is not reported missing, but nothing below a link is plain.
 */
export function codexRolloutParts(home: string, threadId: string): CodexRolloutPart[] {
  return [...rolloutParts(home, threadId)];
}

/** `X.jsonl` and `X.jsonl.zst` are representations of ONE logical part, named by its plain path. */
export function rolloutLogicalPart(path: string): string {
  return path.endsWith(".jsonl.zst") ? path.slice(0, -".zst".length) : path;
}

/**
 * The rollout a transcript reader reads: the plain `.jsonl` representation of
 * the thread's NEWEST logical part. When that part has none (it exists only as
 * `.jsonl.zst`, or only as a link or below one) the answer is null and its
 * facts stay unknown: an older part never stands in for the current one. Both
 * representations share a directory. Discovery stops after the first day with
 * a matching part, visits no older days and remembers nothing between calls.
 */
export function findCodexRollout(home: string, threadId: string): string | null {
  let newest: string | undefined;
  for (const part of rolloutParts(home, threadId, true)) {
    const logical = rolloutLogicalPart(part.path);
    newest ??= logical;
    if (logical !== newest) return null;
    if (part.plain && part.path === logical) return part.path;
  }
  return null;
}

function* rolloutParts(
  home: string,
  threadId: string,
  newestDayOnly = false,
): Generator<CodexRolloutPart> {
  let sessions: string;
  let sessionsLinked: boolean;
  try {
    sessions = join(realpathSync(home), "sessions");
    sessionsLinked = lstatSync(sessions).isSymbolicLink();
  } catch {
    return;
  }
  yield* walk(sessions, 3, sessionsLinked, threadId, newestDayOnly ? { found: false } : null);
}

/**
 * Date directories down to the day (`depth` levels), each read only when the
 * walk reaches it. With `newestDay`, the walk ends with the first day that
 * holds a part of the thread.
 */
function* walk(
  dir: string,
  depth: number,
  linked: boolean,
  threadId: string,
  newestDay: { found: boolean } | null,
): Generator<CodexRolloutPart> {
  for (const entry of entriesNewestFirst(dir)) {
    const path = join(dir, entry.name);
    if (depth > 0) {
      if (newestDay?.found) return;
      if (entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(path)))
        yield* walk(path, depth - 1, linked || entry.isSymbolicLink(), threadId, newestDay);
    } else if (
      entry.name.includes(threadId) &&
      (entry.name.endsWith(".jsonl") || entry.name.endsWith(".jsonl.zst"))
    ) {
      if (newestDay) newestDay.found = true;
      yield { path, plain: !linked && entry.isFile() };
    }
  }
}

function entriesNewestFirst(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? 1 : a.name > b.name ? -1 : 0,
    );
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export interface RolloutFile {
  fd: number;
  /** The end captured at open: a read never chases bytes appended after it. */
  size: number;
  dev: number;
  ino: number;
  mode: number;
}

/**
 * Open a located part only as the plain file it names under
 * `<canonical home>/sessions`. The checks follow the open, so a link swapped
 * in or out around it cannot hand back another file's descriptor.
 */
export function openCodexRolloutPart(home: string, part: string): RolloutFile | null {
  let fd: number | null = null;
  try {
    const root = realpathSync(home);
    const rel = [home, root]
      .map((base) => relative(base, part))
      .find((r) => r.startsWith(`sessions${sep}`) && !isAbsolute(r));
    if (!rel) return null;
    const path = join(root, rel);
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const opened = fstatSync(fd);
    const named = lstatSync(path);
    if (
      opened.isFile() &&
      realpathSync(path) === path &&
      named.dev === opened.dev &&
      named.ino === opened.ino
    )
      return { fd, size: opened.size, dev: opened.dev, ino: opened.ino, mode: opened.mode };
  } catch {
    /* unreadable or not a plain in-tree file */
  }
  if (fd !== null) closeSync(fd);
  return null;
}

/**
 * Copy a located part through the same checked open, chunk by chunk, into a
 * destination that is not a link. Throws when the source is not a plain
 * in-tree file, the destination is the source itself under another spelling,
 * or the copied size does not verify. A destination is truncated only once it
 * is known to be another file and is removed again on a later failure; a
 * refused source or a self-copy leaves every file as it was.
 */
export function copyCodexRolloutPart(home: string, source: string, dest: string): void {
  const file = openCodexRolloutPart(home, source);
  if (!file)
    throw new Error(`rollout part is not a plain file inside the sessions tree: ${source}`);
  let out: number | null = null;
  try {
    out = openSync(
      dest,
      constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const target = fstatSync(out);
    if (target.dev === file.dev && target.ino === file.ino) {
      closeSync(out);
      out = null;
      throw new Error(`rollout copy destination is the source itself: ${dest}`);
    }
    ftruncateSync(out, 0);
    fchmodSync(out, file.mode & 0o777);
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(limits.chunkBytes, file.size)));
    let copied = 0;
    while (copied < file.size) {
      const read = readSync(
        file.fd,
        buffer,
        0,
        Math.min(buffer.length, file.size - copied),
        copied,
      );
      if (read === 0) break;
      for (let written = 0; written < read;)
        written += writeSync(out, buffer, written, read - written);
      copied += read;
    }
    // The source must not have changed under the copy, and the destination
    // must hold exactly the captured size.
    if (
      copied !== file.size ||
      fstatSync(file.fd).size !== file.size ||
      fstatSync(out).size !== file.size
    )
      throw new Error("rollout copy size mismatch");
  } catch (error) {
    if (out !== null) {
      closeSync(out);
      out = null;
      rmSync(dest, { force: true });
    }
    throw error;
  } finally {
    closeSync(file.fd);
    if (out !== null) closeSync(out);
  }
}

/** A line holding at least one requested marker. */
export interface MarkedLine {
  /** The requested markers that occur in the line's bytes. */
  markers: ReadonlySet<string>;
  /** The parsed record; undefined when the line is not JSON or exceeded the carried-line bound. */
  record: unknown;
}

/**
 * Read `[from, end)` of an open rollout in fixed chunks and hand every
 * complete line that contains a marker to `onLine`, in file order; other
 * lines are never decoded. Returns the offset just past the last complete
 * line and the unterminated remainder when it holds a marker, which the
 * caller may weigh but must not consume (codex may still be writing it).
 */
export function scanRolloutLines(
  fd: number,
  from: number,
  end: number,
  markers: readonly string[],
  onLine: (line: MarkedLine) => void,
): { consumed: number; tail: MarkedLine | null } {
  const { chunkBytes, maxLineBytes } = limits;
  const overlap = Math.max(...markers.map((marker) => marker.length)) - 1;
  const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(chunkBytes, end - from)));
  // The line in progress across reads: its bytes while within the bound,
  // then only which markers it showed, plus an edge for markers split by a read.
  let carry = Buffer.alloc(0);
  let heldBytes = 0;
  let oversized: Set<string> | null = null;
  let edge = Buffer.alloc(0);
  const extend = (part: Buffer): void => {
    if (!oversized && heldBytes + part.length <= maxLineBytes) {
      if (heldBytes + part.length > carry.length) {
        const grown = Buffer.allocUnsafe(
          Math.min(maxLineBytes, Math.max(heldBytes + part.length, 2 * carry.length, 4096)),
        );
        carry.copy(grown, 0, 0, heldBytes);
        carry = grown;
      }
      heldBytes += part.copy(carry, heldBytes);
      stats.peakCarryBytes = Math.max(stats.peakCarryBytes, heldBytes);
      return;
    }
    const probe = Buffer.concat([oversized ? edge : carry.subarray(0, heldBytes), part]);
    oversized ??= new Set();
    for (const marker of markers) if (probe.includes(marker)) oversized.add(marker);
    edge = Buffer.from(probe.subarray(Math.max(0, probe.length - overlap)));
    carry = Buffer.alloc(0);
    heldBytes = 0;
  };
  const finish = (): MarkedLine | null => {
    const line = oversized
      ? oversized.size
        ? { markers: oversized, record: undefined }
        : null
      : marked(carry.subarray(0, heldBytes), markers);
    heldBytes = 0;
    oversized = null;
    edge = Buffer.alloc(0);
    return line;
  };
  let consumed = from;
  for (let pos = from; pos < end;) {
    const read = readSync(fd, chunk, 0, Math.min(chunk.length, end - pos), pos);
    if (read <= 0) break; // truncated under us: stop at what exists
    stats.bytes += read;
    stats.reads += 1;
    const view = chunk.subarray(0, read);
    let start = 0;
    if (heldBytes > 0 || oversized) {
      const newline = view.indexOf(0x0a);
      extend(view.subarray(0, newline < 0 ? read : newline));
      if (newline < 0) {
        pos += read;
        continue;
      }
      const line = finish();
      if (line) onLine(line);
      start = newline + 1;
      consumed = pos + start;
    }
    const last = view.lastIndexOf(0x0a);
    if (last >= start) {
      for (const line of markedLinesIn(view, start, last, markers)) onLine(line);
      start = last + 1;
      consumed = pos + start;
    }
    if (start < read) extend(view.subarray(start));
    pos += read;
  }
  return { consumed, tail: heldBytes > 0 || oversized ? finish() : null };
}

/** The marked complete lines of `view[start, last]` (`last` is a newline), in order. */
function markedLinesIn(
  view: Buffer,
  start: number,
  last: number,
  markers: readonly string[],
): MarkedLine[] {
  const starts = new Set<number>();
  for (const marker of markers) {
    for (let at = view.indexOf(marker, start); at >= 0 && at < last;) {
      starts.add(view.lastIndexOf(0x0a, at) + 1);
      const lineEnd = view.indexOf(0x0a, at);
      at = view.indexOf(marker, lineEnd + 1);
    }
  }
  return [...starts]
    .sort((a, b) => a - b)
    .flatMap((lineStart) => {
      const line = marked(
        view.subarray(Math.max(start, lineStart), view.indexOf(0x0a, lineStart)),
        markers,
      );
      return line ? [line] : [];
    });
}

/** Over the bound a line is unparsed however the reads happened to split it. */
function marked(bytes: Buffer, markers: readonly string[]): MarkedLine | null {
  const found = new Set(markers.filter((marker) => bytes.includes(marker)));
  if (found.size === 0) return null;
  let record: unknown;
  try {
    record = bytes.length <= limits.maxLineBytes ? JSON.parse(bytes.toString("utf8")) : undefined;
  } catch {
    record = undefined;
  }
  return { markers: found, record };
}
