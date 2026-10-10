import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DurableJournal } from "./test-support/fixtures/legacy/journal/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlobFiles } from "./blob-files.js";
import { setGlobalGenerationInTx } from "./generations.js";
import { Obligations } from "./obligations.js";
import { createPartition } from "./partitions.js";
import { SqlProjectRouter } from "./project-router.js";
import { applyProjectMutation, SqlProjectStore } from "./projects.js";
import { EngineStore } from "./store.js";
import { legacyOracle } from "./test-support/legacy-oracle.js";

const clock = vi.hoisted(() => ({ at: "2030-01-01T00:00:00.000Z", id: 0 }));
vi.mock("@claudexor/util", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@claudexor/util")>()),
  nowIso: () => clock.at,
  newId: (prefix: string) => `${prefix}-${++clock.id}`,
}));
vi.mock("./test-support/fixtures/legacy/util/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./test-support/fixtures/legacy/util/index.js")>()),
  nowIso: () => clock.at,
  newId: (prefix: string) => `${prefix}-${++clock.id}`,
}));
let root: string,
  store: EngineStore,
  obligations: Obligations,
  sql: SqlProjectStore,
  router: SqlProjectRouter,
  journal: DurableJournal;
let legacy: InstanceType<typeof legacyOracle.daemonProjects.ProjectStore>;
beforeEach(async () => {
  clock.id = 0;
  clock.at = "2030-01-01T00:00:00.000Z";
  root = realpathSync(mkdtempSync(join(tmpdir(), "cx-sql-projects-")));
  store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: resolve(import.meta.dirname, "../../dist/store/flusher-worker.js"),
    flusherHooks: { manualTick: true },
  });
  obligations = new Obligations(store);
  store.transaction(() => setGlobalGenerationInTx(store, createPartition(store, "global").pid));
  sql = new SqlProjectStore(store, new BlobFiles(store), obligations);
  router = new SqlProjectRouter(sql);
  journal = new DurableJournal({
    rootDir: join(root, "legacy"),
    partition: "global",
    deferCompaction: true,
  });
  legacy = new legacyOracle.daemonProjects.ProjectStore(journal);
});
afterEach(async () => {
  journal?.close();
  obligations?.close();
  await store?.close();
  rmSync(root, { recursive: true, force: true });
});
function both<T>(fn: (s: Pick<SqlProjectStore, "list" | "relink" | "unregister">) => T): T {
  const start = clock.id,
    expected = fn(legacy);
  const end = clock.id;
  clock.id = start;
  const actual = fn(sql);
  expect(actual).toEqual(expected);
  expect(clock.id).toBe(end);
  return actual;
}

// PR-A added the registration receipt after the frozen baseline: compare its
// complete project to that oracle, and assert the additive created field itself.
function registerBoth(input: Parameters<SqlProjectStore["register"]>[0]) {
  const start = clock.id,
    expected = legacy.register(input);
  const end = clock.id;
  clock.id = start;
  const actual = sql.register(input);
  expect(actual.project).toEqual(expected);
  expect(clock.id).toBe(end);
  return actual;
}

function path(name: string): string {
  const value = join(root, name);
  mkdirSync(value, { recursive: true });
  return value;
}

describe("SQL project registry parity", () => {
  it("replays both registration keys with their own original created flag at identical times", async () => {
    const dir = path("project");
    const first = { root: dir, idempotencyKey: "first", clientId: "test" };
    const second = { root: dir, idempotencyKey: "second", clientId: "test" };
    const p = registerBoth(first);
    expect(p.created).toBe(true);
    expect(registerBoth(second).created).toBe(false);
    expect(registerBoth(first).created).toBe(true);
    expect(registerBoth(second).created).toBe(false);
    const target = path("new-root");
    both((s) => s.relink(p.project.id, target));
    expect(registerBoth(first)).toMatchObject({ created: true, project: { root: target } });
    obligations.close();
    await store.close();
    store = await EngineStore.open({
      daemonDir: join(root, "daemon"),
      workerEntry: resolve(import.meta.dirname, "../../dist/store/flusher-worker.js"),
      flusherHooks: { manualTick: true },
    });
    obligations = new Obligations(store);
    sql = new SqlProjectStore(store, new BlobFiles(store), obligations);
    expect(registerBoth(second)).toMatchObject({
      created: false,
      project: { id: p.project.id, root: target },
    });
  });

  it("preserves nesting, relink identity and unregister semantics", () => {
    const p = path("parent"),
      child = path("parent/child");
    const first = registerBoth({ root: p, idempotencyKey: "p", clientId: "test" }).project;
    registerBoth({ root: child, idempotencyKey: "c", clientId: "test" });
    expect(sql.listWithNesting()).toEqual(
      legacy.list().map((p) => ({ ...p, nesting: legacy.nestingFor(p.id) })),
    );
    for (const s of [sql, legacy])
      expect(() => s.relink(first.id, child)).toThrow("already registered");
    const stable = sql.partition(first.id)!.pid;
    both((s) => s.relink(first.id, path("other")));
    expect(sql.partition(first.id)!.pid).toBe(stable);
    both((s) => s.unregister(first.id));
    both((s) => s.unregister(first.id));
    both((s) => s.list());
    expect(store.prepare("SELECT status FROM partition WHERE id=?").get(stable)).toEqual({
      status: "archived",
    });
  });

  it("relinks all thread roots atomically with the registry and global head event", () => {
    const first = sql.register({
      root: path("one"),
      idempotencyKey: "one",
      clientId: "test",
    }).project;
    const thread = router.createThread({
      repoRoot: first.root,
      workspace: "delegated",
      workspaceRoot: "/caller-workspace",
    });
    const newRoot = path("two");
    store
      .prepare(
        "CREATE TEMP TRIGGER fail_head BEFORE INSERT ON event WHEN new.type='thread.head.updated' BEGIN SELECT RAISE(ABORT,'head fault'); END",
      )
      .run();
    expect(() => sql.relink(first.id, newRoot)).toThrow("head fault");
    expect(sql.get(first.id)).toEqual(first);
    expect(router.getThread(thread.id)).toEqual(thread);
    store.prepare("DROP TRIGGER fail_head").run();
    sql.relink(first.id, newRoot);
    expect(router.getThread(thread.id)?.repo?.root).toBe(newRoot);
    expect(router.getThread(thread.id)?.workspace.workspace_root).toBe("/caller-workspace");
  });

  it("remove discloses a logical archive and preserves its existing refusal paths", () => {
    const p = sql.register({ root: path("one"), idempotencyKey: "one", clientId: "test" }).project;
    const t = router.createThread({ repoRoot: p.root });
    expect(() => sql.remove(p.id, new Set())).toThrow("still has 1 thread");
    router.trashThread(t.id);
    router.purgeThread(t.id);
    expect(() => sql.remove(p.id, new Set([p.root]))).toThrow("live or queued run");
    const generation = sql.partition(p.id)!;
    const receipt = sql.remove(p.id, new Set());
    expect(receipt).toEqual({
      projectId: p.id,
      root: p.root,
      registryRemoved: true,
      journalPartitionArchived: true,
      archivedPartitionPath: `partition:${generation.name}@${generation.epoch}`,
      artifactsRetained: true,
      activeRunCheck: "snapshot",
    });
    expect(store.prepare("SELECT count(*) AS n FROM thread").get()).toEqual({ n: 1 });
  });

  it("pure import derives created from original order without generating runtime events", () => {
    const dir = path("one");
    legacy.register({ root: dir, idempotencyKey: "one", clientId: "test" });
    legacy.register({ root: dir, idempotencyKey: "two", clientId: "test" });
    for (const record of journal.records(0, ["project.registered"]))
      store.transaction(() =>
        applyProjectMutation(
          store,
          sql.global().pid,
          "project.registered",
          record.payload,
          record.time,
        ),
      );
    expect(sql.list()).toEqual(legacy.list());
    expect(sql.register({ root: dir, idempotencyKey: "one", clientId: "test" }).created).toBe(true);
    expect(sql.register({ root: dir, idempotencyKey: "two", clientId: "test" }).created).toBe(
      false,
    );
    expect(store.prepare("SELECT count(*) AS n FROM event").get()).toEqual({ n: 0 });
  });
});
