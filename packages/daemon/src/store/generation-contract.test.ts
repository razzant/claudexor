import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlobFiles } from "./blob-files.js";
import { readJournalEvents, encodeJournalCursor } from "./cursors.js";
import {
  archiveGenerationInTx,
  globalGeneration,
  isServedPid,
  quarantineGeneration,
  restoreGenerationInTx,
  setGenerationStatusInTx,
  setGlobalGenerationInTx,
  SERVED_PIDS_SQL,
} from "./generations.js";
import { bindIdempotencyInTx } from "./idempotency.js";
import { Obligations } from "./obligations.js";
import { createPartition, currentGeneration } from "./partitions.js";
import { SqlProjectRouter } from "./project-router.js";
import { SqlProjectStore } from "./projects.js";
import { EngineStore } from "./store.js";

let root: string,
  store: EngineStore,
  blobs: BlobFiles,
  obligations: Obligations,
  projects: SqlProjectStore,
  router: SqlProjectRouter;
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cx-sql-generations-")));
  store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: resolve(import.meta.dirname, "../../dist/store/flusher-worker.js"),
    flusherHooks: { manualTick: true },
  });
  blobs = new BlobFiles(store);
  obligations = new Obligations(store);
  store.transaction(() => setGlobalGenerationInTx(store, createPartition(store, "global").pid));
  projects = new SqlProjectStore(store, blobs, obligations);
  router = new SqlProjectRouter(projects);
});
afterEach(async () => {
  obligations?.close();
  await store?.close();
  rmSync(root, { recursive: true, force: true });
});
function project(name: string) {
  const path = join(root, name);
  mkdirSync(path);
  return projects.register({ root: path, idempotencyKey: name, clientId: "test" }).project;
}
function command(pid: number, id: string) {
  store.transaction(() =>
    store
      .prepare(
        "INSERT INTO command(id,pid,operation,state,created_at,summary,params_sha,kind) VALUES(?,?,'run.create','queued','2000',x'7b7d','fixture','product')",
      )
      .run(id, pid),
  );
}
function invariant() {
  expect(
    store
      .prepare(`SELECT count(*) AS n FROM command WHERE live=1 AND pid NOT IN (${SERVED_PIDS_SQL})`)
      .get(),
  ).toEqual({ n: 0 });
}
function quarantine(pid: number, key: string) {
  return quarantineGeneration(store, blobs, {
    oldPid: pid,
    keyDigest: key,
    requestDigest: key,
    operationId: `op-${key}`,
    payload: { operationId: `op-${key}` },
  });
}

describe("served partition generations", () => {
  it("archives/restores only served ready generations and retains all evidence", () => {
    const p = project("one"),
      g = projects.partition(p.id)!;
    command(g.pid, "one");
    const thread = router.createThread({ repoRoot: p.root });
    const cursor = encodeJournalCursor(g.name, g.epoch, 0);
    const archive = store.transaction(() => archiveGenerationInTx(store, g.pid));
    expect(archive).toBe(`partition:${g.name}@${g.epoch}`);
    expect(router.getThread(thread.id)).toBeUndefined();
    expect(isServedPid(store, g.pid)).toBe(false);
    invariant();
    expect(() => readJournalEvents(store, g.name, cursor)).toThrow("resnapshot");
    store.transaction(() => restoreGenerationInTx(store, g.pid));
    expect(router.getThread(thread.id)).toEqual(thread);
    expect(isServedPid(store, g.pid)).toBe(true);
    invariant();
    store.transaction(() => setGenerationStatusInTx(store, g.pid, "recovery_required"));
    invariant();
    expect(router.getThread(thread.id)).toBeUndefined();
    store.transaction(() => setGenerationStatusInTx(store, g.pid, "ready"));
    invariant();
    expect(router.getThread(thread.id)).toEqual(thread);
  });

  it("project quarantine hides old state, keys and cursors while current project survives", () => {
    const p = project("one"),
      g = projects.partition(p.id)!;
    command(g.pid, "old");
    const input = {
      repoRoot: p.root,
      idempotency: { key: "creation", client: "test", request: { root: p.root } },
    };
    const old = router.createThread(input),
      cursor = encodeJournalCursor(g.name, g.epoch, 0);
    const result = quarantine(g.pid, "quarantine-1");
    expect(result.generation?.pid).not.toBe(g.pid);
    expect(projects.get(p.id)).toEqual(p);
    expect(router.getThread(old.id)).toBeUndefined();
    expect(router.findThreadCreation(input)).toBeNull();
    expect(() => readJournalEvents(store, g.name, cursor)).toThrow("stale epoch");
    const fresh = router.createThread(input);
    expect(fresh.id).not.toBe(old.id);
    invariant();
    const replay = quarantine(g.pid, "quarantine-1");
    expect(replay.replay).toBe(true);
    expect(replay.binding.targetId).toBe("op-quarantine-1");
    expect(store.prepare("SELECT count(*) AS n FROM thread").get()).toEqual({ n: 2 });
    expect(() =>
      quarantineGeneration(store, blobs, {
        oldPid: g.pid,
        keyDigest: "quarantine-1",
        requestDigest: "changed",
        operationId: "x",
        payload: {},
      }),
    ).toThrow("different request");
  });

  it("global quarantine hides every former project even when its partition stays ready", () => {
    const p = project("one"),
      p2 = project("two"),
      g = projects.partition(p.id)!;
    command(g.pid, "old-project");
    command(projects.partition(p2.id)!.pid, "old-project-2");
    command(globalGeneration(store)!.pid, "old-global");
    const thread = router.createThread({ repoRoot: p.root });
    store.transaction(() =>
      bindIdempotencyInTx(store, {
        owner: "upload",
        pid: 0,
        keyDigest: "upload",
        requestDigest: "upload",
        operation: "upload.create",
        targetId: "up-1",
        createdAt: "2000",
        result: { uploadId: "up-1" },
      }),
    );
    const cursor = encodeJournalCursor(g.name, g.epoch, 0);
    quarantine(globalGeneration(store)!.pid, "global");
    expect(projects.list()).toEqual([]);
    expect(router.getThread(thread.id)).toBeUndefined();
    invariant();
    expect(currentGeneration(store, g.name)).toBeNull();
    expect(() => readJournalEvents(store, g.name, cursor)).toThrow("resnapshot");
    expect(store.prepare("SELECT count(*) AS n FROM command WHERE live=1").get()).toEqual({ n: 0 });
    expect(
      store.prepare("SELECT target_id FROM idempotency WHERE owner='upload' AND pid=0").get(),
    ).toEqual({ target_id: "up-1" });
    const next = projects.register({
      root: p.root,
      idempotencyKey: "new",
      clientId: "test",
    }).project;
    expect(next.id).not.toBe(p.id);
    expect(projects.partition(next.id)!.pid).not.toBe(g.pid);
    expect(router.createThread({ repoRoot: p.root }).repo?.root).toBe(p.root);
    invariant();
  });

  it("unregister removes project bindings, not archived conversations, and never re-adopts by root", () => {
    const p = project("one"),
      g = projects.partition(p.id)!;
    command(g.pid, "old");
    const thread = router.createThread({ repoRoot: p.root });
    projects.unregister(p.id);
    invariant();
    store.transaction(() => restoreGenerationInTx(store, g.pid));
    invariant();
    expect(router.getThread(thread.id)).toBeUndefined();
    expect(currentGeneration(store, g.name)).toBeNull();
    expect(
      store
        .prepare("SELECT count(*) AS n FROM idempotency WHERE owner='project' AND target_id=?")
        .get(p.id),
    ).toEqual({ n: 0 });
    const next = projects.register({
      root: p.root,
      idempotencyKey: "one",
      clientId: "test",
    }).project;
    expect(next.id).not.toBe(p.id);
    expect(projects.partition(next.id)?.pid).not.toBe(g.pid);
    invariant();
    expect(store.prepare("SELECT id FROM thread WHERE id=?").get(thread.id)).toEqual({
      id: thread.id,
    });
  });

  it("a quarantine-event failure rolls generation, registry and visibility back", () => {
    const p = project("one"),
      g = projects.partition(p.id)!;
    command(g.pid, "command");
    store
      .prepare(
        "CREATE TEMP TRIGGER fail_quarantine BEFORE INSERT ON event WHEN new.type='journal.partition_quarantined' BEGIN SELECT RAISE(ABORT,'quarantine fault'); END",
      )
      .run();
    expect(() => quarantine(g.pid, "fault")).toThrow("quarantine fault");
    expect(projects.partition(p.id)?.pid).toBe(g.pid);
    expect(isServedPid(store, g.pid)).toBe(true);
    invariant();
    expect(store.prepare("SELECT count(*) AS n FROM partition").get()).toEqual({ n: 2 });
    expect(
      store.prepare("SELECT count(*) AS n FROM idempotency WHERE owner='quarantine'").get(),
    ).toEqual({ n: 0 });
  });

  it("recovers only current interrupted runless turns without reading command bodies", () => {
    const thread = router.createThread({});
    const turn = router.createTurn(thread.id, "accepted but not started");
    const pid = projects.global().pid;
    store.transaction(() =>
      store
        .prepare(
          `INSERT INTO command(id,pid,operation,state,turn_id,created_at,summary,params_sha,kind,error)
      VALUES('interrupted',?,'run.create','interrupted',?,'2000',x'7b7d','absent-body','product',?)`,
        )
        .run(
          pid,
          turn.id,
          Buffer.from(JSON.stringify({ error: "restarted", errorCode: "daemon_restart" })),
        ),
    );
    // The legacy command projection replays acceptance order, not wall time.
    store.transaction(() =>
      store
        .prepare(
          `INSERT INTO command(id,pid,operation,state,turn_id,created_at,summary,params_sha,kind,error)
      VALUES('later-acceptance',?,'run.create','interrupted',?,'1999',x'7b7d','also-absent','product',?)`,
        )
        .run(pid, turn.id, Buffer.from(JSON.stringify({ error: "later refusal" }))),
    );
    expect(router.recoverRunlessTurns()).toBe(1);
    expect(router.getTurn(turn.id)?.enqueue_error).toMatchObject({
      code: "daemon_restarted_before_start",
      message: "restarted",
    });
    expect(router.recoverRunlessTurns()).toBe(0);
    quarantine(pid, "global-runless");
    expect(router.recoverRunlessTurns()).toBe(0);
  });
});
