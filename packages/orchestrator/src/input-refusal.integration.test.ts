import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import { ArtifactStore } from "@claudexor/artifact-store";
import {
  ConformanceReport,
  HarnessManifest,
  RunFailure,
  RunTelemetry,
  type HarnessEvent,
  type HarnessRequestRefusal,
  type HarnessRunSpec,
  type QuotaSnapshot,
} from "@claudexor/schema";
import { Orchestrator } from "./orchestrator.js";
import { createClaudeParser } from "../../harness-claude/src/parse.js";
import {
  withClaudeApiFailureParser,
  withClaudeVendorFailure,
} from "../../harness-claude/src/vendor-failure.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)
const refusal: HarnessRequestRefusal = {
  kind: "input_too_large",
  scope: "turn_text",
  unit: "unicode_scalars",
  limit: 10,
  actual: 11,
  source: "fixture.turn/start",
  native_code: "input_too_large",
};

function fixture(run: (spec: HarnessRunSpec) => AsyncIterable<HarnessEvent>, harness = "codex") {
  const root = mkdtempSync(join(tmpdir(), "input-refusal-"));
  roots.push(root);
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
  writeFileSync(join(root, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"],
    { cwd: root, stdio: "pipe" },
  );
  const config = process.env.CLAUDEXOR_CONFIG_DIR!;
  const profiles = ["a", "b", "c"].map((id) => ({
    profile_id: id,
    harness_id: harness,
    display_name: id,
    credential_kind: "config_dir_login",
    isolation_locator: join(config, "profiles", id),
  }));
  for (const p of profiles) mkdirSync(p.isolation_locator, { recursive: true });
  writeFileSync(
    join(config, "config.yaml"),
    JSON.stringify({
      credential_profiles: profiles,
      harnesses: {
        [harness]: {
          default_model: "target",
          fallback_model: "fallback",
          profile_policy: { limit_action: "rotate" },
        },
      },
    }),
  );
  const adapter: HarnessAdapter = {
    id: harness,
    run,
    discover: async () =>
      HarnessManifest.parse({
        id: harness,
        display_name: "fixture",
        kind: "local_cli",
        provider_family: "local",
        capabilities: {
          implement: true,
          repair: true,
          read_files: true,
          explain: true,
          audit: true,
          plan: true,
          synthesize: true,
          known_models: ["target", "fallback"],
        },
        auth_modes: ["local_session"],
        access_profiles_supported: ["readonly", "workspace_write", "full"],
      }),
    doctor: async () =>
      ConformanceReport.parse({
        harness_id: harness,
        status: "ok",
        enabled_intents: ["implement", "repair", "explain", "audit", "plan", "synthesize"],
        auth_sources: [
          { source: "native_session", availability: "available", verification: "passed" },
        ],
      }),
    probeCredentialProfile: async (p) => ({
      profile_id: p.profile_id,
      harness_id: harness,
      availability: "available",
      verification: "passed",
      verification_source: "local_store",
      last_verified_at: new Date().toISOString(),
    }),
  };
  // The named accounts have their own vendor proof, independently of the
  // default doctor. Refusal tests then exercise the intended account order.
  const vendorSnapshots: QuotaSnapshot[] = profiles.map((profile) => ({
    subject: {
      harness,
      credential_route: "vendor_native",
      plan_label: null,
      subject_id: profile.profile_id,
    },
    constraints: [],
    source: harness === "claude" ? "claude_oauth_usage" : "codex_app_server",
    observed_at: new Date().toISOString(),
    freshness: "fresh",
  }));
  return { root, adapter, vendorSnapshots };
}
const common = (spec: HarnessRunSpec) => ({
  session_id: spec.session_id,
  ts: new Date().toISOString(),
  credential_route: "vendor_native" as const,
  credential_profile_id: spec.credential_profile?.profile_id,
});

it.each([
  { mode: "ask" as const, attempts: undefined },
  { mode: "agent" as const, attempts: undefined },
  { mode: "agent" as const, attempts: 3 },
  { mode: "plan" as const, attempts: undefined },
  { mode: "ask" as const, attempts: undefined, deepScan: true, n: 1 },
])(
  "$mode (attempts=$attempts) preserves typed input refusal through final artifacts without rotating or retrying",
  async ({ mode, attempts, ...options }) => {
    const calls: string[] = [];
    const { root, adapter, vendorSnapshots } = fixture(async function* (spec) {
      calls.push(`${spec.credential_profile?.profile_id}:${spec.model_hint}`);
      yield { ...common(spec), type: "error", error: "request refused", request_refusal: refusal };
      yield { ...common(spec), type: "completed", payload: { harness_reported_error: true } };
    });
    const events: string[] = [];
    const result = await new Orchestrator({
      registry: new Map([[adapter.id, adapter]]),
      reviewers: [],
      quotaSnapshots: () => vendorSnapshots,
    }).run({
      repoRoot: root,
      mode,
      prompt: "12345678901",
      harnesses: ["codex"],
      models: { codex: "target" },
      authPreference: "subscription",
      review: false,
      web: "off",
      ...options,
      ...(mode === "agent" ? { inPlace: true, n: 1, ...(attempts ? { attempts } : {}) } : {}),
      onEvent: (e) => events.push(e.type),
    });
    expect(result.lifecycle).toBe("failed");
    expect(calls).toEqual(["a:target"]);
    expect(
      events.filter(
        (e) =>
          e.startsWith("route.profile.rotat") ||
          e.startsWith("route.transient") ||
          (mode !== "plan" && e.startsWith("route.fallback")),
      ),
    ).toEqual([]);
    const store = new ArtifactStore(root);
    const failure = RunFailure.parse(store.readYaml(join(result.runDir, "final/failure.yaml")));
    expect(failure).toMatchObject({
      category: "validation",
      code: "input_too_large",
      requestRefusal: refusal,
      resetsAt: null,
    });
    expect(failure.nextActions.join(" ")).not.toContain("Retry the run");
    const telemetry = RunTelemetry.parse(
      store.readYaml(join(result.runDir, "final/telemetry.yaml")),
    );
    expect(telemetry.attempts[0]?.request_refusal).toEqual(refusal);
  },
);

it.each(["structural", "quota"] as const)("keeps useful %s account failover", async (cause) => {
  const calls: string[] = [];
  const { root, adapter, vendorSnapshots } = fixture(async function* (spec) {
    const profile = spec.credential_profile!.profile_id;
    calls.push(profile);
    if (profile === "a") {
      if (cause === "quota")
        yield {
          ...common(spec),
          type: "status",
          rate_limit: {
            resets_at: new Date(Date.now() + 60000).toISOString(),
            retry_delay_ms: null,
          },
        };
      yield { ...common(spec), type: "error", error: "fixture refusal" };
    } else yield { ...common(spec), type: "message", text: "Completed normally", final: true };
    yield { ...common(spec), type: "completed" };
  });
  const result = await new Orchestrator({
    registry: new Map([[adapter.id, adapter]]),
    reviewers: [],
    quotaSnapshots: () => vendorSnapshots,
  }).run({
    repoRoot: root,
    mode: "ask",
    prompt: "short",
    harnesses: ["codex"],
    models: { codex: "target" },
    authPreference: "subscription",
    review: false,
    web: "off",
  });
  expect(calls).toEqual(["a", "b"]);
  expect(result.lifecycle, result.summary).toBe("succeeded");
});

it.each([false, true])(
  "does not borrow earlier/untried quota for a later structural failure (earlier quota=%s)",
  async (earlierQuota) => {
    const calls: string[] = [];
    const { root, adapter, vendorSnapshots } = fixture(async function* (spec) {
      const profile = spec.credential_profile!.profile_id;
      calls.push(profile);
      if (earlierQuota && profile === "a")
        yield {
          ...common(spec),
          type: "status",
          rate_limit: {
            resets_at: new Date(Date.now() + 60000).toISOString(),
            retry_delay_ms: null,
          },
        };
      yield { ...common(spec), type: "error", error: "fixture structural failure" };
      yield { ...common(spec), type: "completed" };
    });
    const snapshots: QuotaSnapshot[] = [
      {
        subject: {
          harness: "codex",
          credential_route: "vendor_native",
          plan_label: null,
          subject_id: "c",
        },
        constraints: [
          {
            id: "week",
            label: "week",
            used_ratio: 1,
            window_seconds: 604800,
            resets_at: new Date(Date.now() + 60000).toISOString(),
            cooldown_until: null,
          },
        ],
        source: "codex_app_server",
        observed_at: new Date().toISOString(),
        freshness: "fresh",
      },
    ];
    const result = await new Orchestrator({
      registry: new Map([[adapter.id, adapter]]),
      reviewers: [],
      quotaSnapshots: () => [
        ...snapshots,
        ...vendorSnapshots.filter(
          (row) =>
            !snapshots.some((override) => override.subject.subject_id === row.subject.subject_id),
        ),
      ],
    }).run({
      repoRoot: root,
      mode: "ask",
      prompt: "short",
      harnesses: ["codex"],
      models: { codex: "target" },
      authPreference: "subscription",
      review: false,
      web: "off",
    });
    const failure = RunFailure.parse(
      new ArtifactStore(root).readYaml(join(result.runDir, "final/failure.yaml")),
    );
    expect(calls).toContain("b");
    expect(calls).not.toContain("c");
    expect(failure).toMatchObject({ code: null, resetsAt: null });
    expect(failure.safeMessage).toContain("fixture structural failure");
  },
);

it("input refusal skips the same-harness model retry without inventing a new cross-harness ASK route", async () => {
  const calls: string[] = [];
  const { root, adapter, vendorSnapshots } = fixture(async function* (spec) {
    calls.push(`codex:${spec.model_hint}`);
    yield { ...common(spec), type: "error", error: "request refused", request_refusal: refusal };
    yield { ...common(spec), type: "completed" };
  });
  const sibling: HarnessAdapter = {
    ...adapter,
    id: "sibling",
    probeCredentialProfile: undefined,
    discover: async () => ({ ...(await adapter.discover())!, id: "sibling" }),
    doctor: async (spec) => ({ ...(await adapter.doctor(spec)), harness_id: "sibling" }),
    run: async function* (spec) {
      calls.push("sibling");
      yield { ...common(spec), type: "message", text: "Other harness completed", final: true };
      yield { ...common(spec), type: "completed" };
    },
  };
  const result = await new Orchestrator({
    registry: new Map([
      ["codex", adapter],
      ["sibling", sibling],
    ]),
    reviewers: [],
    quotaSnapshots: () => vendorSnapshots,
  }).run({
    repoRoot: root,
    mode: "ask",
    prompt: "12345678901",
    harnesses: ["codex", "sibling"],
    models: { codex: "target" },
    authPreference: "subscription",
    review: false,
    web: "auto",
    n: 2,
  });
  expect(calls).toEqual(["codex:target"]);
  expect(result.lifecycle, result.summary).toBe("failed");
});

it.each([
  { mode: "plan" as const, council: true, deepScan: false },
  { mode: "ask" as const, council: false, deepScan: true },
])("$mode aggregate preserves input refusal only when every cause agrees", async (strategy) => {
  for (const mixed of [false, true]) {
    const calls: string[] = [];
    const { root, adapter, vendorSnapshots } = fixture(async function* (spec) {
      calls.push("codex");
      yield { ...common(spec), type: "error", error: "input refused", request_refusal: refusal };
      yield { ...common(spec), type: "completed", payload: { harness_reported_error: true } };
    });
    const sibling: HarnessAdapter = {
      ...adapter,
      id: "sibling",
      probeCredentialProfile: undefined,
      discover: async () => ({ ...(await adapter.discover())!, id: "sibling" }),
      doctor: async (spec) => ({ ...(await adapter.doctor(spec)), harness_id: "sibling" }),
      run: async function* (spec) {
        calls.push("sibling");
        yield {
          ...common(spec),
          type: "error",
          error: mixed ? "other failure" : "input refused",
          ...(mixed ? {} : { request_refusal: refusal }),
        };
        yield { ...common(spec), type: "completed", payload: { harness_reported_error: true } };
      },
    };
    const result = await new Orchestrator({
      registry: new Map([
        ["codex", adapter],
        ["sibling", sibling],
      ]),
      reviewers: [],
      quotaSnapshots: () => vendorSnapshots,
    }).run({
      repoRoot: root,
      prompt: "12345678901",
      harnesses: ["codex", "sibling"],
      primaryHarness: "codex",
      mode: strategy.mode,
      n: 2,
      ...(strategy.council ? { council: true } : { deepScan: true }),
      authPreference: "subscription",
      review: false,
      web: "auto",
    });
    expect(calls.sort()).toEqual(["codex", "sibling"]);
    expect(result.lifecycle).toBe("failed");
    const failure = RunFailure.parse(
      new ArtifactStore(root).readYaml(join(result.runDir, "final/failure.yaml")),
    );
    expect(failure.code).toBe(mixed ? null : "input_too_large");
    expect(failure.requestRefusal).toEqual(mixed ? undefined : refusal);
    expect(failure.category).toBe(mixed ? "harness_error" : "validation");
    expect(failure.resetsAt).toBeNull();
    if (!mixed) expect(failure.nextActions.join(" ")).not.toMatch(/Retry|Reduce explore width/);
  }
});

it.each([false, true])(
  "solo Plan reports the last failed route (input refusal=%s)",
  async (lastRefuses) => {
    const calls: string[] = [];
    const { root, adapter, vendorSnapshots } = fixture(async function* (spec) {
      calls.push("codex");
      yield {
        ...common(spec),
        type: "error",
        error: "first failure",
        ...(lastRefuses ? {} : { request_refusal: refusal }),
      };
      yield { ...common(spec), type: "completed" };
    });
    const sibling: HarnessAdapter = {
      ...adapter,
      id: "sibling",
      probeCredentialProfile: undefined,
      discover: async () => ({ ...(await adapter.discover())!, id: "sibling" }),
      doctor: async (spec) => ({ ...(await adapter.doctor(spec)), harness_id: "sibling" }),
      run: async function* (spec) {
        calls.push("sibling");
        yield {
          ...common(spec),
          type: "error",
          error: "different terminal failure",
          ...(lastRefuses ? { request_refusal: refusal } : {}),
        };
        yield { ...common(spec), type: "completed" };
      },
    };
    const result = await new Orchestrator({
      registry: new Map([
        ["codex", adapter],
        ["sibling", sibling],
      ]),
      reviewers: [],
      quotaSnapshots: () => vendorSnapshots,
    }).run({
      repoRoot: root,
      mode: "plan",
      prompt: "12345678901",
      harnesses: ["codex", "sibling"],
      primaryHarness: "codex",
      authPreference: "subscription",
      web: "auto",
      review: false,
    });
    expect(calls).toEqual(["codex", "sibling"]);
    const failure = RunFailure.parse(
      new ArtifactStore(root).readYaml(join(result.runDir, "final/failure.yaml")),
    );
    expect(failure).toMatchObject({
      category: lastRefuses ? "validation" : "harness_error",
      code: lastRefuses ? "input_too_large" : null,
      resetsAt: null,
    });
    expect(failure.requestRefusal).toEqual(lastRefuses ? refusal : undefined);
  },
);

it.each([
  { mode: "ask" as const, version: "2.1.288", typed: true },
  { mode: "agent" as const, version: "2.1.288", typed: true },
  { mode: "plan" as const, version: "2.1.288", typed: true },
  { mode: "ask" as const, version: "2.1.165", typed: false },
  { mode: "agent" as const, version: "2.1.165", typed: false },
  { mode: "plan" as const, version: "2.1.165", typed: false },
])(
  "$mode keeps Claude $version native cause and owner-selected rotation policy",
  async ({ mode, version, typed }) => {
    const frames = readFileSync(
      new URL(
        `../../harness-claude/fixtures/signals/vendor-cli-too-old-${version}.jsonl`,
        import.meta.url,
      ),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const calls: string[] = [];
    const { root, adapter, vendorSnapshots } = fixture(async function* (spec) {
      calls.push(spec.credential_profile!.profile_id);
      const parse = withClaudeApiFailureParser(createClaudeParser(), "/fixture/claude");
      async function* nativeEvents() {
        for (const frame of frames) {
          for (const event of parse(frame, spec.session_id) ?? [])
            yield { ...event, ...common(spec) };
        }
        yield {
          ...common(spec),
          type: "completed" as const,
          payload: { exit_code: 1, harness_reported_error: true },
        };
      }
      yield* withClaudeVendorFailure(nativeEvents());
    }, "claude");
    const result = await new Orchestrator({
      registry: new Map([[adapter.id, adapter]]),
      reviewers: [],
      quotaSnapshots: () => vendorSnapshots,
    }).run({
      repoRoot: root,
      mode,
      prompt: "fixture",
      harnesses: ["claude"],
      models: { claude: "target" },
      authPreference: "subscription",
      review: false,
      web: "off",
      ...(mode === "agent" ? { inPlace: true, n: 1 } : {}),
    });
    expect(result.lifecycle).toBe("failed");
    expect(calls).toEqual(
      typed || mode === "plan"
        ? ["a"]
        : mode === "ask"
          ? ["a", "b", "c", "a", "b", "c"]
          : ["a", "b", "c"],
    );
    const failure = RunFailure.parse(
      new ArtifactStore(root).readYaml(join(result.runDir, "final/failure.yaml")),
    );
    expect(failure.code).toBe(typed ? "vendor_cli_too_old" : null);
    expect(failure.safeMessage).toContain(frames.at(-1)!.result);
    expect(failure.vendorFailure).toMatchObject({
      code: typed ? "claude_code_version_too_old" : null,
      message: frames.at(-1)!.result,
      source: "claude_stdout",
    });
    expect(failure.nextActions.join(" ")).not.toMatch(/Re-authenticate|crashed/);
    expect(failure.resetsAt).toBeNull();
    if (typed) {
      expect(failure.category).toBe("harness_unavailable");
      expect(failure.requestRefusal).toMatchObject({
        kind: "vendor_cli_too_old",
        binary_path: "/fixture/claude",
        installed_version: version,
      });
      expect(failure.nextActions.join(" ")).toContain(
        "Update the Claude Code CLI at /fixture/claude",
      );
      expect(failure.nextActions.join(" ")).toContain(version);
      expect(failure.nextActions.join(" ")).toContain("claudexor harness update claude --yes");
    }
  },
);
