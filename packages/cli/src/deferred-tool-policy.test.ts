import { afterEach, expect, it, vi } from "vitest";
vi.mock("@claudexor/schema", () => import("../../schema/src/index.js"));
vi.mock("@claudexor/control-api", () => import("../../control-api/src/index.js"));
vi.mock("@claudexor/orchestrator", () => import("../../orchestrator/src/index.js"));
vi.mock("@claudexor/config", async (original) => ({
  ...(await original<object>()),
  loadConfig: vi.fn(),
}));
vi.mock("./registry.js", () => ({ buildRegistry: vi.fn() }));
vi.mock("./run-orchestrator.js", () => ({ buildRunOrchestrator: vi.fn() }));
vi.mock("./continue-from-run.js", () => ({
  continuationForRun: () => ({ from: { runId: "run-p" } }),
}));
vi.mock("@claudexor/workspace", async (original) => ({
  ...(await original<object>()),
  readContinuationEvidence: () => ({ hasEvidence: true }),
}));
vi.mock("./request-preflight.js", async (original) => {
  const actual = await original<typeof import("./request-preflight.js")>();
  const create: typeof actual.createRunRequirementsPreflight = (
    resources,
    root,
    dependencies = {},
    policy,
  ) =>
    actual.createRunRequirementsPreflight(
      resources,
      root,
      {
        ...dependencies,
        gitCapability: async () => ({
          status: "available",
          version: "fixture",
          detail: null,
          remediation: null,
        }),
      },
      policy,
    );
  return { ...actual, createRunRequirementsPreflight: create };
});
import { loadConfig } from "@claudexor/config";
import { createFakeHarness } from "@claudexor/harness-fake";
import { claudeArgsForSpec } from "../../harness-claude/src/index.js";
import {
  CapturedRunStart,
  ControlRunStartRequest,
  HarnessManifest,
  HarnessRunSpec,
  ResolvedConfig,
  decodeAcceptedRunStart,
  type ActiveTaskContract,
} from "@claudexor/schema";
import { Orchestrator, type RoutedAdapter, type RunInput } from "@claudexor/orchestrator";
import { prepareRunAdmission } from "../../orchestrator/src/runAdmission.js";
import { buildTaskContract } from "../../orchestrator/src/task-contract-builder.js";
import { executionRunConfig } from "../../orchestrator/src/run-defaults.js";
import { buildRegistry } from "./registry.js";
import { buildRunOrchestrator } from "./run-orchestrator.js";
import { createDeferredStartPreparation } from "./deferred-start-preparation.js";
import { oneShotRunInput } from "./one-shot-run-input.js";

afterEach(() => vi.restoreAllMocks());
function config(allow: string[] = [], deny: string[] = []) {
  return ResolvedConfig.parse({
    global: {
      harnesses: {
        claude: {
          default_model: "fake-model",
          effort: "high",
          max_turns: 5,
          max_rounds: 3,
          tools_allow: allow,
          tools_deny: deny,
        },
      },
    },
    project: {},
    trust: { access_default: "workspace_write" },
  });
}

// Observe the real preflight route and reuse its existing spec-knob producers.
// No new production seam and no copied permission translation. The adapter's
// manifest/doctor are offline; run() must never be entered by preparation.
interface LaneOwner {
  resolveCandidateAdapters(input: RunInput, intent: "implement"): Promise<RoutedAdapter[]>;
  routeSpecKnobs(
    route: RoutedAdapter,
    contract: ActiveTaskContract,
  ): Parameters<LaneOwner["harnessSpecKnobs"]>[1];
  harnessSpecKnobs(
    contract: ActiveTaskContract,
    knobs: {
      webPolicy: "auto" | "off" | "on";
      toolsAllow: string[];
      toolsDeny: string[];
      model: string | null;
      effort: HarnessRunSpec["effort_hint"];
      maxTurns: number | null;
      promptCacheTtl?: "5m" | "1h";
    },
    intent: "implement",
  ): Partial<HarnessRunSpec>;
}
async function fixture(allow: string[] = [], deny: string[] = []) {
  vi.mocked(loadConfig).mockReturnValue(config(allow, deny));
  const base = createFakeHarness("fake-implement"),
    baseManifest = await base.discover();
  const manifest = HarnessManifest.parse({
    ...baseManifest,
    id: "claude",
    kind: "local_cli",
    provider_family: "anthropic",
    capability_profile: { ...baseManifest.capability_profile, prompt_cache_ttls: ["5m", "1h"] },
    capabilities: { ...baseManifest.capabilities, tool_lists: true, max_turns: true },
  });
  const run = vi.fn(async function* () {
    throw Error("preparation cannot launch a provider");
  });
  const lane = {
    ...base,
    id: "claude",
    capabilityProfile: manifest.capability_profile,
    discover: async () => manifest,
    doctor: async (spec: Parameters<typeof base.doctor>[0]) => ({
      ...(await base.doctor(spec)),
      harness_id: "claude",
    }),
    run,
  };
  const registry = new Map([["claude", lane]]);
  vi.mocked(buildRegistry).mockReturnValue(registry);
  let owner: LaneOwner, route: RoutedAdapter;
  vi.mocked(buildRunOrchestrator).mockImplementation(({ p }) => {
    const orchestrator = new Orchestrator({
      registry,
      reviewers: [],
      executionDefaults: p.deferredDefaults,
    });
    owner = orchestrator as unknown as LaneOwner;
    const resolve = owner.resolveCandidateAdapters.bind(owner);
    vi.spyOn(owner, "resolveCandidateAdapters").mockImplementation(async (input, intent) => {
      const routes = await resolve(input, intent);
      route = routes[0]!;
      return routes;
    });
    return orchestrator;
  });
  const preparation = createDeferredStartPreparation({
    resources: { resolve: () => [] },
    accounts: {},
    commands: {},
    authority: {},
    quota: vi.fn(),
  } as never);
  const predecessor = {
    id: "p",
    runId: "run-p",
    state: "running" as const,
    createdAt: new Date().toISOString(),
    params: ControlRunStartRequest.parse({
      mode: "agent",
      prompt: "first",
      harnesses: ["claude"],
      scope: { kind: "project", root: process.cwd() },
      promptCacheTtl: "1h",
    }),
  };
  const captured = await preparation.capture(predecessor, {
    action: "create",
    predecessorId: "p",
    prompt: "follow up",
    attachments: [],
    controls: {
      access: "workspace_write",
      review: false,
      maxSeconds: 120,
      timeLimitMode: "hard",
      web: "off",
    },
  });
  async function specFor(request = captured) {
    await preparation.validate(request);
    expect(route!).toBeDefined();
    const { resolved } = prepareRunAdmission(
      oneShotRunInput(request),
      { registry, reviewers: [], executionDefaults: request.deferredDefaults },
      () => {},
    );
    const contract = buildTaskContract(resolved, "task-fixture", "agent", {});
    const knobs = owner!.routeSpecKnobs(route!, contract);
    const spec = HarnessRunSpec.parse({
      session_id: "fixture",
      intent: "implement",
      prompt: request.prompt,
      cwd: process.cwd(),
      access: route!.adapterAccess,
      ...owner!.harnessSpecKnobs(contract, knobs, "implement"),
    });
    expect(run).not.toHaveBeenCalled();
    return { spec, args: claudeArgsForSpec(spec), route: route! };
  }
  return { captured, specFor };
}
function toolFlags(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index === -1 ? [] : args[index + 1]!.split(",");
}

it("never captures native permission lists as execution preferences", async () => {
  const { captured } = await fixture(["Read(/before/**)"], ["Bash"]);
  expect(captured.deferredDefaults!.harnesses.claude).not.toHaveProperty("tools_allow");
  expect(captured.deferredDefaults!.harnesses.claude).not.toHaveProperty("tools_deny");
});

it("a later Bash deny reaches real preparation, spec mapping and Claude argv without losing frozen preferences", async () => {
  const f = await fixture();
  const current = config([], ["Bash"]);
  Object.assign(current.global.harnesses.claude!, {
    default_model: "fake-model-alt",
    effort: "low",
    max_turns: 99,
    max_rounds: 99,
  });
  vi.mocked(loadConfig).mockReturnValue(current);
  const { spec, args, route } = await f.specFor();
  expect(spec.access).toBe("workspace_write");
  expect(spec.tool_permission_policy.deny).toContain("Bash");
  expect(toolFlags(args, "--disallowedTools")).toContain("Bash");
  expect(toolFlags(args, "--allowedTools")).not.toContain("Bash");
  expect(spec).toMatchObject({
    model_hint: "fake-model",
    effort_hint: "high",
    max_turns: 5,
    prompt_cache_ttl: "1h",
  });
  expect(route.settings?.maxRounds).toBe(3);
  expect(f.captured).toMatchObject({
    maxSeconds: 120,
    timeLimitMode: "hard",
    promptCacheTtl: "1h",
  });
});

it("withdrawing an old explicit allow keeps only current restrictions in native argv", async () => {
  const f = await fixture(["Read(/before/**)"]);
  vi.mocked(loadConfig).mockReturnValue(config(["Read(/current/**)"], ["Bash"]));
  const { spec, args } = await f.specFor();
  expect(spec.tool_permission_policy.allow).toEqual(["Read(/current/**)"]);
  expect(toolFlags(args, "--allowedTools")).toContain("Read(/current/**)");
  expect(toolFlags(args, "--allowedTools")).not.toContain("Read(/before/**)");
  expect(toolFlags(args, "--disallowedTools")).toContain("Bash");
});

it("retained old lists cannot override current policy even without a prior decoder, and accepted bytes stay immutable", async () => {
  const f = await fixture();
  const retained = {
    ...f.captured,
    deferredDefaults: {
      ...f.captured.deferredDefaults!,
      harnesses: {
        ...f.captured.deferredDefaults!.harnesses,
        claude: {
          ...f.captured.deferredDefaults!.harnesses.claude!,
          tools_allow: ["Bash", "Read(/old/**)"],
          tools_deny: [],
        },
      },
    },
  };
  const acceptedBytes = JSON.stringify(retained);
  vi.mocked(loadConfig).mockReturnValue(config([], ["Bash"]));
  expect(
    executionRunConfig(process.cwd(), retained.deferredDefaults).global.harnesses.claude,
  ).toMatchObject({ tools_allow: [], tools_deny: ["Bash"] });
  const decoded = decodeAcceptedRunStart(retained);
  expect(decoded.deferredDefaults!.harnesses.claude).not.toHaveProperty("tools_allow");
  expect(decoded.deferredDefaults!.harnesses.claude).not.toHaveProperty("tools_deny");
  const { args } = await f.specFor(retained as CapturedRunStart);
  expect(toolFlags(args, "--allowedTools")).not.toContain("Bash");
  expect(toolFlags(args, "--allowedTools")).not.toContain("Read(/old/**)");
  expect(toolFlags(args, "--disallowedTools")).toContain("Bash");
  expect(JSON.stringify(retained)).toBe(acceptedBytes);
});

it("unchanged current policy still admits the supported workspace-write continuation", async () => {
  const f = await fixture(["Read(/current/**)"], ["WebFetch"]);
  const { spec, args } = await f.specFor();
  expect(spec).toMatchObject({
    access: "workspace_write",
    model_hint: "fake-model",
    effort_hint: "high",
    max_turns: 5,
    prompt_cache_ttl: "1h",
  });
  expect(toolFlags(args, "--allowedTools")).toContain("Bash");
  expect(toolFlags(args, "--allowedTools")).toContain("Read(/current/**)");
  expect(toolFlags(args, "--disallowedTools")).toContain("WebFetch");
});

it("a harness section removed after capture dispatches with current defaults under frozen preferences", async () => {
  const f = await fixture(["Read(/before/**)"], ["Bash"]);
  vi.mocked(loadConfig).mockReturnValue(
    ResolvedConfig.parse({
      global: { harnesses: {} },
      project: {},
      trust: { access_default: "workspace_write" },
    }),
  );
  const { spec, args, route } = await f.specFor();
  expect(
    executionRunConfig(process.cwd(), f.captured.deferredDefaults).global.harnesses.claude,
  ).toMatchObject({
    enabled: true,
    native_credentials_enabled: true,
    profile_policy: { limit_action: "auto" },
    tools_allow: [],
    tools_deny: [],
    default_model: "fake-model",
    max_rounds: 3,
  });
  expect(spec).toMatchObject({ model_hint: "fake-model", effort_hint: "high", max_turns: 5 });
  expect(route.settings).toMatchObject({ maxRounds: 3, toolsAllow: [], toolsDeny: [] });
  expect(toolFlags(args, "--allowedTools")).not.toContain("Read(/before/**)");
  expect(toolFlags(args, "--disallowedTools")).not.toContain("Bash");
});
