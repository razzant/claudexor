import { TERMINAL_LIFECYCLES } from "@claudexor/schema";

/** Daemon job states that end a stream/wait (shared by both SSE surfaces).
 * The daemon job state IS the run lifecycle (D8), so the terminal set is the
 * ONE projection-owned TERMINAL_LIFECYCLES — no local copy re-derives it. */
export const TERMINAL_STATES: ReadonlySet<string> = TERMINAL_LIFECYCLES;

/** One SSE data line: the exact event, JSON re-minified when parseable. */
export function sseDataLine(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw));
  } catch {
    return raw;
  }
}
/**
 * The run event stream's identity for one non-empty events.jsonl line, shared
 * by the stream and the event-part reader: its persisted seq, else its 1-based
 * non-empty line number (legacy lines, matching EventLog's counter init), and
 * its SSE event name.
 */
export function streamLineIdentity(raw: string, lineNo: number): { seq: number; type: string } {
  try {
    const parsed = JSON.parse(raw) as { type?: unknown; seq?: unknown };
    return {
      seq: typeof parsed.seq === "number" && Number.isFinite(parsed.seq) ? parsed.seq : lineNo,
      type: String(parsed.type ?? "run"),
    };
  } catch {
    return { seq: lineNo, type: "malformed" };
  }
}
