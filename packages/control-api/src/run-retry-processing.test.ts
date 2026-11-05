import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRunRetryRoute, type RunRetryRouteContext } from "./run-retry-routes.js";
import type { DaemonRunRecord } from "./daemon-server.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)
function fixture(explicit?: "standard" | "fast") {
  const root = mkdtempSync(join(tmpdir(), "retry-processing-"));
  roots.push(root);
  mkdirSync(join(root, "context"));
  writeFileSync(
    join(root, "context", "task.yaml"),
    [
      "schema_version: 2",
      "task_id: task-source",
      "created_at: 2026-09-12T00:00:00.000Z",
      "repo:",
      `  root: ${JSON.stringify(root)}`,
      "  base_ref: HEAD",
      "mode:",
      "  kind: agent",
      "user_intent:",
      "  raw: work",
      "processing_preference: standard",
      "tests:",
      "  commands: []",
      "",
    ].join("\n"),
  );
  const source = {
    id: "source-job",
    runId: "source",
    runDir: root,
    state: "succeeded",
    params: {
      prompt: "work",
      mode: "agent",
      scope: { kind: "project", root },
      execution: { isolation: "envelope", workspaceKind: "directory", scopePaths: ["chosen"] },
      ...(explicit ? { processingPreference: explicit } : {}),
    },
  } as DaemonRunRecord;
  const enqueue = vi.fn(async (_params: unknown) => ({ id: "retry-job" }));
  const findAccepted = vi.fn(async (): Promise<DaemonRunRecord | null> => null);
  const json = vi.fn();
  const preflight = vi.fn(async () => {});
  const ctx = {
    daemon: { enqueue, findAccepted } as unknown as RunRetryRouteContext["daemon"],
    findRun: async () => source,
    waitForRunStart: async () => ({ id: "retry-job", runId: "retry", state: "running" }),
    serializeThreadMutation: async (_id, work) => work(),
    json,
    requestError: (_res, error) => {
      throw error;
    },
    services: { preflightRunRequirements: preflight },
  } as RunRetryRouteContext;
  const req = { headers: { "idempotency-key": "exact-retry" } } as unknown as IncomingMessage;
  return { ctx, req, enqueue, findAccepted, json, preflight, source };
}

describe("exact retry processing custody", () => {
  it.each([true, false])(
    "omits internal continuation model provenance from an editable draft (%s)",
    async (inherited) => {
      const f = fixture();
      f.source.params = {
        ...(f.source.params as object),
        continueFrom: "predecessor",
        continueModelInherited: inherited,
        model: "selected",
      };
      await handleRunRetryRoute(
        f.ctx,
        "GET",
        "/runs/source/run-again",
        f.req,
        {} as ServerResponse,
      );
      const draft = f.json.mock.calls[0]?.[2];
      expect(draft.request).toHaveProperty("model", "selected");
      expect(draft.request).not.toHaveProperty("continueModelInherited");
      expect(draft.differences).toContainEqual({
        field: "continueModelInherited",
        change: "omitted",
        reason: "model intent is resolved from the edited request",
      });
    },
  );
  it.each([undefined, "fast"] as const)(
    "preserves original processing and scope (explicit=%s)",
    async (explicit) => {
      const f = fixture(explicit);
      await handleRunRetryRoute(f.ctx, "POST", "/runs/source/retry", f.req, {} as ServerResponse);
      expect(f.enqueue.mock.calls[0]?.[0]).toMatchObject({
        processingPreference: explicit ?? "standard",
        execution: { workspaceKind: "directory", scopePaths: ["chosen"] },
        retryOf: "source",
      });
    },
  );
  it("rejoins an accepted retry before rerunning preparation or dispatch", async () => {
    const f = fixture();
    f.findAccepted.mockResolvedValue({
      id: "retry-job",
      runId: "retry",
      state: "running",
      params: { processingPreference: "standard" },
    } as DaemonRunRecord);
    await handleRunRetryRoute(f.ctx, "POST", "/runs/source/retry", f.req, {} as ServerResponse);
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.preflight).not.toHaveBeenCalled();
    expect(f.json.mock.calls[0]?.[2]).toMatchObject({ runId: "retry", retryOf: "source" });
  });
});

/** A thread run's Exact Retry; `recorded` is its recovery turn left before a first enqueue. */
function threadRetry(recorded: { id: string } | null) {
  const f = fixture();
  f.source.params = { ...(f.source.params as object), threadId: "th-1", turnId: "tn-source" };
  const turns: unknown[] = [
    { id: "tn-source", run_id: "source", attachments: [{ resource_id: "res-1" }] },
    ...(recorded ? [{ id: recorded.id, run_id: null }] : []),
  ];
  const validateResources = vi.fn(async (_refs: unknown, _heldBy?: unknown) => {});
  const createThreadTurn = vi.fn(async () => ({ id: "tn-new" }));
  const findThreadTurnByIdempotency = vi.fn(async () => recorded);
  f.ctx.services = {
    preflightRunRequirements: f.preflight,
    validateResources,
    createThreadTurn,
    findThreadTurnByIdempotency,
    threadDetail: async () => ({ thread: { id: "th-1", state: "active" }, sessions: [], turns }),
    setTurnEnqueueError: vi.fn(),
  } as unknown as RunRetryRouteContext["services"];
  Object.assign(f.ctx.daemon, { list: vi.fn(async () => []) });
  return { ...f, validateResources, createThreadTurn, findThreadTurnByIdempotency };
}

describe("Exact Retry whose recovery turn was recorded before its first enqueue (#249)", () => {
  const refs = [{ resourceId: "res-1" }];
  it("repeats as that recorded turn: its refs resolve as their holder and it is dispatched", async () => {
    const f = threadRetry({ id: "tn-retry" });
    await handleRunRetryRoute(f.ctx, "POST", "/runs/source/retry", f.req, {} as ServerResponse);
    const holder = { owner: "turn", id: "tn-retry" };
    expect(f.findThreadTurnByIdempotency).toHaveBeenCalledWith("th-1", {
      key: "exact-retry",
      client: "control-api",
      request: { retryOf: "source" },
    });
    expect(f.validateResources).toHaveBeenCalledWith(refs, holder);
    expect(f.preflight).toHaveBeenCalledWith(
      expect.objectContaining({ retryOf: "source" }),
      holder,
    );
    expect(f.createThreadTurn).not.toHaveBeenCalled();
    expect(f.enqueue.mock.calls[0]?.[0]).toMatchObject({ turnId: "tn-retry", attachments: refs });
  });

  it("keeps a fresh Exact Retry a new reference with no holder", async () => {
    const f = threadRetry(null);
    await handleRunRetryRoute(f.ctx, "POST", "/runs/source/retry", f.req, {} as ServerResponse);
    expect(f.validateResources).toHaveBeenCalledWith(refs, undefined);
    expect(f.preflight).toHaveBeenCalledWith(
      expect.objectContaining({ retryOf: "source" }),
      undefined,
    );
    expect(f.createThreadTurn).toHaveBeenCalledTimes(1);
    expect(f.enqueue.mock.calls[0]?.[0]).toMatchObject({ turnId: "tn-new" });
  });

  it("refuses a changed request under the key before any resource is read", async () => {
    const f = threadRetry(null);
    f.findThreadTurnByIdempotency.mockRejectedValueOnce(
      Object.assign(new Error("idempotency key was already used with a different request"), {
        code: "idempotency_conflict",
        status: 409,
      }),
    );
    await expect(
      handleRunRetryRoute(f.ctx, "POST", "/runs/source/retry", f.req, {} as ServerResponse),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(f.validateResources).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  });
});
