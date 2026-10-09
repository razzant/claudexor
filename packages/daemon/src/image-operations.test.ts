import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableJournal } from "@claudexor/journal";
import {
  CredentialProfile,
  ImageCallRequest,
  ImageCallResult,
  ImageOperationParams,
} from "@claudexor/schema";
import { DaemonClient } from "./client.js";
import { CommandStore } from "./command-store.js";
import { DaemonServer } from "./server.js";
import { ImageOperations, type ImageOperationDependencies } from "./image-operations.js";
import { ResourceStore } from "./resource-store.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

const first = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const second = Buffer.from([255, 216, 255, 2]);
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const route = {
  source: "codex",
  credentialProfileId: "fixture",
  accountFingerprint: "account-A",
  model: "gpt-image-2",
};
const request = (prompt = "Generate a 🦉") =>
  ImageCallRequest.parse({
    request: {
      model: "gpt-image-2",
      prompt,
      n: 2,
      quality: "auto",
      size: "auto",
      background: "auto",
    },
  });
const result = () =>
  ImageCallResult.parse({
    outcome: "completed",
    route,
    data: [
      { b64_json: first.toString("base64"), generation_id: "one" },
      { b64_json: second.toString("base64"), generation_id: "two" },
    ],
    usage: { input_tokens: 3, output_tokens: 4 },
    problem: null,
  });

type Invoke = Awaited<ReturnType<ImageOperationDependencies["resolve"]>>["invoke"];
async function fixture(invoke?: Invoke, maxHistory?: number) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cx-io-")));
  let clock = new Date();
  const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
  const store = new CommandStore(journal, () => clock);
  const commands = { current: () => store };
  const resources = new ResourceStore(join(root, "resources"));
  const socket =
    process.platform === "win32" ? `\\\\.\\pipe\\cx-io-${randomUUID()}` : join(root, "daemon.sock");
  const client = new DaemonClient(socket, "fixture-control");
  const profile = CredentialProfile.parse({
    profile_id: "fixture",
    harness_id: "codex",
    display_name: "Fixture",
    credential_kind: "config_dir_login",
    isolation_locator: join(root, "profile"),
  });
  const sends = vi.fn();
  const operations = new ImageOperations({
    commands,
    resources: () => resources,
    now: () => clock,
    enqueue: (envelope) => client.call("claudexor.enqueue", envelope),
    cancel: (id, reason) => client.cancel(id, reason),
    resolve: async () => ({
      profile,
      invoke:
        invoke ??
        (async (_request, context) => {
          await context.onDispatch(route);
          sends(context.imageTurnId);
          return result();
        }),
    }),
  });
  const server = new DaemonServer({
    socketPath: socket,
    token: "fixture-control",
    commands,
    ...(maxHistory === undefined ? {} : { maxHistory, idempotencyRetentionMs: 0 }),
    maxConcurrent: 1,
    runner: (input, context) => operations.execute(input, context),
    onCommandTerminal: (record) => operations.onCommandTerminal(record),
  });
  await server.start();
  cleanup.push(async () => {
    await server.stop();
    operations.close();
    journal.close();
    rmSync(root, { recursive: true, force: true });
  });
  const terminal = async (id: string) => {
    await vi.waitFor(
      () => expect(["queued", "running"]).not.toContain(operations.inspect(id).state),
      { timeout: 10_000, interval: 5 },
    );
    return operations.inspect(id);
  };
  return {
    root,
    journal,
    store,
    commands,
    resources,
    operations,
    server,
    client,
    sends,
    terminal,
    setNow: (time: Date) => {
      clock = time;
    },
  };
}

describe("image operations on the existing command substrate", () => {
  it("journals one dispatch, preserves full JSON and releases only after each decoded-image digest ACK", async () => {
    const f = await fixture();
    const created = await f.operations.create(request(), "two-images");
    const done = await f.terminal(created.id);
    expect(done).toMatchObject({
      state: "succeeded",
      dispatch: { state: "response_received", startedAt: expect.any(String) },
      response: { state: "ready", images: [digest(first), digest(second)], acknowledged: [] },
    });
    expect(JSON.stringify(f.store.records())).not.toContain("Generate a 🦉");
    expect(JSON.stringify(f.store.records())).not.toContain(first.toString("base64"));
    const payload = f.operations.readResult(created.id);
    expect(ImageCallResult.parse(JSON.parse(payload.bytes.toString()))).toEqual(result());
    expect(payload.sha256).toBe(`sha256:${digest(payload.bytes)}`);
    expect(() => f.operations.acknowledge(created.id, "0".repeat(64))).toThrowError(
      expect.objectContaining({ code: "image_result_digest_mismatch" }),
    );
    expect(f.operations.acknowledge(created.id, digest(first)).response).toMatchObject({
      state: "ready",
      acknowledged: [digest(first)],
    });
    expect(f.operations.acknowledge(created.id, `sha256:${digest(first)}`).response).toMatchObject({
      state: "ready",
      acknowledged: [digest(first)],
    });
    expect(f.operations.readResult(created.id).bytes.equals(payload.bytes)).toBe(true);
    expect(f.operations.acknowledge(created.id, digest(second)).response.state).toBe(
      "acknowledged",
    );
    // A lost final ACK reply replays the same digest without reviving bytes or a send.
    expect(f.operations.acknowledge(created.id, digest(second)).response.state).toBe(
      "acknowledged",
    );
    expect(() => f.operations.acknowledge(created.id, "0".repeat(64))).toThrowError(
      expect.objectContaining({ code: "image_result_digest_mismatch" }),
    );
    expect(() => f.operations.readResult(created.id)).toThrowError(
      expect.objectContaining({ code: "image_result_released" }),
    );
    expect(f.resources.listImageResources()).toEqual([]);
    expect((await f.operations.create(request(), "two-images")).id).toBe(created.id);
    expect(f.sends).toHaveBeenCalledOnce();
    expect(f.sends).toHaveBeenCalledWith(`img-${created.id}`);
  });

  it("retains a half-ACK result across restart and keeps image GC disjoint from model GC", async () => {
    const f = await fixture();
    const model = f.resources.publishModel(Buffer.from("caller-owned model bytes"));
    const created = await f.operations.create(request(), "restart-images");
    const done = await f.terminal(created.id);
    if (done.response.state !== "ready") throw new Error("expected ready image result");
    const full = f.operations.readResult(created.id).bytes;
    f.operations.acknowledge(created.id, digest(first));
    await f.server.stop();
    f.operations.close();
    f.journal.close();
    const journal = new DurableJournal({ rootDir: join(f.root, "journal"), partition: "global" });
    const store = new CommandStore(journal);
    const resources = new ResourceStore(join(f.root, "resources"));
    const reopened = new ImageOperations({
      commands: { current: () => store },
      resources: () => resources,
      enqueue: async () => {
        throw new Error("must replay accepted command");
      },
      cancel: async () => {
        throw new Error("must not cancel");
      },
      resolve: async () => {
        throw new Error("must not start a second generation");
      },
    });
    cleanup.push(async () => {
      reopened.close();
      journal.close();
    });
    expect(reopened.reconcileResources()).toEqual({ released: [], errors: [] });
    expect(reopened.readResult(created.id).bytes.equals(full)).toBe(true);
    expect((await reopened.create(request(), "restart-images")).id).toBe(created.id);
    expect(reopened.inspect(created.id).response).toMatchObject({
      state: "ready",
      acknowledged: [digest(first)],
    });
    expect(resources.readModel(model).toString()).toBe("caller-owned model bytes");
    reopened.acknowledge(created.id, digest(second));
    expect(resources.listImageResources()).toEqual([]);
    expect(resources.readModel(model).toString()).toBe("caller-owned model bytes");
    expect(f.sends).toHaveBeenCalledOnce();
  });

  it("retains compact idempotency after age/cap cleanup and expires unacknowledged images", async () => {
    const f = await fixture(undefined, 1);
    const firstOp = await f.operations.create(request(), "first-key");
    const firstDone = await f.terminal(firstOp.id);
    if (firstDone.response.state !== "ready") throw new Error("expected ready image result");
    const retainedRef = firstDone.response.ref;
    const secondOp = await f.operations.create(request("Other"), "second-key");
    await f.terminal(secondOp.id);
    expect(f.store.records()).toHaveLength(2);
    f.setNow(new Date(firstDone.response.expiresAt));
    expect(f.operations.inspect(firstOp.id).response.state).toBe("expired");
    expect(f.operations.reconcileResources(true).released).toContain(retainedRef.resourceId);
    expect(f.operations.reconcileResources().errors).toEqual([]);
    expect(() => f.resources.readImage(retainedRef)).toThrow();
    expect((await f.operations.create(request(), "first-key")).response.state).toBe("expired");
    expect(f.sends).toHaveBeenCalledTimes(2);
  });

  it("preserves a send's unknown outcome; no replay or second provider call", async () => {
    const sends = vi.fn();
    const f = await fixture(async (_request, context) => {
      await context.onDispatch(route);
      sends();
      throw new Error("provider transport died after send");
    });
    const created = await f.operations.create(request(), "unknown-key");
    expect(await f.terminal(created.id)).toMatchObject({
      state: "interrupted",
      dispatch: { state: "unknown", startedAt: expect.any(String) },
      response: { state: "absent" },
    });
    expect((await f.operations.create(request(), "unknown-key")).id).toBe(created.id);
    expect(sends).toHaveBeenCalledOnce();
    expect(f.resources.listImageResources()).toEqual([]);
  });

  it("retains a typed image-only rate limit in the compact detail without inventing result bytes", async () => {
    const f = await fixture(async (_request, context) => {
      await context.onDispatch(route);
      return ImageCallResult.parse({
        outcome: "failed",
        route,
        data: null,
        usage: null,
        problem: {
          code: "image_generation_limit_reached",
          message: "Image limit reached; text allowance unchanged",
          retryable: false,
          context: { resetsAt: "2026-10-09T00:00:00Z" },
        },
      });
    });
    const created = await f.operations.create(request(), "image-limit");
    expect(await f.terminal(created.id)).toMatchObject({
      state: "failed",
      dispatch: { state: "response_received" },
      response: { state: "absent" },
      problem: {
        code: "image_generation_limit_reached",
        context: { resetsAt: "2026-10-09T00:00:00Z" },
      },
    });
    expect(() => f.operations.readResult(created.id)).toThrowError(
      expect.objectContaining({ code: "image_result_not_ready" }),
    );
    expect(f.resources.listImageResources()).toEqual([]);
    expect(f.resources.listModelResources()).toEqual([]);
  });

  it("does not POST when dispatch journal update rejects and keeps image quota refusal out of text authority", async () => {
    const sends = vi.fn();
    const f = await fixture(async (_request, context) => {
      try {
        await context.onDispatch(route);
        sends();
      } catch {
        /* adapter observed failed write */
      }
      return ImageCallResult.parse({
        outcome: "failed",
        route,
        data: null,
        usage: null,
        problem: null,
      });
    });
    const update = f.store.update.bind(f.store);
    vi.spyOn(f.store, "update").mockImplementation((id, patch) => {
      if ((patch.result as { dispatch?: { state?: string } })?.dispatch?.state === "started")
        throw new Error("journal unavailable");
      return update(id, patch);
    });
    const created = await f.operations.create(request(), "dispatch-write-failed");
    expect(await f.terminal(created.id)).toMatchObject({
      state: "failed",
      dispatch: { state: "not_started" },
    });
    expect(sends).not.toHaveBeenCalled();
    // This class owns neither account selection nor a text-quota ledger; its
    // only effect is the command and purpose=image resources.
    expect(f.resources.listModelResources()).toEqual([]);
  });

  it("refuses changed-key payloads without retaining an orphan and refuses malformed raw image refs", async () => {
    const f = await fixture();
    const created = await f.operations.create(request(), "fixed-key");
    await f.terminal(created.id);
    await expect(f.operations.create(request("Different"), "fixed-key")).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    expect(f.resources.listImageResources()).toHaveLength(1); // only the result remains
    const ordinary = f.resources.publishModel(Buffer.from(JSON.stringify(request())));
    f.store.accept({
      id: "bad-image",
      params: { kind: "image", request: ordinary },
      idempotencyKey: "bad",
      clientId: "fixture",
    });
    const receipt = await f.operations.execute(
      ImageOperationParams.parse({ kind: "image", request: ordinary }),
      {
        jobId: "bad-image",
        signal: new AbortController().signal,
      } as Parameters<ImageOperations["execute"]>[1],
    );
    expect(receipt).toMatchObject({
      lifecycle: "failed",
      dispatch: { state: "not_started" },
      problem: { code: "resource_purpose_mismatch" },
    });
    expect(f.sends).toHaveBeenCalledOnce();
  });
});
