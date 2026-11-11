import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ControlRunStartRequest,
  ControlThreadTurnRequest,
  HarnessCapabilityProfile,
  HarnessManifest,
  PlanQuestion,
  RUN_START_CLIENT_REJECTED_KEYS,
} from "@claudexor/schema";
import { CLAUDE_CAPABILITY_PROFILE } from "../../harness-claude/src/capability-profile.js";

const mocks = vi.hoisted(() => ({
  ensureDaemon: vi.fn(),
  connectDaemonIfRunning: vi.fn(),
  enqueueAndAwait: vi.fn(),
  fetchRunDetail: vi.fn(),
  fetchPlanReadiness: vi.fn(),
  fetchPlanQuestions: vi.fn(),
  fetchOutcomeBanner: vi.fn(),
  fetchApplyEligibility: vi.fn(),
  fetchRunOutcomeFacts: vi.fn(),
  followRun: vi.fn(),
  ttyAnswer: vi.fn(),
  statusAll: vi.fn(),
  controlApiFetch: vi.fn(),
}));

vi.mock("./daemon-run.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./daemon-run.js")>();
  return {
    ...actual,
    ensureDaemon: mocks.ensureDaemon,
    connectDaemonIfRunning: mocks.connectDaemonIfRunning,
    enqueueAndAwait: mocks.enqueueAndAwait,
    fetchRunDetail: mocks.fetchRunDetail,
    fetchPlanReadiness: mocks.fetchPlanReadiness,
    fetchPlanQuestions: mocks.fetchPlanQuestions,
    fetchOutcomeBanner: mocks.fetchOutcomeBanner,
    fetchApplyEligibility: mocks.fetchApplyEligibility,
    fetchRunOutcomeFacts: mocks.fetchRunOutcomeFacts,
  };
});

vi.mock("./live.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./live.js")>();
  return { ...actual, controlApiFetch: mocks.controlApiFetch, followRun: mocks.followRun };
});

// The plan question loop reads inline answers from the terminal.
vi.mock("node:readline/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:readline/promises")>();
  return {
    ...actual,
    createInterface: () => ({ question: mocks.ttyAnswer, close: () => undefined }),
  };
});

vi.mock("./registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./registry.js")>();
  return {
    ...actual,
    buildGateway: () => ({ statusAll: mocks.statusAll }),
    buildRegistry: () => new Map(),
    harnessModelTruth: async (harnessId: string) => ({
      response: { harnessId, models: [], source: "none", verifiedAgainst: null },
    }),
  };
});

vi.mock("@claudexor/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@claudexor/workspace")>();
  return {
    ...actual,
    probeGitCapability: async () => ({
      status: "available",
      version: "2.50.0",
      detail: null,
      remediation: null,
    }),
  };
});

// The cases import the CLI module graph; transform it once up front so a busy
// host measures each case's own flow, not the first cold transform.
beforeAll(async () => {
  await import("./capabilities.js");
  await import("./mcp-runner.js");
}, 600_000);
vi.setConfig({ testTimeout: 120_000 });

const addr = { baseUrl: "http://127.0.0.1:1", token: "test-token" };
const accepted = { runId: "run-ttl", runDir: "/tmp/run-ttl", status: "succeeded", jobId: "job" };

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  for (const mock of Object.values(mocks)) mock.mockReset();
});

function refuseOtherRequests(): void {
  mocks.controlApiFetch.mockImplementation(
    async (_addr: unknown, path: string, init?: RequestInit) => {
      throw new Error(`unexpected control request: ${init?.method ?? "GET"} ${path}`);
    },
  );
}

async function cli(argv: string[]): Promise<number | undefined> {
  const priorArgv = process.argv;
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  const flushed = (...args: unknown[]) => {
    (args.find((arg) => typeof arg === "function") as (() => void) | undefined)?.();
    return true;
  };
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(flushed as never);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(flushed as never);
  process.argv = [process.execPath, "claudexor", ...argv];
  try {
    await import("./cli.js");
    await vi.waitFor(() => expect(exit).toHaveBeenCalled(), { timeout: 60_000 });
    return exit.mock.calls[0]?.[0] as number | undefined;
  } finally {
    process.argv = priorArgv;
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

describe("CLI --prompt-cache-ttl", () => {
  it("sends the exact value on the run request", async () => {
    let body: Record<string, unknown> | null = null;
    refuseOtherRequests();
    mocks.ensureDaemon.mockResolvedValue({ client: {}, addr });
    mocks.fetchRunDetail.mockResolvedValue(null);
    mocks.enqueueAndAwait.mockImplementation(async (_client, _addr, request) => {
      body = request as Record<string, unknown>;
      return accepted;
    });
    expect(await cli(["plan", "what is cached", "--json", "--prompt-cache-ttl", "1h"])).toBe(0);
    expect(body).toMatchObject({ mode: "plan", promptCacheTtl: "1h" });
    expect(ControlRunStartRequest.parse(body).promptCacheTtl).toBe("1h");
  });

  it("omits the key for Default", async () => {
    let body: Record<string, unknown> | null = null;
    refuseOtherRequests();
    mocks.ensureDaemon.mockResolvedValue({ client: {}, addr });
    mocks.fetchRunDetail.mockResolvedValue(null);
    mocks.enqueueAndAwait.mockImplementation(async (_client, _addr, request) => {
      body = request as Record<string, unknown>;
      return accepted;
    });
    expect(await cli(["plan", "what is cached", "--json"])).toBe(0);
    expect(body).not.toBeNull();
    expect(body).not.toHaveProperty("promptCacheTtl");
  });

  it("refuses an unknown value as usage before any daemon contact", async () => {
    refuseOtherRequests();
    expect(await cli(["plan", "what is cached", "--json", "--prompt-cache-ttl", "2h"])).toBe(2);
    expect(mocks.ensureDaemon).not.toHaveBeenCalled();
    expect(mocks.enqueueAndAwait).not.toHaveBeenCalled();
  });
});

describe("interactive plan answers in the same command", () => {
  const question = PlanQuestion.parse({
    id: "lifetime",
    kind: "single",
    prompt: "Which cache?",
    options: [{ id: "keep", label: "Keep it" }],
    allow_text: false,
  });

  /** A text-mode `claudexor plan --thread` on a TTY whose plan asks one question,
   * answered inline; returns the run request and the follow-up answer turn. */
  async function planAnsweredInline(ttl?: "5m" | "1h") {
    const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    const requests: Record<string, unknown>[] = [];
    refuseOtherRequests();
    mocks.ensureDaemon.mockResolvedValue({
      client: { status: async () => ({ state: "succeeded" }) },
      addr,
    });
    mocks.fetchRunDetail.mockResolvedValue(null);
    mocks.followRun.mockResolvedValue(undefined);
    mocks.fetchPlanReadiness.mockImplementation(async (_addr: unknown, runId: string) =>
      runId === "run-plan"
        ? { state: "needs_answers", questionCount: 1 }
        : { state: "ready", questionCount: 0 },
    );
    mocks.fetchPlanQuestions.mockResolvedValue([question]);
    mocks.fetchOutcomeBanner.mockResolvedValue(null);
    mocks.fetchApplyEligibility.mockResolvedValue(null);
    mocks.fetchRunOutcomeFacts.mockResolvedValue(null);
    mocks.ttyAnswer.mockResolvedValue("1");
    mocks.enqueueAndAwait.mockImplementation(async (_client, _addr, request) => {
      requests.push(request as Record<string, unknown>);
      const runId = requests.length === 1 ? "run-plan" : "run-answer";
      return { runId, runDir: `/tmp/${runId}`, status: "running", jobId: `job-${runId}` };
    });
    try {
      const flags = ttl ? ["--prompt-cache-ttl", ttl] : [];
      const code = await cli(["plan", "what is cached", "--thread", "th-ttl", ...flags]);
      return { code, requests };
    } finally {
      if (tty) Object.defineProperty(process.stdin, "isTTY", tty);
      else Reflect.deleteProperty(process.stdin, "isTTY");
    }
  }

  it.each(["5m", "1h"] as const)("keep %s on the answer turn", async (ttl) => {
    const { code, requests } = await planAnsweredInline(ttl);
    expect(code).toBe(0);
    expect(mocks.ttyAnswer).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(2);
    const [initial, answer] = requests;
    expect(initial).toMatchObject({ mode: "plan", threadId: "th-ttl", promptCacheTtl: ttl });
    expect(answer).toMatchObject({
      mode: "plan",
      threadId: "th-ttl",
      answersPlanRunId: "run-plan",
      promptCacheTtl: ttl,
    });
    // The answer is a thread turn; its strict request accepts the lifetime.
    const { threadId: _thread, scope: _scope, execution: _execution, ...turn } = answer ?? {};
    expect(ControlThreadTurnRequest.parse(turn).promptCacheTtl).toBe(ttl);
  });

  it("keep Default off both the run and the answer turn", async () => {
    const { code, requests } = await planAnsweredInline();
    expect(code).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ mode: "plan", answersPlanRunId: "run-plan" });
    for (const request of requests) expect(request).not.toHaveProperty("promptCacheTtl");
  });
});

describe("delegation-belt children", () => {
  it("inherit the parent's captured lifetime; the generic MCP runner exposes none", async () => {
    const { mcpSurfaceRunner } = await import("./mcp-runner.js");
    const connection = { client: {}, addr, engine: {} };
    mocks.connectDaemonIfRunning.mockResolvedValue(connection);
    mocks.ensureDaemon.mockResolvedValue(connection);
    mocks.enqueueAndAwait.mockResolvedValue({ ...accepted, status: "running" });
    await mcpSurfaceRunner({
      requireExistingDaemon: true,
      delegationParentRunId: "parent",
      delegationRepoRoot: "/source",
      delegationPromptCacheTtl: "1h",
    })({ mode: "agent", prompt: "child", deferred: true, promptCacheTtl: "5m" });
    expect(mocks.enqueueAndAwait.mock.calls[0]?.[2]).toMatchObject({
      promptCacheTtl: "1h",
      parentRunId: "parent",
    });
    await mcpSurfaceRunner()({
      mode: "agent",
      prompt: "work",
      deferred: true,
      repoPath: "/source",
      promptCacheTtl: "1h",
    });
    expect(mocks.enqueueAndAwait.mock.calls[1]?.[2]).not.toHaveProperty("promptCacheTtl");
  });
});

describe("agent-capabilities advertises the exact translated values", () => {
  const manifest = (id: string, profile: HarnessCapabilityProfile) =>
    HarnessManifest.parse({
      id,
      display_name: id,
      kind: "local_cli",
      provider_family: id === "claude" ? "anthropic" : "openai",
      capabilities: {},
      capability_profile: profile,
    });
  const status = (id: string, profile: HarnessCapabilityProfile) => ({
    id,
    available: true,
    status: "ok",
    manifest: manifest(id, profile),
    enabledIntents: ["explain"],
    routableIntents: ["explain"],
    disabledIntents: [],
    checks: [],
    reasons: [],
    authSources: [],
  });

  it("claude lists 5m and 1h, an undeclared harness lists none, runControlKeys lists the key", async () => {
    mocks.statusAll.mockResolvedValue([
      status("claude", CLAUDE_CAPABILITY_PROFILE),
      status("codex", HarnessCapabilityProfile.parse({})),
    ]);
    const { buildAgentCapabilityCatalog } = await import("./capabilities.js");
    const catalog = await buildAgentCapabilityCatalog();
    const rows = Object.fromEntries(catalog.harnesses.map((row) => [row.id, row]));
    expect(rows["claude"]?.promptCacheTtls).toEqual(["5m", "1h"]);
    expect(rows["codex"]?.promptCacheTtls).toEqual([]);
    expect(catalog.runControlKeys).toContain("promptCacheTtl");
    expect(RUN_START_CLIENT_REJECTED_KEYS).not.toContain("promptCacheTtl");
  });
});
