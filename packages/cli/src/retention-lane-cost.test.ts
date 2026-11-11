// INV-034: global thread-id lane ownership reuses the pass inventory, with fresh SQL proof.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Thread } from "@claudexor/schema";
import { noProjectRepoRoot } from "@claudexor/util";
import { createRetentionRunner } from "./retention-service.js";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";

it("reads thousands of global thread bodies once and absorbs late lane owners before sweeping", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-lane-cost-")));
  const before = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = join(root, "engine");
  mkdirSync(process.env.CLAUDEXOR_CONFIG_DIR);
  const sql = await sqlFixture(join(root, "sql"));
  try {
    for (let i = 0; i < 3000; i++)
      sql.graph.threads.createThread({ title: `global ${i}`, workspace: "in_place" });
    for (let i = 0; i < 150; i++) {
      const repo = join(root, `repo-${i}`);
      mkdirSync(repo);
      sql.graph.projects.register({ root: repo, idempotencyKey: `repo-${i}`, clientId: "fixture" });
    }
    const parse = vi.spyOn(Thread, "parse");
    const inventory = await sql.graph.threads.retentionReferences();
    try {
      const count = parse.mock.calls.length;
      expect(count).toBe(3000);
      const start = performance.now();
      for (let i = 0; i < 150; i++)
        expect(inventory.laneThreadIds!(join(root, `repo-${i}`)).size).toBe(3000);
      console.log("LANE-COST 3000 threads / 150 roots ms:", performance.now() - start);
      expect(parse.mock.calls.length).toBe(count);
      parse.mockClear();
      const fullStart = performance.now();
      const receipt = await createRetentionRunner({
        projects: () => sql.graph.projects,
        threads: sql.graph.threads,
        daemonJobs: () => [],
        purgeThread: async () => {},
        hasPurgeLeftovers: () => false,
      })({ dry_run: false });
      console.log(
        "LANE-COST full pass 3000 threads / 150 roots ms:",
        performance.now() - fullStart,
      );
      expect(receipt.errors).toEqual([]);
      // One maintenance read and one shared reference read, independent of roots.
      expect(parse.mock.calls.length).toBe(6000);
      const late = sql.graph.threads.createThread({ title: "late owner", workspace: "in_place" });
      const afterInsert = parse.mock.calls.length;
      expect(inventory.laneThreadIds!(noProjectRepoRoot()).has(late.id)).toBe(true);
      expect(parse.mock.calls.length - afterInsert).toBe(1);
      // Unreadable newly inserted ownership fails closed at the same boundary.
      sql.store.prepare("UPDATE thread SET body=? WHERE id=?").run(Buffer.from("invalid"), late.id);
      expect(() => inventory.laneThreadIds!(noProjectRepoRoot())).toThrow(late.id);
    } finally {
      inventory.close?.();
      parse.mockRestore();
    }
  } finally {
    await sql.close();
    if (before === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = before;
    rmSync(root, { recursive: true, force: true });
  }
}, 600_000);
