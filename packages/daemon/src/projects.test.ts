import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableJournal } from "@claudexor/journal";
import { describe, expect, it } from "vitest";
import { ProjectStore } from "./projects.js";

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-projects-")));
  const journalRoot = join(base, "state");
  const firstRoot = join(base, "first");
  const secondRoot = join(base, "second");
  mkdirSync(firstRoot);
  mkdirSync(secondRoot);
  const journal = new DurableJournal({ rootDir: journalRoot, partition: "global" });
  return { base, journalRoot, firstRoot, secondRoot, journal, store: new ProjectStore(journal) };
}

describe("ProjectStore", () => {
  it("starts empty, registers idempotently, and survives restart without v1 import", () => {
    const f = fixture();
    expect(f.store.list()).toEqual([]);
    const input = { root: f.firstRoot, idempotencyKey: "register-1", clientId: "test" };
    const project = f.store.register(input);
    expect(f.store.register(input).id).toBe(project.id);
    expect(() => f.store.register({ ...input, root: f.secondRoot })).toThrow(/different request/);
    f.journal.close();
    const reloaded = new ProjectStore(
      new DurableJournal({ rootDir: f.journalRoot, partition: "global" }),
    );
    expect(reloaded.list()).toEqual([project]);
    expect(reloaded.register(input).id).toBe(project.id);
  });

  it("deduplicates canonical roots and relinks one stable project id", () => {
    const f = fixture();
    const project = f.store.register({
      root: f.firstRoot,
      idempotencyKey: "register-1",
      clientId: "test",
    });
    const same = f.store.register({
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

  it("refuses a project root inside the Claudexor runtime tree (F2 ghost guard)", () => {
    const f = fixture();
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
      const okRoot = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-ok-")));
      const ok = f.store.register({ root: okRoot, idempotencyKey: "ok", clientId: "test" });
      expect(() => f.store.relink(ok.id, ghostRoot)).toThrow(/inside the Claudexor runtime tree/);
    } finally {
      if (prev === undefined) delete process.env["CLAUDEXOR_CONFIG_DIR"];
      else process.env["CLAUDEXOR_CONFIG_DIR"] = prev;
    }
  });

  it("discloses nested-project relations without refusing (F3)", () => {
    const f = fixture();
    const outer = f.firstRoot;
    const inner = join(outer, "packages", "inner");
    mkdirSync(inner, { recursive: true });
    const outerProj = f.store.register({ root: outer, idempotencyKey: "o", clientId: "t" });
    // Registering the inner project SUCCEEDS (no refusal) and both sides
    // disclose the overlap.
    const innerProj = f.store.register({ root: inner, idempotencyKey: "i", clientId: "t" });
    expect(f.store.list()).toHaveLength(2);
    expect(f.store.nestingFor(innerProj.id)).toEqual([
      { relation: "inside", root: realpathSync(outer), projectId: outerProj.id },
    ]);
    expect(f.store.nestingFor(outerProj.id)).toEqual([
      { relation: "contains", root: realpathSync(inner), projectId: innerProj.id },
    ]);
    // A disjoint project has no nesting.
    const other = f.store.register({ root: f.secondRoot, idempotencyKey: "s", clientId: "t" });
    expect(f.store.nestingFor(other.id)).toEqual([]);
  });

  it("unregisters a project and forgets its root + idempotency bindings, surviving restart (F2 cleanup)", () => {
    const f = fixture();
    const input = { root: f.firstRoot, idempotencyKey: "reg", clientId: "test" };
    const project = f.store.register(input);
    expect(f.store.unregister(project.id)?.id).toBe(project.id);
    expect(f.store.list()).toEqual([]);
    // The root frees up and re-registration mints a fresh id (no dangling index).
    expect(f.store.findByRoot(f.firstRoot)).toBeUndefined();
    f.journal.close();
    const reloaded = new ProjectStore(
      new DurableJournal({ rootDir: f.journalRoot, partition: "global" }),
    );
    expect(reloaded.list()).toEqual([]);
    expect(reloaded.unregister("prj-missing")).toBeUndefined();
  });
});
