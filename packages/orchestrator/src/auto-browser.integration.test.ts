import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import { HarnessGateway } from "@claudexor/gateway";
import { normalizeRunStartRequest } from "../../control-api/src/run-start.js";
import { createCodexAdapter, CODEX_VENDOR_CLI_VERSION } from "../../harness-codex/src/index.js";
import { createClaudeAdapter, CLAUDE_EFFORT_SNAPSHOT } from "../../harness-claude/src/index.js";
import {
  ConformanceReport,
  ControlThreadTurnRequest,
  GlobalConfig,
  HarnessManifest,
  type QuotaSnapshot,
  type ControlRunStartRequest,
  type HarnessRunSpec,
  type RunEvent,
} from "@claudexor/schema";
import { createRunRequirementsPreflight } from "../../cli/src/request-preflight.js";
import { runCredentialProfileId } from "../../cli/src/run-credential-profile.js";
import { repoHash } from "@claudexor/config";
import { Orchestrator } from "./orchestrator.js";
import { ArtifactStore } from "@claudexor/artifact-store";
import {
  handleThreadTurnCreate,
  type ThreadTurnRouteCtx,
} from "../../control-api/src/thread-turn-routes.js";
import {
  handleRunRetryRoute,
  type RunRetryRouteContext,
} from "../../control-api/src/run-retry-routes.js";
import { resolveContinuationBody } from "../../control-api/src/run-continuation-start.js";
import { timelineEvents } from "../../control-api/src/run-timeline.js";

const roots: string[] = [];
afterEach(
  () => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })),
  0,
); // synchronous removal: no deadline (#376, see vitest.setup.ts)

/** Real source manifests; runtime probes and task execution alone are controlled.
 * No vendor CLI, daemon, listener or model is started. Git is fixture-local. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "auto-browser-"));
  roots.push(root);
  const repoRoot = join(root, "project");
  mkdirSync(repoRoot);
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
  writeFileSync(join(repoRoot, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot });
  execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"],
    { cwd: repoRoot, stdio: "pipe" },
  );
  const codex = createCodexAdapter({
    detectVersion: async () => CODEX_VENDOR_CLI_VERSION,
    brokenInstallAdvisory: () => null,
    probeLogin: async () => ({ authed: false, method: "logged_out", probeError: null }),
    hasApiKey: () => false,
    codexApiKey: () => undefined,
    probeEfforts: async () => null,
  });
  const claude = createClaudeAdapter({
    detectVersion: async () => "2.1.261",
    installation: () => ({ path: null, advisory: null }),
    probeAuthStatus: async () => ({
      loggedIn: false,
      authed: false,
      authMethod: null,
      probeError: null,
    }),
    anthropicApiKey: () => null,
    claudeOAuthToken: () => null,
    probeReadonlyProfile: async () => ({ supported: true, missingFlags: [], detail: "fixture" }),
    probeEffortLevels: async () => ({ levels: CLAUDE_EFFORT_SNAPSHOT, live: false }),
  });
  const specs: Array<{ harness: string; spec: HarnessRunSpec }> = [];
  const registry = new Map<string, HarnessAdapter>();
  for (const real of [codex, claude]) {
    registry.set(real.id, {
      id: real.id,
      capabilityProfile: real.capabilityProfile,
      discover: real.discover,
      async doctor() {
        return ConformanceReport.parse({
          harness_id: real.id,
          status: "ok",
          enabled_intents: [
            "implement",
            "create_from_scratch",
            "repair",
            "explain",
            "plan",
            "audit",
          ],
          auth_sources: [
            { source: "native_session", availability: "available", verification: "passed" },
          ],
        });
      },
      async probeCredentialProfile(profile) {
        return {
          profile_id: profile.profile_id,
          harness_id: real.id,
          availability: "available",
          verification: "passed",
          verification_source: "vendor",
          last_verified_at: null,
          detail: "fixture ready",
        };
      },
      async *run(spec) {
        specs.push({ harness: real.id, spec });
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts };
        yield {
          type: "message",
          session_id: spec.session_id,
          ts,
          final: true,
          payload: { work_report_side_tool: { state: "completed", required_inputs: [] } },
          text: JSON.stringify({
            work_report: { state: "completed", required_inputs: [] },
            output: "Completed fixture task.",
          }),
        };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    });
  }
  const config = GlobalConfig.parse({
    routing: { eligible_harnesses: [], paid_fallback: "never" },
    credential_profiles: ["codex", "claude"].map((id) => ({
      profile_id: `${id}-fixture`,
      harness_id: id,
      display_name: id,
      credential_kind: "config_dir_login",
      isolation_locator: join(root, id),
    })),
  });
  const saveConfig = () =>
    writeFileSync(join(process.env.CLAUDEXOR_CONFIG_DIR!, "config.yaml"), JSON.stringify(config));
  saveConfig();
  const gateway = new HarnessGateway(registry);
  const threadProfile = { id: null as string | null };
  const preflight = createRunRequirementsPreflight({ resolve: () => [] }, root, {
    registry,
    statusAll: (cwd, ids) => gateway.statusAll({ cwd }, ids),
    threadProfileId: () => threadProfile.id,
  });
  const request = (extra: Partial<ControlRunStartRequest> = {}) =>
    normalizeRunStartRequest({
      scope: { kind: "project", root: repoRoot },
      prompt: "Complete the fixture task",
      mode: "agent",
      access: "workspace_write",
      web: "auto",
      browser: true,
      review: false,
      models: { codex: "gpt-6.1-sol", claude: "sonnet" },
      ...extra,
    });
  async function run(p = request(), quotaSnapshots: QuotaSnapshot[] = []) {
    const events: RunEvent[] = [];
    const result = await new Orchestrator({
      registry,
      reviewers: [],
      quotaSnapshots: () => quotaSnapshots,
    }).run({
      ...p,
      attachments: [],
      repoRoot,
      onEvent: (event) => events.push(event),
      credentialProfileId: runCredentialProfileId(p, () => threadProfile.id),
      inPlace: p.execution.isolation === "live",
      workspaceKind: p.execution.workspaceKind,
      scopePaths: p.execution.scopePaths,
      executionRoot: p.execution.workspaceRoot,
    });
    return { result, events };
  }
  return { repoRoot, registry, specs, config, saveConfig, preflight, request, run, threadProfile };
}

describe("ordinary Auto Browser eligibility through normalization, preflight and orchestration", () => {
  it("selects the Browser-compatible real Claude lane without changing its controls", async () => {
    const f = await fixture();
    const request = f.request();
    await f.preflight(request);
    const { result, events } = await f.run(request);
    expect(result.summary).not.toContain("browser was requested but no selected");
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(f.specs.map(({ harness }) => harness)).toEqual(["claude"]);
    expect(f.specs[0]!.spec).toMatchObject({
      access: "workspace_write",
      external_context_policy: "auto",
      model_hint: "sonnet",
      credential_profile: { profile_id: "claude-fixture" },
      browser: { headless: false },
    });
    expect(events.find((event) => event.type === "route.pool.degraded")?.payload).toMatchObject({
      dropped_lanes: [{ harness_id: "codex", stage: "access" }],
    });
  });

  it("keeps Codex first with Browser disabled", async () => {
    const f = await fixture();
    const request = f.request({ browser: false });
    await f.preflight(request);
    const { result } = await f.run(request);
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(f.specs.map(({ harness }) => harness)).toEqual(["codex"]);
    expect(f.specs[0]!.spec.browser).toBeNull();
  });

  it("projects before the incompatible lane's account/quota and processing preparation", async () => {
    const f = await fixture();
    const codex = f.registry.get("codex")!;
    // Record rather than throw: a throwing probe would only drop Codex as an
    // unavailable Auto lane at quota preflight, with or without projection.
    const reached: string[] = [];
    f.registry.set("codex", {
      ...codex,
      probeCredentialProfile: async (...args) => {
        reached.push("account");
        return codex.probeCredentialProfile!(...args);
      },
      prepareProcessing: async () => {
        reached.push("processing");
        throw new Error("incompatible Codex reached processing preparation");
      },
    });
    const { result } = await f.run();
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(f.specs.map(({ harness }) => harness)).toEqual(["claude"]);
    expect(reached).toEqual([]);
  });

  it.each(["auto", "cached", "live"] as const)(
    "preserves non-off web %s on the selected lane",
    async (web) => {
      const f = await fixture();
      const { result } = await f.run(f.request({ web, access: "inherit_native" }));
      expect(result.lifecycle, result.summary).toBe("succeeded");
      expect(f.specs[0]).toMatchObject({
        harness: "claude",
        spec: { access: "inherit_native", external_context_policy: web },
      });
    },
  );

  it("keeps full-access consent and admits Codex only with the existing grant", async () => {
    const f = await fixture();
    const request = f.request({ access: "full" });
    await expect(f.run(request)).rejects.toMatchObject({ code: "trust_full_access_required" });
    expect(f.specs).toEqual([]);
    const trust = join(process.env.CLAUDEXOR_CONFIG_DIR!, "trust");
    mkdirSync(trust, { recursive: true });
    writeFileSync(join(trust, `${repoHash(f.repoRoot)}.yaml`), "allow_full_access: true\n");
    const { result } = await f.run(request);
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(f.specs[0]).toMatchObject({
      harness: "codex",
      spec: { access: "full", browser: { headless: false } },
    });
  });

  it.each(["request pool", "settings pool", "pin", "explicit primary"])(
    "preserves an incompatible Codex %s instead of substituting Claude",
    async (selection) => {
      const f = await fixture();
      if (selection === "settings pool") {
        f.config.routing.eligible_harnesses = ["codex"];
        f.saveConfig();
      }
      const request = f.request({
        ...(selection === "request pool" ? { harnesses: ["codex"] } : {}),
        ...(selection === "pin" ? { credentialProfileId: "codex-fixture" } : {}),
        ...(selection === "explicit primary" ? { primaryHarness: "codex" } : {}),
      });
      if (selection === "explicit primary") await f.preflight(request);
      else
        await expect(f.preflight(request)).rejects.toMatchObject({ code: "browser_unavailable" });
      const { result } = await f.run(request);
      expect(result.lifecycle).toBe("failed");
      expect(result.summary).toContain("codex: access_profile_incompatible");
      expect(f.specs).toEqual([]);
    },
  );

  it("lets a configured primary yield with a truthful capability cause", async () => {
    const f = await fixture();
    f.config.routing.primary_harness = "codex";
    f.saveConfig();
    const { result, events } = await f.run();
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(f.specs.map(({ harness }) => harness)).toEqual(["claude"]);
    expect(events.find((event) => event.type === "route.primary.diverged")?.payload).toMatchObject({
      requested: "codex",
      effective: "claude",
      reason: "capability_incompatible",
      detail: "codex (browser: access_profile_incompatible)",
    });
  });

  it("keeps a configured primary's per-harness web off as its exact cause", async () => {
    const f = await fixture();
    f.config.routing.primary_harness = "codex";
    f.config.harnesses.codex = GlobalConfig.parse({
      harnesses: { codex: { web: "off" } },
    }).harnesses.codex!;
    f.saveConfig();
    const request = f.request();
    await f.preflight(request);
    const { result, events } = await f.run(request);
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(f.specs).toHaveLength(1);
    expect(f.specs[0]).toMatchObject({
      harness: "claude",
      spec: {
        access: "workspace_write",
        external_context_policy: "auto",
        browser: { headless: false },
      },
    });
    const detail = "codex (browser: web_policy_off)";
    expect(events.find((event) => event.type === "route.primary.diverged")?.payload).toMatchObject({
      requested: "codex",
      effective: "claude",
      reason: "capability_incompatible",
      detail,
    });
    expect(events.find((event) => event.type === "route.pool.degraded")?.payload).toMatchObject({
      dropped_lanes: [{ harness_id: "codex", stage: "web", detail }],
    });
    // The run-detail timeline keeps the new reason's event visible with its cause.
    expect(
      timelineEvents({}, events).find((row) => row.type === "route.primary.diverged"),
    ).toMatchObject({ severity: "warning", detail });
  });

  it("treats [] and a null profile as Auto overrides of Settings", async () => {
    const f = await fixture();
    f.config.routing.eligible_harnesses = ["codex"];
    f.saveConfig();
    const request = f.request({ harnesses: [], credentialProfileId: null });
    await f.preflight(request);
    const { result } = await f.run(request);
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(f.specs.map(({ harness }) => harness)).toEqual(["claude"]);
  });

  it.each([{ harnesses: undefined }, { harnesses: ["codex", "claude"] }])(
    "keeps a mixed width-two pool intact: %j",
    async ({ harnesses }) => {
      const f = await fixture();
      const { result, events } = await f.run(f.request({ harnesses, n: 2, review: true }));
      expect(result.lifecycle, result.summary).toBe("succeeded");
      expect(f.specs).toHaveLength(2);
      expect(f.specs.map(({ harness }) => harness).toSorted()).toEqual(["claude", "codex"]);
      expect(f.specs.find(({ harness }) => harness === "codex")?.spec.browser).toBeNull();
      expect(f.specs.find(({ harness }) => harness === "claude")?.spec.browser).toMatchObject({
        headless: false,
      });
      expect(events.some((event) => event.type === "route.pool.degraded")).toBe(false);
    },
  );

  it.each(["missing", "disabled", "unready", "unsupported", "attachment intersection"])(
    "refuses without task starts when Claude is %s",
    async (cause) => {
      const f = await fixture();
      const claude = f.registry.get("claude")!;
      if (cause === "missing") f.registry.delete("claude");
      if (cause === "disabled") {
        f.config.harnesses.claude = GlobalConfig.parse({
          harnesses: { claude: { enabled: false } },
        }).harnesses.claude!;
        f.saveConfig();
      }
      if (cause === "unready")
        f.registry.set("claude", {
          ...claude,
          doctor: async () =>
            ConformanceReport.parse({ harness_id: "claude", status: "unavailable" }),
          probeCredentialProfile: async (profile) => ({
            profile_id: profile.profile_id,
            harness_id: "claude",
            availability: "unavailable",
            verification: "not_run",
            verification_source: "vendor",
            last_verified_at: null,
            detail: "fixture unavailable",
          }),
        });
      if (cause === "unsupported" || cause === "attachment intersection")
        f.registry.set("claude", {
          ...claude,
          discover: async () => {
            const manifest = await claude.discover();
            return HarnessManifest.parse(
              cause === "unsupported"
                ? { ...manifest, capabilities: { ...manifest.capabilities, browser_tool: false } }
                : {
                    ...manifest,
                    capability_profile: { ...manifest.capability_profile, attachment_inputs: [] },
                  },
            );
          },
        });
      const request = f.request(cause === "missing" ? { models: { codex: "gpt-6.1-sol" } } : {});
      const events: RunEvent[] = [];
      const result = await new Orchestrator({ registry: f.registry, reviewers: [] }).run({
        ...request,
        attachments: [],
        repoRoot: f.repoRoot,
        onEvent: (event) => events.push(event),
        ...(cause === "attachment intersection"
          ? {
              attachments: [
                {
                  resource_id: "image",
                  kind: "image",
                  name: "image.png",
                  mime: "image/png",
                  size_bytes: 1,
                  sha256: `sha256:${"a".repeat(64)}`,
                  path: join(f.repoRoot, "image.png"),
                },
              ],
            }
          : {}),
      });
      expect(result.lifecycle).toBe("failed");
      expect(result.summary).toContain("codex: access_profile_incompatible");
      expect(f.specs).toEqual([]);
    },
  );

  it.each(["readonly", "ask", "plan", "off", "harness off"])(
    "never widens access or web: %s",
    async (control) => {
      const f = await fixture();
      if (control === "harness off") {
        f.config.harnesses.claude = GlobalConfig.parse({
          harnesses: { claude: { web: "off" } },
        }).harnesses.claude!;
        f.saveConfig();
      }
      const request = f.request({
        ...(control === "readonly" ? { access: "readonly" } : {}),
        ...(control === "ask" || control === "plan" ? { mode: control, review: undefined } : {}),
        ...(control === "off" ? { web: "off" } : {}),
      });
      // Request admission's per-harness web mismatch is deliberately excluded.
      if (control === "harness off") await f.preflight(request);
      else
        await expect(f.preflight(request)).rejects.toMatchObject({ code: "browser_unavailable" });
      const { result } = await f.run(request);
      expect(result.lifecycle).toBe("failed");
      expect(result.summary).toContain("browser was requested");
      expect(f.specs).toEqual([]);
    },
  );

  it("keeps the compatible lane's exhausted-account code and reset instead of restoring Codex", async () => {
    const f = await fixture();
    const reset = new Date(Date.now() + 3_600_000).toISOString();
    const snapshot: QuotaSnapshot = {
      subject: {
        harness: "claude",
        credential_route: "vendor_native",
        subject_id: "claude-fixture",
        plan_label: null,
      },
      constraints: [
        {
          id: "five_hour",
          label: "Five hour",
          used_ratio: 1,
          window_seconds: 18000,
          cooldown_until: null,
          resets_at: reset,
        },
      ],
      source: "claude_oauth_usage",
      observed_at: new Date().toISOString(),
      freshness: "fresh",
    };
    const request = f.request();
    await f.preflight(request);
    const { result } = await f.run(request, [snapshot]);
    expect(result.lifecycle).toBe("failed");
    expect(f.specs).toEqual([]);
    const failure = new ArtifactStore(f.repoRoot).readYaml(
      join(result.runDir, "final/failure.yaml"),
    );
    expect(failure).toMatchObject({ code: "credential_pool_exhausted", resetsAt: reset });
  });

  it("keeps forbidden billing terminal after compatibility instead of restoring Codex", async () => {
    const f = await fixture();
    const claude = f.registry.get("claude")!;
    f.registry.set("claude", {
      ...claude,
      probeCredentialProfile: async (profile) => ({
        profile_id: profile.profile_id,
        harness_id: "claude",
        availability: "available",
        verification: "passed",
        verification_source: "local_store",
        last_verified_at: null,
        detail: "fixture transport only",
      }),
    });
    const { result } = await f.run();
    expect(result.lifecycle).toBe("failed");
    expect(result.summary).toContain("after budget and quota routing");
    expect(f.specs).toEqual([]);
  });

  it("preserves ordinary access refusal precedence when no lane survives admission", async () => {
    const f = await fixture();
    for (const [id, adapter] of f.registry) {
      f.registry.set(id, {
        ...adapter,
        discover: async () =>
          HarnessManifest.parse({
            ...(await adapter.discover()),
            access_profiles_supported: ["readonly"],
          }),
      });
    }
    const { result } = await f.run();
    expect(result.lifecycle).toBe("failed");
    expect(result.summary).toContain("no harness can enforce the requested access profile");
    expect(
      new ArtifactStore(f.repoRoot).readYaml(join(result.runDir, "final/failure.yaml")),
    ).toMatchObject({ code: "access_profile_incompatible" });
    expect(f.specs).toEqual([]);
  });

  it.each(["auto", "pool", "primary", "pin"])(
    "uses the real thread-turn inheritance boundary: %s",
    async (selection) => {
      const f = await fixture();
      f.threadProfile.id = selection === "pin" ? "codex-fixture" : null;
      let accepted: ControlRunStartRequest | undefined;
      const refusals: unknown[] = [];
      const ctx: ThreadTurnRouteCtx = {
        json() {},
        normalizeStart: normalizeRunStartRequest,
        preflightThreadRunRequirements: f.preflight,
        threadTurnChains: new Map(),
        threadDetail: async () => ({
          thread: {
            repo: { root: f.repoRoot },
            mode: "agent",
            auth_preference: "auto",
            head_run_id: null,
            primary_harness: selection === "primary" ? "codex" : null,
            eligible_harnesses: selection === "pool" ? ["codex"] : [],
            credential_profile_id: selection === "pin" ? "codex-fixture" : null,
            workspace: { mode: "in_place" },
          },
          sessions: [],
          turns: [],
        }),
        createThreadTurn: async () => ({ id: "turn" }),
        setTurnEnqueueError: (_id, problem) => refusals.push(problem),
        waitForRunStart: async () => ({ id: "job", state: "queued" }) as never,
        isTerminalState: () => false,
        readRunArtifactText: async () => null,
        resolveRunArtifactPath: async () => null,
        daemon: {
          enqueue: async (params: ControlRunStartRequest) => {
            accepted = params;
            return { id: "job", state: "queued" };
          },
        } as unknown as ThreadTurnRouteCtx["daemon"],
      };
      await handleThreadTurnCreate(
        ctx,
        {} as ServerResponse,
        "thread",
        ControlThreadTurnRequest.parse({
          prompt: "Fixture turn",
          mode: "agent",
          access: "workspace_write",
          web: "auto",
          browser: true,
          review: false,
        }),
        "thread-key",
      );
      if (selection === "pool" || selection === "pin") {
        expect(accepted).toBeUndefined();
        expect(refusals).toHaveLength(1);
      } else {
        expect(accepted).toBeDefined();
        const { result } = await f.run(accepted!);
        expect(result.lifecycle, result.summary).toBe(
          selection === "auto" ? "succeeded" : "failed",
        );
        expect(f.specs.map(({ harness }) => harness)).toEqual(
          selection === "auto" ? ["claude"] : [],
        );
      }
    },
  );

  it("Exact Retry re-enters requirements and routing with the original controls", async () => {
    const f = await fixture();
    const original = f.request();
    let accepted: ControlRunStartRequest | undefined;
    let preflights = 0;
    const ctx = {
      daemon: {
        findAccepted: async () => null,
        enqueue: async (params: ControlRunStartRequest) => {
          accepted = params;
          return { id: "retry-job" };
        },
      },
      findRun: async () => ({
        id: "source-job",
        runId: "source",
        state: "failed",
        params: original,
      }),
      waitForRunStart: async () => ({ id: "retry-job", runId: "retry", state: "running" }),
      serializeThreadMutation: async (_id: string, work: () => Promise<unknown>) => work(),
      json() {},
      requestError(_res: unknown, error: unknown) {
        throw error;
      },
      services: {
        preflightRunRequirements: async (request: ControlRunStartRequest) => {
          preflights++;
          await f.preflight(request);
        },
      },
    } as unknown as RunRetryRouteContext;
    await handleRunRetryRoute(
      ctx,
      "POST",
      "/runs/source/retry",
      { headers: { "idempotency-key": "retry-key" } } as unknown as IncomingMessage,
      {} as ServerResponse,
    );
    expect(preflights).toBe(1);
    expect(accepted).toMatchObject({
      browser: true,
      access: "workspace_write",
      web: "auto",
      models: original.models,
      retryOf: "source",
    });
    const { result } = await f.run(accepted!);
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(f.specs.map(({ harness }) => harness)).toEqual(["claude"]);
  });

  it("HTTP continuation inherits the existing route group, never a Browser group", async () => {
    const f = await fixture();
    const predecessor = {
      id: "source-job",
      runId: "source",
      state: "failed",
      params: f.request({ primaryHarness: "codex" }),
    };
    const daemon = { list: async () => [predecessor] } as unknown as Parameters<
      typeof resolveContinuationBody
    >[0];
    const inherited = normalizeRunStartRequest(
      await resolveContinuationBody(daemon, {
        continueFrom: "source",
        prompt: "Continue fixture",
        access: "workspace_write",
        browser: true,
        review: false,
      }),
    );
    expect(inherited.primaryHarness).toBe("codex");
    await f.preflight(inherited);
    const strict = await f.run(inherited);
    expect(strict.result.summary).toContain("codex: access_profile_incompatible");
    expect(f.specs).toEqual([]);
    const auto = normalizeRunStartRequest(
      await resolveContinuationBody(daemon, {
        continueFrom: "source",
        prompt: "Continue fixture",
        harnesses: [],
        access: "workspace_write",
        browser: true,
        review: false,
      }),
    );
    expect(auto.primaryHarness).toBeUndefined();
    await f.preflight(auto);
    // This qualifies the successor's routing input, not a native carrier resume.
    const routed = await f.run(auto);
    expect(routed.result.lifecycle, routed.result.summary).toBe("succeeded");
    expect(f.specs.map(({ harness }) => harness)).toEqual(["claude"]);
    const unarmed = normalizeRunStartRequest(
      await resolveContinuationBody(daemon, { continueFrom: "source", prompt: "Continue fixture" }),
    );
    expect(unarmed.browser).not.toBe(true);
  });
});
