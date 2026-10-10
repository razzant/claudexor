import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectRuntimeDir } from "@claudexor/util";
import { ensureThreadWorktree, git } from "@claudexor/workspace";
import { threadPurgeEffect, threadPurgeOwner } from "../../../cli/src/thread-purge.js";
import { BlobFiles } from "./blob-files.js";
import { setGlobalGenerationInTx } from "./generations.js";
import { Obligations } from "./obligations.js";
import { createPartition } from "./partitions.js";
import { SqlProjectRouter } from "./project-router.js";
import { SqlProjectStore } from "./projects.js";
import { partitionFilesHandler, SqlPurgeFiles } from "./purge-files.js";
import { EngineStore } from "./store.js";

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
  root = realpathSync(mkdtempSync(join(tmpdir(), "cx-sql-purge-")));
  vi.stubEnv("CLAUDEXOR_CONFIG_DIR", join(root, "config"));
  await open();
  store.transaction(() => setGlobalGenerationInTx(store, createPartition(store, "global").pid));
});
afterEach(async () => {
  vi.restoreAllMocks();
  obligations?.close();
  await store?.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
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

describe("purge decision and filesystem custody", () => {
  it("removes a real isolated worktree and its branch while retaining project and sibling bytes", async () => {
    const project = join(root, "project");
    mkdirSync(project);
    writeFileSync(join(project, "keep.txt"), "project bytes");
    const thread = router.createThread({ repoRoot: project, workspace: "isolated" });
    const tree = await ensureThreadWorktree(project, thread.id);
    router.setThreadWorktree(thread.id, tree.path, tree.baseSha);
    writeFileSync(join(tree.path, "unpublished.txt"), "owned bytes");
    const sibling = join(projectRuntimeDir(project), "lanes", "th-sibling");
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "keep"), "sibling bytes");
    expect(
      (await git(project, ["rev-parse", "--verify", `refs/heads/claudexor/thread-${thread.id}`]))
        .code,
    ).toBe(0);
    router.trashThread(thread.id);
    const operation = threadPurgeOwner(router, join(root, "no-project"), purge).purgeThread(
      thread.id,
    );
    await tick();
    await operation;
    expect(existsSync(tree.path)).toBe(false);
    expect(
      (await git(project, ["rev-parse", "--verify", `refs/heads/claudexor/thread-${thread.id}`]))
        .code,
    ).not.toBe(0);
    expect(readFileSync(join(project, "keep.txt"), "utf8")).toBe("project bytes");
    expect(readFileSync(join(sibling, "keep"), "utf8")).toBe("sibling bytes");
  });
  it("waits for the decision barrier and keeps the conversation and caller-owned workspace", async () => {
    const workspace = join(root, "caller");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "keep.txt"), "caller bytes");
    const thread = router.createThread({
      repoRoot: root,
      workspace: "delegated",
      workspaceRoot: workspace,
    });
    const turn = router.createTurn(thread.id, "keep the conversation", {
      idempotency: { key: "turn", client: "test", request: {} },
    });
    const lanes = join(projectRuntimeDir(root), "lanes", thread.id);
    mkdirSync(lanes, { recursive: true });
    writeFileSync(join(lanes, "owned"), "state");
    router.trashThread(thread.id);
    const owner = threadPurgeOwner(router, join(root, "no-project"), purge);
    let completed = false;
    const result = owner.purgeThread(thread.id).then((value) => {
      completed = true;
      return value;
    });
    expect(router.getThread(thread.id)?.state).toBe("purged");
    expect(completed).toBe(false);
    expect(existsSync(lanes)).toBe(true);
    expect(obligations.open()).toMatchObject([{ state: "pending", kind: "purge_fs" }]);
    await tick();
    await result;
    expect(existsSync(lanes)).toBe(false);
    expect(readFileSync(join(workspace, "keep.txt"), "utf8")).toBe("caller bytes");
    expect(router.getTurn(turn.id)?.prompt).toBe("keep the conversation");
    expect(obligations.open()).toMatchObject([{ state: "materialized" }]);
    await tick();
    expect(obligations.open()).toEqual([]);
    expect(
      router.findTurnByIdempotency(thread.id, { key: "turn", client: "test", request: {} })?.id,
    ).toBe(turn.id);
  });

  it("retains pending after a partial filesystem failure and retries the same obligation", async () => {
    const thread = router.createThread({});
    router.trashThread(thread.id);
    router.purgeThread(thread.id);
    const perform = vi
      .fn()
      .mockRejectedValueOnce(new Error("EIO after first directory"))
      .mockResolvedValue([root]);
    const failed = purge.complete(thread.id, perform);
    const rejected = expect(failed).rejects.toThrow("EIO");
    await tick();
    await rejected;
    expect(obligations.open()).toMatchObject([{ state: "pending", key: thread.id }]);
    const retry = purge.complete(thread.id, perform);
    await tick();
    await retry;
    expect(perform).toHaveBeenCalledTimes(2);
    expect(obligations.open()).toMatchObject([{ state: "materialized" }]);
    expect(router.getThread(thread.id)?.state).toBe("purged");
  });

  it("joins concurrent retries and does not repeat materialized file effects", async () => {
    const thread = router.createThread({});
    router.trashThread(thread.id);
    router.purgeThread(thread.id);
    const perform = vi.fn(async () => [root]);
    const first = purge.complete(thread.id, perform),
      second = purge.complete(thread.id, perform);
    expect(second).toBe(first);
    await tick();
    await first;
    const replay = purge.complete(thread.id, perform);
    await tick();
    await replay;
    expect(perform).toHaveBeenCalledTimes(1);
    expect(obligations.open()).toEqual([]);
  });

  it("reopens after the decision and completes real owned leftovers through the startup handler", async () => {
    const thread = router.createThread({ repoRoot: root, workspace: "isolated" });
    const turn = router.createTurn(thread.id, "retained");
    const dir = join(projectRuntimeDir(root), "threads", thread.id, "tree");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "unfinished"), "owned bytes");
    router.trashThread(thread.id);
    router.purgeThread(thread.id);
    obligations.close();
    await store.close();
    await open();
    obligations.registerHandler(
      "purge_fs",
      purge.handler(threadPurgeEffect(join(root, "no-project"))),
    );
    const recovery = obligations.completeOpen();
    expect(existsSync(dir)).toBe(true);
    await tick();
    expect(await recovery).toMatchObject({
      completed: [{ kind: "purge_fs", key: thread.id }],
      failed: [],
    });
    expect(existsSync(dir)).toBe(false);
    expect(router.getTurn(turn.id)?.prompt).toBe("retained");
    // A second process cannot use the preceding process's materialized_g.
    obligations.close();
    await store.close();
    await open();
    obligations.registerHandler(
      "purge_fs",
      purge.handler(threadPurgeEffect(join(root, "no-project"))),
    );
    const again = obligations.completeOpen();
    await tick();
    expect((await again).failed).toEqual([]);
    await tick();
    expect(obligations.open()).toEqual([]);
  });

  it("does not persist a purge obligation when its head event rolls back", () => {
    const thread = router.createThread({});
    router.trashThread(thread.id);
    store
      .prepare(
        "CREATE TEMP TRIGGER fail_purge BEFORE INSERT ON event WHEN new.type='thread.head.updated' BEGIN SELECT RAISE(ABORT,'head fault'); END",
      )
      .run();
    expect(() => router.purgeThread(thread.id)).toThrow("head fault");
    expect(router.getThread(thread.id)?.state).toBe("trashed");
    expect(obligations.open()).toEqual([]);
  });

  it("archive/quarantine handlers replay only explicit real leftover paths", async () => {
    const source = join(root, "legacy-partition"),
      destination = join(root, "archive");
    mkdirSync(source);
    writeFileSync(join(source, "history"), "evidence");
    store.transaction(() =>
      obligations.create("archive_fs", "archive", 1, { source, destination }),
    );
    obligations.registerHandler("archive_fs", partitionFilesHandler(store));
    const completion = obligations.completeOpen();
    expect(existsSync(source)).toBe(true);
    await tick();
    expect((await completion).failed).toEqual([]);
    expect(readFileSync(join(destination, "history"), "utf8")).toBe("evidence");
    const replay = obligations.completeOpen();
    await tick();
    expect((await replay).failed).toEqual([]);
  });
});
