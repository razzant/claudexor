import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessAdapter } from "@claudexor/core";
import {
  ConformanceReport,
  HarnessCapabilityProfile,
  HarnessManifest,
  type HarnessEvent,
  type HarnessRunSpec,
  type PromptCacheTtl,
  type PromptCacheTtlReceipt,
  type ProviderFamily,
} from "@claudexor/schema";
import { ArtifactStore } from "@claudexor/artifact-store";
import type { ReviewerSpec } from "@claudexor/review";
import { Orchestrator } from "./orchestrator.js";
import { summarizeThreadPrefix } from "./continuity-summary.js";
import { observePromptCacheTtl, type PromptCacheTelemetry } from "./prompt-cache-telemetry.js";
import { routePromptCacheTtl, withReviewerPromptCacheTtl } from "./prompt-cache-routing.js";

const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

const declaring = {
  id: "cached",
  capabilityProfile: HarnessCapabilityProfile.parse({ prompt_cache_ttls: ["5m", "1h"] }),
};
const silent = { id: "plain", capabilityProfile: HarnessCapabilityProfile.parse({}) };

describe("prompt-cache lifetime routing", () => {
  it("forwards only a declared value and discloses the rest", () => {
    expect(routePromptCacheTtl(declaring, undefined)).toEqual({});
    expect(routePromptCacheTtl(declaring, "1h")).toEqual({ ttl: "1h" });
    expect(routePromptCacheTtl(silent, "5m")).toEqual({
      ignored:
        "prompt_cache_ttl=5m (capability_profile.prompt_cache_ttls does not declare it for plain)",
    });
    expect(routePromptCacheTtl({ id: "bare" }, "1h").ignored).toContain("for bare");
  });

  it("reviewers inherit on the same terms and an undeclared harness is disclosed once", () => {
    const warnings: string[] = [];
    const reviewers = withReviewerPromptCacheTtl(
      [{ adapter: declaring }, { adapter: silent }, { adapter: silent }],
      "1h",
      (detail) => warnings.push(detail),
    );
    expect(reviewers.map((reviewer) => reviewer.promptCacheTtl)).toEqual([
      "1h",
      undefined,
      undefined,
    ]);
    expect(warnings).toEqual([
      "reviewer prompt_cache_ttl=1h (capability_profile.prompt_cache_ttls does not declare it for plain)",
    ]);
    expect(
      withReviewerPromptCacheTtl([{ adapter: silent }], undefined, () => {
        throw new Error("Default must not warn");
      }),
    ).toEqual([{ adapter: silent }]);
  });
});

describe("prompt-cache attempt telemetry", () => {
  const receipt = (over: Partial<PromptCacheTtlReceipt>): PromptCacheTtlReceipt => ({
    requested: "1h",
    submitted: "1h",
    reason: null,
    observed: "unknown",
    write_5m_tokens: null,
    write_1h_tokens: null,
    ...over,
  });
  const ev = (
    type: HarnessEvent["type"],
    prompt_cache_ttl?: PromptCacheTtlReceipt,
  ): HarnessEvent => ({
    type,
    session_id: "s",
    ts: "t",
    ...(prompt_cache_ttl ? { prompt_cache_ttl } : {}),
  });

  it("folds finished sessions so a later session cannot erase earlier evidence", () => {
    const t: PromptCacheTelemetry = {};
    observePromptCacheTtl(t, ev("status"));
    expect(t.promptCacheTtl).toBeUndefined();
    observePromptCacheTtl(
      t,
      ev("usage", receipt({ write_1h_tokens: 7, write_5m_tokens: 0, observed: "1h" })),
    );
    observePromptCacheTtl(t, ev("completed"));
    observePromptCacheTtl(t, ev("started", receipt({ reason: "FORCE_PROMPT_CACHING_5M is set" })));
    expect(t.promptCacheTtl).toMatchObject({ observed: "unknown", write_1h_tokens: null });
    observePromptCacheTtl(
      t,
      ev(
        "usage",
        receipt({
          reason: "FORCE_PROMPT_CACHING_5M is set",
          write_1h_tokens: 0,
          write_5m_tokens: 3,
          observed: "5m",
        }),
      ),
    );
    observePromptCacheTtl(t, ev("completed"));
    expect(t.promptCacheTtl).toEqual(
      receipt({
        reason: "FORCE_PROMPT_CACHING_5M is set",
        observed: "mixed",
        write_1h_tokens: 7,
        write_5m_tokens: 3,
      }),
    );
  });
});

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "claudexor-prompt-cache-"));
  roots.push(root);
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
  writeFileSync(join(root, "README.md"), "fixture");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "base"],
    { cwd: root, stdio: "pipe" },
  );
  return root;
}

function fakeAdapter(
  id: string,
  profile: HarnessCapabilityProfile,
  specs: HarnessRunSpec[],
): HarnessAdapter {
  return {
    id,
    capabilityProfile: profile,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "local",
        capabilities: { implement: true, read_files: true, explain: true, audit: true },
        capability_profile: profile,
        auth_modes: ["local_session"],
        access_profiles_supported: ["workspace_write", "readonly"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["implement", "explain", "audit"],
        auth_sources: [
          { source: "native_session", availability: "available", verification: "passed" },
        ],
      });
    },
    async *run(spec) {
      specs.push(spec);
      const common = { session_id: spec.session_id, ts: new Date().toISOString() };
      // A translating adapter stamps its own receipt; the engine only folds it.
      const prompt_cache_ttl: PromptCacheTtlReceipt | undefined = profile.prompt_cache_ttls
        ? {
            requested: spec.prompt_cache_ttl ?? null,
            submitted: spec.prompt_cache_ttl ?? null,
            reason: null,
            observed: "1h",
            write_5m_tokens: 0,
            write_1h_tokens: 42,
          }
        : undefined;
      yield { ...common, type: "started", ...(prompt_cache_ttl ? { prompt_cache_ttl } : {}) };
      yield {
        ...common,
        type: "usage",
        usage: { input_tokens: 1, output_tokens: 1 },
        ...(prompt_cache_ttl ? { prompt_cache_ttl } : {}),
      };
      yield { ...common, type: "message", text: "Answer", final: true };
      yield { ...common, type: "completed" };
    },
  };
}

describe("prompt-cache lifetime through a real orchestrated run", () => {
  async function ask(adapter: HarnessAdapter, promptCacheTtl?: PromptCacheTtl) {
    const root = gitRepo();
    const result = await new Orchestrator({
      registry: new Map([[adapter.id, adapter]]),
      reviewers: [],
    }).run({
      repoRoot: root,
      mode: "ask",
      prompt: "explain the fixture",
      harnesses: [adapter.id],
      review: false,
      web: "off",
      ...(promptCacheTtl ? { promptCacheTtl } : {}),
    });
    const store = new ArtifactStore(root);
    const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; payload?: Record<string, unknown> });
    return {
      result,
      contract: store.readYaml<any>(join(result.runDir, "context", "task.yaml")),
      telemetry: store.readYaml<any>(join(result.runDir, "final", "telemetry.yaml")),
      started: events.filter((event) => event.type === "harness.started"),
    };
  }

  it("captures the lifetime, forwards it to a declaring route and folds its receipt", async () => {
    const specs: HarnessRunSpec[] = [];
    const run = await ask(fakeAdapter("cached", declaring.capabilityProfile, specs), "1h");
    expect(run.result.lifecycle, run.result.summary).toBe("succeeded");
    expect(run.contract.prompt_cache_ttl).toBe("1h");
    expect(specs.map((spec) => spec.prompt_cache_ttl)).toEqual(["1h"]);
    expect(run.started.every((event) => event.payload?.["ignored_settings"] === undefined)).toBe(
      true,
    );
    expect(run.telemetry.attempts[0].prompt_cache_ttl).toEqual({
      requested: "1h",
      submitted: "1h",
      reason: null,
      observed: "1h",
      write_5m_tokens: 0,
      write_1h_tokens: 42,
    });
  });

  it("discloses the lifetime on harness.started for a route that does not declare it", async () => {
    const specs: HarnessRunSpec[] = [];
    const run = await ask(fakeAdapter("plain", silent.capabilityProfile, specs), "5m");
    expect(run.result.lifecycle, run.result.summary).toBe("succeeded");
    expect(run.contract.prompt_cache_ttl).toBe("5m");
    expect(specs.map((spec) => spec.prompt_cache_ttl)).toEqual([undefined]);
    expect(run.started.map((event) => event.payload?.["ignored_settings"])).toEqual([
      ["prompt_cache_ttl=5m (capability_profile.prompt_cache_ttls does not declare it for plain)"],
    ]);
    expect(run.telemetry.attempts[0].prompt_cache_ttl).toBeUndefined();
  });

  it("Default captures nothing and forwards nothing", async () => {
    const specs: HarnessRunSpec[] = [];
    const run = await ask(fakeAdapter("cached", declaring.capabilityProfile, specs));
    expect(run.contract.prompt_cache_ttl).toBeUndefined();
    expect(specs.map((spec) => spec.prompt_cache_ttl)).toEqual([undefined]);
    expect(run.telemetry.attempts[0].prompt_cache_ttl).toMatchObject({
      requested: null,
      submitted: null,
    });
  });
});

const lifetimes = [
  ["1h", "1h"],
  ["5m", "5m"],
  ["Default", undefined],
] as const;

function runEvents(runDir: string) {
  return readFileSync(join(runDir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; payload?: Record<string, unknown> });
}

function capturingReviewer(
  id: string,
  family: ProviderFamily,
  profile: HarnessCapabilityProfile,
  specs: HarnessRunSpec[],
): ReviewerSpec {
  const adapter: HarnessAdapter = {
    id,
    capabilityProfile: profile,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: family,
        capabilities: { review: true },
        capability_profile: profile,
      });
    },
    async doctor() {
      return ConformanceReport.parse({ harness_id: id, status: "ok", enabled_intents: ["review"] });
    },
    async *run(spec) {
      specs.push(spec);
      const common = { session_id: spec.session_id, ts: new Date().toISOString() };
      const route = { credential_route: "managed_api_key" as const };
      yield { ...common, ...route, type: "started", observed_model: `${id}-model` };
      yield { ...common, type: "message", text: "```json\n[]\n```" };
      yield { ...common, ...route, type: "usage", usage: { cost_usd: 0.001 } };
      yield { ...common, type: "completed" };
    },
  };
  return { adapter, providerFamily: family };
}

const implementer: HarnessAdapter = {
  id: "impl",
  async discover() {
    return HarnessManifest.parse({
      id: "impl",
      display_name: "impl",
      kind: "local_cli",
      provider_family: "local",
      capabilities: { implement: true },
      access_profiles_supported: ["workspace_write", "full"],
    });
  },
  async doctor() {
    return ConformanceReport.parse({
      harness_id: "impl",
      status: "ok",
      enabled_intents: ["implement"],
    });
  },
  async *run(spec) {
    const common = { session_id: spec.session_id, ts: new Date().toISOString() };
    const route = { credential_route: "managed_api_key" as const };
    yield { ...common, ...route, type: "started", observed_model: "impl-model" };
    writeFileSync(join(spec.cwd, "CHANGED.txt"), "real change\n");
    yield { ...common, type: "message", text: "Implemented." };
    yield { ...common, ...route, type: "usage", usage: { input_tokens: 1, output_tokens: 1 } };
    yield { ...common, type: "completed" };
  },
};

describe("reviewer HarnessRunSpec through a real orchestrated Agent run", () => {
  // A reviewed Agent run takes seconds; the budget keeps a busy host from timing out.
  it.each(lifetimes)(
    "routes %s to reviewers by declaration",
    async (_label, ttl) => {
      const cached: HarnessRunSpec[] = [];
      const plain: HarnessRunSpec[] = [];
      const result = await new Orchestrator({
        registry: new Map([[implementer.id, implementer]]),
        reviewers: [
          capturingReviewer("rev-cached", "anthropic", declaring.capabilityProfile, cached),
          capturingReviewer("rev-plain", "openai", silent.capabilityProfile, plain),
        ],
      }).run({
        repoRoot: gitRepo(),
        mode: "agent",
        prompt: "implement the change",
        harnesses: [implementer.id],
        review: true,
        web: "off",
        ...(ttl ? { promptCacheTtl: ttl } : {}),
      });
      expect(result.lifecycle, result.summary).toBe("succeeded");
      expect(cached.map((spec) => spec.prompt_cache_ttl)).toEqual([ttl]);
      expect(plain.map((spec) => spec.prompt_cache_ttl)).toEqual([undefined]);
      const disclosed = runEvents(result.runDir)
        .filter((event) => event.type === "review.preflight")
        .flatMap((event) => (event.payload?.["ignored_settings"] as string[] | undefined) ?? [])
        .filter((detail) => detail.includes("prompt_cache_ttl"));
      expect(disclosed).toEqual(
        ttl
          ? [
              `reviewer prompt_cache_ttl=${ttl} (capability_profile.prompt_cache_ttls does not declare it for rev-plain)`,
            ]
          : [],
      );
    },
    120_000,
  );
});

describe("continuity summary pass", () => {
  it.each(lifetimes)("carries %s into its HarnessRunSpec", async (_label, ttl) => {
    const specs: HarnessRunSpec[] = [];
    const summary = await summarizeThreadPrefix({
      adapter: fakeAdapter("cached", declaring.capabilityProfile, specs),
      turns: [{ id: "t1", prompt: "decision", outputText: "state" }],
      cwd: gitRepo(),
      env: {},
      credentialProfile: null,
      authPreference: "auto",
      envInheritance: "clean",
      ...(ttl ? { processing: { prompt_cache_ttl: ttl } } : {}),
    });
    expect(summary).toBe("Answer");
    expect(specs.map((spec) => spec.prompt_cache_ttl)).toEqual([ttl]);
  });
});

describe("delegation belt env carries the captured lifetime", () => {
  it("rebinds the belt variable from the run input and clears it for Default", async () => {
    const { delegationBeltFor } = await import("./delegationBelt.js");
    const { DELEGATION_ENV } = await import("@claudexor/util");
    const routed = {
      delegationRequirement: { effective: true },
      mcpInjectionRequiresFullAccess: false,
      adapterAccess: "workspace_write",
    } as never;
    const input = (promptCacheTtl?: PromptCacheTtl) =>
      ({
        delegate: true,
        delegationParentRunId: "parent",
        repoRoot: "/source",
        promptCacheTtl,
        delegationBelt: {
          name: "claudexor",
          command: "/bin/belt",
          args: [],
          env: { [DELEGATION_ENV.promptCacheTtl]: "stale" },
        },
      }) as never;
    const [explicit] = delegationBeltFor(input("1h"), "implement", routed, { kind: "unlimited" });
    expect(explicit?.env[DELEGATION_ENV.promptCacheTtl]).toBe("1h");
    const [defaulted] = delegationBeltFor(input(), "implement", routed, { kind: "unlimited" });
    expect(defaulted?.env).not.toHaveProperty(DELEGATION_ENV.promptCacheTtl);
  });
});
