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
import { logLine } from "./daemon-lifecycle.js";

export interface RetentionRunnerDeps {
  projects: () => ProjectStore;
  threads: ProjectPartitions;
  daemonJobs: () => Promise<Array<{ runId?: string; state: string; finishedAt?: string }>>;
}

export type RetentionRunner = (request: ControlGcRequest) => Promise<ControlGcReceipt>;

export function createRetentionRunner(deps: RetentionRunnerDeps): RetentionRunner {
  const noProjectRoot = noProjectRepoRoot();
  return async (request) => {
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
    const roots = [
      ...new Set([
        ...deps
          .projects()
          .list()
          .map((p) => p.root),
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
