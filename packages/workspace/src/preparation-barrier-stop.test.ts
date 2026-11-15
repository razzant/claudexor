// #694 V17: a Stop that arrives while a preparation waits at one of its async
// barriers starts no new Git step. The initializer's `beforeMutation` (the
// thread's durable scope and record) and the recovery add's `beforeAdd` (its
// registration read and record write) are awaited right before a step that,
// on Windows, takes the user's own locks and is therefore not handed the stop
// (`userLockStep`): only a check after the wait can keep it from starting. A
// step already started keeps that boundary rule: it finishes, then the stop is
// taken, with the partial progress it really made.
//
// The initializer runs on a scripted Git (no process); the recovery add runs
// real `git` in this test's own folders. Nothing is signalled.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitCommandResult } from "./git-initialization.js";
import {
  ensureGitRepository,
  worktreeAdd,
  worktreeAddExisting,
  worktreeRegistered,
} from "./git.js";
import { GitInitializationError } from "./git-initialization.js";
import { PreparationCancelled } from "./git-run.js";

const availableGit = async () => ({
  status: "available" as const,
  version: "git version test",
  detail: null,
  remediation: null,
});
const rootPolicy = { userHomeDir: () => "/home/tester", realpath: (path: string) => path };
const ok = (stdout = ""): GitCommandResult => ({ code: 0, stdout, stderr: "" });

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A scripted Git for a folder that is not a repository yet; mutations are logged. */
function scriptedGit(hold?: { stage: string; until: Promise<void> }) {
  const mutations: string[] = [];
  const runGit = async (_repo: string, args: string[]): Promise<GitCommandResult> => {
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree")
      return { code: 128, stdout: "", stderr: "not a git repository" };
    const stage = args.includes("commit") ? "commit" : (args[0] as string);
    mutations.push(stage);
    if (hold?.stage === stage) await hold.until;
    return stage === "rev-parse" ? ok("0123456789abcdef0123456789abcdef01234567\n") : ok();
  };
  return { runGit, mutations };
}

describe("a Stop at the initializer's beforeMutation barrier (#694 V17)", () => {
  it.each(["linux", "win32"] as const)(
    "%s: Stop while the barrier waits starts no init and reports no partial progress",
    async (platform) => {
      const git = scriptedGit();
      const controller = new AbortController();
      const barrier = deferred();
      let barrierCalls = 0;
      const pending = ensureGitRepository("/project", {
        probeCapability: availableGit,
        runGit: git.runGit,
        rootPolicy,
        signal: controller.signal,
        platform,
        beforeMutation: async () => {
          barrierCalls += 1;
          await barrier.promise;
          return controller.signal;
        },
      });
      await expect.poll(() => barrierCalls).toBe(1);
      controller.abort("stop");
      barrier.resolve();
      const error = await pending.then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(PreparationCancelled);
      expect(error).not.toBeInstanceOf(GitInitializationError);
      expect(git.mutations).toEqual([]);
    },
  );

  it("control: an unstopped barrier proceeds through init, add, commit and HEAD", async () => {
    const git = scriptedGit();
    const controller = new AbortController();
    const result = await ensureGitRepository("/project", {
      probeCapability: availableGit,
      runGit: git.runGit,
      rootPolicy,
      signal: controller.signal,
      platform: "win32",
      beforeMutation: async () => controller.signal,
    });
    expect(result).toMatchObject({ initialized: true, baselineCommitted: true });
    expect(git.mutations).toEqual(["init", "add", "commit", "rev-parse"]);
  });

  it("win32: a step already started finishes; the stop is then taken with the real partial progress", async () => {
    const release = deferred();
    const git = scriptedGit({ stage: "init", until: release.promise });
    const controller = new AbortController();
    const pending = ensureGitRepository("/project", {
      probeCapability: availableGit,
      runGit: git.runGit,
      rootPolicy,
      signal: controller.signal,
      platform: "win32",
      beforeMutation: async () => controller.signal,
    });
    await expect.poll(() => git.mutations).toEqual(["init"]);
    controller.abort("stop");
    release.resolve();
    const error = await pending.then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(GitInitializationError);
    expect((error as GitInitializationError).progress).toMatchObject({
      initialized: true,
      baselineCommitted: false,
      failedStage: "add",
    });
    expect(git.mutations).toEqual(["init"]);
  });
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
function gitIn(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: GIT_ENV });
}
/** A repository whose thread branch survived while its worktree directory was lost. */
async function lostWorktree(): Promise<{ repo: string; tree: string; branch: string }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-barrier-stop-")));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  gitIn(repo, ["init", "-q"]);
  writeFileSync(join(repo, "README.md"), "base\n");
  gitIn(repo, ["add", "README.md"]);
  gitIn(repo, ["commit", "-qm", "base"]);
  const base = gitIn(repo, ["rev-parse", "HEAD"]).trim();
  const tree = join(root, "threads", "th-1", "tree");
  mkdirSync(join(tree, ".."), { recursive: true });
  const branch = "claudexor/thread-th-1";
  await worktreeAdd(repo, tree, branch, base);
  rmSync(tree, { recursive: true, force: true });
  return { repo, tree, branch };
}

describe("a Stop at the recovery add's beforeAdd barrier (#694 V17)", () => {
  it.each(["linux", "win32"] as const)(
    "%s: Stop while beforeAdd waits starts no worktree add",
    async (platform) => {
      const { repo, tree, branch } = await lostWorktree();
      const controller = new AbortController();
      const barrier = deferred();
      let reached = false;
      const pending = worktreeAddExisting(
        repo,
        tree,
        branch,
        controller.signal,
        async () => {
          reached = true;
          await barrier.promise;
        },
        platform,
      );
      await expect.poll(() => reached).toBe(true);
      controller.abort("stop");
      barrier.resolve();
      await expect(pending).rejects.toBeInstanceOf(PreparationCancelled);
      expect(existsSync(tree)).toBe(false);
      expect(await worktreeRegistered(repo, tree)).toBe(false);
    },
  );

  it("control: an unstopped beforeAdd recreates the worktree from its branch", async () => {
    const { repo, tree, branch } = await lostWorktree();
    const controller = new AbortController();
    await worktreeAddExisting(repo, tree, branch, controller.signal, async () => {}, "win32");
    expect(existsSync(join(tree, "README.md"))).toBe(true);
    expect(await worktreeRegistered(repo, tree)).toBe(true);
  });
});
