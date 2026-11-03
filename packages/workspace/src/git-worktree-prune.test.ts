import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { worktreeAdd, worktreeAddExisting, worktreePrune } from "./git.js";

const roots: string[] = [];
let configDirOverride: string | undefined;

/** Git reports fully resolved worktree paths; on macOS the temp dir is a
 *  symlink, so every fixture path is resolved before it is compared. */
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function initRepo(): { repo: string; base: string } {
  const repo = tempDir("claudexor-worktree-prune-");
  git(repo, ["init", "-q"]);
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, ["add", "README.md"]);
  git(repo, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "base",
  ]);
  return { repo, base: git(repo, ["rev-parse", "HEAD"]).trim() };
}

function registeredWorktrees(repo: string): string[] {
  return git(repo, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim());
}

beforeEach(() => {
  // Own the "Claudexor runtime tree" for this suite so an envelope worktree is
  // recognizably ours without touching the real ~/.claudexor.
  configDirOverride = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = tempDir("claudexor-owned-root-");
});

afterEach(() => {
  if (configDirOverride === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
  else process.env.CLAUDEXOR_CONFIG_DIR = configDirOverride;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

describe("worktreePrune", () => {
  it("never deregisters a stale worktree Claudexor does not own", async () => {
    const { repo, base } = initRepo();
    // A worktree of the SAME git dir owned by whoever else drives this repo
    // (e.g. the host that delegates runs to Claudexor), momentarily absent.
    const foreign = join(tempDir("claudexor-foreign-"), "tree");
    await worktreeAdd(repo, foreign, "foreign/tree", base);
    rmSync(foreign, { recursive: true, force: true });

    await worktreePrune(repo);

    expect(registeredWorktrees(repo)).toContain(foreign);
  });

  it("prunes when every stale registration is a Claudexor envelope tree", async () => {
    const { repo, base } = initRepo();
    const owned = join(process.env.CLAUDEXOR_CONFIG_DIR as string, "projects", "abc", "tree");
    mkdirSync(join(owned, ".."), { recursive: true });
    await worktreeAdd(repo, owned, "claudexor/task/a01", base);
    rmSync(owned, { recursive: true, force: true });

    await worktreePrune(repo);

    expect(registeredWorktrees(repo)).not.toContain(owned);
  });

  it("is a no-op on a directory that is not a git repository", async () => {
    await expect(worktreePrune(tempDir("claudexor-not-a-repo-"))).resolves.toBeUndefined();
  });
});

describe("worktreeAddExisting", () => {
  it("reclaims only its own lost registration, never a foreign stale one", async () => {
    const { repo, base } = initRepo();
    // A co-writer's worktree of the SAME git dir, momentarily absent. Thread
    // recovery runs against the USER'S project root, so this is the realistic
    // neighbour — not a Claudexor-owned envelope.
    const foreign = join(tempDir("claudexor-foreign-"), "tree");
    await worktreeAdd(repo, foreign, "foreign/tree", base);
    rmSync(foreign, { recursive: true, force: true });
    // Our thread worktree: branch survived, directory lost (the recovery case).
    const ours = join(process.env.CLAUDEXOR_CONFIG_DIR as string, "projects", "abc", "tree");
    mkdirSync(join(ours, ".."), { recursive: true });
    await worktreeAdd(repo, ours, "claudexor/thread-t1", base);
    rmSync(ours, { recursive: true, force: true });

    await worktreeAddExisting(repo, ours, "claudexor/thread-t1");

    // The recovery must succeed AND leave the co-writer registered: a repo-wide
    // `git worktree prune` here would deregister their live workspace, which we
    // cannot undo for them.
    expect(registeredWorktrees(repo)).toContain(ours);
    expect(registeredWorktrees(repo)).toContain(foreign);
  });
});
