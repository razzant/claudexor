import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  runRetentionPass,
  readRunTombstone,
  type RetentionDeps,
  type RetentionPolicy,
  type RetentionProject,
} from "./retention.js";
import { rmSync as __rmSyncReap } from "node:fs";
import { afterAll as __afterAllReap } from "vitest";

// W-h: reap every temp dir this suite creates so the gate stops leaking tmpdirs.
const __reapDirs: string[] = [];
function reapMk(...args: Parameters<typeof mkdtempSync>): string {
  const dir = mkdtempSync(...args);
  __reapDirs.push(dir);
  return dir;
}
__afterAllReap(() => {
  for (const dir of __reapDirs.splice(0)) __rmSyncReap(dir, { recursive: true, force: true });
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-17T00:00:00.000Z");
const POLICY: RetentionPolicy = {
  runsMaxAgeDays: 30,
  reviewsMaxAgeDays: 14,
  keepLastRunsPerProject: 1,
};

function sandbox(): { project: RetentionProject; root: string } {
  const root = reapMk(join(tmpdir(), "claudexor-retention-"));
  roots.push(root);
  const runsDir = join(root, "runs");
  const reviewsDir = join(root, "repo", ".claudexor", "reviews");
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(reviewsDir, { recursive: true });
  return { project: { root: join(root, "repo"), runsDir, reviewsDir }, root };
}

function seedRun(
  runsDir: string,
  runId: string,
  opts: { terminal?: boolean; workProduct?: string; decision?: string } = {},
): string {
  const dir = join(runsDir, runId);
  mkdirSync(join(dir, "final"), { recursive: true });
  writeFileSync(join(dir, "attempt.log"), "x".repeat(1024));
  if (opts.terminal !== false) writeFileSync(join(dir, "final", "summary.md"), "# done\n");
  if (opts.workProduct) writeFileSync(join(dir, "final", "work_product.yaml"), opts.workProduct);
  if (opts.decision) {
    mkdirSync(join(dir, "arbitration"), { recursive: true });
    writeFileSync(join(dir, "arbitration", "decision.yaml"), opts.decision);
  }
  return dir;
}

function daysAgo(days: number): string {
  return new Date(NOW - days * DAY_MS).toISOString();
}

function deps(project: RetentionProject, overrides: Partial<RetentionDeps> = {}): RetentionDeps {
  return {
    projects: () => [project],
    records: () => [],
    referencedRunIds: () => new Set(),
    now: () => NOW,
    ...overrides,
  };
}

describe("runRetentionPass", () => {
  it("deletes only old terminal unreferenced trees, keeps newest-N, leaves a tombstone", async () => {
    const { project } = sandbox();
    seedRun(project.runsDir, "run-old-a");
    seedRun(project.runsDir, "run-old-b");
    seedRun(project.runsDir, "run-young");
    const records = [
      { runId: "run-old-a", state: "succeeded", finishedAt: daysAgo(60) },
      { runId: "run-old-b", state: "succeeded", finishedAt: daysAgo(45) },
      { runId: "run-young", state: "succeeded", finishedAt: daysAgo(2) },
    ];
    const receipt = await runRetentionPass(
      POLICY,
      { dry_run: false },
      deps(project, {
        records: () => records,
      }),
    );

    // run-young survives the age window; run-old-b is the newest aged
    // candidate and survives keepLastRunsPerProject=1; run-old-a dies.
    expect(receipt.deleted_runs.map((d) => d.run_id)).toEqual(["run-old-a"]);
    expect(receipt.kept.young).toBe(1);
    expect(receipt.kept.recent).toBe(1);
    expect(receipt.freed_bytes).toBeGreaterThan(0);
    expect(existsSync(join(project.runsDir, "run-old-b", "final", "summary.md"))).toBe(true);
    // The tree is gone; the tombstone projection remains.
    expect(existsSync(join(project.runsDir, "run-old-a", "attempt.log"))).toBe(false);
    const tombstone = readRunTombstone(join(project.runsDir, "run-old-a"));
    expect(tombstone).toMatchObject({ run_id: "run-old-a", reason: "retention" });
    // A second pass skips the tombstone instead of re-deleting.
    const second = await runRetentionPass(
      POLICY,
      { dry_run: false },
      deps(project, {
        records: () => records,
      }),
    );
    expect(second.deleted_runs).toEqual([]);
  });

  it("dry_run reports the same decisions without touching disk", async () => {
    const { project } = sandbox();
    seedRun(project.runsDir, "run-old");
    seedRun(project.runsDir, "run-newer");
    const receipt = await runRetentionPass(
      POLICY,
      { dry_run: true },
      deps(project, {
        records: () => [
          { runId: "run-old", state: "succeeded", finishedAt: daysAgo(90) },
          { runId: "run-newer", state: "succeeded", finishedAt: daysAgo(60) },
        ],
      }),
    );
    expect(receipt.dry_run).toBe(true);
    expect(receipt.deleted_runs.map((d) => d.run_id)).toEqual(["run-old"]);
    expect(existsSync(join(project.runsDir, "run-old", "attempt.log"))).toBe(true);
    expect(readRunTombstone(join(project.runsDir, "run-old"))).toBeNull();
  });

  it("protects active, referenced, blocked, applyable, and unproven trees", async () => {
    const { project } = sandbox();
    seedRun(project.runsDir, "run-running");
    seedRun(project.runsDir, "run-referenced");
    // D8: a needs-decision run is a succeeded lifecycle whose decision.facts
    // carry review=blocked — retention keeps it actionable via the facts.
    seedRun(project.runsDir, "run-blocked", {
      decision:
        "winner: a01\nfacts:\n  lifecycle: succeeded\n  review: blocked\n  checks: not_configured\n  noChanges: false\n  reason: review_blocked\n",
    });
    seedRun(project.runsDir, "run-applyable", {
      workProduct: "meta:\n  result_kind: patch\n  apply_state: not_applied\n",
    });
    // The CONVERGENCE writer shape (release wave round-13): top-level kind
    // with NO meta.result_kind — its unapplied patch is equally actionable.
    seedRun(project.runsDir, "run-convergence-patch", {
      terminal: true,
      workProduct: "kind: patch\nmeta:\n  apply_state: not_applied\n",
    });
    seedRun(project.runsDir, "run-unproven", { terminal: false });
    const receipt = await runRetentionPass(
      { ...POLICY, keepLastRunsPerProject: 0 },
      { dry_run: false },
      deps(project, {
        records: () => [
          { runId: "run-running", state: "running" },
          { runId: "run-referenced", state: "succeeded", finishedAt: daysAgo(90) },
          { runId: "run-blocked", state: "succeeded", finishedAt: daysAgo(90) },
          { runId: "run-applyable", state: "succeeded", finishedAt: daysAgo(90) },
          { runId: "run-convergence-patch", state: "succeeded", finishedAt: daysAgo(90) },
        ],
        referencedRunIds: () => new Set(["run-referenced"]),
      }),
    );
    expect(receipt.deleted_runs).toEqual([]);
    expect(receipt.kept).toMatchObject({
      active: 1,
      referenced: 1,
      actionable: 3,
      unknown_state: 1,
    });
  });

  it("fails closed on a record state it does not recognize as terminal", async () => {
    // The terminal set is an ALLOWLIST: a state added to ControlRunState later
    // (or a record written by a different engine version) must protect its
    // tree, never default to deletable.
    const { project } = sandbox();
    seedRun(project.runsDir, "run-future-state");
    const receipt = await runRetentionPass(
      { ...POLICY, keepLastRunsPerProject: 0 },
      { dry_run: false },
      deps(project, {
        records: () => [
          { runId: "run-future-state", state: "awaiting_quorum", finishedAt: daysAgo(90) },
        ],
      }),
    );
    expect(receipt.deleted_runs).toEqual([]);
    expect(receipt.kept.active).toBe(1);
    expect(existsSync(join(project.runsDir, "run-future-state", "attempt.log"))).toBe(true);
  });

  it("an APPLIED patch ages out normally (its lifecycle is complete)", async () => {
    const { project } = sandbox();
    seedRun(project.runsDir, "run-applied", {
      workProduct: "meta:\n  result_kind: patch\n  apply_state: applied\n",
    });
    const receipt = await runRetentionPass(
      { ...POLICY, keepLastRunsPerProject: 0 },
      { dry_run: false },
      deps(project, {
        records: () => [{ runId: "run-applied", state: "succeeded", finishedAt: daysAgo(90) }],
      }),
    );
    expect(receipt.deleted_runs.map((d) => d.run_id)).toEqual(["run-applied"]);
  });

  it("a project WITHOUT review debris is a clean no-op, never a false error", async () => {
    // Most projects have no .claudexor/reviews at all; the pass receipt must
    // not carry an "unsafe directory" error for them (final sol review #7).
    const { project } = sandbox();
    rmSync(project.reviewsDir!, { recursive: true, force: true });
    const receipt = await runRetentionPass(POLICY, { dry_run: false }, deps(project));
    expect(receipt.errors).toEqual([]);
    expect(receipt.deleted_reviews).toEqual([]);
  });

  it("refuses to sweep a reviews dir reached through a symlinked parent (path-safety)", async () => {
    const { project, root } = sandbox();
    // A hostile/misconfigured repo ships `.claudexor/reviews` as a symlink to
    // an out-of-repo dir holding an aged diff-* tree. The GC must NOT follow it.
    const { mkdirSync: mkd, rmSync: rm, symlinkSync, utimesSync } = await import("node:fs");
    rm(project.reviewsDir!, { recursive: true, force: true });
    const outside = join(root, "outside-reviews");
    const victim = join(outside, "diff-2026-05-01T00-00-00");
    mkd(victim, { recursive: true });
    writeFileSync(join(victim, "evidence.md"), "e");
    const past = new Date(NOW - 60 * DAY_MS);
    utimesSync(victim, past, past);
    symlinkSync(outside, project.reviewsDir!);

    const receipt = await runRetentionPass(POLICY, { dry_run: false }, deps(project));
    expect(receipt.deleted_reviews).toEqual([]);
    expect(existsSync(victim)).toBe(true); // never rm -rf'd through the symlink
    expect(receipt.errors.join("\n")).toContain("canonical in-repo directory");
  });

  it("prunes only aged diff-* review trees and never follows other names", async () => {
    const { project } = sandbox();
    const oldReview = join(project.reviewsDir!, "diff-2026-05-01T00-00-00");
    const freshReview = join(project.reviewsDir!, "diff-2026-07-16T00-00-00");
    const foreign = join(project.reviewsDir!, "important-notes");
    for (const dir of [oldReview, freshReview, foreign]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "evidence.md"), "e");
    }
    // Age the old tree on disk (mtime is the age source for review trees).
    const past = new Date(NOW - 60 * DAY_MS);
    const { utimesSync, realpathSync } = await import("node:fs");
    utimesSync(oldReview, past, past);
    // The swept path is the CANONICAL one: the parent fence resolves symlinks
    // (on macOS /var -> /private/var) before walking, so the receipt reports
    // the real path the engine deleted. Resolve it BEFORE the sweep removes it.
    const canonicalOldReview = realpathSync(oldReview);

    const receipt = await runRetentionPass(POLICY, { dry_run: false }, deps(project));
    expect(receipt.deleted_reviews.map((d) => d.path)).toEqual([canonicalOldReview]);
    expect(existsSync(freshReview)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
  });

  it("bounded batches disclose truncation instead of silently stopping", async () => {
    const { project } = sandbox();
    seedRun(project.runsDir, "run-a");
    seedRun(project.runsDir, "run-b");
    const receipt = await runRetentionPass(
      { ...POLICY, keepLastRunsPerProject: 0 },
      { dry_run: false },
      deps(project, {
        records: () => [
          { runId: "run-a", state: "succeeded", finishedAt: daysAgo(90) },
          { runId: "run-b", state: "succeeded", finishedAt: daysAgo(90) },
        ],
        maxDeletionsPerPass: 1,
      }),
    );
    expect(receipt.deleted_runs).toHaveLength(1);
    expect(receipt.errors.join("\n")).toContain("truncated at 1");
  });

  it("does not claim truncation when the cap lands exactly on the last work there was", async () => {
    // Cap reached, but nothing remained to sweep: "run gc again to continue"
    // would be a false disclosure (the daemon logs errors as a problem).
    const { project } = sandbox();
    seedRun(project.runsDir, "run-only");
    const receipt = await runRetentionPass(
      { ...POLICY, keepLastRunsPerProject: 0 },
      { dry_run: false },
      {
        projects: () => [project],
        records: () => [{ runId: "run-only", state: "succeeded", finishedAt: daysAgo(90) }],
        referencedRunIds: () => new Set(),
        now: () => NOW,
        maxDeletionsPerPass: 1,
      },
    );
    expect(receipt.deleted_runs).toHaveLength(1);
    expect(receipt.errors).toEqual([]);
  });

  it("sweeps EVERY project's reviews — a project without a reviews dir is not a stop", async () => {
    // The no-project root carries reviewsDir: null. Skipping it must not skip
    // the projects after it.
    const withReviews = sandbox();
    const old = join(withReviews.project.reviewsDir!, "diff-2026-05-01T00-00-00");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "evidence.md"), "e");
    const { utimesSync, realpathSync } = await import("node:fs");
    const past = new Date(NOW - 60 * DAY_MS);
    utimesSync(old, past, past);
    const canonicalOld = realpathSync(old);
    const nullReviews = { ...sandbox().project, reviewsDir: null };

    const receipt = await runRetentionPass(
      POLICY,
      { dry_run: false },
      {
        projects: () => [nullReviews, withReviews.project], // null one FIRST
        records: () => [],
        referencedRunIds: () => new Set(),
        now: () => NOW,
      },
    );
    expect(receipt.deleted_reviews.map((d) => d.path)).toEqual([canonicalOld]);
  });

  it("discloses truncation even when the cap falls on a project's LAST candidate", async () => {
    // Two projects, each with one aged deletable run; cap = 1. The cap is hit
    // as project A's last (only) candidate, so A's inner loop ends normally —
    // the disclosure must still fire for the skipped project B.
    const a = sandbox();
    const b = sandbox();
    seedRun(a.project.runsDir, "run-a");
    seedRun(b.project.runsDir, "run-b");
    const receipt = await runRetentionPass(
      { ...POLICY, keepLastRunsPerProject: 0 },
      { dry_run: false },
      {
        projects: () => [a.project, b.project],
        records: () => [
          { runId: "run-a", state: "succeeded", finishedAt: daysAgo(90) },
          { runId: "run-b", state: "succeeded", finishedAt: daysAgo(90) },
        ],
        referencedRunIds: () => new Set(),
        now: () => NOW,
        maxDeletionsPerPass: 1,
      },
    );
    expect(receipt.deleted_runs).toHaveLength(1);
    expect(receipt.errors.join("\n")).toContain("truncated at 1");
  });

  it("readRunTombstone round-trips what the pass wrote", async () => {
    const { project } = sandbox();
    seedRun(project.runsDir, "run-x");
    await runRetentionPass(
      { ...POLICY, keepLastRunsPerProject: 0 },
      { dry_run: false },
      deps(project, {
        records: () => [{ runId: "run-x", state: "succeeded", finishedAt: daysAgo(90) }],
      }),
    );
    const raw = readFileSync(join(project.runsDir, "run-x", "tombstone.yaml"), "utf8");
    expect(raw).toContain("reason: retention");
    expect(readRunTombstone(join(project.runsDir, "run-x"))).toMatchObject({
      run_id: "run-x",
      deleted_at: new Date(NOW).toISOString(),
    });
  });
});
