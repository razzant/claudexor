import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { projectRuntimeDir } from "@claudexor/util";
// The fixture's store is the package build's; its partition helper is the same one.
import { createPartition } from "@claudexor/daemon";
import { sqlFixture } from "./test-support/sql-fixture.js";

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "retention-topology-")));
  const sql = await sqlFixture(root);
  const dir = (name: string) => {
    const path = join(root, name);
    mkdirSync(path);
    return path;
  };
  return {
    sql,
    dir,
    async close() {
      await sql.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it("absorbs a late registration's fresh generation, reads its owners and defers its namespace (#503)", async () => {
  const f = await fixture();
  try {
    const router = f.sql.graph.threads;
    const proof = await router.retentionReferences();
    const late = f.dir("late");
    router.registerProject({ root: late, idempotencyKey: "late", clientId: "test" });
    const thread = router.createThread({
      title: "late owner",
      workspace: "in_place",
      repoRoot: late,
    });
    router.createTurn(thread.id, "keep it", { parentRunId: "late-held" });
    // A new partition is no stale-map failure and no longer stops every deletion.
    expect(proof.recheck!()).toBe(true);
    expect(proof.referencedRunIds.has("late-held")).toBe(true);
    // Its keep-last and ownership changed during the pass: that namespace holds.
    expect(proof.deferredRuntimes!().has(projectRuntimeDir(late))).toBe(true);
    proof.close!();
  } finally {
    await f.close();
  }
});

it("defers both roots of a relink, and holds the pass when never-inventoried rows become owners", async () => {
  const f = await fixture();
  try {
    const router = f.sql.graph.threads;
    const a = f.dir("a");
    const b = f.dir("b");
    const { project } = router.registerProject({ root: a, idempotencyKey: "a", clientId: "test" });
    // Excluded at inventory: a quarantined generation's rows are evidence, never owners.
    const hidden = f.sql.store.transaction(() => createPartition(f.sql.store, "hidden-generation"));
    f.sql.store.prepare("UPDATE partition SET status='quarantined' WHERE id=?").run(hidden.pid);
    const proof = await router.retentionReferences();
    router.relinkProject(project.id, b);
    expect(proof.recheck!()).toBe(true);
    expect([...proof.deferredRuntimes!()]).toEqual(
      expect.arrayContaining([projectRuntimeDir(a), projectRuntimeDir(b)]),
    );
    // Those rows were skipped, so a Map refresh cannot make them owners: hold everything.
    f.sql.store.prepare("UPDATE partition SET status='ready' WHERE id=?").run(hidden.pid);
    expect(proof.recheck!()).toBe(false);
    proof.close!();
  } finally {
    await f.close();
  }
});
