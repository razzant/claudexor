import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@claudexor/schema", () => import("../../schema/src/index.js"));
vi.mock("@claudexor/control-api", () => import("../../control-api/src/index.js"));
vi.mock("@claudexor/orchestrator", () => import("../../orchestrator/src/index.js"));
vi.mock("@claudexor/config", async (original) => ({
  ...(await original<object>()),
  loadConfig: vi.fn(),
}));
vi.mock("./registry.js", () => ({
  buildRegistry: () =>
    new Map([
      ["codex", {}],
      ["claude", {}],
    ]),
}));
vi.mock("./request-preflight.js", () => ({ createRunRequirementsPreflight: () => requirements }));
vi.mock("./run-orchestrator.js", () => ({
  buildRunOrchestrator: vi.fn(() => ({ preflightOneShot: route })),
}));
vi.mock("./continue-from-run.js", () => ({
  continuationForRun: vi.fn(() => ({ retain: true, from: { runId: "run-p" } })),
}));
vi.mock("@claudexor/workspace", async (original) => ({
  ...(await original<object>()),
  readContinuationEvidence: vi.fn(() => ({ hasEvidence: true })),
}));
const { requirements, route } = vi.hoisted(() => ({
  requirements: vi.fn(async () => {}),
  route: vi.fn(async () => {}),
}));
import { loadConfig } from "@claudexor/config";
import { CapturedRunStart, ControlRunStartRequest, ResolvedConfig } from "@claudexor/schema";
import { executionRunConfig } from "../../orchestrator/src/run-defaults.js";
import { resolveRunInputDefaults } from "../../orchestrator/src/run-input-resolution.js";
import { oneShotRunInput } from "./one-shot-run-input.js";
import { createDeferredStartPreparation } from "./deferred-start-preparation.js";
import { buildRunOrchestrator } from "./run-orchestrator.js";
import { readContinuationEvidence } from "@claudexor/workspace";

afterEach(() => vi.clearAllMocks());
const config = () =>
  ResolvedConfig.parse({
    global: {
      harnesses: { codex: { default_model: "model-a", effort: "high", max_turns: 5 } },
      budget: { paid_budget_per_run: { kind: "finite", maxUsd: 2 } },
    },
    project: {},
    trust: { access_default: "workspace_write" },
  });
function fixture() {
  vi.mocked(loadConfig).mockReturnValue(config());
  const resources = { resolve: vi.fn(() => []) };
  const prep = createDeferredStartPreparation({
    resources,
    accounts: {},
    commands: {},
    authority: {},
    quota: vi.fn(),
  } as never);
  const params = ControlRunStartRequest.parse({ mode: "ask", prompt: "first" });
  const predecessor = {
    id: "job-p",
    state: "running",
    createdAt: new Date().toISOString(),
    params,
  } as const;
  const request = {
    action: "create",
    predecessorId: "job-p",
    prompt: "verify",
    attachments: [],
  } as const;
  return { prep, predecessor, request: { ...request, attachments: [] }, resources };
}
describe("canonical production deferred-start preparation", () => {
  it("captures Auto, unpinned credentials and defaults once without requiring live predecessor terminality", async () => {
    const f = fixture();
    const captured = await f.prep.capture(f.predecessor, f.request);
    expect(captured).toMatchObject({
      mode: "ask",
      continueFrom: "job-p",
      prompt: "verify",
      access: "readonly",
      web: "auto",
      credentialProfileId: null,
      models: { codex: "model-a" },
      efforts: { codex: "high" },
      paidBudget: { kind: "finite", maxUsd: 2 },
      deferredDefaults: { harnesses: { codex: { max_turns: 5 } } },
    });
    expect(captured.harnesses).toBeUndefined();
    expect(captured.primaryHarness).toBeUndefined();
    expect(requirements).toHaveBeenCalledTimes(1);
    expect(route).not.toHaveBeenCalled();
    expect(ControlRunStartRequest.safeParse(captured).success).toBe(false);
  });
  it("preserves explicit inherited routing and operator controls, without pinning a selected account", async () => {
    const f = fixture();
    const predecessor = {
      ...f.predecessor,
      runId: "run-p",
      params: ControlRunStartRequest.parse({
        mode: "agent",
        prompt: "first",
        scope: { kind: "project", root: process.cwd() },
        harnesses: ["codex"],
        models: { codex: "explicit-model" },
      }),
    };
    const captured = await f.prep.capture(predecessor, {
      ...f.request,
      controls: {
        web: "off",
        review: true,
        credentialProfileId: "work",
        effort: "low",
        paidBudget: { kind: "finite", maxUsd: 0 },
        maxSeconds: 90,
        timeLimitMode: "soft",
      },
    });
    expect(captured).toMatchObject({
      mode: "agent",
      scope: predecessor.params.scope,
      harnesses: ["codex"],
      models: { codex: "explicit-model" },
      efforts: { codex: "low" },
      web: "off",
      externalContextPolicy: "off",
      review: true,
      credentialProfileId: "work",
      maxSeconds: 90,
      timeLimitMode: "soft",
      paidBudget: { kind: "finite", maxUsd: 0 },
    });
    expect(captured.primaryHarness).toBeUndefined();
    const resolved = resolveRunInputDefaults(oneShotRunInput(captured), {
      config: executionRunConfig(process.cwd(), captured.deferredDefaults),
      registryIds: ["codex", "claude"],
    });
    expect(resolved).toMatchObject({ primaryHarness: "codex", primaryHarnessExplicit: false });
  });
  it("rechecks resources and requirements plus the actual orchestrator route owner at dispatch", async () => {
    const f = fixture();
    const captured = await f.prep.capture(f.predecessor, f.request);
    await f.prep.validate(captured);
    expect(f.resources.resolve).toHaveBeenCalledTimes(3);
    expect(requirements).toHaveBeenCalledTimes(2);
    expect(buildRunOrchestrator).toHaveBeenCalledWith(expect.objectContaining({ p: captured }));
    expect(route).toHaveBeenCalledWith(
      expect.objectContaining({
        continuation: { retain: true, from: { runId: "run-p" } },
        models: { codex: "model-a" },
        credentialProfileId: null,
      }),
    );
    requirements.mockRejectedValueOnce(
      Object.assign(new Error("MIME revoked"), { code: "attachment_unsupported" }),
    );
    await expect(f.prep.validate(captured)).rejects.toMatchObject({
      code: "attachment_unsupported",
    });
    expect(route).toHaveBeenCalledTimes(1);
  });
  it("holds admission when retained continuation evidence disappears before dispatch", async () => {
    const f = fixture();
    const captured = await f.prep.capture(f.predecessor, f.request);
    vi.mocked(readContinuationEvidence).mockReturnValueOnce({
      held: null,
      resumable: undefined,
      hasEvidence: false,
    } as ReturnType<typeof readContinuationEvidence>);
    await expect(f.prep.validate(captured)).rejects.toMatchObject({
      code: "continuation_evidence_unavailable",
      retryable: false,
    });
    expect(route).not.toHaveBeenCalled();
  });
  it("freezes execution defaults but keeps current enablement, credentials, trust and quota policy", async () => {
    const f = fixture();
    const captured = await f.prep.capture(f.predecessor, f.request);
    const current = config();
    current.trust.access_default = "readonly";
    current.global.harnesses.codex!.default_model = "model-b";
    current.global.harnesses.codex!.effort = "max";
    current.global.harnesses.codex!.enabled = false;
    current.global.harnesses.codex!.native_credentials_enabled = false;
    current.global.harnesses.codex!.profile_policy.limit_action = "fail";
    current.global.harnesses.claude = {
      ...current.global.harnesses.codex!,
      default_model: "new-model",
    };
    current.global.routing.eligible_harnesses = ["claude"];
    vi.mocked(loadConfig).mockReturnValue(current);
    const execution = executionRunConfig("/tmp/project", captured.deferredDefaults);
    expect(execution.global.harnesses.codex).toMatchObject({
      default_model: "model-a",
      effort: "high",
      enabled: false,
      native_credentials_enabled: false,
      profile_policy: { limit_action: "fail" },
    });
    expect(execution.global.harnesses.claude!.default_model).toBeNull();
    expect(execution.global.routing.eligible_harnesses).toEqual([]);
    expect(execution.trust.access_default).toBe("readonly");
    expect(CapturedRunStart.parse(captured).models).toEqual({ codex: "model-a" });
  });
});
