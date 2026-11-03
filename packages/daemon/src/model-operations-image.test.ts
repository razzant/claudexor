import { sqlFixture } from "./store/test-support/sql-fixture.js";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ModelAdapter } from "@claudexor/core";
import {
  CredentialProfile,
  ImageCallRequest,
  ImageCallResult,
  ModelOperationParams,
  type ModelPayloadRef,
} from "@claudexor/schema";
import { DaemonClient } from "./client.js";
import { DaemonServer } from "./server.js";
import { ModelOperations } from "./model-operations.js";
import { afterEachClosed } from "../../cli/src/test-support/after-each-closed.js";

const cleanup: Array<() => Promise<void>> = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0).reverse();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72]);
const sha = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const route = {
  source: "codex",
  credentialProfileId: "fixture",
  accountFingerprint: "account-A",
  model: null,
};
const imageRequest = (prompt = "a red fox") =>
  ImageCallRequest.parse({
    source: "codex",
    model: "gpt-image-2",
    account: { mode: "pin", profileId: "fixture" },
    prompt,
  });
const imageResult = (images = 1): ImageCallResult =>
  ImageCallResult.parse({
    outcome: "completed",
    operation: "generate",
    requestedModel: "gpt-image-2",
    images: Array.from({ length: images }, () => ({
      mime: "image/png",
      sha256: sha(PNG),
      sizeBytes: PNG.length,
      dataBase64: PNG.toString("base64"),
      generationId: "gen-1",
    })),
    route,
    appliedOptions: { quality: "medium" },
    usage: { input_tokens: 1474, output_tokens: 1372 },
    cost: { knowledge: "unknown", billing: "unknown", source: "codex.images", provenance: ["t"] },
    providerRequestId: "req-1",
    problem:
      images > 0
        ? null
        : {
            code: "response_rejected",
            message: "no images",
            retryable: false,
            context: {},
            fieldErrors: {},
            requiredActions: [],
            evidenceRefs: [],
          },
  });

async function fixture(
  invoke?: NonNullable<ModelAdapter["image"]>["invoke"],
  options: { withImage?: boolean } = {},
) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cx-moi-")));
  const clock = new Date();
  const sql = await sqlFixture(root, () => clock);
  const store = sql.graph.commands.current();
  const commands = sql.graph.commands;
  const resources = sql.graph.resources;
  const socket =
    process.platform === "win32"
      ? `\\\\.\\pipe\\cx-moi-${randomUUID()}`
      : join(root, "daemon.sock");
  const client = new DaemonClient(socket, "fixture-control");
  const sends = vi.fn();
  const textInvoke = vi.fn();
  const adapter: ModelAdapter = {
    id: "codex",
    catalog: vi.fn(),
    invoke: textInvoke,
    ...(options.withImage === false
      ? {}
      : {
          image: {
            capability: {
              models: ["gpt-image-2"],
              modelsProvenance: "fixture",
              inputMimes: ["image/png"],
              maxInputImages: 5,
              maxInputImagesProvenance: "fixture",
              supportedOptions: ["size"],
            },
            invoke:
              invoke ??
              (async (_input, context) => {
                await context.onDispatch(route);
                sends();
                return imageResult();
              }),
          },
        }),
  };
  const profile = CredentialProfile.parse({
    profile_id: "fixture",
    harness_id: "codex",
    display_name: "Fixture",
    credential_kind: "config_dir_login",
    isolation_locator: join(root, "profile"),
  });
  const resolveImage = vi.fn(async () => ({ adapter, profile }));
  const operations = new ModelOperations({
    commands,
    resourceQueries: commands.queries,
    resources: () => resources,
    now: () => clock,
    enqueue: (envelope) => client.call("claudexor.enqueue", envelope),
    cancel: (id, reason) => client.cancel(id, reason),
    resolve: async () => ({ adapter, profile }),
    resolveImage,
  });
  const server = new DaemonServer({
    socketPath: socket,
    token: "fixture-control",
    commands,
    maxConcurrent: 1,
    runner: (input, context) => operations.execute(input, context),
    onCommandTerminal: (record) => operations.onCommandTerminal(record),
  });
  await server.start();
  removals.push(() => rmSync(root, { recursive: true, force: true }));
  cleanup.push(async () => {
    await server.stop();
    operations.close();
    await sql.close();
  });
  const upload = (body: unknown = imageRequest()): ModelPayloadRef =>
    resources.publishModel(Buffer.from(JSON.stringify(body)));
  const terminal = async (id: string) => {
    await vi.waitFor(
      () => expect(["queued", "running"]).not.toContain(operations.inspect(id).state),
      { timeout: 10_000, interval: 5 },
    );
    return operations.inspect(id);
  };
  return {
    records: sql.records,
    store,
    resources,
    operations,
    sends,
    textInvoke,
    resolveImage,
    upload,
    terminal,
    clock,
  };
}

describe("image requests over the existing model-operation substrate", () => {
  it("runs one image dispatch through the same SQL store, publishes the exact result and releases on ACK", async () => {
    const f = await fixture();
    const created = await f.operations.create(
      f.upload(),
      "image-one",
      undefined,
      undefined,
      "image",
    );
    expect(ModelOperationParams.parse(f.store.get(created.id)!.params)).toMatchObject({
      kind: "model",
      requestKind: "image",
    });
    const done = await f.terminal(created.id);
    expect(done).toMatchObject({
      state: "succeeded",
      dispatch: { state: "response_received", route: { model: null } },
      usage: { input_tokens: 1474, output_tokens: 1372 },
      cost: { knowledge: "unknown", source: "codex.images" },
      problem: null,
      response: { state: "ready" },
    });
    expect(f.sends).toHaveBeenCalledTimes(1);
    expect(f.textInvoke).not.toHaveBeenCalled();
    expect(f.resolveImage).toHaveBeenCalledTimes(1);
    const stored = f.operations.readResult(created.id);
    const parsed = ImageCallResult.parse(JSON.parse(stored.bytes.toString()));
    expect(parsed.images[0]!.dataBase64).toBe(PNG.toString("base64"));
    expect(parsed.requestedModel).toBe("gpt-image-2");
    // Same key + same kind replays the accepted command; no second generation.
    const replay = await f.operations.create(
      f.upload(),
      "image-one",
      undefined,
      undefined,
      "image",
    );
    expect(replay.id).toBe(created.id);
    expect(f.sends).toHaveBeenCalledTimes(1);
    // Same key with the TEXT kind is a different identity and conflicts.
    await expect(f.operations.create(f.upload(), "image-one")).rejects.toMatchObject({
      code: expect.stringContaining("idempotency"),
    });
    f.operations.acknowledge(created.id, stored.sha256);
    expect(f.operations.inspect(created.id).response.state).toBe("acknowledged");
    expect(() => f.operations.readResult(created.id)).toThrow(/acknowledged or expired/);
  });

  it("expires image bytes while replay retains the original command and cannot dispatch again", async () => {
    const f = await fixture();
    const ref = f.upload();
    const created = await f.operations.create(ref, "image-expiry", undefined, undefined, "image");
    const done = await f.terminal(created.id);
    expect(f.resources.listModelResources()).toHaveLength(1); // request released
    if (done.response.state !== "ready") throw new Error("expected a ready response");
    f.clock.setTime(Date.parse(done.response.expiresAt));
    expect(f.operations.reconcileResources().errors).toEqual([]);
    expect(f.resources.listModelResources()).toEqual([]);
    const replay = await f.operations.create(ref, "image-expiry", undefined, undefined, "image");
    expect(replay).toMatchObject({ id: created.id, response: { state: "expired" } });
    expect(f.sends).toHaveBeenCalledTimes(1);
  });

  it("cancels a queued image before dispatch and a sent image with honest response custody", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sends = vi.fn();
    const f = await fixture(async (_input, context) => {
      await context.onDispatch(route);
      sends();
      await barrier;
      return imageResult();
    });
    const first = await f.operations.create(
      f.upload(),
      "image-running",
      undefined,
      undefined,
      "image",
    );
    // The send follows the dispatch barrier (one flusher pass, much slower
    // under disk contention, #441); a 1 s window is not part of the contract.
    await vi.waitFor(() => expect(sends).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    const queued = await f.operations.create(
      f.upload(imageRequest("queued")),
      "image-queued",
      undefined,
      undefined,
      "image",
    );
    expect(await f.operations.cancel(queued.id)).toMatchObject({
      state: "cancelled",
      dispatch: { state: "not_started" },
    });
    await f.operations.cancel(first.id);
    release();
    const done = await f.terminal(first.id);
    expect(done).toMatchObject({
      state: "cancelled",
      dispatch: { state: "response_received" },
      response: { state: "ready" },
    });
    expect(sends).toHaveBeenCalledTimes(1);
    const stored = f.operations.readResult(first.id);
    expect(ImageCallResult.parse(JSON.parse(stored.bytes.toString())).images).toHaveLength(1);
    f.operations.acknowledge(first.id, stored.sha256);
    expect(f.resources.listModelResources()).toEqual([]);
  });

  it("refuses the evidence flags with the image kind and a text-shaped payload before admission", async () => {
    const f = await fixture();
    await expect(
      f.operations.create(f.upload(), "image-flags", true, undefined, "image"),
    ).rejects.toMatchObject({ code: "unsupported_parameter", status: 400 });
    await expect(
      f.operations.create(
        f.upload({ source: "codex", model: "m", account: { mode: "auto" }, messages: [] }),
        "image-shape",
        undefined,
        undefined,
        "image",
      ),
    ).rejects.toMatchObject({ code: "model_request_invalid", status: 400 });
    expect(f.records()).toHaveLength(0);
  });

  it("maps a completed response with no usable image to a failed lifecycle that keeps usage", async () => {
    const f = await fixture(async (_input, context) => {
      await context.onDispatch(route);
      return imageResult(0);
    });
    const created = await f.operations.create(
      f.upload(),
      "image-empty",
      undefined,
      undefined,
      "image",
    );
    const done = await f.terminal(created.id);
    expect(done).toMatchObject({
      state: "failed",
      dispatch: { state: "response_received" },
      usage: { input_tokens: 1474 },
      problem: { code: "response_rejected" },
      response: { state: "ready" },
    });
  });

  it("marks an interrupted image send unknown rather than never-sent", async () => {
    const f = await fixture(async (_input, context) => {
      await context.onDispatch(route);
      throw new Error("socket vanished");
    });
    const created = await f.operations.create(
      f.upload(),
      "image-torn",
      undefined,
      undefined,
      "image",
    );
    const done = await f.terminal(created.id);
    expect(done).toMatchObject({
      state: "interrupted",
      dispatch: { state: "unknown", startedAt: expect.any(String) },
      response: { state: "absent" },
    });
  });

  it("refuses an image request when the source declares no image facet, with no dispatch", async () => {
    const f = await fixture(undefined, { withImage: false });
    const created = await f.operations.create(
      f.upload(),
      "image-none",
      undefined,
      undefined,
      "image",
    );
    const done = await f.terminal(created.id);
    expect(done).toMatchObject({
      state: "failed",
      dispatch: { state: "not_started" },
      problem: { code: "model_source_unavailable" },
    });
  });
});
