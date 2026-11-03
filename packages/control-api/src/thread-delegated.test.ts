import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ControlThreadTurnRequest,
  SCHEMA_VERSION,
  Thread,
  type ControlRunStartRequest,
} from "@claudexor/schema";
import { resolveProducedRoot } from "./artifact-serve-routes.js";
import type { DaemonRunRecord } from "./daemon-server.js";
import { normalizeRunStart, normalizeRunStartRequest } from "./run-start.js";
import { handleThreadCreate, type ThreadCreateRouteCtx } from "./thread-create-route.js";
import {
  handleThreadLifecycleRoutes,
  type ThreadLifecycleRouteCtx,
} from "./thread-lifecycle-routes.js";
import { handleThreadTurnCreate, type ThreadTurnRouteCtx } from "./thread-turn-routes.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cx-delegated-api-"));
  roots.push(dir);
  return dir;
}

function delegatedThread(project: string, copy: string) {
  return Thread.parse({
    schema_version: SCHEMA_VERSION,
    id: "th-del",
    created_at: "2026-10-08T00:00:00Z",
    updated_at: "2026-10-08T00:00:00Z",
    repo: { root: project, base_ref: "HEAD" },
    mode: "agent",
    access: "full",
    workspace: { mode: "delegated", workspace_root: copy },
  });
}

function turnCtx(thread: unknown) {
  const enqueue = vi.fn(async (_params: unknown) => ({ id: "job-1" }));
  const createThreadTurn = vi.fn(async () => ({ id: "turn-1" }));
  const setTurnEnqueueError = vi.fn();
  const json = vi.fn();
  const ctx = {
    threadTurnChains: new Map(),
    threadDetail: async () => ({ thread, turns: [], sessions: [] }),
    createThreadTurn,
    setTurnEnqueueError,
    // The REAL shared normalizer, with the options the route passes.
    normalizeStart: normalizeRunStart,
    daemon: { enqueue, findAccepted: async () => null },
    waitForRunStart: async () => ({ id: "job-1", state: "queued" }),
    isTerminalState: () => false,
    json,
  } as unknown as ThreadTurnRouteCtx;
  return { ctx, enqueue, createThreadTurn, setTurnEnqueueError, json };
}

describe("delegated thread turns record their effective execution before acceptance", () => {
  it.each([
    ["agent", "live"],
    ["ask", "envelope"],
    ["plan", "envelope"],
  ] as const)(
    "%s turn carries the bound root under delegated authority",
    async (mode, isolation) => {
      const project = tempDir();
      const copy = tempDir();
      const { ctx, enqueue } = turnCtx(delegatedThread(project, copy));
      await handleThreadTurnCreate(
        ctx,
        {} as ServerResponse,
        "th-del",
        ControlThreadTurnRequest.parse({ prompt: "round 1", mode }),
        "key-1",
      );
      expect(enqueue).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          mode,
          threadId: "th-del",
          turnId: "turn-1",
          scope: expect.objectContaining({ kind: "project", root: project }),
          execution: expect.objectContaining({ delegated: true, isolation, workspaceRoot: copy }),
        }),
        // The idempotency digest still covers only the client's own request.
        expect.objectContaining({
          idempotencyRequest: {
            threadId: "th-del",
            body: expect.not.objectContaining({ execution: expect.anything() }),
          },
        }),
      );
    },
  );

  it("defers root availability to the durable job: a missing copy still yields a durable turn", async () => {
    const project = tempDir();
    const { ctx, enqueue, createThreadTurn, setTurnEnqueueError } = turnCtx(
      delegatedThread(project, join(tempDir(), "not-yet-there")),
    );
    await handleThreadTurnCreate(
      ctx,
      {} as ServerResponse,
      "th-del",
      ControlThreadTurnRequest.parse({ prompt: "round 2" }),
      "key-2",
    );
    expect(createThreadTurn).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(setTurnEnqueueError).not.toHaveBeenCalled();
  });

  it("refuses a per-turn envelope that contradicts the live binding", async () => {
    const { ctx, enqueue, json } = turnCtx(delegatedThread(tempDir(), tempDir()));
    await handleThreadTurnCreate(
      ctx,
      {} as ServerResponse,
      "th-del",
      ControlThreadTurnRequest.parse({ prompt: "x", execution: { isolation: "envelope" } }),
      "key-3",
    );
    expect(enqueue).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({ code: "thread_execution_conflict" }),
    );
  });

  it("leaves ordinary thread turns undelegated and rootless", async () => {
    const project = tempDir();
    const thread = Thread.parse({
      schema_version: SCHEMA_VERSION,
      id: "th-ord",
      created_at: "2026-10-08T00:00:00Z",
      updated_at: "2026-10-08T00:00:00Z",
      repo: { root: project, base_ref: "HEAD" },
    });
    const { ctx, enqueue } = turnCtx(thread);
    await handleThreadTurnCreate(
      ctx,
      {} as ServerResponse,
      "th-ord",
      ControlThreadTurnRequest.parse({ prompt: "x" }),
      "key-4",
    );
    const params = enqueue.mock.calls[0]?.[0] as ControlRunStartRequest;
    expect(params.execution.delegated).toBe(false);
    expect(params.execution.workspaceRoot).toBeUndefined();
  });
});

describe("per-turn auxiliary writable roots on a delegated thread", () => {
  const thread = (project: string, copy: string) =>
    Thread.parse({
      ...delegatedThread(project, copy),
      access: "workspace_write",
    });

  it("records each turn's own list beside the fixed binding; omission grants nothing", async () => {
    const project = tempDir();
    const copy = tempDir();
    const cache = tempDir();
    const first = turnCtx(thread(project, copy));
    await handleThreadTurnCreate(
      first.ctx,
      {} as ServerResponse,
      "th-del",
      ControlThreadTurnRequest.parse({
        prompt: "round 1",
        mode: "agent",
        execution: { auxiliaryWritableRoots: [cache] },
      }),
      "key-aux-1",
    );
    expect(first.enqueue.mock.calls[0]?.[0]).toMatchObject({
      access: "workspace_write",
      execution: {
        delegated: true,
        isolation: "live",
        workspaceRoot: copy,
        auxiliaryWritableRoots: [cache],
      },
    });
    const second = turnCtx(thread(project, copy));
    await handleThreadTurnCreate(
      second.ctx,
      {} as ServerResponse,
      "th-del",
      ControlThreadTurnRequest.parse({ prompt: "round 2", mode: "agent" }),
      "key-aux-2",
    );
    const params = second.enqueue.mock.calls[0]?.[0] as ControlRunStartRequest;
    expect(params.execution).toMatchObject({ delegated: true, workspaceRoot: copy });
    expect(params.execution).not.toHaveProperty("auxiliaryWritableRoots");
  });

  it("refuses a grant on a read-only turn instead of clamping it away", async () => {
    const { ctx, enqueue, json } = turnCtx(thread(tempDir(), tempDir()));
    await handleThreadTurnCreate(
      ctx,
      {} as ServerResponse,
      "th-del",
      ControlThreadTurnRequest.parse({
        prompt: "look",
        mode: "ask",
        execution: { auxiliaryWritableRoots: [tempDir()] },
      }),
      "key-aux-3",
    );
    expect(enqueue).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({ code: "auxiliary_writable_roots_access_conflict" }),
    );
  });
});

describe("shared normalizer: the narrow delegated root allowance", () => {
  it("accepts a delegated read-only root and refuses it without delegated authority", () => {
    const project = tempDir();
    const copy = tempDir();
    for (const mode of ["ask", "plan"] as const) {
      expect(
        normalizeRunStartRequest({
          prompt: "q",
          mode,
          scope: { kind: "project", root: project },
          execution: { delegated: true, workspaceRoot: copy },
        }).execution.workspaceRoot,
      ).toBe(copy);
      expect(() =>
        normalizeRunStartRequest({
          prompt: "q",
          mode,
          scope: { kind: "project", root: project },
          execution: { workspaceRoot: copy },
        }),
      ).toThrow(expect.objectContaining({ code: "execution_workspace_invalid" }));
    }
  });

  it("defers existence only when asked, never the absolute-path rule", () => {
    const project = tempDir();
    const request = {
      prompt: "q",
      mode: "agent",
      scope: { kind: "project", root: project },
      execution: { delegated: true, isolation: "live", workspaceRoot: join(project, "gone") },
      access: "full",
    };
    expect(() => normalizeRunStartRequest(request)).toThrow(/does not exist/);
    expect(
      normalizeRunStartRequest(request, { deferExecutionWorkspaceAvailability: true }).execution
        .workspaceRoot,
    ).toBe(join(project, "gone"));
    expect(() =>
      normalizeRunStartRequest(
        { ...request, execution: { ...request.execution, workspaceRoot: "relative" } },
        { deferExecutionWorkspaceAvailability: true },
      ),
    ).toThrow(/absolute path/);
  });
});

function createCtx(services: ThreadCreateRouteCtx["services"], body: unknown) {
  const json = vi.fn();
  const requestError = vi.fn();
  const ctx: ThreadCreateRouteCtx = {
    services,
    readBody: async () => body,
    json,
    requestError,
  };
  const req = { headers: { "idempotency-key": "seat-thread" } } as unknown as IncomingMessage;
  return { ctx, req, json, requestError };
}

describe("POST /v2/threads delegated creation", () => {
  it.each([
    [{ workspace: "delegated" }, "required"],
    [{ workspaceRoot: "/x" }, "only with workspace='delegated'"],
  ])("refuses the incoherent shape %o", async (extra, message) => {
    const createThread = vi.fn();
    const { ctx, req, requestError } = createCtx(
      { createThread },
      { scope: { kind: "project", root: tempDir() }, ...extra },
    );
    await handleThreadCreate(ctx, req, {} as ServerResponse);
    expect(createThread).not.toHaveBeenCalled();
    expect(requestError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        code: "thread_workspace_invalid",
        message: expect.stringContaining(message),
      }),
    );
  });

  it("refuses a no-project delegated thread and a missing or relative root", async () => {
    for (const body of [
      { workspace: "delegated", workspaceRoot: tempDir() },
      { scope: { kind: "project", root: tempDir() }, workspace: "delegated", workspaceRoot: "rel" },
      {
        scope: { kind: "project", root: tempDir() },
        workspace: "delegated",
        workspaceRoot: join(tempDir(), "missing"),
      },
    ]) {
      const createThread = vi.fn();
      const { ctx, req, requestError } = createCtx({ createThread }, body);
      await handleThreadCreate(ctx, req, {} as ServerResponse);
      expect(createThread).not.toHaveBeenCalled();
      expect(requestError).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ code: "thread_workspace_invalid", status: 400 }),
      );
    }
  });

  it("creates with the exact spelling and returns the accepted thread on replay before path checks", async () => {
    const project = tempDir();
    const copy = tempDir();
    const body = {
      scope: { kind: "project", root: project },
      workspace: "delegated",
      workspaceRoot: copy,
      access: "full",
    };
    const stored = delegatedThread(project, copy);
    const createThread = vi.fn(async () => stored);
    const first = createCtx({ createThread, findThreadCreation: async () => null }, body);
    await handleThreadCreate(first.ctx, first.req, {} as ServerResponse);
    expect(createThread).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: project, workspace: "delegated", workspaceRoot: copy }),
    );
    expect(first.json).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({ workspaceMode: "delegated", workspaceRoot: copy }),
    );
    // Both paths disappear; the exact replay still recovers the original
    // thread (no filesystem admission runs before the durable lookup).
    rmSync(copy, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    const createAgain = vi.fn();
    const findThreadCreation = vi.fn(async () => stored);
    const replay = createCtx({ createThread: createAgain, findThreadCreation }, body);
    await handleThreadCreate(replay.ctx, replay.req, {} as ServerResponse);
    expect(findThreadCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: project,
        idempotency: expect.objectContaining({ key: "seat-thread" }),
      }),
    );
    expect(createAgain).not.toHaveBeenCalled();
    expect(replay.json).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({ id: "th-del", workspaceRoot: copy }),
    );
  });
});

describe("delegated thread Apply refusal", () => {
  it("refuses before reading command history or attempting delivery", async () => {
    const thread = delegatedThread(tempDir(), tempDir());
    const applyThread = vi.fn();
    const listRuns = vi.fn();
    const requestError = vi.fn();
    const ctx = {
      turnCtx: { threadTurnChains: new Map() },
      services: {
        threadDetail: async () => ({ thread, turns: [], sessions: [] }),
        applyThread,
      },
      requiredIdempotencyKey: () => "apply-delegated",
      readBody: async () => ({ mode: "apply" }),
      listRuns,
      requestError,
    } as unknown as ThreadLifecycleRouteCtx;

    expect(
      await handleThreadLifecycleRoutes(
        ctx,
        "POST",
        "/threads/th-del/apply",
        {} as IncomingMessage,
        {} as ServerResponse,
      ),
    ).toBe(true);
    expect(requestError).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ status: 400, code: "thread_workspace_caller_owned" }),
    );
    expect(listRuns).not.toHaveBeenCalled();
    expect(applyThread).not.toHaveBeenCalled();
  });
});

describe("/produced resolves the caller-owned execution address", () => {
  const record = (params: Record<string, unknown>): DaemonRunRecord => ({
    id: "job-1",
    runId: "run-1",
    state: "succeeded",
    params,
  });

  it("serves the recorded delegated root, never the stable project", async () => {
    const project = tempDir();
    const copy = tempDir();
    const rec = record({
      scope: { kind: "project", root: project },
      execution: { delegated: true, isolation: "live", workspaceRoot: copy },
      threadId: "th-del",
    });
    expect(
      await resolveProducedRoot(rec, async () => ({ mode: "delegated", worktreePath: copy })),
    ).toEqual({
      kind: "root",
      root: copy,
    });
    rmSync(copy, { recursive: true, force: true });
    expect(await resolveProducedRoot(rec)).toEqual({
      kind: "worktree_unavailable",
      threadId: "th-del",
      reason: "worktree_missing",
      callerOwned: true,
    });
  });

  it("covers a one-shot delegated run's recorded root too", async () => {
    const project = tempDir();
    const copy = tempDir();
    expect(
      await resolveProducedRoot(
        record({
          scope: { kind: "project", root: project },
          execution: { delegated: true, isolation: "live", workspaceRoot: copy },
        }),
      ),
    ).toEqual({ kind: "root", root: copy });
  });
});
