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
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import {
  ControlGcReceipt,
  ControlGcRequest,
  type GcKeepCounts,
  type GcRunDeletion,
} from "@claudexor/schema";
import { readTextSafe, writeText } from "@claudexor/util";

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
}

export interface RetentionRunRecord {
  runId: string;
  state: string;
  finishedAt?: string;
}

export interface RetentionDeps {
  projects: () => RetentionProject[];
  /** The daemon's journal-projected command records (terminality truth). */
  records: () => RetentionRunRecord[];
  /** Every run id referenced by a non-purged thread (lineage, heads, turns). */
  referencedRunIds: () => Set<string>;
  now?: () => number;
  /** Bounded batches: one pass deletes at most this many trees (disclosed). */
  maxDeletionsPerPass?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TOMBSTONE = "tombstone.yaml";
/** Daemon-record states with an operator or scheduler still attached. */
/**
 * Run states whose tree is COMPLETE and may age out — an explicit allowlist,
 * mirroring ControlRunState's terminal half. A blocklist would fail OPEN: a
 * state added to the enum later (or an unrecognized string from a
 * newer/older daemon's records) would default to deletable, which is exactly
 * the "fail closed on unknown state" contract this service owes. Anything not
 * named here — live, unknown, or future — keeps its tree.
 */
const TERMINAL_STATES = new Set([
  "succeeded",
  "no_op",
  "ungated",
  "review_not_run",
  "failed",
  "cancelled",
  "interrupted_unknown",
  "cost_unverifiable",
  "exhausted_overshoot",
  "exhausted",
  "not_converged",
  "stuck_no_progress",
]);

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
  let examined = 0;
  let freedBytes = 0;
  let deletions = 0;
  let truncated = false;

  for (const project of projects) {
    const candidates: { runId: string; root: string; ageStamp: number }[] = [];
    for (const runId of listSubdirs(project.runsDir)) {
      const root = join(project.runsDir, runId);
      if (existsSync(join(root, TOMBSTONE))) continue; // already reclaimed
      examined += 1;
      const record = recordsById.get(runId);
      // A record that does not PROVE terminality protects its tree: live
      // states, and anything this engine does not recognize as finished.
      // `blocked` is terminal-but-actionable and keeps its own reason below.
      if (record && record.state !== "blocked" && !TERMINAL_STATES.has(record.state)) {
        kept.active += 1;
        continue;
      }
      if (referenced.has(runId)) {
        kept.referenced += 1;
        continue;
      }
      // Blocked runs stay operator-visible; an undelivered/applyable patch
      // (or a review-blocked delivery) is work the operator may still act
      // on. The decision RECORDS themselves are journal-durable and survive
      // independently of the tree.
      if (record?.state === "blocked" || hasActionableWorkProduct(root)) {
        kept.actionable += 1;
        continue;
      }
      // Terminality is evidence, never an assumption: without a daemon record
      // the tree itself must prove it finished (a final summary / failure /
      // work product). An unproven tree is protected, not deleted.
      if (!record && !hasTerminalEvidence(root)) {
        kept.unknown_state += 1;
        continue;
      }
      const ageStamp = ageStampOf(root, record);
      if (ageStamp > runCutoff) {
        kept.young += 1;
        continue;
      }
      candidates.push({ runId, root, ageStamp });
    }
    // The newest N per project survive regardless of age.
    candidates.sort((a, b) => b.ageStamp - a.ageStamp);
    const spared = candidates.slice(0, policy.keepLastRunsPerProject);
    kept.recent += spared.length;
    for (const candidate of candidates.slice(policy.keepLastRunsPerProject)) {
      if (deletions >= maxDeletions) {
        truncated = true;
        break;
      }
      try {
        const bytes = treeBytes(candidate.root);
        if (!dryRun) {
          rmSync(candidate.root, { recursive: true, force: true });
          // The deletion is FACT once rmSync returns — a failed tombstone
          // write must not erase it from the receipt (release wave round-15
          // NIT); it degrades to an errors[] entry beside the recorded
          // deletion instead.
          try {
            writeText(
              join(candidate.root, TOMBSTONE),
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
          } catch (tombstoneError) {
            errors.push(
              `runs/${candidate.runId}: tombstone write failed: ${tombstoneError instanceof Error ? tombstoneError.message : String(tombstoneError)}`,
            );
          }
        }
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
      }
    }
    // `truncated` is set ONLY where a real candidate was skipped (above), so
    // exhausting the cap on the very last deletable tree never makes the pass
    // claim "run gc again to continue" with nothing left to do.
    if (truncated) break;
  }

  for (const project of projects) {
    // No reviews dir (the no-project root has none) — skip THIS project only.
    // Checked BEFORE the cap so a project with nothing to sweep never makes
    // the pass claim it was truncated.
    if (!project.reviewsDir) continue;
    if (truncated) break;
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
    for (const name of listSubdirs(reviewsDir)) {
      // Standalone diff-review trees only — `.claudexor/` in a user repo is
      // user-owned config; the engine deletes nothing there but its own
      // `diff-*` runtime debris, never following a symlinked leaf either.
      if (!name.startsWith("diff-")) continue;
      const path = join(reviewsDir, name);
      try {
        if (lstatSync(path).isSymbolicLink()) continue;
        if (statSync(path).mtimeMs > reviewCutoff) continue;
        // The cap is checked once this IS a real deletion candidate, so a
        // truncation disclosure always means work was genuinely left behind.
        if (deletions >= maxDeletions) {
          truncated = true;
          break;
        }
        const bytes = treeBytes(path);
        if (!dryRun) rmSync(path, { recursive: true, force: true });
        deletedReviews.push({ path, freed_bytes: bytes });
        freedBytes += bytes;
        deletions += 1;
        // Same bounded-batch discipline as the runs loop: yield so a large
        // reviews sweep never blocks the daemon's event loop.
        await new Promise<void>((resolve) => setImmediate(resolve));
      } catch (error) {
        errors.push(`reviews/${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (truncated) {
    errors.push(
      `pass truncated at ${maxDeletions} deletions (bounded batch); run gc again to continue`,
    );
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
    deleted_reviews: deletedReviews,
    freed_bytes: freedBytes,
    errors,
  });
}

export interface RunTombstone {
  run_id: string;
  deleted_at: string;
  reason: string;
}

/** The honest post-GC projection: why this run's artifacts are gone. */
export function readRunTombstone(runDir: string): RunTombstone | null {
  const text = readTextSafe(join(runDir, TOMBSTONE));
  if (text === null) return null;
  try {
    const value = yamlParse(text) as Partial<RunTombstone> | null;
    return value && typeof value.run_id === "string" && typeof value.deleted_at === "string"
      ? { run_id: value.run_id, deleted_at: value.deleted_at, reason: String(value.reason ?? "") }
      : null;
  } catch {
    return null;
  }
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

function listSubdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function hasTerminalEvidence(runRoot: string): boolean {
  return (
    existsSync(join(runRoot, "final", "summary.md")) ||
    existsSync(join(runRoot, "final", "failure.yaml")) ||
    existsSync(join(runRoot, "final", "work_product.yaml"))
  );
}

function hasActionableWorkProduct(runRoot: string): boolean {
  const text = readTextSafe(join(runRoot, "final", "work_product.yaml"));
  if (text === null) return false;
  try {
    const doc = (yamlParse(text) ?? {}) as { kind?: unknown; meta?: unknown };
    const meta = (doc.meta ?? {}) as Record<string, unknown>;
    // The canonical discriminator is the TOP-LEVEL kind (release wave
    // round-13): convergence writes kind: patch without meta.result_kind, and
    // deleting its unapplied tree would destroy actionable work.
    if (doc.kind !== "patch" && doc.kind !== "new_repo" && meta["result_kind"] !== "patch")
      return false;
    const applyState = meta["apply_state"];
    // Same value set controlRunResult projects: an undelivered patch or a
    // review-blocked delivery is still the operator's to act on; applied and
    // reverted patches have completed their lifecycle.
    return applyState !== "applied" && applyState !== "reverted";
  } catch {
    return true; // unreadable work product: fail closed, keep the tree
  }
}

function ageStampOf(runRoot: string, record: RetentionRunRecord | undefined): number {
  const finished = Date.parse(record?.finishedAt ?? "");
  if (Number.isFinite(finished)) return finished;
  try {
    return statSync(runRoot).mtimeMs;
  } catch {
    return Date.now();
  }
}

function treeBytes(root: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      try {
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile()) total += statSync(path).size;
      } catch {
        /* a racing unlink must not fail the measurement */
      }
    }
  };
  try {
    walk(root);
  } catch {
    /* tree vanished mid-walk */
  }
  return total;
}
