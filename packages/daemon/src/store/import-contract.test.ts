import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  DurableJournal,
  journalPartitionDirectory,
} from "./test-support/fixtures/legacy/journal/index.js";
import { journalFoldPolicy } from "./test-support/fixtures/legacy/daemon/journal-fold-policy.js";
import { legacyStores } from "./test-support/legacy-replay.js";
import { readLogicalFixture, writeLogicalFixture } from "./test-support/fixture-loader.js";
import { runLegacyImport, type LegacyImportOptions, type ImportProgress } from "./importer.js";
import { ImportContext } from "./import-context.js";
import { commandRow, hydrateCommand } from "./command-rows.js";
import { readImportSource } from "./import-source.js";
import { verifyImportedPartition } from "./import-verify.js";
import { encodeFrame } from "./test-support/fixtures/legacy/journal/frame-codec.js";

const TIME = "2026-10-10T00:00:00.000Z";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
function root() {
  const path = realpathSync.native(mkdtempSync(join(tmpdir(), "cx-import-")));
  roots.push(path);
  return path;
}
function fixture(names = ["global"]) {
  const path = root(),
    journalRoot = join(path, "journal");
  mkdirSync(journalRoot);
  const partitions = names.map((name) => ({
    name,
    directory: journalPartitionDirectory(journalRoot, name),
  }));
  const options: LegacyImportOptions = {
    databasePath: join(path, "engine.sqlite.import"),
    journalRoot,
    resourceStoreDir: join(path, "resource-store"),
    partitions,
    now: () => new Date(TIME),
  };
  return {
    root: path,
    options,
    append(name: string, records: Array<{ type: string; payload: unknown }>) {
      const journal = new DurableJournal({
        rootDir: journalRoot,
        partition: name,
        now: () => new Date(TIME),
        epochFactory: () => `epoch-${name}`,
        deferCompaction: true,
      });
      try {
        journal.appendBatch(records);
      } finally {
        journal.close();
      }
    },
  };
}
const accepted = (id: string, prompt = "fixture") => ({
  type: "command.accepted",
  payload: {
    record: { id, params: { mode: "agent", prompt }, state: "queued", createdAt: TIME },
    keyDigest: `key-${id}`,
    requestDigest: `request-${id}`,
  },
});

describe("single-connection legacy import", () => {
  it("the source fingerprint detects valid changed bytes with unchanged size and mtime", async () => {
    const f = fixture();
    f.append("global", [accepted("job", "before")]);
    const path = join(f.options.partitions[0]!.directory, "journal.bin");
    const header = {
      partition: "global",
      epoch: "epoch-global",
      seq: 1,
      previousFrameHash: "0".repeat(64),
      time: TIME,
      type: "command.accepted",
    };
    const replace = (prompt: string) => {
      writeFileSync(
        path,
        encodeFrame(header, Buffer.from(JSON.stringify(accepted("job", prompt).payload))),
      );
      utimesSync(path, new Date(TIME), new Date(TIME));
    };
    replace("before");
    const before = statSync(path, { bigint: true }),
      first = await runLegacyImport(f.options);
    replace("after!");
    const after = statSync(path, { bigint: true });
    expect([after.size, after.mtimeNs]).toEqual([before.size, before.mtimeNs]);
    const second = await runLegacyImport(f.options);
    expect(second.partitions[0]?.reused).toBe(false);
    expect(second.partitions[0]?.fingerprint).not.toBe(first.partitions[0]?.fingerprint);
    const db = new DatabaseSync(f.options.databasePath);
    try {
      const sql = new ImportContext(db, join(f.options.resourceStoreDir, "blobs"));
      expect(hydrateCommand(commandRow(sql, "job")!, sql).params).toMatchObject({
        prompt: "after!",
      });
    } finally {
      db.close();
    }
  });
  it("binds project registrations and global head revisions after project state, then respects unregister on resume", async () => {
    const f = fixture(["global", "project:prj-fixture"]);
    const source = readLogicalFixture(
      resolve(import.meta.dirname, "test-support/fixtures/global.json"),
    );
    const project = (
      source.records.find((row) => row.type === "project.registered")!.payload as {
        project: { id: string };
      }
    ).project;
    const entities = source.records.filter((row) => row.type === "thread.entities_upserted");
    const head = source.records.find((row) => row.type === "thread.head.updated")!;
    const registration = {
      keyDigest: "original-project-key",
      requestDigest: "original-project-request",
      projectId: project.id,
    };
    f.append("global", [{ type: "project.registered", payload: { project, registration } }, head]);
    f.append("project:prj-fixture", [...entities, accepted("project-job", "x".repeat(80000))]);
    const receipt = await runLegacyImport(f.options);
    const projectPid = receipt.partitions.find((row) => row.name === "project:prj-fixture")!.pid;
    let db = new DatabaseSync(f.options.databasePath);
    try {
      expect(db.prepare("SELECT current_pid FROM project").get()).toEqual({
        current_pid: projectPid,
      });
      expect(db.prepare("SELECT live FROM command").get()).toEqual({ live: 1 });
      expect(
        db
          .prepare(
            "SELECT key_digest,request_digest,target_id FROM idempotency WHERE owner='project'",
          )
          .get(),
      ).toEqual({
        key_digest: registration.keyDigest,
        request_digest: registration.requestDigest,
        target_id: project.id,
      });
      expect(db.prepare("SELECT head_revision FROM thread").get()).toEqual({
        head_revision: (head.payload as { revision: number }).revision,
      });
    } finally {
      db.close();
    }
    f.append("global", [{ type: "project.unregistered", payload: { project } }]);
    await runLegacyImport(f.options);
    db = new DatabaseSync(f.options.databasePath);
    try {
      expect(db.prepare("SELECT status FROM project").get()).toEqual({ status: "archived" });
      expect(db.prepare("SELECT live FROM command").get()).toEqual({ live: 0 });
      expect(
        db.prepare("SELECT count(*) AS n FROM idempotency WHERE owner='project'").get(),
      ).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
  it("imports the sealed portable corpus with exact rows/bindings/head and preserves every source byte", async () => {
    const path = root();
    const logical = readLogicalFixture(
      resolve(import.meta.dirname, "test-support/fixtures/global.json"),
    );
    writeLogicalFixture(join(path, "source"), logical);
    const journalRoot = join(path, "source/journal"),
      directory = journalPartitionDirectory(journalRoot, "global"),
      journalPath = join(directory, "journal.bin");
    const before = digest(journalPath),
      progress: ImportProgress[] = [];
    const options: LegacyImportOptions = {
      databasePath: join(path, "engine.sqlite.import"),
      journalRoot,
      resourceStoreDir: join(path, "resource-store"),
      partitions: [{ name: "global", directory }],
      onProgress: (row) => progress.push(row),
    };
    const receipt = await runLegacyImport(options);
    expect(receipt.unclassified).toBe(0);
    expect(receipt.compared).toBeGreaterThan(0);
    expect(digest(journalPath)).toBe(before);
    expect(existsSync(options.databasePath + "-wal")).toBe(false);
    expect(progress.at(-1)).toMatchObject({
      phase: "complete",
      completedPartitions: 1,
      totalPartitions: 1,
      currentPartition: null,
    });
    const frozen = DurableJournal.prepare({
      rootDir: journalRoot,
      partition: "global",
      fold: journalFoldPolicy,
    });
    const db = new DatabaseSync(options.databasePath, { readOnly: true });
    try {
      const old = legacyStores(frozen, path, logical.now),
        sql = new ImportContext(db, join(options.resourceStoreDir, "blobs"));
      expect(
        (db.prepare("SELECT id FROM command ORDER BY rowid").all() as Array<{ id: string }>).map(
          ({ id }) => hydrateCommand(commandRow(sql, id)!, sql),
        ),
      ).toEqual(old.commands.records());
      expect(
        db
          .prepare("SELECT root FROM pruned_root ORDER BY root")
          .all()
          .map((row) => row.root),
      ).toEqual(old.commands.prunedScopeRoots());
      expect(
        db
          .prepare("SELECT owner FROM idempotency GROUP BY owner ORDER BY owner")
          .all()
          .map((row) => row.owner),
      ).toEqual(["command", "decision", "setup", "thread", "turn"]);
      for (const thread of old.threads.listThreads()) {
        expect(db.prepare("SELECT head_revision FROM thread WHERE id=?").get(thread.id)).toEqual({
          head_revision: old.heads.revision(thread.id),
        });
      }
      expect(receipt.partitions[0]?.nextSeq).toBe(frozen.currentSequence() + 1);
    } finally {
      db.close();
      frozen.close();
    }
    const resumed = await runLegacyImport(options);
    expect(resumed.partitions[0]?.reused).toBe(true);
    expect(resumed.partitions[0]?.pid).toBe(receipt.partitions[0]?.pid);
    expect(digest(journalPath)).toBe(before);
  });

  it("resumes committed partitions after interruption and replaces a changed source by its fingerprint", async () => {
    const f = fixture(["global", "project:p"]);
    f.append("global", [accepted("global")]);
    f.append("project:p", [accepted("project", "x".repeat(80000))]);
    let stopped = false;
    await expect(
      runLegacyImport({
        ...f.options,
        onProgress: (p) => {
          if (p.phase === "reading" && p.completedPartitions === 1) {
            stopped = true;
            throw new Error("fixture interruption");
          }
        },
      }),
    ).rejects.toThrow("fixture interruption");
    expect(stopped).toBe(true);
    const resumed = await runLegacyImport(f.options);
    expect(resumed.partitions.map((p) => p.reused)).toEqual([true, false]);
    f.append("global", [
      {
        type: "command.updated",
        payload: {
          record: {
            id: "global",
            state: "succeeded",
            createdAt: TIME,
            finishedAt: TIME,
            result: { value: "changed" },
          },
        },
      },
    ]);
    const changed = await runLegacyImport(f.options);
    expect(changed.partitions.find((p) => p.name === "global")?.reused).toBe(false);
    expect(changed.partitions.find((p) => p.name === "project:p")?.reused).toBe(true);
    const db = new DatabaseSync(f.options.databasePath);
    try {
      expect(db.prepare("SELECT count(*) AS n FROM command").get()).toEqual({ n: 2 });
    } finally {
      db.close();
    }
  });

  it("preserves a folded tail's disk sequence, and classifies duplicates and unknown records without choosing a terminal", async () => {
    const f = fixture();
    const event = {
      seq: 1,
      ts: TIME,
      run_id: "run",
      task_id: "task",
      type: "run.failed",
      payload: {},
    };
    f.append("global", [
      accepted("job"),
      {
        type: "command.updated",
        payload: {
          record: {
            id: "job",
            state: "failed",
            createdAt: TIME,
            runId: "run",
            taskId: "task",
            finishedAt: TIME,
          },
        },
      },
      { type: "run.event", payload: event },
      { type: "run.event", payload: { ...event, seq: 2 } },
      { type: "future.record", payload: { exact: "unknown" } },
      {
        type: "interaction.resolved",
        payload: { runId: "run", interactionIds: ["gone"], terminal: "answered" },
      },
    ]);
    const receipt = await runLegacyImport(f.options);
    expect(receipt.partitions[0]?.nextSeq).toBe(7);
    expect(receipt.unclassified).toBe(3);
    const db = new DatabaseSync(f.options.databasePath);
    try {
      expect(db.prepare("SELECT state,error FROM command").get()).toMatchObject({
        state: "interrupted",
      });
      expect(db.prepare("SELECT count(*) AS n FROM run_terminal").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT max(seq) AS n FROM event").get()).toEqual({ n: 5 });
    } finally {
      db.close();
    }
  });

  it("imports only the acknowledged intent prefix and keeps a damaged non-intent prefix explicitly unavailable", async () => {
    for (const withIntent of [true, false]) {
      const f = fixture();
      f.append("global", [accepted("job")]);
      const path = join(f.options.partitions[0]!.directory, "journal.bin"),
        bytes = readFileSync(path).length;
      appendFileSync(path, Buffer.from([1, 2, 3]));
      if (withIntent)
        writeFileSync(
          join(f.options.partitions[0]!.directory, "append.pending.json"),
          JSON.stringify({ v: 1, offset: bytes, length: 3 }),
          { mode: 0o600 },
        );
      const before = digest(path),
        receipt = await runLegacyImport(f.options);
      expect(digest(path)).toBe(before);
      expect(receipt.partitions[0]).toMatchObject({
        status: withIntent ? "ready" : "recovery_required",
        nextSeq: 2,
        discardedTailBytes: withIntent ? 3 : 0,
      });
      const db = new DatabaseSync(f.options.databasePath);
      try {
        expect(db.prepare("SELECT live FROM command").get()).toEqual({ live: withIntent ? 1 : 0 });
      } finally {
        db.close();
      }
    }
  });

  it("Level 1 detects altered retained payload and source drift prevents the completion receipt", async () => {
    const f = fixture();
    f.append("global", [accepted("job")]);
    const receipt = await runLegacyImport(f.options);
    const db = new DatabaseSync(f.options.databasePath);
    try {
      const sql = new ImportContext(db, join(f.options.resourceStoreDir, "blobs"));
      db.prepare("UPDATE event SET payload=?").run(Buffer.from('{"wrong":true}'));
      expect(() =>
        verifyImportedPartition(
          sql,
          readImportSource(f.options.journalRoot, f.options.partitions[0]!),
          receipt.partitions[0]!.pid,
        ),
      ).toThrow(expect.objectContaining({ code: "store_import_equivalence_mismatch" }));
    } finally {
      db.close();
    }
    await expect(
      runLegacyImport({
        ...f.options,
        onProgress(p) {
          if (p.phase === "verifying")
            appendFileSync(join(f.options.partitions[0]!.directory, "journal.bin"), "changed");
        },
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "store_import_source_changed" }));
  });
});
