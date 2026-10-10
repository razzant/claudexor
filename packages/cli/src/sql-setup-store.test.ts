import { mkdtempSync, realpathSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BlobFiles,
  EngineStore,
  SqlEventLedger,
  currentGeneration,
  encodeJournalCursor,
  importSetupBindingInTx,
} from "@claudexor/daemon";
import { hashJson } from "@claudexor/util";
import type { ControlSetupJob } from "@claudexor/schema";
import { insertEventInTx, restoreEventSequenceInTx } from "../../daemon/src/store/retention.js";
import { SetupJobStore as FrozenSetupJobStore } from "../../daemon/src/store/test-support/fixtures/legacy/cli/setup-job-store.js";
import { SqlSetupJobStore } from "./sql-setup-store.js";
import type { SetupJournalPayload } from "./setup-job-persistence.js";
import { SetupLifecycleBinding } from "./setup-lifecycle-binding.js";

const TIME = "2026-10-10T12:00:00.000Z";
const EPOCH = "e".repeat(32);
let root: string;
const stores: EngineStore[] = [];
const legacyStores: FrozenSetupJobStore[] = [];
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sql-setup-")));
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const old of legacyStores.splice(0)) old.journal.close();
  for (const store of stores.splice(0)) await store.close();
  rmSync(root, { recursive: true, force: true });
});

function job(jobId: string): ControlSetupJob {
  return {
    jobId,
    harness: "codex",
    action: "login",
    transport: "daemon",
    state: "queued",
    phase: "preparing",
    command: null,
    guideUrl: null,
    message: "waiting",
    createdAt: TIME,
    startedAt: null,
    finishedAt: null,
    profileId: null,
    authCapability: {
      attemptId: `attempt-${jobId}`,
      challengeDigest: "a".repeat(64),
      requestDigest: "b".repeat(64),
      state: "disclosed",
      disclosure: {
        schemaVersion: 1,
        protocolVersion: 1,
        harness: "codex",
        requested: "subscription",
        requiredRoute: "vendor_native",
        requiredSource: "native_session",
        networkScope: "selected_harness_only",
        billingKnowledge: "unknown",
        incrementalCostKnowledge: "unknown",
        mayConsumeQuota: true,
        generatedAt: TIME,
      },
    },
  };
}

async function fixture(epoch = EPOCH) {
  const dataRoot = join(root, "sql");
  const store = await EngineStore.open({
    daemonDir: dataRoot,
    workerEntry: resolve(import.meta.dirname, "../../daemon/dist/store/flusher-worker.js"),
    flusherHooks: { manualTick: true },
    now: () => new Date(TIME),
  });
  stores.push(store);
  if (!currentGeneration(store, "global"))
    store.transaction(() => {
      const row = store
        .prepare(
          "INSERT INTO partition(name,epoch,status,next_seq,created_at) VALUES('global',?,'ready',1,?)",
        )
        .run(epoch, TIME);
      store
        .prepare("INSERT INTO meta(key,value) VALUES('global_pid',?)")
        .run(String(row.lastInsertRowid));
    });
  const generation = currentGeneration(store, "global")!;
  const blobs = new BlobFiles(store);
  const ledger = new SqlEventLedger(store, blobs, generation);
  const api = new SqlSetupJobStore(dataRoot, store, ledger);
  return { store, generation, blobs, ledger, api, dataRoot };
}

describe("SQL setup persistence with the shared lifecycle projection", () => {
  it("keeps SQL-authoritative create/extend bindings across restart, distinct owner keys and no journal files", async () => {
    const f = await fixture();
    const create = { key: "same-key", client: "fixture", request: { action: "create" } };
    const extend = { ...create, request: { action: "extend" } };
    f.api.create(job("setup-main"), create);
    f.api.update("setup-main", { message: "extended" }, extend);
    expect(f.api.resolveCreate(create)?.message).toBe("extended");
    expect(f.api.resolveExtend(extend)?.message).toBe("extended");
    expect(() => f.api.resolveCreate({ ...create, request: { action: "other" } })).toThrow(
      /different request/,
    );
    expect(
      f.store
        .prepare(
          "SELECT owner,pid,key_digest,operation,created_at FROM idempotency ORDER BY operation",
        )
        .all(),
    ).toEqual([
      {
        owner: "setup",
        pid: f.generation.pid,
        key_digest: hashJson({
          client: create.client,
          partition: "global",
          operation: "setup.job.create",
          key: create.key,
        }),
        operation: "setup.job.create",
        created_at: TIME,
      },
      {
        owner: "setup",
        pid: f.generation.pid,
        key_digest: hashJson({
          client: extend.client,
          partition: "global",
          operation: "setup.job.extend",
          key: extend.key,
        }),
        operation: "setup.job.extend",
        created_at: TIME,
      },
    ]);
    expect("journal" in f.api).toBe(false);
    expect(readdirSync(f.dataRoot)).not.toContain("journal");
    expect(readdirSync(f.api.paths("setup-main").dir)).toEqual([]);
    await f.store.close();
    const reopened = await fixture();
    expect(reopened.api.resolveCreate(create)?.message).toBe("extended");
    expect(reopened.api.resolveExtend(extend)?.message).toBe("extended");
    reopened.store.transaction(() =>
      reopened.store.prepare("DELETE FROM idempotency WHERE owner='setup'").run(),
    );
    expect(reopened.api.resolveCreate(create)).toBeNull();
    const missing = new SqlSetupJobStore(reopened.dataRoot, reopened.store, reopened.ledger);
    expect(missing.recoveryState().status).toBe("recovery_required");
    expect(() => missing.status("setup-main")).toThrow(/requires recovery/);
  });

  it.each(["create", "bind", "extend"] as const)(
    "atomically rolls back the %s binding, event, sequence and live maps on SQL failure",
    async (kind) => {
      const f = await fixture();
      if (kind !== "create") f.api.create(job("setup-main"));
      const binding = { key: `${kind}-key`, client: "fixture", request: { kind } };
      const before = f.api.list();
      const seq = currentGeneration(f.store, "global")!.nextSeq;
      const type = kind === "bind" ? "setup.job.create_bound" : "setup.job.saved";
      f.store.transaction(() =>
        f.store
          .prepare(
            `CREATE TEMP TRIGGER fail_setup BEFORE INSERT ON event WHEN NEW.type = '${type}' BEGIN SELECT RAISE(ABORT, 'setup rollback probe'); END`,
          )
          .run(),
      );
      const action = () =>
        kind === "create"
          ? f.api.create(job("setup-main"), binding)
          : kind === "bind"
            ? f.api.bindCreate("setup-main", binding)
            : f.api.update("setup-main", { message: "extended" }, binding);
      expect(action).toThrow(/setup rollback probe/);
      expect(f.api.list()).toEqual(before);
      expect(currentGeneration(f.store, "global")!.nextSeq).toBe(seq);
      expect(
        f.store.prepare("SELECT count(*) AS n FROM idempotency WHERE owner='setup'").get(),
      ).toEqual({ n: 0 });
      expect(
        kind === "extend" ? f.api.resolveExtend(binding) : f.api.resolveCreate(binding),
      ).toBeNull();
      f.store.transaction(() => f.store.prepare("DROP TRIGGER fail_setup").run());
      action();
      expect(
        kind === "extend"
          ? f.api.resolveExtend(binding)?.jobId
          : f.api.resolveCreate(binding)?.jobId,
      ).toBe("setup-main");
      expect(currentGeneration(f.store, "global")!.nextSeq).toBe(seq + 1);
    },
  );

  it("imports frozen legacy saved/create-bound/extend digests and sparse original cursors without guessing operation", async () => {
    let legacyTick = 0;
    const old = new FrozenSetupJobStore(join(root, "legacy"), {
      now: () => new Date(Date.parse(TIME) + ++legacyTick * 1000),
    });
    legacyStores.push(old);
    const create = { key: "create", client: "fixture", request: { a: 1 } };
    const bind = { key: "bound", client: "fixture", request: { a: 2 } };
    const extend = { key: "extend", client: "fixture", request: { a: 3 } };
    old.create(job("setup-main"), create);
    old.journal.append("unrelated", { note: "gap" });
    const after = old.journal.currentCursor();
    old.appendLog("setup-main", "log gap");
    old.update("setup-main", { message: "second" }, extend);
    old.bindCreate("setup-main", bind);
    old.journal.append("unrelated", {});
    old.update("setup-main", {
      state: "failed",
      phase: "completed",
      outcome: { reason: "launch_failed" },
      finishedAt: TIME,
    });
    old.journal.append("thread.entities_upserted", {});
    const records = old.journal.records<SetupJournalPayload>();
    const f = await fixture(records[0]!.epoch);
    f.store.transaction(() => {
      for (const record of records) {
        insertEventInTx(f.store, f.generation.pid, record);
        importSetupBindingInTx(f.store, f.generation.pid, record);
      }
      restoreEventSequenceInTx(f.store, f.generation.pid, old.journal.currentSequence() + 1);
    });
    const imported = new SqlSetupJobStore(f.dataRoot, f.store, f.ledger);
    expect(imported.list()).toEqual(old.list());
    expect(imported.snapshot("setup-main")).toEqual(old.snapshot("setup-main"));
    expect(imported.events("setup-main", after)).toEqual(old.events("setup-main", after));
    expect(imported.resolveCreate(create)).toEqual(old.resolveCreate(create));
    expect(imported.resolveCreate(bind)).toEqual(old.resolveCreate(bind));
    expect(imported.resolveExtend(extend)).toEqual(old.resolveExtend(extend));
    const bindings = records
      .filter((r) => r.payload?.binding !== undefined)
      .map((r) => ({ ...(r.payload.binding as object), createdAt: r.time }));
    expect(
      f.store
        .prepare(
          "SELECT key_digest AS keyDigest,request_digest AS requestDigest,target_id AS jobId,created_at AS createdAt FROM idempotency ORDER BY key_digest",
        )
        .all(),
    ).toEqual(bindings.sort((a, b) => (a as any).keyDigest.localeCompare((b as any).keyDigest)));
    expect(f.store.prepare("SELECT DISTINCT operation FROM idempotency").all()).toEqual([
      { operation: "setup.legacy_unknown" },
    ]);
    expect(f.ledger.records(0, ["setup.job.log"])).toEqual([]);
    expect(f.ledger.records(0, ["setup.job.saved"])).toHaveLength(3);
    expect(() => imported.events("setup-main", encodeJournalCursor("global", "other", 0))).toThrow(
      expect.objectContaining({ code: "journal_cursor_invalid" }),
    );
    await f.store.close();
    expect((await fixture()).api.events("setup-main", after)).toEqual(
      old.events("setup-main", after),
    );
  });

  it("addresses only the requested saved group through sparse global sequence, including large bodies", async () => {
    const f = await fixture();
    f.api.create(job("setup-main"));
    const snapshot = f.api.snapshot("setup-main");
    f.ledger.append("unrelated", { detail: "x".repeat(90_000) });
    f.api.update("setup-main", { message: "m".repeat(70_000) });
    f.ledger.append("setup.job.saved", {
      job: { ...job("setup-other-large"), message: "z".repeat(80_000) },
    });
    let previousCount = 0;
    for (const count of [20, 200]) {
      for (let i = previousCount; i < count; i++)
        f.ledger.append("setup.job.saved", { job: job(`setup-other-${i}`) });
      previousCount = count;
      const read = vi.spyOn(f.blobs, "read");
      const saved = f.api.events("setup-main", snapshot.cursor);
      expect(saved).toHaveLength(1);
      expect(saved[0]!.previousCursor).toBe(snapshot.cursor);
      expect(saved[0]!.sequence).toBe(snapshot.sequence + 2);
      expect(saved[0]!.message).toHaveLength(70_000);
      expect(read).toHaveBeenCalledTimes(1);
      read.mockRestore();
      const plan = f.store
        .prepare(
          "EXPLAIN QUERY PLAN SELECT seq,time,type,payload,payload_sha FROM event INDEXED BY event_group WHERE pid=? AND group_key=? AND seq>? AND type='setup.job.saved' ORDER BY seq",
        )
        .all(f.generation.pid, "s:setup-main:saved", 0) as Array<{ detail: string }>;
      expect(plan.some((row) => /SEARCH event USING INDEX event_group/.test(row.detail))).toBe(
        true,
      );
    }
    expect(f.api.snapshot("setup-main").sequence).toBeGreaterThan(
      f.api.events("setup-main").at(-1)!.sequence,
    );
  });

  it("keeps stateful semantic recovery and refuses old global generations", async () => {
    const f = await fixture();
    f.api.create(job("setup-main"));
    f.ledger.append("setup.job.saved", { job: { ...job("setup-main"), harness: "claude" } });
    const invalid = new SqlSetupJobStore(f.dataRoot, f.store, f.ledger);
    expect(invalid.recoveryState()).toMatchObject({
      status: "recovery_required",
      location: { kind: "cursor", epoch: f.generation.epoch, seq: 2 },
    });
    expect(() => invalid.update("setup-main", { message: "must not save" })).toThrow(
      /requires recovery/,
    );
    f.store.transaction(() =>
      f.store.prepare("UPDATE partition SET status='quarantined' WHERE id=?").run(f.generation.pid),
    );
    expect(() => f.api.create(job("setup-late"))).toThrow(/requires recovery/);
  });

  it("keeps a missing create-bound SQL row in the typed semantic recovery plane", async () => {
    const f = await fixture();
    f.api.create(job("setup-main"));
    const event = f.ledger.append("setup.job.create_bound", {
      binding: {
        keyDigest: hashJson({ key: "opaque" }),
        requestDigest: hashJson({ request: "opaque" }),
        jobId: "setup-main",
      },
    });
    expect(() => new SqlSetupJobStore(f.dataRoot, f.store, f.ledger)).toThrow(
      expect.objectContaining({
        code: "journal_recovery_required",
        recovery: expect.objectContaining({
          location: { kind: "cursor", epoch: event.epoch, seq: event.seq },
        }),
      }),
    );
  });

  it("rebinds one setup supervisor to the new SQL global generation", async () => {
    const f = await fixture();
    const key = { key: "request", client: "fixture", request: {} };
    f.api.create(job("setup-old"), key);
    let current = f.api;
    let generation = 1;
    const calls: string[] = [];
    const lifecycle = new SetupLifecycleBinding(
      { current: () => current, generation: () => generation },
      (api) => {
        const bound = generation;
        return {
          start: async () => {
            api.validateProjection();
            calls.push(`start-${bound}`);
          },
          list: (filter: { active: boolean }) => api.list(filter),
          beginDrain: () => {
            calls.push(`drain-${bound}`);
          },
          shutdown: async () => {
            calls.push(`stop-${bound}`);
          },
        };
      },
    );
    await lifecycle.start();
    await lifecycle.start();
    await lifecycle.replaceAfter(() => {
      f.store.transaction(() => {
        f.store
          .prepare("UPDATE partition SET status='quarantined' WHERE id=?")
          .run(f.generation.pid);
        const next = f.store
          .prepare(
            "INSERT INTO partition(name,epoch,status,next_seq,created_at) VALUES('global',?,'ready',1,?)",
          )
          .run("new-epoch", TIME);
        f.store
          .prepare("UPDATE meta SET value=? WHERE key='global_pid'")
          .run(String(next.lastInsertRowid));
      });
      current = new SqlSetupJobStore(
        f.dataRoot,
        f.store,
        new SqlEventLedger(f.store, f.blobs, currentGeneration(f.store, "global")!),
      );
      generation++;
    });
    await lifecycle.start();
    expect(calls).toEqual(["start-1", "drain-1", "stop-1", "start-2"]);
    expect(current.resolveCreate(key)).toBeNull();
    expect(() => f.api.resolveCreate(key)).toThrow(/requires recovery/);
    current.create(job("setup-new"), key);
    expect(current.resolveCreate(key)?.jobId).toBe("setup-new");
    expect(
      f.store.prepare("SELECT DISTINCT pid FROM idempotency WHERE owner='setup'").all(),
    ).toHaveLength(2);
    await lifecycle.shutdown();
    expect(calls.slice(-2)).toEqual(["drain-2", "stop-2"]);
  });
});
