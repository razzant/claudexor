import { afterEach, expect, it, vi } from "vitest";
vi.mock("@claudexor/schema", () => import("../../schema/src/index.js"));
vi.mock("../../cli/src/daemon-run.js", () => ({ connectDaemonIfRunning: vi.fn() }));
vi.mock("../../cli/src/live.js", () => ({ controlApiFetch: vi.fn() }));
vi.mock("../../cli/src/run-wait-events.js", () => ({ observeRunEvents: vi.fn() }));
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { defaultClaudexorTools } from "./index.js";
import {
  projectRecoveryRunDetail,
  projectDegradedRecoveryRunDetail,
} from "../../cli/src/mcp-run-projections.js";
import { runWaitQuery } from "../../cli/src/mcp-run-wait.js";
import { boundedDeferredMessage } from "../../cli/src/mcp-deferred-message.js";
import { CapturedRunStart } from "@claudexor/schema";
import { connectDaemonIfRunning } from "../../cli/src/daemon-run.js";
import { controlApiFetch } from "../../cli/src/live.js";
import { observeRunEvents } from "../../cli/src/run-wait-events.js";

afterEach(() => vi.resetAllMocks());
const draft = {
  draftId: "draft-1",
  revision: 1,
  state: "waiting",
  predecessorJobId: "job-1",
  predecessorRunId: "run-1",
  predecessorResult: "/v2/runs/run-1",
  hold: null,
  dispatchedRevision: null,
  successorJobId: null,
  successorRunId: null,
};

async function validateTool(name: string, payload: Record<string, unknown>) {
  const tool = defaultClaudexorTools(async () => payload).find((t) => t.name === name)!;
  const output = await tool.handler({ runId: "job-1", waitMs: 0 }, {});
  expect(typeof output).toBe("object");
  const structured = (output as { structured: Record<string, unknown> }).structured;
  // The same SDK schema adapter used by buildMcpServer, without a listener or
  // transport. Exercise generated JSON, inlined refs and the public handler.
  const schema = fromJsonSchema(tool.outputSchema as Parameters<typeof fromJsonSchema>[0]);
  const result = await schema["~standard"].validate(structured);
  expect(result.issues, `${name}: ${JSON.stringify(result.issues)}`).toBeUndefined();
  const unexpected = await schema["~standard"].validate({
    ...structured,
    accidentalPrivateField: true,
  });
  expect(unexpected.issues).toBeDefined(); // The output contract remains strict.
  return structured;
}

it.each(["queued", "running", "succeeded"] as const)(
  "validates actual status/result/wait producers through the SDK for %s",
  async (state) => {
    // The public summary retains a job handle as runId until binding.
    const projection =
      state === "queued"
        ? { ...draft, predecessorRunId: null, predecessorResult: "/v2/runs/job-1" }
        : draft;
    const detail = {
      summary: { jobId: "job-1", runId: state === "queued" ? "job-1" : "run-1", state },
      pendingInteractions: [],
      lastSeq: 0,
      deferredMessage: projection,
    };
    for (const [name, mode] of [
      ["claudexor_run_status", "__run_status"],
      ["claudexor_run_result", "__run_result"],
    ]) {
      const payload = projectRecoveryRunDetail(mode!, "job-1", detail);
      expect(await validateTool(name!, payload)).toMatchObject({
        status: state,
        deferredMessage: projection,
      });
    }
    vi.mocked(connectDaemonIfRunning).mockResolvedValue({
      addr: { baseUrl: "http://fixture", token: "fixture" },
    } as never);
    vi.mocked(controlApiFetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => detail,
    } as never);
    const waited = await runWaitQuery({ runId: "job-1", waitMs: 0 });
    expect(await validateTool("claudexor_run_wait", waited)).toMatchObject({
      status: state,
      deferredMessage: projection,
    });
  },
);

it("validates degraded status/result without inventing a draft snapshot", async () => {
  const payload = projectDegradedRecoveryRunDetail(
    "job-1",
    Object.assign(new Error("unreadable detail"), { code: "invalid_service_response" }),
  );
  for (const name of ["claudexor_run_status", "claudexor_run_result"]) {
    const actual = await validateTool(name, payload);
    expect(actual).not.toHaveProperty("deferredMessage");
    expect(actual.detailProblem).toMatchObject({ code: "invalid_service_response" });
  }
});

it("validates a wait whose final snapshot is unavailable, retaining its fenced draft disclosure", async () => {
  vi.mocked(connectDaemonIfRunning).mockResolvedValue({
    addr: { baseUrl: "http://fixture", token: "fixture" },
  } as never);
  vi.mocked(controlApiFetch)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        summary: { jobId: "job-1", runId: "run-1", state: "running" },
        pendingInteractions: [],
        lastSeq: 0,
        deferredMessage: draft,
      }),
    } as never)
    .mockRejectedValueOnce(new Error("snapshot disconnected"));
  vi.mocked(observeRunEvents).mockResolvedValue({
    events: [],
    nextSeq: 0,
    eventOmission: null,
    oversizedEvent: null,
    stop: "timeout",
    questionRequested: false,
  });
  const waited = await runWaitQuery({ runId: "job-1", waitMs: 1 });
  expect(await validateTool("claudexor_run_wait", waited)).toMatchObject({
    snapshotPhase: "before_wait",
    snapshotProblem: "snapshot_unavailable",
    deferredMessage: draft,
  });
});

it("validates the bounded draft read with its frozen controls through the SDK", async () => {
  const tool = defaultClaudexorTools(vi.fn()).find(
    (t) => t.name === "claudexor_next_message_read",
  )!;
  const schema = fromJsonSchema(tool.outputSchema as Parameters<typeof fromJsonSchema>[0]);
  const read = boundedDeferredMessage({
    ...draft,
    state: "waiting",
    prompt: "verify",
    attachments: [],
    capturedStart: CapturedRunStart.parse({
      mode: "ask",
      access: "readonly",
      deferredDefaults: {
        harnesses: { codex: { max_turns: 5 } },
        eligibleHarnesses: [],
        primaryHarness: null,
        authPreference: "auto",
      },
    }),
    capturedAt: "2026-10-26T12:00:00.000Z",
  });
  expect(read.controls).toMatchObject({
    inherited: { mode: "ask" },
    resolved: { access: "readonly" },
  });
  expect((await schema["~standard"].validate(read)).issues).toBeUndefined();
  const extra = { ...read, controls: { ...read.controls, current: [] } };
  expect((await schema["~standard"].validate(extra)).issues).toBeDefined();
});

it("keeps private captured preferences out of every public launch input", async () => {
  const tools = defaultClaudexorTools(vi.fn()).filter((t) => t.runMode);
  expect(tools.length).toBeGreaterThan(0);
  for (const tool of tools) {
    const schema = fromJsonSchema(tool.inputSchema as Parameters<typeof fromJsonSchema>[0]);
    const publicBody = { prompt: "hello", repoPath: "/tmp" };
    expect((await schema["~standard"].validate(publicBody)).issues, tool.name).toBeUndefined();
    for (const extra of [
      { deferredDefaults: {} },
      { deferredDefaults: {}, operation: "run.retry", clientId: "control-api" },
    ]) {
      const result = await schema["~standard"].validate({ ...publicBody, ...extra });
      expect(result.issues, tool.name).toBeDefined();
    }
  }
});
