import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../../artifact-store/src/index.js";
import { WorkspaceManager, applyWorkspaceFiles, ensureLaneHomeEnv } from "@claudexor/workspace";
import { projectRuntimeDir } from "@claudexor/util";
import { runRetentionPass } from "./retention.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "retention-workspace-"));
  roots.push(root);
  vi.stubEnv("CLAUDEXOR_CONFIG_DIR", join(root, "engine"));
  const source = join(root, "source");
  mkdirSync(source);
  writeFileSync(join(source, "input.txt"), "source bytes\n");
  const store = new ArtifactStore(source);
  const run = store.createRun("run-live");
  const manager = new WorkspaceManager(source);
  const collect = () =>
    runRetentionPass(
      { runsMaxAgeDays: 30, reviewsMaxAgeDays: 14, keepLastRunsPerProject: 20 },
      { dry_run: false },
      {
        projects: () => [{ root: source, runsDir: store.runsDir(), reviewsDir: null }],
        records: () => [{ runId: run.runId, state: "running" }],
        referencedRunIds: () => new Set([run.runId]),
        // Advance the pass clock beyond timestamp granularity: age never owns payloads.
        now: () => Date.now() + 5000,
      },
    );
  return { source, run, manager, collect };
}
it("keeps an untouched copied workspace noChanges and Apply a no-op", async () => {
  const f = fixture();
  mkdirSync(join(f.source, "empty-output"));
  const env = await f.manager.create({
    taskId: "task-live",
    attemptId: "a01",
    workspaceKind: "directory",
    scopePaths: ["."],
    custody: { runId: f.run.runId, runDir: f.run.root },
  });
  expect((await f.manager.captureFiles(env, f.run.root)).noChanges).toBe(true);
  const receipt = await f.collect();
  expect(receipt.kept.active).toBe(1);
  expect(receipt.deleted_runs).toEqual([]);
  const after = await f.manager.captureFiles(env, f.run.root);
  expect(after.noChanges).toBe(true);
  expect(await applyWorkspaceFiles(f.source, after.manifest, f.run.root)).toMatchObject({
    treeMutated: false,
    appliedPaths: [],
  });
  expect(existsSync(join(f.source, "empty-output"))).toBe(true);
});
it("preserves git status in a live private checkout with packed refs", async () => {
  const f = fixture();
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  git(f.source, ["init", "-q"]);
  git(f.source, ["add", "input.txt"]);
  git(f.source, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "initial",
  ]);
  const env = await f.manager.create({
    taskId: "task-live",
    attemptId: "a01",
    custody: { runId: f.run.runId, runDir: f.run.root },
  });
  git(env.worktree_path, ["pack-refs", "--all"]);
  expect(git(env.worktree_path, ["status", "--porcelain"])).toBe("");
  expect((await f.collect()).kept.active).toBe(1);
  expect(git(env.worktree_path, ["status", "--porcelain"])).toBe("");
  expect(existsSync(join(env.worktree_path, ".git/refs"))).toBe(true);
});
it("never touches empty vendor folders in a lane home", async () => {
  const f = fixture();
  const lane = ensureLaneHomeEnv(projectRuntimeDir(f.source), "th-live", "codex", null);
  await f.collect();
  for (const relative of [".codex", ".claude", ".cursor", ".config/opencode", ".copilot"])
    expect(existsSync(join(lane.homeDir, relative))).toBe(true);
  expect(existsSync(join(f.run.root, "context"))).toBe(true);
});
