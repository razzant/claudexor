import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DurableJournal,
  journalPartitionDirectory,
} from "./test-support/fixtures/legacy/journal/index.js";
import { runLegacyImport } from "./importer.js";
import { ImportContext } from "./import-context.js";

const calls = vi.hoisted(() => ({
  active: 0,
  peak: 0,
  opened: 0,
  forceWal: false,
  pragmas: [] as string[],
}));
vi.mock("node:sqlite", async (original) => {
  const actual = await original<typeof import("node:sqlite")>();
  return {
    ...actual,
    DatabaseSync: class extends actual.DatabaseSync {
      private closed = false;
      constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
        super(...args);
        calls.active++;
        calls.opened++;
        calls.peak = Math.max(calls.peak, calls.active);
      }
      override exec(sql: string) {
        calls.pragmas.push(sql);
        return super.exec(sql);
      }
      override close() {
        if (!this.closed) {
          this.closed = true;
          calls.active--;
        }
        return super.close();
      }
    },
  };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync(path: Parameters<typeof actual.existsSync>[0]) {
      return calls.forceWal && String(path).endsWith("engine.sqlite.import-wal")
        ? true
        : actual.existsSync(path);
    },
  };
});
const roots: string[] = [];
beforeEach(() => {
  calls.peak = 0;
  calls.opened = 0;
  calls.pragmas = [];
});
afterEach(() => {
  calls.forceWal = false;
  expect(calls.active).toBe(0);
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const path = realpathSync.native(mkdtempSync(join(tmpdir(), "cx-import-fault-")));
  roots.push(path);
  const journalRoot = join(path, "journal");
  mkdirSync(journalRoot, { mode: 0o700 });
  const partitions = ["global", "project:p"].map((name) => {
    const journal = new DurableJournal({
      rootDir: journalRoot,
      partition: name,
      deferCompaction: true,
    });
    journal.append("command.accepted", {
      record: {
        id: name,
        params: { prompt: name === "global" ? "short" : "x".repeat(80000) },
        state: "queued",
        createdAt: "2026-10-10T00:00:00.000Z",
      },
      keyDigest: name,
      requestDigest: name,
    });
    journal.close();
    return { name, directory: journalPartitionDirectory(journalRoot, name) };
  });
  return {
    path,
    options: {
      databasePath: join(path, "engine.sqlite.import"),
      journalRoot,
      resourceStoreDir: join(path, "resource-store"),
      partitions,
    },
  };
}

describe("import connection and publication boundary", () => {
  it("a marker-write failure rolls back the entire partition and a later retry succeeds", async () => {
    const f = fixture();
    const original = ImportContext.prototype.prepare;
    const fault = vi.spyOn(ImportContext.prototype, "prepare").mockImplementation(function (
      this: ImportContext,
      sql,
    ) {
      const statement = original.call(this, sql);
      if (!sql.startsWith("INSERT INTO import_partition")) return statement;
      return new Proxy(statement, {
        get(target, property) {
          if (property === "run")
            return () => {
              throw new Error("marker disk failure");
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    try {
      await expect(runLegacyImport(f.options)).rejects.toThrow("marker disk failure");
    } finally {
      fault.mockRestore();
    }
    const db = new DatabaseSync(f.options.databasePath, { readOnly: true });
    try {
      for (const table of ["command", "idempotency", "event", "partition", "import_partition"])
        expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT value FROM meta WHERE key='migration'").get()).toBeUndefined();
    } finally {
      db.close();
    }
    expect((await runLegacyImport(f.options)).partitions.every((row) => !row.reused)).toBe(true);
  });
  it("uses one writer for integrity, resume, verification, NORMAL receipt and close", async () => {
    const f = fixture();
    const first = await runLegacyImport(f.options),
      second = await runLegacyImport(f.options);
    expect(calls.peak).toBe(1);
    expect(calls.opened).toBe(2);
    expect(second.partitions.every((partition) => partition.reused)).toBe(true);
    expect(second.externalDirectories).toContain(join(f.options.resourceStoreDir, "blobs"));
    expect(calls.pragmas).toContain("PRAGMA synchronous=NORMAL");
    expect(calls.pragmas.some((sql) => sql.includes("wal_checkpoint(TRUNCATE)"))).toBe(true);
    expect(existsSync(f.options.databasePath + "-wal")).toBe(false);
    expect(first.partitions.map((row) => row.pid)).toEqual(second.partitions.map((row) => row.pid));
  });

  it("reopens only after close for a remaining WAL and refuses publication if it remains", async () => {
    const f = fixture();
    calls.forceWal = true;
    let complete = false;
    await expect(
      runLegacyImport({
        ...f.options,
        onProgress(p) {
          complete ||= p.phase === "complete";
        },
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "store_import_wal_present" }));
    expect(calls.peak).toBe(1);
    expect(calls.opened).toBe(2);
    expect(complete).toBe(false);
    calls.forceWal = false;
    expect((await runLegacyImport(f.options)).partitions.every((row) => row.reused)).toBe(true);
  });

  it("rebuilds a corrupt temp file while retaining the source and rejects a serving filename", async () => {
    const f = fixture(),
      before = readFileSync(join(f.options.partitions[0]!.directory, "journal.bin"));
    writeFileSync(f.options.databasePath, "not a database");
    expect((await runLegacyImport(f.options)).compared).toBe(2);
    expect(readFileSync(join(f.options.partitions[0]!.directory, "journal.bin"))).toEqual(before);
    expect(calls.peak).toBe(1);
    await expect(
      runLegacyImport({ ...f.options, databasePath: join(f.path, "engine.sqlite") }),
    ).rejects.toThrow(expect.objectContaining({ code: "store_import_target_invalid" }));
    expect(existsSync(join(f.path, "engine.sqlite"))).toBe(false);
  });

  it("a terminated worker leaves committed partition markers, and restart keeps its body directory barrier", async () => {
    const f = fixture();
    // First a full run prepares a large body; interruption on the next run may
    // reuse that marker without rewriting the file's directory entry.
    await runLegacyImport(f.options);
    const source = `const {runLegacyImport}=await import(${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, "../../dist/store/importer.js")).href)});
      await runLegacyImport({...${JSON.stringify(f.options)},onProgress(p){if(p.phase==='reading'&&p.completedPartitions===1)process.kill(process.pid,'SIGKILL')}}); process.exit(19);`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      encoding: "utf8",
      timeout: 15000,
    });
    expect(child.signal, child.stderr).toBe("SIGKILL");
    const receipt = await runLegacyImport(f.options);
    expect(receipt.partitions.every((row) => row.reused)).toBe(true);
    expect(receipt.externalDirectories).toContain(join(f.options.resourceStoreDir, "blobs"));
    const db = new DatabaseSync(f.options.databasePath, { readOnly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM command").get()).toEqual({ n: 2 });
    } finally {
      db.close();
    }
  });
});
