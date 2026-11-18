import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import {
  CLAUDE_TURN_REPLIES_HEADER,
  claudeTurnReply,
  ControlRunEventPart,
  RUN_EVENT_PART_DEFAULT_BYTES,
  RUN_EVENT_PART_MAX_BYTES,
  RUN_EVENT_PART_MIN_BYTES,
  RunEvent,
} from "@claudexor/schema";
import { expiredRunBody } from "./artifact-serve-routes.js";
import { queryParam, REPLY_PROJECTION_HEADER } from "./operation-parameters.js";
import type { OperationDraft } from "./operation-draft.js";
import { readRunTombstone } from "./retention.js";
import type { DaemonRunRecord } from "./run-record.js";
import { sseDataLine, streamLineIdentity } from "./sse-shared.js";

/** Route-owned catalog descriptor for the one addressed event-part read. */
export const RUN_EVENT_PART_OPERATION_DRAFTS: OperationDraft[] = [
  {
    method: "GET",
    path: "/v2/runs/:id/events/:id",
    mutability: "read_only",
    requestSchema: null,
    responseSchema: "ControlRunEventPart",
    responseKind: "json",
    summary:
      "Read one bounded part of a validated journal event by seq. By default it contains the exact JSON serialization delivered by the run event stream.",
    parameters: [
      queryParam({
        name: "offset",
        description:
          "UTF-8 byte offset of the part: 0 or the previous part's nextOffset (canonical nonnegative integer at a character boundary).",
      }),
      queryParam({
        name: "limit",
        description: `Maximum part bytes, ${RUN_EVENT_PART_MIN_BYTES} to ${RUN_EVENT_PART_MAX_BYTES} (default ${RUN_EVENT_PART_DEFAULT_BYTES}); a part may end earlier at a character boundary.`,
      }),
      REPLY_PROJECTION_HEADER,
    ],
  },
];

export interface RunEventPartRouteContext {
  findRun(id: string): Promise<DaemonRunRecord | null>;
  json(res: ServerResponse, status: number, body: unknown): void;
}

const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;
const READ_BYTES = 64 * 1024;

function decimal(raw: string | null, name: string, min: number, max: number): number {
  const value = raw !== null && CANONICAL_DECIMAL.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw Object.assign(new Error(`${name} must be a canonical integer from ${min} to ${max}`), {
      code: "invalid_request",
    });
  }
  return value;
}

/**
 * The first valid complete event at the stream address `seq`, scanning
 * events.jsonl in bounded reads with the stream's own line and id rules. An
 * unterminated tail is not served, exactly as the stream holds it back. Each
 * read yields to the daemon's event loop; a part still rescans the history
 * before its event, so the work stays proportional to that history.
 */
async function eventLine(
  path: string,
  runId: string,
  seq: number,
): Promise<{ raw: string; event: RunEvent } | "invalid" | null> {
  let file: FileHandle;
  try {
    file = await open(path, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.allocUnsafe(READ_BYTES);
    let carry: Buffer[] = [];
    let position = 0;
    let lineNo = 0;
    let invalidMatch = false;
    const { size } = await file.stat();
    while (position < size) {
      const length = Math.min(READ_BYTES, size - position);
      const { bytesRead: read } = await file.read(buffer, 0, length, position);
      if (read === 0) return null;
      position += read;
      let start = 0;
      for (let index = 0; index < read; index += 1) {
        if (buffer[index] !== 0x0a) continue;
        const line = Buffer.concat([...carry, buffer.subarray(start, index)]);
        carry = [];
        start = index + 1;
        if (line.length === 0) continue;
        lineNo += 1;
        const text = line.toString("utf8");
        if (streamLineIdentity(text, lineNo).seq !== seq) continue;
        try {
          const parsed = RunEvent.safeParse(JSON.parse(text));
          if (
            parsed.success &&
            parsed.data.run_id === runId &&
            (parsed.data.seq === undefined || parsed.data.seq === seq)
          )
            return { raw: text, event: parsed.data };
        } catch {
          // A damaged row gets a positional SSE id that may equal a later durable seq.
        }
        invalidMatch = true;
      }
      if (start < read) carry.push(Buffer.from(buffer.subarray(start, read)));
    }
    return invalidMatch ? "invalid" : null;
  } finally {
    await file.close();
  }
}

/**
 * `GET /v2/runs/:id/events/:seq?offset=&limit=` — one bounded part of one
 * validated event, in the exact stored serialization the event stream
 * delivers, so a reader whose page cannot hold that event reassembles the
 * same bytes instead of skipping it. Addressed by run and seq only: no path,
 * no other artifact, no whole-log transfer.
 */
export async function handleRunEventPartRoute(
  ctx: RunEventPartRouteContext,
  method: string,
  path: string,
  url: URL,
  res: ServerResponse,
  headers: IncomingHttpHeaders = {},
): Promise<boolean> {
  const runEventPartMatch = /^\/runs\/([^/]+)\/events\/([^/]+)$/.exec(path);
  if (!(method === "GET" && runEventPartMatch)) return false;
  res.setHeader("Vary", CLAUDE_TURN_REPLIES_HEADER);
  let seq: number;
  let offset: number;
  let limit: number;
  try {
    for (const name of url.searchParams.keys()) {
      if (name !== "offset" && name !== "limit") {
        throw Object.assign(new Error(`unknown query parameter: ${name}`), {
          code: "invalid_request",
        });
      }
    }
    seq = decimal(
      decodeURIComponent(runEventPartMatch[2] as string),
      "seq",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    offset = decimal(url.searchParams.get("offset") ?? "0", "offset", 0, Number.MAX_SAFE_INTEGER);
    limit = decimal(
      url.searchParams.get("limit") ?? String(RUN_EVENT_PART_DEFAULT_BYTES),
      "limit",
      RUN_EVENT_PART_MIN_BYTES,
      RUN_EVENT_PART_MAX_BYTES,
    );
  } catch (error) {
    ctx.json(res, 400, { error: (error as Error).message, code: "invalid_request" });
    return true;
  }
  const rec = await ctx.findRun(decodeURIComponent(runEventPartMatch[1] as string));
  if (!rec) {
    ctx.json(res, 404, { error: "no such run" });
    return true;
  }
  const tombstone = () => (rec.runDir ? readRunTombstone(rec.runDir) : null);
  let reclaimed = tombstone();
  const runId = rec.runId ?? rec.id;
  const found =
    reclaimed || !rec.runDir ? null : await eventLine(join(rec.runDir, "events.jsonl"), runId, seq);
  // Retention may reclaim the run while the scan yields: answer as of its end.
  reclaimed ??= tombstone();
  if (reclaimed) {
    ctx.json(res, 410, expiredRunBody(reclaimed));
    return true;
  }
  if (found === null) {
    ctx.json(res, 404, { error: `run has no event ${seq}`, code: "run_event_not_found" });
    return true;
  }
  if (found === "invalid") {
    ctx.json(res, 422, {
      error: `event ${seq} is not a valid run event; it has no readable parts`,
      code: "run_event_invalid",
    });
    return true;
  }
  const { raw, event } = found;
  // Only an opted-in reader gets decoded text pages. The default still reads
  // the exact event serialization, including evidence observed after Stop.
  const reply =
    headers[CLAUDE_TURN_REPLIES_HEADER] === "1" && event.type === "harness.event"
      ? claudeTurnReply(event.payload)
      : null;
  const bytes = Buffer.from(reply?.text ?? sseDataLine(raw), "utf8");
  // A part starts on a character and never splits one at its end.
  if (offset >= bytes.length || ((bytes[offset] as number) & 0xc0) === 0x80) {
    ctx.json(res, 400, {
      error: `offset ${offset} is not a character boundary below ${bytes.length}; use 0 or a returned nextOffset`,
      code: "invalid_request",
    });
    return true;
  }
  let end = Math.min(offset + limit, bytes.length);
  while (end < bytes.length && ((bytes[end] as number) & 0xc0) === 0x80) end -= 1;
  const part = bytes.subarray(offset, end);
  ctx.json(
    res,
    200,
    ControlRunEventPart.parse({
      runId,
      seq,
      type: event.type,
      totalBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      offset,
      nextOffset: end,
      text: part.toString("utf8"),
      ...(reply
        ? {
            claudeTurnReply: {
              source: reply.source,
              partSha256: createHash("sha256").update(part).digest("hex"),
            },
          }
        : {}),
    }),
  );
  return true;
}
