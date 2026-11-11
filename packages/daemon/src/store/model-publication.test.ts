import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { ModelAdapter, ModelAdapterContext } from "@claudexor/core";
import {
  CredentialProfile,
  ImageCallRequest,
  ImageCallResult,
  ModelCallRequest,
  ModelCallResult,
} from "@claudexor/schema";
import { describe, expect, it, vi } from "vitest";
import { DaemonClient } from "../client.js";
import { ModelOperations } from "../model-operations.js";
import { DaemonServer } from "../server.js";
import { sha256Hex } from "./blob-files.js";
import { setGlobalGenerationInTx } from "./generations.js";
import { createPartition, currentGeneration } from "./partitions.js";
import { payloadRef } from "./resource-rows.js";
import { createSqlDaemonServices } from "./sql-daemon-services.js";
import { EngineStore } from "./store.js";
import { builtWorker, chunks } from "./test-support/resource-fixture.js";
import { afterEachClosed } from "../../../cli/src/test-support/after-each-closed.js";

// Native read failures are deterministic even when chmod would be bypassed.
// The later fault starts only after the response part has been written.
const fault = vi.hoisted(() => ({
  dir: "",
  active: false,
  afterWrite: false,
  reads: [] as string[],
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: vi.fn(actual.readdirSync),
    readFileSync: ((path: unknown, ...args: unknown[]) => {
      if (fault.dir && String(path).startsWith(fault.dir)) {
        fault.reads.push(String(path));
        if (fault.active) throw Object.assign(new Error("fixture legacy read"), { code: "EACCES" });
      }
      return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...args);
    }) as typeof actual.readFileSync,
    writeSync: ((...args: unknown[]) => {
      const written = (actual.writeSync as (...args: unknown[]) => number)(...args);
      if (fault.afterWrite) {
        fault.afterWrite = false;
        fault.active = true;
      }
      return written;
    }) as typeof actual.writeSync,
  };
});

const cleanup: Array<() => void | Promise<void>> = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0).reverse();
  fault.dir = "";
  fault.active = fault.afterWrite = false;
  fault.reads = [];
  for (const close of cleanup.splice(0).reverse()) await close();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});
const route = {
  source: "codex",
  credentialProfileId: "fixture",
  accountFingerprint: "fixture-account",
  model: null,
};
const cost = { knowledge: "unknown", billing: "unknown", source: "fixture", provenance: ["test"] };
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF5cAAAAASUVORK5CYII=",
  "base64",
);
const textResult = ModelCallResult.parse({
  outcome: "completed",
  message: { role: "assistant", content: "exact answer 🦉 " + "x".repeat(70_000) },
  route,
  usage: { input_tokens: 3, output_tokens: 2 },
  cost,
  appliedOptions: {},
  problem: null,
});
const imageResult = ImageCallResult.parse({
  outcome: "completed",
  operation: "generate",
  providerRequestId: "fixture-provider-request",
  requestedModel: "gpt-image-2",
  images: [
    {
      mime: "image/png",
      sha256: `sha256:${sha256Hex(png)}`,
      sizeBytes: png.length,
      dataBase64: png.toString("base64"),
      generationId: "fixture-image",
    },
  ],
  route,
  usage: { input_tokens: 3, output_tokens: 2 },
  cost,
  appliedOptions: {},
  problem: null,
});

/** Source imports bind this consumer to the actual resource/command owners;
 * only the provider and the legacy file read failure are controlled. */
async function serve(root: string, adapter: ModelAdapter) {
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: builtWorker("flusher-worker.js"),
  });
  if (!currentGeneration(store, "global"))
    store.transaction(() => setGlobalGenerationInTx(store, createPartition(store, "global").pid));
  const graph = createSqlDaemonServices(store, { purgeFiles: async () => [] });
  await graph.recoverAfterStartup();
  const socket =
    process.platform === "win32"
      ? `\\\\.\\pipe\\cx-pub-${randomUUID()}`
      : join(root, "daemon.sock");
  const client = new DaemonClient(socket, "fixture-control");
  const profile = CredentialProfile.parse({
    profile_id: "fixture",
    harness_id: "codex",
    display_name: "Fixture",
    credential_kind: "config_dir_login",
    isolation_locator: join(root, "profile"),
  });
  const operations = new ModelOperations({
    commands: graph.commands,
    resourceQueries: graph.commands.queries,
    resources: () => graph.resources,
    enqueue: (envelope) => client.call("claudexor.enqueue", envelope),
    cancel: (id, reason) => client.cancel(id, reason),
    resolve: async () => ({ adapter, profile }),
    resolveImage: async () => ({ adapter, profile }),
  });
  const server = new DaemonServer({
    socketPath: socket,
    token: "fixture-control",
    commands: graph.commands,
    maxConcurrent: 1,
    runner: (input, context) => operations.execute(input, context),
    onCommandTerminal: (record) => operations.onCommandTerminal(record),
  });
  let closing: Promise<void> | undefined;
  /** One close: a later caller gets its outcome, not a success it never saw (#376). */
  const close = () =>
    (closing ??= (async () => {
      await server.stop();
      operations.close();
      await graph.close();
      await store.close();
    })());
  cleanup.push(close);
  await server.start();
  return { store, graph, operations, close };
}

describe("new model result publication with unavailable legacy upload keys", () => {
  it.each([
    ["text", "create"],
    ["text", "finalize"],
    ["image", "create"],
    ["image", "finalize"],
  ] as const)(
    "keeps the %s response when the directory fails before internal %s",
    async (kind, stage) => {
      const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "cx-pub-")));
      removals.push(() => fs.rmSync(root, { recursive: true, force: true }));
      const dispatch = vi.fn(async (context: ModelAdapterContext) => {
        await context.onDispatch(route);
        // Admission and its durable dispatch barrier have already succeeded.
        fault.dir = join(root, "daemon/resource-store/idempotency") + sep;
        fault.active = stage === "create";
        fault.afterWrite = stage === "finalize";
      });
      const adapter: ModelAdapter = {
        id: "codex",
        catalog: vi.fn(),
        invoke: async (_request, context) => {
          await dispatch(context);
          return textResult;
        },
        image: {
          capability: {
            models: ["gpt-image-2"],
            modelsProvenance: "fixture",
            inputMimes: ["image/png"],
            maxInputImages: 1,
            maxInputImagesProvenance: "fixture",
            supportedOptions: [],
          },
          invoke: async (_request, context) => {
            await dispatch(context);
            return imageResult;
          },
        },
      };
      const first = await serve(root, adapter);
      const dir = join(first.store.paths.resourceStore, "idempotency");
      fs.mkdirSync(dir, { recursive: true });
      const historical = Buffer.from("untouched unrelated damaged legacy binding");
      fs.writeFileSync(join(dir, "historical.json"), historical);
      first.store.transaction(() =>
        first.store
          .prepare("INSERT INTO meta(key,value) VALUES('legacy_idempotency_dir','present')")
          .run(),
      );
      const request =
        kind === "image"
          ? ImageCallRequest.parse({
              source: "codex",
              model: "gpt-image-2",
              account: { mode: "pin", profileId: "fixture" },
              prompt: "a red fox",
            })
          : ModelCallRequest.parse({
              source: "codex",
              model: "test-model",
              account: { mode: "pin", profileId: "fixture" },
              messages: [{ role: "user", content: "own conversation" }],
            });
      // Real caller-key ingress before the fault, not publishModel as a test upload shortcut.
      const bytes = Buffer.from(JSON.stringify(request));
      const upload = first.graph.resources.create(
        {
          purpose: "model",
          kind: "file",
          mime: "application/json",
          name: "request.json",
          sizeBytes: bytes.length,
        },
        "caller-create",
      );
      await first.graph.resources.write(upload.uploadId, chunks(bytes));
      const input = payloadRef(
        first.graph.resources.finalize(
          upload.uploadId,
          `sha256:${sha256Hex(bytes)}`,
          "caller-finalize",
        ),
      );
      const requestKind = kind === "image" ? "image" : undefined;
      const accepted = await first.operations.create(
        input,
        "one-generation",
        undefined,
        undefined,
        requestKind,
      );
      await vi.waitFor(
        () =>
          expect(["queued", "running"]).not.toContain(first.operations.inspect(accepted.id).state),
        { timeout: 10_000, interval: 5 },
      );
      // Check the received bytes and the one invocation even on the unchanged negative.
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(fault.active).toBe(true);
      expect(first.operations.inspect(accepted.id)).toMatchObject({
        state: "succeeded",
        dispatch: { state: "response_received" },
        response: { state: "ready" },
        problem: null,
      });
      const result = first.operations.readResult(accepted.id);
      expect(result.bytes).toEqual(
        Buffer.from(JSON.stringify(kind === "image" ? imageResult : textResult)),
      );
      expect(result.sha256).toBe(`sha256:${sha256Hex(result.bytes)}`);
      expect(
        (await first.operations.create(input, "one-generation", undefined, undefined, requestKind))
          .id,
      ).toBe(accepted.id);
      expect(first.operations.readResult(accepted.id)).toEqual(result);
      expect(fault.reads).toEqual([]);
      expect(vi.mocked(fs.readdirSync).mock.calls.filter(([path]) => String(path) === dir)).toEqual(
        [],
      );
      await first.close();
      const second = await serve(root, adapter);
      expect(second.operations.readResult(accepted.id)).toEqual(result);
      expect(
        (await second.operations.create(input, "one-generation", undefined, undefined, requestKind))
          .id,
      ).toBe(accepted.id);
      expect(second.operations.acknowledge(accepted.id, result.sha256).response.state).toBe(
        "acknowledged",
      );
      expect(() => second.operations.readResult(accepted.id)).toThrow(
        expect.objectContaining({ code: "model_result_released" }),
      );
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(fault.reads).toEqual([]);
      fault.active = false;
      expect(fs.readFileSync(join(dir, "historical.json"))).toEqual(historical);
    },
  );
});
