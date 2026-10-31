/**
 * Daemon-owned disk retention (W3.6): bounded GC over engine-owned runtime
 * artifacts. Deletes ONLY terminal, unreferenced, non-actionable run trees
 * past their age window — and standalone diff-review trees past theirs —
 * leaving a tombstone projection behind so an old thread fails honestly
 * ("expired by retention"), never a mysterious 404. Every survivor is
 * counted with its keep reason: silent deletion and silent retention are
 * both bugs. The CLI (`claudexor gc`) and the startup maintenance pass are
 * thin callers of this one owner.
 */
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { setImmediate as yieldToAdmission } from "node:timers/promises";
import { dirname, join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import {
  ControlGcReceipt,
  ControlGcRequest,
  type GcKeepCounts,
  type GcRunDeletion,
} from "@claudexor/schema";
import { prunePatchObjects, redactSecrets } from "@claudexor/util";
import { pruneProjectObjectStore } from "@claudexor/workspace";
export { readRunTombstone } from "./run-tombstone.js";
import { treeReclaimableBytes } from "./retention-bytes.js";
import { ageStampOf, runKeepReason } from "./retention-candidates.js";
import { survivingAnchorIds, pruneRunAnchors } from "./retention-anchors.js";
import { pruneEmptyRuntimeDirectories } from "./retention-directories.js";
import { scanDataRootUnrecognized, type DataRootMode } from "./retention-data-root.js";
import {
  pendingRetirements,
  prepareRetirement,
  RETIRING,
  type Retirement,
} from "./retention-removal.js";

export interface RetentionPolicy {
  runsMaxAgeDays: number;
  reviewsMaxAgeDays: number;
  keepLastRunsPerProject: number;
}

export interface RetentionProject {
  /** Canonical project root (or the no-project root). */
  root: string;
  /** The ArtifactStore runs directory for this root. */
  runsDir: string;
  /** Standalone diff-review trees dir (`<root>/.claudexor/reviews`); null = none. */
  reviewsDir: string | null;
  /** False when inventory proves this namespace has no remaining project owner.
   * Omitted by older embedders preserves their existing keep-last protection. */
  keepLastRuns?: boolean;
}

export interface RetentionRunRecord {
  runId: string;
  state: string;
  finishedAt?: string;
}

export interface RetentionDeps {
  /** Any skipped namespace makes cross-namespace anchor ownership unknown. */
  anchorsHeld?: boolean;
  signal?: AbortSignal;
  projects: () => RetentionProject[];
  /** The daemon's journal-projected command records (terminality truth). */
  records: () => RetentionRunRecord[];
  /** Every run id referenced by a non-purged thread (lineage, heads, turns). */
  referencedRunIds: () => Set<string>;
  /** Fresh proof that asynchronous inventory still describes the SQL owners. */
  referencesCurrent?: () => boolean;
  /** Reread changed owners cooperatively before the synchronous final proof. */
  refreshReferences?: () => Promise<void>;
  now?: () => number;
  /** Bounded batches: one pass deletes at most this many trees (disclosed). */
  maxDeletionsPerPass?: number;
  /** Signals a real skipped candidate to the lifecycle scheduler. */
  onTruncated?: () => void;
  /**
   * Absolute Claudexor-owned data root to scan for NOT-engine-owned top-level
   * entries (advisory disclosure only — the pass never deletes anything
   * there). Injected from composition, never derived from globals here, so
   * the pass stays a pure function of its deps. Absent = no scan and the
   * receipt field stays absent. The scan also runs ONLY when the request
   * opted in via data_root_report (capability negotiation for version skew).
   */
  dataRoot?: string;
  /**
   * Which layout the injected dataRoot follows — "default" (~/.claudexor,
   * where the engine keeps its state under the v3 generation subtree) or
   * "override" (an explicit CLAUDEXOR_CONFIG_DIR root, which IS the complete
   * relocatable tree, so the engine additionally writes secrets.json,
   * plugins, quota, and workspaces directly at its top level). Injected from
   * composition beside dataRoot; absent defaults to "default".
   */
  dataRootMode?: DataRootMode;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TOMBSTONE = "tombstone.yaml";
export async function runRetentionPass(
  policy: RetentionPolicy,
  request: ControlGcRequest,
  deps: RetentionDeps,
): Promise<ControlGcReceipt> {
  const now = deps.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const dryRun = request.dry_run;
  const maxDeletions = deps.maxDeletionsPerPass ?? 500;
  const runCutoff = now() - policy.runsMaxAgeDays * DAY_MS;
  const reviewCutoff = now() - policy.reviewsMaxAgeDays * DAY_MS;
  const recordsById = new Map(deps.records().map((record) => [record.runId, record]));
  const referenced = deps.referencedRunIds();

  const kept: GcKeepCounts = {
    active: 0,
    recent: 0,
    young: 0,
    referenced: 0,
    actionable: 0,
    unknown_state: 0,
  };
  const projects = [...deps.projects()];
  const deletedRuns: GcRunDeletion[] = [];
  const deletedReviews: { path: string; freed_bytes: number }[] = [];
  const errors: string[] = [];
  const holds: ControlGcReceipt["holds"] = [];
  let examined = 0;
  let freedBytes = 0;
  const plannedUnlinks = new Map<string, number>();
  let deletions = 0;
  let truncated = false;
  let invalidated = false;
  const proofCurrent = () => {
    if (invalidated || deps.signal?.aborted) return false;
    try {
      if (deps.referencesCurrent?.() === false) invalidated = true;
    } catch (error) {
      invalidated = true;
      errors.push(`retention reference recheck failed: ${String(error)}`);
    }
    return !invalidated;
  };
  const refreshProof = async () => {
    if (invalidated || deps.signal?.aborted) return;
    try {
      await deps.refreshReferences?.();
    } catch (error) {
      invalidated = true;
      errors.push(`retention reference refresh failed: ${String(error)}`);
    }
  };
  const recoverPending = async (parent: string, kind: "runs" | "reviews", projectRoot: string) => {
    for await (const retirement of pendingRetirements(parent, kind, dryRun, errors, deps.signal)) {
      if (deps.signal?.aborted) break;
      if (deletions >= maxDeletions) {
        truncated = true;
        break;
      }
      try {
        await retirement.recover();
        const planned = new Map(dryRun ? plannedUnlinks : undefined);
        const bytes = await retirement.reclaimableBytes(planned);
        if (!dryRun) {
          errors.push(...(await retirement.finish()));
        } else for (const [key, value] of planned) plannedUnlinks.set(key, value);
        if (kind === "runs")
          deletedRuns.push({
            run_id: retirement.intent.name,
            project_root: projectRoot,
            freed_bytes: bytes,
          });
        else
          deletedReviews.push({ path: join(parent, retirement.intent.name), freed_bytes: bytes });
        freedBytes += bytes;
        deletions += 1;
      } catch (error) {
        errors.push(`${kind}/${retirement.intent.name}: retired cleanup pending: ${String(error)}`);
      }
    }
  };

  runProjects: for (const project of projects) {
    if (deps.signal?.aborted) break;
    await refreshProof();
    if (!proofCurrent()) break;
    await recoverPending(project.runsDir, "runs", project.root);
    if (truncated || deps.signal?.aborted) break;
    const candidates: {
      runId: string;
      root: string;
      ageStamp: number;
      dev: number;
      ino: number;
    }[] = [];
    for (const runId of await listSubdirs(project.runsDir)) {
      await yieldToAdmission();
      await refreshProof();
      if (!proofCurrent()) break runProjects;
      const root = join(project.runsDir, runId);
      if (existsSync(join(root, TOMBSTONE))) continue; // already reclaimed
      examined += 1;
      const record = recordsById.get(runId);
      const reason = runKeepReason(root, runId, record, referenced, runCutoff, (error) =>
        errors.push(`runs/${runId}: kept; its retained sources are unreadable: ${String(error)}`),
      );
      if (reason) {
        kept[reason] += 1;
        continue;
      }
      const ageStamp = ageStampOf(root, record);
      const identity = lstatSync(root);
      if (!identity.isDirectory()) continue;
      candidates.push({ runId, root, ageStamp, dev: identity.dev, ino: identity.ino });
    }
    // Recent history belongs to a still-owned project, not an orphan namespace.
    candidates.sort((a, b) => b.ageStamp - a.ageStamp);
    const keepLast = project.keepLastRuns === false ? 0 : policy.keepLastRunsPerProject;
    const spared = candidates.slice(0, keepLast);
    kept.recent += spared.length;
    for (const candidate of candidates.slice(keepLast)) {
      if (deps.signal?.aborted) break;
      if (deletions >= maxDeletions) {
        truncated = true;
        break;
      }
      let retirement: Retirement | undefined;
      try {
        const planned = new Map(dryRun ? plannedUnlinks : undefined);
        const bytes = await treeReclaimableBytes(candidate.root, planned, deps.signal);
        if (!dryRun)
          retirement = await prepareRetirement(
            project.runsDir,
            candidate.runId,
            yamlStringify({
              run_id: candidate.runId,
              deleted_at: new Date(now()).toISOString(),
              reason: "retention",
              policy: {
                runs_max_age_days: policy.runsMaxAgeDays,
                keep_last_runs_per_project: policy.keepLastRunsPerProject,
              },
            }),
          );
        await refreshProof();
        if (!proofCurrent()) break runProjects;
        // Re-read every mutable filesystem guard after the asynchronous walk.
        // SQL-backed callers reread changed owners; older embedders
        // without that proof supply fresh references/records here instead.
        const record = deps.referencesCurrent
          ? recordsById.get(candidate.runId)
          : deps.records().find((row) => row.runId === candidate.runId);
        const liveReferences = deps.referencesCurrent ? referenced : deps.referencedRunIds();
        const identity = lstatSync(candidate.root);
        if (
          !identity.isDirectory() ||
          identity.dev !== candidate.dev ||
          identity.ino !== candidate.ino ||
          existsSync(join(candidate.root, TOMBSTONE))
        )
          continue;
        const reason = runKeepReason(
          candidate.root,
          candidate.runId,
          record,
          liveReferences,
          runCutoff,
          (error) =>
            errors.push(
              `runs/${candidate.runId}: kept; its retained sources are unreadable: ${String(error)}`,
            ),
        );
        if (reason) {
          kept[reason] += 1;
          continue;
        }
        if (retirement) {
          retirement.commit();
          errors.push(...(await retirement.finish()));
        }
        if (dryRun) for (const [key, value] of planned) plannedUnlinks.set(key, value);
        deletedRuns.push({
          run_id: candidate.runId,
          project_root: project.root,
          freed_bytes: bytes,
        });
        freedBytes += bytes;
        deletions += 1;
        // Bounded batches must not starve the event loop under the daemon.
        await new Promise<void>((resolve) => setImmediate(resolve));
      } catch (error) {
        errors.push(
          `runs/${candidate.runId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        try {
          await retirement?.abandon();
        } catch (error) {
          errors.push(`runs/${candidate.runId}: retirement cleanup: ${String(error)}`);
        }
      }
    }
    // `truncated` is set ONLY where a real candidate was skipped (above), so
    // exhausting the cap on the very last deletable tree never makes the pass
    // claim "run gc again to continue" with nothing left to do.
    if (truncated || deps.signal?.aborted) break;
  }

  for (const project of projects) {
    await yieldToAdmission();
    await refreshProof();
    if (!proofCurrent()) break;
    // No reviews dir (the no-project root has none) — skip THIS project only.
    // Checked BEFORE the cap so a project with nothing to sweep never makes
    // the pass claim it was truncated.
    if (!project.reviewsDir) continue;
    if (truncated || deps.signal?.aborted) break;
    // `.claudexor/reviews` lives inside the USER repo: fence the PARENT before
    // ever walking it. A repo that ships `.claudexor` or `.claudexor/reviews`
    // as a symlink must not redirect readdir/rmSync outside the repo (a real
    // rm -rf-outside-repo hole). realpath both the dir and its canonical
    // in-repo location; a mismatch (symlinked parent) skips the whole tree.
    const fenced = canonicalInRepoReviewsDir(project);
    if (fenced.verdict === "missing") continue; // no review debris — clean no-op
    if (fenced.verdict === "unsafe") {
      errors.push(`reviews: ${project.reviewsDir} is not a canonical in-repo directory; skipped`);
      continue;
    }
    const reviewsDir = fenced.path;
    await recoverPending(reviewsDir, "reviews", project.root);
    if (truncated || deps.signal?.aborted) break;
    for (const name of await listSubdirs(reviewsDir)) {
      if (deps.signal?.aborted) break;
      // Standalone diff-review trees only — `.claudexor/` in a user repo is
      // user-owned config; the engine deletes nothing there but its own
      // `diff-*` runtime debris, never following a symlinked leaf either.
      if (!name.startsWith("diff-")) continue;
      const path = join(reviewsDir, name);
      let retirement: Retirement | undefined;
      try {
        if (lstatSync(path).isSymbolicLink()) continue;
        if (statSync(path).mtimeMs > reviewCutoff) continue;
        // The cap is checked once this IS a real deletion candidate, so a
        // truncation disclosure always means work was genuinely left behind.
        if (deps.signal?.aborted) break;
        if (deletions >= maxDeletions) {
          truncated = true;
          break;
        }
        const planned = new Map(dryRun ? plannedUnlinks : undefined);
        const bytes = await treeReclaimableBytes(path, planned, deps.signal);
        if (!dryRun) retirement = await prepareRetirement(reviewsDir, name, null);
        await refreshProof();
        if (!proofCurrent()) break;
        const currentFence = canonicalInRepoReviewsDir(project);
        if (
          currentFence.verdict !== "ok" ||
          currentFence.path !== reviewsDir ||
          !lstatSync(path).isDirectory() ||
          statSync(path).mtimeMs > reviewCutoff
        )
          continue;
        if (retirement) {
          retirement.commit();
          errors.push(...(await retirement.finish()));
        }
        if (dryRun) for (const [key, value] of planned) plannedUnlinks.set(key, value);
        deletedReviews.push({ path, freed_bytes: bytes });
        freedBytes += bytes;
        deletions += 1;
        // Same bounded-batch discipline as the runs loop: yield so a large
        // reviews sweep never blocks the daemon's event loop.
        await new Promise<void>((resolve) => setImmediate(resolve));
      } catch (error) {
        errors.push(`reviews/${name}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        try {
          await retirement?.abandon();
        } catch (error) {
          errors.push(`reviews/${name}: retirement cleanup: ${String(error)}`);
        }
      }
    }
  }
  let namedAnchors: Set<string> | undefined;
  if (!deps.anchorsHeld && !invalidated && !deps.signal?.aborted) {
    try {
      namedAnchors = await survivingAnchorIds(
        projects,
        new Set(
          deletedRuns.flatMap((run) =>
            projects
              .filter((project) => project.root === run.project_root)
              .map((project) => join(project.runsDir, run.run_id)),
          ),
        ),
        deps.signal,
      );
    } catch (error) {
      const example = `anchors kept: ${redactSecrets(String(error))}`;
      holds.push({ class: "anchor_references_unreadable", count: 1, example });
      errors.push(example);
    }
  }
  for (const project of projects) {
    try {
      if (invalidated || deps.signal?.aborted) break;
      await refreshProof();
      if (!proofCurrent()) break;
      if (namedAnchors)
        freedBytes += await pruneRunAnchors({
          runtime: dirname(project.runsDir),
          named: namedAnchors,
          cutoff: runCutoff,
          dryRun,
          planned: plannedUnlinks,
          current: proofCurrent,
          signal: deps.signal,
        });
      freedBytes += await prunePatchObjects(
        dirname(project.runsDir),
        dryRun,
        plannedUnlinks,
        deps.signal,
      );
      // #535: objects live while a run, thread, envelope or anchor owning them
      // exists; a run retired here (in a dry run too) owns nothing any more.
      const retiredOwners = new Set(
        deletedRuns
          .filter((run) => run.project_root === project.root)
          .map((run) => join(project.runsDir, run.run_id)),
      );
      freedBytes += (
        await pruneProjectObjectStore(dirname(project.runsDir), { dryRun, retiredOwners })
      ).freedBytes;
      if (!dryRun && proofCurrent())
        pruneEmptyRuntimeDirectories(
          dirname(project.runsDir),
          Date.parse(startedAt),
          (path, error) =>
            errors.push(
              `runtime cleanup ${path}: ${error instanceof Error ? error.message : String(error)}`,
            ),
        );
    } catch (error) {
      errors.push(`runtime cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }
    await yieldToAdmission();
  }

  if (truncated) {
    deps.onTruncated?.();
    errors.push(
      `pass truncated at ${maxDeletions} deletions (bounded batch); run gc again to continue`,
    );
  }
  if (invalidated) {
    holds.push({
      class: "references_changed",
      count: 1,
      example: "remaining candidates kept; retry with a fresh snapshot",
    });
    deps.onTruncated?.();
    errors.push(
      "retention references changed during inventory; remaining candidates kept; retry with a fresh snapshot",
    );
  }

  // Advisory data-root disclosure (never a deletion surface): a failed scan
  // leaves the field ABSENT — an empty list must always mean "scanned, clean".
  // Emitted ONLY when the request opted in via data_root_report: a request
  // from a client that never sent the flag (any pre-feature CLI) gets a
  // receipt byte-compatible with pre-feature engines, so an old strict
  // receipt schema never rejects the reply to a mutating verb it already ran.
  let dataRootUnrecognized: string[] | undefined;
  if (!deps.signal?.aborted && request.data_root_report === true && deps.dataRoot) {
    try {
      dataRootUnrecognized = await scanDataRootUnrecognized(
        deps.dataRoot,
        deps.dataRootMode ?? "default",
      );
    } catch (error) {
      errors.push(
        `data root scan (${deps.dataRoot}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (deps.signal?.aborted) {
    deps.onTruncated?.();
    errors.push("retention cancelled; pass truncated; run gc again to resume remaining work");
  }

  return ControlGcReceipt.parse({
    schema_version: 1,
    dry_run: dryRun,
    started_at: startedAt,
    finished_at: new Date(now()).toISOString(),
    policy: {
      runs_max_age_days: policy.runsMaxAgeDays,
      reviews_max_age_days: policy.reviewsMaxAgeDays,
      keep_last_runs_per_project: policy.keepLastRunsPerProject,
    },
    examined_runs: examined,
    deleted_runs: deletedRuns,
    kept,
    holds,
    truncated: truncated || invalidated || deps.signal?.aborted === true,
    deleted_reviews: deletedReviews,
    freed_bytes: freedBytes,
    errors,
    ...(dataRootUnrecognized === undefined ? {} : { data_root_unrecognized: dataRootUnrecognized }),
  });
}

/**
 * The reviews dir ONLY if it is a real in-repo directory: its canonical
 * (symlink-resolved) path must equal the canonical `<repo>/.claudexor/reviews`
 * built from the canonical repo root. A symlinked `.claudexor` or
 * `.claudexor/reviews` (committed by a hostile/misconfigured repo) resolves
 * elsewhere — the engine never rm -rf's outside the repo it was pointed at.
 * "Missing" is a distinct verdict: MOST projects have no review debris, and
 * reporting them as unsafe would put a false error in every pass receipt
 * (final sol review #7).
 */
function canonicalInRepoReviewsDir(
  project: RetentionProject,
): { verdict: "ok"; path: string } | { verdict: "missing" } | { verdict: "unsafe" } {
  if (!project.reviewsDir || !existsSync(project.reviewsDir)) return { verdict: "missing" };
  try {
    const canonicalRoot = realpathSync(project.root);
    const expected = join(canonicalRoot, ".claudexor", "reviews");
    const actual = realpathSync(project.reviewsDir);
    return actual === expected ? { verdict: "ok", path: actual } : { verdict: "unsafe" };
  } catch {
    return { verdict: "unsafe" };
  }
}

async function listSubdirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== RETIRING)
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
