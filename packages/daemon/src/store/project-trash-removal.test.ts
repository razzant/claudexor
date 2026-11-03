/**
 * #333: an explicitly opted-in project removal purges the threads already in
 * the trash and retires the project generation in ONE store transaction, then
 * the one thread purge owner deletes their directories. Real SQL, real
 * flusher barrier, real Git worktree/branch and real purge effect; the user's
 * project folder is a sentinel that must survive byte-identically.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectRuntimeDir } from "@claudexor/util";
import { ensureThreadWorktree, git } from "@claudexor/workspace";
import { threadPurgeEffect, threadPurgeOwner } from "../../../cli/src/thread-purge.js";
import { BlobFiles } from "./blob-files.js";
import { setGlobalGenerationInTx } from "./generations.js";
import { Obligations } from "./obligations.js";
import { createPartition } from "./partitions.js";
import { SqlProjectRouter } from "./project-router.js";
import { SqlProjectStore } from "./projects.js";
import { SqlPurgeFiles } from "./purge-files.js";
import { EngineStore } from "./store.js";
import { sqlFixture } from "./test-support/sql-fixture.js";
import { afterEachClosed } from "../../../cli/src/test-support/after-each-closed.js";

let root: string,
  store: EngineStore,
  obligations: Obligations,
  router: SqlProjectRouter,
  purge: SqlPurgeFiles;
async function open() {
  store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: resolve(import.meta.dirname, "../../dist/store/flusher-worker.js"),
    flusherHooks: { manualTick: true },
  });
  obligations = new Obligations(store);
  router = new SqlProjectRouter(new SqlProjectStore(store, new BlobFiles(store), obligations));
  purge = new SqlPurgeFiles(store, obligations);
}
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cx-trash-remove-")));
  vi.stubEnv("CLAUDEXOR_CONFIG_DIR", join(root, "config"));
  await open();
  store.transaction(() => setGlobalGenerationInTx(store, createPartition(store, "global").pid));
});
afterEachClosed(async () => {
  vi.restoreAllMocks();
  obligations?.close();
  await store?.close();
  return () => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  };
});
function tick(): Promise<void> {
  return new Promise((done) => {
    const off = store.onSynced(() => {
      off();
      done();
    });
    store.flusherControl.tick();
  });
}
/** Drive manual flusher passes until the awaited cleanup settles. */
async function settled<T>(work: Promise<T>): Promise<T> {
  let done = false;
  const observed = work.finally(() => {
    done = true;
  });
  observed.catch(() => undefined);
  while (!done) {
    await tick();
    await new Promise((next) => setTimeout(next, 5));
  }
  return observed;
}
function thrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
}
function registered(name: string) {
  const dir = join(root, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "sentinel.txt"), `${name} user bytes`);
  const { project } = router.registerProject({
    root: dir,
    idempotencyKey: `register-${name}`,
    clientId: "test",
  });
  const pid = (
    store.prepare("SELECT current_pid FROM project WHERE id=?").get(project.id) as {
      current_pid: number;
    }
  ).current_pid;
  return { dir, project, pid };
}
const threadRow = (id: string) => store.prepare("SELECT state,pid FROM thread WHERE id=?").get(id);
const partitionStatus = (pid: number) =>
  (store.prepare("SELECT status FROM partition WHERE id=?").get(pid) as { status: string }).status;

describe("project removal with its trashed threads (#333)", () => {
  it("keeps the default removal refusing a project whose only threads are in the trash", () => {
    const { project, pid } = registered("default");
    const thread = router.createThread({ repoRoot: project.root });
    router.trashThread(thread.id);
    expect(thrown(() => router.removeProject(project.id, new Set()))).toMatchObject({
      code: "project_has_threads",
      status: 409,
    });
    expect(router.getThread(thread.id)?.state).toBe("trashed");
    expect(router.projects.get(project.id)).toBeDefined();
    expect(partitionStatus(pid)).toBe("ready");
    expect(obligations.open()).toEqual([]);
  });

  it("purges only trashed threads in the removal commit, then deletes their directories but never the project folder", async () => {
    const { dir, project, pid } = registered("app");
    const isolated = router.createThread({ repoRoot: dir, workspace: "isolated" });
    const tree = await ensureThreadWorktree(dir, isolated.id);
    router.setThreadWorktree(isolated.id, tree.path, tree.baseSha);
    writeFileSync(join(tree.path, "unapplied.txt"), "thread-owned change");
    const asked = router.createThread({ repoRoot: dir });
    const lanes = join(projectRuntimeDir(dir), "lanes", asked.id);
    mkdirSync(join(lanes, "fake-session-default", "home"), { recursive: true });
    writeFileSync(join(lanes, "fake-session-default", "home", "session"), "lane state");
    const other = registered("other");
    const sibling = router.createThread({ repoRoot: other.dir });
    router.trashThread(isolated.id);
    router.trashThread(asked.id);
    const branch = `refs/heads/claudexor/thread-${isolated.id}`;
    expect((await git(dir, ["rev-parse", "--verify", branch])).code).toBe(0);

    const { receipt, purged } = router.removeProjectWithTrashedThreads(project.id, new Set());
    expect(receipt).toEqual({
      projectId: project.id,
      root: dir,
      registryRemoved: true,
      journalPartitionArchived: true,
      archivedPartitionPath: expect.stringMatching(/^partition:project:.+@/),
      artifactsRetained: true,
      activeRunCheck: "snapshot",
    });
    expect(purged.map((thread) => [thread.id, thread.state])).toEqual([
      [isolated.id, "trashed"],
      [asked.id, "trashed"],
    ]);
    // One commit: purged rows (kept physically), pending cleanup obligations
    // carrying the pre-purge record, the registry entry and its generation.
    expect(threadRow(isolated.id)).toEqual({ state: "purged", pid });
    expect(threadRow(asked.id)).toEqual({ state: "purged", pid });
    expect(
      obligations
        .open()
        .map((row) => [row.kind, row.key, row.pid, row.state, (row.payload as any).thread.state])
        .sort(),
    ).toEqual(
      [
        ["purge_fs", isolated.id, pid, "pending", "trashed"],
        ["purge_fs", asked.id, pid, "pending", "trashed"],
      ].sort(),
    );
    expect(router.projects.list().map((item) => item.id)).toEqual([other.project.id]);
    expect(partitionStatus(pid)).toBe("archived");
    expect(router.getThread(isolated.id)).toBeUndefined();
    expect(router.getThread(sibling.id)?.state).toBe("active");
    expect(existsSync(tree.path)).toBe(true);

    const owner = threadPurgeOwner(router, join(root, "no-project"), purge);
    for (const thread of purged) await settled(owner.finishPurge(thread));
    expect(existsSync(join(projectRuntimeDir(dir), "threads", isolated.id))).toBe(false);
    expect((await git(dir, ["rev-parse", "--verify", branch])).code).not.toBe(0);
    expect(existsSync(lanes)).toBe(false);
    expect(readFileSync(join(dir, "sentinel.txt"), "utf8")).toBe("app user bytes");
    expect(readFileSync(join(other.dir, "sentinel.txt"), "utf8")).toBe("other user bytes");
    expect(store.prepare("SELECT count(*) AS n FROM thread WHERE pid=?").get(pid)).toEqual({
      n: 2,
    });
    await tick();
    expect(obligations.open()).toEqual([]);
  });

  it("refuses before any change while a thread is outside the trash or the root snapshot is busy", () => {
    const { dir, project, pid } = registered("mixed");
    const trashed = router.createThread({ repoRoot: dir });
    router.trashThread(trashed.id);
    const active = router.createThread({ repoRoot: dir });
    const unchanged = () => {
      expect(router.getThread(trashed.id)?.state).toBe("trashed");
      expect(router.projects.get(project.id)).toBeDefined();
      expect(partitionStatus(pid)).toBe("ready");
      expect(obligations.open()).toEqual([]);
    };
    expect(
      thrown(() => router.removeProjectWithTrashedThreads(project.id, new Set())),
    ).toMatchObject({
      code: "project_has_threads",
      status: 409,
      message: expect.stringContaining("1 thread(s) outside the trash"),
    });
    unchanged();
    // A closed (archived) conversation is not in the trash either.
    router.updateThread(active.id, { state: "closed" });
    expect(
      thrown(() => router.removeProjectWithTrashedThreads(project.id, new Set())),
    ).toMatchObject({ code: "project_has_threads" });
    unchanged();
    router.trashThread(active.id);
    expect(
      thrown(() => router.removeProjectWithTrashedThreads(project.id, new Set([dir]))),
    ).toMatchObject({ code: "project_has_active_run", status: 409 });
    unchanged();
    expect(
      thrown(() => router.removeProjectWithTrashedThreads("prj-missing", new Set())),
    ).toMatchObject({ code: "project_not_found", status: 404 });
  });

  it("rolls back every purge, obligation and the registry change when the commit fails", () => {
    const { dir, project, pid } = registered("atomic");
    const first = router.createThread({ repoRoot: dir });
    const second = router.createThread({ repoRoot: dir });
    router.trashThread(first.id);
    router.trashThread(second.id);
    store
      .prepare(
        "CREATE TEMP TRIGGER fail_removal BEFORE INSERT ON event WHEN new.type='project.unregistered' BEGIN SELECT RAISE(ABORT,'removal fault'); END",
      )
      .run();
    expect(() => router.removeProjectWithTrashedThreads(project.id, new Set())).toThrow(
      "removal fault",
    );
    expect(router.getThread(first.id)?.state).toBe("trashed");
    expect(router.getThread(second.id)?.state).toBe("trashed");
    expect(obligations.open()).toEqual([]);
    expect(router.projects.get(project.id)).toBeDefined();
    expect(partitionStatus(pid)).toBe("ready");
    store.prepare("DROP TRIGGER fail_removal").run();
    expect(
      router.removeProjectWithTrashedThreads(project.id, new Set()).purged.map((t) => t.id),
    ).toEqual([first.id, second.id]);
  });

  // Mode bits cannot refuse an unlink to root or on Windows.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps a failed cleanup pending and the startup handler finishes it after a restart",
    async () => {
      const { dir, project, pid } = registered("recover");
      const thread = router.createThread({ repoRoot: dir });
      const lanesRoot = join(projectRuntimeDir(dir), "lanes");
      mkdirSync(join(lanesRoot, thread.id), { recursive: true });
      writeFileSync(join(lanesRoot, thread.id, "state"), "lane state");
      router.trashThread(thread.id);
      const { purged } = router.removeProjectWithTrashedThreads(project.id, new Set());
      const owner = threadPurgeOwner(router, join(root, "no-project"), purge);
      // A real permission failure in the real purge effect: the lane home's
      // parent cannot lose an entry, so this thread's cleanup cannot finish.
      chmodSync(lanesRoot, 0o555);
      try {
        await expect(settled(owner.finishPurge(purged[0]!))).rejects.toThrow();
      } finally {
        chmodSync(lanesRoot, 0o755);
      }
      expect(existsSync(join(lanesRoot, thread.id))).toBe(true);
      expect(obligations.open()).toMatchObject([
        { kind: "purge_fs", key: thread.id, pid, state: "pending" },
      ]);

      obligations.close();
      await store.close();
      await open();
      obligations.registerHandler(
        "purge_fs",
        purge.handler(threadPurgeEffect(join(root, "no-project"))),
      );
      const recovery = obligations.completeOpen();
      await tick();
      expect(await recovery).toMatchObject({
        completed: [{ kind: "purge_fs", key: thread.id }],
        failed: [],
      });
      expect(existsSync(join(lanesRoot, thread.id))).toBe(false);
      expect(router.projects.get(project.id)).toBeUndefined();
      expect(threadRow(thread.id)).toEqual({ state: "purged", pid });
      expect(readFileSync(join(dir, "sentinel.txt"), "utf8")).toBe("recover user bytes");
      await tick();
      expect(obligations.open()).toEqual([]);
    },
  );
});

describe("partition-wide busy fence of the opt-in (#333)", () => {
  it("refuses while any command of the project is queued or running, even under a former root or as an Apply", async () => {
    // Its own data root: the manual-tick store above owns `${root}/daemon`.
    const fixtureRoot = join(root, "fixture");
    mkdirSync(fixtureRoot);
    const f = await sqlFixture(fixtureRoot);
    try {
      await f.graph.recoverAfterStartup();
      const dir = join(fixtureRoot, "busy");
      mkdirSync(dir);
      const threads = f.graph.threads;
      const { project } = threads.registerProject({
        root: dir,
        idempotencyKey: "register-busy",
        clientId: "test",
      });
      const thread = threads.createThread({ repoRoot: dir });
      threads.trashThread(thread.id);
      const commands = threads.forRequest({ threadId: thread.id });
      const { record } = commands.accept({
        id: "job-busy",
        params: { threadId: thread.id, scope: { kind: "project", root: "/former/root" } },
        idempotencyKey: "busy",
        clientId: "test",
      });
      expect(record.state).toBe("queued");
      const refusal = () =>
        thrown(() => threads.removeProjectWithTrashedThreads(project.id, new Set()));
      // The root snapshot alone cannot see this run; the partition fence does.
      expect(refusal()).toMatchObject({ code: "project_has_active_run", status: 409 });
      commands.update(record.id, { state: "running", startedAt: new Date().toISOString() });
      expect(refusal()).toMatchObject({ code: "project_has_active_run" });
      commands.update(record.id, { state: "cancelled", finishedAt: new Date().toISOString() });
      const delivery = threads.beginDelivery(
        { threadId: thread.id },
        {
          key: "apply",
          client: "test",
          operation: "thread.apply",
          request: { threadId: thread.id },
        },
      );
      expect(delivery.state).toBe("running");
      expect(refusal()).toMatchObject({ code: "project_has_active_run" });
      expect(threads.getThread(thread.id)?.state).toBe("trashed");
      expect(f.graph.obligations.open()).toEqual([]);
      // The default removal is unchanged: the trashed thread refuses it first.
      expect(thrown(() => threads.removeProject(project.id, new Set()))).toMatchObject({
        code: "project_has_threads",
      });
      threads.failDelivery(delivery.id, new Error("apply abandoned"));
      expect(
        threads.removeProjectWithTrashedThreads(project.id, new Set()).purged.map((t) => t.id),
      ).toEqual([thread.id]);
    } finally {
      await f.close();
    }
  });
});
