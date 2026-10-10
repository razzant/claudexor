import { mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { journalPartitionDirectory } from "./test-support/fixtures/legacy/journal/index.js";
import { readLogicalFixture, writeLogicalFixture } from "./test-support/fixture-loader.js";
import { runLegacyImport } from "./importer.js";
import { EngineStore } from "./store.js";
import { createSqlDaemonServices } from "./sql-daemon-services.js";
import { SqlPartitionRecovery } from "./sql-recovery.js";
import { sqlRecoveryProjections } from "./sql-validation.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sql-validate-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const logical = readLogicalFixture(
    resolve(import.meta.dirname, "test-support/fixtures/global.json"),
  );
  writeLogicalFixture(join(root, "source"), logical);
  const journalRoot = join(root, "source/journal"),
    temporary = join(root, "engine.sqlite.import");
  await runLegacyImport({
    databasePath: temporary,
    journalRoot,
    resourceStoreDir: join(root, "resource-store"),
    partitions: [{ name: "global", directory: journalPartitionDirectory(journalRoot, "global") }],
  });
  renameSync(temporary, join(root, "engine.sqlite"));
  const store = await EngineStore.open({
    daemonDir: root,
    workerEntry: resolve(import.meta.dirname, "../../dist/store/flusher-worker.js"),
  });
  cleanup.push(() => store.close());
  const graph = createSqlDaemonServices(store, {
    purgeFiles: async () => [root],
    maintenance: {
      workerEntry: resolve(import.meta.dirname, "../../dist/store/maintenance-worker.js"),
    },
  });
  cleanup.push(() => graph.close());
  const setup = vi.fn();
  const recovery = new SqlPartitionRecovery(store, graph.blobs, graph.maintenance, "global", {
    projections: (g) => sqlRecoveryProjections(store, graph.blobs, g, setup),
  });
  return { store, graph, recovery, setup };
}
describe("SQL recovery uses canonical domain validators", () => {
  it("validates the imported portable domain state without writing or inventing empty coverage", async () => {
    const f = await fixture();
    const before = f.recovery.inspect();
    const result = await f.recovery.validate();
    expect(result.status).toBe("ready");
    expect(result.projectionStatus.map((p) => p.name)).toEqual([
      "sqlite.integrity",
      "commands",
      "threads",
      "interactions",
      "decisions",
      "run-events",
      "projects",
      "quota",
      "setup",
    ]);
    expect(result.projectionStatus.every((p) => p.status === "valid")).toBe(true);
    expect(f.setup).toHaveBeenCalledTimes(1);
    expect(f.recovery.inspect().fingerprint).toBe(before.fingerprint);
  });
  it("detects a dangling accepted command binding and preserves its rows for recovery", async () => {
    const f = await fixture();
    f.store.transaction(() =>
      f.store.prepare("UPDATE idempotency SET target_id='missing' WHERE owner='command'").run(),
    );
    const bindings = f.store
      .prepare("SELECT * FROM idempotency WHERE owner='command' ORDER BY key_digest")
      .all();
    expect(bindings.length).toBeGreaterThan(0);
    const result = await f.recovery.validate();
    expect(result.status).toBe("recovery_required");
    expect(result.projectionStatus.find((p) => p.name === "commands")).toMatchObject({
      status: "invalid",
      detail: "command idempotency index is dangling",
    });
    expect(
      f.store.prepare("SELECT * FROM idempotency WHERE owner='command' ORDER BY key_digest").all(),
    ).toEqual(bindings);
  });
});
