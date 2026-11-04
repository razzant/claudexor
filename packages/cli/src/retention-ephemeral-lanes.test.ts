import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { projectRuntimeDir } from "@claudexor/util";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
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
  expect((await gc({ dry_run: false })).errors).toEqual([]);
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

it("keeps quarantined and archived lanes while sweeping an unregistered namespace", async () => {
  const kept: string[] = [];
  for (const status of ["quarantined", "archived"]) {
    const repo = join(root, status);
    mkdirSync(repo);
    const project = sql.graph.projects.register({
      root: repo,
      idempotencyKey: status,
      clientId: "test",
    }).project;
    kept.push(lane(repo, "th-held"));
    if (status === "archived") sql.graph.projects.unregister(project.id);
    else
      sql.store.transaction(() =>
        sql.store
          .prepare("UPDATE partition SET status='quarantined' WHERE id=?")
          .run(sql.graph.projects.partition(project.id)!.pid),
      );
  }
  const orphan = lane(join(root, "unregistered"), "th-orphan");
  expect((await runner()({ dry_run: false })).errors).toEqual([]);
  expect(existsSync(orphan)).toBe(false);
  for (const path of kept) expect(existsSync(path)).toBe(true);
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
