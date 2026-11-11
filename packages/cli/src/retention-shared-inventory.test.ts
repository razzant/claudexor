import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { createRetentionRunner } from "./retention-service.js";
import { createNativeHomeRetention } from "./native-home-retention.js";
it("shares and closes one SQL inventory for combined run and native retention", async () => {
  const root = mkdtempSync(join(tmpdir(), "retention-shared-"));
  const before = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = join(root, "engine");
  mkdirSync(process.env.CLAUDEXOR_CONFIG_DIR);
  const sql = await sqlFixture(join(root, "sql"));
  try {
    const read = sql.graph.threads.retentionReferences.bind(sql.graph.threads);
    const closed: ReturnType<typeof vi.fn>[] = [];
    const inventory = vi
      .spyOn(sql.graph.threads, "retentionReferences")
      .mockImplementation(async (...args) => {
        const proof = await read(...args);
        const close = vi.fn(proof.close);
        closed.push(close);
        return { ...proof, close };
      });
    const native = createNativeHomeRetention({
      threads: sql.graph.threads,
      isBusy: () => false,
      registry: () => new Map(),
      profiles: () => [],
    });
    const gc = createRetentionRunner({
      projects: () => sql.graph.projects,
      threads: sql.graph.threads,
      daemonJobs: () => [],
      purgeThread: async () => {},
      hasPurgeLeftovers: () => false,
      nativeHomes: native,
    });
    expect((await gc({ dry_run: false })).errors).toEqual([]);
    expect(inventory).toHaveBeenCalledTimes(1);
    expect(closed[0]).toHaveBeenCalledTimes(1);
    await native({
      dryRun: false,
      olderThan: Date.now(),
      ignoredRunIds: new Set(),
      ignoredThreadIds: new Set(),
    });
    expect(inventory).toHaveBeenCalledTimes(2);
    expect(closed[1]).toHaveBeenCalledTimes(1);
  } finally {
    await sql.close();
    if (before === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = before;
    rmSync(root, { recursive: true, force: true });
  }
});
