import type { LaneCheckpoint, Session, Thread, ThreadTurn } from "@claudexor/schema";
import { parseMutation, type ThreadMutation } from "../thread-store-support.js";
import type { BlobFiles, BodyRef } from "./blob-files.js";
import { deleteUnownedInlineInTx } from "./blob-files.js";
import { bindIdempotencyInTx } from "./idempotency.js";
import { requireTransaction, type SqlWriteContext } from "./mutation.js";

export const encodeBody = (body: unknown): Buffer => Buffer.from(JSON.stringify(body));
export const decodeBody = <T>(row: { body: Uint8Array }): T =>
  JSON.parse(Buffer.from(row.body).toString("utf8")) as T;

export interface PreparedThreadMutation {
  mutation: ThreadMutation;
  prompts: ReadonlyMap<string, BodyRef>;
}

export function prepareThreadMutation(
  blobs: BlobFiles,
  value: ThreadMutation,
): PreparedThreadMutation {
  const mutation = parseMutation(value);
  const prompts = new Map(
    (mutation.turns ?? []).map((turn) => [turn.id, blobs.prepareBody(Buffer.from(turn.prompt))]),
  );
  return { mutation, prompts };
}

/** Pure replay/runtime reducer. The importer supplies prepared prompt bytes
 * and original time on its one connection; no files, callbacks or COMMIT here. */
export function applyThreadMutation(
  sql: SqlWriteContext,
  pid: number,
  prepared: PreparedThreadMutation,
  time: string,
): string[] {
  requireTransaction(sql);
  const changed = new Set<string>();
  const mutation = parseMutation(prepared.mutation);
  for (const thread of mutation.threads ?? []) {
    const result = sql
      .prepare(
        `INSERT INTO thread(id,pid,state,updated_at,body) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at, body=excluded.body
      WHERE thread.pid=excluded.pid`,
      )
      .run(thread.id, pid, thread.state, thread.updated_at, encodeBody(thread));
    if (!result.changes) throw new Error(`thread ${thread.id} belongs to another generation`);
  }
  for (const turn of mutation.turns ?? []) {
    const ref = prepared.prompts.get(turn.id);
    if (!ref) throw new Error(`missing prepared prompt for ${turn.id}`);
    const old = sql.prepare("SELECT pid, ordinal, prompt_sha FROM turn WHERE id=?").get(turn.id) as
      { pid: number; ordinal: number; prompt_sha: string } | undefined;
    if (old && old.pid !== pid) throw new Error(`turn ${turn.id} belongs to another generation`);
    const ordinal = old?.ordinal ?? nextOrdinal(sql, "turn", turn.thread_id);
    sql
      .prepare("INSERT OR IGNORE INTO blob(sha256,size,inline) VALUES(?,?,?)")
      .run(ref.sha256, ref.size, ref.inline);
    const { prompt: _prompt, ...body } = turn;
    sql
      .prepare(
        `INSERT INTO turn(id,pid,thread_id,ordinal,run_id,created_at,prompt_sha,body) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id, prompt_sha=excluded.prompt_sha, body=excluded.body`,
      )
      .run(
        turn.id,
        pid,
        turn.thread_id,
        ordinal,
        turn.run_id,
        turn.created_at,
        ref.sha256,
        encodeBody(body),
      );
    changed.add(ref.sha256);
    if (old) changed.add(old.prompt_sha);
  }
  for (const session of mutation.sessions ?? []) writeLane(sql, "session", pid, session);
  for (const checkpoint of mutation.checkpoints ?? [])
    writeLane(sql, "lane_checkpoint", pid, checkpoint);
  const bindings = [
    mutation.threadCreation && {
      ...mutation.threadCreation,
      owner: "thread" as const,
      targetId: mutation.threadCreation.threadId,
      operation: "thread.create",
    },
    mutation.idempotency && {
      ...mutation.idempotency,
      owner: "turn" as const,
      targetId: mutation.idempotency.turnId,
      operation: "thread.turn.create",
    },
  ];
  for (const binding of bindings) {
    if (!binding) continue;
    const saved = bindIdempotencyInTx(sql, { ...binding, pid, createdAt: time });
    if (saved.targetId !== binding.targetId)
      throw new Error("conflicting thread idempotency history");
  }
  for (const sha of changed) deleteUnownedInlineInTx(sql, sha);
  return [...changed];
}

function nextOrdinal(
  sql: SqlWriteContext,
  table: "turn" | "session" | "lane_checkpoint",
  scope: string | number,
): number {
  const column = table === "turn" ? "ordinal" : "insertion_ordinal";
  const key = table === "turn" ? "thread_id" : "pid";
  const row = sql
    .prepare(`SELECT ${column} AS n FROM ${table} WHERE ${key}=? ORDER BY ${column} DESC LIMIT 1`)
    .get(scope) as { n: number } | undefined;
  return (row?.n ?? -1) + 1;
}

function writeLane(
  sql: SqlWriteContext,
  table: "session" | "lane_checkpoint",
  pid: number,
  item: Session | LaneCheckpoint,
): void {
  if (table === "session") {
    const previous = sql
      .prepare("SELECT insertion_ordinal FROM session WHERE id=? AND pid=?")
      .get(item.id, pid) as { insertion_ordinal: number } | undefined;
    const ordinal = previous?.insertion_ordinal ?? nextOrdinal(sql, table, pid);
    const result = sql
      .prepare(
        `INSERT INTO session(id,thread_id,harness_id,profile_id,pid,insertion_ordinal,body)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET profile_id=excluded.profile_id,body=excluded.body
      WHERE session.pid=excluded.pid`,
      )
      .run(
        item.id,
        item.thread_id,
        item.harness_id,
        item.profile_id ?? "",
        pid,
        ordinal,
        encodeBody(item),
      );
    if (!result.changes) throw new Error(`session ${item.id} belongs to another generation`);
    return;
  }
  // Checkpoints retain legacy lane identity, including the null/default alias.
  const previous = sql
    .prepare(
      `SELECT profile_id,insertion_ordinal FROM ${table}
    WHERE thread_id=? AND harness_id=? AND json_extract(CAST(body AS TEXT),'$.id')=?`,
    )
    .get(item.thread_id, item.harness_id, item.id) as
    { profile_id: string; insertion_ordinal: number } | undefined;
  const ordinal = previous?.insertion_ordinal ?? nextOrdinal(sql, table, pid);
  const profile = item.profile_id ?? "";
  if (previous && previous.profile_id !== profile) {
    sql
      .prepare(`DELETE FROM ${table} WHERE thread_id=? AND harness_id=? AND profile_id=? AND pid=?`)
      .run(item.thread_id, item.harness_id, previous.profile_id, pid);
  }
  const result = sql
    .prepare(
      `INSERT INTO lane_checkpoint(thread_id,harness_id,profile_id,pid,insertion_ordinal,body,turn_id)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(thread_id,harness_id,profile_id) DO UPDATE SET body=excluded.body,turn_id=excluded.turn_id
    WHERE lane_checkpoint.pid=excluded.pid`,
    )
    .run(
      item.thread_id,
      item.harness_id,
      profile,
      pid,
      ordinal,
      encodeBody(item),
      (item as LaneCheckpoint).turn_id,
    );
  if (!result.changes) throw new Error(`checkpoint ${item.id} belongs to another generation`);
}

/** Applied separately after project rows; import never emits a fresh ping. */
export function applyImportedHeadRevision(
  sql: SqlWriteContext,
  threadId: string,
  revision: number,
): void {
  requireTransaction(sql);
  sql
    .prepare("UPDATE thread SET head_revision=max(head_revision,?) WHERE id=?")
    .run(revision, threadId);
}

export function readThread(
  sql: Pick<SqlWriteContext, "prepare">,
  pid: number,
  id: string,
): Thread | undefined {
  const row = sql.prepare("SELECT body FROM thread WHERE id=? AND pid=?").get(id, pid) as
    { body: Uint8Array } | undefined;
  return row ? decodeBody<Thread>(row) : undefined;
}

export function readTurn(
  sql: Pick<SqlWriteContext, "prepare">,
  blobs: Pick<BlobFiles, "read">,
  pid: number,
  id: string,
): ThreadTurn | undefined {
  const row = sql.prepare("SELECT body,prompt_sha FROM turn WHERE id=? AND pid=?").get(id, pid) as
    { body: Uint8Array; prompt_sha: string } | undefined;
  return row ? hydrateTurn(row, blobs) : undefined;
}

export function hydrateTurn(
  row: { body: Uint8Array; prompt_sha: string },
  blobs: Pick<BlobFiles, "read">,
): ThreadTurn {
  return {
    ...decodeBody<Omit<ThreadTurn, "prompt">>(row),
    prompt: blobs.read(row.prompt_sha).toString("utf8"),
  };
}
