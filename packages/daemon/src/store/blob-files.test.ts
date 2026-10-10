import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlobFiles, INLINE_BODY_MAX_BYTES, sha256Hex } from "./blob-files.js";
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
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-blobs-"));
});
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  rmSync(root, { recursive: true, force: true });
});
async function openStore(manualTick = false): Promise<EngineStore> {
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: builtWorkerEntry("flusher-worker.js"),
    flusherHooks: { manualTick },
  });
  stores.push(store);
  return store;
}
function body(size: number, fill = 7): Buffer {
  return Buffer.alloc(size, fill);
}
function commandWithParams(store: EngineStore, id: string, sha: string): void {
  store
    .prepare(
      "INSERT INTO command(id, pid, operation, state, created_at, summary, params_sha, kind) VALUES(?, 1, 'run.create', 'succeeded', 't', x'00', ?, 'product')",
    )
    .run(id, sha);
}
const blobRows = (store: EngineStore) =>
  (store.prepare("SELECT sha256 FROM blob ORDER BY sha256").all() as Array<{ sha256: string }>).map(
    (r) => r.sha256,
  );

describeStore("blob files (SYNTHESIS_R5 §6.5)", () => {
  it("stores bodies up to 64 KiB inline and larger bodies as content-addressed files", async () => {
    const store = await openStore();
    const blobs = new BlobFiles(store);
    const small = blobs.prepareBody(body(INLINE_BODY_MAX_BYTES));
    expect(small.inline).not.toBeNull();
    expect(small.file).toBeNull();
    const large = blobs.prepareBody(body(INLINE_BODY_MAX_BYTES + 1));
    expect(large.inline).toBeNull();
    expect(large.file).toBe(join(store.paths.blobs, large.sha256));
    expect(large.generation).not.toBeNull();
    expect(readdirSync(store.paths.blobs)).toEqual([large.sha256]);
    store.transaction(() => {
      blobs.insertRow(small);
      blobs.insertRow(large);
      commandWithParams(store, "c1", small.sha256);
      commandWithParams(store, "c2", large.sha256);
    });
    expect(blobs.read(small.sha256).equals(body(INLINE_BODY_MAX_BYTES))).toBe(true);
    expect(blobs.read(large.sha256).equals(body(INLINE_BODY_MAX_BYTES + 1))).toBe(true);
    expect(() => blobs.read("f".repeat(64))).toThrow(/no blob/);
    expect(() => blobs.insertRow(small)).toThrow(/inside the owner's transaction/);
  });

  it("never rewrites an existing blob file (decided by the file, not the row) and tolerates a repeated row", async () => {
    const store = await openStore();
    const blobs = new BlobFiles(store);
    const bytes = body(100_000, 3);
    const first = blobs.prepareBody(bytes);
    const before = statSync(first.file!);
    const second = blobs.prepareBody(bytes);
    expect(second.sha256).toBe(first.sha256);
    expect(statSync(second.file!).ino).toBe(before.ino);
    expect(statSync(second.file!).mtimeMs).toBe(before.mtimeMs);
    store.transaction(() => {
      blobs.insertRow(first);
      blobs.insertRow(second);
    });
    expect(blobRows(store)).toEqual([first.sha256]);
  });

  it("detects a tampered file through the digest", async () => {
    const store = await openStore();
    const blobs = new BlobFiles(store);
    const ref = blobs.prepareBody(body(70_000));
    store.transaction(() => blobs.insertRow(ref));
    writeFileSync(ref.file!, body(70_000, 9));
    expect(() => blobs.read(ref.sha256)).toThrow(/does not match its digest/);
  });

  it("publishes an upload part by hard link, once", async () => {
    const store = await openStore();
    const blobs = new BlobFiles(store);
    const bytes = body(200_000, 5);
    const part = join(store.paths.uploads, "upl-1.part");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(store.paths.uploads, { recursive: true });
    writeFileSync(part, bytes);
    const sha = sha256Hex(bytes);
    const published = blobs.publishLink(part, sha);
    expect(published.linked).toBe(true);
    expect(statSync(published.path).nlink).toBe(2);
    expect(blobs.publishLink(part, sha).linked).toBe(false);
    store.transaction(() =>
      blobs.insertRow({
        sha256: sha,
        size: bytes.length,
        inline: null,
        file: published.path,
        generation: null,
      }),
    );
    expect(blobs.read(sha).equals(bytes)).toBe(true);
  });

  it("T-GC-1: the GC rechecks owners after the barrier and keeps a digest published meanwhile", async () => {
    const store = await openStore(true);
    const blobs = new BlobFiles(store);
    const obligations = new Obligations(store);
    const orphan = blobs.prepareBody(body(80_000, 1));
    const republished = blobs.prepareBody(body(80_000, 2));
    const obligated = blobs.prepareBody(body(80_000, 3));
    store.transaction(() => {
      blobs.insertRow(orphan);
      blobs.insertRow(republished);
      blobs.insertRow(obligated);
      obligations.create("publish_blob", "upl-9", 0, {
        sha: obligated.sha256,
        resource_id: "res-9",
      });
    });
    const collecting = Promise.all(
      [orphan, republished, obligated].map((ref) => blobs.gc(ref.sha256)),
    );
    // Races the GC's barrier wait: a publication that references the digest
    // commits synchronously before the GC's recheck runs.
    store.transaction(() => commandWithParams(store, "c9", republished.sha256));
    store.flusherControl.tick();
    expect(await collecting).toEqual(["removed", "owned", "owned"]);
    expect(existsSync(orphan.file!)).toBe(false);
    expect(existsSync(republished.file!)).toBe(true);
    expect(existsSync(obligated.file!)).toBe(true);
    expect(blobRows(store)).toEqual([republished.sha256, obligated.sha256].sort());
  });

  it("T-GC-3: the GC is bound to the LATEST owner change and waits for its barrier before unlinking", async () => {
    const store = await openStore(true);
    const blobs = new BlobFiles(store);
    const bytes = body(80_000, 4);
    const refA = blobs.prepareBody(bytes);
    store.transaction(() => {
      blobs.insertRow(refA);
      commandWithParams(store, "A", refA.sha256);
    });
    // Delete A (unref g1) and start the GC; it waits for the barrier covering g1.
    store.transaction(() => store.prepare("DELETE FROM command WHERE id = 'A'").run());
    const g1 = blobs.noteOwnerChange(refA.sha256);
    const collecting = blobs.gc(refA.sha256);
    expect(blobs.gc(refA.sha256)).toBe(collecting); // single-flight per digest
    // The barrier for g1 completes; in the SAME synchronous section as its
    // acknowledgement (before the GC resumes) B republishes and unrefs the digest.
    let g2 = 0;
    const raced = new Promise<void>((resolve) => {
      const off = store.onSynced((g) => {
        if (g < g1 || g2 !== 0) return;
        const refB = blobs.prepareBody(bytes); // file exists: adopted
        store.transaction(() => {
          blobs.insertRow(refB);
          commandWithParams(store, "B", refB.sha256);
        });
        store.transaction(() => store.prepare("DELETE FROM command WHERE id = 'B'").run());
        g2 = blobs.noteOwnerChange(refA.sha256);
        off();
        resolve();
      });
    });
    store.flusherControl.tick();
    await raced;
    await new Promise((r) => setTimeout(r, 20));
    // After g1 the GC saw a newer unref (g2) and waited instead of unlinking.
    expect(g2).toBeGreaterThan(g1);
    expect(store.facts().flusher.acknowledged_generation).toBeLessThan(g2);
    expect(existsSync(refA.file!)).toBe(true);
    expect(blobs.owners.generationOf(`blob:${refA.sha256}`)).toBe(g2);
    // Had B's deletion lost its barrier (power loss) the recovered prefix would
    // own the blob; only once g2 is proven may the file go.
    store.flusherControl.tick();
    expect(await collecting).toBe("removed");
    expect(existsSync(refA.file!)).toBe(false);
    expect(blobRows(store)).toEqual([]);
    expect(blobs.owners.generationOf(`blob:${refA.sha256}`)).toBeUndefined();
  });

  it("gc tolerates a file already gone and leaves inline rows alone", async () => {
    const store = await openStore(true);
    const blobs = new BlobFiles(store);
    const inline = blobs.prepareBody(body(10));
    const file = blobs.prepareBody(body(70_000, 6));
    store.transaction(() => {
      blobs.insertRow(inline);
      blobs.insertRow(file);
    });
    rmSync(file.file!);
    const collecting = Promise.all([blobs.gc(inline.sha256), blobs.gc(file.sha256)]);
    store.flusherControl.tick();
    expect(await collecting).toEqual(["removed", "removed"]);
    // The inline row is deleted with its last reference by the owner, never by the file GC.
    expect(blobRows(store)).toEqual([inline.sha256]);
  });
});
