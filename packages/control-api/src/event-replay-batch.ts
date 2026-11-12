import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { sseDataLine, streamLineIdentity } from "./sse-shared.js";

/** Work units, not a history limit: the caller continues until the file is quiet. */
export const EVENT_REPLAY_BYTES = 64 * 1024;

type ReadCursor = { phase: "read"; offset: number; carry: Uint8Array; lineNo: number | null };
type SeekCursor = {
  phase: "seek";
  before: number;
  end: number;
  carry: Uint8Array;
  trailing: boolean;
  lineNo: number | null;
  selected?: ReadCursor;
};
type CountCursor = {
  phase: "count";
  offset: number;
  end: number;
  lineNo: number;
  nonempty: boolean;
  resume: ReadCursor | SeekCursor;
};
export type EventReplayCursor = ReadCursor | SeekCursor | CountCursor;

/** Plain records cross the bulk executor boundary; it never owns a live stream. */
export interface EventReplayRequest {
  path: string;
  lastEventId: number;
  cursor?: EventReplayCursor;
}
export interface EventReplayFrame {
  seq: number;
  type: string;
  data: string;
  terminal: boolean;
}
export interface EventReplayResult {
  cursor?: EventReplayCursor;
  frames: EventReplayFrame[];
  terminalSeen: boolean;
  /** Another finite batch can make progress without waiting for a producer. */
  progressed: boolean;
  missing?: boolean;
}

const empty = () => new Uint8Array();
const fromStart = (): ReadCursor => ({ phase: "read", offset: 0, carry: empty(), lineNo: 0 });
const result = (
  cursor: EventReplayCursor,
  progressed: boolean,
  terminalSeen = false,
): EventReplayResult => ({
  cursor,
  frames: [],
  terminalSeen,
  progressed,
});
const isTerminal = (type: string) =>
  type === "run.completed" || type === "run.failed" || type === "run.blocked";

function readBytes(fd: number, start: number, length: number): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  const count = readSync(fd, bytes, 0, length, start);
  return bytes.subarray(0, count);
}

/**
 * Locate a resume point from the tail. Persisted seqs are monotonic, as owned by
 * EventLog. A legacy/malformed row needs an absolute non-empty line number:
 * count raw newline-delimited bytes in finite jobs, without parsing the prefix,
 * then resume this backward search with that known position. An uncertain
 * legacy/mixed log may require a full backward scan; only a persisted seq is a
 * safe fence for an earlier durable event.
 */
function seek(fd: number, cursor: SeekCursor, lastEventId: number): EventReplayResult {
  const start = Math.max(0, cursor.before - Math.max(EVENT_REPLAY_BYTES, cursor.carry.length));
  const bytes = Buffer.concat([readBytes(fd, start, cursor.before - start), cursor.carry]);
  let end = bytes.length;
  let selected = cursor.selected;
  if (cursor.trailing) {
    end = bytes.lastIndexOf(10);
    if (end < 0) {
      return start === 0 ? result(fromStart(), true) : result({ ...cursor, before: start }, true);
    }
    selected = { phase: "read", offset: start + end + 1, carry: empty(), lineNo: cursor.lineNo };
  }
  let lineNo = cursor.lineNo;
  let terminalSeen = false;
  while (end >= 0) {
    const previous = end > 0 ? bytes.lastIndexOf(10, end - 1) : -1;
    if (previous < 0 && start > 0) {
      return result(
        {
          ...cursor,
          before: start,
          carry: bytes.subarray(0, end),
          trailing: false,
          lineNo,
          selected,
        },
        true,
        terminalSeen,
      );
    }
    const raw = bytes.toString("utf8", previous + 1, end);
    if (raw.length > 0) {
      const { seq: persisted, type } = streamLineIdentity(raw, Number.NaN);
      terminalSeen ||= isTerminal(type);
      if (!Number.isFinite(persisted) && lineNo === null) {
        return result(
          {
            phase: "count",
            offset: 0,
            end: cursor.end,
            lineNo: 0,
            nonempty: false,
            resume: {
              ...cursor,
              before: cursor.end,
              carry: empty(),
              trailing: true,
              selected: undefined,
            },
          },
          true,
          terminalSeen,
        );
      }
      if (Number.isFinite(persisted) && persisted <= lastEventId) {
        return result(
          { phase: "read", offset: start + end + 1, carry: empty(), lineNo },
          true,
          terminalSeen,
        );
      }
      if ((Number.isFinite(persisted) ? persisted : lineNo!) > lastEventId) {
        selected = {
          phase: "read",
          offset: start + previous + 1,
          carry: empty(),
          lineNo: lineNo === null ? null : lineNo - 1,
        };
      }
      // A legacy id below the cursor does not fence an earlier durable seq:
      // malformed/no-seq rows can follow a durable log with seq gaps.
      if (lineNo !== null) lineNo -= 1;
    }
    if (previous < 0) return result(selected ?? fromStart(), true, terminalSeen);
    end = previous;
  }
  return result(fromStart(), true);
}

function countLines(fd: number, cursor: CountCursor): EventReplayResult {
  const bytes = readBytes(
    fd,
    cursor.offset,
    Math.min(EVENT_REPLAY_BYTES, cursor.end - cursor.offset),
  );
  let { lineNo, nonempty } = cursor;
  for (const byte of bytes) {
    if (byte === 10) {
      if (nonempty) lineNo += 1;
      nonempty = false;
    } else {
      nonempty = true;
    }
  }
  const offset = cursor.offset + bytes.length;
  return result(
    offset < cursor.end ? { ...cursor, offset, lineNo, nonempty } : { ...cursor.resume, lineNo },
    true,
  );
}

function readTail(
  fd: number,
  size: number,
  cursor: ReadCursor,
  lastEventId: number,
): EventReplayResult {
  if (size === cursor.offset) return result(cursor, false);
  const bytes = Buffer.concat([
    cursor.carry,
    // Grow with an unfinished event so carry copying stays linear in its size.
    readBytes(
      fd,
      cursor.offset,
      Math.min(Math.max(EVENT_REPLAY_BYTES, cursor.carry.length), size - cursor.offset),
    ),
  ]);
  const nextOffset = cursor.offset + bytes.length - cursor.carry.length;
  const lastNewline = bytes.lastIndexOf(10);
  const rawLines =
    lastNewline < 0 ? [] : bytes.toString("utf8", 0, lastNewline).split("\n").filter(Boolean);
  // Preserve byte carry, including a UTF-8 codepoint split across reads, and
  // decode only complete events, so a batch never ends inside an event.
  const carry = bytes.subarray(lastNewline + 1);
  let lineNo = cursor.lineNo;
  const frames: EventReplayFrame[] = [];
  let terminalSeen = false;
  for (const raw of rawLines) {
    if (lineNo !== null) lineNo += 1;
    const { seq, type } = streamLineIdentity(raw, lineNo ?? Number.NaN);
    if (!Number.isFinite(seq)) {
      return result(
        {
          phase: "count",
          offset: 0,
          end: cursor.offset - cursor.carry.length,
          lineNo: 0,
          nonempty: false,
          resume: cursor,
        },
        true,
      );
    }
    const terminal = isTerminal(type);
    terminalSeen ||= terminal;
    if (seq > lastEventId) frames.push({ seq, type, terminal, data: sseDataLine(raw) });
  }
  return {
    cursor: { phase: "read", offset: nextOffset, carry, lineNo },
    frames,
    terminalSeen,
    progressed: rawLines.length > 0 || nextOffset < size,
  };
}

/** One finite, read-only job. All offsets describe bytes actually read, never a later cursor. */
export function readEventReplayBatch(request: EventReplayRequest): EventReplayResult {
  let fd: number;
  try {
    fd = openSync(request.path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        cursor: request.cursor,
        frames: [],
        terminalSeen: false,
        progressed: false,
        missing: true,
      };
    }
    throw error;
  }
  try {
    const size = fstatSync(fd).size;
    let cursor: EventReplayCursor =
      request.cursor ??
      (request.lastEventId > 0 && size > 0
        ? { phase: "seek", before: size, end: size, carry: empty(), trailing: true, lineNo: null }
        : fromStart());
    // Rotation discards both the old byte offset and its incomplete codepoint.
    const end = cursor.phase === "read" ? cursor.offset : cursor.end;
    if (size < end) cursor = fromStart();
    if (cursor.phase === "seek") return seek(fd, cursor, request.lastEventId);
    if (cursor.phase === "count") return countLines(fd, cursor);
    return readTail(fd, size, cursor, request.lastEventId);
  } finally {
    closeSync(fd);
  }
}
