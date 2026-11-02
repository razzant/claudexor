import { afterEach, describe, expect, it, vi } from "vitest";
import { McpRunToolResult, taskGroupReceiptMetadata } from "@claudexor/schema";
import { keyedLaunchNeedsProject, projectLaunchHandle } from "./mcp-launch-handle.js";
import { enqueueAndAwait } from "./daemon-run.js";
import { acceptedPreRunFailure } from "./run-start-acceptance.js";
import { CLI_FLAGS, RUN_FLAGS_BY_MODE } from "./command-flags.js";

vi.mock("./live.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./live.js")>()),
  controlApiFetch: vi.fn(),
}));
import { controlApiFetch } from "./live.js";

const addr = { baseUrl: "http://local", token: "t" };
const failure = {
  phase: "preflight",
  category: "auth",
  code: null,
  harnessId: null,
  attemptId: null,
  safeMessage: "profile p1 is unknown",
  rawDetailRef: null,
  resetsAt: null,
  vendorFailure: null,
  logRefs: [],
  eventRefs: [],
  runDir: null,
  nextActions: ["Pick a registered profile."],
};

afterEach(() => vi.resetAllMocks());

describe("MCP launch handles", () => {
  const taskGroupId = "11111111-1111-4111-8111-111111111111";
  const storeId = "22222222-2222-4222-8222-222222222222";

  it("declares --task-group-id as a value on every public one-shot CLI mode", () => {
    expect(CLI_FLAGS.find((flag) => flag.name === "task-group-id")).toMatchObject({
      kind: "value",
    });
    for (const flags of Object.values(RUN_FLAGS_BY_MODE)) expect(flags).toContain("task-group-id");
  });

  it.each([
    ["queued", true],
    ["running", true],
    ["failed", true],
    ["queued", false],
    ["running", false],
    ["failed", false],
  ] as const)(
    "projects accepted %s metadata (task group: %s) through the real enqueue and handle owners",
    async (status, grouped) => {
      // An ordinary receipt names its accepting store alone.
      const receipt = grouped ? { taskGroupId, storeId } : { storeId };
      const serverReceipt =
        status === "failed"
          ? {
              code: "fixture_pre_run_failure",
              message: "pre-run failure",
              retryable: false,
              context: { jobId: "job-g", state: "failed", ...receipt },
            }
          : status === "queued"
            ? { jobId: "job-g", state: "queued", ...receipt }
            : { jobId: "job-g", runId: "actual-run", runDir: "/fixture/run", ...receipt };
      vi.mocked(controlApiFetch).mockResolvedValueOnce(
        Response.json(serverReceipt, {
          status: status === "failed" ? 403 : status === "queued" ? 202 : 200,
        }),
      );
      const client = { status: vi.fn(async () => ({ state: status })) };
      const accepted = await enqueueAndAwait(
        client as never,
        addr,
        { prompt: "work", ...(grouped ? { taskGroupId } : {}) },
        { waitForTerminal: false, acceptUnbound: true },
      );
      expect(accepted).toMatchObject({ jobId: "job-g" });
      vi.mocked(controlApiFetch).mockResolvedValue(Response.json({}, { status: 404 }));
      const handle = await projectLaunchHandle(addr, accepted, { deferred: true });
      expect(handle).toMatchObject({ jobId: "job-g", ...receipt });
      if (!grouped) {
        expect(handle).not.toHaveProperty("taskGroupId");
        // The pair-only copy this handle used before #163 drops a lone store.
        expect(taskGroupReceiptMetadata(accepted)).toEqual({});
      }
      expect(handle.runId).toBe(status === "running" ? "actual-run" : "");
      const { structuredRunResult } = await import("../../mcp-server/src/run-result-format.js");
      expect(McpRunToolResult.parse(structuredRunResult(handle))).toMatchObject(receipt);
    },
  );

  it("projects a pre-run failure's group from accepted server context", async () => {
    const accepted = acceptedPreRunFailure(403, {
      code: "fixture_pre_run_failure",
      message: "pre-run failure",
      retryable: false,
      context: { jobId: "job-g", state: "failed", taskGroupId, storeId },
    });
    expect(accepted).not.toBeNull();
    vi.mocked(controlApiFetch).mockResolvedValue(Response.json({}, { status: 404 }));
    expect(await projectLaunchHandle(addr, accepted!, { deferred: true })).toMatchObject({
      jobId: "job-g",
      taskGroupId,
      storeId,
    });
  });

  it("rejects group metadata on CLI thread/resume transport before posting a turn", async () => {
    vi.mocked(controlApiFetch).mockResolvedValue(Response.json({ jobId: "job" }, { status: 202 }));
    await expect(
      enqueueAndAwait(
        {} as never,
        addr,
        { threadId: "thread", prompt: "work", taskGroupId },
        { waitForTerminal: false, acceptUnbound: true },
      ),
    ).rejects.toBeDefined();
    expect(controlApiFetch).not.toHaveBeenCalled();
  });

  it("keeps a still-queued job as a handle without reading detail", async () => {
    const result = await projectLaunchHandle(
      addr,
      { jobId: "job-q", runId: "", runDir: "", status: "queued" },
      { deferred: true, mode: "agent" },
    );
    expect(result).toMatchObject({ jobId: "job-q", runId: "", status: "queued" });
    expect(result).not.toHaveProperty("taskGroupId");
    expect(result).not.toHaveProperty("storeId");
    expect(String(result["summary"])).toContain("Follow it with claudexor_run_wait");
    expect(controlApiFetch).not.toHaveBeenCalled();
  });

  it("reads a pre-run failure's typed detail by its job id", async () => {
    vi.mocked(controlApiFetch).mockResolvedValue(
      Response.json({ summary: { jobId: "job-f", runId: "job-f", state: "failed" }, failure }),
    );
    const result = await projectLaunchHandle(
      addr,
      { jobId: "job-f", runId: "", runDir: "", status: "failed", error: "profile p1 is unknown" },
      { deferred: true },
    );
    expect(vi.mocked(controlApiFetch).mock.calls[0]![1]).toBe("/runs/job-f");
    expect(result).toMatchObject({
      jobId: "job-f",
      status: "failed",
      summary: "profile p1 is unknown",
      failure: { category: "auth", safeMessage: "profile p1 is unknown" },
    });
  });

  it("keeps terminal-waiting (belt) reads on the bound run only", async () => {
    const result = await projectLaunchHandle(
      addr,
      { jobId: "job-f", runId: "", runDir: "", status: "failed", error: "refused" },
      { deferred: false, mode: "agent" },
    );
    expect(controlApiFetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ runId: "", jobId: "job-f", summary: "refused" });
  });

  it("names the keyed-launch project requirement as a typed usage refusal", () => {
    expect(keyedLaunchNeedsProject()).toMatchObject({
      category: "usage",
      code: "idempotency_repo_path_required",
      retryable: false,
    });
  });

  it("produces handles the declared MCP result schema accepts once mirrored", async () => {
    const { structuredRunResult } = await import("../../mcp-server/src/run-result-format.js");
    const handle = await projectLaunchHandle(
      addr,
      { jobId: "job-q", runId: "", runDir: "", status: "queued" },
      { deferred: true },
    );
    expect(McpRunToolResult.parse(structuredRunResult(handle))).toMatchObject({
      jobId: "job-q",
      runId: null,
      status: "queued",
    });
  });
});
