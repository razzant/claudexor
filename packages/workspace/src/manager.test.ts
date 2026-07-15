import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { summarizeDiffPaths } from "@claudexor/core";
import { projectRuntimeDir } from "@claudexor/util";
import {
  applyPatchProtected,
  ensureGitRepository,
  git,
  isGitRepo,
  revParse,
  revertWorkingTreePatch,
  revertWorkingTreeTo,
  snapshotTree,
} from "./git.js";
import { createRevertAnchor, readRevertAnchor } from "./anchor-store.js";
import { WorkspaceManager } from "./manager.js";
import { advanceThreadWorktree, ensureThreadWorktree, purgeThreadWorktree } from "./thread-tree.js";

describe("revertWorkingTreeTo", () => {
  it("restores a modified file, removes a turn-added file, and refuses when the tree diverged", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claudexor-revert-"));
    await git(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "keep.ts"), "original\n");
    writeFileSync(join(repo, "other.ts"), "other original\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["-c", "user.email=t@t.dev", "-c", "user.name=Test", "commit", "-m", "init"]);

    const preTurn = await snapshotTree(repo); // clean -> HEAD
    // The "turn" mutates the live tree: edit a tracked file + add a new one.
    writeFileSync(join(repo, "keep.ts"), "MUTATED by the turn\n");
    writeFileSync(join(repo, "added.ts"), "new file from the turn\n");
    const postTurn = await snapshotTree(repo);

    // A later user edit outside the turn-owned patch (including staged index
    // state) must survive the scoped reverse apply byte-for-byte.
    writeFileSync(join(repo, "other.ts"), "later user edit\n");
    await git(repo, ["add", "--", "other.ts"]);
    const indexRel = (await git(repo, ["rev-parse", "--git-path", "index"])).stdout.trim();
    const indexPath = isAbsolute(indexRel) ? indexRel : resolve(repo, indexRel);
    const indexBefore = readFileSync(indexPath);

    // Happy path: turn-owned hunks still equal postTurn -> restore only them.
    const r1 = await revertWorkingTreeTo(repo, preTurn, postTurn);
    expect(r1.reverted).toBe(true);
    expect(r1.removed).toContain("added.ts");
    expect(readFileSync(join(repo, "keep.ts"), "utf8")).toBe("original\n");
    expect(existsSync(join(repo, "added.ts"))).toBe(false);
    expect(readFileSync(join(repo, "other.ts"), "utf8")).toBe("later user edit\n");
    expect(readFileSync(indexPath).equals(indexBefore)).toBe(true);

    // Divergence fence: re-mutate then ask to revert against the STALE postTurn.
    writeFileSync(join(repo, "keep.ts"), "edited again after the turn\n");
    const r2 = await revertWorkingTreeTo(repo, preTurn, postTurn);
    expect(r2.reverted).toBe(false);
    expect(r2.reason).toMatch(/postimage no longer matches|user edits/);
    // The refused revert touched nothing.
    expect(readFileSync(join(repo, "keep.ts"), "utf8")).toBe("edited again after the turn\n");
  });
});

async function initRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "claudexor-ws-"));
  await git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# test\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["-c", "user.email=t@t.dev", "-c", "user.name=Test", "commit", "-m", "init"]);
  return repo;
}

describe("WorkspaceManager", () => {
  it("does not bridge the macOS login keychain into generic scoped homes", async () => {
    const repo = await initRepo();
    const mgr = new WorkspaceManager(repo);
    const env = await mgr.create({ taskId: "task-keychain", attemptId: "a01", baseRef: "HEAD" });
    expect(existsSync(join(env.home_dir, "Library", "Keychains"))).toBe(false);
    expect(env.home_dir).not.toBe(process.env.HOME);
    expect(env.harness_config_dirs["cursor_config"]).toBe(join(env.home_dir, ".cursor"));
    await mgr.dispose(env);
  });

  it("creates an isolated worktree with scoped dirs and captures a diff", async () => {
    const repo = await initRepo();
    const mgr = new WorkspaceManager(repo);
    const env = await mgr.create({ taskId: "task-1", attemptId: "a01", baseRef: "HEAD" });

    expect(existsSync(env.worktree_path)).toBe(true);
    expect(existsSync(env.harness_config_dirs["codex_home"] as string)).toBe(true);

    const scoped = mgr.envFor(env);
    expect(scoped.HOME).toBe(env.home_dir);
    expect(scoped.CODEX_HOME).toContain(".codex");
    expect(scoped.CLAUDE_CONFIG_DIR).toContain(".claude");

    writeFileSync(join(env.worktree_path, "NEW.txt"), "hello world\n");
    // Simulate a harness writing secrets/state into its scoped HOME (e.g. codex auth.json).
    writeFileSync(
      join(env.harness_config_dirs["codex_home"] as string, "auth.json"),
      '{"OPENAI_API_KEY":"sk-secret"}\n',
    );
    const diff = await mgr.diff(env);
    expect(diff).toContain("NEW.txt");
    expect(diff).toContain("hello world");
    // Scoped HOME lives outside the worktree, so its contents must never leak into the diff.
    expect(diff).not.toContain("auth.json");
    expect(diff).not.toContain("sk-secret");

    await mgr.dispose(env);
    expect(existsSync(env.worktree_path)).toBe(false);
    // Dispose also removes the scoped dirs (no lingering credentials).
    expect(existsSync(env.home_dir)).toBe(false);
  });

  it("capture/create/diff/dispose preserves the live index and arbitrary project .claudexor bytes", async () => {
    const repo = await initRepo();
    mkdirSync(join(repo, ".claudexor"), { recursive: true });
    const ignorePath = join(repo, ".claudexor", ".gitignore");
    const ignoreBytes = Buffer.from("# user-owned\r\n!keep-this\r\n", "utf8");
    writeFileSync(ignorePath, ignoreBytes);
    chmodSync(ignorePath, 0o640);
    await git(repo, ["add", "--", ".claudexor/.gitignore"]);
    await git(repo, [
      "-c",
      "user.email=t@t.dev",
      "-c",
      "user.name=Test",
      "commit",
      "-m",
      "user config",
    ]);

    // Preserve a pre-existing staged change, an unstaged edit, and a legal
    // newline-bearing untracked filename through every capture path.
    writeFileSync(join(repo, "staged.txt"), "already staged\n");
    await git(repo, ["add", "--", "staged.txt"]);
    writeFileSync(join(repo, "README.md"), "# unstaged user edit\n");
    writeFileSync(join(repo, "line\nbreak.txt"), "untracked\n");

    const indexRel = (await git(repo, ["rev-parse", "--git-path", "index"])).stdout.trim();
    const indexPath = isAbsolute(indexRel) ? indexRel : resolve(repo, indexRel);
    const indexBefore = readFileSync(indexPath);
    const statusBefore = (
      await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    ).stdout;
    const ignoreModeBefore = statSync(ignorePath).mode & 0o777;

    const manager = new WorkspaceManager(repo);
    const env = await manager.create({
      taskId: "safe-state",
      attemptId: "a01",
      dirtyPolicy: "snapshot",
    });
    writeFileSync(join(env.worktree_path, "candidate.txt"), "candidate\n");
    const diff = await manager.diff(env);
    expect(diff).toContain("candidate.txt");
    await manager.dispose(env);

    expect(readFileSync(indexPath).equals(indexBefore)).toBe(true);
    expect(
      (await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout,
    ).toBe(statusBefore);
    expect(readFileSync(ignorePath).equals(ignoreBytes)).toBe(true);
    expect(statSync(ignorePath).mode & 0o777).toBe(ignoreModeBefore);
    expect(existsSync(join(repo, ".claudexor", "workspaces"))).toBe(false);
    expect(existsSync(join(repo, ".claudexor-review-evidence"))).toBe(false);
  });

  it("snapshotTree succeeds in-place when the project gitignores .claudexor (the v0.10 bug)", async () => {
    const repo = await initRepo();
    // The project ignores .claudexor in ITS OWN .gitignore — the failing case the
    // user hit on an in-place agent turn ("paths are ignored ... use -f").
    writeFileSync(join(repo, ".gitignore"), ".claudexor\n.claudexor-review-evidence\n");
    await git(repo, ["add", "-A"]);
    await git(repo, [
      "-c",
      "user.email=t@t.dev",
      "-c",
      "user.name=Test",
      "commit",
      "-m",
      "gitignore .claudexor",
    ]);
    // Materialize the self-ignored run dir (mirrors a concurrent in-place turn).
    mkdirSync(join(repo, ".claudexor", "runs", "run-x"), { recursive: true });
    writeFileSync(join(repo, ".claudexor", ".gitignore"), "*\n");
    writeFileSync(join(repo, ".claudexor", "runs", "run-x", "artifact.txt"), "run artifact\n");
    // A genuine dirty user edit so the snapshot path runs (not the clean->HEAD shortcut).
    writeFileSync(join(repo, "user-edit.txt"), "dirty work\n");

    // Used to throw `snapshot add -A failed: ... paths are ignored ... use -f`.
    const snap = await snapshotTree(repo);
    const head = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
    expect(snap).not.toBe(head); // a real dirty snapshot, not the clean fallback
    // The snapshot captures the user edit but never the gitignored .claudexor artifacts.
    const tree = (await git(repo, ["ls-tree", "-r", "--name-only", snap])).stdout;
    expect(tree).toContain("user-edit.txt");
    expect(tree).not.toContain(".claudexor");
  });

  it("refuses a dirty repo by default, allows snapshot", async () => {
    const repo = await initRepo();
    writeFileSync(join(repo, "README.md"), "# changed (uncommitted)\n");
    const mgr = new WorkspaceManager(repo);

    await expect(mgr.create({ taskId: "t2", attemptId: "a01" })).rejects.toThrow(/dirty/);

    const env = await mgr.create({ taskId: "t3", attemptId: "a01", dirtyPolicy: "snapshot" });
    expect(existsSync(env.worktree_path)).toBe(true);
    await mgr.dispose(env);
  });

  it("in-place: works on a non-git dir, diffs via snapshot, and dispose never deletes the live tree", async () => {
    // A plain (non-git) directory stands in for a stateful external environment.
    const dir = mkdtempSync(join(tmpdir(), "claudexor-inplace-"));
    writeFileSync(join(dir, "a.txt"), "one\n");
    const mgr = new WorkspaceManager(dir);

    const env = await mgr.create({ taskId: "t-ip", attemptId: "converge", inPlace: true });
    // The envelope points at the live tree; base_sha is null (no git) and scoped HOME is outside it.
    expect(env.worktree_path).toBe(dir);
    expect(env.base_sha).toBeNull();
    expect(existsSync(env.harness_config_dirs["codex_home"] as string)).toBe(true);
    // In-place records the EFFECTIVE dirty policy (dirty state folds into the
    // per-turn base snapshot), never echoing an ignored request.
    expect(env.dirty_policy).toBe("snapshot");

    // Simulate the harness mutating the live tree in place (incl. a file
    // under a path that repo-relative protected globs like `test/**` watch).
    writeFileSync(join(dir, "a.txt"), "two\n");
    writeFileSync(join(dir, "b.txt"), "new file\n");
    mkdirSync(join(dir, "test"), { recursive: true });
    writeFileSync(join(dir, "test", "guard.spec.js"), "// protected\n");
    const diff = await mgr.diff(env);
    expect(diff).toContain("b.txt");
    // Headers are RELATIVIZED to git-style a/<rel> b/<rel>: repo-relative
    // policy globs must see `test/guard.spec.js`, never an absolute
    // /tmp/.../test/... path they can never match (protected-path bypass).
    const paths = summarizeDiffPaths(diff);
    expect(paths.paths).toContain("b.txt");
    expect(paths.paths).toContain("test/guard.spec.js");
    expect(paths.paths.every((p) => !p.startsWith("/"))).toBe(true);

    await mgr.dispose(env);
    // The live tree and its files survive dispose (never rm the repo root)...
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, "a.txt"))).toBe(true);
    expect(existsSync(join(dir, "b.txt"))).toBe(true);
    // ...but the scoped envelope base (home + baseline) is removed.
    expect(existsSync(env.home_dir)).toBe(false);
    expect(existsSync(join(projectRuntimeDir(dir), "workspaces", "t-ip", "converge"))).toBe(false);
  });

  it("in-place non-git: header relativization never rewrites hunk CONTENT that looks like a header (INV-041)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-inplace-fidelity-"));
    // Content lines that RENDER as `--- `/`+++ ` in a unified diff: a removed
    // line starting `-- <baseline path>` and an added line starting
    // `++ <live path>`. The relativizer must leave those bytes alone while
    // still relativizing the real file header.
    writeFileSync(join(dir, "notes.txt"), `keep\n-- ${dir}/replaced\n`);
    const mgr = new WorkspaceManager(dir);
    const env = await mgr.create({ taskId: "t-fid", attemptId: "converge", inPlace: true });
    writeFileSync(join(dir, "notes.txt"), `keep\n++ ${dir}/added\n`);
    const diff = await mgr.diff(env);
    // Real header relativized: policy sees repo-relative notes.txt.
    expect(summarizeDiffPaths(diff).paths).toContain("notes.txt");
    // Content bytes untouched: the removed/added CONTENT lines still carry
    // the raw absolute paths and were never rewritten to a/ b/ shape.
    expect(diff).toContain(`--- ${dir}/replaced`);
    expect(diff).toContain(`+++ ${dir}/added`);
    expect(diff).not.toContain("--- b/replaced");
    expect(diff).not.toContain("+++ b/added");
    await mgr.dispose(env);
  });

  it("relativizer: a mid-hunk FORGED full triple (---/+++/@@ from content) is never rewritten without a header witness", () => {
    // The parser demands a GNU timestamp (or /dev/null) witness on mid-hunk
    // header lines; the relativizer must apply the SAME bar. Here hunk content
    // forges the loose triple: a removed `-- <path>` line, an added
    // `++ <path>` line, then the NEXT hunk's real `@@` header.
    const base = "/tmp/claudexor-forge/baseline";
    const live = "/tmp/claudexor-forge/live";
    const doc = [
      `diff -ruN ${base}/notes.txt ${live}/notes.txt`,
      `--- ${base}/notes.txt\t2026-01-01 00:00:00`,
      `+++ ${live}/notes.txt\t2026-01-01 00:00:01`,
      "@@ -1,3 +1,3 @@",
      " keep",
      `--- ${base}/forged-old`, // removed content line, rendered with --- prefix
      `+++ ${live}/forged-new`, // added content line, rendered with +++ prefix
      "@@ -10,2 +10,2 @@",
      " tail",
      `-old ${base}/inline`,
      `+new ${live}/inline`,
      "",
    ].join("\n");
    type Relativize = (text: string, baselineRoot: string, liveRoot: string) => string;
    const relativize = (WorkspaceManager as unknown as Record<string, Relativize>)[
      "relativizePlainDiffHeadersFor"
    ] as Relativize;
    const out = relativize(doc, base, live);
    // Real header (witnessed by timestamps) relativized.
    expect(out).toContain("--- a/notes.txt\t2026-01-01 00:00:00");
    expect(out).toContain("+++ b/notes.txt\t2026-01-01 00:00:01");
    // Forged mid-hunk triple: content bytes untouched.
    expect(out).toContain(`--- ${base}/forged-old`);
    expect(out).toContain(`+++ ${live}/forged-new`);
    expect(out).not.toContain("--- a/forged-old");
    expect(out).not.toContain("+++ b/forged-new");
    // Ordinary +/- content lines with absolute paths are untouched too.
    expect(out).toContain(`-old ${base}/inline`);
    expect(out).toContain(`+new ${live}/inline`);
  });

  it("in-place on a GIT repo: per-turn diff shows only this turn's net change", async () => {
    const repo = await initRepo();
    // A prior turn already left an uncommitted edit in the live tree.
    writeFileSync(join(repo, "prior.txt"), "from an earlier turn\n");
    const mgr = new WorkspaceManager(repo);

    // This turn's envelope snapshots the current (dirty) tree as its base.
    const env = await mgr.create({ taskId: "th-1", attemptId: "turn-2", inPlace: true });
    expect(env.worktree_path).toBe(repo);
    expect(env.base_sha).not.toBeNull(); // git mode records a snapshot sha

    // The harness mutates the live tree in place.
    writeFileSync(join(repo, "added.txt"), "this turn\n");
    writeFileSync(join(repo, "README.md"), "# test\nthis turn edit\n");
    const diff = await mgr.diff(env);
    expect(diff).toContain("added.txt");
    expect(diff).toContain("this turn edit");
    // Pre-existing dirty state was folded into the base, so it is NOT this turn's change.
    expect(diff).not.toContain("prior.txt");
    await mgr.dispose(env);
    // dispose never deletes the live tree in in-place mode.
    expect(existsSync(join(repo, "added.txt"))).toBe(true);
  });

  it("ensureThreadWorktree creates a reusable isolated worktree off the project snapshot", async () => {
    const repo = await initRepo();
    writeFileSync(join(repo, "live.txt"), "uncommitted project state\n");
    const first = await ensureThreadWorktree(repo, "th-iso");
    expect(first.created).toBe(true);
    expect(existsSync(join(first.path, ".git"))).toBe(true);
    // The worktree is seeded from the snapshot, so it carries the uncommitted state.
    expect(existsSync(join(first.path, "live.txt"))).toBe(true);
    // Reuse returns the same path without recreating.
    const second = await ensureThreadWorktree(repo, "th-iso");
    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);
    expect(second.baseSha).toBe(first.baseSha);
    // Runtime is external: no project `.claudexor` or ignore file is created.
    expect(first.path.startsWith(projectRuntimeDir(repo))).toBe(true);
    expect(existsSync(join(repo, ".claudexor"))).toBe(false);
  });

  it("advances the persistent thread branch so its delivered base survives git gc", async () => {
    const repo = await initRepo();
    const wt = await ensureThreadWorktree(repo, "th-gc");
    writeFileSync(join(wt.path, "delivered.txt"), "delivered\n");
    writeFileSync(join(repo, "delivered.txt"), "delivered\n");
    const target = await snapshotTree(repo);

    expect(await advanceThreadWorktree(repo, "th-gc", wt.path, target)).toBe(target);
    expect((await git(wt.path, ["status", "--porcelain"])).stdout).toBe("");
    expect(await revParse(repo, "claudexor/thread-th-gc")).toBe(target);

    await git(repo, ["worktree", "remove", "--force", wt.path]);
    await git(repo, ["reflog", "expire", "--expire=now", "--all"]);
    await git(repo, ["gc", "--prune=now"]);
    const restored = await ensureThreadWorktree(repo, "th-gc");
    expect(restored.baseSha).toBe(target);
    expect(readFileSync(join(restored.path, "delivered.txt"), "utf8")).toBe("delivered\n");
  });

  it("does not publish the thread branch when worktree realignment fails", async () => {
    const repo = await initRepo();
    const wt = await ensureThreadWorktree(repo, "th-realign-fail");
    const original = await revParse(repo, "claudexor/thread-th-realign-fail");
    writeFileSync(join(repo, "new-file.txt"), "new target content\n");
    const target = await snapshotTree(repo);
    chmodSync(wt.path, 0o500);
    try {
      await expect(advanceThreadWorktree(repo, "th-realign-fail", wt.path, target)).rejects.toThrow(
        /realignment failed/,
      );
      expect(await revParse(repo, "claudexor/thread-th-realign-fail")).toBe(original);
    } finally {
      chmodSync(wt.path, 0o700);
    }
  });

  it("reverts from an external content-addressed anchor after snapshot GC", async () => {
    const repo = await initRepo();
    const pre = await snapshotTree(repo);
    writeFileSync(join(repo, "README.md"), "# changed by turn\n");
    const post = await snapshotTree(repo);
    const anchorId = await createRevertAnchor(repo, pre, post);

    await git(repo, ["reflog", "expire", "--expire=now", "--all"]);
    await git(repo, ["gc", "--prune=now"]);
    const reverted = await revertWorkingTreePatch(repo, readRevertAnchor(repo, anchorId));

    expect(reverted.reverted).toBe(true);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("# test\n");
  });

  it("purges only the owned isolated worktree and persistent branch", async () => {
    const repo = await initRepo();
    const wt = await ensureThreadWorktree(repo, "th-purge");
    expect(await revParse(repo, "claudexor/thread-th-purge")).toBe(wt.baseSha);

    await purgeThreadWorktree(repo, "th-purge");

    expect(existsSync(wt.path)).toBe(false);
    expect((await git(repo, ["rev-parse", "--verify", "claudexor/thread-th-purge"])).code).not.toBe(
      0,
    );
    expect(existsSync(join(repo, "README.md"))).toBe(true);
  });

  it("snapshotTree + applyPatch work INSIDE a linked worktree (.git is a file there)", async () => {
    // Regression for review #8/#9: a worktree's `.git` is a FILE (gitdir pointer),
    // so scratch index / patch paths must NOT live under `<worktree>/.git`.
    const repo = await initRepo();
    const wt = await ensureThreadWorktree(repo, "th-wt");
    // Dirty the worktree, then snapshot it (used to fail with "Not a directory").
    writeFileSync(join(wt.path, "wt-change.txt"), "edited in worktree\n");
    const snap = await snapshotTree(wt.path);
    expect(snap).not.toBe(wt.baseSha); // a real snapshot sha, not a crash
    const diff = await new WorkspaceManager(wt.path).diff(
      // craft an in-place envelope pointing at the worktree
      {
        worktree_path: wt.path,
        repo_root: wt.path,
        base_sha: wt.baseSha,
        task_id: "t",
        attempt_id: "a",
      } as never,
    );
    expect(diff).toContain("wt-change.txt");
    // Adopt a patch into the worktree (race-winner path) — must not throw.
    const patch =
      "diff --git a/adopted.txt b/adopted.txt\nnew file mode 100644\nindex 0000000..0905ab8\n--- /dev/null\n+++ b/adopted.txt\n@@ -0,0 +1 @@\n+adopted\n";
    expect((await applyPatchProtected(wt.path, patch)).ok).toBe(true);
    expect(existsSync(join(wt.path, "adopted.txt"))).toBe(true);
  });

  it("snapshotTree returns HEAD for a clean tree and a new sha for a dirty tree", async () => {
    const repo = await initRepo();
    const head = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
    expect(await snapshotTree(repo)).toBe(head); // clean -> HEAD
    writeFileSync(join(repo, "dirty.txt"), "x\n");
    const dirty = await snapshotTree(repo);
    expect(dirty).not.toBe(head); // dirty -> dangling snapshot commit
  });

  it("captures committed-by-harness work in the diff (vs base_sha, not worktree HEAD)", async () => {
    const repo = await initRepo();
    const mgr = new WorkspaceManager(repo);
    const env = await mgr.create({ taskId: "task-commit", attemptId: "a01", baseRef: "HEAD" });
    // Simulate a harness that COMMITS its work inside the worktree (Claude Code does this
    // routinely). Diffing vs HEAD would now be empty (work is committed, no index delta);
    // diffing vs base_sha must still surface it, or the candidate's output is silently lost.
    writeFileSync(join(env.worktree_path, "feature.ts"), "export const x = 1;\n");
    await git(env.worktree_path, ["add", "-A"]);
    await git(env.worktree_path, [
      "-c",
      "user.email=h@h.dev",
      "-c",
      "user.name=Harness",
      "commit",
      "-m",
      "harness work",
    ]);
    const diff = await mgr.diff(env);
    expect(diff).toContain("feature.ts");
    expect(diff).toContain("export const x = 1;");
    await mgr.dispose(env);
  });

  it("deletes the per-attempt branch on dispose so a same-id re-attempt does not collide", async () => {
    const repo = await initRepo();
    const mgr = new WorkspaceManager(repo);
    const env1 = await mgr.create({ taskId: "task-gc", attemptId: "a01", baseRef: "HEAD" });
    const branch = env1.branch_name;
    expect((await git(repo, ["rev-parse", "--verify", branch])).code).toBe(0);
    await mgr.dispose(env1);
    // Branch is gone (no permanent claudexor/* leak)...
    expect((await git(repo, ["rev-parse", "--verify", branch])).code).not.toBe(0);
    // ...the empty per-task dir was pruned...
    expect(existsSync(join(projectRuntimeDir(repo), "workspaces", "task-gc"))).toBe(false);
    // ...and a re-attempt with the SAME ids succeeds (previously collided on worktree add -b).
    const env2 = await mgr.create({ taskId: "task-gc", attemptId: "a01", baseRef: "HEAD" });
    expect(existsSync(env2.worktree_path)).toBe(true);
    await mgr.dispose(env2);
  });

  it("snapshot dirty policy includes UNTRACKED files (no silent drop)", async () => {
    const repo = await initRepo();
    // Only an untracked file is dirty: `git stash create` would have ignored it
    // entirely (tracked-only), dropping it from the run base. The temp-index
    // snapshot must carry it through.
    writeFileSync(join(repo, "untracked.txt"), "fresh\n");
    const mgr = new WorkspaceManager(repo);
    const env = await mgr.create({
      taskId: "task-snap",
      attemptId: "a01",
      dirtyPolicy: "snapshot",
    });
    expect(existsSync(join(env.worktree_path, "untracked.txt"))).toBe(true);
    await mgr.dispose(env);
  });
});

describe("ensureGitRepository", () => {
  it("initializes a non-git folder without creating .gitignore and makes a baseline commit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-ensure-"));
    writeFileSync(join(dir, "data.txt"), "hello\n");
    const result = await ensureGitRepository(dir);
    expect(result.initialized).toBe(true);
    expect(result.baselineCommitted).toBe(true);
    expect(result.gitignoreSeeded).toBe(false);
    expect(result.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await isGitRepo(dir)).toBe(true);
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
    const tracked = await git(dir, ["ls-files"]);
    expect(tracked.stdout).toContain("data.txt");
    expect(tracked.stdout).not.toContain(".gitignore");
    const author = await git(dir, ["log", "-1", "--format=%an"]);
    expect(author.stdout.trim()).toBe("Claudexor");
  });

  it("creates a baseline commit for a repo with an unborn HEAD", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-ensure-"));
    await git(dir, ["init", "-b", "main"]);
    writeFileSync(join(dir, "x.txt"), "x\n");
    const result = await ensureGitRepository(dir);
    expect(result.initialized).toBe(false);
    expect(result.baselineCommitted).toBe(true);
    expect((await git(dir, ["rev-parse", "--verify", "HEAD"])).code).toBe(0);
  });

  it("is a no-op for a healthy repo and never rewrites an existing .gitignore entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-ensure-"));
    await git(dir, ["init", "-b", "main"]);
    writeFileSync(join(dir, ".gitignore"), ".claudexor/\nnode_modules/\n");
    writeFileSync(join(dir, "y.txt"), "y\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["-c", "user.email=t@t.dev", "-c", "user.name=Test", "commit", "-m", "init"]);
    const before = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
    const result = await ensureGitRepository(dir);
    expect(result.initialized).toBe(false);
    expect(result.baselineCommitted).toBe(false);
    expect(result.gitignoreSeeded).toBe(false);
    expect(result.headSha).toBe(before);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".claudexor/\nnode_modules/\n");
  });

  it("preserves an existing .gitignore byte-for-byte and treats repo .claudexor as user state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-ensure-"));
    // A user may version any shape below `.claudexor`; Claudexor neither
    // classifies it as runtime nor repairs the user's no-newline ignore file.
    mkdirSync(join(dir, ".claudexor", "runs", "run-x"), { recursive: true });
    writeFileSync(join(dir, ".claudexor", "runs", "run-x", "events.jsonl"), "{}\n");
    writeFileSync(join(dir, ".gitignore"), "node_modules");
    writeFileSync(join(dir, "data.txt"), "hello\n");
    const result = await ensureGitRepository(dir);
    expect(result.gitignoreSeeded).toBe(false);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("node_modules");
    const tracked = await git(dir, ["ls-files"]);
    expect(tracked.stdout).toContain("data.txt");
    expect(tracked.stdout).toContain(".claudexor/runs/run-x/events.jsonl");
  });
});

describe("disposeOrphan (crash GC)", () => {
  it("removes an orphaned envelope's worktree, branch, and scoped base by ids alone", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claudexor-orphan-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "x\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], {
      cwd: repo,
    });
    const wsm = new WorkspaceManager(repo);
    const env = await wsm.create({ taskId: "task-orph", attemptId: "a01" });
    // Simulate the crash: the envelope is on disk with no live owner.
    expect(existsSync(env.worktree_path)).toBe(true);
    const wsm2 = new WorkspaceManager(repo);
    await wsm2.disposeOrphan("task-orph", "a01");
    expect(existsSync(join(projectRuntimeDir(repo), "workspaces", "task-orph"))).toBe(false);
    const branches = execFileSync("git", ["branch", "--list", "claudexor/*"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(branches.trim()).toBe("");
    rmSync(repo, { recursive: true, force: true });
  });
});

describe("diff fidelity", () => {
  it("round-trips CRLF content: captured diff applies cleanly to a fresh clone of base", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claudexor-crlf-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    writeFileSync(join(repo, "win.txt"), "line one\r\nline two\r\nline three\r\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], {
      cwd: repo,
    });
    const wsm = new WorkspaceManager(repo);
    const env = await wsm.create({ taskId: "task-crlf", attemptId: "a01" });
    // Harness edit inside the worktree keeps CRLF endings.
    writeFileSync(join(env.worktree_path, "win.txt"), "line one\r\nCHANGED two\r\nline three\r\n");
    const diff = await wsm.diff(env);
    expect(diff).toContain("\r"); // CR bytes SURVIVE capture (readline used to strip them)
    // The patch must apply cleanly onto the base tree.
    const clone = mkdtempSync(join(tmpdir(), "claudexor-crlf-clone-"));
    execFileSync("git", ["clone", "-q", repo, clone]);
    execFileSync("git", ["apply", "--check", "-"], { cwd: clone, input: diff });
    await wsm.dispose(env);
    rmSync(repo, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  });

  it("captures binary changes with an applyable payload (--binary), never a stub", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claudexor-bin-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "x\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], {
      cwd: repo,
    });
    const wsm = new WorkspaceManager(repo);
    const env = await wsm.create({ taskId: "task-bin", attemptId: "a01" });
    writeFileSync(
      join(env.worktree_path, "img.bin"),
      Buffer.from([0, 1, 2, 3, 255, 254, 0, 10, 13, 7]),
    );
    const diff = await wsm.diff(env);
    expect(diff).toContain("GIT binary patch");
    expect(diff).not.toContain("img.bin differ");
    const clone = mkdtempSync(join(tmpdir(), "claudexor-bin-clone-"));
    execFileSync("git", ["clone", "-q", repo, clone]);
    execFileSync("git", ["apply", "--check", "-"], { cwd: clone, input: diff });
    await wsm.dispose(env);
    rmSync(repo, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  });
});

describe("revert with quoted/special filenames", () => {
  it("removes a turn-added non-ASCII file and reports it (git C-quotes it on the newline format)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claudexor-revert-q-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    writeFileSync(join(repo, "base.txt"), "base\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], {
      cwd: repo,
    });
    const pre = await snapshotTree(repo);
    // The turn adds a file whose name git quotes under core.quotePath=true.
    const special = "файл с пробелом.txt";
    writeFileSync(join(repo, special), "added by turn\n");
    const post = await snapshotTree(repo);
    const res = await revertWorkingTreeTo(repo, pre, post);
    expect(res.reverted).toBe(true);
    expect(res.removed).toContain(special);
    expect(existsSync(join(repo, special))).toBe(false);
    rmSync(repo, { recursive: true, force: true });
  });
});

describe("repo .claudexor is entirely USER STATE", () => {
  it("counts both tracked config and untracked similarly-named files as user changes", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const { statusPorcelainMeaningful } = await import("./artifact-paths.js");
    const repo = mkdtempSync(join(tmpdir(), "cx-tracked-art-"));
    const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    g(["init", "-q"]);
    g(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root"]);
    mkdirSync(join(repo, ".claudexor"), { recursive: true });
    writeFileSync(join(repo, ".claudexor", "config.yaml"), "tests: []\n");
    g(["add", ".claudexor/config.yaml"]);
    g(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "versioned config"]);
    // Both paths are user-owned. Real runtime never appears below the repo.
    writeFileSync(join(repo, ".claudexor", "config.yaml"), 'tests: ["node --test"]\n');
    mkdirSync(join(repo, ".claudexor", "runs", "run-x"), { recursive: true });
    writeFileSync(join(repo, ".claudexor", "runs", "run-x", "events.jsonl"), "{}\n");
    // Dirty check must not hide either path based on its name.
    const dirty = await statusPorcelainMeaningful(repo);
    expect(dirty.some((l) => l.includes(".claudexor/config.yaml"))).toBe(true);
    expect(dirty.some((l) => l.includes("runs"))).toBe(true);
  });
});

describe("snapshot keeps every repo .claudexor change", () => {
  it("captures tracked config edits and untracked similarly-named files", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const { snapshotTree } = await import("./git.js");
    const repo = mkdtempSync(join(tmpdir(), "cx-snap-art-"));
    const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    g(["init", "-q"]);
    mkdirSync(join(repo, ".claudexor"), { recursive: true });
    writeFileSync(join(repo, ".claudexor", "config.yaml"), "tests: []\n");
    writeFileSync(join(repo, "src.txt"), "hello\n");
    g(["add", "-A"]);
    g(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
    // The turn edits tracked config and adds another user-owned project file.
    writeFileSync(join(repo, ".claudexor", "config.yaml"), 'tests: ["node --test"]\n');
    mkdirSync(join(repo, ".claudexor", "runs", "run-y"), { recursive: true });
    writeFileSync(join(repo, ".claudexor", "runs", "run-y", "events.jsonl"), "{}\n");
    const sha = await snapshotTree(repo);
    const files = execFileSync("git", ["-C", repo, "ls-tree", "-r", "--name-only", sha], {
      encoding: "utf8",
    });
    expect(files).toContain(".claudexor/config.yaml");
    expect(files).toContain(".claudexor/runs/run-y/events.jsonl");
    const content = execFileSync("git", ["-C", repo, "show", `${sha}:.claudexor/config.yaml`], {
      encoding: "utf8",
    });
    expect(content).toContain("node --test"); // the EDIT, not the base version
  });
});

describe("pre-STAGED deletion of a versioned artifact-dir file (R33 cycle-3)", () => {
  it("a user-staged `git rm .claudexor/config.yaml` counts as dirty and the snapshot carries the deletion", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const { snapshotTree } = await import("./git.js");
    const { statusPorcelainMeaningful } = await import("./artifact-paths.js");
    const repo = mkdtempSync(join(tmpdir(), "cx-staged-del-"));
    const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    g(["init", "-q"]);
    mkdirSync(join(repo, ".claudexor"), { recursive: true });
    writeFileSync(join(repo, ".claudexor", "config.yaml"), "tests: []\n");
    writeFileSync(join(repo, "src.txt"), "hello\n");
    g(["add", "-A"]);
    g(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
    // The USER stages the deletion before any run (index entry gone).
    g(["rm", "-q", ".claudexor/config.yaml"]);
    const dirty = await statusPorcelainMeaningful(repo);
    expect(dirty.some((l) => l.includes(".claudexor/config.yaml"))).toBe(true);
    const sha = await snapshotTree(repo);
    const files = execFileSync("git", ["-C", repo, "ls-tree", "-r", "--name-only", sha], {
      encoding: "utf8",
    });
    // The snapshot tree reflects the DELETION (file absent), not HEAD's copy.
    expect(files).not.toContain(".claudexor/config.yaml");
    expect(files).toContain("src.txt");
    // And it IS a snapshot, not a fall-through to HEAD.
    const headSha = g(["rev-parse", "HEAD"]).trim();
    expect(sha).not.toBe(headSha);
  });
});
