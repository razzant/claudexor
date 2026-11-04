/**
 * Composition of the daemon-owned retention service (W3.6): binds the
 * control-api retention pass to the daemon's live truth — the project
 * registry, thread lineage references, and journal-projected job records —
 * and schedules the bounded startup maintenance pass. `claudexor gc` and the
 * control route are thin callers of the runner built here. The same pass
 * purges expired trash (a trashed thread past `purge_after`) through the one
 * thread purge owner, so trash cannot outlive its restore window forever, and
 * through the same owner finishes every purge whose directory cleanup failed
 * after the purge was journaled.
 */
import type { ProjectThreadPort, ProjectStorePort } from "@claudexor/daemon";
import type { ControlGcReceipt, ControlGcRequest, Thread } from "@claudexor/schema";
import { findActiveThreadRun, runRetentionPass } from "@claudexor/control-api";
import { loadConfig } from "@claudexor/config";
import { dirname } from "node:path";
import {
  claudexorOwnedRoot,
  noProjectRepoRoot,
  projectRuntimeDir,
  userConfigDir,
} from "@claudexor/util";
import { sweepOrphanLanes } from "@claudexor/workspace";
import type { NativeRetentionRequest, NativeRetentionResult } from "./native-home-retention.js";
import { retentionProjects } from "./retention-projects.js";
import { setImmediate as yieldToAdmission } from "node:timers/promises";
import {
  serializeRetention,
  withoutRetentionInventory,
  type RetentionRunner,
} from "./retention-lifetime.js";
export type { RetentionRunner } from "./retention-lifetime.js";
export { scheduleStartupRetention } from "./retention-schedule.js";

export interface RetentionRunnerDeps {
  projects: () => ProjectStorePort;
  maxDeletionsPerPass?: number;
  nativeHomes?: (request: NativeRetentionRequest) => Promise<NativeRetentionResult>;
  threads: ProjectThreadPort;
  daemonJobs: () =>
    | Array<{ runId?: string; state: string; finishedAt?: string; params?: unknown }>
    | Promise<Array<{ runId?: string; state: string; finishedAt?: string; params?: unknown }>>;
  /** The ONE thread purge owner (thread-purge.ts): journals the purge, then
   * deletes the isolated worktree/branch and every lane home of the thread.
   * `signal` is the pass's own cancellation: it ends a retirement's lane
   * verification, and that cleanup then stays pending for the next pass. */
  purgeThread: (id: string, signal?: AbortSignal) => Promise<unknown>;
  /** Whether a directory that owner deletes is still on disk for the thread. */
  hasPurgeLeftovers: (thread: Thread) => boolean;
}

/** Trashed threads whose restore window (`purge_after`) has ended. */
function expiredTrashThreads(threads: readonly Thread[], now: number): Thread[] {
  return threads.filter(
    (thread) =>
      thread.state === "trashed" &&
      thread.purge_after !== null &&
      Date.parse(thread.purge_after) <= now,
  );
}

/**
 * Finish purges whose directory cleanup failed after the journal commit: a
 * purged thread is hidden from every listing, so without this pass its
 * isolated worktree (and any lane home) would stay on disk forever. The owner
 * journals nothing new for an already purged thread and deletes what is left;
 * a cleanup that fails again is disclosed and retried by the next pass. The
 * thread is never made restorable again. Dry-run only lists them.
 */
async function finishPurgeLeftovers(
  deps: RetentionRunnerDeps,
  threads: readonly Thread[],
  dryRun: boolean,
  signal?: AbortSignal,
): Promise<{ finished: string[]; errors: string[] }> {
  const finished: string[] = [];
  const errors: string[] = [];
  for (const thread of threads.filter((thread) => thread.state === "purged")) {
    if (signal?.aborted) break;
    if (!deps.hasPurgeLeftovers(thread)) continue;
    try {
      if (!dryRun) await deps.purgeThread(thread.id, signal);
      finished.push(thread.id);
    } catch (error) {
      errors.push(
        `purged thread ${thread.id} cleanup: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { finished, errors };
}

/**
 * Purge expired trash through the one purge owner. A thread with a queued or
 * running turn is kept for a later pass (the purge route answers 409
 * `thread_busy` for the same reason); dry-run only lists what it would purge.
 * A purge that fails after its journal commit is finished by the NEXT pass's
 * `finishPurgeLeftovers` (this pass only discloses the error).
 */
async function purgeExpiredTrash(
  deps: RetentionRunnerDeps,
  threads: readonly Thread[],
  dryRun: boolean,
  signal?: AbortSignal,
): Promise<{ purged: string[]; errors: string[] }> {
  const purged: string[] = [];
  const errors: string[] = [];
  for (const thread of expiredTrashThreads(threads, Date.now())) {
    if (signal?.aborted) break;
    const jobs = await deps.daemonJobs();
    // The inventory yielded: a thread may have been restored while its old
    // trash deadline passed. Judge current state immediately before purge.
    const current = deps.threads.getThread(thread.id);
    if (!current || expiredTrashThreads([current], Date.now()).length === 0) continue;
    const active = findActiveThreadRun(jobs, thread.id);
    if (active) {
      errors.push(`expired trash thread ${thread.id} kept: a turn is still ${active.state}`);
      continue;
    }
    try {
      if (!dryRun) await deps.purgeThread(thread.id, signal);
      purged.push(thread.id);
    } catch (error) {
      errors.push(
        `expired trash thread ${thread.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { purged, errors };
}

export function createRetentionRunner(deps: RetentionRunnerDeps): RetentionRunner {
  const noProjectRoot = noProjectRepoRoot();
  // Serialize passes (review sol #7): the startup pass and any concurrent
  // `claudexor gc` / control-op invocation must not interleave rmSync +
  // tombstone writes on the same candidates, which would double-count
  // freed_bytes and cross-report deletions between receipts.
  let lastReceipt: ControlGcReceipt | null = null;
  const truncatedReceipts = new WeakSet<ControlGcReceipt>();
  const runOnce = async (
    request: ControlGcRequest,
    signal: AbortSignal,
  ): Promise<ControlGcReceipt> => {
    // Policy is read fresh per pass (configurable without restart); the
    // reference set spans EVERY non-purged thread's full run lineage.
    let morePending = false;
    const retention = loadConfig(noProjectRoot).global.retention;
    let leftovers = { finished: [] as string[], errors: [] as string[] };
    let trash = { purged: [] as string[], errors: [] as string[] };
    try {
      signal.throwIfAborted();
      const maintenanceThreads = await deps.threads.retentionThreads(signal);
      // Purges left unfinished by an earlier failure, then expired trash, both
      // FIRST, so the runs only expired trash referenced become ordinary
      // unreferenced candidates of this same pass. A dry run purges nothing, so
      // its reference set skips the would-be-purged threads to preview the same.
      leftovers = await finishPurgeLeftovers(deps, maintenanceThreads, request.dry_run, signal);
      trash = await purgeExpiredTrash(deps, maintenanceThreads, request.dry_run, signal);
      const previewPurged = new Set(request.dry_run ? trash.purged : []);
      const references = await deps.threads.retentionReferences(previewPurged, signal);
      try {
        const healthyRoots = new Set(references.blocked ? [] : deps.threads.healthyProjectRoots());
        const inventoryErrors: string[] = [];
        const inventoryHolds: ControlGcReceipt["holds"] = [];
        const laneHold = (example: string) =>
          inventoryHolds.push({ class: "cleanup_suppressed", count: 1, example });
        const heldRoots = new Set(references.protectedProjectRoots);
        const changedRoots = new Set<string>();
        const projectHeld = (project: { root: string; runsDir: string }) => {
          for (const root of references.heldProjectRoots ?? []) {
            if (project.root !== root && dirname(project.runsDir) !== projectRuntimeDir(root))
              continue;
            heldRoots.add(project.root);
            if (!changedRoots.has(project.root)) {
              changedRoots.add(project.root);
              inventoryHolds.push({
                class: "references_changed",
                count: 1,
                example: `project registration changed: ${root}; namespace kept until next pass`,
              });
            }
            return true;
          }
          if (!references.protectedProjectRoots.has(project.root)) return false;
          heldRoots.add(project.root);
          return true;
        };
        const gcProjects = await retentionProjects(
          references,
          noProjectRoot,
          healthyRoots,
          inventoryErrors,
          signal,
          heldRoots,
        );
        // The namespace inventory finds the last orphan even after its root's
        // last thread is purged. Archived/quarantined registrations keep lanes;
        // healthy and unregistered namespaces use the shared live ownership proof.
        if (!request.dry_run && !references.blocked) {
          const laneProofCurrent = references.recheck ?? references.isCurrent;
          const deferred =
            "lane sweep deferred: ownership changed; a fresh retention pass must resume";
          if (!laneProofCurrent()) {
            inventoryErrors.push(deferred);
            laneHold(deferred);
          } else
            for (const project of gcProjects) {
              const { root } = project;
              const runtime = dirname(project.runsDir);
              if (!healthyRoots.has(root) && references.registeredProjectRoots.has(root)) continue;
              await yieldToAdmission();
              if (signal.aborted) break;
              try {
                const ids =
                  references.laneThreadIds?.(root, runtime) ??
                  new Set(
                    deps.threads
                      .listThreads()
                      .filter(
                        (thread) =>
                          thread.state !== "purged" &&
                          projectRuntimeDir(thread.repo?.root ?? noProjectRoot) === runtime,
                      )
                      .map((thread) => thread.id),
                  );
                // No yield between the live read and the synchronous sweep.
                if (
                  projectHeld(project) ||
                  [...(references.protectedLaneRoots ?? [])].some(
                    (held) => projectRuntimeDir(held) === runtime,
                  )
                )
                  continue;
                sweepOrphanLanes(runtime, ids);
              } catch (error) {
                if (!laneProofCurrent()) {
                  inventoryErrors.push(deferred);
                  laneHold(`${deferred}: ${String(error)}`);
                  break;
                }
                const detail = `lane sweep skipped for ${root}: ${String(error)}`;
                inventoryErrors.push(detail);
                laneHold(detail);
              }
            }
        }
        const receipt = await runRetentionPass(
          {
            runsMaxAgeDays: retention.runs_max_age_days,
            reviewsMaxAgeDays: retention.reviews_max_age_days,
            keepLastRunsPerProject: retention.keep_last_runs_per_project,
          },
          request,
          {
            signal,
            anchorsHeld: !!references.blocked || heldRoots.size > 0,
            projects: () => gcProjects,
            records: () => references.records,
            referencedRunIds: () => references.referencedRunIds,
            referencesCurrent: references.recheck ?? references.isCurrent,
            refreshReferences: references.refresh,
            projectHeld,
            maxDeletionsPerPass: deps.maxDeletionsPerPass,
            onTruncated: () => {
              morePending = true;
            },
            // Advisory data-root disclosure: the ONE owned-root derivation
            // (claudexorOwnedRoot covers both the default ~/.claudexor tree and
            // an explicit CLAUDEXOR_CONFIG_DIR override) is injected here so the
            // pass itself never reaches for globals. The mode rides along:
            // claudexorOwnedRoot() collapses onto userConfigDir() exactly when a
            // CLAUDEXOR_CONFIG_DIR override is active (in the default mode the
            // owned root is ~/.claudexor while the config dir is its v3 subtree),
            // and the override root owns secrets.json/plugins/quota/workspaces at
            // its top level where the default root does not.
            dataRoot: claudexorOwnedRoot(),
            dataRootMode: claudexorOwnedRoot() === userConfigDir() ? "override" : "default",
          },
        );
        receipt.held.roots = heldRoots.size;
        const reportedGenerationHolds = references.holds?.length ?? 0;
        receipt.holds.push(...(references.holds ?? []), ...inventoryHolds);
        const unclassified = [...heldRoots].filter(
          (root) => !references.protectedProjectRoots.has(root) && !changedRoots.has(root),
        );
        if (unclassified.length && !references.blocked)
          receipt.holds.push({
            class: "namespace_unreadable",
            count: unclassified.length,
            example: unclassified[0]!,
          });
        const native = await deps.nativeHomes?.({
          signal,
          references,
          dryRun: request.dry_run,
          olderThan: Date.now() - retention.runs_max_age_days * 24 * 60 * 60_000,
          ignoredRunIds: new Set(
            request.dry_run ? receipt.deleted_runs.map((run) => run.run_id) : [],
          ),
          ignoredThreadIds: previewPurged,
        });
        if (native) {
          receipt.freed_bytes += native.freedBytes;
          receipt.errors.push(...native.errors);
          morePending ||= native.truncated;
          receipt.holds.push(...(native.holds ?? []));
          receipt.held.native_homes = native.heldHomes ?? 0;
          if (request.native_home_report) receipt.native_homes = native.reports;
        }
        receipt.holds.push(...(references.holds?.slice(reportedGenerationHolds) ?? []));
        receipt.errors.unshift(
          ...leftovers.errors,
          ...trash.errors,
          ...(references.errors ?? []),
          ...inventoryErrors,
        );
        if (request.trash_purge_report) {
          receipt.purged_threads = trash.purged;
          receipt.purge_leftovers = leftovers.finished;
        }
        receipt.truncated ||= morePending;
        receipt.finished_at = new Date().toISOString();
        if (morePending) truncatedReceipts.add(receipt);
        lastReceipt = receipt;
        return receipt;
      } finally {
        references.close?.();
      }
    } catch (error) {
      if (!signal.aborted) throw error;
      // Cancellation during inventory has not retired any run. Preserve any
      // completed thread purges and use the same typed resumable receipt.
      const receipt = await runRetentionPass(
        {
          runsMaxAgeDays: retention.runs_max_age_days,
          reviewsMaxAgeDays: retention.reviews_max_age_days,
          keepLastRunsPerProject: retention.keep_last_runs_per_project,
        },
        request,
        { signal, projects: () => [], records: () => [], referencedRunIds: () => new Set() },
      );
      receipt.errors.unshift(...leftovers.errors, ...trash.errors);
      if (request.trash_purge_report) {
        receipt.purged_threads = trash.purged;
        receipt.purge_leftovers = leftovers.finished;
      }
      truncatedReceipts.add(receipt);
      lastReceipt = receipt;
      return withoutRetentionInventory(receipt);
    }
  };
  const run = serializeRetention(runOnce);
  run.hasMore = (receipt = lastReceipt ?? undefined) =>
    receipt !== undefined && truncatedReceipts.has(receipt);
  return run;
}
