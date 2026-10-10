import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  DurableJournal,
  journalPartitionDirectory,
} from "./test-support/fixtures/legacy/journal/index.js";
import { readLogicalFixture, writeLogicalFixture } from "./test-support/fixture-loader.js";
import { importLegacyInWorker } from "./import-worker.js";
import { discoverLegacyPartitions } from "./import-discovery.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "import-worker-")));
  roots.push(root);
  const source = join(root, "source");
  const logical = readLogicalFixture(
    resolve(import.meta.dirname, "test-support/fixtures/global.json"),
  );
  writeLogicalFixture(source, logical);
  const journalRoot = join(source, "journal");
  return {
    input: {
      databasePath: join(root, "engine.sqlite.import"),
      journalRoot,
      resourceStoreDir: join(root, "resource-store"),
      partitions: [{ name: "global", directory: journalPartitionDirectory(journalRoot, "global") }],
    },
    workerEntry: resolve(import.meta.dirname, "../../dist/store/maintenance-worker.js"),
  };
}

describe("maintenance worker legacy import role", () => {
  it("discovers original identities including empty projects and nonstandard framed names", async () => {
    const f = fixture();
    const projectName = "project:prj-empty";
    mkdirSync(journalPartitionDirectory(f.input.journalRoot, projectName));
    writeFileSync(
      join(journalPartitionDirectory(f.input.journalRoot, projectName), "journal.bin"),
      "",
    );
    const custom = "another:original/name",
      journal = new DurableJournal({ rootDir: f.input.journalRoot, partition: custom });
    journal.append("custom.evidence", { kept: true });
    journal.close();
    const sources = discoverLegacyPartitions(f.input.journalRoot);
    expect(sources.map((row) => row.name).sort()).toEqual([custom, "global", projectName].sort());
    const { partitions: _explicit, ...input } = f.input;
    const receipt = await importLegacyInWorker(input, { workerEntry: f.workerEntry });
    expect(receipt.partitions.map((row) => row.name).sort()).toEqual(
      [custom, "global", projectName].sort(),
    );
    expect(receipt.unclassified).toBe(1); // Unknown evidence is retained, not silently discarded.
  });

  it("keeps a damaged known partition addressable and refuses an unverifiable unknown name", () => {
    const f = fixture(),
      name = "project:prj-damaged";
    const directory = journalPartitionDirectory(f.input.journalRoot, name);
    mkdirSync(directory);
    const bytes = Buffer.from("damaged original journal");
    writeFileSync(join(directory, "journal.bin"), bytes);
    expect(discoverLegacyPartitions(f.input.journalRoot)).toContainEqual({ name, directory });
    const unknown = join(f.input.journalRoot, "unrecoverable-name");
    mkdirSync(unknown);
    writeFileSync(join(unknown, "journal.bin"), bytes);
    expect(() => discoverLegacyPartitions(f.input.journalRoot)).toThrow(
      expect.objectContaining({ code: "store_import_partition_identity" }),
    );
    expect(readFileSync(join(directory, "journal.bin"))).toEqual(bytes);
    expect(readFileSync(join(unknown, "journal.bin"))).toEqual(bytes);
  });
  it("delivers progress and a closed verified database without a main-thread reader", async () => {
    const f = fixture(),
      phases: string[] = [];
    const receipt = await importLegacyInWorker(f.input, {
      workerEntry: f.workerEntry,
      onProgress: (p) => phases.push(p.phase),
    });
    expect(phases).toContain("importing");
    expect(phases.at(-1)).toBe("complete");
    expect(receipt.partitions).toHaveLength(1);
    expect(receipt.compared).toBeGreaterThan(0);
    expect(existsSync(f.input.databasePath + "-wal")).toBe(false);
    const db = new DatabaseSync(f.input.databasePath, { readOnly: true });
    try {
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      db.close();
    }
  });
  it("waits for cancelled worker exit and resumes the same saved import", async () => {
    const f = fixture(),
      controller = new AbortController();
    await expect(
      importLegacyInWorker(f.input, {
        workerEntry: f.workerEntry,
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ code: "store_import_interrupted" });
    // Receipt rejection means the prior worker has exited; resume cannot race it.
    const receipt = await importLegacyInWorker(f.input, { workerEntry: f.workerEntry });
    expect(receipt.partitions).toHaveLength(1);
    expect(receipt.unclassified).toBe(0);
    expect(existsSync(f.input.databasePath + "-wal")).toBe(false);
  });
});
