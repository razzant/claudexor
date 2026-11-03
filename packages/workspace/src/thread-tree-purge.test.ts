/**
 * The isolated-thread purge never reports as deleted what Git still records
 * (#333 review C2) and never follows a link out of the runtime tree (C1): a
 * Git refusal, a link above the thread directory or a repository it cannot
 * reach throws, keeping what Git still records; what is already gone counts as
 * done. A removal Git left half done, its registration gone and the directory
 * still there, finishes in the repository recorded before it (R3).
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectRuntimeDir } from "@claudexor/util";
import { git, worktreeRemoveRegistered } from "./git.js";
import {
  ensureThreadWorktree,
  purgeThreadWorktree,
  type PurgeRepositoryRecord,
} from "./thread-tree.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

async function userRepo(): Promise<string> {
  const repo = tempDir("claudexor-purge-repo-");
  await git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "user file\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["-c", "user.email=t@t.dev", "-c", "user.name=Test", "commit", "-qm", "init"]);
  return repo;
}

const branchExists = async (repo: string, branch: string): Promise<boolean> =>
  (await git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
const registrations = async (repo: string): Promise<string> =>
  (await git(repo, ["worktree", "list", "--porcelain"])).stdout;

// Permissions do not stop root, and Windows has no read-only directory bit.
const unixUser = it.skipIf(process.platform === "win32" || process.getuid?.() === 0);

/** Git drops a worktree's registration even when it cannot delete the
 * directory, which stays with the `.git` file naming the registration now gone. */
async function partlyRemoved(repo: string, threadId: string) {
  const tree = await ensureThreadWorktree(repo, threadId);
  const recorded: PurgeRepositoryRecord[] = [];
  const recordRepository = async (repository: PurgeRepositoryRecord) =>
    void recorded.push(repository);
  chmodSync(tree.path, 0o555);
  try {
    await expect(purgeThreadWorktree(repo, threadId, { recordRepository })).rejects.toThrow(
      /git worktree remove failed/,
    );
  } finally {
    chmodSync(tree.path, 0o755);
  }
  expect(await registrations(repo)).not.toContain(threadId);
  expect(existsSync(join(tree.path, ".git"))).toBe(true);
  expect(recorded).toEqual([{ gitDir: join(repo, ".git"), identity: expect.any(String) }]);
  return { tree, recorded, recordRepository };
}

describe("isolated thread purge", () => {
  it("keeps a locked worktree, its registration and branch, and finishes once unlocked", async () => {
    const repo = await userRepo();
    const tree = await ensureThreadWorktree(repo, "th-locked");
    writeFileSync(join(tree.path, "unapplied.txt"), "thread work\n");
    expect((await git(repo, ["worktree", "lock", tree.path])).code).toBe(0);

    await expect(purgeThreadWorktree(repo, "th-locked")).rejects.toThrow(
      /git worktree remove failed/,
    );
    expect(readFileSync(join(tree.path, "unapplied.txt"), "utf8")).toBe("thread work\n");
    expect(await registrations(repo)).toContain(realpathSync(tree.path));
    expect(await branchExists(repo, "claudexor/thread-th-locked")).toBe(true);

    expect((await git(repo, ["worktree", "unlock", tree.path])).code).toBe(0);
    await purgeThreadWorktree(repo, "th-locked");
    expect(existsSync(dirname(tree.path))).toBe(false);
    expect(await registrations(repo)).not.toContain("th-locked");
    expect(await branchExists(repo, "claudexor/thread-th-locked")).toBe(false);
  });

  it("keeps the branch and the thread directory while a ref lock is held", async () => {
    const repo = await userRepo();
    const tree = await ensureThreadWorktree(repo, "th-reflock");
    const lock = join(repo, ".git", "refs", "heads", "claudexor", "thread-th-reflock.lock");
    writeFileSync(lock, "held by a concurrent git process\n");

    await expect(purgeThreadWorktree(repo, "th-reflock")).rejects.toThrow(/git branch -D/);
    expect(await branchExists(repo, "claudexor/thread-th-reflock")).toBe(true);
    expect(existsSync(dirname(tree.path))).toBe(true);

    rmSync(lock);
    await expect(purgeThreadWorktree(repo, "th-reflock")).resolves.toBe(join(repo, ".git"));
    expect(existsSync(dirname(tree.path))).toBe(false);
    expect(await branchExists(repo, "claudexor/thread-th-reflock")).toBe(false);
  });

  it("records a moved repository before Git deletes the worktree naming it, and finishes there after a ref lock", async () => {
    const project = await userRepo();
    const tree = await ensureThreadWorktree(project, "th-moved");
    const moved = join(tempDir("claudexor-purge-moved-"), "repo");
    renameSync(project, moved);
    expect((await git(moved, ["worktree", "repair"])).code).toBe(0);
    const common = join(moved, ".git");
    const lock = join(common, "refs", "heads", "claudexor", "thread-th-moved.lock");
    writeFileSync(lock, "held by a concurrent git process\n");
    const recorded: PurgeRepositoryRecord[] = [];
    const recordRepository = async (repository: PurgeRepositoryRecord) => {
      expect(existsSync(join(tree.path, ".git"))).toBe(true);
      recorded.push(repository);
    };

    await expect(purgeThreadWorktree(project, "th-moved", { recordRepository })).rejects.toThrow(
      /git branch -D/,
    );
    expect(recorded).toEqual([{ gitDir: common, identity: expect.any(String) }]);
    expect(existsSync(join(tree.path, ".git"))).toBe(false);
    expect(await branchExists(moved, "claudexor/thread-th-moved")).toBe(true);

    // Another repository at the old project path holds nothing of this thread.
    mkdirSync(project);
    expect((await git(project, ["init", "-q"])).code).toBe(0);
    rmSync(lock);
    await expect(
      purgeThreadWorktree(project, "th-moved", { repository: recorded[0], recordRepository }),
    ).resolves.toBe(common);
    expect(await branchExists(moved, "claudexor/thread-th-moved")).toBe(false);
    expect(await registrations(moved)).not.toContain("th-moved");
    expect(existsSync(dirname(tree.path))).toBe(false);
    expect(recorded).toHaveLength(1);
  });

  it("stays pending once the repository it recorded moved away, also with another one at its path", async () => {
    const project = await userRepo();
    const tree = await ensureThreadWorktree(project, "th-moved-later");
    const lock = join(project, ".git", "refs", "heads", "claudexor", "thread-th-moved-later.lock");
    writeFileSync(lock, "held by a concurrent git process\n");
    const recorded: PurgeRepositoryRecord[] = [];
    await expect(
      purgeThreadWorktree(project, "th-moved-later", {
        recordRepository: async (repository) => void recorded.push(repository),
      }),
    ).rejects.toThrow(/git branch -D/);
    expect(recorded).toEqual([{ gitDir: join(project, ".git"), identity: expect.any(String) }]);
    rmSync(lock);
    const elsewhere = join(tempDir("claudexor-purge-moved-"), "repo");
    renameSync(project, elsewhere);
    const retry = () => purgeThreadWorktree(project, "th-moved-later", { repository: recorded[0] });

    await expect(retry()).rejects.toThrow(/is gone or another one is there now/);
    mkdirSync(project);
    expect((await git(project, ["init", "-q"])).code).toBe(0);
    await expect(retry()).rejects.toThrow(/is gone or another one is there now/);
    expect(await branchExists(elsewhere, "claudexor/thread-th-moved-later")).toBe(true);

    // Back at its path, the recorded repository finishes the cleanup.
    rmSync(project, { recursive: true, force: true });
    renameSync(elsewhere, project);
    await expect(retry()).resolves.toBe(join(project, ".git"));
    expect(await branchExists(project, "claudexor/thread-th-moved-later")).toBe(false);
    expect(existsSync(dirname(tree.path))).toBe(false);
  });

  it("records the project folder's repository before Git changes it when the worktree directory is gone", async () => {
    const project = await userRepo();
    const tree = await ensureThreadWorktree(project, "th-dirless");
    rmSync(tree.path, { recursive: true, force: true });
    const lock = join(project, ".git", "refs", "heads", "claudexor", "thread-th-dirless.lock");
    writeFileSync(lock, "held by a concurrent git process\n");
    const recorded: PurgeRepositoryRecord[] = [];
    const recordRepository = async (repository: PurgeRepositoryRecord) => {
      expect(await registrations(project)).toContain("th-dirless");
      recorded.push(repository);
    };

    await expect(purgeThreadWorktree(project, "th-dirless", { recordRepository })).rejects.toThrow(
      /git branch -D/,
    );
    expect(recorded).toEqual([{ gitDir: join(project, ".git"), identity: expect.any(String) }]);
    expect(await registrations(project)).not.toContain("th-dirless");
    rmSync(lock);
    const elsewhere = join(tempDir("claudexor-purge-moved-"), "repo");
    renameSync(project, elsewhere);
    mkdirSync(project);
    expect((await git(project, ["init", "-q"])).code).toBe(0);
    const retry = () =>
      purgeThreadWorktree(project, "th-dirless", { repository: recorded[0], recordRepository });

    await expect(retry()).rejects.toThrow(/is gone or another one is there now/);
    expect(await branchExists(elsewhere, "claudexor/thread-th-dirless")).toBe(true);
    rmSync(project, { recursive: true, force: true });
    renameSync(elsewhere, project);
    await expect(retry()).resolves.toBe(join(project, ".git"));
    expect(await branchExists(project, "claudexor/thread-th-dirless")).toBe(false);
    expect(recorded).toHaveLength(1);
  });

  it("records nothing when Git holds nothing of the thread to change", async () => {
    const repo = await userRepo();
    const recorded: PurgeRepositoryRecord[] = [];
    const recordRepository = async (repository: PurgeRepositoryRecord) =>
      void recorded.push(repository);
    const gone = await ensureThreadWorktree(repo, "th-gone");
    expect((await git(repo, ["worktree", "remove", "--force", gone.path])).code).toBe(0);
    expect((await git(repo, ["branch", "-D", "claudexor/thread-th-gone"])).code).toBe(0);

    await expect(
      purgeThreadWorktree(repo, "th-lazy", { worktreeRecorded: false, recordRepository }),
    ).resolves.toBe(join(repo, ".git"));
    await expect(purgeThreadWorktree(repo, "th-gone", { recordRepository })).resolves.toBe(
      join(repo, ".git"),
    );
    expect(recorded).toEqual([]);
  });

  it("finds Git's registration when the config dir is spelled in another case", async (context) => {
    const config = tempDir("claudexor-purge-config-");
    const respelled = join(dirname(config), basename(config).toUpperCase());
    if (!existsSync(respelled)) context.skip(); // a case-sensitive filesystem
    vi.stubEnv("CLAUDEXOR_CONFIG_DIR", respelled);
    const repo = await userRepo();
    await ensureThreadWorktree(repo, "th-case");

    await purgeThreadWorktree(repo, "th-case");
    expect(await registrations(repo)).not.toContain("th-case");
    expect(await branchExists(repo, "claudexor/thread-th-case")).toBe(false);
  });

  it("drops a registration and branch left behind after the directory went", async () => {
    const repo = await userRepo();
    const tree = await ensureThreadWorktree(repo, "th-stale");
    rmSync(dirname(tree.path), { recursive: true, force: true });

    await expect(purgeThreadWorktree(repo, "th-stale")).resolves.toBe(join(repo, ".git"));
    expect(await registrations(repo)).not.toContain("th-stale");
    expect(await branchExists(repo, "claudexor/thread-th-stale")).toBe(false);
  });

  it("counts a worktree and branch that are already gone as done", async () => {
    const repo = await userRepo();
    const removed = await ensureThreadWorktree(repo, "th-removed");
    expect((await git(repo, ["worktree", "remove", "--force", removed.path])).code).toBe(0);
    expect((await git(repo, ["branch", "-D", "claudexor/thread-th-removed"])).code).toBe(0);
    await purgeThreadWorktree(repo, "th-removed");
    expect(existsSync(dirname(removed.path))).toBe(false);
  });

  it("purges a thread that never had a worktree, also outside any repository", async () => {
    const plain = tempDir("claudexor-purge-plain-");
    const tree = join(projectRuntimeDir(plain), "threads", "th-synthetic", "tree");
    mkdirSync(tree, { recursive: true });

    await expect(
      purgeThreadWorktree(plain, "th-synthetic", { worktreeRecorded: false }),
    ).resolves.toBeNull();
    expect(existsSync(dirname(tree))).toBe(false);
  });

  it("stays pending when the project repository is gone, as a deletion looks like a move", async () => {
    const repo = await userRepo();
    const tree = await ensureThreadWorktree(repo, "th-orphan");
    rmSync(repo, { recursive: true, force: true });

    await expect(purgeThreadWorktree(repo, "th-orphan")).rejects.toThrow(/git worktree repair/);
    expect(existsSync(join(tree.path, ".git"))).toBe(true);

    // Without the worktree's own pointer, a recorded worktree is unprovable too.
    rmSync(dirname(tree.path), { recursive: true, force: true });
    await expect(purgeThreadWorktree(repo, "th-orphan")).rejects.toThrow(/cannot be checked/);
    const plain = tempDir("claudexor-purge-plain-");
    await expect(purgeThreadWorktree(plain, "th-recorded")).rejects.toThrow(/cannot be checked/);

    // The disclosed recovery after a real deletion: with the leftover worktree
    // directory gone, an empty repository at the project path lets it finish.
    mkdirSync(repo);
    expect((await git(repo, ["init", "-q"])).code).toBe(0);
    await purgeThreadWorktree(repo, "th-orphan");
  });

  unixUser("finishes a removal Git left half done in the repository it recorded", async () => {
    const repo = await userRepo();
    const { tree, recorded, recordRepository } = await partlyRemoved(repo, "th-partial");
    const retry = () =>
      purgeThreadWorktree(repo, "th-partial", { repository: recorded[0], recordRepository });
    // Without the record, nothing tells this from a moved repository.
    await expect(purgeThreadWorktree(repo, "th-partial")).rejects.toThrow(/git worktree repair/);

    // While the directory cannot be deleted, the cleanup stays pending.
    chmodSync(tree.path, 0o555);
    try {
      await expect(retry()).rejects.toThrow();
    } finally {
      chmodSync(tree.path, 0o755);
    }
    expect(existsSync(join(tree.path, ".git"))).toBe(true);
    await expect(retry()).resolves.toBe(join(repo, ".git"));
    expect(await branchExists(repo, "claudexor/thread-th-partial")).toBe(false);
    expect(existsSync(dirname(tree.path))).toBe(false);
    expect(recorded).toHaveLength(1);
  });

  unixUser("leaves the worktree that took a half-removed one's registration name", async () => {
    const repo = await userRepo();
    const { tree, recorded } = await partlyRemoved(repo, "th-partial-reused");
    const newer = await ensureThreadWorktree(repo, "th-newer");
    // Git names a registration after the directory, so the newer one got the freed name.
    expect(readFileSync(join(repo, ".git", "worktrees", "tree", "gitdir"), "utf8")).toContain(
      "th-newer",
    );

    await expect(
      purgeThreadWorktree(repo, "th-partial-reused", { repository: recorded[0] }),
    ).resolves.toBe(join(repo, ".git"));
    expect(existsSync(dirname(tree.path))).toBe(false);
    expect(await branchExists(repo, "claudexor/thread-th-partial-reused")).toBe(false);
    expect(await registrations(repo)).toContain(realpathSync(newer.path));
    expect(await branchExists(repo, "claudexor/thread-th-newer")).toBe(true);
    expect(readFileSync(join(newer.path, "README.md"), "utf8")).toBe("user file\n");
  });

  unixUser(
    "keeps a half-done removal pending while its repository is away or replaced",
    async () => {
      const project = await userRepo();
      const { tree, recorded } = await partlyRemoved(project, "th-partial-moved");
      const elsewhere = join(tempDir("claudexor-purge-moved-"), "repo");
      renameSync(project, elsewhere);
      const retry = () =>
        purgeThreadWorktree(project, "th-partial-moved", { repository: recorded[0] });

      await expect(retry()).rejects.toThrow(/is gone or another one is there now/);
      mkdirSync(project);
      expect((await git(project, ["init", "-q"])).code).toBe(0);
      await expect(retry()).rejects.toThrow(/is gone or another one is there now/);
      expect(await branchExists(elsewhere, "claudexor/thread-th-partial-moved")).toBe(true);
      expect(existsSync(join(tree.path, ".git"))).toBe(true);

      rmSync(project, { recursive: true, force: true });
      renameSync(elsewhere, project);
      await expect(retry()).resolves.toBe(join(project, ".git"));
      expect(await branchExists(project, "claudexor/thread-th-partial-moved")).toBe(false);
      expect(existsSync(dirname(tree.path))).toBe(false);
    },
  );

  unixUser("trusts the record only for a registration that was in that repository", async () => {
    const repo = await userRepo();
    const { tree, recorded } = await partlyRemoved(repo, "th-partial-foreign");
    const other = await userRepo();
    writeFileSync(join(tree.path, ".git"), `gitdir: ${join(other, ".git", "worktrees", "tree")}\n`);

    await expect(
      purgeThreadWorktree(repo, "th-partial-foreign", { repository: recorded[0] }),
    ).rejects.toThrow(/git worktree repair/);
    expect(await branchExists(repo, "claudexor/thread-th-partial-foreign")).toBe(true);
    expect(existsSync(join(tree.path, ".git"))).toBe(true);
  });

  // Neither character is allowed in a Windows file name.
  it.skipIf(process.platform === "win32")(
    "finds the registration of a runtime path with quotes, tabs and non-ASCII letters",
    async () => {
      // Git prints worktree paths raw in porcelain output; only lock reasons are quoted.
      vi.stubEnv("CLAUDEXOR_CONFIG_DIR", join(tempDir("claudexor-purge-cfg-"), 'q"uote\tПроект é'));
      const repo = await userRepo();
      const tree = await ensureThreadWorktree(repo, "th-unusual");

      await purgeThreadWorktree(repo, "th-unusual");
      expect(await registrations(repo)).not.toContain("th-unusual");
      expect(await branchExists(repo, "claudexor/thread-th-unusual")).toBe(false);
      expect(existsSync(dirname(tree.path))).toBe(false);
    },
  );

  // Neither character is allowed in a Windows file name.
  it.skipIf(process.platform === "win32")(
    "refuses a runtime path with a line break instead of missing its registration",
    async () => {
      vi.stubEnv("CLAUDEXOR_CONFIG_DIR", join(tempDir("claudexor-purge-cfg-"), "line\nbreak"));
      const repo = await userRepo();
      const tree = await ensureThreadWorktree(repo, "th-newline");
      // Without its branch, only the registration is left to find.
      expect((await git(tree.path, ["checkout", "-q", "--detach"])).code).toBe(0);
      expect((await git(repo, ["branch", "-D", "claudexor/thread-th-newline"])).code).toBe(0);

      await expect(purgeThreadWorktree(repo, "th-newline")).rejects.toThrow(/line break/);
      expect(await registrations(repo)).toContain("th-newline");
      expect(existsSync(join(tree.path, ".git"))).toBe(true);
    },
  );

  it("never matches a registration that differs only in letter case", async (context) => {
    const base = tempDir("claudexor-purge-case-");
    mkdirSync(join(base, "case", "tree"), { recursive: true });
    if (existsSync(join(base, "CASE"))) context.skip(); // a case-insensitive filesystem
    const repo = await userRepo();
    const other = join(base, "CASE", "tree");
    expect((await git(repo, ["worktree", "add", "-q", "--detach", other])).code).toBe(0);

    await worktreeRemoveRegistered(repo, join(base, "case", "tree"));
    expect(await registrations(repo)).toContain(other);
    expect(existsSync(join(other, "README.md"))).toBe(true);
  });

  it("still reaches a larger repository after the project subfolder in it was deleted", async () => {
    const repo = await userRepo();
    const project = join(repo, "packages", "app");
    mkdirSync(project, { recursive: true });
    const tree = await ensureThreadWorktree(project, "th-subfolder");
    rmSync(project, { recursive: true, force: true });

    await expect(purgeThreadWorktree(project, "th-subfolder")).resolves.toBe(join(repo, ".git"));
    expect(await registrations(repo)).not.toContain("th-subfolder");
    expect(await branchExists(repo, "claudexor/thread-th-subfolder")).toBe(false);
    expect(existsSync(dirname(tree.path))).toBe(false);
  });

  it("refuses a threads directory that links out of the runtime tree", async () => {
    const repo = await userRepo();
    const user = tempDir("claudexor-purge-user-");
    mkdirSync(join(user, "th-linked"));
    writeFileSync(join(user, "th-linked", "SENTINEL"), "user data\n");
    mkdirSync(projectRuntimeDir(repo), { recursive: true });
    symlinkSync(user, join(projectRuntimeDir(repo), "threads"), "dir");

    await expect(purgeThreadWorktree(repo, "th-linked")).rejects.toThrow(
      /link; refusing to follow/,
    );
    expect(readFileSync(join(user, "th-linked", "SENTINEL"), "utf8")).toBe("user data\n");
  });

  it("unlinks a linked thread directory without handing it to Git", async () => {
    // The link leads to the user's own linked worktree of the same repository.
    const repo = await userRepo();
    const user = tempDir("claudexor-purge-user-");
    const feature = await git(repo, ["worktree", "add", "-q", "-b", "feature", join(user, "tree")]);
    expect(feature.code).toBe(0);
    writeFileSync(join(user, "tree", "uncommitted.txt"), "user work\n");
    const threads = join(projectRuntimeDir(repo), "threads");
    mkdirSync(threads, { recursive: true });
    symlinkSync(user, join(threads, "th-final"), "dir");

    await purgeThreadWorktree(repo, "th-final");
    expect(lstatSync(join(threads, "th-final"), { throwIfNoEntry: false })).toBeUndefined();
    expect(readFileSync(join(user, "tree", "uncommitted.txt"), "utf8")).toBe("user work\n");
    expect(await registrations(repo)).toContain(join(user, "tree"));
    expect(await branchExists(repo, "feature")).toBe(true);
  });
});
