import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlobFiles, type EngineStore } from "@claudexor/daemon";
import { ControlUploadCreateRequest } from "@claudexor/schema";
import { hashJson } from "@claudexor/util";
import { SqlDaemonStorage } from "./sql-daemon-storage.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

it("keeps physical archive bodies and uploads outside fresh and restarted GC custody", async () => {
  const f = fixture();
  await f.storage.open();
  const old = f.storage.graph();
  const params = { prompt: "acknowledged old conversation ".repeat(4_000) };
  old.commands
    .current()
    .accept({ id: "old-only", params, clientId: "fixture", idempotencyKey: "old" });
  const body = old.store.prepare("SELECT params_sha FROM command WHERE id='old-only'").get() as {
    params_sha: string;
  };
  const modelBytes = Buffer.from("unacknowledged model response ".repeat(4_000));
  const model = old.resources.publishModel(modelBytes);
  const uploadBytes = Buffer.from("unfinished upload ".repeat(6_000));
  const request = ControlUploadCreateRequest.parse({
    purpose: "model",
    kind: "file",
    mime: "application/json",
    name: "pending.json",
    sizeBytes: uploadBytes.length,
  });
  const upload = old.resources.create(request, "upload");
  await old.resources.write(
    upload.uploadId,
    (async function* () {
      yield uploadBytes;
    })(),
  );
  // A valid, previously unreplayed legacy key belongs with its old resource generation.
  const legacyKey = "unreplayed-legacy-create";
  const keyDigest = createHash("sha256").update(`create\0${legacyKey}`).digest("hex");
  const legacyPath = join("resource-store", "idempotency", `${keyDigest}.json`);
  const legacyBytes = JSON.stringify({
    operation: "create",
    key: legacyKey,
    requestDigest: hashJson(request),
    result: upload,
  });
  mkdirSync(join(f.rootDir, "resource-store/idempotency"), { recursive: true });
  writeFileSync(join(f.rootDir, legacyPath), legacyBytes);
  old.store.transaction(() =>
    old.store.exec(
      "INSERT INTO meta(key,value) VALUES('legacy_idempotency_dir','present'); CREATE TABLE archive_damage(value TEXT); INSERT INTO archive_damage VALUES('damage only this page')",
    ),
  );
  const { rootpage } = old.store
    .prepare("SELECT rootpage FROM sqlite_schema WHERE name='archive_damage'")
    .get() as { rootpage: number };
  const { page_size } = old.store.prepare("PRAGMA page_size").get() as { page_size: number };
  const preserved = [
    "accounts/evidence",
    "credentials/evidence",
    "runs/kept/evidence",
    "journal-legacy/evidence",
    "setup-artifacts/evidence",
    "authority/evidence",
  ];
  for (const name of preserved) {
    mkdirSync(join(f.rootDir, name, ".."), { recursive: true });
    writeFileSync(join(f.rootDir, name), `keep ${name}`);
  }
  await old.store.flushed();
  await old.resources.drainCleanup();
  await f.storage.close();
  // Exercise the default process-start cutoff with known old fixture mtimes.
  const resourceSha = model.sha256.replace(/^sha256:/, "");
  const part = join("resource-store", "uploads", `${upload.uploadId}.part`);
  for (const name of [
    join("resource-store/blobs", body.params_sha),
    join("resource-store/blobs", resourceSha),
    part,
  ])
    utimesSync(join(f.rootDir, name), new Date(0), new Date(0));
  const fd = openSync(join(f.rootDir, "engine.sqlite"), "r+");
  try {
    writeSync(fd, Buffer.from([0xff]), 0, 1, (rootpage - 1) * page_size);
  } finally {
    closeSync(fd);
  }
  await f.storage.open();
  expect(f.storage.graph().commands.current().get("old-only")!.params).toEqual(params);
  expect((await f.storage.graph().maintenance.integrityCheck()).ok).toBe(false);
  expect(f.onCorrupt).toHaveBeenCalledWith(expect.objectContaining({ code: "store_corrupt" }));
  const recoveryRequest = {
    idempotencyKey: "archive",
    confirmation: "quarantine_and_start_fresh" as const,
    expectedFingerprint: f.storage.engineRecovery.inspect().fingerprint,
  };
  const receipt = await f.storage.engineRecovery.quarantineAndStartFresh(recoveryRequest);
  const fresh = f.storage.graph();
  expect(fresh.store.prepare("SELECT count(*) AS n FROM command").get()).toEqual({ n: 0 });
  expect(
    fresh.store.prepare("SELECT value FROM meta WHERE key='legacy_idempotency_dir'").get(),
  ).toBeUndefined();
  const freshParams = { prompt: "a current owner ".repeat(6_000) };
  fresh.commands.current().accept({
    id: "fresh-kept",
    params: freshParams,
    clientId: "fixture",
    idempotencyKey: "fresh",
  });
  const current = fresh.store
    .prepare("SELECT params_sha FROM command WHERE id='fresh-kept'")
    .get() as { params_sha: string };
  utimesSync(fresh.blobs.filePath(current.params_sha), new Date(0), new Date(0));
  const orphan = fresh.blobs.prepareBody(Buffer.from("true new orphan ".repeat(6_000)));
  utimesSync(orphan.file!, new Date(0), new Date(0));
  await fresh.recoverAfterStartup();
  const sweep = await fresh.maintenance.sweepOrphans();
  expect(sweep.removedBlobs).toContain(orphan.sha256);
  expect(existsSync(orphan.file!)).toBe(false);
  expect(fresh.commands.current().get("fresh-kept")!.params).toEqual(freshParams);

  const archiveDatabase = join(receipt.quarantinePath, "engine.sqlite");
  const archivedBytes = readFileSync(archiveDatabase);
  const checkArchive = () => {
    const db = new DatabaseSync(archiveDatabase, { readOnly: true });
    try {
      // The production body reader over an explicitly read-only archived connection.
      const reader = new BlobFiles(
        { prepare: db.prepare.bind(db) } as EngineStore,
        join(receipt.quarantinePath, "resource-store/blobs"),
      );
      expect(JSON.parse(reader.read(body.params_sha).toString("utf8"))).toEqual(params);
      expect(reader.read(resourceSha)).toEqual(modelBytes);
      expect(db.prepare("SELECT state FROM resource WHERE id=?").get(model.resourceId)).toEqual({
        state: "ready",
      });
      expect(db.prepare("SELECT state FROM upload WHERE id=?").get(upload.uploadId)).toEqual({
        state: "uploaded",
      });
    } finally {
      db.close();
    }
    expect(readFileSync(join(receipt.quarantinePath, part))).toEqual(uploadBytes);
    expect(readFileSync(join(receipt.quarantinePath, legacyPath), "utf8")).toBe(legacyBytes);
    expect(readFileSync(archiveDatabase)).toEqual(archivedBytes);
    for (const name of preserved)
      expect(readFileSync(join(f.rootDir, name), "utf8")).toBe(`keep ${name}`);
  };
  checkArchive();
  const newUpload = fresh.resources.create(request, legacyKey);
  expect(newUpload.uploadId).not.toBe(upload.uploadId);
  await fresh.resources.write(
    newUpload.uploadId,
    (async function* () {
      yield uploadBytes;
    })(),
  );
  const newPart = join(fresh.store.paths.uploads, `${newUpload.uploadId}.part`);
  expect(await f.storage.engineRecovery.quarantineAndStartFresh(recoveryRequest)).toEqual(receipt);
  expect(readFileSync(newPart)).toEqual(uploadBytes);
  checkArchive();
  await f.storage.close();
  await f.storage.open();
  await f.storage.graph().recoverAfterStartup();
  expect((await f.storage.graph().maintenance.integrityCheck()).ok).toBe(true);
  await f.storage.graph().maintenance.sweepOrphans();
  expect(f.storage.graph().commands.current().get("fresh-kept")!.params).toEqual(freshParams);
  expect(readFileSync(newPart)).toEqual(uploadBytes);
  expect(await f.storage.engineRecovery.quarantineAndStartFresh(recoveryRequest)).toEqual(receipt);
  checkArchive();
});
function fixture() {
  const rootDir = realpathSync(mkdtempSync(join(tmpdir(), "sql-storage-owner-")));
  cleanups.push(() => rmSync(rootDir, { recursive: true, force: true }));
  const beforeClose = vi.fn(async () => {}),
    onOpen = vi.fn(),
    onCorrupt = vi.fn(),
    advanceFloor = vi.fn();
  const storage = new SqlDaemonStorage({
    rootDir,
    graph: {
      purgeFiles: async () => [rootDir],
      maintenance: {
        workerEntry: resolve(import.meta.dirname, "../../daemon/dist/store/maintenance-worker.js"),
      },
    },
    beforeClose,
    onOpen,
    onCorrupt,
    advanceFloor,
    log: () => {},
    importWorkerEntry: resolve(
      import.meta.dirname,
      "../../daemon/dist/store/maintenance-worker.js",
    ),
    flusherWorkerEntry: resolve(import.meta.dirname, "../../daemon/dist/store/flusher-worker.js"),
  });
  cleanups.push(() => storage.close());
  return { rootDir, storage, beforeClose, onOpen, onCorrupt, advanceFloor };
}
describe("one SQL storage owner", () => {
  it("keeps physical recovery usable when SQLite cannot open, and replays the original receipt", async () => {
    const f = fixture();
    const damaged = Buffer.from("not a sqlite database, retained as forensic evidence");
    writeFileSync(join(f.rootDir, "engine.sqlite"), damaged);
    await expect(f.storage.open()).rejects.toMatchObject({ code: "store_corrupt" });
    expect(f.onCorrupt).toHaveBeenCalledOnce();
    expect(f.advanceFloor).not.toHaveBeenCalled();
    expect(f.storage.facts()).toMatchObject({ integrity: "failed", flusher: null });
    const inspection = f.storage.engineRecovery.inspect();
    expect(inspection.status).toBe("recovery_required");
    const request = {
      idempotencyKey: "repair",
      confirmation: "quarantine_and_start_fresh" as const,
      expectedFingerprint: inspection.fingerprint,
    };
    const receipt = await f.storage.engineRecovery.quarantineAndStartFresh(request);
    expect(readFileSync(join(receipt.quarantinePath, "engine.sqlite"))).toEqual(damaged);
    expect(f.beforeClose).toHaveBeenCalledOnce();
    expect(f.onOpen).toHaveBeenCalledOnce();
    expect(f.advanceFloor).toHaveBeenCalledOnce();
    const graph = f.storage.graph();
    expect(graph.projects.global().epoch).toBe(receipt.newEpoch);
    expect(f.storage.blockedPartitions()).toEqual([]);
    graph.commands.current().accept({
      id: "kept-after-repair",
      params: { prompt: "keep" },
      clientId: "test",
      idempotencyKey: "keep",
    });
    expect(await f.storage.engineRecovery.quarantineAndStartFresh(request)).toEqual(receipt);
    expect(graph.commands.current().get("kept-after-repair")).toBeDefined();
    expect(f.onOpen).toHaveBeenCalledOnce();
    expect(existsSync(join(f.rootDir, "engine.sqlite"))).toBe(true);
  });
  it("retains the graph and logical recovery while the global generation is blocked", async () => {
    const f = fixture();
    await f.storage.open();
    const graph = f.storage.graph();
    graph.store.transaction(() =>
      graph.store
        .prepare("UPDATE partition SET status='recovery_required' WHERE name='global'")
        .run(),
    );
    expect(f.storage.blockedPartitions()).toEqual(["global"]);
    const target = f.storage.partition("global");
    const inspection = target.inspect();
    expect(inspection.status).toBe("recovery_required");
    target.quarantineAndStartFresh({
      idempotencyKey: "global",
      confirmation: "quarantine_and_start_fresh" as const,
      expectedFingerprint: inspection.fingerprint,
    });
    expect(f.storage.blockedPartitions()).toEqual([]);
    expect(f.storage.graph()).toBe(graph);
    expect(graph.quota.read()).toBeDefined();
  });
});

it("isolates an unhealthy project while serving a healthy project and global commands", async () => {
  const f = fixture();
  await f.storage.open();
  const graph = f.storage.graph();
  const register = (name: string) => {
    const root = join(f.rootDir, name);
    mkdirSync(root);
    return graph.projects.register({ root, clientId: "test", idempotencyKey: name }).project;
  };
  const healthy = register("healthy"),
    damaged = register("damaged");
  const generation = graph.projects.partition(damaged.id)!;
  graph.store.transaction(() =>
    graph.store
      .prepare("UPDATE partition SET status='recovery_required' WHERE id=?")
      .run(generation.pid),
  );
  expect(f.storage.blockedPartitions()).toEqual([]);
  expect(() =>
    graph.commands.forRequest({ scope: { kind: "project", root: damaged.root } }),
  ).toThrow(expect.objectContaining({ code: "journal_recovery_required" }));
  expect(f.storage.partition(generation.name).inspect().status).toBe("recovery_required");
  const params = { scope: { kind: "project", root: healthy.root }, prompt: "still available" };
  const command = graph.commands
    .forRequest(params)
    .accept({ id: "healthy-job", params, clientId: "test", idempotencyKey: "healthy" });
  expect(command.record.id).toBe("healthy-job");
  expect(
    graph.commands.current().accept({
      id: "global-job",
      params: { prompt: "global" },
      clientId: "test",
      idempotencyKey: "global",
    }).record.id,
  ).toBe("global-job");
});
