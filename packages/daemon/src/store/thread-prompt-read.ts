import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import {
  ThreadPromptPartInput,
  threadHistoryProblem,
  type ThreadPromptPart,
} from "@claudexor/schema";
import type { BlobFiles } from "./blob-files.js";
import type { EngineStore } from "./store.js";

/** Prompt blobs are immutable and hold the turn's exact prompt (INV-146); a turn
 * written under the retired INV-062 keeps the masked prompt it stored then, read
 * back as stored. SQL substr bounds inline allocation; file reads allocate only
 * maxBytes+1. */
export function readThreadPromptPart(
  store: EngineStore,
  blobs: BlobFiles,
  raw: ThreadPromptPartInput,
): ThreadPromptPart {
  const input = ThreadPromptPartInput.parse(raw);
  const row = store
    .prepare(
      `SELECT t.prompt_sha AS sha256,b.size AS totalBytes,
    substr(b.inline,?,?) AS bytes,b.inline IS NOT NULL AS isInline
    FROM turn t LEFT JOIN blob b ON b.sha256=t.prompt_sha WHERE t.id=? AND t.thread_id=?`,
    )
    .get(input.offset + 1, input.maxBytes + 1, input.turnId, input.threadId) as
    { sha256: string; totalBytes: number; bytes: Uint8Array | null; isInline: number } | undefined;
  if (!row) throw threadHistoryProblem("thread_turn_not_found", 404, "no such thread turn prompt");
  if (row.totalBytes === null)
    throw threadHistoryProblem(
      "thread_history_unavailable",
      503,
      "stored prompt blob is unavailable",
    );
  if (input.offset > row.totalBytes)
    throw threadHistoryProblem("invalid_prompt_offset", 400, "prompt offset is past the end");
  let bytes: Buffer;
  if (row.isInline) bytes = Buffer.from(row.bytes!);
  else {
    let fd: number | undefined;
    try {
      fd = openSync(
        blobs.filePath(row.sha256),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size !== row.totalBytes) throw new Error("prompt size changed");
      bytes = Buffer.alloc(Math.min(input.maxBytes + 1, row.totalBytes - input.offset));
      if (readSync(fd, bytes, 0, bytes.length, input.offset) !== bytes.length)
        throw new Error("short prompt read");
    } catch {
      throw threadHistoryProblem(
        "thread_history_unavailable",
        503,
        "stored prompt bytes are unavailable",
      );
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  if (bytes.length && (bytes[0]! & 0xc0) === 0x80)
    throw threadHistoryProblem("invalid_prompt_offset", 400, "offset must be a UTF-8 boundary");
  let end = Math.min(input.maxBytes, bytes.length);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, end),
    );
  } catch {
    throw threadHistoryProblem("thread_history_unavailable", 503, "stored prompt is not UTF-8");
  }
  return {
    threadId: input.threadId,
    turnId: input.turnId,
    sha256: row.sha256,
    totalBytes: row.totalBytes,
    offset: input.offset,
    nextOffset: input.offset + end,
    text,
  };
}
