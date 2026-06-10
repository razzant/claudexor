import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureGitRepository, git, isGitRepo } from "./git.js";
import { WorkspaceManager } from "./manager.js";

async function initRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "claudexor-ws-"));
  await git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# test\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["-c", "user.email=t@t.dev", "-c", "user.name=Test", "commit", "-m", "init"]);
  return repo;
}

describe("WorkspaceManager", () => {
  it("creates an isolated worktree with scoped dirs/ports and captures a diff", async () => {
    const repo = await initRepo();
    const mgr = new WorkspaceManager(repo);
    const env = await mgr.create({ taskId: "task-1", attemptId: "a01", baseRef: "HEAD", ports: 2 });

    expect(existsSync(env.worktree_path)).toBe(true);
    expect(existsSync(env.harness_config_dirs["codex_home"] as string)).toBe(true);
    expect(env.ports.allocated.length).toBe(2);

    const scoped = mgr.envFor(env);
    expect(scoped.HOME).toBe(env.home_dir);
    expect(scoped.CODEX_HOME).toContain(".codex");
    expect(scoped.CLAUDE_CONFIG_DIR).toContain(".claude");

    writeFileSync(join(env.worktree_path, "NEW.txt"), "hello world\n");
    // Simulate a harness writing secrets/state into its scoped HOME (e.g. codex auth.json).
    writeFileSync(join(env.harness_config_dirs["codex_home"] as string, "auth.json"), '{"OPENAI_API_KEY":"sk-secret"}\n');
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

    // Simulate the harness mutating the live tree in place.
    writeFileSync(join(dir, "a.txt"), "two\n");
    writeFileSync(join(dir, "b.txt"), "new file\n");
    const diff = await mgr.diff(env);
    expect(diff).toContain("b.txt");

    await mgr.dispose(env);
    // The live tree and its files survive dispose (never rm the repo root)...
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, "a.txt"))).toBe(true);
    expect(existsSync(join(dir, "b.txt"))).toBe(true);
    // ...but the scoped envelope base (home + baseline) is removed.
    expect(existsSync(env.home_dir)).toBe(false);
    expect(existsSync(join(dir, ".claudexor", "workspaces", "t-ip", "converge"))).toBe(false);
  });
});

describe("ensureGitRepository", () => {
  it("initializes a non-git folder with a seeded .gitignore and a baseline commit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-ensure-"));
    writeFileSync(join(dir, "data.txt"), "hello\n");
    const result = await ensureGitRepository(dir);
    expect(result.initialized).toBe(true);
    expect(result.baselineCommitted).toBe(true);
    expect(result.gitignoreSeeded).toBe(true);
    expect(result.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await isGitRepo(dir)).toBe(true);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".claudexor/");
    const tracked = await git(dir, ["ls-files"]);
    expect(tracked.stdout).toContain("data.txt");
    expect(tracked.stdout).toContain(".gitignore");
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
});
