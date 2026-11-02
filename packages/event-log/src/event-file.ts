import type { RunEvent } from "@claudexor/schema";
import { RunEvent as RunEventSchema } from "@claudexor/schema";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { readTextSafe } from "@claudexor/util";

/* Readers of a run's events.jsonl file: no live writer state is consulted. */

/** Shared reader for live terminal preparation and selected interrupted-run recovery. */
export function readRunEvents(path: string): { events: RunEvent[]; malformed: number } {
  const text = readTextSafe(path);
  if (text === null) return { events: [], malformed: 0 };
  const events: RunEvent[] = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(RunEventSchema.parse(JSON.parse(trimmed)));
    } catch {
      malformed += 1;
    }
  }
  return { events, malformed };
}

/** How much of a log's end `lastSeqInFile` reads before it scans the whole file. */
const LAST_SEQ_TAIL_BYTES = 64 * 1024;

/**
 * Highest `seq` already present in an events.jsonl file (0 for missing/empty).
 * Legacy lines without seq count by position so a continued log never reuses
 * a line number an SSE replayer may have already served as a fallback id.
 *
 * Seqs only grow within a log (its writer is the one owner and continues from
 * the tail when reopened), so the last line carries the highest one. When the
 * last 64 KiB hold that whole line and it carries a numeric seq, the tail
 * answers; a legacy or torn last line (valued by its position), a last line
 * longer than the window, or a read failure takes the full scan.
 */
export function lastSeqInFile(path: string): number {
  try {
    return lastSeqFromTail(path) ?? lastSeqByScan(path);
  } catch {
    return lastSeqByScan(path);
  }
}

/** The last non-blank line's numeric seq, or null when only a scan can tell. */
function lastSeqFromTail(path: string): number | null {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - LAST_SEQ_TAIL_BYTES);
    const window = Buffer.alloc(size - start);
    let end = readSync(fd, window, 0, window.length, start);
    for (;;) {
      const newline = end > 0 ? window.lastIndexOf(0x0a, end - 1) : -1;
      // Without a newline in the window the line may begin before it.
      if (newline < 0 && start > 0) return null;
      const line = window.toString("utf8", newline + 1, end).trim();
      if (line) return finiteSeq(line);
      if (newline < 0) return 0;
      end = newline;
    }
  } finally {
    closeSync(fd);
  }
}

function finiteSeq(line: string): number | null {
  try {
    const seq = (JSON.parse(line) as { seq?: unknown }).seq;
    return typeof seq === "number" && Number.isFinite(seq) ? seq : null;
  } catch {
    return null;
  }
}

function lastSeqByScan(path: string): number {
  const text = readTextSafe(path);
  if (text === null) return 0;
  let last = 0;
  let lineNo = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    lineNo += 1;
    try {
      const parsed = JSON.parse(trimmed) as { seq?: unknown };
      const seq =
        typeof parsed.seq === "number" && Number.isFinite(parsed.seq) ? parsed.seq : lineNo;
      if (seq > last) last = seq;
    } catch {
      if (lineNo > last) last = lineNo;
    }
  }
  return last;
}

export function terminalEventInFile(path: string): boolean {
  const text = readTextSafe(path);
  if (text === null) return false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = RunEventSchema.parse(JSON.parse(trimmed));
      if (
        event.type === "run.completed" ||
        event.type === "run.failed" ||
        event.type === "run.blocked"
      ) {
        return true;
      }
    } catch {
      /* malformed evidence cannot establish a terminal fence */
    }
  }
  return false;
}
