import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { sqlFixture } from "./test-support/sql-fixture.js";
import { diskRetentionReferences } from "./retention-references.js";
import { retentionGenerations } from "./retention-generations.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "retention-topology-")));
  const sql = await sqlFixture(root);
  cleanups.push(async () => {
    await sql.close();
    rmSync(root, { recursive: true, force: true });
  });
  const register = (name: string) => {
    const path = join(root, name);
    mkdirSync(path);
    return sql.graph.projects.register({ root: path, idempotencyKey: name, clientId: "test" })
      .project;
  };
  return { ...sql, root, register };
}

it("absorbs a partition and continuation born during inventory, but rejects a missing live pid", async () => {
  const sql = await fixture();
  const generations = retentionGenerations(sql.store);
  const pending = diskRetentionReferences(sql.store);
  const project = sql.register("late");
  const params = { scope: { kind: "project", root: project.root }, continueFrom: "source" };
  sql.graph.commands.forRequest(params).accept({
    id: "late-command",
    params,
    idempotencyKey: "late",
    clientId: "test",
  });
  const proof = await pending;
  try {
    expect(proof.isCurrent()).toBe(false);
    expect(proof.recheck!()).toBe(true);
    expect(proof.referencedRunIds.has("source")).toBe(true);
    expect(generations.retained(sql.graph.projects.partition(project.id)!.pid)).toBe(true);
    expect(() => generations.retained(999999)).toThrow("missing partition 999999");
  } finally {
    proof.close!();
  }
});

it("holds every old and new root through relink and removal without vetoing unrelated proof", async () => {
  const sql = await fixture();
  const project = sql.register("original");
  const proof = await diskRetentionReferences(sql.store);
  const middle = join(sql.root, "middle");
  const last = join(sql.root, "last");
  mkdirSync(middle);
  mkdirSync(last);
  sql.graph.projects.relink(project.id, middle);
  sql.graph.projects.relink(project.id, last);
  sql.store.transaction(() => sql.store.prepare("DELETE FROM project WHERE id=?").run(project.id));
  try {
    expect(proof.recheck!()).toBe(true);
    expect(proof.heldProjectRoots).toEqual(new Set([project.root, middle, last]));
    expect(proof.protectedProjectRoots.size).toBe(0);
  } finally {
    proof.close!();
  }
});

it("latches unreadable changed owners while unrelated project insertion stays current", async () => {
  const sql = await fixture();
  const thread = sql.graph.threads.createThread({ title: "owner", workspace: "in_place" });
  const proof = await diskRetentionReferences(sql.store);
  try {
    sql.register("unrelated");
    expect(proof.recheck!()).toBe(true);
    sql.store.transaction(() =>
      sql.store
        .prepare("UPDATE thread SET body=? WHERE id=?")
        .run(Buffer.from("broken"), thread.id),
    );
    expect(() => proof.recheck!()).toThrow(/retention thread/);
    expect(proof.recheck!()).toBe(false);
    await proof.refresh!();
    expect(proof.recheck!()).toBe(false);
  } finally {
    proof.close!();
  }
});

it("keeps a late recovery hold install-wide for the rest of the pass", async () => {
  const sql = await fixture();
  const project = sql.register("recovering");
  const pid = sql.graph.projects.partition(project.id)!.pid;
  const proof = await diskRetentionReferences(sql.store);
  try {
    sql.store.transaction(() =>
      sql.store.prepare("UPDATE partition SET status='recovery_required' WHERE id=?").run(pid),
    );
    expect(proof.recheck!()).toBe(false);
    expect(proof.blocked).toContain("recovery_required");
    expect(proof.holds).toContainEqual({
      class: "recovery_pending",
      count: 1,
      example: expect.stringContaining("recovery_required"),
    });
    sql.store.transaction(() =>
      sql.store.prepare("UPDATE partition SET status='ready' WHERE id=?").run(pid),
    );
    expect(proof.recheck!()).toBe(false);
  } finally {
    proof.close!();
  }
  const fresh = await diskRetentionReferences(sql.store);
  expect(fresh.recheck!()).toBe(true);
  fresh.close!();
});
