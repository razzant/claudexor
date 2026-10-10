import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ModelCallRequest, type ModelPayloadRef } from "@claudexor/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelOperations } from "../model-operations.js";
import { setGlobalGenerationInTx } from "./generations.js";
import { createPartition } from "./partitions.js";
import { readResourceRow } from "./resource-rows.js";
import { createSqlDaemonServices } from "./sql-daemon-services.js";
import { EngineStore } from "./store.js";

const READY = "2026-01-01T00:00:00.000Z";
const EXPIRES = "2026-01-31T00:00:00.000Z";
const LATE = "2026-04-01T00:00:00.000Z";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cx-model-expiry-"));
  let clock = READY;
  let nextId = 0;
  let store: EngineStore;
  let graph: ReturnType<typeof createSqlDaemonServices>;
  let operations: ModelOperations;
  const resolveModel = vi.fn(async () => {
    throw new Error("provider calls are forbidden in custody reconciliation");
  });
  const enqueue = vi.fn(async (envelope) => ({
    id: graph.commands.current().accept({
      id: `model-${++nextId}`,
      params: envelope.request,
      operation: envelope.operation,
      idempotencyKey: envelope.idempotencyKey,
      clientId: envelope.clientId,
      idempotencyParams: envelope.idempotencyRequest,
    }).record.id,
  }));
  const open = async () => {
    store = await EngineStore.open({
      daemonDir: root,
      now: () => new Date(clock),
      workerEntry: resolve(import.meta.dirname, "../../dist/store/flusher-worker.js"),
    });
    if (!store.prepare("SELECT id FROM partition WHERE name='global'").get()) {
      store.transaction(() => setGlobalGenerationInTx(store, createPartition(store, "global").pid));
    }
    graph = createSqlDaemonServices(store, { purgeFiles: async () => [root] });
    operations = new ModelOperations({
      commands: graph.commands,
      resourceQueries: graph.commands.queries,
      resources: () => graph.resources,
      enqueue,
      cancel: async () => undefined,
      resolve: resolveModel,
      now: () => new Date(clock),
    });
  };
  const close = async () => {
    operations.close();
    await graph.close();
    await store.close();
  };
  await open();
  cleanups.push(async () => {
    await close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    get graph() {
      return graph;
    },
    get operations() {
      return operations;
    },
    enqueue,
    resolveModel,
    setNow(value: string) {
      clock = value;
    },
    async reopen() {
      await close();
      await open();
    },
    async completed(key: string, response?: ModelPayloadRef, expiresAt = EXPIRES) {
      const request = graph.resources.publishModel(
        Buffer.from(
          JSON.stringify(
            ModelCallRequest.parse({
              source: "codex",
              model: "fixture",
              account: { mode: "pin", profileId: "fixture" },
              messages: [{ role: "user", content: key }],
            }),
          ),
        ),
      );
      const detail = await operations.create(request, key);
      response ??= graph.resources.publishModel(Buffer.from('{"answer":"done"}'));
      const readyAt = new Date(Date.parse(expiresAt) - 30 * 24 * 60 * 60 * 1000).toISOString();
      graph.commands.current().update(detail.id, {
        state: "succeeded",
        finishedAt: readyAt,
        result: {
          lifecycle: "succeeded",
          dispatch: { state: "not_started", startedAt: null, route: null },
          response: { state: "ready", ref: response, readyAt, expiresAt },
          usage: {},
          cost: null,
          problem: null,
        },
      });
      return { id: detail.id, request, response, key };
    },
    bindings(ref: ModelPayloadRef) {
      return Number(
        (
          store
            .prepare(
              `SELECT count(*) AS n FROM idempotency i JOIN upload u
        ON u.id=i.target_id WHERE i.owner='upload'
        AND json_extract(CAST(u.body AS TEXT),'$.resourceId')=?`,
            )
            .get(ref.resourceId) as { n: number }
        ).n,
      );
    },
  };
}

describe("model response expiry through the SQL composition", () => {
  it("retains the known expiry after a long offline period and frees only its old upload bindings", async () => {
    const f = await fixture(),
      op = await f.completed("late-expiry");
    f.setNow(LATE);
    expect(f.operations.reconcileResources(true).released).toContain(op.response.resourceId);
    expect(readResourceRow(f.store, op.response.resourceId)?.state).toBe("ready");
    expect(f.operations.reconcileResources().errors).toEqual([]);
    expect(f.operations.inspect(op.id).response).toMatchObject({
      state: "expired",
      releasedAt: EXPIRES,
    });
    expect(readResourceRow(f.store, op.response.resourceId)).toMatchObject({
      state: "expired",
      releasedAt: EXPIRES,
      expiresAt: EXPIRES,
    });
    expect(readResourceRow(f.store, op.request.resourceId)).toMatchObject({
      state: "released",
      releasedAt: LATE,
      expiresAt: null,
    });
    expect(f.graph.resources.pruneUploadBindings()).toBe(2);
    expect(f.bindings(op.response)).toBe(0);
    expect(f.bindings(op.request)).toBe(2);
    expect((await f.operations.create(op.request, op.key)).id).toBe(op.id);
    expect(f.enqueue).toHaveBeenCalledOnce();
    expect(f.resolveModel).not.toHaveBeenCalled();
  });

  it("retries failed expiry after reopen using the persisted receipt date", async () => {
    const f = await fixture(),
      op = await f.completed("retry-expiry");
    f.setNow(LATE);
    vi.spyOn(f.graph.resources, "expireModel").mockImplementationOnce(() => {
      throw new Error("expiry metadata unavailable");
    });
    expect(f.operations.reconcileResources().errors).toEqual([
      "Error: expiry metadata unavailable",
    ]);
    expect(f.operations.inspect(op.id).response).toMatchObject({
      state: "expired",
      releasedAt: EXPIRES,
    });
    expect(readResourceRow(f.store, op.response.resourceId)?.state).toBe("ready");
    await f.reopen();
    expect(f.graph.commands.queries.expiredResponses(LATE)).toEqual([]);
    expect(f.operations.reconcileResources().errors).toEqual([]);
    expect(readResourceRow(f.store, op.response.resourceId)).toMatchObject({
      state: "expired",
      releasedAt: EXPIRES,
      expiresAt: EXPIRES,
    });
    expect(f.graph.resources.pruneUploadBindings()).toBe(2);
    expect(f.operations.reconcileResources().released).toEqual([]);
    expect(f.resolveModel).not.toHaveBeenCalled();
  });

  it.each(["2026-01-15T00:00:00.000Z", LATE])(
    "ACK at %s preserves ordinary release or known expiry",
    async (now) => {
      const f = await fixture(),
        op = await f.completed("ack");
      f.setNow(now);
      const expired = now === LATE;
      expect(f.operations.acknowledge(op.id, op.response.sha256).response).toMatchObject({
        state: expired ? "expired" : "acknowledged",
        releasedAt: expired ? EXPIRES : now,
      });
      expect(readResourceRow(f.store, op.response.resourceId)).toMatchObject({
        state: expired ? "expired" : "released",
        releasedAt: expired ? EXPIRES : now,
        expiresAt: expired ? EXPIRES : null,
      });
      expect(f.graph.resources.pruneUploadBindings()).toBe(expired ? 2 : 0);
      expect(f.operations.acknowledge(op.id, op.response.sha256).response.state).toBe(
        expired ? "expired" : "acknowledged",
      );
    },
  );

  it("keeps another live response owner and releases at the last known expiry", async () => {
    const f = await fixture(),
      first = await f.completed("first-owner");
    const laterExpiry = "2026-05-01T00:00:00.000Z";
    f.setNow(LATE);
    const second = await f.completed("second-owner", first.response, laterExpiry);
    // Another resource with the same bytes independently owns the physical blob.
    const sibling = f.graph.resources.publishModel(Buffer.from('{"answer":"done"}'));
    f.setNow(LATE);
    expect(f.operations.reconcileResources().errors).toEqual([]);
    expect(f.operations.inspect(first.id).response.state).toBe("expired");
    expect(f.operations.inspect(second.id).response.state).toBe("ready");
    expect(f.graph.resources.readModel(first.response).toString()).toBe('{"answer":"done"}');
    expect(readResourceRow(f.store, first.response.resourceId)?.state).toBe("ready");
    expect(f.bindings(first.response)).toBe(2);
    f.setNow("2026-07-01T00:00:00.000Z");
    expect(f.operations.reconcileResources().errors).toEqual([]);
    expect(readResourceRow(f.store, first.response.resourceId)).toMatchObject({
      state: "expired",
      releasedAt: laterExpiry,
      expiresAt: laterExpiry,
    });
    expect(f.graph.resources.pruneUploadBindings()).toBe(6); // two requests plus the response
    await f.graph.resources.drainCleanup();
    expect(f.graph.resources.readModel(sibling).toString()).toBe('{"answer":"done"}');
  });
});
