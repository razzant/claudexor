import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlobFiles } from "./blob-files.js";
import { writeExternalFile } from "./external-files.js";
import type { FlusherPassReport } from "./flusher-protocol.js";
import { Obligations, type ObligationRow } from "./obligations.js";
import { runMutation } from "./mutation.js";
import { EngineStore } from "./store.js";

/** The store runs only where `node:sqlite` exists; elsewhere these cases are skipped, not failed. */
const sqliteAvailable = await import("node:sqlite").then(
  () => true,
  () => false,
);
const describeStore = sqliteAvailable ? describe : describe.skip;

function builtWorkerEntry(name: string): string {
  const entry = resolve(import.meta.dirname, "../../dist/store", name);
  if (!existsSync(entry)) throw new Error(`built worker missing at ${entry}; run pnpm build first`);
  return entry;
}

let root: string;
const stores: EngineStore[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-obligations-"));
});
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  rmSync(root, { recursive: true, force: true });
});
async function openStore(): Promise<EngineStore> {
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: builtWorkerEntry("flusher-worker.js"),
    flusherHooks: { manualTick: true },
  });
  stores.push(store);
  return store;
}
async function pass(store: EngineStore): Promise<FlusherPassReport> {
  return new Promise((resolve) => {
    const off = store.onSynced((_g, report) => {
      off();
      resolve(report);
    });
    store.flusherControl.tick();
  });
}
const openCount = (store: EngineStore) => store.facts().obligations_open;
const stateOf = (store: EngineStore, kind: string, key: string) =>
  (store
    .prepare("SELECT state, materialized_g FROM effect_obligation WHERE kind = ? AND key = ?")
    .get(kind, key) as { state: string; materialized_g: number | null } | undefined) ?? null;

describeStore("effect obligations (SYNTHESIS_R5 §4.6, R5_AMENDMENTS A2)", () => {
  it("is created pending inside the decision's transaction and refuses to be created outside", async () => {
    const store = await openStore();
    const obligations = new Obligations(store);
    expect(() => obligations.create("terminal_files", "run-1", 1, {})).toThrow(
      /inside the transaction/,
    );
    store.transaction(() => {
      store.prepare("INSERT INTO run_terminal(run_id, pid, event) VALUES('run-1', 1, x'00')").run();
      obligations.create("terminal_files", "run-1", 1, { facts: { a: 1 } });
    });
    expect(openCount(store)).toBe(1);
    expect(obligations.open()).toEqual([
      expect.objectContaining({
        kind: "terminal_files",
        key: "run-1",
        pid: 1,
        payload: { facts: { a: 1 } },
        state: "pending",
        materializedGeneration: null,
      }),
    ]);
    // A second terminal for the same run is a constraint violation, not a replay.
    expect(() =>
      store.transaction(() => obligations.create("terminal_files", "run-1", 1, {})),
    ).toThrow(/UNIQUE|constraint/i);
    expect(openCount(store)).toBe(1);
  });

  it("T-OBL-1: a pending row survives synced whatever its registrations; materialized clears after its generation", async () => {
    const store = await openStore();
    const obligations = new Obligations(store);
    store.transaction(() => {
      obligations.create("terminal_files", "partial", 1, {});
      obligations.create("terminal_files", "empty", 1, {});
    });
    // One of two directories registered, never materialized: synced leaves it alone.
    const finalDir = join(root, "run", "final");
    writeExternalFile(store, { dir: finalDir, name: "run_facts.yaml", bytes: Buffer.from("x") });
    obligations.registerEffect("terminal_files", "partial", finalDir);
    await pass(store);
    await pass(store);
    expect(openCount(store)).toBe(2);
    expect(stateOf(store, "terminal_files", "partial")).toEqual({
      state: "pending",
      materialized_g: null,
    });
    // Materialize both: the generation is the last registration, or a fresh mark for an empty set.
    const gPartial = obligations.materialize("terminal_files", "partial");
    const gEmpty = obligations.materialize("terminal_files", "empty");
    expect(stateOf(store, "terminal_files", "partial")).toEqual({
      state: "materialized",
      materialized_g: gPartial,
    });
    expect(gEmpty).toBeGreaterThan(gPartial);
    expect(openCount(store)).toBe(2);
    const report = await pass(store);
    expect(report.g).toBeGreaterThanOrEqual(gEmpty);
    expect(openCount(store)).toBe(0);
    expect(store.facts().flusher.pending_registrations).toBe(0);
  });

  it("T-OBL-2: a failed file step keeps the row pending; the retry materializes it without a restart", async () => {
    const store = await openStore();
    const obligations = new Obligations(store);
    store.transaction(() => obligations.create("terminal_files", "run-2", 1, { facts: "f" }));
    const finalDir = join(root, "run-2", "final");
    const materializeFiles = (fail: boolean) => {
      writeExternalFile(store, {
        dir: finalDir,
        name: "run_facts.yaml",
        bytes: Buffer.from("facts"),
      });
      obligations.registerEffect("terminal_files", "run-2", finalDir);
      if (fail) throw new Error("EIO: telemetry");
      writeExternalFile(store, { dir: finalDir, name: "telemetry.yaml", bytes: Buffer.from("t") });
      obligations.registerEffect("terminal_files", "run-2", finalDir);
      obligations.materialize("terminal_files", "run-2");
    };
    expect(() => materializeFiles(true)).toThrow(/EIO/);
    await pass(store);
    expect(stateOf(store, "terminal_files", "run-2")?.state).toBe("pending");
    expect(openCount(store)).toBe(1);
    materializeFiles(false);
    expect(stateOf(store, "terminal_files", "run-2")?.state).toBe("materialized");
    await pass(store);
    expect(openCount(store)).toBe(0);
  });

  it("materializes inside an open transaction when the owner is in one", async () => {
    const store = await openStore();
    const obligations = new Obligations(store);
    store.transaction(() =>
      obligations.create("publish_blob", "upl-1", 0, { sha: "a".repeat(64) }),
    );
    const generation = obligations.registerEffect("publish_blob", "upl-1", root);
    runMutation(store, (tx) => {
      tx.prepare(
        "INSERT INTO upload(id, state, received_bytes, body) VALUES('upl-1','published',1,x'00')",
      ).run();
      obligations.materializeInTx(tx, "publish_blob", "upl-1", generation);
    });
    expect(stateOf(store, "publish_blob", "upl-1")?.state).toBe("materialized");
    await pass(store);
    expect(openCount(store)).toBe(0);
  });

  it.each([false, true])(
    "OBL-CLEAR-NO-NOTE: default composition shares owner changes with GC (separate helper: %s)",
    async (separateHelper) => {
      const store = await openStore();
      const blobs = new BlobFiles(store);
      const obligations = new Obligations(store);
      const ref = blobs.prepareBody(Buffer.alloc(80_000, 9));
      store.transaction(() => {
        blobs.insertRow(ref);
        // The obligation is the ONLY owner of the digest.
        obligations.create("publish_blob", "upl-sole", 0, { sha: ref.sha256, resource_id: "res" });
      });
      obligations.registerEffect("publish_blob", "upl-sole", store.paths.blobs);
      const gMaterialized = obligations.materialize("publish_blob", "upl-sole");
      // The GC waits on the pass that will also clear the obligation.
      const collector = separateHelper ? new BlobFiles(store) : blobs;
      const collecting = collector.gc(ref.sha256);
      const key = `blob:${ref.sha256}` as const;
      await new Promise((r) => setTimeout(r, 20));
      const report = await pass(store);
      expect(report.g).toBeGreaterThanOrEqual(gMaterialized);
      await new Promise((r) => setTimeout(r, 20));
      // The clear ran before the GC resumed: the row is gone, but the owner
      // generation moved past the barrier the GC waited for, so the GC waits again.
      expect(openCount(store)).toBe(0);
      expect(blobs.owners.generationOf(key)).toBeGreaterThan(report.g);
      expect(existsSync(ref.file!)).toBe(true);
      expect(store.facts().flusher.pending_waiters).toBe(1);
      // Only the next barrier, which covers the obligation's deletion, lets the unlink happen.
      await pass(store);
      expect(await collecting).toBe("removed");
      expect(existsSync(ref.file!)).toBe(false);
    },
  );

  it("S2: a failing clear transaction is logged and retried on the next synced, never thrown on the request thread", async () => {
    const store = await openStore();
    const lines: string[] = [];
    const obligations = new Obligations(store, { log: (line) => lines.push(line) });
    store.transaction(() => obligations.create("terminal_files", "run-s2", 1, {}));
    obligations.materialize("terminal_files", "run-s2");
    let uncaught: unknown = null;
    const onUncaught = (error: unknown) => {
      uncaught = error;
    };
    process.on("uncaughtException", onUncaught);
    try {
      // Stand-in for SQLITE_FULL during the clear's WAL append.
      store.db.exec("PRAGMA query_only=1");
      await pass(store);
      await new Promise((r) => setTimeout(r, 20));
      expect(uncaught).toBeNull();
      expect(openCount(store)).toBe(1);
      expect(lines).toEqual([expect.stringMatching(/obligation clear deferred: .*readonly/)]);
      expect(store.facts().flusher.state).toBe("up");
      store.db.exec("PRAGMA query_only=0");
      await pass(store);
      expect(openCount(store)).toBe(0);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("startup replays open rows (pending or materialized) through per-kind idempotent handlers", async () => {
    const store = await openStore();
    const first = new Obligations(store);
    store.transaction(() => {
      first.create("terminal_files", "run-3", 1, { facts: "f" });
      first.create("terminal_files", "run-4", 1, { facts: "g" });
      first.create("archive_fs", "proj-1", 1, { from: "a", to: "b" });
      first.create("quarantine_fs", "part-1", 1, {});
    });
    // run-4 was materialized by the "previous process" but never cleared.
    first.registerEffect("terminal_files", "run-4", root);
    first.materialize("terminal_files", "run-4");
    first.close();
    // A new process: nothing tracked in memory, four rows on disk.
    const second = new Obligations(store);
    const seen: string[] = [];
    second.registerHandler("terminal_files", (obligation, effects) => {
      seen.push(`${obligation.key}:${obligation.state}`);
      const dir = join(root, "redo", obligation.key);
      writeExternalFile(store, { dir, name: "run_facts.yaml", bytes: Buffer.from("redone") });
      effects.register(dir);
    });
    second.registerHandler("archive_fs", () => {
      throw new Error("disk says no");
    });
    expect(() => second.registerHandler("archive_fs", () => undefined)).toThrow(
      /already registered/,
    );
    const receipt = await second.completeOpen();
    expect(receipt).toEqual({
      completed: [
        { kind: "terminal_files", key: "run-3" },
        { kind: "terminal_files", key: "run-4" },
      ],
      failed: [{ kind: "archive_fs", key: "proj-1", error: "disk says no" }],
      unhandled: [{ kind: "quarantine_fs", key: "part-1" }],
    });
    expect(seen.sort()).toEqual(["run-3:pending", "run-4:materialized"]);
    expect(openCount(store)).toBe(4);
    await pass(store);
    await pass(store);
    // Only the completed ones cleared; the failed (still pending) and unhandled rows stay as unfinished work.
    expect(
      second
        .open()
        .map((row) => `${row.key}:${row.state}`)
        .sort(),
    ).toEqual(["part-1:pending", "proj-1:pending"]);
    expect(openCount(store)).toBe(2);
  });

  it("a rolled-back create cannot replace tracking for an already materialized obligation", async () => {
    const store = await openStore();
    const obligations = new Obligations(store);
    store.transaction(() => obligations.create("terminal_files", "original", 1, {}));
    obligations.materialize("terminal_files", "original");
    expect(() =>
      store.transaction(() => {
        store.prepare("DELETE FROM effect_obligation WHERE key='original'").run();
        obligations.create("terminal_files", "original", 1, { replacement: true });
        throw new Error("rollback replacement");
      }),
    ).toThrow(/rollback replacement/);
    expect(obligations.open()[0]).toMatchObject({ payload: {}, state: "materialized" });
    // Before M1, create() reset tracked inside the transaction and this row
    // stayed open forever even though its original materialization committed.
    await pass(store);
    expect(openCount(store)).toBe(0);
  });

  it("materializeInTx rollback leaves upload, obligation and live tracking unchanged", async () => {
    const store = await openStore();
    const obligations = new Obligations(store);
    store.transaction(() => {
      obligations.create("publish_blob", "upl-rollback", 0, { sha: "d".repeat(64) });
      store
        .prepare(
          "INSERT INTO upload(id,state,received_bytes,body) VALUES('upl-rollback','finalizing',1,x'00')",
        )
        .run();
    });
    const generation = obligations.registerEffect("publish_blob", "upl-rollback", root);
    expect(() =>
      runMutation(store, (tx) => {
        tx.prepare("UPDATE upload SET state='published' WHERE id='upl-rollback'").run();
        obligations.materializeInTx(tx, "publish_blob", "upl-rollback", generation);
        throw new Error("rollback materialization");
      }),
    ).toThrow(/rollback materialization/);
    expect(store.prepare("SELECT state FROM upload WHERE id='upl-rollback'").get()).toEqual({
      state: "finalizing",
    });
    expect(stateOf(store, "publish_blob", "upl-rollback")).toEqual({
      state: "pending",
      materialized_g: null,
    });
    await pass(store);
    expect(openCount(store)).toBe(1);
    expect(store.owners.generationOf(`blob:${"d".repeat(64)}`)).toBeUndefined();
    runMutation(store, (tx) => {
      tx.prepare("UPDATE upload SET state='published' WHERE id='upl-rollback'").run();
      tx.changes.uploadChanged("upl-rollback");
      obligations.materializeInTx(tx, "publish_blob", "upl-rollback", generation);
    });
    expect(store.prepare("SELECT state FROM upload WHERE id='upl-rollback'").get()).toEqual({
      state: "published",
    });
    expect(stateOf(store, "publish_blob", "upl-rollback")?.state).toBe("materialized");
    await pass(store);
    expect(openCount(store)).toBe(0);
  });

  it("awaits filesystem completion outside SQL; a failed retry after reopen is pending with fresh evidence required", async () => {
    const firstStore = await openStore();
    const first = new Obligations(firstStore);
    firstStore.transaction(() => {
      first.create("purge_fs", "thread-1", 1, { path: root });
      first.create("archive_fs", "unhandled", 1, {});
    });
    first.materialize("purge_fs", "thread-1");
    first.materialize("archive_fs", "unhandled");
    first.close();
    await firstStore.close();
    const store = await openStore();
    const second = new Obligations(store);
    let finish!: () => void;
    const allowed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let fail = true;
    second.registerHandler("purge_fs", async (_row, effects) => {
      expect(store.inTransaction).toBe(false);
      await allowed;
      expect(store.inTransaction).toBe(false);
      effects.register(root);
      if (fail) throw new Error("EIO retry");
    });
    const completing = second.completeOpen();
    expect(
      second.open().every((row) => row.state === "pending" && row.materializedGeneration === null),
    ).toBe(true);
    await pass(store);
    expect(openCount(store)).toBe(2);
    finish();
    expect(await completing).toMatchObject({
      completed: [],
      failed: [{ key: "thread-1", error: "EIO retry" }],
      unhandled: [{ key: "unhandled" }],
    });
    await pass(store);
    expect(stateOf(store, "purge_fs", "thread-1")?.state).toBe("pending");
    fail = false;
    expect(await second.completeOpen()).toMatchObject({
      completed: [{ key: "thread-1" }],
      failed: [],
    });
    expect(stateOf(store, "purge_fs", "thread-1")?.state).toBe("materialized");
    await pass(store);
    expect(second.open().map((row) => [row.key, row.state])).toEqual([["unhandled", "pending"]]);
  });

  it("post-clear sees only committed removed rows and the new shared owner generation, even if notification fails", async () => {
    const store = await openStore();
    const lines: string[] = [];
    const cleared: ObligationRow[][] = [];
    const digest = "e".repeat(64);
    const obligations = new Obligations(store, {
      log: (line) => lines.push(line),
      onCleared: (rows) => {
        expect(store.inTransaction).toBe(false);
        expect(openCount(store)).toBe(0);
        expect(store.owners.generationOf(`blob:${digest}`)).toBeGreaterThan(
          store.acknowledgedGeneration,
        );
        cleared.push([...rows]);
        throw new Error("notification EIO");
      },
    });
    store.transaction(() =>
      obligations.create("publish_blob", "notify", 0, { sha: digest, resource_id: "res-1" }),
    );
    obligations.materialize("publish_blob", "notify");
    store.db.exec("PRAGMA query_only=1");
    await pass(store);
    expect(cleared).toEqual([]);
    expect(store.owners.generationOf(`blob:${digest}`)).toBeUndefined();
    expect(openCount(store)).toBe(1);
    store.db.exec("PRAGMA query_only=0");
    await pass(store);
    expect(cleared).toEqual([
      [
        expect.objectContaining({
          kind: "publish_blob",
          key: "notify",
          pid: 0,
          payload: { sha: digest, resource_id: "res-1" },
          state: "materialized",
        }),
      ],
    ]);
    expect(lines).toEqual([
      expect.stringMatching(/clear deferred/),
      expect.stringMatching(/rows cleared and committed; notification failed: notification EIO/),
    ]);
    const after = store.owners.generationOf(`blob:${digest}`);
    await pass(store);
    expect(cleared).toHaveLength(1);
    expect(store.owners.generationOf(`blob:${digest}`)).toBe(after);
  });
});
