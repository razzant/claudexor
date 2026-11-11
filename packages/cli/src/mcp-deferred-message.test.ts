import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@claudexor/schema", () => import("../../schema/src/index.js"));
vi.mock("./daemon-run.js", () => ({
  connectDaemonIfRunning: vi.fn(),
  ensureDaemon: vi.fn(),
  enqueueAndAwait: vi.fn(),
}));
vi.mock("./live.js", async (original) => ({
  ...(await original<object>()),
  controlApiFetch: vi.fn(),
}));
import { CapturedRunStart, ControlRunStartRequest } from "@claudexor/schema";
import { connectDaemonIfRunning, ensureDaemon } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";
import { boundedDeferredMessage, deferredMessageQuery } from "./mcp-deferred-message.js";
import { mcpSurfaceRunner } from "./mcp-runner.js";
import { deferredMessageTools } from "../../mcp-server/src/deferred-message-tools.js";
import { defaultClaudexorTools } from "../../mcp-server/src/index.js";
import { mcpToolFailure } from "../../mcp-server/src/tool-failure.js";
import { beltClaudexorTools } from "../../mcp-server/src/delegation-belt.js";
import { runWaitQuery } from "./mcp-run-wait.js";
import { projectImmediateRunDetail, projectRecoveryRunDetail } from "./mcp-run-projections.js";

const draft = {
  draftId: "draft-1",
  revision: 1,
  state: "waiting" as const,
  predecessorJobId: "job-1",
  predecessorRunId: "run-1",
  predecessorResult: "/v2/runs/run-1",
  hold: null,
  dispatchedRevision: null,
  successorJobId: null,
  successorRunId: null,
};
const call = {
  request: { action: "create", predecessorId: "job-1", prompt: "verify", attachments: [] },
  idempotencyKey: "stable",
};
afterEach(() => vi.resetAllMocks());
function connected(body: unknown) {
  vi.mocked(connectDaemonIfRunning).mockResolvedValue({
    addr: { baseUrl: "http://fixture", token: "fixture" },
  } as never);
  vi.mocked(controlApiFetch).mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  } as never);
}
describe("operator MCP next-message boundary", () => {
  it("projects waiting draft independently from terminal predecessor status/result/wait", async () => {
    const detail = {
      summary: { jobId: "job-1", runId: "run-1", state: "succeeded" },
      lastSeq: 0,
      pendingInteractions: [],
      deferredMessage: draft,
    };
    expect(projectImmediateRunDetail(detail)).toMatchObject({ deferredMessage: draft });
    expect(projectRecoveryRunDetail("__run_status", "job-1", detail)).toMatchObject({
      deferredMessage: draft,
    });
    expect(projectRecoveryRunDetail("__run_result", "job-1", detail)).toMatchObject({
      deferredMessage: draft,
    });
    connected(detail);
    expect(await runWaitQuery({ runId: "job-1", waitMs: 0 })).toMatchObject({
      status: "succeeded",
      wakeReason: "terminal",
      deferredMessage: { state: "waiting", successorJobId: null },
    });
    expect(controlApiFetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(controlApiFetch).mock.calls[0]![2]).toMatchObject({ method: "GET" });
  });
  it.each(["__next_message", "__next_message_read"])(
    "refuses %s on the actual belt runner before discovery or HTTP",
    async (mode) => {
      await expect(
        mcpSurfaceRunner({ delegationParentRunId: "parent" })({ mode, ...call }),
      ).rejects.toMatchObject({ code: "delegation_forbidden", status: 403 });
      await expect(
        deferredMessageQuery({ mode, ...call, delegatedFromRunId: "parent" }),
      ).rejects.toMatchObject({ code: "delegation_forbidden" });
      expect(connectDaemonIfRunning).not.toHaveBeenCalled();
      expect(controlApiFetch).not.toHaveBeenCalled();
      expect(ensureDaemon).not.toHaveBeenCalled();
    },
  );
  it("forwards complete actions and stable keys once, without start normalization", async () => {
    connected({ appliedRevision: 1, draft });
    expect(await mcpSurfaceRunner()({ mode: "__next_message", ...call })).toEqual({
      appliedRevision: 1,
      draft,
    });
    expect(controlApiFetch).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      "/runs/next-message",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": "stable" },
        body: JSON.stringify(call.request),
      }),
    );
    expect(ensureDaemon).not.toHaveBeenCalled();
  });
  it("refuses engine child targets using the daemon's typed HTTP verdict", async () => {
    connected({});
    vi.mocked(controlApiFetch).mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({
        code: "delegation_forbidden",
        message: "Delegate children cannot reserve work",
        retryable: false,
      }),
    } as never);
    const result = await deferredMessageTools(mcpSurfaceRunner())[0]!.handler(call, {});
    expect(result).toMatchObject({
      isError: true,
      structured: { failure: { code: "delegation_forbidden" } },
    });
  });
  it("bounds UTF-8 content and returns exact predecessor/result and full editing handles", async () => {
    const detail = {
      ...draft,
      prompt: "🙂".repeat(3000),
      attachments: [],
      capturedStart: ControlRunStartRequest.parse({ prompt: "verify" }),
      capturedAt: "2026-10-26T12:00:00.000Z",
    };
    const bounded = boundedDeferredMessage(detail);
    expect(Buffer.byteLength(bounded.promptPreview)).toBe(4096);
    expect(bounded.promptPreview).not.toContain("�");
    expect(bounded.promptBytes).toBe(12000);
    expect(bounded.omittedPromptBytes).toBe(7904);
    expect(bounded.draft.predecessorResult).toBe("/v2/runs/run-1");
    connected(detail);
    expect(await deferredMessageQuery({ mode: "__next_message_read", draftId: "draft-1" })).toEqual(
      bounded,
    );
    expect(bounded).not.toHaveProperty("capturedStart");
  });
  it("discloses the frozen controls by origin as captured, and none after clear", () => {
    const deferredDefaults = {
      harnesses: { codex: { default_model: "frozen-model", max_turns: 5 } },
      eligibleHarnesses: ["codex"],
      primaryHarness: null,
      authPreference: "auto" as const,
    };
    const capturedStart = CapturedRunStart.parse({
      mode: "agent",
      execution: { isolation: "envelope" },
      harnesses: ["codex"],
      models: { codex: "frozen-model" },
      promptCacheTtl: "1h",
      access: "workspace_write",
      web: "off",
      externalContextPolicy: "off",
      credentialProfileId: null,
      paidBudget: { kind: "finite", maxUsd: 2 },
      timeLimitMode: "soft",
      review: false,
      continueCarrier: "packet",
      routingGoal: "economy",
      continueFrom: "run-1",
      continueModelInherited: true,
      deferredDefaults,
    });
    const detail = {
      ...draft,
      prompt: "verify",
      attachments: [],
      capturedStart,
      capturedAt: "2026-10-26T12:00:00.000Z",
    };
    const { controls } = boundedDeferredMessage(detail);
    expect(controls).toEqual({
      capturedAt: "2026-10-26T12:00:00.000Z",
      inherited: {
        mode: "agent",
        scope: capturedStart.scope,
        execution: capturedStart.execution,
        harnesses: ["codex"],
        models: { codex: "frozen-model" },
        promptCacheTtl: "1h",
      },
      resolved: {
        access: "workspace_write",
        web: "off",
        externalContextPolicy: "off",
        credentialProfileId: null,
        paidBudget: { kind: "finite", maxUsd: 2 },
        timeLimitMode: "soft",
        review: false,
        continueCarrier: "packet",
        routingGoal: "economy",
      },
      settings: capturedStart.deferredDefaults,
    });
    expect(JSON.stringify(controls)).not.toContain("continueFrom");
    const cleared = boundedDeferredMessage({
      ...detail,
      state: "cleared",
      prompt: "",
      capturedStart: null,
      capturedAt: null,
    });
    expect(cleared.controls).toBeNull();
  });
  it("maps public Stop: a held draft, an accepted successor and no slot", async () => {
    const tool = defaultClaudexorTools(mcpSurfaceRunner()).find(
      (candidate) => candidate.name === "claudexor_run_cancel",
    )!;
    // The same failure projection buildMcpServer applies around every handler.
    const cancel = (args: Record<string, unknown>) => tool.handler(args, {}).catch(mcpToolFailure);
    const held = { ...draft, state: "held" as const, hold: { code: "stop_requested" as const } };
    connected({
      accepted: true,
      status: "applied",
      runId: "run-1",
      cascadeRunIds: [],
      message: "run is succeeded; cancel now holds its next message",
      deferredMessage: held,
    });
    expect(await mcpSurfaceRunner()({ mode: "__run_cancel", runId: "run-1" })).toEqual({
      summary: "run is succeeded; cancel now holds its next message (run run-1)",
      runId: "run-1",
      acknowledged: true,
      deferredMessage: held,
    });
    const accepted = {
      ...draft,
      state: "dispatched" as const,
      dispatchedRevision: 1,
      successorJobId: "job-2",
      successorRunId: "run-2",
    };
    const refusal = (status: number, body: Record<string, unknown>) =>
      vi.mocked(controlApiFetch).mockResolvedValue({
        ok: false,
        status,
        json: async () => ({ retryable: false, fieldErrors: {}, evidenceRefs: [], ...body }),
      } as never);
    refusal(409, {
      code: "next_message_dispatched",
      message:
        "run is succeeded; cancel has nothing to stop: its next message was already accepted as job job-2 (run run-2), which this cancel does not stop",
      requiredActions: ["Stop job job-2 to stop the successor."],
      context: { deferredMessage: accepted },
    });
    expect(await cancel({ runId: "run-1" })).toMatchObject({
      isError: true,
      text: expect.stringMatching(/^next_message_dispatched: .*job job-2 \(run run-2\)/),
      structured: {
        failure: {
          code: "next_message_dispatched",
          requiredActions: ["Stop job job-2 to stop the successor."],
          context: { deferredMessage: { state: "dispatched", successorJobId: "job-2" } },
        },
      },
    });
    refusal(409, {
      code: "http_409",
      message: "run is succeeded; cancel has nothing to stop",
      requiredActions: [],
      context: {},
    });
    expect(await cancel({ runId: "run-1" })).toMatchObject({
      isError: true,
      text: "http_409: run is succeeded; cancel has nothing to stop",
    });
  });
  it("advertises the two operator tools with schemas and excludes both from the Delegate belt", () => {
    const tools = deferredMessageTools(vi.fn());
    expect(tools.map((t) => t.name)).toEqual([
      "claudexor_next_message",
      "claudexor_next_message_read",
    ]);
    const belt = beltClaudexorTools(vi.fn(), {
      parentRunId: "p",
      repoRoot: "/tmp",
      depth: 0,
      maxSubRuns: 1,
      parentBudget: { kind: "finite", maxUsd: 1 },
    });
    expect(belt.some((t) => t.name.startsWith("claudexor_next_message"))).toBe(false);
  });
});
