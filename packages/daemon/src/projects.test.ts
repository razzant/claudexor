import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableJournal } from "./store/test-support/fixtures/legacy/journal/index.js";
import { SCHEMA_VERSION } from "@claudexor/schema";
import { describe, expect, it, vi } from "vitest";
import { ProjectStore as FrozenProjectStore } from "./store/test-support/fixtures/legacy/daemon/projects.js";
import { projectNesting } from "./projects.js";
import { applyProjectMutation } from "./store/projects.js";
import { sqlFixture } from "./store/test-support/sql-fixture.js";
import { rmSync as __rmSyncReap } from "node:fs";
import { afterAll as __afterAllReap } from "vitest";

// W-h: reap every temp dir this suite creates so the gate stops leaking tmpdirs.
const __reapDirs: string[] = [];
const sqlStores: Array<Awaited<ReturnType<typeof sqlFixture>>> = [];
async function openSql(root: string) {
  const sql = await sqlFixture(root);
  sqlStores.push(sql);
  return sql;
}
function reapMk(...args: Parameters<typeof mkdtempSync>): string {
  const dir = mkdtempSync(...args);
  __reapDirs.push(dir);
  return dir;
}
__afterAllReap(async () => {
  for (const sql of sqlStores.splice(0).reverse()) await sql.close();
  for (const dir of __reapDirs.splice(0)) __rmSyncReap(dir, { recursive: true, force: true });
});

async function fixture() {
  const base = realpathSync(reapMk(join(tmpdir(), "claudexor-projects-")));
  const journalRoot = join(base, "state");
  const firstRoot = join(base, "first");
  const secondRoot = join(base, "second");
  mkdirSync(firstRoot);
  mkdirSync(secondRoot);
  const sql = await openSql(journalRoot);
  return { base, journalRoot, firstRoot, secondRoot, sql, store: sql.graph.projects };
}

describe("ProjectStore", () => {
  it("keeps the frozen registry replay selective over mixed legacy history", async () => {
    const f = await fixture();
    const journal = new DurableJournal({ rootDir: join(f.base, "legacy"), partition: "global" });
    const store = new FrozenProjectStore(journal);
    const project = store.register({
      root: f.firstRoot,
      idempotencyKey: "filter",
      clientId: "test",
    });
    journal.append("unknown.future.history", { text: "unrelated ".repeat(2048) });
    store.relink(project.id, f.secondRoot);
    const records = vi.spyOn(journal, "records");
    expect(new FrozenProjectStore(journal).list()).toEqual(store.list());
    expect(records).toHaveBeenCalledWith(0, [
      "project.registered",
      "project.relinked",
      "project.unregistered",
    ]);
    records.mockRestore();
    expect(journal.records().map((record) => record.seq)).toEqual([1, 2, 3]);
    journal.close();
  });

  it("starts empty, registers idempotently, and survives restart without v1 import", async () => {
    const f = await fixture();
    expect(f.store.list()).toEqual([]);
    const input = { root: f.firstRoot, idempotencyKey: "register-1", clientId: "test" };
    const { project } = f.store.register(input);
    expect(f.store.register(input).project.id).toBe(project.id);
    expect(() => f.store.register({ ...input, root: f.secondRoot })).toThrow(/different request/);
    await f.sql.close();
    const reloaded = (await openSql(f.journalRoot)).graph.projects;
    expect(reloaded.list()).toEqual([project]);
    expect(reloaded.register(input).project.id).toBe(project.id);
  });

  it("answers whether a registration created the project; a key replay repeats its first answer across restart", async () => {
    const f = await fixture();
    const first = { root: f.firstRoot, idempotencyKey: "created-1", clientId: "test" };
    expect(f.store.register(first).created).toBe(true);
    // The same key and request repeats the ORIGINAL answer, not "now it exists".
    expect(f.store.register(first).created).toBe(true);
    // A new key for an already-registered root (another spelling) finds it.
    const second = {
      root: `${f.base}/first/..//first`,
      idempotencyKey: "created-2",
      clientId: "test",
    };
    expect(f.store.register(second)).toMatchObject({
      created: false,
      project: { root: realpathSync(f.firstRoot) },
    });
    await f.sql.close();
    const reloaded = (await openSql(f.journalRoot)).graph.projects;
    expect(reloaded.register(first).created).toBe(true);
    expect(reloaded.register(second).created).toBe(false);
    // Removal retires the key bindings: the root registers as a new project.
    const { project } = reloaded.register(first);
    reloaded.unregister(project.id);
    const again = reloaded.register(first);
    expect(again.created).toBe(true);
    expect(again.project.id).not.toBe(project.id);
  });

  it("deduplicates canonical roots and relinks one stable project id", async () => {
    const f = await fixture();
    const { project } = f.store.register({
      root: f.firstRoot,
      idempotencyKey: "register-1",
      clientId: "test",
    });
    const { project: same } = f.store.register({
      root: `${f.base}/first/..//first`,
      idempotencyKey: "register-2",
      clientId: "test",
    });
    expect(same.id).toBe(project.id);
    expect(f.store.list()).toHaveLength(1);
    expect(f.store.relink(project.id, f.secondRoot)).toMatchObject({
      id: project.id,
      root: realpathSync(f.secondRoot),
    });
    expect(f.store.relink(project.id, f.secondRoot).id).toBe(project.id);
  });

  it("refuses a project root inside the Claudexor runtime tree (F2 ghost guard)", async () => {
    const f = await fixture();
    const prev = process.env["CLAUDEXOR_CONFIG_DIR"];
    // Treat the fixture base as the owned runtime root; an envelope-worktree
    // shaped path under it must never register as a project.
    process.env["CLAUDEXOR_CONFIG_DIR"] = f.base;
    try {
      const ghostRoot = join(f.base, "projects", "abc", "workspaces", "task-1", "a01", "tree");
      mkdirSync(ghostRoot, { recursive: true });
      expect(() =>
        f.store.register({ root: ghostRoot, idempotencyKey: "ghost", clientId: "test" }),
      ).toThrow(/inside the Claudexor runtime tree/);
      // relink is guarded too — the ok project lives OUTSIDE the owned tree.
      const okRoot = realpathSync(reapMk(join(tmpdir(), "claudexor-ok-")));
      const { project: ok } = f.store.register({
        root: okRoot,
        idempotencyKey: "ok",
        clientId: "test",
      });
      expect(() => f.store.relink(ok.id, ghostRoot)).toThrow(/inside the Claudexor runtime tree/);
    } finally {
      if (prev === undefined) delete process.env["CLAUDEXOR_CONFIG_DIR"];
      else process.env["CLAUDEXOR_CONFIG_DIR"] = prev;
    }
  });

  it("discloses nested-project relations without refusing (F3)", async () => {
    const f = await fixture();
    const outer = f.firstRoot;
    const inner = join(outer, "packages", "inner");
    mkdirSync(inner, { recursive: true });
    const { project: outerProj } = f.store.register({
      root: outer,
      idempotencyKey: "o",
      clientId: "t",
    });
    // Registering the inner project SUCCEEDS (no refusal) and both sides
    // disclose the overlap.
    const { project: innerProj } = f.store.register({
      root: inner,
      idempotencyKey: "i",
      clientId: "t",
    });
    expect(f.store.list()).toHaveLength(2);
    expect(f.store.nestingFor(innerProj.id)).toEqual([
      { relation: "inside", root: realpathSync(outer), projectId: outerProj.id },
    ]);
    expect(f.store.nestingFor(outerProj.id)).toEqual([
      { relation: "contains", root: realpathSync(inner), projectId: innerProj.id },
    ]);
    // A disjoint project has no nesting.
    const { project: other } = f.store.register({
      root: f.secondRoot,
      idempotencyKey: "s",
      clientId: "t",
    });
    expect(f.store.nestingFor(other.id)).toEqual([]);
  });

  it("unregisters a project and forgets its root + idempotency bindings, surviving restart (F2 cleanup)", async () => {
    const f = await fixture();
    const input = { root: f.firstRoot, idempotencyKey: "reg", clientId: "test" };
    const { project } = f.store.register(input);
    expect(f.store.unregister(project.id)?.id).toBe(project.id);
    expect(f.store.list()).toEqual([]);
    // The root frees up and re-registration mints a fresh id (no dangling index).
    expect(f.store.findByRoot(f.firstRoot)).toBeUndefined();
    await f.sql.close();
    const reloaded = (await openSql(f.journalRoot)).graph.projects;
    expect(reloaded.list()).toEqual([]);
    expect(reloaded.unregister("prj-missing")).toBeUndefined();
  });
});

/** A registry replayed from synthetic registrations (roots need not exist). */
async function syntheticRegistry(roots: readonly string[]) {
  const sql = await openSql(realpathSync(reapMk(join(tmpdir(), "claudexor-nesting-"))));
  const at = new Date(0).toISOString();
  sql.store.transaction(() =>
    roots.forEach((root, index) =>
      applyProjectMutation(
        sql.store,
        sql.graph.projects.global().pid,
        "project.registered",
        {
          project: {
            schema_version: SCHEMA_VERSION,
            id: `prj-${String(index).padStart(6, "0")}`,
            root,
            created_at: at,
            updated_at: at,
          },
        },
        at,
      ),
    ),
  );
  return { sql, store: sql.graph.projects };
}

/** The pre-batch projection: one `nestingFor` scan per project. */
function perProject(store: import("./store-contracts.js").ProjectStorePort) {
  return store.list().map((project) => ({ ...project, nesting: store.nestingFor(project.id) }));
}

/** 2035 roots: workspaces with nested packages and prefix-but-not-parent siblings. */
function liveSizedRoots(): string[] {
  const roots: string[] = [];
  for (let user = 0; roots.length < 2035; user += 1) {
    roots.push(`/Users/u${user}`);
    for (let p = 0; p < 20 && roots.length < 2035; p += 1) {
      roots.push(`/Users/u${user}/work/p${p}`);
      if (roots.length < 2035) roots.push(`/Users/u${user}/work/p${p}x`);
      if (p % 3 === 0 && roots.length < 2035) {
        roots.push(`/Users/u${user}/work/p${p}/packages/core`);
      }
    }
  }
  return roots;
}

describe("whole-registry nesting (one pass)", () => {
  it("equals per-project nestingFor on nested, sibling and prefix-but-not-parent roots", async () => {
    const { sql, store } = await syntheticRegistry([
      "/w/a/b/c",
      "/w",
      "/w/a",
      "/w/ab", // a prefix of nothing: "/w/a" is not its parent
      "/w/a b", // sorts between "/w/a" and "/w/a/b"
      "/w/a/b",
      "/w/a/bc",
      "/w/a/..dots", // `relative` reads this name as "..", so nestingFor leaves it out
      "/w/sibling-1",
      "/w/sibling-2",
      "/w/a/b/c/d/e/f",
      "/w/é",
      "/elsewhere/x",
      "/",
    ]);
    const batch = store.listWithNesting();
    expect(batch).toStrictEqual(perProject(store));
    const nesting = (root: string) => batch.find((project) => project.root === root)?.nesting;
    expect(nesting("/w/ab")?.map((n) => `${n.relation} ${n.root}`)).toEqual([
      "inside /",
      "inside /w",
    ]);
    expect(nesting("/w/a/bc")?.map((n) => n.root)).toEqual(["/", "/w", "/w/a"]);
    expect(
      nesting("/w/a")
        ?.filter((n) => n.relation === "contains")
        .map((n) => n.root),
    ).toEqual(["/w/a/b", "/w/a/b/c", "/w/a/b/c/d/e/f", "/w/a/bc"]);
    await sql.close();
  });

  it("equals per-project nestingFor at 2035 roots while testing each root only against its ancestors", async () => {
    const roots = liveSizedRoots();
    expect(roots).toHaveLength(2035);
    const { sql, store } = await syntheticRegistry(roots);
    const nestingFor = vi.spyOn(store, "nestingFor");
    const batch = store.listWithNesting();
    expect(nestingFor).not.toHaveBeenCalled();
    nestingFor.mockRestore();
    expect(batch).toStrictEqual(perProject(store));
    expect(batch.reduce((count, project) => count + project.nesting.length, 0)).toBeGreaterThan(
      2035,
    );
    // Complexity: the containment predicate runs once per (root, registered
    // ancestor) candidate, not once per pair of projects (2035² ≈ 4.1M).
    let tests = 0;
    const counted = projectNesting(store.list(), (child, parent) => {
      tests += 1;
      return child !== parent && child.startsWith(parent === "/" ? "/" : `${parent}/`);
    });
    expect(tests).toBeLessThan(4 * roots.length);
    expect(tests).toBeGreaterThan(0);
    expect([...counted.values()].flat().length).toBe(
      batch.reduce((count, project) => count + project.nesting.length, 0),
    );
    await sql.close();
  });
});
