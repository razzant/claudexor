import { randomUUID } from "node:crypto";
import {
  ThreadHistoryInput,
  ThreadHistoryPage,
  ThreadHistoryHeader,
  ThreadHistoryTurn,
  ControlTurnRunCard,
  needsOperatorAttention,
  THREAD_HISTORY_PAGE_BYTES,
  THREAD_HISTORY_ROW_BYTES,
  THREAD_HISTORY_HEADER_BYTES,
  encodeThreadHistoryCursor,
  decodeThreadHistoryCursor,
  threadHistoryProblem,
  type ThreadHistoryCursor,
  type ThreadHistoryRevision,
  type ThreadPromptPart,
  type ThreadPromptPartInput,
  type ThreadTurn,
} from "@claudexor/schema";
import { projectThread, projectTurn, projectSession } from "./thread-projection.js";
import { projectHistoryRun } from "./thread-history-run.js";
import type { DaemonRunRecord, ControlOperatorDecisionRecord } from "./run-record.js";

type Key = { id: string; ordinal: number; runId: string | null };
export interface ThreadHistorySource {
  storeId: string | undefined;
  incarnation: object;
  identity(id: string): { epoch: string };
  header(id: string): {
    thread: Record<string, unknown>;
    latest?: {
      id: string;
      ordinal: number;
      runId: string | null;
      refusal: string | null;
      jobId: string | null;
      state: string | null;
    };
    sessions: unknown[];
    sessionsComplete: boolean;
  };
  select(
    input: ThreadHistoryInput,
    cursor: ThreadHistoryCursor | null,
  ): {
    keys: Key[];
    probedMore: boolean;
    direction: "older" | "newer";
    ceiling: number;
    edge: number | null;
  };
  turn(
    threadId: string,
    key: Key,
  ): { raw: ThreadTurn; promptInfo: ThreadHistoryTurn["promptInfo"] };
  coverage(
    threadId: string,
    low: number,
    high: number,
    ceiling: number,
  ): { hasOlder: boolean; hasNewer: boolean };
  runs(ids: string[]): DaemonRunRecord[];
  runInput(record: DaemonRunRecord): {
    waitingOnUser: boolean;
    asyncQuestionsOnly: boolean;
    operator: ControlOperatorDecisionRecord | null;
    childRunIds: string[];
  };
  planAnswer(
    threadId: string,
    planRunId: string,
  ): Pick<ThreadHistoryTurn, "answeredByTurnId" | "answeredByPrompt" | "planAnswerComplete">;
  prompt(input: ThreadPromptPartInput): ThreadPromptPart;
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** One owner for all transports. No await is permitted between allocating the
 * observation order and finishing projection: old SQL facts never acquire a
 * revision sampled after a newer output/terminal/decision/retention read. */
export function createThreadHistoryRead(source: () => ThreadHistorySource) {
  let incarnation: object | undefined;
  let epoch = randomUUID();
  let sequence = 0;
  const begin = (host: ThreadHistorySource): ThreadHistoryRevision => {
    if (host.incarnation !== incarnation) {
      incarnation = host.incarnation;
      epoch = randomUUID();
      sequence = 0;
    }
    return { epoch, sequence: ++sequence };
  };
  const checkStore = (host: ThreadHistorySource, expected?: string) => {
    if (!host.storeId)
      throw threadHistoryProblem(
        "thread_history_unavailable",
        503,
        "durable store identity is unavailable",
      );
    if (expected !== undefined && host.storeId !== expected)
      throw threadHistoryProblem("store_mismatch", 409, "history belongs to another store");
    return host.storeId;
  };
  return {
    threadHistory(raw: ThreadHistoryInput): ThreadHistoryPage {
      const input = ThreadHistoryInput.parse(raw);
      const host = source();
      const revision = begin(host);
      const storeId = checkStore(host, input.expectedStoreId);
      const cursor = input.cursor ? decodeThreadHistoryCursor(input.cursor) : null;
      // Bind store/thread/limit BEFORE resolving an id in a replacement store.
      // Otherwise a lost old thread would mask the required stale-store refusal.
      if (
        cursor &&
        (cursor.storeId !== storeId ||
          cursor.threadId !== input.threadId ||
          cursor.limit !== input.limit)
      )
        throw threadHistoryProblem(
          "thread_history_cursor_stale",
          409,
          "history cursor scope changed; read a fresh page",
        );
      const identity = host.identity(input.threadId);
      if (cursor && cursor.epoch !== identity.epoch)
        throw threadHistoryProblem(
          "thread_history_cursor_stale",
          409,
          "history cursor scope changed; read a fresh page",
        );
      const selected = host.select(input, cursor);
      const rawHeader = host.header(input.threadId);
      const headId =
        typeof rawHeader.thread.head_run_id === "string" ? rawHeader.thread.head_run_id : null;
      const records = new Map(
        host
          .runs([
            ...new Set([
              ...selected.keys.flatMap((k) => (k.runId ? [k.runId] : [])),
              ...(headId ? [headId] : []),
            ]),
          ])
          .map((r) => [r.runId ?? r.id, r]),
      );
      const runCache = new Map<string, ReturnType<typeof projectHistoryRun>>();
      const run = (id: string | null) => {
        if (!id) return null;
        const record = records.get(id);
        // Command retention removes the addressed run directory as well as its
        // receipt. The turn/prompt survive; absence is not a failed store read.
        if (!record) return null;
        if (!runCache.has(id)) runCache.set(id, projectHistoryRun(record, host.runInput(record)));
        return runCache.get(id)!;
      };
      const head = run(headId);
      const headNeedsHuman =
        head?.run.state === "succeeded" && head.run.outcomeFacts
          ? needsOperatorAttention(head.run.outcomeFacts, head.run.operatorDecision !== null)
          : false;
      const { runIds: _runIds, ...thread } = projectThread(rawHeader.thread, headNeedsHuman);
      const latest = rawHeader.latest;
      const admission = latest
        ? projectTurn(
            {
              id: latest.id,
              thread_id: input.threadId,
              run_id: latest.runId,
              enqueue_error: latest.refusal ? JSON.parse(latest.refusal) : null,
              created_at: "",
            },
            new Map(),
          )
        : null;
      const header = ThreadHistoryHeader.parse({
        thread,
        latestTurnId: latest?.id ?? null,
        latestOrdinal: latest?.ordinal ?? null,
        latestAdmission: admission
          ? {
              id: admission.id,
              runId: admission.runId,
              enqueueError: admission.enqueueError,
              jobId: latest?.jobId ?? null,
              state: latest?.state ?? null,
            }
          : null,
        headRun: headId && head ? { runId: headId, run: ControlTurnRunCard.parse(head.run) } : null,
        headRunStatus: !headId ? "unbound" : head ? "available" : "not_retained",
        sessions: [],
        sessionsComplete: false,
      });
      if (bytes(header) > THREAD_HISTORY_HEADER_BYTES)
        throw threadHistoryProblem(
          "thread_history_header_too_large",
          503,
          "history header exceeds its byte limit",
        );
      for (const session of rawHeader.sessions) {
        header.sessions.push(projectSession(session));
        if (bytes(header) > THREAD_HISTORY_HEADER_BYTES) {
          header.sessions.pop();
          break;
        }
      }
      header.sessionsComplete =
        header.sessions.length === rawHeader.sessions.length && rawHeader.sessionsComplete;
      const result: ThreadHistoryPage = {
        storeId,
        epoch: identity.epoch,
        threadId: input.threadId,
        revision,
        header,
        turns: [],
        hasOlder: false,
        hasNewer: false,
        olderCursor: null,
        newerCursor: null,
        replayCursor: null,
        replayNextCursor: null,
        limitedBy: null,
      };
      let pageBytes = bytes(result);
      for (const key of selected.keys) {
        // Reserve a worst-case next row BEFORE reading its prompt/body/output.
        // This keeps decode work limited to emitted rows, including byte pages.
        if (pageBytes + THREAD_HISTORY_ROW_BYTES + 8192 > THREAD_HISTORY_PAGE_BYTES) {
          result.limitedBy = "bytes";
          break;
        }
        const item = host.turn(input.threadId, key);
        const projection = run(key.runId);
        const base = projectTurn(item.raw, new Map());
        const relation =
          key.runId && (!projection || projection.run.mode === "plan")
            ? host.planAnswer(input.threadId, key.runId)
            : { answeredByTurnId: null, answeredByPrompt: null, planAnswerComplete: true };
        const row = ThreadHistoryTurn.parse({
          ...base,
          ordinal: key.ordinal,
          revision,
          promptInfo: item.promptInfo,
          run: projection?.run ?? null,
          runStatus: !key.runId ? "unbound" : projection ? "available" : "not_retained",
          primaryOutput: projection?.primaryOutput ?? null,
          primaryOutputStatus:
            key.runId && !projection
              ? "not_retained"
              : projection?.primaryOutput
                ? "available"
                : "none",
          ...relation,
        });
        const rowBytes = bytes(row);
        if (rowBytes > THREAD_HISTORY_ROW_BYTES)
          throw threadHistoryProblem(
            "thread_history_metadata_too_large",
            503,
            "history row exceeds its byte limit",
          );
        pageBytes += rowBytes + (result.turns.length ? 1 : 0);
        result.turns.push(row);
      }
      result.turns.sort((a, b) => a.ordinal - b.ordinal);
      const low = result.turns[0]?.ordinal,
        high = result.turns.at(-1)?.ordinal;
      if (low !== undefined && high !== undefined) {
        Object.assign(result, host.coverage(input.threadId, low, high, selected.ceiling));
        const encode = (direction: ThreadHistoryCursor["direction"]) =>
          encodeThreadHistoryCursor({
            version: 1,
            storeId,
            epoch: identity.epoch,
            threadId: input.threadId,
            limit: input.limit,
            low,
            high,
            ceiling: selected.ceiling,
            direction,
          });
        result.olderCursor = result.hasOlder ? encode("older") : null;
        result.newerCursor = result.hasNewer ? encode("newer") : null;
        result.replayCursor =
          cursor?.direction === "replay"
            ? encodeThreadHistoryCursor({ ...cursor, after: undefined })
            : encode("replay");
        if (cursor?.direction === "replay" && high < cursor.high)
          result.replayNextCursor = encodeThreadHistoryCursor({ ...cursor, after: high });
        if (!result.limitedBy && selected.probedMore) result.limitedBy = "turns";
      } else if (selected.edge !== null) {
        // No emitted row to advance past: reverse from the addressed boundary,
        // INCLUDING that edge. Empty threads (no edge) still have no coverage.
        const direction = selected.direction === "older" ? "newer" : "older";
        const reverse = encodeThreadHistoryCursor({
          version: 1,
          storeId,
          epoch: identity.epoch,
          threadId: input.threadId,
          limit: input.limit,
          low: selected.edge,
          high: selected.edge,
          ceiling: selected.ceiling,
          direction,
          inclusive: true,
        });
        if (direction === "newer") {
          result.hasNewer = true;
          result.newerCursor = reverse;
        } else {
          result.hasOlder = true;
          result.olderCursor = reverse;
        }
      }
      return ThreadHistoryPage.parse(result);
    },
    threadPromptPart(input: ThreadPromptPartInput): ThreadPromptPart {
      const host = source();
      checkStore(host, input.expectedStoreId);
      host.identity(input.threadId);
      return host.prompt(input);
    },
  };
}
