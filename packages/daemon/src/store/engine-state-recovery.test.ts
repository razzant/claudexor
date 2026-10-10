import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as util from "@claudexor/util";
import {
  ControlJournalInspection,
  ControlJournalQuarantineReceipt,
  ControlJournalValidation,
  ControlJournalExportReceipt,
} from "@claudexor/schema";
import { sha256, sha256File } from "../journal-recovery-files.js";
import {
  readRootAuthority,
  assertRootAuthorityAdmits,
  ROOT_AUTHORITY_EPOCH,
} from "../root-authority.js";
import {
  EngineStateRecovery,
  type EngineRecoveryLifecycle,
  type EngineRecoveryOptions,
} from "./engine-state-recovery.js";
import {
  ENGINE_STATE_FILES,
  engineFileEvidence,
  engineFingerprint,
} from "./engine-recovery-files.js";
import { EngineStore } from "./store.js";
import { createPartition } from "./partitions.js";
import { globalGeneration, setGlobalGenerationInTx } from "./generations.js";

let root: string;
const opened: EngineStore[] = [];
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cx-engine-recovery-")));
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of opened.splice(0)) await store.close();
  rmSync(root, { recursive: true, force: true });
});
const TIME = "2026-10-10T12:00:00.000Z";
const original = new Map(ENGINE_STATE_FILES.map((name) => [name, Buffer.from(`corrupt ${name}`)]));
function seed() {
  for (const [name, bytes] of original) writeFileSync(join(root, name), bytes, { mode: 0o600 });
  for (const dir of [
    "credentials",
    "journal-legacy",
    "resource-store/blobs",
    "runs/kept",
    "setup-artifacts/kept",
    "authority",
  ]) {
    mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, dir, "evidence"), `keep ${dir}`, { mode: 0o600 });
  }
  writeFileSync(
    join(root, "authority/root-authority-v2.json"),
    JSON.stringify({
      schemaVersion: 2,
      epoch: ROOT_AUTHORITY_EPOCH,
      state: "served",
      floor: "4.0.0",
    }),
    { mode: 0o600 },
  );
}
function lifecycle() {
  let corrupt = true;
  const calls: string[] = [];
  const created: Array<{ operationId: string; newEpoch: string }> = [];
  const owner: EngineRecoveryLifecycle = {
    state: () => ({
      generation: created.length,
      recovery: corrupt
        ? {
            status: "recovery_required",
            location: { kind: "byte", byteOffset: 0 },
            reason: "physical fixture corruption",
            discardedTailBytes: 0,
          }
        : { status: "ready", discardedTailBytes: 0 },
    }),
    validate: async () => ({ ok: !corrupt, detail: corrupt ? "database is unreadable" : null }),
    close: async () => {
      calls.push("close");
    },
    createFresh: async (input) => {
      calls.push("fresh");
      const op = readdirSync(join(root, "recovery-operations/engine-state"))
        .filter((name) => name.endsWith(".json"))
        .map((name) =>
          JSON.parse(readFileSync(join(root, "recovery-operations/engine-state", name), "utf8")),
        )
        .find((row) => row.operationId === input.operationId);
      expect(op.phase).toBe("archived");
      expect(op.newEpoch).toBe(input.newEpoch);
      expect(op.closedFiles).toHaveLength(3);
      const db = join(root, "engine.sqlite");
      if (existsSync(db)) expect(JSON.parse(readFileSync(db, "utf8"))).toEqual(input);
      else {
        writeFileSync(db, JSON.stringify(input), { mode: 0o600 });
        created.push(input);
      }
      corrupt = false;
    },
  };
  return {
    owner,
    calls,
    created,
    corrupt: () => {
      corrupt = true;
    },
  };
}
function api(owner: EngineRecoveryLifecycle, options: EngineRecoveryOptions = {}) {
  return new EngineStateRecovery(root, owner, { now: () => new Date(TIME), ...options });
}
function input(current: EngineStateRecovery, key = "request-key") {
  return {
    idempotencyKey: key,
    expectedFingerprint: current.inspect().fingerprint,
    confirmation: "quarantine_and_start_fresh" as const,
  };
}
function operation(key = "request-key") {
  return JSON.parse(
    readFileSync(
      join(root, "recovery-operations/engine-state", `${sha256(Buffer.from(key))}.json`),
      "utf8",
    ),
  );
}

describe("physical engine-state recovery", () => {
  it("keeps inspection/validation/export diagnostic when SQLite is unreadable", async () => {
    seed();
    const f = lifecycle();
    const current = api(f.owner);
    f.owner.validate = async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(join(root, "engine.sqlite"), { readOnly: true });
      try {
        db.prepare("PRAGMA integrity_check").all();
        return { ok: true, detail: null };
      } finally {
        db.close();
      }
    };
    const inspection = current.inspect();
    expect(ControlJournalInspection.parse(inspection)).toEqual(inspection);
    expect(inspection.fingerprint).toBe(engineFingerprint(engineFileEvidence(root)));
    const validation = await current.validate();
    expect(ControlJournalValidation.parse(validation).projectionStatus[0]).toMatchObject({
      status: "invalid",
      detail: expect.any(String),
    });
    // Even a read-only SQLite connection may change transient SHM state;
    // the export binds the exact file set observed after validation finishes.
    const exportInspection = current.inspect();
    const exportBytes = new Map(
      ENGINE_STATE_FILES.map((name) => [
        name,
        existsSync(join(root, name)) ? readFileSync(join(root, name)) : null,
      ]),
    );
    const exported = current.exportRecovery();
    expect(ControlJournalExportReceipt.parse(exported)).toEqual(exported);
    const manifest = JSON.parse(readFileSync(join(exported.bundlePath, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      diagnosticOnly: true,
      integrity: "not_verified",
      fingerprint: exportInspection.fingerprint,
    });
    expect(manifest.externalEvidence).toContain("not a restorable complete store snapshot");
    expect(sha256File(join(exported.bundlePath, "manifest.json"))).toBe(exported.manifestSha256);
    for (const [name, bytes] of exportBytes) {
      if (bytes === null) expect(existsSync(join(exported.bundlePath, name))).toBe(false);
      else expect(readFileSync(join(exported.bundlePath, name))).toEqual(bytes);
    }
    expect(f.calls).toEqual([]);
    expect(() => current.events()).toThrow(
      expect.objectContaining({ code: "recovery_events_unavailable" }),
    );
  });

  it("rejects stale fingerprints and conflicting keys before any close/rename effect", async () => {
    seed();
    const f = lifecycle();
    const current = api(f.owner);
    const request = input(current);
    writeFileSync(join(root, "engine.sqlite-wal"), "changed", { mode: 0o600 });
    await expect(current.quarantineAndStartFresh(request)).rejects.toMatchObject({
      code: "recovery_fingerprint_mismatch",
    });
    expect(f.calls).toEqual([]);
    expect(existsSync(join(root, "journal-quarantine"))).toBe(false);
    const good = input(current);
    const crash = api(f.owner, {
      fault: (stage) => {
        if (stage === "intent") throw new Error("crash");
      },
    });
    await expect(crash.quarantineAndStartFresh(good)).rejects.toThrow("crash");
    await expect(
      current.quarantineAndStartFresh({ ...good, expectedFingerprint: "b".repeat(64) }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      current.quarantineAndStartFresh({ ...good, idempotencyKey: "other" }),
    ).rejects.toMatchObject({ code: "recovery_operation_pending" });
    expect(f.calls).toEqual([]);
  });

  it("waits for owner close and records the actual checkpointed file set before rename", async () => {
    seed();
    const f = lifecycle();
    let release!: () => void;
    f.owner.close = async () => {
      f.calls.push("close");
      await new Promise<void>((done) => {
        release = done;
      });
      writeFileSync(join(root, "engine.sqlite"), "checkpointed-database", { mode: 0o600 });
      rmSync(join(root, "engine.sqlite-wal"));
      rmSync(join(root, "engine.sqlite-shm"));
    };
    const current = api(f.owner);
    const request = input(current);
    const running = current.quarantineAndStartFresh(request);
    await vi.waitFor(() => expect(f.calls).toEqual(["close"]));
    expect(existsSync(join(root, "engine.sqlite"))).toBe(true);
    expect(existsSync(join(root, "journal-quarantine"))).toBe(false);
    release();
    const receipt = await running;
    expect(receipt.previousFingerprint).toBe(request.expectedFingerprint);
    expect(readFileSync(join(receipt.quarantinePath, "engine.sqlite"), "utf8")).toBe(
      "checkpointed-database",
    );
    expect(operation().closedFiles).toEqual([
      { name: "engine.sqlite", bytes: 21, sha256: sha256(Buffer.from("checkpointed-database")) },
      { name: "engine.sqlite-wal", bytes: null, sha256: null },
      { name: "engine.sqlite-shm", bytes: null, sha256: null },
    ]);
  });

  it.each([
    "intent",
    "closed",
    "closed_record",
    "engine.sqlite",
    "engine.sqlite-wal",
    "engine.sqlite-shm",
    "archived_record",
    "fresh",
    "receipt",
  ])("resumes exact durable custody after interruption at %s", async (point) => {
    seed();
    const f = lifecycle();
    let crashed = false;
    const first = api(f.owner, {
      fault: (stage, name) => {
        if (!crashed && (point === stage || (stage === "renamed" && point === name))) {
          crashed = true;
          throw new Error(`crash ${point}`);
        }
      },
    });
    const request = input(first);
    await expect(first.quarantineAndStartFresh(request)).rejects.toThrow(`crash ${point}`);
    const durable = operation();
    const originalOperationId = durable.operationId;
    const epoch = durable.newEpoch;
    const second = api(f.owner);
    const resumed = await second.quarantineAndStartFresh(request);
    expect(ControlJournalQuarantineReceipt.parse(resumed)).toEqual(resumed);
    expect(resumed).toMatchObject({
      operationId: originalOperationId,
      newEpoch: epoch,
      previousFingerprint: request.expectedFingerprint,
    });
    expect(f.created).toHaveLength(1);
    for (const [name, bytes] of original)
      expect(readFileSync(join(resumed.quarantinePath, name))).toEqual(bytes);
    const calls = f.calls.length;
    expect(await api(f.owner).quarantineAndStartFresh(request)).toEqual(resumed);
    expect(f.calls).toHaveLength(calls);
    expect(operation().status).toBe("completed");
    expect(readdirSync(join(root, "journal-quarantine"))).toEqual([resumed.quarantineArtifactId]);
  });

  it("reconciles the same accepted operation before ordinary startup and preserves later-generation receipt replay", async () => {
    seed();
    const f = lifecycle();
    const first = api(f.owner, {
      fault: (stage) => {
        if (stage === "archived_record") throw new Error("before fresh");
      },
    });
    const request = input(first);
    await expect(first.quarantineAndStartFresh(request)).rejects.toThrow("before fresh");
    expect(existsSync(join(root, "engine.sqlite"))).toBe(false);
    const fresh = api(f.owner);
    const receipt = await fresh.resumePending();
    expect(receipt!.newEpoch).toBe(operation().newEpoch);
    expect(await fresh.resumePending()).toBeNull();
    f.corrupt();
    writeFileSync(join(root, "engine.sqlite"), "second corrupt generation", { mode: 0o600 });
    const later = await fresh.quarantineAndStartFresh(input(fresh, "later"));
    expect(later.newEpoch).not.toBe(receipt!.newEpoch);
    const calls = f.calls.length;
    expect(await fresh.quarantineAndStartFresh(request)).toEqual(receipt);
    expect(f.calls).toHaveLength(calls);
    expect(readdirSync(join(root, "journal-quarantine"))).toHaveLength(2);
  });

  it("never overwrites a prior archive or silently accepts a replaced closed source", async () => {
    seed();
    const f = lifecycle();
    const interrupted = api(f.owner, {
      fault: (stage) => {
        if (stage === "closed_record") throw new Error("closed recorded");
      },
    });
    const request = input(interrupted);
    await expect(interrupted.quarantineAndStartFresh(request)).rejects.toThrow("closed recorded");
    const archived = operation().quarantinePath;
    mkdirSync(archived, { recursive: true, mode: 0o700 });
    writeFileSync(join(archived, "engine.sqlite"), "prior archive", { mode: 0o600 });
    await expect(api(f.owner).quarantineAndStartFresh(request)).rejects.toMatchObject({
      code: "recovery_quarantine_mismatch",
    });
    expect(readFileSync(join(archived, "engine.sqlite"), "utf8")).toBe("prior archive");
    expect(readFileSync(join(root, "engine.sqlite"))).toEqual(original.get("engine.sqlite"));
    rmSync(join(archived, "engine.sqlite"));
    writeFileSync(join(root, "engine.sqlite"), "replacement", { mode: 0o600 });
    await expect(api(f.owner).quarantineAndStartFresh(request)).rejects.toMatchObject({
      code: "recovery_fingerprint_mismatch",
    });
    expect(f.created).toHaveLength(0);
  });

  it("preserves root authority4.0, credentials and historical artifact directories", async () => {
    seed();
    const f = lifecycle();
    const current = api(f.owner);
    const authority = readFileSync(join(root, "authority/root-authority-v2.json"));
    await current.quarantineAndStartFresh(input(current));
    expect(readFileSync(join(root, "authority/root-authority-v2.json"))).toEqual(authority);
    const status = readRootAuthority(join(root, "authority"));
    expect(status.status).toBe("valid");
    if (status.status !== "valid") throw new Error("missing authority");
    expect(() => assertRootAuthorityAdmits(status.record, "3.25.1")).toThrow(
      expect.objectContaining({ code: "root_authority_floor_regression" }),
    );
    for (const dir of [
      "credentials",
      "journal-legacy",
      "resource-store/blobs",
      "runs/kept",
      "setup-artifacts/kept",
      "authority",
    ])
      expect(readFileSync(join(root, dir, "evidence"), "utf8")).toBe(`keep ${dir}`);
  });

  it("persists operation and archive ancestor names before closing or moving source bytes", async () => {
    seed();
    const f = lifecycle();
    const synced: string[] = [];
    const originalSync = util.fsyncDirectory;
    vi.spyOn(util, "fsyncDirectory").mockImplementation((path) => {
      synced.push(path);
      originalSync(path);
    });
    let transfers = 0;
    const current = api(f.owner, {
      fault: (stage) => {
        if (stage === "intent") {
          expect(synced).toEqual(
            expect.arrayContaining([
              join(root, "recovery-operations/engine-state"),
              join(root, "recovery-operations"),
              root,
            ]),
          );
          expect(f.calls).toEqual([]);
        }
        if (stage === "closed") synced.length = 0;
        if (stage === "closed_record") {
          expect(synced.slice(-2)).toEqual([root, join(root, "recovery-operations/engine-state")]);
          synced.length = 0;
        }
        if (stage === "renamed") {
          transfers++;
          expect(synced).toContain(join(root, "journal-quarantine"));
          expect(synced.slice(-2)).toEqual([operation().quarantinePath, root]);
        }
      },
    });
    await current.quarantineAndStartFresh(input(current));
    expect(transfers).toBe(3);
  });

  it.each(["intent", "closed", "archived", "completed"])(
    "retries visible operation records after their directory sync failed at %s",
    async (point) => {
      seed();
      const f = lifecycle();
      const ops = join(root, "recovery-operations/engine-state");
      const requiredSyncs =
        point === "intent" ? [ops, join(root, "recovery-operations"), root] : [ops];
      let failed = false;
      const resumedSyncs: string[] = [];
      const originalSync = util.fsyncDirectory;
      vi.spyOn(util, "fsyncDirectory").mockImplementation((path) => {
        if (path === ops && !failed && operation().phase === point) {
          failed = true;
          throw Object.assign(new Error("operation sync failed"), { code: "EIO" });
        }
        originalSync(path);
        if (failed) resumedSyncs.push(path);
      });
      const close = f.owner.close;
      f.owner.close = async () => {
        if (failed) expect(resumedSyncs).toEqual(expect.arrayContaining(requiredSyncs));
        await close();
      };
      const current = api(f.owner);
      const request = input(current);
      await expect(current.quarantineAndStartFresh(request)).rejects.toThrow(
        "operation sync failed",
      );
      const visible = operation();
      const receipt = await current.quarantineAndStartFresh(request);
      expect(resumedSyncs).toEqual(expect.arrayContaining(requiredSyncs));
      expect(receipt.operationId).toBe(visible.operationId);
      expect(receipt.newEpoch).toBe(visible.newEpoch);
      if (visible.receipt) expect(receipt).toEqual(visible.receipt);
      expect(f.created).toHaveLength(1);
    },
  );

  it("retries a transferred file's failed destination sync before persisting its source removal", async () => {
    seed();
    const f = lifecycle();
    const current = api(f.owner);
    const request = input(current);
    let failed = false;
    let destinationRetried = false;
    const originalSync = util.fsyncDirectory;
    vi.spyOn(util, "fsyncDirectory").mockImplementation((path) => {
      if (!existsSync(join(root, "engine.sqlite"))) {
        const destination = operation().quarantinePath;
        if (path === destination && !failed) {
          failed = true;
          throw Object.assign(new Error("destination sync failed"), { code: "EIO" });
        }
        if (path === destination && failed) destinationRetried = true;
        if (path === root && failed) expect(destinationRetried).toBe(true);
      }
      originalSync(path);
    });
    await expect(current.quarantineAndStartFresh(request)).rejects.toThrow(
      "destination sync failed",
    );
    const receipt = await current.quarantineAndStartFresh(request);
    expect(destinationRetried).toBe(true);
    for (const [name, bytes] of original)
      expect(readFileSync(join(receipt.quarantinePath, name))).toEqual(bytes);
  });

  it("retains pending custody when closing or fresh creation fails, and serializes duplicate requests", async () => {
    seed();
    const f = lifecycle();
    const current = api(f.owner);
    const request = input(current);
    const close = f.owner.close;
    f.owner.close = async () => {
      throw new Error("close failed");
    };
    await expect(current.quarantineAndStartFresh(request)).rejects.toThrow("close failed");
    expect(operation().phase).toBe("intent");
    expect(existsSync(join(root, "journal-quarantine"))).toBe(false);
    for (const [name, bytes] of original) expect(readFileSync(join(root, name))).toEqual(bytes);
    f.owner.close = close;
    const create = f.owner.createFresh;
    f.owner.createFresh = async () => {
      throw new Error("fresh open failed");
    };
    await expect(current.quarantineAndStartFresh(request)).rejects.toThrow("fresh open failed");
    expect(operation().phase).toBe("archived");
    expect(existsSync(join(root, "engine.sqlite"))).toBe(false);
    f.owner.createFresh = create;
    const [one, two] = await Promise.all([
      current.quarantineAndStartFresh(request),
      current.quarantineAndStartFresh(request),
    ]);
    expect(one).toEqual(two);
    expect(f.created).toHaveLength(1);
  });

  it("creates an actual fresh SQLite global generation only through the parent callback", async () => {
    seed();
    let freshStore: EngineStore | undefined;
    const f = lifecycle();
    f.owner.close = async () => {
      await freshStore?.close();
      freshStore = undefined;
    };
    f.owner.createFresh = async ({ operationId, newEpoch }) => {
      freshStore = await EngineStore.open({
        daemonDir: root,
        workerEntry: resolve(import.meta.dirname, "../../dist/store/flusher-worker.js"),
        flusherHooks: { manualTick: true },
      });
      opened.push(freshStore);
      const current = globalGeneration(freshStore);
      if (current) expect(current.epoch).toBe(newEpoch);
      else
        freshStore.transaction(() => {
          setGlobalGenerationInTx(
            freshStore!,
            createPartition(freshStore!, "global", { epoch: newEpoch }).pid,
          );
          freshStore!
            .prepare("INSERT INTO meta(key,value) VALUES('recovery_operation',?)")
            .run(operationId);
        });
      expect(freshStore.prepare("SELECT count(*) AS n FROM command").get()).toEqual({ n: 0 });
      const generation = freshStore.registerExternal(root);
      const durable = freshStore.synced(generation);
      freshStore.flusherControl.tick();
      await durable;
    };
    const current = api(f.owner);
    const receipt = await current.quarantineAndStartFresh(input(current));
    expect(globalGeneration(freshStore!)!.epoch).toBe(receipt.newEpoch);
    expect(
      freshStore!.prepare("SELECT value FROM meta WHERE key='recovery_operation'").get(),
    ).toEqual({ value: receipt.operationId });
    expect(readFileSync(join(receipt.quarantinePath, "engine.sqlite"))).toEqual(
      original.get("engine.sqlite"),
    );
  });
});
