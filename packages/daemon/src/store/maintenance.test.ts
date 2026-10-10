import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlobFiles, sha256Hex } from "./blob-files.js";
import { MaintenanceController } from "./maintenance.js";
import { Obligations } from "./obligations.js";
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
const controllers: MaintenanceController[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-maintenance-"));
});
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.stop();
  for (const store of stores.splice(0)) await store.close();
  rmSync(root, { recursive: true, force: true });
});
async function openStore(
  manualTick = false,
): Promise<{ store: EngineStore; maintenance: MaintenanceController; blobs: BlobFiles }> {
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: builtWorkerEntry("flusher-worker.js"),
    flusherHooks: { manualTick },
  });
  stores.push(store);
  const blobs = new BlobFiles(store);
  const maintenance = new MaintenanceController(store, {
    workerEntry: builtWorkerEntry("maintenance-worker.js"),
    processStartedAt: Date.now(),
    blobs,
  });
  controllers.push(maintenance);
  return { store, maintenance, blobs };
}
let nextSeq = 1;
function seedRows(store: EngineStore, n: number): void {
  const insert = store.prepare(
    "INSERT INTO event(pid, seq, time, type, payload) VALUES(1, ?, 't', 'x', ?)",
  );
  store.transaction(() => {
    for (let i = 0; i < n; i += 1) insert.run(nextSeq++, Buffer.alloc(900, nextSeq & 0xff));
  });
}
/** Push every WAL frame into the database file, retrying while a flusher pass holds the checkpoint lock. */
async function checkpointAll(store: EngineStore): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const row = store.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
      busy: number;
      log: number;
    };
    if (Number(row.busy) === 0 && Number(row.log) === 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("could not truncate the WAL");
}
function age(path: string, by = 60_000): void {
  const then = (Date.now() - by) / 1000;
  utimesSync(path, then, then);
}
const rowTotals = (store: EngineStore) =>
  Number(
    (
      store
        .prepare(
          "SELECT (SELECT count(*) FROM blob) + (SELECT count(*) FROM upload) + (SELECT count(*) FROM resource) AS n",
        )
        .get() as { n: number }
    ).n,
  );

describeStore("maintenance worker (SYNTHESIS_R5 §6.5, §7 p.6; R5_AMENDMENTS A4, C2, C10)", () => {
  it("runs integrity_check on its own connection and records the fact", async () => {
    const { store, maintenance } = await openStore();
    seedRows(store, 200);
    expect(store.facts().integrity).toBe("pending");
    const report = await maintenance.integrityCheck();
    expect(report).toMatchObject({ ok: true, problems: [] });
    expect(store.facts().integrity).toBe("ok");
    await checkpointAll(store);
    const fd = openSync(store.paths.database, "r+");
    try {
      for (const page of [3, 4, 5, 6])
        writeSync(fd, Buffer.alloc(32, 0xff), 0, 32, 4096 * (page - 1));
    } finally {
      closeSync(fd);
    }
    const failed = await maintenance.integrityCheck();
    expect(failed.ok).toBe(false);
    expect(failed.problems.length).toBeGreaterThan(0);
    expect(store.facts().integrity).toBe("failed");
  });

  it("exports a consistent snapshot with VACUUM INTO while the main thread keeps writing", async () => {
    const { store, maintenance } = await openStore();
    seedRows(store, 300);
    const target = join(root, "export.sqlite");
    const exporting = maintenance.exportTo(target);
    seedRows(store, 1);
    const report = await exporting;
    expect(report.target).toBe(target);
    expect(report.bytes).toBeGreaterThan(0);
    const { DatabaseSync } = await import("node:sqlite");
    const exported = new DatabaseSync(target, { readOnly: true });
    try {
      expect(
        (exported.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
          .integrity_check,
      ).toBe("ok");
      const n = Number(
        (exported.prepare("SELECT count(*) AS n FROM event").get() as { n: number }).n,
      );
      expect([300, 301]).toContain(n);
    } finally {
      exported.close();
    }
  });

  it("T-GC-2: the worker enumerates, main decides — unreferenced files older than the process start go with their blob rows", async () => {
    const { store, maintenance, blobs } = await openStore();
    const obligations = new Obligations(store);
    mkdirSync(store.paths.uploads, { recursive: true });
    const owned = blobs.prepareBody(Buffer.alloc(70_000, 1));
    const orphanOld = blobs.prepareBody(Buffer.alloc(70_000, 2));
    const orphanYoung = blobs.prepareBody(Buffer.alloc(70_000, 3));
    const referencedOnly = blobs.prepareBody(Buffer.alloc(70_000, 4));
    store.transaction(() => {
      blobs.insertRow(owned);
      store
        .prepare(
          "INSERT INTO resource(id, kind, sha256, size_bytes, state, created_at, body) VALUES('r1','file',?,70000,'ready','t',x'00')",
        )
        .run(referencedOnly.sha256);
      store
        .prepare(
          "INSERT INTO upload(id, state, received_bytes, body) VALUES('live-upl', 'uploaded', 5, x'00')",
        )
        .run();
      store
        .prepare(
          "INSERT INTO upload(id, state, received_bytes, body) VALUES('done-upl', 'published', 5, x'00')",
        )
        .run();
      store
        .prepare(
          "INSERT INTO upload(id, state, received_bytes, body) VALUES('obligated-upl', 'published', 5, x'00')",
        )
        .run();
      obligations.create("publish_blob", "obligated-upl", 0, { sha: "f".repeat(64) });
    });
    const staleTemp = join(store.paths.blobs, `.${"a".repeat(64)}.deadbeef.tmp`);
    writeFileSync(staleTemp, "partial");
    const parts = {
      live: join(store.paths.uploads, "live-upl.part"),
      done: join(store.paths.uploads, "done-upl.part"),
      obligated: join(store.paths.uploads, "obligated-upl.part"),
      rowless: join(store.paths.uploads, "ghost.part"),
      young: join(store.paths.uploads, "young.part"),
    };
    for (const path of Object.values(parts)) writeFileSync(path, "bytes");
    for (const path of [
      owned.file!,
      orphanOld.file!,
      referencedOnly.file!,
      staleTemp,
      parts.live,
      parts.done,
      parts.obligated,
      parts.rowless,
    ])
      age(path);
    const rowsBefore = rowTotals(store);
    const listed = await maintenance.sweepCandidates();
    // A bare `blob` row is not an owner (A3/A4): the catalogued-only file is a candidate too.
    expect(listed.candidates.map((c) => c.kind).sort()).toEqual([
      "blob",
      "blob",
      "part",
      "part",
      "part",
      "part",
      "tmp",
    ]);
    expect(listed.keptOwned).toBe(1); // referenced-only blob (resource row)
    expect(listed.keptYoung).toBe(2); // young blob, young part
    const report = await maintenance.sweepOrphans();
    expect(report.removedBlobs.sort()).toEqual([owned.sha256, orphanOld.sha256].sort());
    expect(report.removedTemps).toEqual([staleTemp]);
    expect(report.removedParts.sort()).toEqual([parts.done, parts.rowless].sort());
    expect(report.keptParts.sort()).toEqual([parts.live, parts.obligated].sort());
    expect(readdirSync(store.paths.blobs).sort()).toEqual(
      [orphanYoung.sha256, referencedOnly.sha256].sort(),
    );
    expect(readdirSync(store.paths.uploads).sort()).toEqual(
      ["live-upl.part", "obligated-upl.part", "young.part"].sort(),
    );
    // The row of the removed catalogued blob went with its file (C10 same section); nothing else was written.
    expect(
      (store.prepare("SELECT sha256 FROM blob").all() as Array<{ sha256: string }>).map(
        (r) => r.sha256,
      ),
    ).toEqual([]);
    expect(rowTotals(store)).toBe(rowsBefore - 1);
    const again = await maintenance.sweepOrphans();
    expect(again.removedBlobs).toEqual([]);
    expect(again.removedParts).toEqual([]);
    expect(sha256Hex(Buffer.alloc(70_000, 1))).toBe(owned.sha256);
  });

  it("T-GC-2 race: a digest republished between the worker's listing and main's decision stays", async () => {
    const { store, maintenance, blobs } = await openStore(true);
    const ref = blobs.prepareBody(Buffer.alloc(70_000, 8));
    age(ref.file!);
    const listed = await maintenance.sweepCandidates();
    expect(listed.candidates).toEqual([{ kind: "blob", path: ref.file!, sha: ref.sha256 }]);
    // Main adopts the file and references it in one tick, then the GC's barrier runs.
    const sweeping = (async () => {
      const outcome = await blobs.gc(ref.sha256);
      return outcome;
    })();
    store.transaction(() => {
      blobs.insertRow(blobs.prepareBody(Buffer.alloc(70_000, 8)));
      store
        .prepare(
          "INSERT INTO command(id, pid, operation, state, created_at, summary, params_sha, kind) VALUES('adopter', 1, 'run.create', 'succeeded', 't', x'00', ?, 'product')",
        )
        .run(ref.sha256);
    });
    store.flusherControl.tick();
    expect(await sweeping).toBe("owned");
    expect(existsSync(ref.file!)).toBe(true);
  });

  it("C9/C10: a rowless .part goes only after a barrier still shows no row; a row that reappears keeps it", async () => {
    const { store, maintenance } = await openStore(true);
    mkdirSync(store.paths.uploads, { recursive: true });
    const gone = join(store.paths.uploads, "gone.part");
    const back = join(store.paths.uploads, "back.part");
    writeFileSync(gone, "x");
    writeFileSync(back, "y");
    age(gone);
    age(back);
    const sweeping = maintenance.sweepOrphans();
    const untilWaiter = () =>
      new Promise<void>((resolve) => {
        const poll = () =>
          store.facts().flusher.pending_waiters >= 1 ? resolve() : setTimeout(poll, 5);
        poll();
      });
    // `back.part` is decided first: no row → parked on the barrier; nothing removed yet.
    await untilWaiter();
    expect(existsSync(gone)).toBe(true);
    expect(existsSync(back)).toBe(true);
    // Before the barrier completes, its upload row (re)appears.
    store.transaction(() =>
      store
        .prepare(
          "INSERT INTO upload(id, state, received_bytes, body) VALUES('back','uploaded',1,x'00')",
        )
        .run(),
    );
    const firstGeneration = store.facts().flusher.generation;
    store.flusherControl.tick();
    await new Promise<void>((resolve) => {
      const poll = () =>
        store.facts().flusher.acknowledged_generation >= firstGeneration
          ? resolve()
          : setTimeout(poll, 5);
      poll();
    });
    // Directory order is not defined: `gone.part` may already have been decided
    // in that same barrier, or it parks next (a newer generation) and needs one more.
    const done = sweeping.then(() => "done" as const);
    const parkedAgain = new Promise<"waiter">((resolve) => {
      const poll = () =>
        store.facts().flusher.generation > firstGeneration &&
        store.facts().flusher.pending_waiters >= 1
          ? resolve("waiter")
          : setTimeout(poll, 5);
      poll();
    });
    if ((await Promise.race([done, parkedAgain])) === "waiter") store.flusherControl.tick();
    const report = await sweeping;
    expect(report.removedParts).toEqual([gone]);
    expect(report.keptParts).toEqual([back]);
    expect(existsSync(back)).toBe(true);
  });

  it("T-FIN-7 (C10): an upload row that reappears and vanishes during the wait defers the unlink to a new barrier", async () => {
    const { store, maintenance, blobs } = await openStore(true);
    mkdirSync(store.paths.uploads, { recursive: true });
    const part = join(store.paths.uploads, "flap.part");
    writeFileSync(part, "x");
    age(part);
    const key = "upload:flap" as const;
    const sweeping = maintenance.sweepOrphans();
    const untilWaiter = () =>
      new Promise<void>((resolve) => {
        const poll = () =>
          store.facts().flusher.pending_waiters >= 1 ? resolve() : setTimeout(poll, 5);
        poll();
      });
    await untilWaiter();
    const g1 = store.facts().flusher.generation;
    // The row appears (INSERT + owner change) and its barrier completes; in that
    // barrier's synchronous acknowledgement the row vanishes again (DELETE +
    // owner change, no barrier yet).
    store.transaction(() =>
      store
        .prepare(
          "INSERT INTO upload(id, state, received_bytes, body) VALUES('flap','uploaded',1,x'00')",
        )
        .run(),
    );
    const g2 = blobs.owners.noteChange(key);
    let g3 = 0;
    const flapped = new Promise<void>((resolve) => {
      const off = store.onSynced((g) => {
        if (g < g2 || g3 !== 0) return;
        store.transaction(() => store.prepare("DELETE FROM upload WHERE id = 'flap'").run());
        g3 = blobs.owners.noteChange(key);
        off();
        resolve();
      });
    });
    store.flusherControl.tick();
    await flapped;
    await new Promise((r) => setTimeout(r, 20));
    // No durable prefix may show `uploaded` without its part: the unlink waits for g3.
    expect(g3).toBeGreaterThan(g2);
    expect(g2).toBeGreaterThan(g1);
    expect(existsSync(part)).toBe(true);
    expect(blobs.owners.generationOf(key)).toBe(g3);
    store.flusherControl.tick();
    const report = await sweeping;
    expect(report.removedParts).toEqual([part]);
    expect(existsSync(part)).toBe(false);
    expect(blobs.owners.generationOf(key)).toBeUndefined();
  });

  it("serializes requests on one worker and refuses after stop", async () => {
    const { store, maintenance } = await openStore();
    seedRows(store, 50);
    const [a, b] = await Promise.all([maintenance.integrityCheck(), maintenance.integrityCheck()]);
    expect(a.ok && b.ok).toBe(true);
    await maintenance.stop();
    await expect(maintenance.integrityCheck()).rejects.toMatchObject({ code: "store_closed" });
    expect(statSync(store.paths.database).size).toBeGreaterThan(0);
  });
});
