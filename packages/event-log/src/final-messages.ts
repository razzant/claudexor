import { createHash, randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  FINAL_MESSAGES_PATH,
  FinalMessagesHeader,
  FinalMessagesPointer,
  type RunEvent,
} from "@claudexor/schema";
import { ensureDir } from "@claudexor/util";
import { terminalTypeOf } from "./event-file.js";

interface EventSource {
  /** Readable rows from the start of this run's events.jsonl, in file order. */
  events: readonly RunEvent[];
  /** Records of the same log that could not be read. */
  malformed: number;
  /** The run's writer observed a failed event append or journal landing. */
  eventLoss?: boolean;
}

/**
 * A harness message its adapter typed final, as recorded: neither a fragment
 * (`delta`) nor a buffered snapshot. Its text is never inspected, so an empty
 * final or one carrying only a machine envelope still counts. A result Claude
 * Code reported for another turn is already rebuilt by its adapter as a
 * `foreign_result` status, so it is no message and never counts.
 */
export function isFinalMessage(event: RunEvent): boolean {
  if (event.type !== "harness.event") return false;
  const harness = event.payload;
  if (harness["type"] !== "message" || harness["final"] !== true) return false;
  const native = harness["payload"];
  const flags =
    native && typeof native === "object" && !Array.isArray(native)
      ? (native as Record<string, unknown>)
      : {};
  return flags["delta"] !== true && flags["buffered"] !== true;
}

/**
 * The run's typed finals in event order, each line one complete event exactly
 * as the run's log serializes it, with every attempt, session and native fact
 * it recorded. Nothing is merged, trimmed, deduplicated, capped or chosen, and
 * no final is inferred from narration when none was typed. Reading stops at
 * the first terminal. The producer reads its log before its own terminal is
 * appended, so every unreadable record it counts precedes that boundary and
 * makes the document partial.
 */
export function finalMessagesDocument(
  runId: string,
  source: EventSource,
): { header: FinalMessagesHeader; bytes: Buffer } {
  const records: string[] = [];
  let throughEventSeq = 0;
  let lastId = 0;
  let partial = source.eventLoss === true || source.malformed > 0;
  for (const [index, event] of source.events.entries()) {
    // The per-run writer starts at 1. A legacy row occupies its nonblank line
    // number, as in lastSeqInFile. The first terminal can prove a preceding gap.
    const id = event.seq ?? index + 1;
    if (id > lastId + 1) partial = true;
    if (terminalTypeOf(event.type)) break;
    lastId = Math.max(lastId, id);
    throughEventSeq = Math.max(throughEventSeq, event.seq ?? 0);
    if (isFinalMessage(event)) records.push(JSON.stringify(event));
  }
  const header = FinalMessagesHeader.parse({
    schemaVersion: 1,
    runId,
    state: partial ? "partial" : "complete",
    count: records.length,
    throughEventSeq,
  });
  const text = [JSON.stringify(header), ...records].map((line) => `${line}\n`).join("");
  return { header, bytes: Buffer.from(text, "utf8") };
}

/**
 * Publish the run's final-messages document and return its pointer: the size
 * and digest of exactly the bytes written. The bytes reach the address only by
 * an atomic rename, so a failed write leaves no partial document there. A log
 * with no readable event was not checked (an announced run always recorded
 * `run.created`), so it is refused rather than published as an empty answer.
 */
export function writeFinalMessages(
  runDir: string,
  runId: string,
  source: EventSource,
): FinalMessagesPointer {
  if (source.events.length === 0) throw new Error("the run's event log has no readable event");
  const { header, bytes } = finalMessagesDocument(runId, source);
  const path = join(runDir, FINAL_MESSAGES_PATH);
  const temporary = join(dirname(path), `.final-messages-${randomUUID()}.tmp`);
  try {
    ensureDir(dirname(path));
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return FinalMessagesPointer.parse({
    path: FINAL_MESSAGES_PATH,
    state: header.state,
    count: header.count,
    bytes: bytes.byteLength,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    throughEventSeq: header.throughEventSeq,
  });
}
