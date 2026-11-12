import { createHash } from "node:crypto";
import type { Thread } from "@claudexor/schema";
import { commandRow, hydrateCommand, type CommandRow } from "./command-rows.js";
import type { BlobFiles } from "./blob-files.js";
import { isServedPid } from "./generations.js";
import type { EngineStore } from "./store.js";
import { decodeBody, hydrateTurn } from "./thread-rows.js";
import { deferredMessageDetail, type DeferredMessageRow } from "./deferred-message-rows.js";

export interface ThreadClosureHold {
  code:
    | "closure_not_quiescent"
    | "closure_awaiting_decision"
    | "closure_partition_unavailable"
    | "command_record_not_retained";
  subject: string;
  message: string;
}

export interface ThreadClosureCommand {
  jobId: string;
  runId: string | null;
  state: string;
  kind: string;
  threadId: string | null;
  turnId: string | null;
  continueFrom: string | null;
  delegatedFrom: string | null;
  runDir: string | null;
}

/** One exact engine record of the closure, addressed for an exported document. */
export interface ThreadClosureDocument {
  key: string;
  path: string;
}

/**
 * Everything the engine store knows about one thread's work, read in one
 * snapshot: the thread, its turns, sessions and checkpoints, and the
 * typed command graph reached from them through `continue_from` and
 * `delegated_from` in both directions, with those commands' interactions,
 * decisions, deferred messages and terminal records. `digest` changes when any
 * of those rows does; `holds` name what keeps the closure from being finished.
 */
export interface ThreadClosure {
  storeId: string;
  thread: Thread;
  headRevision: number;
  digest: string;
  turns: { turnId: string; ordinal: number; runId: string | null; promptSha256: string }[];
  commands: ThreadClosureCommand[];
  documents: ThreadClosureDocument[];
  holds: ThreadClosureHold[];
}

const COLUMNS = `id,pid,operation,client_id,state,run_id,task_id,run_dir,thread_id,turn_id,delegated_from,
  continue_from,scope_root,created_at,started_at,finished_at,summary,params_sha,result_sha,error,kind,live,
  needs_decision,response_state,response_expires_at,request_resource_id,response_resource_id,task_group_id`;

const bytesHex = (value: Uint8Array | null | undefined): string | null =>
  value ? createHash("sha256").update(value).digest("hex") : null;
/** A document's path segment: never a separator, never a dot-only name. */
const segment = (value: string): string =>
  encodeURIComponent(value).replace(/^\.+/, (dots) => "%2E".repeat(dots.length));

function refsOf(thread: Thread, turns: { body: Uint8Array; run_id: string | null }[]): string[] {
  const refs = new Set<string>([
    ...thread.run_ids,
    ...(thread.head_run_id ? [thread.head_run_id] : []),
  ]);
  for (const turn of turns) {
    const body = decodeBody<Record<string, unknown>>(turn);
    if (turn.run_id) refs.add(turn.run_id);
    for (const key of ["parent_run_id", "answers_plan_run_id", "plan_run_id"]) {
      const value = body[key];
      if (typeof value === "string" && value) refs.add(value);
    }
  }
  return [...refs];
}

/** The thread row alone and its store: one addressed read, for answers that
 * need no closure. Like the closure, it answers for a purged thread too. */
export function readClosureThread(
  store: EngineStore,
  threadId: string,
): { storeId: string; thread: Thread } | null {
  const row = store.prepare("SELECT body FROM thread WHERE id=?").get(threadId) as
    { body: Uint8Array } | undefined;
  return row ? { storeId: store.storeId ?? "", thread: decodeBody<Thread>(row) } : null;
}

/** What the closure read uses: statements on one connection, in one snapshot, and the
 * store's identity. Acceptance passes the writer inside its transaction; observation
 * passes the maintenance worker's read-only snapshot (`maintenance-worker.ts`). */
export type ClosureReader = Pick<EngineStore, "prepare" | "storeId">;

/** Throws nothing for a retained thread; a missing thread returns null. */
export function readThreadClosure(store: ClosureReader, threadId: string): ThreadClosure | null {
  const threadRow = store
    .prepare("SELECT pid,state,head_revision,body FROM thread WHERE id=?")
    .get(threadId) as
    { pid: number; state: string; head_revision: number; body: Uint8Array } | undefined;
  if (!threadRow) return null;
  const thread = decodeBody<Thread>(threadRow);
  const turnRows = store
    .prepare(
      "SELECT id,ordinal,run_id,prompt_sha,body FROM turn WHERE thread_id=? ORDER BY ordinal",
    )
    .all(threadId) as {
    id: string;
    ordinal: number;
    run_id: string | null;
    prompt_sha: string;
    body: Uint8Array;
  }[];

  const commands = new Map<string, CommandRow>();
  const pending: CommandRow[] = [];
  const add = (rows: unknown[]): void => {
    for (const row of rows as CommandRow[])
      if (!commands.has(row.id)) {
        commands.set(row.id, row);
        pending.push(row);
      }
  };
  const byThread = store.prepare(`SELECT ${COLUMNS} FROM command WHERE thread_id=?`);
  const byAddress = store.prepare(`SELECT ${COLUMNS} FROM command WHERE id=?1 OR run_id=?1`);
  const byEdge = store.prepare(
    `SELECT ${COLUMNS} FROM command WHERE continue_from=?1 OR delegated_from=?1`,
  );
  add(byThread.all(threadId));
  const holds: ThreadClosureHold[] = [];
  for (const ref of refsOf(thread, turnRows)) {
    const rows = byAddress.all(ref);
    if (rows.length === 0)
      holds.push({
        code: "command_record_not_retained",
        subject: ref,
        message: `run ${ref} is named by the thread but its command record is not retained`,
      });
    add(rows);
  }
  for (let next = pending.shift(); next; next = pending.shift()) {
    for (const address of new Set([next.id, next.run_id].filter((v): v is string => !!v)))
      add(byEdge.all(address));
    for (const edge of [next.continue_from, next.delegated_from])
      if (edge) {
        const rows = byAddress.all(edge);
        if (rows.length === 0)
          holds.push({
            code: "command_record_not_retained",
            subject: edge,
            message: `command ${next.id} links to ${edge}, whose record is not retained`,
          });
        add(rows);
      }
  }

  const ordered = [...commands.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const hash = createHash("sha256");
  const note = (...values: unknown[]): void => void hash.update(`${JSON.stringify(values)}\n`);
  const documents: ThreadClosureDocument[] = [{ key: "thread", path: "sql/thread.json" }];
  note("store", store.storeId ?? null);
  note("thread", threadId, threadRow.pid, threadRow.head_revision, bytesHex(threadRow.body));
  for (const turn of turnRows) {
    note("turn", turn.id, turn.ordinal, turn.run_id, turn.prompt_sha, bytesHex(turn.body));
    documents.push({
      key: `turn:${turn.id}`,
      path: `sql/turns/${String(turn.ordinal).padStart(6, "0")}-${segment(turn.id)}.json`,
    });
    const body = decodeBody<Record<string, unknown>>(turn);
    if (!turn.run_id && !body["enqueue_error"])
      holds.push({
        code: "closure_not_quiescent",
        subject: turn.id,
        message: `turn ${turn.id} has no run and no recorded refusal; its start is still pending`,
      });
  }
  const lanes = store
    .prepare("SELECT id,body FROM session WHERE thread_id=? ORDER BY id")
    .all(threadId) as { id: string; body: Uint8Array }[];
  for (const row of lanes) {
    note("session", row.id, bytesHex(row.body));
    documents.push({ key: `session:${row.id}`, path: `sql/sessions/${segment(row.id)}.json` });
  }
  const checkpoints = store
    .prepare(
      "SELECT harness_id,profile_id,turn_id,body FROM lane_checkpoint WHERE thread_id=? ORDER BY harness_id,profile_id",
    )
    .all(threadId) as {
    harness_id: string;
    profile_id: string;
    turn_id: string;
    body: Uint8Array;
  }[];
  for (const row of checkpoints) {
    note("checkpoint", row.harness_id, row.profile_id, row.turn_id, bytesHex(row.body));
    documents.push({
      key: `checkpoint:${row.harness_id}\0${row.profile_id}`,
      path: `sql/checkpoints/${segment(row.harness_id)}-${segment(row.profile_id || "default")}.json`,
    });
  }

  const decisions = store.prepare("SELECT body FROM operator_decision WHERE run_id=?");
  const terminals = store.prepare("SELECT event FROM run_terminal WHERE run_id=?");
  // Node truncates TEXT at NUL; the key is runId\0interactionId.
  const interactions = store.prepare(
    "SELECT CAST(id AS BLOB) AS id,state,request,resolution FROM interaction WHERE run_id=?",
  );
  const drafts = store.prepare(
    "SELECT * FROM deferred_message WHERE predecessor_job_id=?1 OR successor_job_id=?1",
  );
  const pendingFiles = store.prepare(
    "SELECT 1 FROM effect_obligation WHERE kind='terminal_files' AND key=? AND state='pending'",
  );
  const seenDrafts = new Set<string>();
  for (const row of ordered) {
    note(
      "command",
      row.id,
      row.pid,
      row.operation,
      row.state,
      row.kind,
      row.live,
      row.run_id,
      row.run_dir,
      row.thread_id,
      row.turn_id,
      row.continue_from,
      row.delegated_from,
      row.finished_at,
      row.needs_decision,
      row.params_sha,
      row.result_sha,
      bytesHex(row.summary),
      bytesHex(row.error),
    );
    documents.push({ key: `command:${row.id}`, path: `sql/commands/${segment(row.id)}.json` });
    const label = row.run_id ?? row.id;
    if (row.state === "queued" || row.state === "running")
      holds.push({
        code: "closure_not_quiescent",
        subject: label,
        message: `${row.kind} command ${label} is still ${row.state}`,
      });
    if (row.needs_decision)
      holds.push({
        code: "closure_awaiting_decision",
        subject: label,
        message: `run ${label} is waiting for an operator decision`,
      });
    if (!isServedPid(store, row.pid))
      holds.push({
        code: "closure_partition_unavailable",
        subject: label,
        message: `run ${label} lives in a partition this engine does not serve`,
      });
    for (const draft of drafts.all(row.id) as unknown as DeferredMessageRow[]) {
      if (seenDrafts.has(draft.id)) continue;
      seenDrafts.add(draft.id);
      note(
        "deferred",
        draft.id,
        draft.state,
        draft.revision,
        draft.body_sha,
        draft.successor_job_id,
        draft.dispatched_revision,
        bytesHex(draft.hold),
      );
      documents.push({
        key: `deferred:${draft.id}`,
        path: `sql/deferred/${segment(draft.id)}.json`,
      });
      if (draft.state === "waiting" || draft.state === "held")
        holds.push({
          code: "closure_not_quiescent",
          subject: draft.id,
          message: `deferred message ${draft.id} is ${draft.state}`,
        });
    }
    if (!row.run_id) continue;
    if (pendingFiles.get(row.run_id))
      holds.push({
        code: "closure_not_quiescent",
        subject: row.run_id,
        message: `run ${row.run_id} is terminal but its final files are not yet written`,
      });
    const decision = decisions.get(row.run_id) as { body: Uint8Array } | undefined;
    if (decision) {
      note("decision", row.run_id, bytesHex(decision.body));
      documents.push({
        key: `decision:${row.run_id}`,
        path: `sql/decisions/${segment(row.run_id)}.json`,
      });
    }
    const terminal = terminals.get(row.run_id) as { event: Uint8Array } | undefined;
    if (terminal) {
      note("terminal", row.run_id, bytesHex(terminal.event));
      documents.push({
        key: `terminal:${row.run_id}`,
        path: `sql/terminals/${segment(row.run_id)}.json`,
      });
    }
    const asked = interactions.all(row.run_id) as {
      id: Uint8Array;
      state: string;
      request: Uint8Array;
      resolution: Uint8Array | null;
    }[];
    for (const interaction of asked) {
      const id = Buffer.from(interaction.id).toString("utf8");
      note(
        "interaction",
        id,
        interaction.state,
        bytesHex(interaction.request),
        bytesHex(interaction.resolution),
      );
      documents.push({
        key: `interaction:${id}`,
        path: `sql/interactions/${segment(id)}.json`,
      });
      if (interaction.state === "pending")
        holds.push({
          code: "closure_not_quiescent",
          subject: row.run_id,
          message: `run ${row.run_id} has a pending interaction`,
        });
    }
  }
  return {
    storeId: store.storeId ?? "",
    thread,
    headRevision: threadRow.head_revision,
    digest: `sha256:${hash.digest("hex")}`,
    turns: turnRows.map((row) => ({
      turnId: row.id,
      ordinal: row.ordinal,
      runId: row.run_id,
      promptSha256: row.prompt_sha,
    })),
    commands: ordered.map((row) => ({
      jobId: row.id,
      runId: row.run_id,
      state: row.state,
      kind: row.kind,
      threadId: row.thread_id,
      turnId: row.turn_id,
      continueFrom: row.continue_from,
      delegatedFrom: row.delegated_from,
      runDir: row.run_dir,
    })),
    documents,
    holds,
  };
}

function rowDocument(store: EngineStore, blobs: BlobFiles, threadId: string, key: string): unknown {
  const body = (sql: string, ...args: string[]): unknown => {
    const row = store.prepare(sql).get(...args) as { body: Uint8Array } | undefined;
    return row ? decodeBody(row) : undefined;
  };
  const colon = key.indexOf(":");
  const kind = colon < 0 ? key : key.slice(0, colon);
  const id = colon < 0 ? "" : key.slice(colon + 1);
  switch (kind) {
    case "thread":
      return body("SELECT body FROM thread WHERE id=?", threadId);
    case "turn": {
      const row = store.prepare("SELECT body,prompt_sha FROM turn WHERE id=?").get(id) as
        { body: Uint8Array; prompt_sha: string } | undefined;
      return row ? hydrateTurn(row, blobs) : undefined;
    }
    case "session":
      return body("SELECT body FROM session WHERE id=?", id);
    case "checkpoint": {
      const [harness, profile] = id.split("\0") as [string, string];
      return body(
        "SELECT body FROM lane_checkpoint WHERE thread_id=? AND harness_id=? AND profile_id=?",
        threadId,
        harness,
        profile,
      );
    }
    case "command": {
      const row = commandRow(store, id);
      return row ? hydrateCommand(row, blobs) : undefined;
    }
    case "decision":
      return body("SELECT body FROM operator_decision WHERE run_id=?", id);
    case "terminal": {
      const row = store.prepare("SELECT event FROM run_terminal WHERE run_id=?").get(id) as
        { event: Uint8Array } | undefined;
      return row ? (JSON.parse(Buffer.from(row.event).toString("utf8")) as unknown) : undefined;
    }
    case "interaction": {
      const row = store
        .prepare("SELECT state,request,resolution FROM interaction WHERE id=?")
        .get(id) as
        { state: string; request: Uint8Array; resolution: Uint8Array | null } | undefined;
      if (!row) return undefined;
      const parse = (value: Uint8Array) =>
        JSON.parse(Buffer.from(value).toString("utf8")) as unknown;
      return {
        state: row.state,
        request: parse(row.request),
        resolution: row.resolution ? parse(row.resolution) : null,
      };
    }
    case "deferred": {
      const row = store.prepare("SELECT * FROM deferred_message WHERE id=?").get(id) as
        DeferredMessageRow | undefined;
      return row ? deferredMessageDetail(store, blobs, row) : undefined;
    }
    default:
      return undefined;
  }
}

/** The exact bytes of one closure document; a vanished row is null, never empty. */
export function readThreadClosureDocument(
  store: EngineStore,
  blobs: BlobFiles,
  threadId: string,
  key: string,
): Buffer | null {
  const value = rowDocument(store, blobs, threadId, key);
  return value === undefined ? null : Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}
