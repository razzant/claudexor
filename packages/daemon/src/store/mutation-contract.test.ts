import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlobFiles } from "./blob-files.js";
import { SqlEventLedger } from "./event-store.js";
import {
  bindIdempotencyInTx,
  deleteTargetIdempotencyInTx,
  lookupIdempotency,
  type IdempotencyBinding,
} from "./idempotency.js";
import { MutationPostCommitError, runMutation } from "./mutation.js";
import { createPartition } from "./partitions.js";
import { EngineStore } from "./store.js";

let root: string;
const stores: EngineStore[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-mutation-"));
});
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  rmSync(root, { recursive: true, force: true });
});
async function openStore(): Promise<EngineStore> {
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: resolve(import.meta.dirname, "../../dist/store/flusher-worker.js"),
    flusherHooks: { manualTick: true },
  });
  stores.push(store);
  return store;
}
const binding: IdempotencyBinding = {
  owner: "command",
  pid: 1,
  keyDigest: "sha256:original-key-formula",
  requestDigest: "sha256:original-request-formula",
  operation: "run.create",
  targetId: "command-1",
  createdAt: "2026-10-10T01:00:00.000Z",
};

describe("M1 mutation boundaries", () => {
  it.each(["blob", "command", "binding", "event"])(
    "rolls back after %s without partial rows, sequences, owners or notifications",
    async (fault) => {
      const store = await openStore();
      const blobs = new BlobFiles(store);
      const partition = store.transaction(() => createPartition(store, "global"));
      const ledger = new SqlEventLedger(store, blobs, partition);
      const body = blobs.prepareBody(Buffer.alloc(80_000, 7));
      const accepted = ledger.prepare("command.accepted", {
        record: { id: binding.targetId, content: "a".repeat(80_000) },
      });
      const notifications: string[] = [];
      const fail = (step: string) => {
        if (step === fault) throw new Error(`fault after ${step}`);
      };
      expect(() =>
        runMutation(store, (tx) => {
          tx.changes.afterCommit(() => notifications.push("accepted"));
          blobs.insertRow(body);
          tx.changes.blobChanged(body.sha256);
          fail("blob");
          tx.prepare(
            "INSERT INTO command(id,pid,operation,state,created_at,summary,params_sha,kind) VALUES(?,?,'run.create','queued',?,x'00',?,'product')",
          ).run(binding.targetId, partition.pid, binding.createdAt, body.sha256);
          fail("command");
          bindIdempotencyInTx(tx, { ...binding, pid: partition.pid });
          fail("binding");
          ledger.appendInTx(tx, accepted);
          fail("event");
        }),
      ).toThrow(`fault after ${fault}`);
      for (const table of ["blob", "command", "idempotency", "event"]) {
        expect(store.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      }
      expect(
        store.prepare("SELECT next_seq FROM partition WHERE id = ?").get(partition.pid),
      ).toEqual({
        next_seq: 1,
      });
      expect(store.owners.generationOf(`blob:${body.sha256}`)).toBeUndefined();
      expect(store.owners.generationOf(`blob:${accepted.body!.sha256}`)).toBeUndefined();
      expect(notifications).toEqual([]);
      // Preparation is allowed to leave a file; no committed reference claims it.
      expect(existsSync(body.file!)).toBe(true);
      await store.close();
      const reopened = await openStore();
      expect(reopened.prepare("SELECT count(*) AS n FROM command").get()).toEqual({ n: 0 });
      expect(lookupIdempotency(reopened, binding, binding.requestDigest)).toBeUndefined();
    },
  );

  it("publishes both sides of blob/upload changes before live callbacks, only after COMMIT", async () => {
    const store = await openStore();
    const keys = ["blob:old", "blob:new", "upload:old", "upload:new"] as const;
    let observed = false;
    runMutation(store, (tx) => {
      tx.prepare("INSERT INTO meta(key,value) VALUES('mutation','committed')").run();
      tx.changes.blobChanged("old", "new", "old", null);
      tx.changes.uploadChanged("old", "new", undefined);
      expect(keys.map((key) => store.owners.generationOf(key))).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
      tx.changes.afterCommit(() => {
        expect(store.inTransaction).toBe(false);
        expect(store.prepare("SELECT value FROM meta WHERE key='mutation'").get()).toEqual({
          value: "committed",
        });
        expect(keys.every((key) => store.owners.generationOf(key)! > 0)).toBe(true);
        observed = true;
      });
    });
    expect(observed).toBe(true);
  });

  it("a real COMMIT constraint failure discards the delta and leaves no transaction open", async () => {
    const store = await openStore();
    store.db.exec("PRAGMA foreign_keys = ON");
    store.transaction(() => {
      store.exec("CREATE TABLE fixture_parent(id INTEGER PRIMARY KEY)");
      store.exec(
        "CREATE TABLE fixture_child(id INTEGER REFERENCES fixture_parent(id) DEFERRABLE INITIALLY DEFERRED)",
      );
    });
    let notified = false;
    expect(() =>
      runMutation(store, (tx) => {
        tx.prepare("INSERT INTO fixture_child(id) VALUES(9)").run();
        tx.changes.blobChanged("uncommitted");
        tx.changes.afterCommit(() => {
          notified = true;
        });
      }),
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(store.prepare("SELECT count(*) AS n FROM fixture_child").get()).toEqual({ n: 0 });
    expect(store.inTransaction).toBe(false);
    expect(store.owners.generationOf("blob:uncommitted")).toBeUndefined();
    expect(notified).toBe(false);
    runMutation(store, (tx) => {
      tx.prepare("INSERT INTO fixture_parent(id) VALUES(9)").run();
      tx.prepare("INSERT INTO fixture_child(id) VALUES(9)").run();
    });
    expect(store.prepare("SELECT id FROM fixture_child").get()).toEqual({ id: 9 });
  });

  it("refuses Promise and nested transaction bodies without publishing their changes", async () => {
    const store = await openStore();
    for (const nested of [false, true]) {
      expect(() =>
        runMutation(store, (tx) => {
          tx.prepare("INSERT INTO meta(key,value) VALUES('bad','body')").run();
          tx.changes.uploadChanged("bad");
          return nested ? runMutation(store, () => undefined) : Promise.resolve();
        }),
      ).toThrow(nested ? /do not nest/ : /must be synchronous/);
      expect(store.prepare("SELECT value FROM meta WHERE key='bad'").get()).toBeUndefined();
      expect(store.owners.generationOf("upload:bad")).toBeUndefined();
    }
  });

  it("notification failure discloses committed SQL and retains every owner generation", async () => {
    const store = await openStore();
    let nextNotification = false;
    let failure: unknown;
    try {
      runMutation(store, (tx) => {
        tx.prepare("INSERT INTO meta(key,value) VALUES('durable','yes')").run();
        tx.changes.blobChanged("committed");
        tx.changes.afterCommit(() => {
          throw new Error("notification failed");
        });
        tx.changes.afterCommit(() => {
          nextNotification = true;
        });
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(MutationPostCommitError);
    expect(failure).toMatchObject({ committed: true });
    expect(nextNotification).toBe(true);
    expect(store.owners.generationOf("blob:committed")).toBeGreaterThan(0);
    expect(store.prepare("SELECT value FROM meta WHERE key='durable'").get()).toEqual({
      value: "yes",
    });
  });
});

describe("M1 owner-scoped idempotency", () => {
  it("T-IDE-1: the same key has independent command, turn and generation bindings through restart", async () => {
    const store = await openStore();
    const bindings: IdempotencyBinding[] = [
      binding,
      { ...binding, owner: "turn", requestDigest: "turn-request", targetId: "turn-1" },
      { ...binding, pid: 2, targetId: "new-generation" },
      { ...binding, owner: "upload", pid: 0, targetId: "upload-1", result: { state: "open" } },
    ];
    runMutation(store, (tx) => {
      for (const row of bindings) bindIdempotencyInTx(tx, row);
    });
    expect(store.prepare("SELECT count(*) AS n FROM idempotency").get()).toEqual({ n: 4 });
    await store.close();
    const reopened = await openStore();
    for (const row of bindings) {
      expect(lookupIdempotency(reopened, row, row.requestDigest)).toEqual(row);
    }
  });

  it("strict digest conflicts never replace the first target, result, operation or time", async () => {
    const store = await openStore();
    const original: IdempotencyBinding = {
      ...binding,
      owner: "upload",
      pid: 0,
      operation: "legacy",
      result: { state: "open", receivedBytes: 0 },
    };
    runMutation(store, (tx) => bindIdempotencyInTx(tx, original));
    expect(() => lookupIdempotency(store, original, "changed")).toThrow(
      expect.objectContaining({ code: "idempotency_conflict", status: 409 }),
    );
    expect(() =>
      runMutation(store, (tx) =>
        bindIdempotencyInTx(tx, { ...original, requestDigest: "changed" }),
      ),
    ).toThrow(/different request/);
    expect(
      runMutation(store, (tx) =>
        bindIdempotencyInTx(tx, { ...original, operation: "new", targetId: "new", result: null }),
      ),
    ).toEqual(original);
    expect(lookupIdempotency(store, original, original.requestDigest)).toEqual(original);
    expect(() =>
      runMutation(store, (tx) => bindIdempotencyInTx(tx, { ...binding, result: {} })),
    ).toThrow(/only upload/);
    runMutation(store, (tx) => bindIdempotencyInTx(tx, binding));
    expect(
      runMutation(store, (tx) =>
        bindIdempotencyInTx(tx, { ...binding, result: { neverPersisted: true } }),
      ),
    ).toEqual(binding);
  });

  it("T-IDE-2: deletion is atomic with its target and frees only that owner and generation", async () => {
    const store = await openStore();
    const turn = { ...binding, owner: "turn" as const };
    const otherGeneration = { ...binding, pid: 2 };
    runMutation(store, (tx) => {
      for (const row of [binding, turn, otherGeneration]) bindIdempotencyInTx(tx, row);
    });
    expect(() =>
      runMutation(store, (tx) => {
        expect(deleteTargetIdempotencyInTx(tx, "command", 1, binding.targetId)).toBe(1);
        throw new Error("target deletion failed");
      }),
    ).toThrow(/target deletion failed/);
    expect(lookupIdempotency(store, binding, binding.requestDigest)).toEqual(binding);
    expect(
      runMutation(store, (tx) => deleteTargetIdempotencyInTx(tx, "command", 1, binding.targetId)),
    ).toBe(1);
    expect(lookupIdempotency(store, binding, binding.requestDigest)).toBeUndefined();
    expect(lookupIdempotency(store, turn, turn.requestDigest)).toEqual(turn);
    expect(lookupIdempotency(store, otherGeneration, otherGeneration.requestDigest)).toEqual(
      otherGeneration,
    );
    const replacement = { ...binding, targetId: "command-2", requestDigest: "new-request" };
    runMutation(store, (tx) => bindIdempotencyInTx(tx, replacement));
    expect(lookupIdempotency(store, replacement, replacement.requestDigest)).toEqual(replacement);
    expect(() => deleteTargetIdempotencyInTx(store, "turn", 1, turn.targetId)).toThrow(
      /transaction/,
    );
  });
});
