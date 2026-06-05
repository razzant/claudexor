import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { git } from "./git.js";
import { WorkspaceManager } from "./manager.js";

async function initRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "claudex-ws-"));
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
});
