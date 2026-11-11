import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMessageQuery } from "./mcp-run-message.js";
import { mcpSurfaceRunner } from "./mcp-runner.js";

vi.mock("./daemon-run.js", () => ({ connectDaemonIfRunning: vi.fn(), ensureDaemon: vi.fn() }));
vi.mock("./live.js", () => ({ controlApiFetch: vi.fn() }));
import { connectDaemonIfRunning, ensureDaemon } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";

const input = {
  runId: "run/1",
  idempotencyKey: "caller-key",
  request: { text: "  Keep going\n", expectedAttemptId: "a1" },
};
const receipt = {
  accepted: true,
  outcome: "accepted",
  runId: "run/1",
  messageId: "caller-key",
  attemptId: "a1",
  nativeTurnId: "turn1",
  harnessId: "codex",
  liveInput: "mid_turn",
};

describe("MCP live message transport", () => {
  beforeEach(() => {
    vi.mocked(connectDaemonIfRunning).mockResolvedValue({
      addr: { baseUrl: "http://local", token: "token" },
    } as never);
    vi.mocked(controlApiFetch).mockResolvedValue({ ok: true, json: async () => receipt } as never);
  });
  afterEach(() => vi.resetAllMocks());

  it("routes one exact POST through the existing daemon with a caller key and request-only signal", async () => {
    const signal = new AbortController().signal;
    expect(await mcpSurfaceRunner()({ mode: "__run_message", ...input }, { signal })).toEqual(
      receipt,
    );
    expect(controlApiFetch).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      "/runs/run%2F1/messages",
      {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": "caller-key" },
        body: JSON.stringify(input.request),
        signal,
      },
    );
    expect(ensureDaemon).not.toHaveBeenCalled();
  });

  it.each([
    ["accepted", undefined],
    ["delivered", undefined],
    ["rejected", "multi_attempt"],
    ["rejected", "admission_persist_failed"],
    ["unsupported", "thread_bound"],
    ["unsupported", "no_live_session"],
    ["not_active", "run_terminal"],
    ["not_active", "interaction_pending"],
    ["delivery_unknown", "transport_lost"],
  ])("returns HTTP-200 %s/%s without retries or invented delivery", async (outcome, reason) => {
    const body = {
      ...receipt,
      accepted: outcome === "accepted" || outcome === "delivered",
      outcome,
      ...(reason ? { reason } : {}),
    };
    vi.mocked(controlApiFetch).mockResolvedValue({ ok: true, json: async () => body } as never);
    expect(await runMessageQuery(input)).toEqual(body);
    expect(controlApiFetch).toHaveBeenCalledTimes(1);
  });

  it.each(["idempotency_conflict", "delivery_interrupted", "message_receipt_unavailable"])(
    "preserves non-200 %s without retry",
    async (code) => {
      const problem = {
        code,
        message: "Original receipt unavailable",
        retryable: false,
        requiredActions: ["Reuse the same key."],
        context: { operation: "run.message" },
      };
      vi.mocked(controlApiFetch).mockResolvedValue({
        ok: false,
        status: code === "message_receipt_unavailable" ? 500 : 409,
        json: async () => problem,
      } as never);
      await expect(runMessageQuery(input)).rejects.toMatchObject(problem);
      expect(controlApiFetch).toHaveBeenCalledTimes(1);
    },
  );

  it("repeats only on caller invocation, reusing the supplied key and forwarding changed bodies to engine authority", async () => {
    await runMessageQuery(input);
    await runMessageQuery(input);
    await runMessageQuery({ ...input, request: { text: "Changed" } });
    expect(controlApiFetch).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(controlApiFetch).mock.calls)
      expect(call[2]?.headers).toMatchObject({ "Idempotency-Key": "caller-key" });
    expect(vi.mocked(controlApiFetch).mock.calls[2]?.[2]?.body).toBe('{"text":"Changed"}');
  });

  it("fails without starting a missing daemon", async () => {
    vi.mocked(connectDaemonIfRunning).mockResolvedValue(null);
    await expect(runMessageQuery(input)).rejects.toMatchObject({ code: "daemon_unavailable" });
    expect(controlApiFetch).not.toHaveBeenCalled();
    expect(ensureDaemon).not.toHaveBeenCalled();
  });

  it("refuses forged belt dispatch before connecting", async () => {
    await expect(
      mcpSurfaceRunner({ delegationParentRunId: "parent" })({ mode: "__run_message", ...input }),
    ).rejects.toMatchObject({ code: "delegation_forbidden", status: 403 });
    expect(connectDaemonIfRunning).not.toHaveBeenCalled();
    expect(controlApiFetch).not.toHaveBeenCalled();
  });

  it("aborts only the HTTP request, never posts a run cancellation or retries", async () => {
    const controller = new AbortController();
    vi.mocked(controlApiFetch).mockImplementation(
      async (_addr, _path, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(controller.signal.reason), {
            once: true,
          });
        }),
    );
    const pending = mcpSurfaceRunner()(
      { mode: "__run_message", ...input },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(controlApiFetch).toHaveBeenCalledTimes(1));
    controller.abort(new Error("Host stopped waiting"));
    await expect(pending).rejects.toThrow("Host stopped waiting");
    expect(controlApiFetch).toHaveBeenCalledTimes(1);
    expect(ensureDaemon).not.toHaveBeenCalled();
  });

  it("does not dispatch an already cancelled request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Already cancelled"));
    await expect(runMessageQuery(input, false, controller.signal)).rejects.toThrow(
      "Already cancelled",
    );
    expect(controlApiFetch).not.toHaveBeenCalled();
  });

  it.each([
    { idempotencyKey: undefined },
    { idempotencyKey: " " },
    { idempotencyKey: "x".repeat(257) },
    { runId: "" },
    { request: { text: "" } },
    { request: { text: "x", extra: true } },
    { request: { text: "😀".repeat(32769) } },
  ])("validates before connecting", async (delta) => {
    await expect(runMessageQuery({ ...input, ...delta })).rejects.toThrow();
    expect(connectDaemonIfRunning).not.toHaveBeenCalled();
    expect(controlApiFetch).not.toHaveBeenCalled();
  });

  it("rejects a malformed success receipt instead of inventing delivery", async () => {
    vi.mocked(controlApiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ accepted: true }),
    } as never);
    await expect(runMessageQuery(input)).rejects.toThrow();
    expect(controlApiFetch).toHaveBeenCalledTimes(1);
  });
});
