import { continuedRunOf, delegatedParentOf, HarnessMaintenanceEvidence } from "@claudexor/schema";
import { compactCommandRecord } from "../command-list-projection.js";
import { isNeedsDecision } from "../command-retention.js";
import { validateCommandRecord } from "../command-store.js";
import type { JobRecord } from "../job-record.js";
import { BlobFiles, type BodyRef } from "./blob-files.js";
import { requireTransaction, type SqlWriteContext } from "./mutation.js";
import { commandKind, type CommandKind } from "./retention.js";

export type CommandRow = {
  id: string;
  pid: number;
  operation: string;
  client_id: string | null;
  state: JobRecord["state"];
  run_id: string | null;
  task_id: string | null;
  run_dir: string | null;
  thread_id: string | null;
  turn_id: string | null;
  delegated_from: string | null;
  continue_from: string | null;
  scope_root: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  summary: Uint8Array;
  params_sha: string;
  result_sha: string | null;
  error: Uint8Array | null;
  kind: CommandKind;
  live: number;
  needs_decision: number;
  response_state: string | null;
  response_expires_at: string | null;
  request_resource_id: string | null;
  response_resource_id: string | null;
};

export interface PreparedCommandRow {
  row: CommandRow;
  params: BodyRef | null;
  result: BodyRef | null;
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const encoded = (value: unknown): Buffer => Buffer.from(JSON.stringify(value ?? null));

export type MaintenanceCommandSummary = Pick<
  JobRecord,
  "id" | "state" | "createdAt" | "startedAt" | "finishedAt"
> & {
  harness: string;
  evidence:
    | (Pick<HarnessMaintenanceEvidence, "phase" | "target" | "mutation"> & {
        before: Pick<
          NonNullable<HarnessMaintenanceEvidence["before"]>,
          "version" | "proved"
        > | null;
      })
    | null;
};

/** Inventory and previous-version selection need only these receipt facts.
 * Full detail keeps the original body; partial evidence is never parsed as a
 * complete HarnessMaintenanceEvidence. The legacy read adapter can reuse this. */
export function maintenanceCommandSummary(record: JobRecord): MaintenanceCommandSummary | null {
  const params = object(record.params);
  if (params.kind !== "harness_maintenance" || typeof params.harness !== "string") return null;
  const { lifecycle: _lifecycle, ...result } = object(record.result);
  const parsed = HarnessMaintenanceEvidence.safeParse(result);
  const evidence = parsed.success ? parsed.data : null;
  return {
    id: record.id,
    state: record.state,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    harness: params.harness,
    evidence: evidence
      ? {
          phase: evidence.phase,
          target: evidence.target,
          mutation: evidence.mutation,
          before: evidence.before
            ? { version: evidence.before.version, proved: evidence.before.proved }
            : null,
        }
      : null,
  };
}

/** One mapper for accept, update, terminal, import and recovery. Indexed facts
 * are derived here; immutable params/kind/acceptance metadata can be reused. */
export function prepareCommandRow(
  record: JobRecord,
  input: {
    pid: number;
    live: boolean;
    operation: string;
    clientId: string | null;
    previous?: CommandRow;
  },
  prepareBody: (bytes: Uint8Array) => BodyRef,
): PreparedCommandRow {
  validateCommandRecord(record);
  const params = object(record.params);
  const kind = input.previous?.kind ?? commandKind(record.id, record.params);
  const summary = compactCommandRecord(record);
  summary.params = Object.fromEntries(
    Object.keys(object(summary.params)).map((key) => [key, params[key]]),
  );
  // Internal scheduling needs the command family; product collections already
  // exclude these rows, so no model request or account binding crosses them.
  if (kind !== "product") summary.params = { ...object(summary.params), kind: params.kind };
  if (kind === "maintenance") {
    const maintenance = maintenanceCommandSummary(record);
    summary.params = { ...object(summary.params), harness: maintenance?.harness ?? null };
    summary.result = maintenance?.evidence ?? null;
  }
  const error = Object.fromEntries(
    Object.entries(record).filter(([key]) => key.startsWith("error")),
  );
  const result = record.result === undefined ? null : prepareBody(encoded(record.result));
  const body = input.previous ? null : prepareBody(encoded(record.params));
  const response = kind === "model" ? object(object(record.result).response) : {};
  return {
    params: body,
    result,
    row: {
      id: record.id,
      pid: input.pid,
      operation: input.previous?.operation ?? input.operation,
      client_id: input.previous?.client_id ?? input.clientId,
      state: record.state,
      run_id: record.runId ?? null,
      task_id: record.taskId ?? null,
      run_dir: record.runDir ?? null,
      thread_id: text(params.threadId),
      turn_id: text(params.turnId),
      delegated_from: delegatedParentOf(record.params),
      continue_from: continuedRunOf(record.params),
      scope_root: object(params.scope).kind === "project" ? text(object(params.scope).root) : null,
      created_at: record.createdAt,
      started_at: record.startedAt ?? null,
      finished_at: record.finishedAt ?? null,
      summary: encoded(summary),
      params_sha: input.previous?.params_sha ?? body!.sha256,
      result_sha: result?.sha256 ?? null,
      error: Object.keys(error).length ? encoded(error) : null,
      kind,
      live: input.live ? 1 : 0,
      needs_decision: isNeedsDecision(record) ? 1 : 0,
      response_state: text(response.state),
      response_expires_at: text(response.expiresAt),
      request_resource_id: kind === "model" ? text(object(params.request).resourceId) : null,
      response_resource_id: text(object(response.ref).resourceId),
    },
  };
}

/** Pure row reducer. Body refs have already been prepared by the runtime or
 * importer; no files, transaction ownership or live callbacks occur here. */
export function applyCommandInTx(
  sql: SqlWriteContext,
  prepared: PreparedCommandRow,
  mode: "accept" | "update",
): void {
  requireTransaction(sql);
  for (const body of [prepared.params, prepared.result]) {
    if (body)
      sql
        .prepare("INSERT OR IGNORE INTO blob(sha256,size,inline) VALUES(?,?,?)")
        .run(body.sha256, body.size, body.inline);
  }
  const row = prepared.row;
  const columns = Object.keys(row) as Array<keyof CommandRow>;
  if (mode === "accept") {
    sql
      .prepare(
        `INSERT INTO command(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
      )
      .run(...columns.map((key) => row[key]));
  } else {
    const mutable = columns.filter(
      (key) => !["id", "pid", "params_sha", "kind", "operation", "client_id"].includes(key),
    );
    const result = sql
      .prepare(
        `UPDATE command SET ${mutable.map((key) => `${key} = ?`).join(",")} WHERE id = ? AND pid = ?`,
      )
      .run(...mutable.map((key) => row[key]), row.id, row.pid);
    if (Number(result.changes) !== 1) throw new Error(`no such job: ${row.id}`);
  }
}

export function commandRow(
  sql: Pick<SqlWriteContext, "prepare">,
  id: string,
  pid?: number,
): CommandRow | undefined {
  return sql
    .prepare(`SELECT * FROM command WHERE id = ?${pid === undefined ? "" : " AND pid = ?"}`)
    .get(...(pid === undefined ? [id] : [id, pid])) as CommandRow | undefined;
}

export function commandSummary(row: Pick<CommandRow, "summary">): JobRecord {
  return JSON.parse(Buffer.from(row.summary).toString("utf8")) as JobRecord;
}

/** Full bodies are hydrated only for an addressed detail, retry or mutation. */
export function hydrateCommand(row: CommandRow, blobs: Pick<BlobFiles, "read">): JobRecord {
  const {
    promptPreview: _preview,
    result: _summaryResult,
    ...metadata
  } = commandSummary(row) as JobRecord & {
    promptPreview?: string;
  };
  const record: JobRecord = metadata;
  record.params = JSON.parse(blobs.read(row.params_sha).toString("utf8")) as unknown;
  if (row.result_sha !== null)
    record.result = JSON.parse(blobs.read(row.result_sha).toString("utf8")) as unknown;
  if (row.error !== null)
    Object.assign(record, JSON.parse(Buffer.from(row.error).toString("utf8")) as unknown);
  return record;
}
