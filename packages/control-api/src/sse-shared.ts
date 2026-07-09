import { closeSync, openSync, readSync, statSync } from "node:fs";
import { redactSecrets } from "@claudexor/util";

/** Daemon job states that end a stream/wait (shared by both SSE surfaces). */
export const TERMINAL_STATES = new Set([
  "succeeded",
  "no_op",
  "ungated",
  "review_not_run",
  "blocked",
  "failed",
  "cancelled",
  "interrupted",
  "exhausted",
  "not_converged",
  "stuck_no_progress",
]);

/** One SSE data line: secrets redacted, JSON re-minified when parseable. */
export function redactedSseLine(raw: string): string {
  const redacted = redactSecrets(raw);
  try {
    return JSON.stringify(JSON.parse(redacted));
  } catch {
    return redacted;
  }
}

/** Incremental line reader for events.jsonl tails (rotation-tolerant). */
export function readNewLines(path: string, offset: number, carry: string): { lines: string[]; nextOffset: number; rest: string } {
  const size = statSync(path).size;
  const start = size < offset ? 0 : offset; // file rotated/truncated; start over
  const len = size - start;
  if (len <= 0) return { lines: [], nextOffset: start, rest: carry };
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, start);
    const text = carry + buf.toString("utf8");
    const parts = text.split("\n");
    const rest = parts.pop() ?? "";
    return { lines: parts.filter(Boolean), nextOffset: size, rest };
  } finally {
    closeSync(fd);
  }
}
