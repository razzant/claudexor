import type { FoldRecord, FoldVerdict } from "@claudexor/journal";
import { isHarnessMaintenanceOperation, isModelOperation } from "@claudexor/schema";
import { journalFoldPolicy } from "../journal-fold-policy.js";
import type { EngineStore } from "./store.js";

export interface EventInput {
  type: string;
  payload: unknown;
  time?: string;
  /** Bare hex digest when the payload body lives in `blob` (collection reads never select it). */
  payloadSha?: string | null;
}

export interface AppendedEvent {
  seq: number;
  verdict: FoldVerdict;
  /** False when the verdict dropped the record (the sequence number is still consumed). */
  stored: boolean;
  /** `payload_sha` of every row this append deleted (retire/slot): owner changes the
   * caller reports with `noteOwnerChange` after COMMIT (A3/C10). */
  releasedDigests: string[];
}

/**
 * Append one `event` row under the journal fold's verdict (SYNTHESIS_R5 §6.6),
 * inside the caller's transaction. `retire` deletes every retained row under
 * the named slot/group keys; `slot` deletes the previous holder; `drop` skips
 * the insert. Sequence numbers come from `partition.next_seq` and are consumed
 * even for dropped records, exactly like a frame the fold forgets on disk.
 */
export function appendEvent(
  store: EngineStore,
  pid: number,
  input: EventInput,
  verdictOf: (record: FoldRecord) => FoldVerdict = journalFoldPolicy.verdict,
): AppendedEvent {
  if (!store.inTransaction) throw new Error("events are appended inside the owner's transaction");
  const current = store.prepare("SELECT next_seq FROM partition WHERE id = ?").get(pid) as
    { next_seq: number | bigint } | undefined;
  if (!current) throw new Error(`no partition generation ${pid}`);
  const seq = Number(current.next_seq);
  const time = input.time ?? store.now().toISOString();
  const bytes = Buffer.from(JSON.stringify(input.payload ?? null));
  const verdict =
    verdictOf({
      seq,
      type: input.type,
      time,
      payload: input.payload,
      byteLength: bytes.byteLength,
    }) ?? {};
  const releasedDigests: string[] = [];
  const collect = (rows: unknown[]): void => {
    for (const row of rows as Array<{ payload_sha: string | null }>) {
      if (typeof row.payload_sha === "string") releasedDigests.push(row.payload_sha);
    }
  };
  const retire = store.prepare(
    "DELETE FROM event WHERE pid = ? AND (slot_key = ? OR group_key = ?) RETURNING payload_sha",
  );
  for (const name of verdict.retire ?? []) collect(retire.all(pid, name, name));
  if (verdict.slot !== undefined) {
    collect(
      store
        .prepare("DELETE FROM event WHERE pid = ? AND slot_key = ? RETURNING payload_sha")
        .all(pid, verdict.slot),
    );
  }
  if (!verdict.drop) {
    store
      .prepare(
        "INSERT INTO event(pid, seq, time, type, payload, payload_sha, slot_key, group_key) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        pid,
        seq,
        time,
        input.type,
        bytes,
        input.payloadSha ?? null,
        verdict.slot ?? null,
        verdict.group ?? null,
      );
  }
  store.prepare("UPDATE partition SET next_seq = ? WHERE id = ?").run(seq + 1, pid);
  return { seq, verdict, stored: !verdict.drop, releasedDigests };
}

/** `command.kind` (R5_AMENDMENTS A1): set once at accept, the single source of
 * both the `GET /v2/runs` predicate (`product`) and the retention `terminal`
 * predicate (`product`, `delivery`, `maintenance`). */
export type CommandKind = "product" | "delivery" | "maintenance" | "model" | "account_reset";

export function commandKind(id: string, params: unknown): CommandKind {
  if (id.startsWith("account-reset-")) return "account_reset";
  if (id.startsWith("delivery-")) return "delivery";
  if (isModelOperation(params)) return "model";
  if (isHarnessMaintenanceOperation(params)) return "maintenance";
  return "product";
}

/** Bounded count of today's `terminal` set over the live generations (B1 query 1). */
export const COMMAND_TERMINAL_COUNT_SQL = `SELECT count(*) AS n FROM (
  SELECT 1 FROM command INDEXED BY command_terminal
  WHERE live = 1 AND kind IN ('product','delivery','maintenance') AND finished_at IS NOT NULL
  LIMIT ?1)`;

/** One keyset page of prune candidates, oldest first (B1 query 2 as amended by C1). */
export const COMMAND_PRUNABLE_PAGE_SQL = `SELECT id, run_id, run_dir, continue_from, created_at
  FROM command INDEXED BY command_prunable
  WHERE live = 1 AND kind IN ('product','delivery','maintenance') AND finished_at IS NOT NULL AND needs_decision = 0
    AND finished_at <= ?1
    AND (created_at, id) > (?2, ?3)
  ORDER BY created_at, id LIMIT ?4`;

/** Continuation exemption: `continueFrom` names a live run id or job id that is still retained. */
export const RETAINED_PREDECESSOR_SQL = `SELECT EXISTS(
  SELECT 1 FROM command WHERE live = 1 AND (id = ?1 OR run_id = ?1)) AS retained`;

export const COMMAND_RETENTION_CAP = 500;
export const COMMAND_RETENTION_BATCH = 100;

export interface PrunableCommand {
  id: string;
  runId: string | null;
  runDir: string | null;
  continueFrom: string | null;
  createdAt: string;
}

export interface CommandRetentionInput {
  now: Date;
  retentionMs: number;
  cap?: number;
  batch?: number;
  /** Extra exemption probed per candidate at most once (the retained-envelope file probe, PR-C). */
  exempt?: (candidate: PrunableCommand) => boolean;
}

export interface CommandRetentionSelection {
  victims: PrunableCommand[];
  excess: number;
  /** Unique candidate rows read (keyset paging never re-reads a prefix). */
  visited: number;
  pages: number;
}

/** Today's `terminal.length`, bounded by `cap + batch` (the excess cannot exceed one batch per call). */
export function terminalCommandCount(
  store: EngineStore,
  cap = COMMAND_RETENTION_CAP,
  batch = COMMAND_RETENTION_BATCH,
): number {
  const row = store.prepare(COMMAND_TERMINAL_COUNT_SQL).get(cap + batch) as { n: number | bigint };
  return Number(row.n);
}

/**
 * Select at most one batch of victims: the oldest expired terminal commands of
 * the live generations, skipping needs-decision rows (outside the index) and
 * continuations whose predecessor is retained, paging by keyset so exempt rows
 * are visited once. The deletion transaction belongs to the owner (PR-C).
 */
export function commandRetentionCandidates(
  store: EngineStore,
  input: CommandRetentionInput,
): CommandRetentionSelection {
  const cap = input.cap ?? COMMAND_RETENTION_CAP;
  const batch = input.batch ?? COMMAND_RETENTION_BATCH;
  const excess = Math.max(0, terminalCommandCount(store, cap, batch) - cap);
  const selection: CommandRetentionSelection = { victims: [], excess, visited: 0, pages: 0 };
  if (excess === 0) return selection;
  const target = Math.min(excess, batch);
  const cutoff = new Date(input.now.getTime() - input.retentionMs).toISOString();
  const page = store.prepare(COMMAND_PRUNABLE_PAGE_SQL);
  const retained = store.prepare(RETAINED_PREDECESSOR_SQL);
  let after: [string, string] = ["", ""];
  while (selection.victims.length < target) {
    const rows = page.all(cutoff, after[0], after[1], batch) as Array<{
      id: string;
      run_id: string | null;
      run_dir: string | null;
      continue_from: string | null;
      created_at: string;
    }>;
    if (rows.length === 0) break;
    selection.pages += 1;
    for (const row of rows) {
      selection.visited += 1;
      const candidate: PrunableCommand = {
        id: row.id,
        runId: row.run_id,
        runDir: row.run_dir,
        continueFrom: row.continue_from,
        createdAt: row.created_at,
      };
      const predecessorRetained =
        candidate.continueFrom !== null &&
        Number((retained.get(candidate.continueFrom) as { retained: number | bigint }).retained) ===
          1;
      if (predecessorRetained || input.exempt?.(candidate)) continue;
      selection.victims.push(candidate);
      if (selection.victims.length >= target) break;
    }
    const last = rows[rows.length - 1]!;
    after = [last.created_at, last.id];
  }
  return selection;
}

/** `EXPLAIN QUERY PLAN` rows for a statement (plan gates, SYNTHESIS_R5 §5). */
export function queryPlan(store: EngineStore, sql: string): string[] {
  return (store.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map(
    (row) => row.detail,
  );
}
