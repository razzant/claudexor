import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ModelAdapter } from "@claudexor/core";
import {
  CredentialProfile,
  ImageCallRequest,
  ImageCallResult,
  ModelOperationParams,
  type ModelOperationReceipt,
  type ModelPayloadRef,
} from "@claudexor/schema";
import { describe, expect, it, vi } from "vitest";
import { createCodexModelAdapter } from "../../../harness-codex/src/model.js";
import { commandDigests } from "../command-store.js";
import { ModelOperations, type ModelOperationDependencies } from "../model-operations.js";
import { BlobFiles } from "./blob-files.js";
import { SqlCommandPruner } from "./command-prune.js";
import { SqlCommandQueries } from "./command-queries.js";
import { commandRow, hydrateCommand } from "./command-rows.js";
import { SqlCommandStore } from "./commands.js";
import { lookupIdempotency } from "./idempotency.js";
import { ImportContext } from "./import-context.js";
import { runLegacyImport } from "./importer.js";
import { Obligations } from "./obligations.js";
import { createPartition, currentGeneration } from "./partitions.js";
import { readResourceRow } from "./resource-rows.js";
import { SqlResourceStore } from "./resources.js";
import { EngineStore } from "./store.js";
import { SqlTerminalFiles } from "./terminal-files.js";
import { CommandStore as LegacyCommandStore } from "./test-support/fixtures/legacy/daemon/command-store.js";
import {
  DurableJournal,
  journalPartitionDirectory,
} from "./test-support/fixtures/legacy/journal/index.js";
import { builtWorker, chunks } from "./test-support/resource-fixture.js";
import { afterEachClosed } from "../../../cli/src/test-support/after-each-closed.js";

/** Image operations through the real SQL owners: command store, addressed
 * custody queries, upload/resource store and the flush barrier. The provider is
 * the real Codex image facet over a synthetic fetch and managed-auth file; no
 * login, credential, network or provider call is involved. */

const NOW = "2026-10-10T00:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70]);
const sha = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const generation = (prompt = "a red fox") =>
  ImageCallRequest.parse({
    source: "codex",
    model: "gpt-image-2",
    account: { mode: "pin", profileId: "fixture" },
    prompt,
  });
const item = (bytes: Buffer, generationId?: string) => ({
  b64_json: bytes.toString("base64"),
  ...(generationId ? { generation_id: generationId } : {}),
});
const imageResponse = (data: unknown[], extra: Record<string, unknown> = {}) =>
  Response.json({ data, usage: { input_tokens: 11, output_tokens: 7 }, ...extra });

const cleanup: Array<() => unknown> = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0).reverse();
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});

function privateRoot(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cx-img-")));
  removals.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** One daemon life. Reopening the same root is a restart: only committed rows
 * and published files survive it. */
async function daemonLife(root: string, clock: { now: Date }, manualTick = false) {
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: builtWorker("flusher-worker.js"),
    flusherHooks: { manualTick, allowExit: true },
    now: () => clock.now,
  });
  const partition =
    currentGeneration(store, "global") ?? store.transaction(() => createPartition(store, "global"));
  const blobs = new BlobFiles(store);
  const logs: string[] = [];
  let resources!: SqlResourceStore;
  const obligations = new Obligations(store, {
    log: (line) => logs.push(line),
    onCleared: (rows) => resources.onObligationsCleared(rows),
  });
  resources = new SqlResourceStore(store, blobs, obligations, (line) => logs.push(line));
  const commands = new SqlCommandStore(store, blobs, partition, {
    isLive: () => true,
    obligations,
    terminalFiles: new SqlTerminalFiles(store, obligations),
    pruner: new SqlCommandPruner(store, blobs),
  });
  let closing: Promise<void> | undefined;
  /** One close: a later caller gets its outcome, not a success it never saw (#376). */
  const close = () =>
    (closing ??= (async () => {
      obligations.close();
      await store.close();
      await resources.drainCleanup();
    })());
  cleanup.push(close);
  return {
    store,
    resources,
    commands,
    obligations,
    logs,
    queries: new SqlCommandQueries(store, blobs),
    close,
  };
}
type Life = Awaited<ReturnType<typeof daemonLife>>;

/** The real Codex image facet; only fetch and the managed auth file are synthetic. */
function provider(respond: () => Response | Promise<Response> = () => imageResponse([item(PNG)])) {
  const posts: Array<{ url: string; body: Record<string, unknown>; turnId: string | null }> = [];
  const hooks: { afterPost?: () => void | Promise<void> } = {};
  const adapter = createCodexModelAdapter({
    now: () => Date.parse(NOW),
    readAuthFile: async () =>
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          account_id: "fixture-account",
          access_token: `fixture.${Buffer.from(JSON.stringify({ exp: 2100000000 })).toString("base64url")}.signature`,
        },
      }),
    fetch: async (url, init) => {
      expect(init?.method).toBe("POST");
      const body = JSON.parse(await new Response(init!.body).text()) as Record<string, unknown>;
      posts.push({
        url: String(url),
        body,
        turnId: new Headers(init!.headers).get("x-codex-image-turn-id"),
      });
      await hooks.afterPost?.();
      return respond();
    },
  });
  return { adapter, posts, hooks };
}

function operations(life: Life, clock: { now: Date }, adapter: ModelAdapter | null) {
  const resolveImage = vi.fn(async () => {
    if (!adapter) throw new Error("this daemon life may not call an image provider");
    return {
      adapter,
      profile: CredentialProfile.parse({
        profile_id: "fixture",
        harness_id: "codex",
        display_name: "Fixture",
        credential_kind: "config_dir_login",
        isolation_locator: join(process.env.CLAUDEXOR_CONFIG_DIR!, "profiles", "fixture"),
      }),
    };
  });
  const enqueue = vi.fn(async (envelope: Parameters<ModelOperationDependencies["enqueue"]>[0]) => ({
    id: life.commands.accept({
      id: `image-${randomUUID()}`,
      params: envelope.request,
      idempotencyParams: envelope.idempotencyRequest,
      idempotencyKey: envelope.idempotencyKey,
      clientId: envelope.clientId,
      operation: envelope.operation,
    }).record.id,
  }));
  const ops = new ModelOperations({
    commands: {
      current: () => life.commands,
      findById: (id) => (life.commands.get(id) ? life.commands : undefined),
    },
    resourceQueries: life.queries,
    resources: () => life.resources,
    now: () => clock.now,
    enqueue,
    cancel: async () => undefined,
    resolve: async () => {
      throw new Error("the text provider is not part of these cases");
    },
    resolveImage,
  });
  cleanup.push(() => ops.close());
  return { ops, resolveImage, enqueue };
}

/** A caller's model-purpose upload through the real SQL upload/finalize path. */
async function upload(life: Life, body: unknown): Promise<ModelPayloadRef> {
  const bytes = Buffer.from(JSON.stringify(body));
  const key = randomUUID();
  const status = life.resources.create(
    {
      purpose: "model",
      kind: "file",
      mime: "application/json",
      name: "image-request.json",
      sizeBytes: bytes.length,
    },
    `${key}-create`,
  );
  await life.resources.write(status.uploadId, chunks(bytes));
  const resource = life.resources.finalize(status.uploadId, sha(bytes), `${key}-finalize`);
  return {
    resourceId: resource.resourceId,
    sha256: resource.sha256,
    sizeBytes: resource.sizeBytes,
  };
}

/** DaemonServer's terminal boundary: one terminal update, then the terminal hook. */
function settle(life: Life, ops: ModelOperations, id: string, receipt: ModelOperationReceipt) {
  const record = life.commands.update(id, {
    state: receipt.lifecycle,
    result: receipt,
    finishedAt: life.store.now().toISOString(),
  });
  ops.onCommandTerminal(record);
}

function start(life: Life, ops: ModelOperations, id: string, signal: AbortSignal) {
  life.commands.update(id, { state: "running", startedAt: life.store.now().toISOString() });
  return ops.execute(life.commands.get(id)!.params, {
    jobId: id,
    signal,
    onRunStart: () => undefined,
  });
}

async function run(life: Life, ops: ModelOperations, id: string) {
  const receipt = await start(life, ops, id, new AbortController().signal);
  settle(life, ops, id, receipt);
  return receipt;
}

function pass(store: EngineStore): Promise<void> {
  return new Promise((resolve) => {
    const off = store.onSynced(() => {
      off();
      resolve();
    });
    store.flusherControl.tick();
  });
}

const readyRef = (receipt: ModelOperationReceipt): ModelPayloadRef => {
  if (receipt.response.state !== "ready") throw new Error("expected a ready image result");
  return receipt.response.ref;
};

describe("image dispatch waits for the SQL flush barrier", () => {
  it.each(["success", "worker_exit", "cancel_before_dispatch", "cancel_after_dispatch"] as const)(
    "the real Codex image facet posts only after a proved barrier (%s)",
    async (mode) => {
      const clock = { now: new Date(NOW) };
      const life = await daemonLife(privateRoot(), clock, true);
      const abort = new AbortController();
      const p = provider();
      if (mode === "cancel_after_dispatch")
        p.hooks.afterPost = () => {
          abort.abort(new Error("cancel after the physical POST"));
          throw abort.signal.reason;
        };
      const { ops, enqueue } = operations(life, clock, p.adapter);
      const ref = await upload(life, generation());
      await pass(life.store); // publication effects of the caller's upload
      const created = await ops.create(ref, "q2-image", undefined, undefined, "image");
      const waiters = life.store.facts().flusher.pending_waiters;
      let early: unknown;
      const executing = start(life, ops, created.id, abort.signal).then((value) => {
        early = value;
        return value;
      });
      await vi.waitFor(() =>
        expect(life.store.facts().flusher.pending_waiters, JSON.stringify(early)).toBe(waiters + 1),
      );
      expect(p.posts).toHaveLength(0);
      // The attempted send is committed before the barrier is proved.
      expect(ops.inspect(created.id).dispatch).toMatchObject({
        state: "started",
        startedAt: NOW,
        route: { source: "codex", credentialProfileId: "fixture", model: null },
      });
      if (mode === "worker_exit") life.store.flusherControl.requestExit(17);
      else {
        if (mode === "cancel_before_dispatch") abort.abort(new Error("cancel during the flush"));
        await pass(life.store);
      }
      const receipt = await executing;
      settle(life, ops, created.id, receipt);
      const sent = mode === "success" || mode === "cancel_after_dispatch";
      expect(p.posts).toHaveLength(sent ? 1 : 0);
      if (mode === "success") {
        expect(receipt).toMatchObject({
          lifecycle: "succeeded",
          dispatch: { state: "response_received", startedAt: NOW },
          usage: { input_tokens: 11, output_tokens: 7 },
          cost: { knowledge: "unknown", cashUsd: null },
          problem: null,
        });
        const stored = ops.readResult(created.id);
        expect(stored.sha256).toBe(readyRef(receipt).sha256);
        const result = ImageCallResult.parse(JSON.parse(stored.bytes.toString()));
        expect(result.images.map((image) => [image.mime, image.sha256, image.dataBase64])).toEqual([
          ["image/png", sha(PNG), PNG.toString("base64")],
        ]);
        expect(p.posts[0]!.turnId).toBe(`img-${created.id}`);
      } else if (mode === "worker_exit") {
        expect(receipt).toMatchObject({
          lifecycle: "failed",
          dispatch: { state: "not_started", startedAt: NOW, route: { model: null } },
          response: { state: "absent" },
          problem: { code: "store_flush_unavailable", retryable: true },
        });
      } else {
        expect(receipt).toMatchObject({
          lifecycle: "cancelled",
          dispatch: {
            state: sent ? "unknown" : "not_started",
            startedAt: NOW,
            route: { credentialProfileId: "fixture" },
          },
        });
        if (!sent) {
          // The facet's own pre-dispatch refusal is the only document: no image exists without a POST.
          const result = ImageCallResult.parse(
            JSON.parse(ops.readResult(created.id).bytes.toString()),
          );
          expect(result).toMatchObject({ outcome: "failed", images: [] });
          expect(result.problem?.code).toBe("cancelled");
        }
      }
      // The durable receipt says the same after the terminal update.
      expect(ops.inspect(created.id)).toMatchObject({
        state: receipt.lifecycle,
        dispatch: receipt.dispatch,
        response: { state: receipt.response.state },
      });
      expect(readResourceRow(life.store, ref.resourceId)?.state).toBe("released");
      const flush = vi.spyOn(life.commands, "flushed");
      const replay = await ops.create(ref, "q2-image", undefined, undefined, "image");
      expect(replay.id).toBe(created.id);
      expect(enqueue).toHaveBeenCalledOnce();
      expect(flush).not.toHaveBeenCalled();
      expect(p.posts).toHaveLength(sent ? 1 : 0);
    },
  );
});

describe("image custody through the SQL owners", () => {
  it("forwards the caller's original edit bytes exactly and publishes the edit result", async () => {
    const clock = { now: new Date(NOW) };
    const life = await daemonLife(privateRoot(), clock);
    const p = provider(() => imageResponse([item(PNG, "edit-1")], { quality: "high" }));
    const { ops } = operations(life, clock, p.adapter);
    // Valid signature plus trailing bytes that any decode/re-encode would normalize away.
    const original = Buffer.concat([PNG, Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f, 0x01])]);
    const request = ImageCallRequest.parse({
      ...generation("make it blue"),
      images: [
        { mime: "image/png", sha256: sha(original), dataBase64: original.toString("base64") },
      ],
    });
    const ref = await upload(life, request);
    expect(life.resources.readModel(ref).equals(Buffer.from(JSON.stringify(request)))).toBe(true);
    const created = await ops.create(ref, "edit-bytes", undefined, undefined, "image");
    expect(ModelOperationParams.parse(life.commands.get(created.id)!.params)).toEqual({
      kind: "model",
      request: ref,
      requestKind: "image",
    });
    const receipt = await run(life, ops, created.id);
    expect(receipt).toMatchObject({
      lifecycle: "succeeded",
      dispatch: { state: "response_received" },
    });
    expect(p.posts).toHaveLength(1);
    expect(p.posts[0]!.url).toMatch(/\/images\/edits$/);
    const sent = (p.posts[0]!.body.images as Array<{ image_url: string }>).map(
      (image) => image.image_url,
    );
    expect(sent).toEqual([`data:image/png;base64,${original.toString("base64")}`]);
    expect(Buffer.from(sent[0]!.split(",")[1]!, "base64").equals(original)).toBe(true);
    const result = ImageCallResult.parse(JSON.parse(ops.readResult(created.id).bytes.toString()));
    expect(result).toMatchObject({
      outcome: "completed",
      operation: "edit",
      requestedModel: "gpt-image-2",
      appliedOptions: { quality: "high" },
      route: { model: null },
    });
    expect(readResourceRow(life.store, ref.resourceId)?.state).toBe("released");
    expect(life.logs).toEqual([]);
  });

  it("keeps usable and rejected siblings across a restart and releases only on the whole-result digest", async () => {
    const root = privateRoot();
    const clock = { now: new Date(NOW) };
    const first = await daemonLife(root, clock);
    const p = provider(() =>
      imageResponse([item(PNG, "first"), { b64_json: "@@@@" }, null, item(JPEG, "last")], {
        quality: "medium",
      }),
    );
    const live = operations(first, clock, p.adapter);
    const ref = await upload(first, generation());
    const created = await live.ops.create(ref, "siblings", undefined, undefined, "image");
    const receipt = await run(first, live.ops, created.id);
    expect(receipt).toMatchObject({
      lifecycle: "failed",
      dispatch: { state: "response_received" },
      response: { state: "ready" },
      usage: { input_tokens: 11, output_tokens: 7 },
      problem: { code: "response_rejected", context: { rejectedIndexes: [1, 2] } },
    });
    const stored = live.ops.readResult(created.id);
    // The caller has not stored its files yet when this daemon life ends.
    await first.close();

    const second = await daemonLife(root, clock);
    expect((await second.obligations.completeOpen()).failed).toEqual([]);
    second.commands.recoverAfterStartup();
    const reopened = operations(second, clock, null);
    const reread = reopened.ops.readResult(created.id);
    expect(reread.sha256).toBe(stored.sha256);
    expect(reread.bytes.equals(stored.bytes)).toBe(true);
    const result = ImageCallResult.parse(JSON.parse(reread.bytes.toString()));
    expect(result).toMatchObject({
      outcome: "completed",
      appliedOptions: { quality: "medium" },
      usage: { input_tokens: 11, output_tokens: 7 },
      problem: { code: "response_rejected", context: { rejectedIndexes: [1, 2] } },
    });
    expect(result.images.map((image) => [image.generationId, image.mime, image.sha256])).toEqual([
      ["first", "image/png", sha(PNG)],
      ["last", "image/jpeg", sha(JPEG)],
    ]);
    expect(result.images.map((image) => image.dataBase64)).toEqual([
      PNG.toString("base64"),
      JPEG.toString("base64"),
    ]);
    // One image's digest is not the received result; the bytes stay retrievable.
    expect(() => reopened.ops.acknowledge(created.id, result.images[0]!.sha256)).toThrow(
      expect.objectContaining({ code: "model_result_digest_mismatch" }),
    );
    expect(reopened.ops.readResult(created.id).bytes.equals(stored.bytes)).toBe(true);
    expect(reopened.ops.acknowledge(created.id, stored.sha256).response).toMatchObject({
      state: "acknowledged",
      releasedAt: NOW,
    });
    expect(readResourceRow(second.store, readyRef(receipt).resourceId)?.state).toBe("released");
    expect(() => reopened.ops.readResult(created.id)).toThrow(/acknowledged or expired/);
    const replay = await reopened.ops.create(ref, "siblings", undefined, undefined, "image");
    expect(replay).toMatchObject({ id: created.id, response: { state: "acknowledged" } });
    expect(reopened.enqueue).not.toHaveBeenCalled();
    expect(reopened.resolveImage).not.toHaveBeenCalled();
    expect(p.posts).toHaveLength(1);
  });

  it("recovers a send interrupted by a daemon crash as unknown without another provider call", async () => {
    const root = privateRoot();
    const clock = { now: new Date(NOW) };
    const first = await daemonLife(root, clock);
    let posted!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      posted = resolve;
    });
    const daemonProcess = new AbortController();
    const p = provider(
      () =>
        new Promise<Response>((_resolve, reject) =>
          daemonProcess.signal.addEventListener("abort", () => reject(daemonProcess.signal.reason)),
        ),
    );
    p.hooks.afterPost = () => posted();
    const live = operations(first, clock, p.adapter);
    const ref = await upload(first, generation());
    const created = await live.ops.create(ref, "crash", undefined, undefined, "image");
    const orphan = start(first, live.ops, created.id, daemonProcess.signal);
    await inFlight;
    expect(live.ops.inspect(created.id).dispatch.state).toBe("started");
    // The daemon dies while the provider call is outstanding: no terminal is written.
    live.ops.close();
    await first.close();
    daemonProcess.abort(new Error("process ended"));
    await orphan;

    const second = await daemonLife(root, clock);
    expect((await second.obligations.completeOpen()).failed).toEqual([]);
    second.commands.recoverAfterStartup();
    const reopened = operations(second, clock, null);
    expect(reopened.ops.inspect(created.id)).toMatchObject({
      state: "interrupted",
      dispatch: { state: "unknown", startedAt: NOW },
      response: { state: "absent" },
      problem: { code: "model_operation_interrupted" },
    });
    expect((await reopened.ops.create(ref, "crash", undefined, undefined, "image")).id).toBe(
      created.id,
    );
    // The terminal command's input is now crash residue for the existing reconciliation.
    expect(reopened.ops.reconcileResources().released).toContain(ref.resourceId);
    expect(readResourceRow(second.store, ref.resourceId)?.state).toBe("released");
    expect(reopened.enqueue).not.toHaveBeenCalled();
    expect(reopened.resolveImage).not.toHaveBeenCalled();
    expect(p.posts).toHaveLength(1);
  });

  it("rejoins a running image by key and bytes and refuses another kind or payload under that key", async () => {
    const clock = { now: new Date(NOW) };
    const life = await daemonLife(privateRoot(), clock);
    let answer!: () => void;
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const p = provider(async () => {
      await held;
      return imageResponse([item(PNG)]);
    });
    const { ops, enqueue } = operations(life, clock, p.adapter);
    const first = await upload(life, generation());
    const created = await ops.create(first, "rejoin", undefined, undefined, "image");
    const executing = start(life, ops, created.id, new AbortController().signal);
    // The POST follows the dispatch barrier (one flusher pass, much slower
    // under disk contention, #441); a 1 s window is not part of the contract.
    await vi.waitFor(() => expect(p.posts).toHaveLength(1), { timeout: 10_000 });
    // A caller that lost the reply uploads identical bytes again and retries its key.
    const copy = await upload(life, generation());
    expect(copy.resourceId).not.toBe(first.resourceId);
    expect((await ops.create(copy, "rejoin", undefined, undefined, "image")).id).toBe(created.id);
    expect(readResourceRow(life.store, copy.resourceId)?.state).toBe("released");
    expect(readResourceRow(life.store, first.resourceId)?.state).toBe("ready");
    await expect(ops.create(await upload(life, generation()), "rejoin")).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    await expect(
      ops.create(
        await upload(life, generation("another fox")),
        "rejoin",
        undefined,
        undefined,
        "image",
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    answer();
    settle(life, ops, created.id, await executing);
    expect(ops.inspect(created.id).state).toBe("succeeded");
    expect(
      (await ops.create(await upload(life, generation()), "rejoin", undefined, undefined, "image"))
        .id,
    ).toBe(created.id);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(p.posts).toHaveLength(1);
  });

  it("expires an image result at its recorded instant, retries a failed expiry after restart and never regenerates", async () => {
    const root = privateRoot();
    const clock = { now: new Date(NOW) };
    const first = await daemonLife(root, clock);
    const p = provider();
    const live = operations(first, clock, p.adapter);
    const ref = await upload(first, generation());
    const created = await live.ops.create(ref, "expiry", undefined, undefined, "image");
    const receipt = await run(first, live.ops, created.id);
    const response = readyRef(receipt);
    const expiresAt = new Date(Date.parse(NOW) + 30 * DAY).toISOString();
    expect(receipt.response).toMatchObject({ state: "ready", readyAt: NOW, expiresAt });
    expect(first.queries.nextResponseExpiry()).toBe(expiresAt);
    clock.now = new Date(Date.parse(expiresAt) + 60 * DAY); // a long offline period
    vi.spyOn(first.resources, "expireModel").mockImplementationOnce(() => {
      throw new Error("expiry metadata unavailable");
    });
    expect(live.ops.reconcileResources().errors).toEqual(["Error: expiry metadata unavailable"]);
    expect(live.ops.inspect(created.id).response).toMatchObject({
      state: "expired",
      releasedAt: expiresAt,
    });
    expect(readResourceRow(first.store, response.resourceId)?.state).toBe("ready");
    live.ops.close();
    await first.close();

    const second = await daemonLife(root, clock);
    expect((await second.obligations.completeOpen()).failed).toEqual([]);
    const reopened = operations(second, clock, null);
    expect(second.queries.expiredResponses(clock.now.toISOString())).toEqual([]);
    expect(reopened.ops.reconcileResources().errors).toEqual([]);
    expect(readResourceRow(second.store, response.resourceId)).toMatchObject({
      state: "expired",
      releasedAt: expiresAt,
      expiresAt,
    });
    expect(() => reopened.ops.readResult(created.id)).toThrow(
      expect.objectContaining({ code: "model_result_released" }),
    );
    expect(await reopened.ops.create(ref, "expiry", undefined, undefined, "image")).toMatchObject({
      id: created.id,
      response: { state: "expired", releasedAt: expiresAt },
    });
    expect(reopened.enqueue).not.toHaveBeenCalled();
    expect(reopened.resolveImage).not.toHaveBeenCalled();
    expect(p.posts).toHaveLength(1);
  });
});

describe("image requestKind across the one-time legacy import", () => {
  it("keeps the stored kind and its same-key identity exactly", async () => {
    const root = privateRoot();
    const journalRoot = join(root, "journal");
    mkdirSync(journalRoot);
    const ref = {
      resourceId: "res_legacy_image",
      sha256: sha(Buffer.from("legacy image request")),
      sizeBytes: 20,
    };
    const params = { kind: "model", request: ref, requestKind: "image" };
    const identity = { kind: "model", sha256: ref.sha256, sizeBytes: ref.sizeBytes };
    const envelope = {
      params,
      idempotencyKey: "legacy-image",
      clientId: "control-api",
      operation: "model.operation.create",
      idempotencyParams: { ...identity, requestKind: "image" },
    };
    // A pre-SQL image command written by the frozen journal-era command store.
    const journal = new DurableJournal({
      rootDir: journalRoot,
      partition: "global",
      now: () => new Date(NOW),
      epochFactory: () => "epoch-global",
      deferCompaction: true,
    });
    try {
      new LegacyCommandStore(journal, () => new Date(NOW)).accept({
        id: "legacy-image-op",
        ...envelope,
      });
    } finally {
      journal.close();
    }
    const options = {
      databasePath: join(root, "engine.sqlite.import"),
      journalRoot,
      resourceStoreDir: join(root, "resource-store"),
      partitions: [{ name: "global", directory: journalPartitionDirectory(journalRoot, "global") }],
      now: () => new Date(NOW),
    };
    expect((await runLegacyImport(options)).unclassified).toBe(0);
    const db = new DatabaseSync(options.databasePath, { readOnly: true });
    try {
      const sql = new ImportContext(db, join(options.resourceStoreDir, "blobs"));
      const row = commandRow(sql, "legacy-image-op")!;
      expect(row).toMatchObject({ kind: "model", request_resource_id: ref.resourceId });
      expect(ModelOperationParams.parse(hydrateCommand(row, sql).params)).toEqual(params);
      const image = commandDigests("global", envelope);
      const text = commandDigests("global", { ...envelope, idempotencyParams: identity });
      expect(text.keyDigest).toBe(image.keyDigest);
      const key = { owner: "command" as const, pid: row.pid, keyDigest: image.keyDigest };
      expect(lookupIdempotency(sql, key, image.requestDigest)?.targetId).toBe("legacy-image-op");
      expect(() => lookupIdempotency(sql, key, text.requestDigest)).toThrow(
        expect.objectContaining({ code: "idempotency_conflict" }),
      );
    } finally {
      db.close();
    }
  });
});
