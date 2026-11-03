/**
 * #333 review C1/C2 through the real purge owner: the project removal receipt,
 * the purge obligation and the startup replay, over a real SQL store and real
 * Git. A lane parent linking out to the user's project, a held ref lock, a
 * locked worktree and a repository moved without a relink each keep the
 * thread's cleanup pending without deleting any user file or forgetting what
 * Git still records; once the cause is gone, the replay completes. The
 * repository a cleanup asks, whether a moved worktree names it or the project
 * folder holds it, is recorded with the obligation (#333 review R1, R2): the
 * retry and a replay after restart finish and sync there, not at the old path,
 * also after Git dropped the registration of a worktree directory it could not
 * delete (R3).
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPartition,
  createSqlDaemonServices,
  EngineStore,
  setGlobalGenerationInTx,
} from "@claudexor/daemon";
import { projectRuntimeDir } from "@claudexor/util";
import { ensureThreadWorktree, git } from "@claudexor/workspace";
import { projectRemovalService } from "./project-removal.js";
import { sqlActivityRecords } from "./sql-daemon-queries.js";
import { threadPurgeEffect, threadPurgeOwner } from "./thread-purge.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

let root: string;
let store: EngineStore;
let graph: ReturnType<typeof createSqlDaemonServices>;

async function open() {
  store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: resolve(import.meta.dirname, "../../daemon/dist/store/flusher-worker.js"),
  });
  graph = createSqlDaemonServices(store, {
    purgeFiles: threadPurgeEffect(join(root, "no-project")),
  });
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cx-purge-refusal-")));
  vi.stubEnv("CLAUDEXOR_CONFIG_DIR", join(root, "config"));
  await open();
  store.transaction(() => setGlobalGenerationInTx(store, createPartition(store, "global").pid));
});

afterEachClosed(async () => {
  // This test's handles, taken before their closes: a late close never reaches the next test's.
  const [ownedGraph, ownedStore] = [graph, store];
  await ownedGraph.close();
  await ownedStore.close();
  return () => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  };
});

function removeWithTrashedThreads(projectId: string) {
  const owner = threadPurgeOwner(graph.threads, join(root, "no-project"), graph.purgeFiles);
  return projectRemovalService(
    graph.threads,
    () => sqlActivityRecords(store),
    owner.finishPurge,
  )(projectId, { trashedThreads: "purge" });
}

function userProject(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "USER-SENTINEL"), "user data must remain");
  return graph.threads.registerProject({ root: dir, clientId: "test", idempotencyKey: dir })
    .project;
}

async function isolatedThread(projectRoot: string) {
  const thread = graph.threads.createThread({ repoRoot: projectRoot, workspace: "isolated" });
  const tree = await ensureThreadWorktree(projectRoot, thread.id);
  graph.threads.setThreadWorktree(thread.id, tree.path, tree.baseSha);
  writeFileSync(join(tree.path, "UNMERGED"), "thread-owned change");
  return { thread, tree, branch: `claudexor/thread-${thread.id}` };
}

const branchExists = async (repo: string, branch: string): Promise<boolean> =>
  (await git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
const registrations = async (repo: string): Promise<string> =>
  (await git(repo, ["worktree", "list", "--porcelain"])).stdout;
const sentinel = (dir: string): string => readFileSync(join(dir, "USER-SENTINEL"), "utf8");
const openPurges = () =>
  graph.obligations.open().map((row) => ({ kind: row.kind, key: row.key, state: row.state }));

/** Startup replay of the open purge obligations. */
async function replay() {
  const receipt = await graph.recoverAfterStartup();
  await store.flushed();
  return receipt;
}

/** The directories the store's flusher is asked to sync, recorded and forwarded. */
function syncedDirectories(): () => string[] {
  const spy = vi.spyOn(store, "registerExternal");
  return () => spy.mock.calls.map(([dir]) => dir);
}

/** A repository moved without a relink; `git worktree repair` relinks its worktrees. */
async function moveRepository(from: string, to: string): Promise<void> {
  renameSync(from, to);
  expect((await git(to, ["worktree", "repair"])).code).toBe(0);
}

describe("purge cleanup refusals stay pending (#333 review C1, C2)", () => {
  it("refuses a lane parent that links to the user's project instead of deleting it", async () => {
    const initial = userProject(join(root, "initial-user-project"));
    const thread = graph.threads.createThread({ repoRoot: initial.root });
    // A folder move plus the public relink give the project the thread's name.
    const userRoot = join(root, thread.id);
    renameSync(initial.root, userRoot);
    const project = graph.threads.relinkProject(initial.id, userRoot);
    graph.threads.trashThread(thread.id);
    const runtime = projectRuntimeDir(userRoot);
    mkdirSync(runtime, { recursive: true });
    symlinkSync(root, join(runtime, "lanes"), "dir");
    expect(realpathSync(join(runtime, "lanes", thread.id))).toBe(userRoot);

    const receipt = await removeWithTrashedThreads(project.id);
    expect(receipt.purgedThreads).toEqual([
      {
        threadId: thread.id,
        cleanup: "pending",
        cleanupError: expect.stringContaining("refusing to follow"),
      },
    ]);
    expect(sentinel(userRoot)).toBe("user data must remain");
    expect(openPurges()).toEqual([{ kind: "purge_fs", key: thread.id, state: "pending" }]);

    expect((await replay()).failed).toMatchObject([{ kind: "purge_fs", key: thread.id }]);
    expect(sentinel(userRoot)).toBe("user data must remain");
    unlinkSync(join(runtime, "lanes"));
    expect((await replay()).completed).toEqual([{ kind: "purge_fs", key: thread.id }]);
    expect(openPurges()).toEqual([]);
    expect(sentinel(userRoot)).toBe("user data must remain");
  });

  it("keeps a branch held by a ref lock pending until the lock is released", async () => {
    const project = userProject(join(root, "project"));
    const { thread, tree, branch } = await isolatedThread(project.root);
    const lock = join(project.root, ".git", "refs", "heads", `${branch}.lock`);
    writeFileSync(lock, "held by a concurrent git process");
    graph.threads.trashThread(thread.id);

    const receipt = await removeWithTrashedThreads(project.id);
    expect(receipt.purgedThreads).toEqual([
      {
        threadId: thread.id,
        cleanup: "pending",
        cleanupError: expect.stringContaining("git branch -D"),
      },
    ]);
    expect(await branchExists(project.root, branch)).toBe(true);
    expect(openPurges()).toEqual([{ kind: "purge_fs", key: thread.id, state: "pending" }]);
    expect((await replay()).failed).toMatchObject([{ kind: "purge_fs", key: thread.id }]);

    rmSync(lock);
    expect((await replay()).completed).toEqual([{ kind: "purge_fs", key: thread.id }]);
    expect(await branchExists(project.root, branch)).toBe(false);
    expect(existsSync(dirname(tree.path))).toBe(false);
    expect(openPurges()).toEqual([]);
    expect(sentinel(project.root)).toBe("user data must remain");
  });

  it("keeps a locked worktree, its registration and branch pending until it is unlocked", async () => {
    const project = userProject(join(root, "project"));
    const { thread, tree, branch } = await isolatedThread(project.root);
    expect((await git(project.root, ["worktree", "lock", tree.path])).code).toBe(0);
    graph.threads.trashThread(thread.id);

    const receipt = await removeWithTrashedThreads(project.id);
    expect(receipt.purgedThreads).toEqual([
      {
        threadId: thread.id,
        cleanup: "pending",
        cleanupError: expect.stringContaining("git worktree remove failed"),
      },
    ]);
    expect(readFileSync(join(tree.path, "UNMERGED"), "utf8")).toBe("thread-owned change");
    expect(await registrations(project.root)).toContain(realpathSync(tree.path));
    expect(await branchExists(project.root, branch)).toBe(true);
    expect((await replay()).failed).toMatchObject([{ kind: "purge_fs", key: thread.id }]);
    expect(existsSync(tree.path)).toBe(true);

    expect((await git(project.root, ["worktree", "unlock", tree.path])).code).toBe(0);
    expect((await replay()).completed).toEqual([{ kind: "purge_fs", key: thread.id }]);
    expect(await registrations(project.root)).not.toContain(thread.id);
    expect(await branchExists(project.root, branch)).toBe(false);
    expect(existsSync(dirname(tree.path))).toBe(false);
    expect(openPurges()).toEqual([]);
    expect(sentinel(project.root)).toBe("user data must remain");
  });

  it("completes an ordinary purge and one whose worktree and branch are already gone", async () => {
    const project = userProject(join(root, "project"));
    const ordinary = await isolatedThread(project.root);
    const gone = await isolatedThread(project.root);
    expect((await git(project.root, ["worktree", "remove", "--force", gone.tree.path])).code).toBe(
      0,
    );
    expect((await git(project.root, ["branch", "-D", gone.branch])).code).toBe(0);
    const asked = graph.threads.createThread({ repoRoot: project.root });
    mkdirSync(join(projectRuntimeDir(project.root), "lanes", asked.id, "fake-default", "home"), {
      recursive: true,
    });
    for (const thread of [ordinary.thread, gone.thread, asked])
      graph.threads.trashThread(thread.id);

    const receipt = await removeWithTrashedThreads(project.id);
    expect(receipt.purgedThreads?.map((item) => item.cleanup)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    for (const { thread, tree, branch } of [ordinary, gone]) {
      expect(existsSync(dirname(tree.path))).toBe(false);
      expect(await branchExists(project.root, branch)).toBe(false);
      expect(await registrations(project.root)).not.toContain(thread.id);
    }
    expect(existsSync(join(projectRuntimeDir(project.root), "lanes", asked.id))).toBe(false);
    await store.flushed();
    expect(openPurges()).toEqual([]);
    expect(sentinel(project.root)).toBe("user data must remain");
  });

  it("keeps the cleanup pending when the repository moved without a relink, until Git repairs it", async () => {
    const project = userProject(join(root, "project"));
    const { thread, tree, branch } = await isolatedThread(project.root);
    graph.threads.trashThread(thread.id);
    const moved = join(root, "project-moved");
    renameSync(project.root, moved);

    const receipt = await removeWithTrashedThreads(project.id);
    expect(receipt.purgedThreads).toEqual([
      {
        threadId: thread.id,
        cleanup: "pending",
        cleanupError: expect.stringContaining("git worktree repair"),
      },
    ]);
    // Nothing the moved repository still records is touched or forgotten.
    expect(await registrations(moved)).toContain(realpathSync(tree.path));
    expect(await branchExists(moved, branch)).toBe(true);
    expect(readFileSync(join(tree.path, "UNMERGED"), "utf8")).toBe("thread-owned change");
    expect(openPurges()).toEqual([{ kind: "purge_fs", key: thread.id, state: "pending" }]);
    expect((await replay()).failed).toMatchObject([{ kind: "purge_fs", key: thread.id }]);

    // The disclosed recovery: Git repairs the worktree's link to the moved repository.
    expect((await git(moved, ["worktree", "repair"])).code).toBe(0);
    expect((await replay()).completed).toEqual([{ kind: "purge_fs", key: thread.id }]);
    expect(await registrations(moved)).not.toContain(thread.id);
    expect(await branchExists(moved, branch)).toBe(false);
    expect(existsSync(dirname(tree.path))).toBe(false);
    expect(openPurges()).toEqual([]);
    expect(sentinel(moved)).toBe("user data must remain");
  });

  it("finishes a moved repository's ref-locked cleanup there, not in a repository now at the old path", async () => {
    const project = userProject(join(root, "project"));
    const { thread, tree, branch } = await isolatedThread(project.root);
    graph.threads.trashThread(thread.id);
    const moved = join(root, "project-moved");
    await moveRepository(project.root, moved);
    const lock = join(moved, ".git", "refs", "heads", `${branch}.lock`);
    writeFileSync(lock, "held by a concurrent git process");

    const receipt = await removeWithTrashedThreads(project.id);
    expect(receipt.purgedThreads).toEqual([
      {
        threadId: thread.id,
        cleanup: "pending",
        cleanupError: expect.stringContaining("git branch -D"),
      },
    ]);
    // Git removed the worktree and the file naming its repository; the obligation kept it.
    expect(existsSync(tree.path)).toBe(false);
    expect(graph.obligations.get("purge_fs", thread.id)?.payload).toMatchObject({
      repository: { gitDir: join(moved, ".git"), identity: expect.any(String) },
    });
    expect(await branchExists(moved, branch)).toBe(true);

    rmSync(lock);
    mkdirSync(project.root);
    expect((await git(project.root, ["init", "-q"])).code).toBe(0);
    const synced = syncedDirectories();
    expect((await replay()).completed).toEqual([{ kind: "purge_fs", key: thread.id }]);
    expect(await branchExists(moved, branch)).toBe(false);
    expect(await registrations(moved)).not.toContain(thread.id);
    expect(synced()).toContain(join(moved, ".git"));
    expect(existsSync(dirname(tree.path))).toBe(false);
    expect(openPurges()).toEqual([]);
    expect(sentinel(moved)).toBe("user data must remain");
    expect(readdirSync(project.root)).toEqual([".git"]);
  });

  it("syncs the moved repository it cleaned, also when a restart replays the completed cleanup", async () => {
    const project = userProject(join(root, "project"));
    const { thread, tree, branch } = await isolatedThread(project.root);
    graph.threads.trashThread(thread.id);
    const moved = join(root, "project-moved");
    await moveRepository(project.root, moved);
    const synced = syncedDirectories();

    const receipt = await removeWithTrashedThreads(project.id);
    // The process stops before the durability barrier clears the obligation
    // (nothing awaits first, or the next flusher pass clears it); the next
    // start replays it with the original project folder still gone.
    graph.obligations.close();
    expect(openPurges()).toEqual([{ kind: "purge_fs", key: thread.id, state: "materialized" }]);
    expect(receipt.purgedThreads).toEqual([
      { threadId: thread.id, cleanup: "completed", cleanupError: null },
    ]);
    expect(synced()).toContain(join(moved, ".git"));
    expect(await branchExists(moved, branch)).toBe(false);
    await graph.close();
    await store.close();
    await open();
    const replayed = syncedDirectories();
    expect((await replay()).completed).toEqual([{ kind: "purge_fs", key: thread.id }]);
    expect(replayed()).toContain(join(moved, ".git"));
    expect(openPurges()).toEqual([]);
    expect(existsSync(project.root)).toBe(false);
    expect(existsSync(dirname(tree.path))).toBe(false);
    expect(sentinel(moved)).toBe("user data must remain");
  });

  it("keeps a missing worktree directory's ref-locked cleanup in the repository it found, not one now at the old path", async () => {
    const project = userProject(join(root, "project"));
    const { thread, tree, branch } = await isolatedThread(project.root);
    graph.threads.trashThread(thread.id);
    rmSync(tree.path, { recursive: true, force: true });
    writeFileSync(join(project.root, ".git", "refs", "heads", `${branch}.lock`), "held");

    const receipt = await removeWithTrashedThreads(project.id);
    expect(receipt.purgedThreads).toEqual([
      {
        threadId: thread.id,
        cleanup: "pending",
        cleanupError: expect.stringContaining("git branch -D"),
      },
    ]);
    // Git dropped the stale registration in the project folder's repository, which the obligation kept.
    expect(await registrations(project.root)).not.toContain(thread.id);
    expect(graph.obligations.get("purge_fs", thread.id)?.payload).toMatchObject({
      repository: { gitDir: join(project.root, ".git"), identity: expect.any(String) },
    });

    const moved = join(root, "project-moved");
    renameSync(project.root, moved);
    rmSync(join(moved, ".git", "refs", "heads", `${branch}.lock`));
    mkdirSync(project.root);
    expect((await git(project.root, ["init", "-q"])).code).toBe(0);
    expect((await replay()).failed).toMatchObject([
      {
        kind: "purge_fs",
        key: thread.id,
        error: expect.stringContaining("another one is there now"),
      },
    ]);
    expect(await branchExists(moved, branch)).toBe(true);
    expect(openPurges()).toEqual([{ kind: "purge_fs", key: thread.id, state: "pending" }]);

    rmSync(project.root, { recursive: true, force: true });
    renameSync(moved, project.root);
    const synced = syncedDirectories();
    expect((await replay()).completed).toEqual([{ kind: "purge_fs", key: thread.id }]);
    expect(await branchExists(project.root, branch)).toBe(false);
    expect(synced()).toContain(join(project.root, ".git"));
    expect(openPurges()).toEqual([]);
    expect(sentinel(project.root)).toBe("user data must remain");
  });

  it("replays a completed cleanup of a missing worktree directory only in the repository it recorded", async () => {
    const project = userProject(join(root, "project"));
    const { thread, tree, branch } = await isolatedThread(project.root);
    graph.threads.trashThread(thread.id);
    rmSync(tree.path, { recursive: true, force: true });

    const receipt = await removeWithTrashedThreads(project.id);
    // The process stops before the durability barrier clears the obligation.
    graph.obligations.close();
    expect(graph.obligations.get("purge_fs", thread.id)).toMatchObject({
      state: "materialized",
      payload: { repository: { gitDir: join(project.root, ".git") } },
    });
    expect(receipt.purgedThreads).toEqual([
      { threadId: thread.id, cleanup: "completed", cleanupError: null },
    ]);
    expect(await branchExists(project.root, branch)).toBe(false);
    await graph.close();
    await store.close();

    // The next start finds another repository at the project path...
    const moved = join(root, "project-moved");
    renameSync(project.root, moved);
    mkdirSync(project.root);
    expect((await git(project.root, ["init", "-q"])).code).toBe(0);
    await open();
    expect((await replay()).failed).toMatchObject([{ kind: "purge_fs", key: thread.id }]);
    expect(openPurges()).toEqual([{ kind: "purge_fs", key: thread.id, state: "pending" }]);
    // ...and with the recorded repository back, the replay syncs that one.
    rmSync(project.root, { recursive: true, force: true });
    renameSync(moved, project.root);
    const synced = syncedDirectories();
    expect((await replay()).completed).toEqual([{ kind: "purge_fs", key: thread.id }]);
    expect(synced()).toContain(join(project.root, ".git"));
    expect(openPurges()).toEqual([]);
    expect(sentinel(project.root)).toBe("user data must remain");
  });

  // Permissions do not stop root, and Windows has no read-only directory bit.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "finishes at the next start a worktree removal Git left half done on a read-only directory",
    async () => {
      const project = userProject(join(root, "project"));
      const { thread, tree, branch } = await isolatedThread(project.root);
      graph.threads.trashThread(thread.id);
      chmodSync(tree.path, 0o555);
      let receipt: Awaited<ReturnType<typeof removeWithTrashedThreads>>;
      try {
        receipt = await removeWithTrashedThreads(project.id);
      } finally {
        chmodSync(tree.path, 0o755);
      }
      expect(receipt.purgedThreads).toEqual([
        {
          threadId: thread.id,
          cleanup: "pending",
          cleanupError: expect.stringContaining("git worktree remove failed"),
        },
      ]);
      // Git dropped the registration although it failed on the directory, which
      // keeps the `.git` file naming it; the obligation kept the repository.
      expect(await registrations(project.root)).not.toContain(thread.id);
      expect(existsSync(join(tree.path, ".git"))).toBe(true);
      expect(await branchExists(project.root, branch)).toBe(true);
      expect(graph.obligations.get("purge_fs", thread.id)?.payload).toMatchObject({
        repository: { gitDir: join(project.root, ".git"), identity: expect.any(String) },
      });
      await store.flushed();
      expect(openPurges()).toEqual([{ kind: "purge_fs", key: thread.id, state: "pending" }]);

      await graph.close();
      await store.close();
      await open();
      const synced = syncedDirectories();
      expect(await replay()).toEqual({
        completed: [{ kind: "purge_fs", key: thread.id }],
        failed: [],
        unhandled: [],
      });
      expect(await branchExists(project.root, branch)).toBe(false);
      expect(existsSync(dirname(tree.path))).toBe(false);
      expect(synced()).toContain(join(project.root, ".git"));
      expect(openPurges()).toEqual([]);
      expect(sentinel(project.root)).toBe("user data must remain");
    },
  );

  it("completes an isolated thread that never had a worktree, outside any repository", async () => {
    const project = userProject(join(root, "plain"));
    const thread = graph.threads.createThread({ repoRoot: project.root, workspace: "isolated" });
    graph.threads.trashThread(thread.id);

    const receipt = await removeWithTrashedThreads(project.id);
    expect(receipt.purgedThreads).toEqual([
      { threadId: thread.id, cleanup: "completed", cleanupError: null },
    ]);
    await store.flushed();
    expect(openPurges()).toEqual([]);
    expect(existsSync(join(project.root, ".git"))).toBe(false);
  });
});
