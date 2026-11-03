import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ControlRunStartRequest,
  ControlThreadTurnRequest,
  RecordedControlRunStartRequest,
  SCHEMA_VERSION,
  Thread,
} from "@claudexor/schema";
import { resolveContinuationBody } from "./run-continuation-start.js";
import { handleRunRetryRoute, type RunRetryRouteContext } from "./run-retry-routes.js";
import type { DaemonRunRecord } from "./daemon-server.js";
import { normalizeRunStart } from "./run-start.js";
import { handleThreadTurnCreate, type ThreadTurnRouteCtx } from "./thread-turn-routes.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

describe("promptCacheTtl request contract", () => {
  it("is an exact optional run and thread-turn control; unknown values fail loudly", () => {
    for (const promptCacheTtl of ["5m", "1h"]) {
      expect(ControlRunStartRequest.parse({ prompt: "x", promptCacheTtl }).promptCacheTtl).toBe(
        promptCacheTtl,
      );
      expect(ControlThreadTurnRequest.parse({ prompt: "x", promptCacheTtl }).promptCacheTtl).toBe(
        promptCacheTtl,
      );
    }
    expect(ControlRunStartRequest.parse({ prompt: "x" })).not.toHaveProperty("promptCacheTtl");
    for (const promptCacheTtl of ["2h", "1H", "", "default", 300, null]) {
      expect(ControlRunStartRequest.safeParse({ prompt: "x", promptCacheTtl }).success).toBe(false);
      expect(ControlThreadTurnRequest.safeParse({ prompt: "x", promptCacheTtl }).success).toBe(
        false,
      );
    }
  });
});

describe("a thread turn forwards the lifetime into its enqueued run", () => {
  it.each([
    ["1h", "1h"],
    ["5m", "5m"],
    ["Default", undefined],
  ] as const)("%s", async (label, promptCacheTtl) => {
    const root = mkdtempSync(join(tmpdir(), "turn-prompt-cache-"));
    roots.push(root);
    const thread = Thread.parse({
      schema_version: SCHEMA_VERSION,
      id: "th-ttl",
      created_at: "2026-10-21T00:00:00Z",
      updated_at: "2026-10-21T00:00:00Z",
      repo: { root, base_ref: "HEAD" },
    });
    const enqueue = vi.fn(async (_params: unknown) => ({ id: "job-1" }));
    const ctx = {
      threadTurnChains: new Map(),
      threadDetail: async () => ({ thread, turns: [], sessions: [] }),
      createThreadTurn: vi.fn(async () => ({ id: "turn-1" })),
      setTurnEnqueueError: vi.fn(),
      // The real shared run-start normalizer the route uses in production.
      normalizeStart: normalizeRunStart,
      daemon: { enqueue, findAccepted: async () => null },
      waitForRunStart: async () => ({ id: "job-1", state: "queued" }),
      isTerminalState: () => false,
      json: vi.fn(),
    } as unknown as ThreadTurnRouteCtx;
    await handleThreadTurnCreate(
      ctx,
      {} as ServerResponse,
      "th-ttl",
      ControlThreadTurnRequest.parse({
        prompt: "next",
        ...(promptCacheTtl ? { promptCacheTtl } : {}),
      }),
      `key-${label}`,
    );
    expect(enqueue).toHaveBeenCalledOnce();
    const params = enqueue.mock.calls[0]?.[0] as ControlRunStartRequest & { turnId?: string };
    expect(params).toMatchObject({ threadId: "th-ttl", turnId: "turn-1" });
    expect(params.promptCacheTtl).toBe(promptCacheTtl);
  });
});

const predecessorDaemon = (params: Record<string, unknown>) => ({
  async list() {
    return [{ id: "job-a", runId: "run-a", state: "failed", params }];
  },
});

describe("continueFrom inherits the captured lifetime", () => {
  it("a bare {continueFrom} body inherits the predecessor's value", async () => {
    const resolved = RecordedControlRunStartRequest.parse(
      await resolveContinuationBody(predecessorDaemon({ promptCacheTtl: "1h", mode: "agent" }), {
        continueFrom: "run-a",
      }),
    );
    expect(resolved).toMatchObject({ continueFrom: "run-a", promptCacheTtl: "1h" });
  });

  it("an explicit value in the continuation body wins", async () => {
    const resolved = await resolveContinuationBody(predecessorDaemon({ promptCacheTtl: "1h" }), {
      continueFrom: "run-a",
      promptCacheTtl: "5m",
    });
    expect(resolved).toMatchObject({ promptCacheTtl: "5m" });
  });

  it("a Default predecessor leaves the continuation on Default", async () => {
    const resolved = await resolveContinuationBody(predecessorDaemon({ mode: "agent" }), {
      continueFrom: "run-a",
    });
    expect(resolved).not.toHaveProperty("promptCacheTtl");
  });
});

function retryFixture(frozen: "5m" | "1h" | null, recorded: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "retry-prompt-cache-"));
  roots.push(root);
  mkdirSync(join(root, "context"));
  writeFileSync(
    join(root, "context", "task.yaml"),
    [
      "schema_version: 2",
      "task_id: task-source",
      "created_at: 2026-10-21T00:00:00.000Z",
      "repo:",
      `  root: ${JSON.stringify(root)}`,
      "  base_ref: HEAD",
      "mode:",
      "  kind: agent",
      "user_intent:",
      "  raw: work",
      ...(frozen ? [`prompt_cache_ttl: ${frozen}`] : []),
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
      execution: { isolation: "envelope" },
      ...recorded,
    },
  } as DaemonRunRecord;
  const enqueue = vi.fn(async (_params: unknown) => ({ id: "retry-job" }));
  const ctx = {
    daemon: {
      enqueue,
      findAccepted: vi.fn(async () => null),
    } as unknown as RunRetryRouteContext["daemon"],
    findRun: async () => source,
    waitForRunStart: async () => ({ id: "retry-job", runId: "retry", state: "running" }),
    serializeThreadMutation: async (_id, work) => work(),
    json: vi.fn(),
    requestError: (_res, error) => {
      throw error;
    },
    services: { preflightRunRequirements: vi.fn(async () => {}) },
  } as RunRetryRouteContext;
  const req = { headers: { "idempotency-key": "exact-retry" } } as unknown as IncomingMessage;
  return { ctx, req, enqueue };
}

describe("Exact Retry keeps the captured lifetime", () => {
  it.each([
    ["recorded explicit value", "1h", { promptCacheTtl: "1h" }, "1h"],
    ["frozen value of a request that omitted it", "1h", {}, "1h"],
    ["explicit recorded value over the frozen one", "1h", { promptCacheTtl: "5m" }, "5m"],
  ] as const)("replays the %s", async (_label, frozen, recorded, expected) => {
    const f = retryFixture(frozen, recorded);
    await handleRunRetryRoute(f.ctx, "POST", "/runs/source/retry", f.req, {} as ServerResponse);
    expect(f.enqueue.mock.calls[0]?.[0]).toMatchObject({
      promptCacheTtl: expected,
      retryOf: "source",
    });
  });

  it("a Default source retries on Default", async () => {
    const f = retryFixture(null, {});
    await handleRunRetryRoute(f.ctx, "POST", "/runs/source/retry", f.req, {} as ServerResponse);
    expect(f.enqueue.mock.calls[0]?.[0]).not.toHaveProperty("promptCacheTtl");
  });
});
