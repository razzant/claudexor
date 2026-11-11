import {
  THREAD_HISTORY_HEADER_BYTES,
  THREAD_HISTORY_METADATA_BYTES,
  THREAD_HISTORY_PROMPT_BYTES,
  THREAD_HISTORY_SESSION_LIMIT,
  threadHistoryProblem,
  type ThreadHistoryCursor,
  type ThreadHistoryInput,
  type ThreadTurn,
} from "@claudexor/schema";
import type { BlobFiles } from "./blob-files.js";
import { isServedPid } from "./generations.js";
import type { EngineStore } from "./store.js";
import { readThreadPromptPart } from "./thread-prompt-read.js";
import { PLAN_ANSWER_PRESENT_SQL, PLAN_ANSWER_RUN_SQL } from "./schema.js";

export interface HistoryTurnKey {
  id: string;
  ordinal: number;
  runId: string | null;
}
type Identity = { pid: number; epoch: string; state: string };
export interface HistoryReadProbe {
  keys: number;
  bodies: number;
  promptBytes: number;
}
const rawThreadFields = [
  "id",
  "title",
  "folder",
  "repo",
  "mode",
  "workspace",
  "auth_preference",
  "primary_harness",
  "eligible_harnesses",
  "credential_profile_id",
  "access",
  "state",
  "trashed_at",
  "purge_after",
  "head_run_id",
  "created_at",
  "updated_at",
];

/** Address first, project second. No full thread/turn array or command bodies. */
export class SqlThreadHistoryRead {
  constructor(
    readonly store: EngineStore,
    readonly blobs: BlobFiles,
    readonly probe?: HistoryReadProbe,
  ) {}

  identity(id: string): Identity {
    const row = this.store
      .prepare(
        `SELECT t.pid,t.state,p.epoch FROM thread t
      JOIN partition p ON p.id=t.pid WHERE t.id=?`,
      )
      .get(id) as Identity | undefined;
    if (!row) throw threadHistoryProblem("thread_not_found", 404, "no such thread");
    if (!isServedPid(this.store, row.pid))
      throw threadHistoryProblem(
        "thread_history_unavailable",
        503,
        "thread partition is not served",
      );
    if (row.state === "purged")
      throw threadHistoryProblem("thread_purged", 410, "thread was purged");
    return row;
  }

  header(id: string) {
    // SQLite extracts only header fields; the growing run_ids array never crosses
    // the SQL boundary or reaches the JavaScript decoder.
    const expression = `json_object(${rawThreadFields.map((k) => `'${k}',json_extract(CAST(body AS TEXT),'$.${k}')`).join(",")})`;
    const row = this.store
      .prepare(
        `SELECT CASE WHEN length(CAST(${expression} AS BLOB))<=?
      THEN ${expression} END AS header FROM thread WHERE id=?`,
      )
      .get(THREAD_HISTORY_HEADER_BYTES, id) as { header: string | null };
    if (row.header === null)
      throw threadHistoryProblem(
        "thread_history_header_too_large",
        503,
        "thread header exceeds its byte bound",
      );
    const latest = this.store
      .prepare(
        `SELECT id,ordinal,run_id AS runId,
      CASE WHEN length(body)<=? THEN json_extract(CAST(body AS TEXT),'$.enqueue_error') END AS refusal,
      length(body)>? AS oversized FROM turn INDEXED BY turn_thread WHERE thread_id=? ORDER BY ordinal DESC LIMIT 1`,
      )
      .get(THREAD_HISTORY_METADATA_BYTES, THREAD_HISTORY_METADATA_BYTES, id) as
      | {
          id: string;
          ordinal: number;
          runId: string | null;
          refusal: string | null;
          oversized: number;
        }
      | undefined;
    if (latest?.oversized)
      throw threadHistoryProblem(
        "thread_history_metadata_too_large",
        503,
        "latest admission exceeds its byte bound",
      );
    const admission = latest
      ? (this.store
          .prepare(
            `SELECT id AS jobId,state FROM command INDEXED BY command_turn WHERE turn_id=? AND live=1 ORDER BY created_at DESC LIMIT 1`,
          )
          .get(latest.id) as { jobId: string; state: string } | undefined)
      : undefined;
    const sessions = this.store
      .prepare(
        `SELECT CASE WHEN length(body)<=? THEN body END AS body
      FROM session INDEXED BY session_order WHERE thread_id=? ORDER BY insertion_ordinal DESC LIMIT ?`,
      )
      .all(THREAD_HISTORY_METADATA_BYTES, id, THREAD_HISTORY_SESSION_LIMIT + 1) as {
      body: Uint8Array | null;
    }[];
    return {
      thread: Object.fromEntries(
        Object.entries(JSON.parse(row.header) as Record<string, unknown>).filter(
          ([, value]) => value !== null,
        ),
      ),
      latest: latest
        ? { ...latest, jobId: admission?.jobId ?? null, state: admission?.state ?? null }
        : undefined,
      sessions: sessions.slice(0, THREAD_HISTORY_SESSION_LIMIT).map((s) => {
        if (s.body === null)
          throw threadHistoryProblem(
            "thread_history_metadata_too_large",
            503,
            "session metadata exceeds its byte bound",
          );
        return JSON.parse(Buffer.from(s.body).toString("utf8")) as unknown;
      }),
      sessionsComplete: sessions.length <= THREAD_HISTORY_SESSION_LIMIT,
    };
  }

  edge(threadId: string, turnId: string): HistoryTurnKey {
    const key = this.store
      .prepare("SELECT id,ordinal,run_id AS runId FROM turn WHERE id=? AND thread_id=?")
      .get(turnId, threadId) as HistoryTurnKey | undefined;
    if (!key)
      throw threadHistoryProblem(
        "thread_turn_not_found",
        404,
        "turn does not belong to this thread",
      );
    return key;
  }

  select(input: ThreadHistoryInput, cursor: ThreadHistoryCursor | null) {
    let direction: "older" | "newer" = cursor?.direction === "newer" ? "newer" : "older";
    let where = "";
    let edge: number | null = null;
    const args: (number | string)[] = [input.threadId];
    const ceiling =
      cursor?.ceiling ??
      (
        this.store
          .prepare(
            "SELECT ordinal FROM turn INDEXED BY turn_thread WHERE thread_id=? ORDER BY ordinal DESC LIMIT 1",
          )
          .get(input.threadId) as { ordinal: number } | undefined
      )?.ordinal ??
      0;
    if (cursor?.direction === "replay") {
      where = " AND ordinal BETWEEN ? AND ?";
      args.push(cursor.after === undefined ? cursor.low : cursor.after + 1, cursor.high);
      direction = "newer";
    } else if (cursor) {
      edge = direction === "older" ? cursor.low : cursor.high;
      where = ` AND ordinal${direction === "older" ? "<" : ">"}${cursor.inclusive ? "=" : ""}?`;
      args.push(edge);
    } else if (input.beforeTurnId || input.afterTurnId) {
      direction = input.afterTurnId ? "newer" : "older";
      where = direction === "older" ? " AND ordinal<?" : " AND ordinal>?";
      edge = this.edge(input.threadId, (input.afterTurnId ?? input.beforeTurnId)!).ordinal;
      args.push(edge);
    } else if (input.aroundTurnId) {
      // Anchor-first traversal guarantees a byte-limited around read includes it.
      // Adjacent earlier rows follow; clients may then request the newer edge.
      where = " AND ordinal<=?";
      args.push(this.edge(input.threadId, input.aroundTurnId).ordinal);
    }
    where += " AND ordinal<=?";
    args.push(ceiling);
    const keys = this.store
      .prepare(
        `SELECT id,ordinal,run_id AS runId FROM turn INDEXED BY turn_thread
      WHERE thread_id=?${where} ORDER BY ordinal ${direction === "older" ? "DESC" : "ASC"} LIMIT ?`,
      )
      .all(...args, input.limit + 1) as unknown as HistoryTurnKey[];
    if (this.probe) this.probe.keys += keys.length;
    return {
      keys: keys.slice(0, input.limit),
      probedMore: keys.length > input.limit,
      direction,
      ceiling,
      edge,
    };
  }

  turn(threadId: string, key: HistoryTurnKey) {
    const row = this.store
      .prepare(
        "SELECT CASE WHEN length(body)<=? THEN body END AS body FROM turn WHERE id=? AND thread_id=?",
      )
      .get(THREAD_HISTORY_METADATA_BYTES, key.id, threadId) as
      { body: Uint8Array | null } | undefined;
    if (!row?.body)
      throw threadHistoryProblem(
        "thread_history_metadata_too_large",
        503,
        "turn metadata is missing or exceeds its byte bound",
      );
    const prompt = readThreadPromptPart(this.store, this.blobs, {
      threadId,
      turnId: key.id,
      offset: 0,
      maxBytes: THREAD_HISTORY_PROMPT_BYTES,
    });
    if (this.probe) {
      this.probe.bodies++;
      this.probe.promptBytes += prompt.nextOffset;
    }
    return {
      raw: {
        ...JSON.parse(Buffer.from(row.body).toString("utf8")),
        prompt: prompt.text,
      } as ThreadTurn,
      promptInfo: {
        textBytes: prompt.nextOffset,
        totalTextBytes: prompt.totalBytes,
        truncated: prompt.nextOffset < prompt.totalBytes,
      },
    };
  }

  /** First accepted relation, even beyond this page's frozen tail. Matches
   * assertPlanAnswerSubmission / PlanAnswerSubmission.acceptedTurn: bound,
   * unrefused queued, or retryable refusal; only a runless false refusal loses.
   * No whole turn body is decoded, and only the selected prompt is read. */
  planAnswer(threadId: string, planRunId: string) {
    const row = this.store
      .prepare(
        `SELECT id,length(body) AS metadataBytes FROM turn INDEXED BY turn_plan_answer
      WHERE thread_id=? AND ${PLAN_ANSWER_PRESENT_SQL} AND ${PLAN_ANSWER_RUN_SQL}=?
        AND CASE WHEN length(body)>? THEN 1 WHEN run_id IS NOT NULL THEN 1
          ELSE json_type(CAST(body AS TEXT),'$.enqueue_error.retryable') IS NOT 'false' END
      ORDER BY ordinal LIMIT 1`,
      )
      .get(threadId, planRunId, THREAD_HISTORY_METADATA_BYTES) as
      { id: string; metadataBytes: number } | undefined;
    if (row && row.metadataBytes > THREAD_HISTORY_METADATA_BYTES)
      throw threadHistoryProblem(
        "thread_history_metadata_too_large",
        503,
        "plan answer metadata exceeds its byte bound",
      );
    const prompt = row
      ? readThreadPromptPart(this.store, this.blobs, {
          threadId,
          turnId: row.id,
          offset: 0,
          maxBytes: THREAD_HISTORY_PROMPT_BYTES,
        })
      : null;
    return {
      answeredByTurnId: row?.id ?? null,
      answeredByPrompt:
        row && prompt
          ? {
              id: row.id,
              prompt: prompt.text,
              promptInfo: {
                textBytes: prompt.nextOffset,
                totalTextBytes: prompt.totalBytes,
                truncated: prompt.nextOffset < prompt.totalBytes,
              },
            }
          : null,
      planAnswerComplete: true,
    };
  }

  coverage(threadId: string, low: number, high: number, ceiling: number) {
    const probe = (op: string, value: number) =>
      Boolean(
        this.store
          .prepare(
            `SELECT 1 FROM turn INDEXED BY turn_thread WHERE thread_id=? AND ordinal${op}? AND ordinal<=? LIMIT 1`,
          )
          .get(threadId, value, ceiling),
      );
    return { hasOlder: probe("<", low), hasNewer: probe(">", high) };
  }
}
