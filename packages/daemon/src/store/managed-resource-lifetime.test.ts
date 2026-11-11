import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ControlRunStartRequest } from "@claudexor/schema";
import { setGlobalGenerationInTx } from "./generations.js";
import { runMutation } from "./mutation.js";
import { createPartition } from "./partitions.js";
import { claimResourceUsesInTx } from "./resource-uses.js";
import { createSqlDaemonServices } from "./sql-daemon-services.js";
import { EngineStore } from "./store.js";
import { chunks } from "./test-support/resource-fixture.js";
import { afterEachClosed } from "../../../cli/src/test-support/after-each-closed.js";
import { threadTurnServices } from "../../../cli/src/thread-turn-services.js";

const cleanups: Array<() => Promise<void>> = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  const ownedRemovals = removals.splice(0).reverse();
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cx-managed-resource-"));
  removals.push(() => rmSync(root, { recursive: true, force: true }));
  const store = await EngineStore.open({
    daemonDir: root,
    workerEntry: resolve(import.meta.dirname, "../../dist/store/flusher-worker.js"),
  });
  if (!store.prepare("SELECT id FROM partition WHERE name='global'").get())
    store.transaction(() => setGlobalGenerationInTx(store, createPartition(store, "global").pid));
  const graph = createSqlDaemonServices(store, { purgeFiles: async () => [root] });
  cleanups.push(async () => {
    await graph.close();
    await store.close();
  });
  const doc = (text: string) => {
    const bytes = Buffer.from(text);
    return {
      bytes,
      content: {
        sizeBytes: bytes.length,
        sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      },
    };
  };
  const request = (extra: Record<string, unknown> = {}) => ({
    expectedStoreId: store.storeId,
    kind: "file",
    mime: "text/plain",
    name: "brief.txt",
    source: "/host/brief.txt",
    ...extra,
  });
  /** One completed keyed import (the host importer's exact calls). */
  const imported = async (key: string, text: string, extra: Record<string, unknown> = {}) => {
    const { bytes, content } = doc(text);
    const begun = graph.resources.importUpload(request({ ...extra, content }), key);
    await graph.resources.write(begun.uploadId, chunks(bytes));
    const ready = graph.resources.importUpload(request(extra), key);
    expect(ready.state).toBe("ready");
    return ready.resource!;
  };
  const accept = (id: string, resourceId: string) =>
    graph.commands.current().accept({
      id,
      params: { prompt: `use ${resourceId}`, attachments: [{ resourceId }] },
      idempotencyKey: id,
      clientId: "test",
    });
  const uses = (resourceId: string) =>
    store
      .prepare("SELECT owner,owner_id FROM resource_use WHERE resource_id=? ORDER BY owner_id")
      .all(resourceId) as Array<{ owner: string; owner_id: string }>;
  const release = (resource: { resourceId: string; sha256: string }) =>
    graph.resources.releaseResource(resource.resourceId, {
      expectedStoreId: store.storeId,
      sha256: resource.sha256,
    });
  /** A managed import with its resolved attachment, the way a turn stores it. */
  const attached = async (key: string, text: string) => {
    const managed = await imported(key, text, { lifetime: "managed" });
    const attachments = graph.resources.resolve([{ resourceId: managed.resourceId }]);
    return { managed, attachments, path: attachments[0]!.path };
  };
  return { store, graph, request, imported, accept, uses, release, attached };
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string; status?: number }).code;
  }
  throw new Error("expected a typed failure");
};

describe("managed ordinary resource lifetime (#249)", () => {
  it("releases only an opted-in ID and answers its original import as released", async () => {
    const f = await fixture();
    const legacy = await f.imported("default-key", "default bytes\n");
    expect(legacy.lifetime).toBeUndefined();
    const release = (id: string, sha256: string, storeId = f.store.storeId) =>
      f.graph.resources.releaseResource(id, { expectedStoreId: storeId, sha256 });
    expect(code(() => release(legacy.resourceId, legacy.sha256))).toBe(
      "resource_lifetime_indefinite",
    );
    const managed = await f.imported("managed-key", "managed bytes\n", { lifetime: "managed" });
    expect(managed.lifetime).toBe("managed");
    // Refusals precede any effect: another store, another digest.
    const otherStore = "00000000-0000-4000-8000-000000000000";
    expect(code(() => release(managed.resourceId, managed.sha256, otherStore))).toBe(
      "store_mismatch",
    );
    expect(code(() => release(managed.resourceId, legacy.sha256))).toBe("resource_digest_mismatch");
    expect(f.graph.resources.resolve([{ resourceId: managed.resourceId }])).toHaveLength(1);
    const receipt = release(managed.resourceId, managed.sha256);
    expect(receipt).toMatchObject({
      storeId: f.store.storeId,
      resourceId: managed.resourceId,
      sha256: managed.sha256,
      state: "released",
    });
    // Naturally idempotent: the first release instant is the answer forever.
    expect(release(managed.resourceId, managed.sha256)).toEqual(receipt);
    // The original operation replays as itself; it never becomes ready or a re-upload.
    const replayed = f.request({ lifetime: "managed" });
    const replay = f.graph.resources.importUpload(replayed, "managed-key");
    expect(replay).toMatchObject({
      state: "released",
      resource: managed,
      releasedAt: receipt.releasedAt,
    });
    // The key binds the lifetime like every other semantic field.
    expect(code(() => f.graph.resources.importUpload(f.request(), "managed-key"))).toBe(
      "idempotency_conflict",
    );
    // A new reference is refused typed; the default ID keeps resolving.
    expect(code(() => f.graph.resources.resolve([{ resourceId: managed.resourceId }]))).toBe(
      "resource_released",
    );
    expect(f.graph.resources.resolve([{ resourceId: legacy.resourceId }])).toHaveLength(1);
  });

  it("keeps bytes for accepted work and frees them after its last holder", async () => {
    const f = await fixture();
    const managed = await f.imported("held-key", "held bytes\n", { lifetime: "managed" });
    const accepted = f.accept("job-accepted", managed.resourceId).record;
    expect(f.uses(managed.resourceId)).toEqual([{ owner: "command", owner_id: accepted.id }]);
    f.graph.resources.releaseResource(managed.resourceId, {
      expectedStoreId: f.store.storeId,
      sha256: managed.sha256,
    });
    // The accepted command still resolves its own ref at execution, from intact bytes.
    const [attachment] = f.graph.resources.resolve([{ resourceId: managed.resourceId }], {
      owner: "command",
      id: accepted.id,
    });
    expect(readFileSync(attachment!.path, "utf8")).toBe("held bytes\n");
    // Its exact replay is the original operation, never a new reference.
    expect(f.accept("job-accepted", managed.resourceId)).toMatchObject({ reused: true });
    // A new command naming the released ID is refused inside its acceptance transaction.
    expect(code(() => f.accept("job-new", managed.resourceId))).toBe("resource_released");
    expect(f.store.prepare("SELECT 1 FROM command WHERE id='job-new'").get()).toBeUndefined();
    // Retiring the last holder (command retention) frees the released bytes.
    f.graph.pruner.prune([accepted.id]);
    expect(f.uses(managed.resourceId)).toEqual([]);
    await vi.waitFor(() => expect(existsSync(attachment!.path)).toBe(false), { timeout: 10_000 });
  });

  it("never frees a digest another live resource or holder shares", async () => {
    const f = await fixture();
    const managed = await f.imported("shared-managed", "same bytes\n", { lifetime: "managed" });
    const sibling = await f.imported("shared-default", "same bytes\n");
    expect(sibling.sha256).toBe(managed.sha256);
    f.graph.resources.releaseResource(managed.resourceId, {
      expectedStoreId: f.store.storeId,
      sha256: managed.sha256,
    });
    await f.graph.resources.drainCleanup();
    const [kept] = f.graph.resources.resolve([{ resourceId: sibling.resourceId }]);
    expect(readFileSync(kept!.path, "utf8")).toBe("same bytes\n");
  });

  it("admits a released ID only for its holder or an owner derived from one", async () => {
    const f = await fixture();
    const managed = await f.imported("derived-key", "derived bytes\n", { lifetime: "managed" });
    const draft = { owner: "deferred_message", id: "draft-1" } as const;
    runMutation(f.store, (tx) => claimResourceUsesInTx(tx, draft, [managed.resourceId]));
    f.graph.resources.releaseResource(managed.resourceId, {
      expectedStoreId: f.store.storeId,
      sha256: managed.sha256,
    });
    const claim = (id: string, from?: typeof draft) =>
      runMutation(f.store, (tx) =>
        claimResourceUsesInTx(tx, { owner: "command", id }, [managed.resourceId], from),
      );
    expect(code(() => claim("job-unrelated"))).toBe("resource_released");
    claim("job-successor", draft);
    // The holder rewriting itself (a turn or draft update) is not a new reference.
    runMutation(f.store, (tx) => claimResourceUsesInTx(tx, draft, [managed.resourceId]));
    expect(f.uses(managed.resourceId).map((row) => row.owner_id)).toEqual([
      "draft-1",
      "job-successor",
    ]);
  });

  it("lets an accepted turn's first dispatch keep a released ID and refuses any later one", async () => {
    const f = await fixture();
    const { managed, attachments } = await f.attached("turn-key", "turn bytes\n");
    const thread = f.graph.threads.createThread({});
    const turn = f.graph.threads.createTurn(thread.id, "use the brief", { attachments });
    const refused = f.graph.threads.createTurn(thread.id, "use it again", { attachments });
    // A refusal recorded before any command (a preflight or enqueue failure) is no dispatch.
    f.graph.threads.setTurnEnqueueError(refused.id, {
      message: "fixture refusal before any command",
      code: "fixture_refused",
      retryable: false,
      required_actions: [],
      context: {},
    });
    f.release(managed);
    expect(code(() => f.graph.threads.createTurn(thread.id, "new", { attachments }))).toBe(
      "resource_released",
    );
    // The create route's preflight reads the accepted turn's refs as their holder.
    const own = { owner: "turn", id: turn.id } as const;
    expect(f.graph.resources.resolve([{ resourceId: managed.resourceId }], own)).toHaveLength(1);
    // A turn's command carries no refs; only its first dispatch inherits the turn's hold.
    const dispatch = (id: string, turnId: string, operation = "thread.turn.create") =>
      f.graph.commands.current().accept({
        id,
        params: { prompt: "use the brief", threadId: thread.id, turnId },
        idempotencyKey: id,
        clientId: "control-api",
        operation,
      });
    expect(dispatch("job-turn", turn.id)).toMatchObject({ reused: false });
    expect(f.uses(managed.resourceId)).toContainEqual({ owner: "command", owner_id: "job-turn" });
    expect(dispatch("job-turn", turn.id)).toMatchObject({ reused: true });
    // Turn Retry under a new key re-dispatches the same turn: a new reference.
    expect(code(() => dispatch("job-retry", turn.id, "thread.turn.retry"))).toBe(
      "resource_released",
    );
    expect(f.store.prepare("SELECT 1 FROM command WHERE id='job-retry'").get()).toBeUndefined();
    // The recorded refusal did not strand the never-dispatched turn: its first dispatch holds.
    expect(dispatch("job-refused", refused.id)).toMatchObject({ reused: false });
    expect(f.uses(managed.resourceId)).toContainEqual({
      owner: "command",
      owner_id: "job-refused",
    });
    // The durable dispatch fact outlives command retention: with no command, refusal or
    // run left for the turn, a new dispatch is still a new reference.
    f.graph.pruner.prune(["job-turn"]);
    expect(f.store.prepare("SELECT 1 FROM command WHERE turn_id=?").get(turn.id)).toBeUndefined();
    expect(f.graph.threads.getTurn(turn.id)).toMatchObject({ run_id: null, enqueue_error: null });
    expect(code(() => dispatch("job-after-prune", turn.id))).toBe("resource_released");
  });

  it("never refuses or holds for a delivery of a run's retained result", async () => {
    const f = await fixture();
    const managed = await f.imported("delivery-key", "delivered bytes\n", { lifetime: "managed" });
    const run = f.accept("job-run", managed.resourceId).record;
    f.release(managed);
    // Apply, discard or revert is accepted with that run's params: it is no new work.
    const delivery = f.graph.commands.current().accept({
      id: "delivery-apply",
      params: run.params,
      idempotencyKey: "apply-key",
      clientId: "control-api",
      operation: "delivery.run.apply",
    });
    expect(delivery).toMatchObject({ reused: false });
    expect(f.uses(managed.resourceId)).toEqual([{ owner: "command", owner_id: "job-run" }]);
    // The same params as new product work stay a new reference.
    expect(code(() => f.accept("job-again", managed.resourceId))).toBe("resource_released");
  });

  it("answers a same-key create after a refusal before any enqueue as the recorded turn", async () => {
    const f = await fixture();
    const { managed } = await f.attached("replay-key", "replay bytes\n");
    const thread = f.graph.threads.createThread({});
    const services = threadTurnServices(f.graph.threads, f.graph.resources);
    const refs = [{ resourceId: managed.resourceId }];
    const create = (key: string, prompt = "use the brief") =>
      services.createThreadTurn(thread.id, prompt, {
        attachments: refs,
        idempotency: {
          key,
          client: "control-api",
          request: { threadId: thread.id, body: { prompt, attachments: refs } },
        },
      });
    // The create recorded its turn; its preflight was then refused before any enqueue
    // (the route records that on the turn), and the caller released the ID.
    const recorded = await create("create-key");
    f.graph.threads.setTurnEnqueueError(recorded.id, {
      message: "fixture preflight refusal",
      code: "fixture_preflight",
      retryable: false,
      required_actions: [],
      context: {},
    });
    f.release(managed);
    // Its same-key repeat is that recorded turn, not a new reference and not a second turn.
    expect((await create("create-key")).id).toBe(recorded.id);
    expect(f.graph.threads.turnsFor(thread.id)).toHaveLength(1);
    // A new key is a new turn naming the released ID; a changed request under the key
    // conflicts before any resource is read. Neither records anything.
    await expect(create("other-key")).rejects.toMatchObject({ code: "resource_released" });
    await expect(create("create-key", "a changed prompt")).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    expect(f.graph.threads.turnsFor(thread.id)).toHaveLength(1);
    // The turn's first dispatch inherits its hold; any later dispatch is new.
    const dispatch = (id: string, operation: string) =>
      f.graph.commands.current().accept({
        id,
        params: { prompt: "use the brief", threadId: thread.id, turnId: recorded.id },
        idempotencyKey: id,
        clientId: "control-api",
        operation,
      });
    expect(dispatch("create-key", "thread.turn.create")).toMatchObject({ reused: false });
    expect(f.uses(managed.resourceId)).toContainEqual({ owner: "command", owner_id: "create-key" });
    expect(code(() => dispatch("job-retry", "thread.turn.retry"))).toBe("resource_released");
  });

  it("ends a purged thread's holds on every purge path and frees the released bytes", async () => {
    const f = await fixture();
    const project = realpathSync(mkdtempSync(join(tmpdir(), "cx-managed-project-")));
    removals.push(() => rmSync(project, { recursive: true, force: true }));
    const trashedTurn = async (key: string, repoRoot?: string) => {
      const held = await f.attached(key, `${key} bytes\n`);
      const thread = f.graph.threads.createThread(repoRoot ? { repoRoot } : {});
      f.graph.threads.createTurn(thread.id, "use it", { attachments: held.attachments });
      f.release(held.managed);
      f.graph.threads.trashThread(thread.id);
      expect(f.uses(held.managed.resourceId)).toHaveLength(1);
      return { ...held, thread };
    };
    const single = await trashedTurn("purged-thread");
    f.graph.threads.purgeThread(single.thread.id);
    expect(f.uses(single.managed.resourceId)).toEqual([]);
    await vi.waitFor(() => expect(existsSync(single.path)).toBe(false), { timeout: 10_000 });
    // A project removal that purges its trash writes through the same reducer.
    const removed = await trashedTurn("removed-project", project);
    const projectId = f.graph.threads.projects.findByRoot(project)!.id;
    f.graph.threads.removeProjectWithTrashedThreads(projectId, new Set());
    expect(f.uses(removed.managed.resourceId)).toEqual([]);
    await vi.waitFor(() => expect(existsSync(removed.path)).toBe(false), { timeout: 10_000 });
  });

  it("frees released bytes when a draft replace or clear drops their last hold", async () => {
    const f = await fixture();
    const start = ControlRunStartRequest.parse({ mode: "ask", prompt: "first" });
    f.graph.commands.current().accept({
      id: "job-p",
      params: start,
      clientId: "test",
      idempotencyKey: "job-p",
    });
    const drafts = f.graph.commands.deferredFor("job-p")!;
    const first = await f.attached("draft-first", "first draft bytes\n");
    const second = await f.attached("draft-second", "second draft bytes\n");
    const created = drafts.mutate(
      {
        action: "create",
        predecessorId: "job-p",
        prompt: "verify",
        attachments: [{ resourceId: first.managed.resourceId }],
      },
      "draft-create",
      start,
    );
    f.release(first.managed);
    const replaced = drafts.mutate(
      {
        action: "replace",
        draftId: created.draft.draftId,
        expectedRevision: created.appliedRevision,
        prompt: "verify",
        attachments: [{ resourceId: second.managed.resourceId }],
      },
      "draft-replace",
    );
    expect(f.uses(first.managed.resourceId)).toEqual([]);
    await vi.waitFor(() => expect(existsSync(first.path)).toBe(false), { timeout: 10_000 });
    f.release(second.managed);
    expect(existsSync(second.path)).toBe(true);
    drafts.mutate(
      {
        action: "clear",
        draftId: created.draft.draftId,
        expectedRevision: replaced.appliedRevision,
      },
      "draft-clear",
    );
    expect(f.uses(second.managed.resourceId)).toEqual([]);
    await vi.waitFor(() => expect(existsSync(second.path)).toBe(false), { timeout: 10_000 });
  });
});
