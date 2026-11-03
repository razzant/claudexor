import { describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import {
  ControlRunStartRequest,
  ControlThreadTurnRequest,
  SCHEMA_VERSION,
  Thread,
} from "@claudexor/schema";
import type { DaemonRunRecord } from "./daemon-server.js";
import { inspectThreadTurnCreateReplay, resolveThreadRecoveryTurn } from "./thread-recovery.js";
import { handleThreadTurnCreate, type ThreadTurnRouteCtx } from "./thread-turn-routes.js";

const source: DaemonRunRecord = {
  id: "job-source",
  runId: "run-source",
  state: "succeeded",
  params: { threadId: "th-1", turnId: "tn-source" },
};

const idempotency = {
  key: "same-key",
  client: "control-api",
  request: { retryOf: "run-source" },
};

describe("thread recovery admission", () => {
  it.each([
    ["ask", undefined, "ask"],
    ["plan", undefined, "plan"],
    ["agent", undefined, "agent"],
    ["agent", "ask", "ask"],
    ["ask", "plan", "plan"],
    ["plan", "agent", "agent"],
  ] as const)(
    "resolves persisted %s with turn override %s as %s",
    async (stored, override, expected) => {
      const thread = Thread.parse({
        schema_version: SCHEMA_VERSION,
        id: "thread-mode",
        mode: stored,
        created_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-10-01T00:00:00Z",
        repo: { root: "/tmp/thread-mode-project", base_ref: "HEAD" },
      });
      const enqueue = vi.fn(async () => ({ id: "job-mode" }));
      const json = vi.fn();
      const ctx = {
        threadTurnChains: new Map(),
        threadDetail: async () => ({ thread, turns: [], sessions: [] }),
        createThreadTurn: async () => ({ id: "turn-mode" }),
        normalizeStart: (request: ControlRunStartRequest) => request,
        daemon: { enqueue, findAccepted: async () => null },
        waitForRunStart: async () => ({ id: "job-mode", state: "queued" }),
        isTerminalState: () => false,
        json,
      } as unknown as ThreadTurnRouteCtx;
      const request = ControlThreadTurnRequest.parse({
        prompt: "Continue",
        ...(override ? { mode: override } : {}),
      });
      await handleThreadTurnCreate(ctx, {} as ServerResponse, thread.id, request, "mode-key");
      expect(enqueue).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          mode: expected,
          threadId: thread.id,
          turnId: "turn-mode",
          execution: expect.objectContaining({
            isolation: expected === "agent" ? "live" : "envelope",
          }),
        }),
        expect.objectContaining({ idempotencyKey: "mode-key" }),
      );
      expect(json).toHaveBeenCalledWith(
        expect.anything(),
        202,
        expect.objectContaining({ turnId: "turn-mode" }),
      );
      expect(thread.mode).toBe(stored);
    },
  );

  it("refuses a runless idempotent turn after the conversation moved on", async () => {
    const list = vi.fn(async () => []);
    const createThreadTurn = vi.fn();

    await expect(
      resolveThreadRecoveryTurn(
        { list },
        {
          findThreadTurnByIdempotency: async () => ({ id: "tn-orphan" }),
          createThreadTurn,
          threadDetail: async () => ({
            thread: {},
            sessions: [],
            turns: [{ id: "tn-orphan" }, { id: "tn-newer" }],
          }),
        },
        source,
        "th-1",
        "retry",
        {},
        idempotency,
        async () => null,
      ),
    ).rejects.toMatchObject({ code: "thread_turn_not_latest", status: 409 });
    expect(list).not.toHaveBeenCalled();
    expect(createThreadTurn).not.toHaveBeenCalled();
  });

  it("returns the original accepted handle even after the conversation moved on", async () => {
    const list = vi.fn(async () => {
      throw new Error("idle state must not replace an accepted replay");
    });
    const threadDetail = vi.fn();

    await expect(
      resolveThreadRecoveryTurn(
        { list },
        {
          findThreadTurnByIdempotency: async () => ({ id: "tn-original" }),
          createThreadTurn: vi.fn(),
          threadDetail,
        },
        source,
        "th-1",
        "retry",
        {},
        idempotency,
        async () => ({ id: "job-original" }),
      ),
    ).resolves.toEqual({ id: "tn-original" });
    expect(threadDetail).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("refuses a bound recovery turn after its accepted command was retained away", async () => {
    await expect(
      resolveThreadRecoveryTurn(
        { list: async () => [] },
        {
          findThreadTurnByIdempotency: async () => ({ id: "tn-bound" }),
          createThreadTurn: vi.fn(),
          threadDetail: async () => ({
            thread: {},
            sessions: [],
            turns: [{ id: "tn-bound", run_id: "run-original" }],
          }),
        },
        source,
        "th-1",
        "retry",
        {},
        idempotency,
        async () => null,
      ),
    ).rejects.toMatchObject({ code: "thread_turn_already_bound", status: 409 });
  });

  it("refuses a bound ordinary turn after its accepted command was retained away", async () => {
    await expect(
      inspectThreadTurnCreateReplay(
        {
          findAccepted: async () => null,
        },
        {
          findThreadTurnByIdempotency: async () => ({ id: "tn-bound" }),
          threadDetail: async () => ({
            thread: {},
            sessions: [],
            turns: [{ id: "tn-bound", run_id: "run-original" }],
          }),
        },
        "th-1",
        { ...idempotency, request: { threadId: "th-1", body: { prompt: "old" } } },
      ),
    ).rejects.toMatchObject({ code: "thread_turn_already_bound", status: 409 });
  });
});

describe("a purged thread's recovery", () => {
  it("refuses an unaccepted recovery turn of a purged thread before anything is admitted", async () => {
    const list = vi.fn(async () => []);
    const createThreadTurn = vi.fn();
    await expect(
      resolveThreadRecoveryTurn(
        { list },
        {
          findThreadTurnByIdempotency: async () => ({ id: "tn-orphan" }),
          createThreadTurn,
          threadDetail: async () => ({
            thread: { state: "purged" },
            sessions: [],
            turns: [{ id: "tn-orphan", run_id: null }],
          }),
        },
        source,
        "th-1",
        "retry",
        {},
        idempotency,
        async () => null,
      ),
    ).rejects.toMatchObject({ code: "thread_purged", status: 409, retryable: false });
    expect(list).not.toHaveBeenCalled();
    expect(createThreadTurn).not.toHaveBeenCalled();
  });

  it("still returns the turn of a recovery the engine accepted before the purge", async () => {
    const threadDetail = vi.fn();
    await expect(
      resolveThreadRecoveryTurn(
        { list: vi.fn() },
        {
          findThreadTurnByIdempotency: async () => ({ id: "tn-original" }),
          createThreadTurn: vi.fn(),
          threadDetail,
        },
        source,
        "th-1",
        "retry",
        {},
        idempotency,
        async () => ({ id: "job-original" }),
      ),
    ).resolves.toEqual({ id: "tn-original" });
    expect(threadDetail).not.toHaveBeenCalled();
  });
});
