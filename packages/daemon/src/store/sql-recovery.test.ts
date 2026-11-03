import { createHash } from "node:crypto";
import * as promises from "node:fs/promises";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ControlJournalInspection,
  ControlJournalQuarantineReceipt,
  ControlJournalValidation,
} from "@claudexor/schema";
import { QuotaRegistry } from "../quota-registry.js";
import { BlobFiles } from "./blob-files.js";
import { encodeJournalCursor } from "./cursors.js";
import { SqlEventLedger } from "./event-store.js";
import {
  globalGeneration,
  setGenerationStatusInTx,
  setGlobalGenerationInTx,
} from "./generations.js";
import { bindIdempotencyInTx } from "./idempotency.js";
import { MaintenanceController } from "./maintenance.js";
import { Obligations } from "./obligations.js";
import { createPartition, type PartitionGeneration } from "./partitions.js";
import { SqlProjectStore } from "./projects.js";
import { SqlPartitionRecovery, type SqlRecoveryOptions } from "./sql-recovery.js";
import { EngineStore } from "./store.js";
import { SqlUploads } from "./uploads.js";
import { uploadKeyDigest } from "./upload-binding-retention.js";
import { afterEachClosed } from "../../../cli/src/test-support/after-each-closed.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const fd = await actual.open(...args);
      const sync = fd.sync.bind(fd);
      fd.sync = async () => {
        // Keep the Windows writable-handle requirement visible on POSIX too.
        // A zero-byte write checks access without changing the exported bytes.
        if ((await fd.stat()).isFile()) writeSync(fd.fd, Buffer.alloc(0), 0, 0, 0);
        await sync();
      };
      return fd;
    },
  };
});

const TIME = "2026-10-10T12:00:00.000Z";
let root: string;
let store: EngineStore;
let blobs: BlobFiles;
let maintenance: MaintenanceController;
let obligations: Obligations;
let projects: SqlProjectStore;
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cx-recovery-")));
  store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    now: () => new Date(TIME),
    workerEntry: resolve(import.meta.dirname, "../../dist/store/flusher-worker.js"),
    flusherHooks: { manualTick: true },
  });
  blobs = new BlobFiles(store);
  maintenance = new MaintenanceController(store, {
    workerEntry: resolve(import.meta.dirname, "../../dist/store/maintenance-worker.js"),
    blobs,
  });
  obligations = new Obligations(store);
  store.transaction(() =>
    setGlobalGenerationInTx(store, createPartition(store, "global", { epoch: "original" }).pid),
  );
  projects = new SqlProjectStore(store, blobs, obligations);
});
afterEachClosed(async () => {
  vi.restoreAllMocks();
  // This test's handles, taken before their closes: a late close never reaches the next test's.
  const [ownedMaintenance, ownedObligations, ownedStore] = [maintenance, obligations, store];
  await ownedMaintenance?.stop();
  ownedObligations?.close();
  await ownedStore?.close();
  return () => {
    rmSync(root, { recursive: true, force: true });
  };
});

const ledger = (generation = globalGeneration(store)!) =>
  new SqlEventLedger(store, blobs, generation);
function recovery(partition = "global", extra: Partial<SqlRecoveryOptions> = {}) {
  return new SqlPartitionRecovery(store, blobs, maintenance, partition, {
    projections: () => [
      {
        name: "quota",
        validate: (generation) =>
          new QuotaRegistry(ledger(generation), [], store.now).validateProjection(),
      },
    ],
    ...extra,
  });
}
function damaged(generation = globalGeneration(store)!) {
  store.transaction(() => setGenerationStatusInTx(store, generation.pid, "recovery_required"));
}
const request = (api: SqlPartitionRecovery, key = "quarantine-key") => ({
  expectedFingerprint: api.inspect().fingerprint,
  confirmation: "quarantine_and_start_fresh" as const,
  idempotencyKey: key,
});
function project() {
  const path = join(root, `project-${Math.random()}`);
  mkdirSync(path);
  return projects.register({ root: path, clientId: "fixture", idempotencyKey: path }).project;
}
function command(generation: PartitionGeneration, id: string) {
  store.transaction(() =>
    store
      .prepare(
        "INSERT INTO command(id,pid,operation,state,created_at,summary,params_sha,kind) VALUES(?,?,'run.create','queued',?,x'7b7d','fixture','product')",
      )
      .run(id, generation.pid, TIME),
  );
}

describe("SQL logical partition recovery", () => {
  it("fingerprints store/name/epoch/next_seq/type counts without hydrating bodies", () => {
    const event = ledger().append("large.evidence", { text: "x".repeat(80_000) });
    const read = vi.spyOn(blobs, "read").mockImplementation(() => {
      throw new Error("unexpected body read");
    });
    const api = recovery();
    const inspected = api.inspect();
    expect(ControlJournalInspection.parse(inspected)).toEqual(inspected);
    const identity = store.prepare("SELECT value FROM meta WHERE key='store_id'").get() as {
      value: string;
    };
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          store_id: identity.value,
          name: "global",
          epoch: "original",
          next_seq: event.seq + 1,
          counts: [{ type: "large.evidence", count: 1 }],
        }),
      )
      .digest("hex");
    expect(inspected).toMatchObject({
      partition: "global",
      generation: globalGeneration(store)!.pid,
      status: "ready",
      fingerprint,
    });
    ledger().append("thread.entities_upserted", {});
    expect(api.inspect().fingerprint).not.toBe(fingerprint);
    expect(read).not.toHaveBeenCalled();
  });

  it("preserves imported recovery details and runs actual quota validation with maintenance integrity", async () => {
    const api = recovery();
    expect(ControlJournalValidation.parse(await api.validate()).projectionStatus).toEqual([
      {
        name: "sqlite.integrity",
        status: "valid",
        detail: "Whole engine database integrity_check passed.",
      },
      { name: "quota", status: "valid", detail: null },
    ]);
    ledger().append("quota.snapshot.upserted", { invalid: "snapshot" });
    const checked = await api.validate();
    expect(checked.status).toBe("recovery_required");
    expect(checked.projectionStatus[1]).toMatchObject({ name: "quota", status: "invalid" });
    const original = {
      status: "recovery_required",
      location: { kind: "byte", byteOffset: 1234 },
      reason: "unexplained damaged tail",
      discardedTailBytes: 0,
    };
    store.transaction(() =>
      store
        .prepare(
          "INSERT INTO import_partition(name,status,pid,problem) VALUES('global','recovery_required',?,?)",
        )
        .run(globalGeneration(store)!.pid, JSON.stringify(original)),
    );
    expect(recovery().inspect().recovery).toEqual(original);
    expect(() => api.events()).toThrow(
      expect.objectContaining({ code: "journal_recovery_required" }),
    );
  });

  it("does not claim projection coverage when validators are absent or physical corruption is observed", async () => {
    await expect(recovery("global", { projections: () => [] }).validate()).rejects.toMatchObject({
      code: "recovery_validation_unavailable",
    });
    const notified = vi.fn();
    const integrity = vi
      .spyOn(maintenance, "integrityCheck")
      .mockResolvedValue({ ok: false, problems: ["fixture physical index damage"], durationMs: 1 });
    const api = recovery("global", { onPhysicalCorruption: notified });
    await expect(api.validate()).rejects.toMatchObject({ code: "store_corrupt" });
    expect(notified).toHaveBeenCalledOnce();
    expect(globalGeneration(store)!.status).toBe("ready");
    integrity.mockRestore();
    store.recordIntegrity("failed");
    expect(() =>
      api.preflightQuarantine({
        expectedFingerprint: "a".repeat(64),
        confirmation: "quarantine_and_start_fresh",
        idempotencyKey: "key",
      }),
    ).toThrow(expect.objectContaining({ code: "store_corrupt" }));
    expect(store.prepare("SELECT count(*) AS n FROM partition").get()).toEqual({ n: 1 });
  });

  it("rejects ready partitions and stale fingerprints before mutations", () => {
    const api = recovery();
    const input = request(api);
    expect(() => api.quarantineAndStartFresh(input)).toThrow(
      expect.objectContaining({ code: "journal_partition_ready" }),
    );
    damaged();
    ledger().append("more.evidence", {});
    expect(() => api.preflightQuarantine(input)).toThrow(
      expect.objectContaining({ code: "recovery_fingerprint_mismatch" }),
    );
    expect(store.prepare("SELECT count(*) AS n FROM idempotency").get()).toEqual({ n: 0 });
    expect(store.prepare("SELECT count(*) AS n FROM partition").get()).toEqual({ n: 1 });
  });

  it("quarantines atomically, keeps old evidence and replays the ORIGINAL receipt after a second quarantine", async () => {
    const original = globalGeneration(store)!;
    const evidence = ledger().append("saved.evidence", { important: true });
    damaged();
    const changed = vi.fn();
    const api = recovery("global", { onQuarantined: changed });
    const firstInput = request(api, "first");
    const first = api.quarantineAndStartFresh(firstInput);
    expect(ControlJournalQuarantineReceipt.parse(first)).toEqual(first);
    expect(first.quarantinePath).toBe(`partition:global@${original.epoch}`);
    expect(changed).toHaveBeenCalledOnce();
    const preserved = store
      .prepare("SELECT payload FROM event WHERE pid=? AND seq=?")
      .get(original.pid, evidence.seq) as { payload: Uint8Array };
    expect(Buffer.from(preserved.payload)).toEqual(Buffer.from(JSON.stringify(evidence.payload)));
    const current = globalGeneration(store)!;
    expect(current.epoch).toBe(first.newEpoch);
    expect(() =>
      api.events({ after: encodeJournalCursor("global", original.epoch, evidence.seq) }),
    ).toThrow(expect.objectContaining({ code: "journal_cursor_invalid", status: 409 }));
    expect(api.events().events[0]).toMatchObject({
      type: "journal.partition_quarantined",
      payload: first,
    });
    damaged(current);
    const second = api.quarantineAndStartFresh(request(api, "second"));
    expect(second.newEpoch).not.toBe(first.newEpoch);
    expect(recovery().preflightQuarantine(firstInput)).toEqual({
      disposition: "completed",
      receipt: first,
    });
    expect(recovery().quarantineAndStartFresh(firstInput)).toEqual(first);
    expect(globalGeneration(store)!.epoch).toBe(second.newEpoch);
    expect(() =>
      api.quarantineAndStartFresh({
        ...firstInput,
        expectedFingerprint: second.previousFingerprint,
      }),
    ).toThrow(expect.objectContaining({ code: "idempotency_conflict" }));
    expect(
      store
        .prepare("SELECT pid,target_id FROM idempotency WHERE owner='quarantine' ORDER BY pid")
        .all(),
    ).toEqual([
      { pid: original.pid, target_id: first.operationId },
      { pid: current.pid, target_id: second.operationId },
    ]);
    await maintenance.stop();
    obligations.close();
    await store.close();
    store = await EngineStore.open({
      daemonDir: join(root, "daemon"),
      now: () => new Date(TIME),
      workerEntry: resolve(import.meta.dirname, "../../dist/store/flusher-worker.js"),
      flusherHooks: { manualTick: true },
    });
    blobs = new BlobFiles(store);
    maintenance = new MaintenanceController(store, {
      workerEntry: resolve(import.meta.dirname, "../../dist/store/maintenance-worker.js"),
      blobs,
    });
    obligations = new Obligations(store);
    expect(recovery().quarantineAndStartFresh(firstInput)).toEqual(first);
    expect(globalGeneration(store)!.epoch).toBe(second.newEpoch);
  });

  it("keeps project quarantine isolated, global quarantine hides project registry/commands, upload pid0 survives", () => {
    const p = project();
    const pg = projects.partition(p.id)!;
    command(pg, "project-command");
    ledger(pg).append("project.evidence", { id: p.id });
    const global = globalGeneration(store)!;
    command(global, "global-command");
    store.transaction(() =>
      bindIdempotencyInTx(store, {
        owner: "upload",
        pid: 0,
        keyDigest: "upload-key",
        operation: "upload.create",
        requestDigest: "request",
        targetId: "upload-id",
        result: { original: true },
        createdAt: TIME,
      }),
    );
    damaged(pg);
    const projectRecovery = recovery(pg.name);
    const projectInput = request(projectRecovery);
    const projectReceipt = projectRecovery.quarantineAndStartFresh(projectInput);
    expect(projects.get(p.id)?.id).toBe(p.id);
    expect(store.prepare("SELECT live FROM command WHERE id='project-command'").get()).toEqual({
      live: 0,
    });
    expect(store.prepare("SELECT live FROM command WHERE id='global-command'").get()).toEqual({
      live: 1,
    });
    damaged(global);
    const api = recovery();
    api.quarantineAndStartFresh(request(api, "global"));
    expect(projects.list()).toEqual([]);
    expect(store.prepare("SELECT id FROM command WHERE live=1").all()).toEqual([]);
    expect(
      store.prepare("SELECT target_id FROM idempotency WHERE owner='upload' AND pid=0").get(),
    ).toEqual({ target_id: "upload-id" });
    expect(projectRecovery.quarantineAndStartFresh(projectInput)).toEqual(projectReceipt);
    expect(() => projectRecovery.inspect()).toThrow(expect.objectContaining({ status: 404 }));
  });

  it("rolls back generation, binding and visibility when the receipt event fails", () => {
    const generation = globalGeneration(store)!;
    command(generation, "job");
    damaged();
    const api = recovery();
    const input = request(api);
    store.transaction(() =>
      store
        .prepare(
          "CREATE TEMP TRIGGER fail_quarantine BEFORE INSERT ON event WHEN NEW.type='journal.partition_quarantined' BEGIN SELECT RAISE(ABORT,'receipt fault'); END",
        )
        .run(),
    );
    expect(() => api.quarantineAndStartFresh(input)).toThrow(/receipt fault/);
    expect(globalGeneration(store)).toMatchObject({
      pid: generation.pid,
      status: "recovery_required",
    });
    expect(
      store.prepare("SELECT count(*) AS n FROM idempotency WHERE owner='quarantine'").get(),
    ).toEqual({ n: 0 });
    expect(store.prepare("SELECT count(*) AS n FROM partition").get()).toEqual({ n: 1 });
    store.transaction(() => store.prepare("DROP TRIGGER fail_quarantine").run());
    expect(api.quarantineAndStartFresh(input).newEpoch).not.toBe(generation.epoch);
  });

  it("retains committed custody when a parent's rebind notification fails", () => {
    damaged();
    const api = recovery("global", {
      onQuarantined: () => {
        throw new Error("rebind fault");
      },
    });
    const input = request(api);
    expect(() => api.quarantineAndStartFresh(input)).toThrow(/rebind fault/);
    const receipt = recovery().quarantineAndStartFresh(input);
    expect(globalGeneration(store)!.epoch).toBe(receipt.newEpoch);
    expect(store.prepare("SELECT count(*) AS n FROM partition").get()).toEqual({ n: 2 });
    expect(existsSync(join(root, "daemon/recovery-operations"))).toBe(false);
  });
});

describe("SQL recovery export", () => {
  it("refuses a failed body sync without losing source bytes and permits a complete retry", async () => {
    ledger().append("large.evidence", { text: "x".repeat(80_000) });
    const required = store.prepare("SELECT sha256 FROM blob WHERE inline IS NULL").get() as {
      sha256: string;
    };
    const before = readFileSync(blobs.filePath(required.sha256));
    const open = promises.open;
    vi.spyOn(promises, "open").mockImplementationOnce(async (...args) => {
      const fd = await open(...args);
      vi.spyOn(fd, "sync").mockRejectedValueOnce(new Error("body sync failed"));
      return fd;
    });
    await expect(recovery().exportRecovery()).rejects.toMatchObject({
      code: "recovery_export_incomplete",
      message: expect.stringContaining("body sync failed"),
    });
    expect(readdirSync(join(root, "daemon/recovery-exports"))).toEqual([]);
    expect(readFileSync(blobs.filePath(required.sha256))).toEqual(before);
    const receipt = await recovery().exportRecovery();
    expect(readFileSync(join(receipt.bundlePath, "blobs", required.sha256))).toEqual(before);
  });

  it("exports an integrity-valid snapshot with required external SQL bodies and original fingerprint", async () => {
    const uploads = new SqlUploads(store, () => {});
    const partBytes = Buffer.from("uploaded but not finalized");
    const upload = uploads.create(
      { kind: "file", mime: "text/plain", name: "pending.txt", sizeBytes: partBytes.length },
      "snapshot-upload",
    );
    uploads.writeAll(upload.uploadId, partBytes);
    const legacyKey = "not-yet-adopted";
    const legacyDir = join(root, "daemon/resource-store/idempotency");
    mkdirSync(legacyDir);
    const legacyPath = join(legacyDir, `${uploadKeyDigest("create", legacyKey)}.json`);
    const legacyBytes = JSON.stringify({
      operation: "create",
      key: legacyKey,
      requestDigest: "legacy-digest",
      result: upload,
    });
    writeFileSync(legacyPath, legacyBytes);
    store.transaction(() =>
      store.prepare("INSERT INTO meta(key,value) VALUES('legacy_idempotency_dir','present')").run(),
    );
    const large = { text: "snapshot-body:".repeat(9000) };
    ledger().append("large.evidence", large);
    const required = store.prepare("SELECT sha256 FROM blob WHERE inline IS NULL").get() as {
      sha256: string;
    };
    blobs.prepareBody(Buffer.from("unreferenced".repeat(9000)));
    const api = recovery();
    const before = api.inspect();
    const originalExport = maintenance.exportTo.bind(maintenance);
    vi.spyOn(maintenance, "exportTo").mockImplementation(async (target) => {
      const report = await originalExport(target);
      ledger().append("later.evidence", {});
      return report;
    });
    const receipt = await api.exportRecovery();
    expect(receipt.fingerprint).toBe(before.fingerprint);
    expect(api.inspect().fingerprint).not.toBe(before.fingerprint);
    const manifestBytes = readFileSync(join(receipt.bundlePath, "manifest.json"));
    expect(createHash("sha256").update(manifestBytes).digest("hex")).toBe(receipt.manifestSha256);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    expect(manifest.scope).toBe("whole_engine_store");
    expect(manifest.externalEvidence).toContain("not included");
    expect(manifest.externalEvidence).toContain("Upload .part files");
    expect(manifest.externalEvidence).toContain(
      "legacy upload idempotency-key files not yet adopted into SQL",
    );
    expect(manifest.entries.map((entry: { path: string }) => entry.path)).toEqual([
      "engine.sqlite",
      `blobs/${required.sha256}`,
    ]);
    const db = new store.runtime.sqlite.DatabaseSync(join(receipt.bundlePath, "engine.sqlite"), {
      readOnly: true,
    });
    try {
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(
        db.prepare("SELECT count(*) AS n FROM event WHERE type='later.evidence'").get(),
      ).toEqual({ n: 0 });
      expect(db.prepare("SELECT state FROM upload WHERE id=?").get(upload.uploadId)).toEqual({
        state: "uploaded",
      });
      expect(
        db
          .prepare("SELECT 1 FROM idempotency WHERE key_digest=?")
          .get(uploadKeyDigest("create", legacyKey)),
      ).toBeUndefined();
    } finally {
      db.close();
    }
    expect(readFileSync(uploads.partPath(upload.uploadId))).toEqual(partBytes);
    expect(readFileSync(legacyPath, "utf8")).toBe(legacyBytes);
    expect(existsSync(join(receipt.bundlePath, "resource-store"))).toBe(false);
    rmSync(blobs.filePath(required.sha256));
    expect(
      JSON.parse(readFileSync(join(receipt.bundlePath, "blobs", required.sha256), "utf8")),
    ).toEqual(large);
    for (const entry of manifest.entries) {
      const path = join(receipt.bundlePath, entry.path);
      expect(statSync(path).mode & 0o222).toBe(0);
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o400);
      expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(entry.sha256);
    }
  });

  it.each(["missing", "changed"] as const)(
    "refuses an incomplete snapshot when a required body is %s before copy",
    async (failure) => {
      ledger().append("large.evidence", { text: "x".repeat(80_000) });
      const required = store.prepare("SELECT sha256 FROM blob WHERE inline IS NULL").get() as {
        sha256: string;
      };
      const originalExport = maintenance.exportTo.bind(maintenance);
      vi.spyOn(maintenance, "exportTo").mockImplementation(async (target) => {
        const report = await originalExport(target);
        if (failure === "missing") rmSync(blobs.filePath(required.sha256));
        else writeFileSync(blobs.filePath(required.sha256), "changed body");
        return report;
      });
      await expect(recovery().exportRecovery()).rejects.toMatchObject({
        code: "recovery_export_incomplete",
      });
      expect(readdirSync(join(root, "daemon/recovery-exports"))).toEqual([]);
    },
  );
});
