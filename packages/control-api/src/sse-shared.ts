import { closeSync, openSync, readSync, statSync } from "node:fs";
import { redactSecrets } from "@claudexor/util";
import { TERMINAL_LIFECYCLES } from "@claudexor/schema";

/** Daemon job states that end a stream/wait (shared by both SSE surfaces).
 * The daemon job state IS the run lifecycle (D8), so the terminal set is the
 * ONE projection-owned TERMINAL_LIFECYCLES — no local copy re-derives it. */
export const TERMINAL_STATES: ReadonlySet<string> = TERMINAL_LIFECYCLES;

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
export function readNewLines(
  path: string,
  offset: number,
  carry: string,
): { lines: string[]; nextOffset: number; rest: string } {
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
