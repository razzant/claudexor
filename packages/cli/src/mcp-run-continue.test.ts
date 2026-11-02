import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTROL_STORE_IDENTITY_HEADER } from "@claudexor/schema";
import { runContinueQuery } from "./mcp-run-continue.js";
import { mcpSurfaceRunner } from "./mcp-runner.js";
import { connectDaemonIfRunning, enqueueAndAwait, ensureDaemon } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";

vi.mock("./daemon-run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./daemon-run.js")>()),
  connectDaemonIfRunning: vi.fn(),
  ensureDaemon: vi.fn(),
  enqueueAndAwait: vi.fn(),
}));
// Only the transport is faked; pure projection helpers stay real.
vi.mock("./live.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./live.js")>()),
  controlApiFetch: vi.fn(),
}));

function connected(body: unknown = { jobId: "job-s", state: "queued" }) {
  vi.mocked(connectDaemonIfRunning).mockResolvedValue({
    addr: { baseUrl: "http://fixture", token: "fixture" },
  } as never);
  vi.mocked(controlApiFetch).mockResolvedValue({
    ok: true,
    status: 202,
    json: async () => body,
  } as never);
}

describe("MCP sparse continuation query", () => {
  afterEach(() => vi.resetAllMocks());
  const taskGroupId = "11111111-1111-4111-8111-111111111111";
  const storeId = "22222222-2222-4222-8222-222222222222";

  it.each([
    ["an explicit continuation group", { taskGroupId }, { taskGroupId, storeId }],
    ["no group", {}, { storeId }],
  ] as const)(
    "forwards %s once and keeps the queued successor's accepted receipt",
    async (_name, group, receipt) => {
      connected({ jobId: "job-s", state: "queued", ...receipt });
      const result = await mcpSurfaceRunner()({
        mode: "__run_continue",
        runId: "run-p",
        ...group,
        idempotencyKey: "group-key",
      });
      expect(JSON.parse(String(vi.mocked(controlApiFetch).mock.calls[0]![2]!.body))).toEqual({
        continueFrom: "run-p",
        ...group,
      });
      expect(result).toMatchObject({ jobId: "job-s", runId: "", status: "queued", ...receipt });
      if (!("taskGroupId" in group)) expect(result).not.toHaveProperty("taskGroupId");
      expect(controlApiFetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["an explicit group", { taskGroupId }, { taskGroupId, storeId }],
    ["no group", {}, { storeId }],
  ] as const)(
    "carries %s and the accepting store through the ordinary MCP launch producer",
    async (_name, group, receipt) => {
      connected();
      vi.mocked(enqueueAndAwait).mockResolvedValue({
        jobId: "job-s",
        runId: "",
        runDir: "",
        status: "queued",
        ...receipt,
      } as Awaited<ReturnType<typeof enqueueAndAwait>>);
      const result = await mcpSurfaceRunner({ requireExistingDaemon: true })({
        mode: "agent",
        prompt: "work",
        repoPath: "/fixture",
        deferred: true,
        ...group,
      });
      expect(result).toMatchObject({ jobId: "job-s", ...receipt });
      const request = vi.mocked(enqueueAndAwait).mock.calls[0]?.[2];
      if ("taskGroupId" in group) {
        expect(request).toHaveProperty("taskGroupId", taskGroupId);
      } else {
        expect(request).not.toHaveProperty("taskGroupId");
        expect(result).not.toHaveProperty("taskGroupId");
      }
    },
  );

  it("keeps accepted pre-run failure metadata from server context", async () => {
    connected();
    vi.mocked(controlApiFetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({
          code: "fixture_pre_run_failure",
          message: "refused",
          retryable: false,
          context: { jobId: "job-f", state: "failed", taskGroupId, storeId },
        }),
      } as never)
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) } as never);
    expect(await runContinueQuery({ runId: "run-p", taskGroupId })).toMatchObject({
      jobId: "job-f",
      taskGroupId,
      storeId,
    });
  });

  it.each([undefined, "", "keep going"])(
    "posts only continuation fields with prompt %j, without runner defaults",
    async (prompt) => {
      connected();
      const result = await mcpSurfaceRunner()({
        mode: "__run_continue",
        runId: "run-p",
        ...(prompt !== undefined ? { prompt } : {}),
        idempotencyKey: "stable-key",
      });
      expect(controlApiFetch).toHaveBeenCalledExactlyOnceWith(expect.anything(), "/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [CONTROL_STORE_IDENTITY_HEADER]: "1",
          "Idempotency-Key": "stable-key",
        },
        body: JSON.stringify({
          continueFrom: "run-p",
          ...(prompt !== undefined ? { prompt } : {}),
        }),
      });
      expect(result).toMatchObject({ jobId: "job-s", runId: "", status: "queued" });
      expect(result).not.toHaveProperty("taskGroupId");
      expect(result).not.toHaveProperty("storeId");
      expect(enqueueAndAwait).not.toHaveBeenCalled();
      expect(ensureDaemon).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a daemon that names no store", {}],
    ["its accepting store", { storeId }],
  ] as const)(
    "returns bound run handles with %s, without polling or inventing lifecycle",
    async (_name, receipt) => {
      connected({
        jobId: "job-s",
        runId: "run-s",
        taskId: "task-s",
        runDir: "/fixture/run-s",
        ...receipt,
      });
      const result = await runContinueQuery({ runId: "run-p" });
      expect(result).toMatchObject({
        jobId: "job-s",
        runId: "run-s",
        runDir: "/fixture/run-s",
        ...receipt,
      });
      // Absent stays unknown: no store is claimed that the daemon did not name.
      if (!("storeId" in receipt)) expect(result).not.toHaveProperty("storeId");
      expect(result).not.toHaveProperty("taskGroupId");
      // No state read is available here: the lifecycle stays unknown, never assumed running.
      expect(result).toMatchObject({ status: "" });
      expect(result).not.toHaveProperty("state");
      expect(controlApiFetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { attachments: undefined },
    { attachments: [] },
    { attachments: [{ resourceId: "res-document" }] },
  ])(
    "preserves sparse attachment refs $attachments and the caller key/body on replay",
    async ({ attachments }) => {
      connected();
      const request = {
        mode: "__run_continue",
        runId: "run-p",
        prompt: "",
        idempotencyKey: "document-successor",
        ...(attachments === undefined ? {} : { attachments }),
      };
      const first = await mcpSurfaceRunner()(request);
      expect(await mcpSurfaceRunner()(request)).toEqual(first);
      const expected = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [CONTROL_STORE_IDENTITY_HEADER]: "1",
          "Idempotency-Key": request.idempotencyKey,
        },
        body: JSON.stringify({
          continueFrom: "run-p",
          prompt: "",
          ...(attachments === undefined ? {} : { attachments }),
        }),
      };
      expect(controlApiFetch).toHaveBeenCalledTimes(2);
      for (const call of vi.mocked(controlApiFetch).mock.calls) {
        expect(call[1]).toBe("/runs");
        expect(call[2]).toEqual(expected);
      }
      expect(ensureDaemon).not.toHaveBeenCalled();
      expect(enqueueAndAwait).not.toHaveBeenCalled();
    },
  );

  it("forwards explicit successor controls verbatim and omits absent ones", async () => {
    connected();
    const controls = {
      access: "readonly",
      web: "off",
      externalContextPolicy: "off",
      credentialProfileId: "codex-work",
      paidBudget: { kind: "finite", maxUsd: 0 },
      maxSeconds: 600,
      timeLimitMode: "soft",
      review: true,
      reviewerPanel: [{ harness: "claude" }],
      reviewerModels: { anthropic: "fixture-model" },
      reviewerEfforts: { openai: "high" },
      continueCarrier: "packet",
    };
    await runContinueQuery({ runId: "run-p", prompt: "", ...controls, idempotencyKey: "k" });
    expect(JSON.parse(String(vi.mocked(controlApiFetch).mock.calls[0]![2]!.body))).toEqual({
      continueFrom: "run-p",
      prompt: "",
      ...controls,
    });
    vi.mocked(controlApiFetch).mockClear();
    await runContinueQuery({ runId: "run-p", review: false });
    expect(JSON.parse(String(vi.mocked(controlApiFetch).mock.calls[0]![2]!.body))).toEqual({
      continueFrom: "run-p",
      review: false,
    });
  });

  it.each([
    { attachments: null },
    { attachments: [{ path: "/host/document.txt" }] },
    { attachments: [{ base64: "Zml4dHVyZQ==" }] },
    { attachments: [{ resourceId: "res-document", path: "/host/document.txt" }] },
    { attachments: [{ resourceId: "" }] },
    {
      attachments: [
        {
          resource_id: "res-document",
          kind: "file",
          mime: "text/plain",
          name: "document.txt",
          path: "/store/blob",
          sha256: `sha256:${"0".repeat(64)}`,
          size_bytes: 7,
        },
      ],
    },
    { taskGroupId: "not-a-uuid" },
    { taskGroupId: null },
    { access: "full_access" },
    { web: "sometimes" },
    { paidBudget: { kind: "finite" } },
    { maxSeconds: 0 },
    { continueCarrier: "native" },
    { reviewerPanel: [] },
    { harnesses: ["claude"] },
    { model: "m" },
    { execution: { isolation: "live" } },
  ])(
    "refuses a control outside the canonical successor contract %j before connection",
    async (extra) => {
      await expect(runContinueQuery({ runId: "run-p", ...extra })).rejects.toBeDefined();
      expect(connectDaemonIfRunning).not.toHaveBeenCalled();
      expect(controlApiFetch).not.toHaveBeenCalled();
    },
  );

  it("returns a successor that failed before its run started as a typed job handle", async () => {
    connected();
    vi.mocked(controlApiFetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          code: "credential_profile_unknown",
          message: "profile p1 is unknown",
          retryable: false,
          requiredActions: [],
          context: { jobId: "job-f", state: "failed" },
        }),
      } as never)
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) } as never);
    expect(await runContinueQuery({ runId: "run-p", credentialProfileId: "p1" })).toMatchObject({
      jobId: "job-f",
      runId: "",
      status: "failed",
      summary: "profile p1 is unknown",
    });
    // The detail read addresses the unbound job by its job id.
    expect(vi.mocked(controlApiFetch).mock.calls[1]![1]).toBe("/runs/job-f");
  });

  it("does not start a missing daemon", async () => {
    vi.mocked(connectDaemonIfRunning).mockResolvedValue(null);
    await expect(runContinueQuery({ runId: "run-p" })).rejects.toMatchObject({
      code: "daemon_unavailable",
      retryable: true,
    });
    expect(ensureDaemon).not.toHaveBeenCalled();
    expect(controlApiFetch).not.toHaveBeenCalled();
  });

  it("blocks bound Delegate contexts and explicit lineage before connecting", async () => {
    await expect(
      mcpSurfaceRunner({ delegationParentRunId: "parent" })({
        mode: "__run_continue",
        runId: "run-p",
      }),
    ).rejects.toMatchObject({ code: "delegation_forbidden" });
    await expect(
      runContinueQuery({ runId: "run-p", delegatedFromRunId: "parent" }),
    ).rejects.toMatchObject({ code: "delegation_forbidden" });
    expect(connectDaemonIfRunning).not.toHaveBeenCalled();
  });

  it.each([
    ["predecessor_unknown", 404],
    ["predecessor_live", 409],
    ["continue_from_unsupported", 400],
    ["continuation_superseded", 409],
    ["run_artifacts_expired", 410],
    ["continuation_predecessor_unavailable", 404],
  ])("preserves %s without retrying", async (code, status) => {
    connected();
    vi.mocked(controlApiFetch).mockResolvedValue({
      ok: false,
      status,
      json: async () => ({
        code,
        message: "engine refusal",
        retryable: false,
        context: { head: "run-head" },
        requiredActions: ["Inspect the predecessor."],
      }),
    } as never);
    await expect(runContinueQuery({ runId: "run-p" })).rejects.toMatchObject({
      code,
      retryable: false,
      context: { head: "run-head" },
      requiredActions: ["Inspect the predecessor."],
    });
    expect(controlApiFetch).toHaveBeenCalledTimes(1);
  });

  it.each([{ runId: "" }, { runId: "run-p", prompt: 1 }, { runId: "run-p", idempotencyKey: "" }])(
    "rejects invalid input %j before connection",
    async (input) => {
      await expect(runContinueQuery(input)).rejects.toBeDefined();
      expect(connectDaemonIfRunning).not.toHaveBeenCalled();
    },
  );

  it("rejects an invalid successful response", async () => {
    connected({ state: "queued" });
    await expect(runContinueQuery({ runId: "run-p" })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});
