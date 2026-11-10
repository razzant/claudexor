import {
  isTerminalLifecycle,
  RunLifecycle,
  RecordedControlRunStartRequest,
} from "@claudexor/schema";
import { readContinuationSources } from "@claudexor/workspace";
import { setImmediate as yieldToAdmission } from "node:timers/promises";
import { BlobFiles } from "./blob-files.js";
import { retentionPages } from "./retention-pages.js";
import type { EngineStore } from "./store.js";
import type { DiskRetentionReferences } from "./retention-references.js";

// Read the immutable request, not the public summary (which omits retry/plan
// sources). Historical requests need not satisfy today's full run contract.
const Dependencies = RecordedControlRunStartRequest.pick({
  continueFrom: true,
  retryOf: true,
  planRef: true,
  planRunId: true,
}).strip();

/** Every retained command owns its explicit file dependencies, even before it
 * has a run ID. Reading every direct edge also retains the complete ancestor
 * chain, including terminal intermediates and archived generations. */
type CommandRow = {
  id: string;
  pid: number;
  kind: string;
  runId: string | null;
  runDir: string | null;
  state: string;
  finishedAt: string | null;
  continue_from: string | null;
  params_sha: string;
};
const COLUMNS =
  "id,pid,kind,run_id AS runId,run_dir AS runDir,state,finished_at AS finishedAt,continue_from,params_sha";
/** The only kinds `readRow` acts on (#638): model, maintenance and reset rows
 * own no run files, so the pass reads them only as a changed-owner refresh. */
const ACTED_COMMAND_KINDS = "kind IN ('product','delivery')";

export async function commandRetentionReferences(
  store: EngineStore,
  retained: (pid: number) => boolean,
  referencedRunIds = new Set<string>(),
  signal?: AbortSignal,
  /** Equivalence tests pass `null` to replay the unfiltered page order. */
  where: string | null = ACTED_COMMAND_KINDS,
) {
  const blobs = new BlobFiles(store);
  const paramsByDigest = new Map<string, ReturnType<typeof Dependencies.parse>>();
  const aliases = new Map<string, string>();
  const records: DiskRetentionReferences["records"] = [];
  const byRun = new Map<string, (typeof records)[number]>();
  const active = new Set<string>();
  const nativeRunDirs = new Set<string>();
  const nativeWatchRunDirs = new Set<string>();
  const uncertainNativeOwners = new Map<string, string>();
  const add = (id: string | null | undefined) => {
    if (!id) return;
    referencedRunIds.add(id);
    const runId = aliases.get(id);
    if (runId) referencedRunIds.add(runId);
  };
  const record = (row: CommandRow) => {
    if (row.runId === null) return;
    const next = { runId: row.runId, state: row.state, finishedAt: row.finishedAt ?? undefined };
    const previous = byRun.get(row.runId);
    if (previous) Object.assign(previous, next);
    else {
      records.push(next);
      byRun.set(row.runId, next);
    }
  };
  const readRow = (row: CommandRow, changed: boolean) => {
    if (!retained(row.pid)) {
      // Terminal timestamps can date old payloads without reading retired
      // requests or treating their abandoned work as an active owner.
      if (
        row.kind === "product" &&
        isTerminalLifecycle(row.state) &&
        row.runId &&
        !byRun.has(row.runId)
      )
        record(row);
      return;
    }
    // Delivery may read source files after awaits, including a repeated
    // apply. Historical delivery params do not reliably name the source.
    if (row.kind === "delivery" && !isTerminalLifecycle(row.state))
      throw new Error("disk retention kept while a delivery command is unsettled");
    if (row.kind !== "product") return;
    const terminal = isTerminalLifecycle(row.state);
    if (terminal) active.delete(row.id);
    else active.add(row.id);
    uncertainNativeOwners.delete(row.id);
    if (
      !RunLifecycle.safeParse(row.state).success ||
      (!terminal && !row.runDir && (row.state !== "queued" || row.runId))
    )
      uncertainNativeOwners.set(
        row.id,
        `native ownership unknown for command ${row.id} in partition ${row.pid}: ${row.state}, run directory ${row.runDir ?? "unbound"}`,
      );
    if (row.runDir) {
      nativeRunDirs.add(row.runDir);
      // Active producers can publish a capsule without another SQL write.
      // A changed producer may already have finished by the final recheck.
      if (!terminal || changed) nativeWatchRunDirs.add(row.runDir);
    }
    if (row.runDir)
      for (const source of readContinuationSources(row.runDir, { strict: true })) add(source.runId);
    let params = paramsByDigest.get(row.params_sha);
    if (!params) {
      params = Dependencies.parse(JSON.parse(blobs.read(row.params_sha).toString("utf8")));
      paramsByDigest.set(row.params_sha, params);
    }
    if ((params.continueFrom ?? null) !== row.continue_from)
      throw new Error(`command ${row.id} retention predecessor disagrees`);
    [row.continue_from, params.retryOf, params.planRef?.runId, params.planRunId].forEach(add);
    if (row.runId !== null) {
      aliases.set(row.id, row.runId);
      if (referencedRunIds.has(row.id)) add(row.runId);
      // The pass's lookup retains these objects, so final lifecycle/age checks
      // observe changes without rebuilding a map of the entire command store.
      record(row);
    }
  };
  const read = (row: CommandRow, changed = false) => {
    try {
      readRow(row, changed);
    } catch (error) {
      throw new Error(
        `retention command ${row.id} in partition ${row.pid}, params ${row.params_sha}: ${String(error)}`,
        { cause: error },
      );
    }
  };
  for await (const rows of retentionPages<CommandRow>(
    store,
    "command",
    COLUMNS,
    signal,
    where ?? undefined,
  )) {
    for (const row of rows) {
      await yieldToAdmission();
      signal?.throwIfAborted();
      read(row);
    }
  }
  for (const id of referencedRunIds) add(id);
  return {
    records,
    referencedRunIds,
    nativeRunDirs,
    nativeWatchRunDirs,
    nativeReferenceError: () => [...uncertainNativeOwners.values()].join("; ") || null,
    hasActiveCommands: () => active.size > 0,
    refresh(id: string) {
      const row = store.prepare(`SELECT ${COLUMNS} FROM command WHERE id=?`).get(id) as
        CommandRow | undefined;
      if (!row) return; // Releases are recognized on the next pass.
      // A newly bound run was absent from the pass's original lifecycle map.
      if (retained(row.pid) && row.kind === "product" && row.runId && !byRun.has(row.runId))
        add(row.runId);
      read(row, true);
    },
  };
}
