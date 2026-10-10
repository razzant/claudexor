import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CredentialProfile, ModelCallRequest, type ModelPayloadRef } from "@claudexor/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexModelAdapter } from "../../../harness-codex/src/model.js";
import { CODEX_HTTP_CLIENT_VERSION } from "../../../harness-codex/src/http-client-version.js";
import { AccountResets } from "../account-resets.js";
import { ModelOperations, type ModelPayloadStore } from "../model-operations.js";
import { BlobFiles } from "./blob-files.js";
import { SqlCommandStore } from "./commands.js";
import { SqlCommandPruner } from "./command-prune.js";
import { SqlCommandQueries } from "./command-queries.js";
import { Obligations } from "./obligations.js";
import { createPartition } from "./partitions.js";
import { EngineStore } from "./store.js";
import { SqlTerminalFiles } from "./terminal-files.js";

const NOW = "2026-10-10T00:00:00.000Z";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cx-q2-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: resolve(import.meta.dirname, "../../dist/store/flusher-worker.js"),
    flusherHooks: { manualTick: true, allowExit: true },
    now: () => new Date(NOW),
  });
  cleanup.push(() => store.close());
  const generation = store.transaction(() => createPartition(store, "global")),
    blobs = new BlobFiles(store),
    obligations = new Obligations(store);
  const commands = new SqlCommandStore(store, blobs, generation, {
    isLive: () => true,
    obligations,
    terminalFiles: new SqlTerminalFiles(store, obligations),
    pruner: new SqlCommandPruner(store, blobs),
  });
  return { root, store, commands, queries: new SqlCommandQueries(store, blobs) };
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
function resources(): ModelPayloadStore {
  const bodies = new Map<string, { ref: ModelPayloadRef; bytes: Buffer; createdAt: string }>();
  let next = 0;
  return {
    publishModel(bytes) {
      const ref = {
        resourceId: `resource-${++next}`,
        sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        sizeBytes: bytes.byteLength,
      };
      bodies.set(ref.resourceId, { ref, bytes: Buffer.from(bytes), createdAt: NOW });
      return ref;
    },
    readModel(ref) {
      const row = bodies.get(ref.resourceId);
      if (!row) throw new Error("released payload");
      expect(row.ref).toEqual(ref);
      return row.bytes;
    },
    releaseModel(ref) {
      bodies.delete(ref.resourceId);
    },
    listModelResources() {
      return [...bodies.values()].map((row) => ({ ...row.ref, createdAt: row.createdAt }));
    },
  };
}

describe("Q2 model dispatch", () => {
  it.each(["success", "worker_exit"] as const)(
    "the real Codex adapter sends only after a proved barrier (%s)",
    async (mode) => {
      const f = await fixture(),
        payloads = resources();
      let posts = 0,
        enqueues = 0;
      const token = `fixture.${Buffer.from(JSON.stringify({ exp: 2100000000 })).toString("base64url")}.signature`;
      const adapter = createCodexModelAdapter({
        now: () => Date.parse(NOW),
        clientVersion: async () => ({
          version: CODEX_HTTP_CLIENT_VERSION,
          source: "verified_transport",
        }),
        readAuthFile: async () =>
          JSON.stringify({
            auth_mode: "chatgpt",
            tokens: {
              account_id: "fixture-account",
              access_token: token,
              refresh_token: "fixture-unused",
              id_token: `fixture.${Buffer.from('{"sub":"fixture-user"}').toString("base64url")}.signature`,
            },
          }),
        fetch: async (_url, init) => {
          if (init?.method !== "POST")
            return Response.json({
              models: [
                {
                  slug: "fixture-model",
                  display_name: "Fixture",
                  visibility: "list",
                  supported_reasoning_levels: [{ effort: "medium" }],
                  default_reasoning_level: "medium",
                  input_modalities: ["text"],
                },
              ],
            });
          posts++;
          await new Response(init.body).text();
          return new Response(
            `data: ${JSON.stringify({ type: "response.completed", response: { model: "fixture-model", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }], usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
          );
        },
      });
      const profile = CredentialProfile.parse({
        profile_id: "fixture",
        harness_id: "codex",
        display_name: "Fixture",
        credential_kind: "config_dir_login",
        isolation_locator: join(process.env.CLAUDEXOR_CONFIG_DIR!, "profiles", "fixture"),
      });
      const operations = new ModelOperations({
        commands: {
          current: () => f.commands,
          findById: (id) => (f.commands.get(id) ? f.commands : undefined),
        },
        resourceQueries: f.queries,
        resources: () => payloads,
        now: () => new Date(NOW),
        resolve: async () => ({ adapter, profile }),
        cancel: async () => undefined,
        enqueue: async (envelope) => {
          enqueues++;
          return {
            id: f.commands.accept({
              id: "model-op",
              params: envelope.request,
              idempotencyParams: envelope.idempotencyRequest,
              idempotencyKey: envelope.idempotencyKey,
              clientId: envelope.clientId,
              operation: envelope.operation,
            }).record.id,
          };
        },
      });
      cleanup.push(() => operations.close());
      const request = ModelCallRequest.parse({
        source: "codex",
        model: "fixture-model",
        account: { mode: "pin", profileId: "fixture" },
        messages: [{ role: "user", content: "One generation only" }],
      });
      const ref = payloads.publishModel(Buffer.from(JSON.stringify(request)));
      const detail = await operations.create(ref, "q2-key");
      f.commands.update(detail.id, { state: "running" });
      let early: unknown;
      const executing = operations
        .execute(f.commands.get(detail.id)!.params, {
          jobId: detail.id,
          signal: new AbortController().signal,
          onRunStart: () => undefined,
        })
        .then((value) => {
          early = value;
          return value;
        });
      await vi.waitFor(() =>
        expect(f.store.facts().flusher.pending_waiters, JSON.stringify(early)).toBe(1),
      );
      expect(posts).toBe(0);
      expect(operations.inspect(detail.id).dispatch).toMatchObject({
        state: "started",
        startedAt: NOW,
        route: { model: "fixture-model", credentialProfileId: "fixture" },
      });
      if (mode === "success") await pass(f.store);
      else f.store.flusherControl.requestExit(17);
      const receipt = await executing;
      f.commands.update(detail.id, { state: receipt.lifecycle, result: receipt, finishedAt: NOW });
      operations.onCommandTerminal(f.commands.get(detail.id)!);
      if (mode === "success") {
        expect(posts).toBe(1);
        expect(receipt.lifecycle).toBe("succeeded");
      } else {
        expect(posts).toBe(0);
        expect(receipt).toMatchObject({
          lifecycle: "failed",
          dispatch: { state: "not_started", startedAt: NOW, route: { model: "fixture-model" } },
          problem: { code: "store_flush_unavailable" },
        });
      }
      const generation = f.store.facts().flusher.generation;
      const replay = await operations.create(ref, "q2-key");
      expect(replay.id).toBe(detail.id);
      expect(enqueues).toBe(1);
      expect(posts).toBe(mode === "success" ? 1 : 0);
      expect(f.store.facts().flusher.generation).toBe(generation);
    },
  );
});

describe("Q2 account reset", () => {
  it.each(["success", "worker_exit"] as const)(
    "native consume waits for the intent barrier and failed barrier replays unavailable (%s)",
    async (mode) => {
      const f = await fixture();
      const consume = vi.fn(async () => ({ outcome: "reset" as const, detail: null }));
      const verify = vi.fn(async () => undefined),
        refresh = vi.fn(async () => {
          throw new Error("offline readback");
        });
      const operations = new AccountResets({
        commands: () => f.commands,
        now: () => new Date(NOW),
        resolve: async () => ({
          harness: "codex",
          locator: "/fixture",
          fingerprint: "fixture",
          program: "rate_limit_reset_credit",
          grant_id: null,
          native_request_id: "same-native-key",
        }),
        verify,
        consume,
        invalidate: () => undefined,
        refresh,
      });
      const input = {
        request: {
          target: { harness: "codex", profile_id: "fixture" },
          offer_id: "codex_granted",
          grant_id: "fixture-grant",
        },
        idempotencyKey: "reset-key",
        clientId: "fixture",
      };
      const executing = operations.create(input);
      await vi.waitFor(() => expect(f.store.facts().flusher.pending_waiters).toBe(1));
      expect(consume).not.toHaveBeenCalled();
      if (mode === "success") await pass(f.store);
      else f.store.flusherControl.requestExit(17);
      const receipt = await executing;
      expect(receipt.state).toBe("completed");
      if (mode === "success") {
        expect(consume).toHaveBeenCalledOnce();
        expect(receipt.outcome).toBe("reset");
      } else {
        expect(consume).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        expect(receipt).toMatchObject({
          outcome: "unavailable",
          detail: "store_flush_unavailable",
        });
      }
      const generation = f.store.facts().flusher.generation;
      expect(await operations.create(input)).toEqual(receipt);
      expect(verify).toHaveBeenCalledOnce();
      expect(f.store.facts().flusher.generation).toBe(generation);
      expect(f.store.prepare("SELECT count(*) AS n FROM command").get()).toEqual({ n: 1 });
    },
  );
});
