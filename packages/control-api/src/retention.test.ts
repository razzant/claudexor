import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceManager,
  envelopeBaseOf,
  releaseEnvelopeCustody,
  retainForInspection,
} from "@claudexor/workspace";
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
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

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

function seedDataRootEntry(dataRoot: string, name: string, kind: "directory" | "file"): void {
  const path = join(dataRoot, name);
  if (kind === "file") writeFileSync(path, `${name}\n`);
  else mkdirSync(path, { recursive: true });
}

describe("runRetentionPass", () => {
  it("keeps actionable patches but lets cancelled Git evidence follow normal retention", async () => {
    const { project } = sandbox();
    const records = ["succeeded", "cancelled", "failed", "interrupted"].map((state) => {
      const runId = `run-${state}`;
      seedRun(project.runsDir, runId, {
        workProduct: `kind: patch\nmeta:\n  lifecycle: ${state}\n  apply_state: not_applied\n`,
      });
      return { runId, state, finishedAt: daysAgo(60) };
    });
    const receipt = await runRetentionPass(
      { ...POLICY, keepLastRunsPerProject: 0 },
      { dry_run: true },
      deps(project, { records: () => records }),
    );
    expect(receipt.kept.actionable).toBe(1);
    expect(receipt.deleted_runs.map((row) => row.run_id).sort()).toEqual([
      "run-cancelled",
      "run-failed",
      "run-interrupted",
    ]);
  });
  it("keeps and discloses a run whose inspection addresses cannot be read; deletes the rest", async () => {
    const { project } = sandbox();
    const unreadable = seedRun(project.runsDir, "run-unreadable");
    writeFileSync(join(unreadable, "attempts"), "not a directory");
    seedRun(project.runsDir, "run-ordinary");
    const records = ["run-unreadable", "run-ordinary"].map((runId) => ({
      runId,
      state: "failed",
      finishedAt: daysAgo(90),
    }));
    const receipt = await runRetentionPass(
      { ...POLICY, keepLastRunsPerProject: 0 },
      { dry_run: false },
      deps(project, { records: () => records }),
    );
    expect(receipt.deleted_runs.map((row) => row.run_id)).toEqual(["run-ordinary"]);
    expect(receipt.kept.actionable).toBe(1);
    expect(receipt.errors).toEqual([expect.stringMatching(/^runs\/run-unreadable: .*ENOTDIR/)]);
    expect(readFileSync(join(unreadable, "attempts"), "utf8")).toBe("not a directory");
    expect(existsSync(join(project.runsDir, "run-ordinary", "final"))).toBe(false);
  });
  // chmod 0o000 denies reads only where the platform honors the mode bits for
  // the current user (not root, not Windows where Node changes only the write
  // bit): probe the real capability once instead of guessing from uid.
  const canDenyRead = (() => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-retention-probe-"));
    const probe = join(dir, "probe");
    try {
      writeFileSync(probe, "x");
      chmodSync(probe, 0o000);
      try {
        readFileSync(probe);
        return false;
      } catch (error) {
        return (error as { code?: string }).code === "EACCES";
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
  it.each([
    { fault: "pointer-malformed", error: /invalid retained-envelope pointer/ },
    { fault: "pointer-is-a-directory", error: /EISDIR/ },
    { fault: "custody-malformed", error: /invalid envelope custody record/ },
    ...(canDenyRead
      ? [
          { fault: "pointer-eacces", error: /EACCES/ },
          { fault: "custody-eacces", error: /EACCES/ },
        ]
      : []),
  ])(
    "keeps and discloses a run whose kept source has fault $fault; a released source follows retention",
    async ({ fault, error }) => {
      const { project } = sandbox();
      execFileSync("git", ["init", "-q", project.root]);
      writeFileSync(join(project.root, "a.txt"), "a\n");
      execFileSync("git", ["-C", project.root, "add", "-A"]);
      execFileSync("git", [
        ...["-C", project.root, "-c", "user.email=t@t", "-c", "user.name=t"],
        ...["commit", "-qm", "init"],
      ]);
      const runDir = seedRun(project.runsDir, "run-kept");
      mkdirSync(join(runDir, "attempts", "a01"), { recursive: true });
      writeFileSync(join(runDir, "attempts", "a01", "answer.md"), "generated answer\n");
      seedRun(project.runsDir, "run-ordinary");
      const env = await new WorkspaceManager(project.root).create({
        taskId: "task-kept",
        attemptId: "a01",
        baseRef: "HEAD",
        custody: { runId: "run-kept", runDir },
      });
      writeFileSync(join(env.worktree_path, "unique.txt"), "irreplaceable source bytes\n");
      retainForInspection(env, { runId: "run-kept", runDir });
      const pointer = join(runDir, "attempts", "a01", "retained-envelope.json");
      const custodyFile = join(envelopeBaseOf(env), "continuation-custody.json");
      const pointerBytes = readFileSync(pointer);
      const custodyBytes = readFileSync(custodyFile);
      const restore: Array<() => void> = [];
      if (fault === "pointer-malformed") writeFileSync(pointer, "{");
      if (fault === "pointer-is-a-directory") {
        rmSync(pointer);
        mkdirSync(pointer);
        restore.push(() => rmSync(pointer, { recursive: true }));
      }
      if (fault === "custody-malformed") writeFileSync(custodyFile, "{");
      if (fault === "pointer-eacces") {
        chmodSync(pointer, 0o000);
        restore.push(() => chmodSync(pointer, 0o600));
      }
      if (fault === "custody-eacces") {
        chmodSync(custodyFile, 0o000);
        restore.push(() => chmodSync(custodyFile, 0o600));
      }
      const records = ["run-kept", "run-ordinary"].map((runId) => ({
        runId,
        state: "failed",
        finishedAt: daysAgo(90),
      }));
      const receipt = await runRetentionPass(
        { ...POLICY, keepLastRunsPerProject: 0 },
        { dry_run: false },
        deps(project, { records: () => records }),
      );
      expect(receipt.deleted_runs.map((row) => row.run_id)).toEqual(["run-ordinary"]);
      expect(receipt.kept.actionable).toBe(1);
      expect(receipt.errors).toEqual([
        expect.stringMatching(/^runs\/run-kept: kept; its retained sources are unreadable: /),
      ]);
      expect(receipt.errors[0]).toMatch(error);
      expect(readFileSync(join(runDir, "attempts", "a01", "answer.md"), "utf8")).toBe(
        "generated answer\n",
      );
      expect(readFileSync(join(env.worktree_path, "unique.txt"), "utf8")).toBe(
        "irreplaceable source bytes\n",
      );
      for (const undo of restore) undo();
      writeFileSync(pointer, pointerBytes);
      writeFileSync(custodyFile, custodyBytes);
      // Readable again: still held, without an error. Once custody is released
      // (an explicit disposition), the stale address is legitimately nothing
      // held and the run follows ordinary retention.
      const held = await runRetentionPass(
        { ...POLICY, keepLastRunsPerProject: 0 },
        { dry_run: false },
        deps(project, { records: () => records }),
      );
      expect(held.deleted_runs).toEqual([]);
      expect(held.kept.actionable).toBe(1);
      expect(held.errors).toEqual([]);
      releaseEnvelopeCustody(envelopeBaseOf(env));
      const released = await runRetentionPass(
        { ...POLICY, keepLastRunsPerProject: 0 },
        { dry_run: false },
        deps(project, { records: () => records }),
      );
      expect(released.deleted_runs.map((row) => row.run_id)).toEqual(["run-kept"]);
      expect(released.errors).toEqual([]);
      expect(readFileSync(join(env.worktree_path, "unique.txt"), "utf8")).toBe(
        "irreplaceable source bytes\n",
      );
      await new WorkspaceManager(project.root).dispose(env);
    },
  );
  it("retains the remainder of partial files delivery and releases explicit discard to normal retention", async () => {
    const { project } = sandbox();
    const records = ["pending", "discarded", "direct"].map((id) => {
      const runId = `run-files-${id}`;
      const root = seedRun(project.runsDir, runId, {
        workProduct: `kind: files\nmeta:\n  apply_state: ${id === "direct" ? "applied" : "not_applied"}\n`,
      });
      if (id !== "direct")
        writeFileSync(
          join(root, "final/delivery_state.yaml"),
          `applyState: ${id === "discarded" ? "discarded" : "not_applied"}\nappliedPaths: [already-delivered.bin]\n`,
        );
      return { runId, state: "succeeded", finishedAt: daysAgo(90) };
    });
    const receipt = await runRetentionPass(
      { ...POLICY, keepLastRunsPerProject: 0 },
      { dry_run: false },
      deps(project, { records: () => records }),
    );
    expect(receipt.deleted_runs.map((r) => r.run_id).sort()).toEqual([
      "run-files-direct",
      "run-files-discarded",
    ]);
    expect(existsSync(join(project.runsDir, "run-files-pending", "final/work_product.yaml"))).toBe(
      true,
    );
  });
  it("retires a captured no-change patch but keeps non-empty, refused, files, and legacy results", async () => {
    const { project } = sandbox();
    const rows = [
      [
        "run-no-change",
        "kind: patch\nmeta:\n  capturedNoGitChange: true\n  apply_state: not_applied\n",
      ],
      [
        "run-changed",
        "kind: patch\nmeta:\n  capturedNoGitChange: false\n  apply_state: not_applied\n",
      ],
      ["run-refused", "kind: patch\nmeta:\n  capture_refused: true\n  apply_state: not_applied\n"],
      ["run-taken", "kind: patch\nmeta:\n  apply_state: not_applied\n"],
      ["run-files", "kind: files\nmeta:\n  apply_state: not_applied\n"],
      ["run-legacy", "kind: patch\nmeta:\n  apply_state: not_applied\n"],
    ] as const;
    for (const [runId, workProduct] of rows) {
      const runDir = seedRun(project.runsDir, runId, { workProduct });
      if (runId === "run-taken")
        writeFileSync(
          join(runDir, "final/delivery_state.yaml"),
          "applyState: not_applied\ntakenAt: 2026-07-01T00:00:00.000Z\ntakenReason: captured_result\n",
        );
    }
    const receipt = await runRetentionPass(
      { ...POLICY, keepLastRunsPerProject: 0 },
      { dry_run: false },
      deps(project, {
        records: () =>
          rows.map(([runId]) => ({ runId, state: "succeeded", finishedAt: daysAgo(90) })),
      }),
    );
    expect(receipt.deleted_runs.map((row) => row.run_id).sort()).toEqual([
      "run-no-change",
      "run-taken",
    ]);
    expect(receipt.kept.actionable).toBe(4);
    for (const runId of ["run-changed", "run-refused", "run-files", "run-legacy"])
      expect(existsSync(join(project.runsDir, runId, "final/work_product.yaml"))).toBe(true);
  });
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

  it("reports NON-engine top-level data-root entries by name, never engine-owned ones (default mode)", async () => {
    const { project, root } = sandbox();
    const dataRoot = join(root, "data-root");
    // Engine-owned (current + legacy) and dotfile entries must NOT be listed.
    // "remote" is engine-managed (harness-installer's pinned vendor prefix).
    for (const owned of ["v3", "node", "profiles", "runtime", "daemon", "remote"]) {
      mkdirSync(join(dataRoot, owned), { recursive: true });
    }
    writeFileSync(join(dataRoot, "config.yaml"), "retention: {}\n");
    writeFileSync(join(dataRoot, ".DS_Store"), "");
    // Foreign operator debris (dirs and files alike) IS listed, sorted.
    // "isolated" is operator scratch, not engine-owned — it is foreign too.
    // In the DEFAULT root mode the engine keeps secrets.json, plugins, quota
    // and workspaces under the v3 subtree, so top-level copies are foreign.
    mkdirSync(join(dataRoot, "isolated"), { recursive: true });
    mkdirSync(join(dataRoot, "reviews"), { recursive: true });
    mkdirSync(join(dataRoot, "my-scratch"), { recursive: true });
    writeFileSync(join(dataRoot, "notes.txt"), "n");
    mkdirSync(join(dataRoot, "plugins"), { recursive: true });
    mkdirSync(join(dataRoot, "quota"), { recursive: true });
    mkdirSync(join(dataRoot, "workspaces"), { recursive: true });
    writeFileSync(join(dataRoot, "secrets.json"), "{}\n");

    const receipt = await runRetentionPass(
      POLICY,
      { dry_run: true, data_root_report: true },
      {
        ...deps(project),
        dataRoot,
      },
    );
    expect(receipt.data_root_unrecognized).toEqual([
      "isolated",
      "my-scratch",
      "notes.txt",
      "plugins",
      "quota",
      "reviews",
      "secrets.json",
      "workspaces",
    ]);
    expect(receipt.errors).toEqual([]);
  });

  it.each([
    {
      mode: undefined,
      expected: ["plugins", "quota", "secrets.json", "v1", "workspaces"],
    },
    {
      mode: "override" as const,
      expected: ["v1", "v2", "v3"],
    },
  ])("preserves the complete owned-name inventory in $mode mode", async ({ mode, expected }) => {
    const { project, root } = sandbox();
    const dataRoot = join(root, "data-root");
    mkdirSync(dataRoot, { recursive: true });
    const commonDirectories = [
      "node",
      "profiles",
      "runtime",
      "cache",
      "dogfood",
      "keys",
      "release-authority",
      "planning",
      "remote",
      "daemon",
      "projects",
      "native",
      "runs",
      "trust",
      "telemetry",
    ];
    for (const name of commonDirectories) seedDataRootEntry(dataRoot, name, "directory");
    seedDataRootEntry(dataRoot, "config.yaml", "file");
    for (const name of ["v1", "v2", "v3", "plugins", "quota", "workspaces"]) {
      seedDataRootEntry(dataRoot, name, "directory");
    }
    seedDataRootEntry(dataRoot, "secrets.json", "file");

    const receipt = await runRetentionPass(
      POLICY,
      { dry_run: true, data_root_report: true },
      {
        ...deps(project),
        dataRoot,
        ...(mode === undefined ? {} : { dataRootMode: mode }),
      },
    );
    expect(receipt.data_root_unrecognized).toEqual(expected);
    expect(receipt.errors).toEqual([]);
  });

  it("reports the default v1/v2/v3 matrix and keeps unrelated names sorted", async () => {
    const { project, root } = sandbox();
    const dataRoot = join(root, "data-root");
    for (const name of ["v1", "v2", "v3", "z-scratch", "a-scratch"]) {
      mkdirSync(join(dataRoot, name), { recursive: true });
    }
    const receipt = await runRetentionPass(
      POLICY,
      { dry_run: true, data_root_report: true },
      { ...deps(project), dataRoot },
    );
    expect(receipt.data_root_unrecognized).toEqual(["a-scratch", "v1", "z-scratch"]);
    expect(receipt.errors).toEqual([]);
  });

  it("reports v1/v2/v3 as plain unrecognized names under an explicit override", async () => {
    const { project, root } = sandbox();
    const dataRoot = join(root, "data-root");
    for (const name of ["v1", "v2", "v3", "scratch"]) {
      mkdirSync(join(dataRoot, name), { recursive: true });
    }
    const receipt = await runRetentionPass(
      POLICY,
      { dry_run: true, data_root_report: true },
      { ...deps(project), dataRoot, dataRootMode: "override" },
    );
    expect(receipt.data_root_unrecognized).toEqual(["scratch", "v1", "v2", "v3"]);
    expect(receipt.errors).toEqual([]);
  });

  it("keeps default v1/v2/v3 bytes untouched in a non-dry advisory scan", async () => {
    const { project, root } = sandbox();
    const dataRoot = join(root, "data-root");
    const markers = new Map<string, string>();
    for (const name of ["v1", "v2", "v3"]) {
      const marker = `${name}-sentinel-${name.repeat(2)}\n`;
      markers.set(name, marker);
      mkdirSync(join(dataRoot, name), { recursive: true });
      writeFileSync(join(dataRoot, name, "marker.txt"), marker);
    }
    const receipt = await runRetentionPass(
      { ...POLICY, keepLastRunsPerProject: 0 },
      { dry_run: false, data_root_report: true },
      { ...deps(project), dataRoot },
    );
    expect(receipt.data_root_unrecognized).toEqual(["v1"]);
    expect(receipt.deleted_runs).toEqual([]);
    expect(receipt.deleted_reviews).toEqual([]);
    expect(receipt.freed_bytes).toBe(0);
    for (const [name, marker] of markers) {
      expect(readFileSync(join(dataRoot, name, "marker.txt"), "utf8")).toBe(marker);
    }
  });

  it("reports default generation names with unexpected kinds without following symlinks", async () => {
    const { project, root } = sandbox();
    const dataRoot = join(root, "data-root");
    const target = join(root, "elsewhere");
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "sentinel.txt"), "outside\n");
    symlinkSync(target, join(dataRoot, "v2"));
    writeFileSync(join(dataRoot, "v3"), "not a directory\n");
    const receipt = await runRetentionPass(
      POLICY,
      { dry_run: true, data_root_report: true },
      { ...deps(project), dataRoot },
    );
    expect(receipt.data_root_unrecognized).toEqual([
      "v2 (unexpected-kind)",
      "v3 (unexpected-kind)",
    ]);
    expect(readFileSync(join(target, "sentinel.txt"), "utf8")).toBe("outside\n");
    expect(receipt.errors).toEqual([]);
  });

  it("reports an owned NAME with the wrong on-disk kind as `<name> (unexpected-kind)`", async () => {
    const { project, root } = sandbox();
    const dataRoot = join(root, "data-root");
    mkdirSync(dataRoot, { recursive: true });
    // A plain FILE where the engine expects the `v3` directory.
    writeFileSync(join(dataRoot, "v3"), "not a directory");
    // A SYMLINK under an owned name (even one pointing at a real directory) —
    // the scan reads dirents WITHOUT following links and flags it.
    const target = join(root, "elsewhere");
    mkdirSync(target, { recursive: true });
    const { symlinkSync } = await import("node:fs");
    symlinkSync(target, join(dataRoot, "runtime"));
    // A healthy owned directory and owned file stay unreported.
    mkdirSync(join(dataRoot, "node"), { recursive: true });
    writeFileSync(join(dataRoot, "config.yaml"), "retention: {}\n");

    const receipt = await runRetentionPass(
      POLICY,
      { dry_run: true, data_root_report: true },
      {
        ...deps(project),
        dataRoot,
      },
    );
    expect(receipt.data_root_unrecognized).toEqual([
      "runtime (unexpected-kind)",
      "v3 (unexpected-kind)",
    ]);
    expect(receipt.errors).toEqual([]);
  });

  it("the kind check is SYMMETRIC: a directory under an owned FILE name is flagged", async () => {
    const { project, root } = sandbox();
    const dataRoot = join(root, "data-root");
    // config.yaml must be a regular file in every mode; secrets.json must be
    // a regular file in override mode (where the name is owned at all).
    mkdirSync(join(dataRoot, "config.yaml"), { recursive: true });
    mkdirSync(join(dataRoot, "secrets.json"), { recursive: true });

    const receipt = await runRetentionPass(
      POLICY,
      { dry_run: true, data_root_report: true },
      {
        ...deps(project),
        dataRoot,
        dataRootMode: "override",
      },
    );
    expect(receipt.data_root_unrecognized).toEqual([
      "config.yaml (unexpected-kind)",
      "secrets.json (unexpected-kind)",
    ]);
    expect(receipt.errors).toEqual([]);
  });

  it("the report is the FULL sorted list, never truncated to a bound", async () => {
    const { project, root } = sandbox();
    const dataRoot = join(root, "data-root");
    mkdirSync(dataRoot, { recursive: true });
    const names = Array.from({ length: 80 }, (_, i) => `foreign-${String(i).padStart(3, "0")}`);
    for (const name of names) mkdirSync(join(dataRoot, name), { recursive: true });

    const receipt = await runRetentionPass(
      POLICY,
      { dry_run: true, data_root_report: true },
      {
        ...deps(project),
        dataRoot,
      },
    );
    expect(receipt.data_root_unrecognized).toEqual(names);
  });

  it("a clean data root reports an EMPTY list (scanned, nothing foreign)", async () => {
    const { project, root } = sandbox();
    const dataRoot = join(root, "data-root");
    mkdirSync(join(dataRoot, "v3"), { recursive: true });
    const receipt = await runRetentionPass(
      POLICY,
      { dry_run: true, data_root_report: true },
      {
        ...deps(project),
        dataRoot,
      },
    );
    expect(receipt.data_root_unrecognized).toEqual([]);
  });

  it("a request WITHOUT data_root_report gets no scan and an absent field (skew-safe shape)", async () => {
    const { project, root } = sandbox();
    const dataRoot = join(root, "data-root");
    mkdirSync(join(dataRoot, "definitely-foreign"), { recursive: true });
    // The dataRoot is injected (a current daemon), but the client did not opt
    // in — exactly what an old CLI sends. The receipt must be byte-compatible
    // with the pre-feature shape: no field, not an empty list.
    const receipt = await runRetentionPass(
      POLICY,
      { dry_run: true },
      {
        ...deps(project),
        dataRoot,
      },
    );
    expect(receipt.data_root_unrecognized).toBeUndefined();
    expect("data_root_unrecognized" in receipt).toBe(false);
    expect(receipt.errors).toEqual([]);
  });

  it("a failed data-root scan leaves the field ABSENT and discloses the error", async () => {
    const { project, root } = sandbox();
    const receipt = await runRetentionPass(
      POLICY,
      { dry_run: true, data_root_report: true },
      {
        ...deps(project),
        dataRoot: join(root, "does-not-exist"),
      },
    );
    expect(receipt.data_root_unrecognized).toBeUndefined();
    expect(receipt.errors.join("\n")).toContain("data root scan");
    // The advisory scan must never fail the pass itself.
    expect(receipt.dry_run).toBe(true);
  });

  it("no injected data root means no scan and an absent field even when requested", async () => {
    const { project } = sandbox();
    const receipt = await runRetentionPass(
      POLICY,
      { dry_run: true, data_root_report: true },
      deps(project),
    );
    expect(receipt.data_root_unrecognized).toBeUndefined();
    expect(receipt.errors).toEqual([]);
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
