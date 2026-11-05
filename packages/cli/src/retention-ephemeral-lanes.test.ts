import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { projectRuntimeDir } from "@claudexor/util";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { quarantineGeneration } from "../../daemon/dist/store/generations.js";
import { createRetentionRunner } from "./retention-service.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

let root: string;
let before: string | undefined;
let sql: Awaited<ReturnType<typeof sqlFixture>>;
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cx-ephemeral-lanes-")));
  before = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = join(root, "engine");
  mkdirSync(process.env.CLAUDEXOR_CONFIG_DIR);
  sql = await sqlFixture(join(root, "sql"));
});
afterEachClosed(async () => {
  vi.restoreAllMocks();
  await sql.close();
  return () => {
    if (before === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = before;
    rmSync(root, { recursive: true, force: true });
  };
});
function lane(repo: string, thread: string) {
  const path = join(projectRuntimeDir(repo), "lanes", thread, "codex-default", "home");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "session"), "native state");
  return path;
}
function runner() {
  return createRetentionRunner({
    projects: () => sql.graph.projects,
    threads: sql.graph.threads,
    daemonJobs: () => [],
    purgeThread: async () => {},
    hasPurgeLeftovers: () => false,
  });
}

it("sweeps the last orphan after its ephemeral thread is purged, including without a remaining root record", async () => {
  const repo = join(root, "one-shot");
  mkdirSync(repo);
  const thread = sql.graph.threads.createThread({
    title: "ephemeral",
    repoRoot: repo,
    ephemeral: true,
    workspace: "in_place",
  });
  const held = lane(repo, thread.id);
  const orphan = lane(repo, "th-orphan");
  const gc = runner();
  expect((await gc({ dry_run: true })).errors).toEqual([]);
  expect(existsSync(orphan)).toBe(true);
  const receipt = await gc({ dry_run: false });
  expect(receipt.errors).toEqual([]);
  expect(receipt.deleted_lanes).toBe(1);
  expect(existsSync(orphan)).toBe(false);
  expect(existsSync(held)).toBe(true);
  sql.graph.threads.trashThread(thread.id);
  sql.graph.threads.purgeThread(thread.id);
  // A fully settled purge has no remaining obligation or root lookup to drive cleanup.
  sql.store.transaction(() => {
    sql.store
      .prepare("DELETE FROM effect_obligation WHERE kind='purge_fs' AND key=?")
      .run(thread.id);
    sql.store.prepare("DELETE FROM thread WHERE id=?").run(thread.id);
  });
  expect(sql.graph.projects.list()).toEqual([]);
  expect((await gc({ dry_run: false })).errors).toEqual([]);
  expect(existsSync(held)).toBe(false);
});

it("keeps lanes through real quarantine and archive while sweeping an unregistered namespace", async () => {
  const archivedRepo = join(root, "archived");
  mkdirSync(archivedRepo);
  const archivedProject = sql.graph.projects.register({
    root: archivedRepo,
    idempotencyKey: "archived",
    clientId: "test",
  }).project;
  const archivedLane = lane(archivedRepo, "th-archived");
  sql.graph.projects.unregister(archivedProject.id);

  const quarantinedRepo = join(root, "quarantined");
  mkdirSync(quarantinedRepo);
  const quarantinedProject = sql.graph.projects.register({
    root: quarantinedRepo,
    idempotencyKey: "quarantined",
    clientId: "test",
  }).project;
  const quarantinedThread = sql.graph.threads.createThread({
    title: "quarantined",
    repoRoot: quarantinedRepo,
    workspace: "in_place",
  });
  const quarantinedLane = lane(quarantinedRepo, quarantinedThread.id);
  const quarantinedPid = sql.graph.projects.partition(quarantinedProject.id)!.pid;
  const quarantine = quarantineGeneration(sql.store, sql.graph.blobs, {
    oldPid: quarantinedPid,
    keyDigest: "quarantined-lanes",
    requestDigest: "quarantined-lanes",
    operationId: "op-quarantined-lanes",
    payload: { operationId: "op-quarantined-lanes" },
  });
  expect(quarantine.replay).toBe(false);
  // Quarantined bodies are evidence and may be malformed; lane ownership uses
  // the indexed id only and must not decode this row.
  sql.store.transaction(() =>
    sql.store.prepare("UPDATE thread SET body=x'00' WHERE id=?").run(quarantinedThread.id),
  );

  const orphan = lane(join(root, "unregistered"), "th-orphan");
  const receipt = await runner()({ dry_run: false });
  expect(receipt.errors).toEqual([]);
  expect(receipt.deleted_lanes).toBe(1);
  expect(existsSync(orphan)).toBe(false);
  expect(existsSync(archivedLane)).toBe(true);
  expect(existsSync(quarantinedLane)).toBe(true);
});

it("keeps a symlink-spelled live thread lane after its root vanishes", async () => {
  const target = join(root, "symlink-target");
  const spelling = join(root, "symlink-spelling");
  mkdirSync(target);
  symlinkSync(target, spelling, "dir");
  const thread = sql.graph.threads.createThread({
    title: "symlink",
    repoRoot: spelling,
    ephemeral: true,
    workspace: "in_place",
  });
  const held = lane(spelling, thread.id);
  rmSync(target, { recursive: true, force: true });
  expect((await runner()({ dry_run: false })).errors).toEqual([]);
  expect(existsSync(held)).toBe(true);
});

it("protects a late ephemeral lane even when namespace inventory had no root name", async () => {
  const repo = join(root, "late-ephemeral");
  mkdirSync(repo);
  const orphan = lane(repo, "th-orphan");
  let held: string | undefined;
  const read = sql.graph.threads.retentionReferences.bind(sql.graph.threads);
  vi.spyOn(sql.graph.threads, "retentionReferences").mockImplementationOnce(async (...args) => {
    const refs = await read(...args);
    const ids = refs.laneThreadIds!;
    refs.laneThreadIds = (...args) => {
      if (!held) {
        const thread = sql.graph.threads.createThread({
          title: "late",
          repoRoot: repo,
          ephemeral: true,
          workspace: "in_place",
        });
        held = lane(repo, thread.id);
      }
      return ids(...args);
    };
    return refs;
  });
  expect((await runner()({ dry_run: false })).errors).toEqual([]);
  expect(held).toBeDefined();
  expect(existsSync(held!)).toBe(true);
  expect(existsSync(orphan)).toBe(false);
});
