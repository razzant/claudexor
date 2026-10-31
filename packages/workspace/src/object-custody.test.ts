import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceManager } from "./manager.js";
import { ensureThreadWorktree } from "./thread-tree.js";
import { importIntoRepository, objectStorePath } from "./object-store.js";
import { isolatedBaseCustody } from "./capture-objects.js";
import { stashCreate } from "./git.js";

// #535 D2: snapshots no user ref keeps (a dirty isolated base) live in the
// project store before the clone, which lists the store as its second
// alternate; snapshots published as user refs (thread branches) stay there.
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  process.env["CLAUDEXOR_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "cx-custody-config-"));
  dirs.push(process.env["CLAUDEXOR_CONFIG_DIR"]);
});
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const git = (repo: string, args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { env: ENV })
    .toString("utf8")
    .trim();
const userGc = (repo: string) => {
  git(repo, ["reflog", "expire", "--expire=now", "--all"]);
  git(repo, ["gc", "-q", "--prune=now"]);
};
const fsck = (repo: string) =>
  spawnSync("git", ["-C", repo, "fsck", "--connectivity-only"], { env: ENV }).status;

function userRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cx-custody-user-"));
  dirs.push(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "tracked.txt"), "committed\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);
  return repo;
}

describe("object custody survives the user's gc --prune=now (D2)", () => {
  it("a dirty base of an execution root that is not the project enters the project's store", async () => {
    const project = userRepo();
    const execution = userRepo();
    writeFileSync(join(execution, "tracked.txt"), "dirty edit\n");
    const runDir = mkdtempSync(join(tmpdir(), "cx-custody-run-"));
    dirs.push(runDir);
    const manager = new WorkspaceManager(execution, {
      runtimeRoot: mkdtempSync(join(tmpdir(), "cx-custody-rt-")),
      projectRoot: project,
    });
    const env = await manager.create({
      taskId: "t1",
      attemptId: "a01",
      dirtyPolicy: "snapshot",
      custody: { runId: "run-1", runDir },
    });
    expect(env.repo_root).toBe(execution);
    const store = objectStorePath(project);
    expect(
      readFileSync(join(env.worktree_path, ".git", "objects", "info", "alternates"), "utf8"),
    ).toContain(join(store, "objects"));
    expect(existsSync(objectStorePath(execution))).toBe(false);
    expect(
      spawnSync("git", ["-C", store, "cat-file", "-e", env.base_sha!], {
        env: { ...ENV, GIT_DIR: store },
      }).status,
    ).toBe(0);
    writeFileSync(join(env.worktree_path, "candidate.txt"), "candidate\n");
    const captured = await manager.captureDiff(env, runDir);
    expect(captured.captureIncomplete).toBe(false);
    expect(existsSync(objectStorePath(execution))).toBe(false);
    expect(
      spawnSync("git", ["-C", store, "cat-file", "-e", captured.result!.candidate_tree], {
        env: { ...ENV, GIT_DIR: store },
      }).status,
    ).toBe(0);
  });

  it("an isolated envelope over a dirty base keeps resolving and capturing it", async () => {
    const repo = userRepo();
    writeFileSync(join(repo, "tracked.txt"), "dirty edit\n");
    writeFileSync(join(repo, "untracked.txt"), "dirty and untracked\n");
    const runDir = mkdtempSync(join(tmpdir(), "cx-custody-run-"));
    dirs.push(runDir);
    const manager = new WorkspaceManager(repo, {
      runtimeRoot: mkdtempSync(join(tmpdir(), "cx-custody-rt-")),
    });
    const env = await manager.create({
      taskId: "t1",
      attemptId: "a01",
      dirtyPolicy: "snapshot",
      custody: { runId: "run-1", runDir },
    });
    const snapshot = env.base_sha!;
    expect(snapshot).not.toBe(git(repo, ["rev-parse", "HEAD"]));
    // The clone's second alternate is the project store, never the user repo's.
    expect(
      readFileSync(join(env.worktree_path, ".git", "objects", "info", "alternates"), "utf8"),
    ).toContain(join(objectStorePath(repo), "objects"));
    expect(existsSync(join(repo, ".git", "objects", "info", "alternates"))).toBe(false);
    userGc(repo);
    // The dangling snapshot left the user's object database; the clone still has it.
    expect(
      spawnSync("git", ["-C", repo, "cat-file", "-e", snapshot], { env: ENV }).status,
    ).not.toBe(0);
    expect(git(env.worktree_path, ["cat-file", "-t", snapshot])).toBe("commit");
    expect(readFileSync(join(env.worktree_path, "untracked.txt"), "utf8")).toBe(
      "dirty and untracked\n",
    );
    writeFileSync(join(env.worktree_path, "candidate.txt"), "candidate\n");
    const captured = await manager.captureDiff(env, runDir);
    expect(captured.captureIncomplete).toBe(false);
    expect(captured.result?.base_commit).toBe(snapshot);
    expect(captured.diff).toContain("+candidate");
    expect(fsck(repo)).toBe(0);
    await manager.dispose(env);
  });

  it("a commit present only in the store becomes a branch after D1 import; fsck stays clean", async () => {
    const repo = userRepo();
    writeFileSync(join(repo, "dirty.txt"), "only in a snapshot\n");
    const snapshot = await stashCreate(repo);
    expect(snapshot).not.toBeNull();
    await isolatedBaseCustody(repo, repo, snapshot!, [repo]);
    userGc(repo);
    expect(
      spawnSync("git", ["-C", repo, "cat-file", "-e", snapshot!], { env: ENV }).status,
    ).not.toBe(0);
    const imported = await importIntoRepository({ projectRoot: repo, repo, roots: [snapshot!] });
    expect(imported.missing).toEqual([]);
    git(repo, ["branch", "from-store", snapshot!]);
    expect(git(repo, ["show", "from-store:dirty.txt"])).toBe("only in a snapshot");
    userGc(repo);
    expect(fsck(repo)).toBe(0);
  });

  it("a thread branch keeps its base through the user's gc, and recovery works from it", async () => {
    const repo = userRepo();
    writeFileSync(join(repo, "dirty.txt"), "dirty thread base\n");
    const first = await ensureThreadWorktree(repo, "th-gc");
    userGc(repo);
    expect(git(repo, ["cat-file", "-t", first.baseSha])).toBe("commit");
    expect(fsck(repo)).toBe(0);
    // The worktree directory is lost; the surviving branch recovers it.
    rmSync(first.path, { recursive: true, force: true });
    const recovered = await ensureThreadWorktree(repo, "th-gc");
    expect(recovered.baseSha).toBe(first.baseSha);
    expect(readFileSync(join(recovered.path, "dirty.txt"), "utf8")).toBe("dirty thread base\n");
    userGc(repo);
    expect(fsck(repo)).toBe(0);
  });
});
