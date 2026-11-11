import { DeferredMessageDetail, DeferredMessageProjection } from "@claudexor/schema";
import type { EngineStore } from "./store.js";
import type { BlobFiles } from "./blob-files.js";
import type { MutationContext } from "./mutation.js";

export interface DeferredMessageRow {
  id: string;
  pid: number;
  predecessor_job_id: string;
  revision: number;
  state: DeferredMessageProjection["state"];
  body_sha: string | null;
  hold: Uint8Array | null;
  successor_job_id: string | null;
  dispatched_revision: number | null;
  created_at: string;
  /** The revision its current hold was applied at (#613); a replace keeps the old value. */
  held_revision?: number | null;
  /** Why the draft left a process-custody hold by itself (#613); schema 7. */
  resumed?: Uint8Array | null;
}

const json = (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;

/** Held only for unknown process custody, at exactly this revision, and not replaced
 * since that hold was applied (#613). Rows held before schema 7 never qualify. */
export function heldForProcessCustody(row: DeferredMessageRow, revision: number): boolean {
  if (row.state !== "held" || row.revision !== revision || !row.hold) return false;
  if (row.held_revision !== row.revision) return false;
  try {
    return (json(row.hold) as { code?: unknown } | null)?.code === "settlement_unknown";
  } catch {
    return false;
  }
}

/** The one row writer; `resumed` is history and is never cleared once set. */
export function writeDraftRowInTx(tx: MutationContext, row: DeferredMessageRow): void {
  tx.prepare(
    `INSERT INTO deferred_message(id,pid,predecessor_job_id,revision,state,body_sha,hold,
    successor_job_id,dispatched_revision,created_at,held_revision,resumed)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state=excluded.state,
    body_sha=excluded.body_sha,hold=excluded.hold,successor_job_id=excluded.successor_job_id,
    dispatched_revision=excluded.dispatched_revision,
    held_revision=COALESCE(excluded.held_revision,deferred_message.held_revision),
    resumed=COALESCE(excluded.resumed,deferred_message.resumed)`,
  ).run(
    row.id,
    row.pid,
    row.predecessor_job_id,
    row.revision,
    row.state,
    row.body_sha,
    row.hold,
    row.successor_job_id,
    row.dispatched_revision,
    row.created_at,
    row.held_revision ?? null,
    row.resumed ?? null,
  );
}

/** Compact reads select identities only, never hydrate a command's full result. */
export function deferredMessageProjection(
  store: EngineStore,
  row: DeferredMessageRow,
): DeferredMessageProjection {
  const run = (id: string | null): string | null => {
    if (!id) return null;
    return (
      (
        store.prepare("SELECT run_id FROM command WHERE id=? AND pid=?").get(id, row.pid) as
          { run_id: string | null } | undefined
      )?.run_id ?? null
    );
  };
  const predecessorRunId = run(row.predecessor_job_id);
  return DeferredMessageProjection.parse({
    draftId: row.id,
    revision: row.revision,
    state: row.state,
    predecessorJobId: row.predecessor_job_id,
    predecessorRunId,
    predecessorResult: `/v2/runs/${predecessorRunId ?? row.predecessor_job_id}`,
    hold: row.hold ? json(row.hold) : null,
    ...(row.resumed ? { resumed: json(row.resumed) } : {}),
    dispatchedRevision: row.dispatched_revision,
    successorJobId: row.successor_job_id,
    successorRunId: run(row.successor_job_id),
  });
}

/** Full text and controls are addressed reads only. Cleared rows own no body. */
export function deferredMessageDetail(
  store: EngineStore,
  blobs: BlobFiles,
  row: DeferredMessageRow,
): DeferredMessageDetail {
  const content = row.body_sha
    ? JSON.parse(blobs.read(row.body_sha).toString("utf8"))
    : { prompt: "", attachments: [], capturedStart: null };
  // Controls are captured once by create; replace keeps them and the row's time.
  return DeferredMessageDetail.parse({
    ...deferredMessageProjection(store, row),
    ...content,
    capturedAt: row.body_sha ? row.created_at : null,
  });
}

/** Cold recovery validates the same decoder and linked identities, never
 * turns a valid row into permission to launch it. */
export function validateDeferredMessages(store: EngineStore, blobs: BlobFiles, pid: number): void {
  const rows = store
    .prepare("SELECT * FROM deferred_message WHERE pid=?")
    .all(pid) as unknown as DeferredMessageRow[];
  for (const row of rows) {
    const detail = deferredMessageDetail(store, blobs, row);
    if (
      !store.prepare("SELECT 1 FROM command WHERE id=? AND pid=?").get(row.predecessor_job_id, pid)
    )
      throw new Error("deferred message predecessor is missing");
    if ((detail.state === "cleared") !== (row.body_sha === null))
      throw new Error("deferred message body custody disagrees with state");
    if ((detail.state === "held") !== (detail.hold !== null) && detail.state !== "cleared")
      throw new Error("deferred message hold disagrees with state");
    if (detail.state === "dispatched") {
      if (
        detail.dispatchedRevision !== detail.revision ||
        !detail.successorJobId ||
        !store.prepare("SELECT 1 FROM command WHERE id=? AND pid=?").get(detail.successorJobId, pid)
      )
        throw new Error("deferred message dispatched receipt is invalid");
    } else if (detail.successorJobId !== null || detail.dispatchedRevision !== null)
      throw new Error("undispatched message carries a successor");
  }
}
