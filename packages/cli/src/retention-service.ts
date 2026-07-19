/**
 * Composition of the daemon-owned retention service (W3.6): binds the
 * control-api retention pass to the daemon's live truth — the project
 * registry, thread lineage references, and journal-projected job records —
 * and schedules the bounded startup maintenance pass. `claudexor gc` and the
 * control route are thin callers of the runner built here.
 */
import { join } from "node:path";
import type { ProjectPartitions, ProjectStore } from "@claudexor/daemon";
import type { ControlGcReceipt, ControlGcRequest } from "@claudexor/schema";
import { ArtifactStore } from "@claudexor/artifact-store";
import { runRetentionPass, type RetentionProject } from "@claudexor/control-api";
import { loadConfig } from "@claudexor/config";
import { noProjectRepoRoot } from "@claudexor/util";
import { sweepOrphanLanes } from "@claudexor/workspace";
import { logLine } from "./daemon-lifecycle.js";

export interface RetentionRunnerDeps {
  projects: () => ProjectStore;
  threads: ProjectPartitions;
  daemonJobs: () => Promise<Array<{ runId?: string; state: string; finishedAt?: string }>>;
}

export type RetentionRunner = (request: ControlGcRequest) => Promise<ControlGcReceipt>;

export function createRetentionRunner(deps: RetentionRunnerDeps): RetentionRunner {
  const noProjectRoot = noProjectRepoRoot();
  // Serialize passes (review sol #7): the startup pass and any concurrent
  // `claudexor gc` / control-op invocation must not interleave rmSync +
  // tombstone writes on the same candidates, which would double-count
  // freed_bytes and cross-report deletions between receipts.
  let inFlight: Promise<ControlGcReceipt> | null = null;
  const runOnce = async (request: ControlGcRequest): Promise<ControlGcReceipt> => {
    // Policy is read fresh per pass (configurable without restart); the
    // reference set spans EVERY non-purged thread's full run lineage.
    const retention = loadConfig(noProjectRoot).global.retention;
    const jobs = await deps.daemonJobs();
    const records = jobs
      .filter((job): job is { runId: string; state: string; finishedAt?: string } =>
        Boolean(job.runId),
      )
      .map((job) => ({ runId: job.runId, state: job.state, finishedAt: job.finishedAt }));
    const referencedRunIds = (): Set<string> => {
      const referenced = new Set<string>();
      for (const thread of deps.threads.listThreads()) {
        for (const id of thread.run_ids) referenced.add(id);
        if (thread.head_run_id) referenced.add(thread.head_run_id);
        for (const turn of deps.threads.turnsFor(thread.id)) {
          for (const id of [turn.run_id, turn.parent_run_id, turn.plan_run_id]) {
            if (id) referenced.add(id);
          }
        }
      }
      return referenced;
    };
    // Fail CLOSED on a quarantined partition (review sol #6/#7): the
    // reference set (listThreads/turnsFor) and job records both come ONLY
    // from ready partitions. A project whose partition journal is not ready
    // contributes an EMPTY reference set — GC'ing its runs against that would
    // delete runs a live thread still references. So GC only project roots
    // whose partition is ready; a quarantined project's runs are protected
    // until it recovers. The no-project root has no partition and is always
    // eligible.
    const healthyRoots = new Set(deps.threads.healthyProjectRoots());
    const roots = [
      ...new Set([
        ...deps
          .projects()
          .list()
          .map((p) => p.root)
          .filter((root) => healthyRoots.has(root)),
        noProjectRoot,
      ]),
    ];
    const gcProjects: RetentionProject[] = roots.map((root) => ({
      root,
      runsDir: new ArtifactStore(root).runsDir(),
      // Standalone diff-review debris lives in the user's repo; the
      // no-project root has none.
      reviewsDir: root === noProjectRoot ? null : join(root, ".claudexor", "reviews"),
    }));
    // INV-034 lifecycle owner (c): remove durable per-lane read-only homes whose
    // thread no longer exists. Bounded to HEALTHY roots only (same fail-closed
    // set as the run GC): a quarantined partition contributes no live thread
    // ids, so its lanes are left untouched until it recovers rather than swept
    // as false orphans. Skip in dry-run — a GC preview must not delete bytes.
    if (!request.dry_run) {
      const liveThreadsByRoot = new Map<string, Set<string>>();
      for (const thread of deps.threads.listThreads()) {
        const root = thread.repo?.root ?? noProjectRoot;
        (liveThreadsByRoot.get(root) ?? liveThreadsByRoot.set(root, new Set()).get(root)!).add(
          thread.id,
        );
      }
      for (const root of roots) {
        try {
          sweepOrphanLanes(root, liveThreadsByRoot.get(root) ?? new Set());
        } catch {
          /* best-effort: orphan lane dirs are harmless and re-sweepable */
        }
      }
    }
    return runRetentionPass(
      {
        runsMaxAgeDays: retention.runs_max_age_days,
        reviewsMaxAgeDays: retention.reviews_max_age_days,
        keepLastRunsPerProject: retention.keep_last_runs_per_project,
      },
      request,
      { projects: () => gcProjects, records: () => records, referencedRunIds },
    );
  };
  return (request) => {
    const chained = (inFlight ?? Promise.resolve()).then(
      () => runOnce(request),
      () => runOnce(request),
    );
    inFlight = chained;
    return chained.finally(() => {
      if (inFlight === chained) inFlight = null;
    });
  };
}

/**
 * SCHEDULE one bounded retention pass after ownership+ready (W3.6) — it never
 * blocks boot, and the unref'd timer never keeps a stopping daemon alive.
 * Failures are logged, never fatal.
 */
export function scheduleStartupRetention(
  runner: RetentionRunner,
  opts: { logPath: string; shuttingDown: () => boolean; delayMs?: number },
): void {
  const timer = setTimeout(() => {
    if (opts.shuttingDown()) return;
    void runner({ dry_run: false }).then(
      (receipt) =>
        logLine(
          opts.logPath,
          `retention: freed ${receipt.freed_bytes} bytes (${receipt.deleted_runs.length} runs, ` +
            `${receipt.deleted_reviews.length} reviews, ${receipt.errors.length} errors)`,
        ),
      (error: unknown) =>
        logLine(
          opts.logPath,
          `retention FAILED: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );
  }, opts.delayMs ?? 60_000);
  timer.unref?.();
}
