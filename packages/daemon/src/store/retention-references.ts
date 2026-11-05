import { Thread, type GcHold } from "@claudexor/schema";
import { setImmediate as yieldToAdmission } from "node:timers/promises";
import { access } from "node:fs/promises";
import { projectRuntimeDir } from "@claudexor/util";
import type { EngineStore } from "./store.js";
import { decodeBody } from "./thread-rows.js";
import { isServedPid } from "./generations.js";
import { retentionPages } from "./retention-pages.js";
import { retentionChanges } from "./retention-changes.js";
import { RetentionReferenceReader } from "./retention-reference-reader.js";
import { commandRetentionReferences } from "./retention-command-references.js";
import { retentionGenerations } from "./retention-generations.js";
import { deferredRetentionReferences } from "./deferred-retention.js";

export interface DiskRetentionReferences {
  /** Legacy exact inventory witness; current retirement rechecks changed owners. */
  isCurrent: () => boolean;
  /** Cooperatively absorb changed owners, then synchronously recheck before expiry. */
  refresh?: () => Promise<void>;
  recheck?: () => boolean;
  /** Native callers absorb the same changed owners before per-file rechecks. */
  nativeCurrent?: () => boolean;
  /** Pass-local ownership, refreshed synchronously at each lane sweep boundary. */
  laneThreadIds?: (root: string) => Set<string>;
  nativeRunDirs?: ReadonlySet<string>;
  nativeWatchRunDirs?: ReadonlySet<string>;
  nativeReferenceError?: () => string | null;
  hasActiveCommands?: () => boolean;
  /** Runtime namespaces whose registration (root, status, generation) changed during
   * the pass: their keep-last and ownership are unknown until a fresh pass (#503). */
  deferredRuntimes?: () => ReadonlySet<string>;
  /** Caller releases the observation after all deletions, including error paths. */
  close?: () => void;
  /** Recovery holds are receipt facts; completed quarantine is not a hold. */
  blocked?: string;
  errors?: string[];
  holds?: GcHold[];
  projectRoots: string[];
  /** Retained active/archived registrations; thread root names alone are not ownership. */
  registeredProjectRoots: Set<string>;
  /** Archived-only registrations need an extant root to own recent history. */
  archivedProjectRoots?: Set<string>;
  protectedProjectRoots: Set<string>;
  referencedRunIds: Set<string>;
  nativeSessions: Map<string, Set<string>>;
  records: Array<{ runId: string; state: string; finishedAt?: string }>;
}

/** Maintenance's served thread listing, including unfinished purges. Unlike
 * public synchronous listing it does not stat every registered project root. */
export async function diskRetentionThreads(
  store: EngineStore,
  signal?: AbortSignal,
): Promise<Thread[]> {
  const result: Thread[] = [];
  const served = new Map<number, boolean>();
  const roots = new Map(
    (
      store
        .prepare(
          `SELECT current_pid AS pid,root FROM project WHERE status='active'
       AND pid=CAST((SELECT value FROM meta WHERE key='global_pid') AS INTEGER)`,
        )
        .all() as Array<{ pid: number; root: string }>
    ).map((row) => [row.pid, row.root]),
  );
  for await (const rows of retentionPages<{ id: string; pid: number; body: Uint8Array }>(
    store,
    "thread",
    "id,pid,body",
    signal,
  )) {
    for (const row of rows) {
      await yieldToAdmission();
      signal?.throwIfAborted();
      if (!served.has(row.pid)) served.set(row.pid, isServedPid(store, row.pid));
      if (!served.get(row.pid)) continue;
      let thread: Thread;
      try {
        thread = Thread.parse(decodeBody(row));
      } catch (error) {
        throw new Error(`retention thread ${row.id} in partition ${row.pid}: ${String(error)}`, {
          cause: error,
        });
      }
      const root = roots.get(row.pid);
      if (
        thread.state !== "purged" &&
        root &&
        !(await access(root).then(
          () => true,
          () => false,
        ))
      )
        continue;
      result.push(thread);
    }
  }
  return result;
}

/** Retirement reads all retained generations, including archived projects. Public
 * listing/admission remains served-generation-only. Any unreadable reference throws. */
export async function diskRetentionReferences(
  store: EngineStore,
  ignoreThreadIds: ReadonlySet<string> = new Set(),
  signal?: AbortSignal,
): Promise<DiskRetentionReferences> {
  const changesObserved = retentionChanges(store);
  try {
    // Keep the legacy exact witness for callers without incremental rechecks.
    // Run/native proofs reread changed owners; lane sweeping reads live IDs.
    // No cursor survives a yield.
    const changes = store.prepare("SELECT total_changes() AS n");
    const version = (changes.get() as { n: number }).n;
    const isCurrent = () => (changes.get() as { n: number }).n === version;
    const generations = retentionGenerations(store);
    // The observer retains every spelling through queued relinks and deletion.
    const deferred = new Set<string>();
    const runtimeByRoot = new Map<string, string>();
    const deferRoots = (changedRoots: ReadonlySet<string>) => {
      for (const root of changedRoots) {
        let runtime = runtimeByRoot.get(root);
        if (!runtime) {
          runtime = projectRuntimeDir(root);
          runtimeByRoot.set(root, runtime);
        }
        deferred.add(runtime);
      }
    };
    const { registeredProjectRoots, archivedProjectRoots, protectedProjectRoots, errors, blocked } =
      generations;
    const roots = new Set([...registeredProjectRoots, ...protectedProjectRoots]);
    const retained = blocked ? () => false : generations.retained;
    const reader = new RetentionReferenceReader(store, ignoreThreadIds, retained);
    reader.addQuarantinedLaneThreadIds();
    for await (const rows of retentionPages<{
      id: string;
      pid: number;
      state: string;
      body: Uint8Array;
    }>(store, "thread", "id,pid,state,body", signal)) {
      for (const row of rows) {
        await yieldToAdmission();
        signal?.throwIfAborted();
        const thread = reader.thread(row);
        if (!thread) continue;
        for (const sessionRow of store
          .prepare("SELECT id,pid,thread_id,harness_id,body FROM session WHERE thread_id=?")
          .all(thread.id) as Array<{
          id: string;
          pid: number;
          thread_id: string;
          harness_id: string;
          body: Uint8Array;
        }>)
          reader.session(sessionRow, thread);
        for (const turnRow of store
          .prepare("SELECT id,pid,thread_id,body FROM turn WHERE thread_id=?")
          .all(thread.id) as Array<{
          id: string;
          pid: number;
          thread_id: string;
          body: Uint8Array;
        }>) {
          await yieldToAdmission();
          signal?.throwIfAborted();
          reader.turn(turnRow, thread);
        }
      }
    }
    for (const row of store
      .prepare("SELECT pid,run_id FROM interaction WHERE state='pending'")
      .all() as Array<{ pid: number; run_id: string }>)
      if (retained(row.pid)) reader.add(row.run_id);
    const refreshDraft = await deferredRetentionReferences(
      store,
      retained,
      (id) => reader.add(id),
      signal,
    );
    const commands = await commandRetentionReferences(store, retained, reader.runs, signal);
    const readChange = ({
      table,
      id,
      roots: changedRoots,
    }: Parameters<Parameters<typeof changesObserved.current>[0]>[0]) => {
      if (table === "command") commands.refresh(id);
      else if (table === "deferred_message") refreshDraft(id);
      else if (table === "blob") {
        const owner = store
          .prepare(
            "SELECT c.id,c.pid FROM command c JOIN partition q ON q.id=c.pid WHERE params_sha=? AND q.status IN ('ready','archived') LIMIT 1",
          )
          .get(id) as { id: string; pid: number } | undefined;
        if (owner)
          throw new Error(
            `immutable retention command ${owner.id} in partition ${owner.pid}: params blob ${id} changed during inventory`,
          );
      } else if (table === "project") {
        deferRoots(changedRoots);
        generations.refreshProject(id);
      } else if (table === "partition") {
        const reason = generations.changed(Number(id));
        if (reason) changesObserved.hold(reason);
        reader.addQuarantinedLaneThreadIds(Number(id));
      } else reader.refresh(table, id);
    };
    const recheck = () => changesObserved.current(readChange) && !generations.blocked;
    const refresh = () => changesObserved.refresh(readChange, signal);
    await refresh();
    for (const root of reader.roots) roots.add(root);
    return {
      isCurrent,
      refresh,
      recheck,
      nativeCurrent: recheck,
      laneThreadIds: () => {
        if (!recheck())
          throw new Error("lane ownership changed; a fresh retention pass must resume");
        return reader.laneThreadIds;
      },
      nativeRunDirs: commands.nativeRunDirs,
      nativeWatchRunDirs: commands.nativeWatchRunDirs,
      nativeReferenceError: commands.nativeReferenceError,
      hasActiveCommands: commands.hasActiveCommands,
      deferredRuntimes: () => deferred,
      close: changesObserved.close,
      get blocked() {
        return generations.blocked;
      },
      errors,
      holds: generations.holds,
      projectRoots: [...roots],
      registeredProjectRoots,
      archivedProjectRoots,
      protectedProjectRoots,
      referencedRunIds: reader.runs,
      records: commands.records,
      nativeSessions: reader.sessions,
    };
  } catch (error) {
    changesObserved.close();
    throw error;
  }
}
