import { RunEvent } from "@claudexor/schema";
import type { JournalRecord } from "./legacy-journal/frame-codec.js";
import type { JobRecord } from "../job-record.js";
import { parseMutation } from "../thread-store-support.js";
import { parseDecisionMutation } from "../operator-decisions.js";
import { deleteUnownedInlineInTx, INLINE_BODY_MAX_BYTES } from "./blob-files.js";
import {
  applyCommandInTx,
  commandRow,
  prepareCommandRow,
  type CommandRow,
} from "./command-rows.js";
import { applyCommandPruneInTx } from "./command-prune.js";
import { applyInteractionInTx } from "./interactions.js";
import { applyDecisionInTx } from "./operator-decisions.js";
import { applyProjectMutation } from "./projects.js";
import { applyThreadMutation } from "./thread-rows.js";
import { applyTerminalInTx } from "./run-events.js";
import { insertEventInTx } from "./retention.js";
import { bindIdempotencyInTx } from "./idempotency.js";
import { importSetupBindingInTx } from "./setup-bindings.js";
import { ImportContext, importError } from "./import-context.js";

const EVENT_ONLY = new Set([
  "quota.projection.updated",
  "quota.snapshot.scoped_prepared",
  "quota.snapshot.upserted",
  "quota.resources.invalidated",
  "quota.resources.observed",
  "quota.window.observed",
  "quota.window.superseded",
  "quota.subject.removed",
  "thread.head.updated",
  "setup.job.log",
  "journal.partition_quarantined",
]);

type Action = (pid: number, released: Set<string>) => void;

/** Bodies are prepared before BEGIN; the returned batch uses only pure row
 * reducers. Runtime append/owner notifications never run during import. */
export function prepareImportRecords(
  sql: ImportContext,
  records: readonly JournalRecord[],
): (pid: number) => void {
  const actions: Action[] = [];
  const commands = new Map<string, { record: JobRecord; row: CommandRow }>();
  const accepted = new Map<string, { target: string; request: string }>();
  const terminals = new Map<string, JournalRecord[]>();
  for (const record of records) {
    if (record.type !== "run.event") continue;
    const event = RunEvent.parse(record.payload);
    if (!["run.completed", "run.failed", "run.blocked"].includes(event.type)) continue;
    const group = terminals.get(event.run_id) ?? [];
    group.push(record);
    terminals.set(event.run_id, group);
  }
  for (const entry of records) {
    const payload = entry.payload as Record<string, unknown>;
    if (entry.type === "command.accepted" || entry.type === "command.updated") {
      const raw = payload.record as JobRecord;
      const previous = commands.get(raw.id);
      if (entry.type === "command.updated" && !previous)
        throw importError("store_import_projection_invalid", "command update precedes acceptance");
      const record = Object.hasOwn(raw, "params")
        ? raw
        : { ...raw, params: previous!.record.params };
      const prepared = prepareCommandRow(
        record,
        { pid: 0, live: false, operation: "legacy", clientId: null, previous: previous?.row },
        (bytes) => sql.body(bytes),
      );
      commands.set(raw.id, { record, row: prepared.row });
      if (entry.type === "command.accepted") {
        if (
          typeof payload.keyDigest !== "string" ||
          !payload.keyDigest ||
          typeof payload.requestDigest !== "string" ||
          !payload.requestDigest
        )
          throw importError("store_import_projection_invalid", "invalid command binding");
        const old = accepted.get(payload.keyDigest);
        if (old && (old.target !== raw.id || old.request !== payload.requestDigest))
          throw importError(
            "store_import_projection_invalid",
            "conflicting command idempotency history",
          );
        accepted.set(payload.keyDigest, { target: raw.id, request: payload.requestDigest });
      }
      actions.push((pid, released) => {
        if (previous?.row.result_sha) released.add(previous.row.result_sha);
        applyCommandInTx(
          sql,
          { ...prepared, row: { ...prepared.row, pid } },
          previous ? "update" : "accept",
        );
        if (entry.type === "command.accepted")
          bindIdempotencyInTx(sql, {
            owner: "command",
            pid,
            keyDigest: payload.keyDigest as string,
            requestDigest: payload.requestDigest as string,
            operation: "legacy",
            targetId: record.id,
            createdAt: record.createdAt,
          });
      });
    } else if (entry.type === "command.pruned") {
      if (!Array.isArray(payload.ids) || payload.ids.some((id) => typeof id !== "string"))
        throw importError("store_import_projection_invalid", "invalid command prune record");
      const ids = payload.ids as string[];
      for (const id of ids) commands.delete(id);
      for (const [key, binding] of accepted) if (ids.includes(binding.target)) accepted.delete(key);
      actions.push((pid, released) => {
        const rows = ids
          .map((id) => commandRow(sql, id, pid))
          .filter((row): row is CommandRow => row !== undefined);
        for (const sha of applyCommandPruneInTx(sql, rows)) released.add(sha);
        for (const root of Array.isArray(payload.roots) ? payload.roots : [])
          if (typeof root === "string" && root)
            sql.prepare("INSERT OR IGNORE INTO pruned_root(root) VALUES(?)").run(root);
      });
    } else if (entry.type === "thread.entities_upserted") {
      const mutation = parseMutation(entry.payload);
      const prompts = new Map(
        (mutation.turns ?? []).map((turn) => [turn.id, sql.body(Buffer.from(turn.prompt))]),
      );
      actions.push((pid, released) => {
        for (const sha of applyThreadMutation(sql, pid, { mutation, prompts }, entry.time))
          released.add(sha);
      });
    } else if (
      ["project.registered", "project.relinked", "project.unregistered"].includes(entry.type)
    ) {
      actions.push((pid) => {
        applyProjectMutation(
          sql,
          pid,
          entry.type as "project.registered" | "project.relinked" | "project.unregistered",
          entry.payload,
          entry.time,
        );
      });
    } else if (entry.type === "interaction.requested" || entry.type === "interaction.resolved") {
      actions.push((pid) =>
        applyInteractionInTx(
          sql,
          pid,
          entry.type as "interaction.requested" | "interaction.resolved",
          entry.payload,
        ),
      );
    } else if (entry.type === "operator.decision_recorded") {
      const mutation = parseDecisionMutation(entry.payload);
      actions.push((pid) => applyDecisionInTx(sql, pid, mutation));
    } else if (entry.type === "setup.job.saved" || entry.type === "setup.job.create_bound") {
      actions.push((pid) => importSetupBindingInTx(sql, pid, { ...entry, payload }));
    } else if (entry.type === "run.event") {
      const event = RunEvent.parse(entry.payload),
        group = terminals.get(event.run_id);
      if (group?.some((candidate) => candidate.seq === entry.seq)) {
        if (group.length === 1) actions.push((pid) => applyTerminalInTx(sql, pid, event));
        else actions.push((pid) => unclassified(sql, pid, entry, "duplicate_terminal"));
      }
    } else if (!EVENT_ONLY.has(entry.type)) {
      actions.push((pid) => unclassified(sql, pid, entry, "unknown_type"));
    }
    const bytes = Buffer.from(JSON.stringify(entry.payload ?? null));
    const body = bytes.length > INLINE_BODY_MAX_BYTES ? sql.body(bytes) : null;
    const encodedPayload = body ? Buffer.from("null") : bytes;
    actions.push((pid, released) => {
      const result = insertEventInTx(sql, pid, {
        ...entry,
        encodedPayload,
        payloadSha: body?.sha256,
      });
      if (result.stored && body)
        sql
          .prepare("INSERT OR IGNORE INTO blob(sha256,size,inline) VALUES(?,?,?)")
          .run(body.sha256, body.size, body.inline);
      for (const sha of result.releasedDigests) released.add(sha);
    });
  }
  // Duplicate evidence is never arbitrated into a first/last terminal authority.
  const duplicateRows = [...terminals]
    .filter(([, entries]) => entries.length > 1)
    .flatMap(([runId, entries]) =>
      [...commands.values()]
        .filter(({ record }) => record.runId === runId)
        .map(({ record, row }) =>
          prepareCommandRow(
            {
              ...record,
              state: "interrupted",
              error: `multiple durable terminal events for run ${runId}`,
              errorCode: "duplicate_terminal",
              errorStatus: 503,
              errorRetryable: false,
              finishedAt: record.finishedAt ?? entries[entries.length - 1]!.time,
              result: undefined,
            },
            { pid: 0, live: false, operation: "legacy", clientId: null, previous: row },
            (bytes) => sql.body(bytes),
          ),
        ),
    );
  return (pid) => {
    const released = new Set<string>();
    for (const action of actions) action(pid, released);
    for (const prepared of duplicateRows) {
      const old = commandRow(sql, prepared.row.id, pid);
      if (old?.result_sha) released.add(old.result_sha);
      applyCommandInTx(sql, { ...prepared, row: { ...prepared.row, pid } }, "update");
    }
    for (const sha of released) deleteUnownedInlineInTx(sql, sha);
  };
}

function unclassified(sql: ImportContext, pid: number, entry: JournalRecord, reason: string): void {
  sql
    .prepare("INSERT INTO unclassified(pid,seq,type,reason,payload) VALUES(?,?,?,?,?)")
    .run(pid, entry.seq, entry.type, reason, Buffer.from(JSON.stringify(entry.payload)));
}
