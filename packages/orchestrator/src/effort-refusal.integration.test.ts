import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import type { CliRunLoopOptions, HarnessAdapter } from "@claudexor/core";
import {
  ConformanceReport,
  HarnessManifest,
  RunTelemetry,
  type HarnessEvent,
} from "@claudexor/schema";
import { createCodexAdapter, clearCodexEffortCache } from "../../harness-codex/src/index.js";
import { createClaudeAdapter } from "../../harness-claude/src/index.js";
import { Orchestrator } from "./orchestrator.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

it.each([
  ...(["codex", "claude"] as const).flatMap((harness) =>
    (["ask", "plan", "agent"] as const).map((mode) => ({
      harness,
      mode,
      attempts: undefined,
      rejected: true,
    })),
  ),
  { harness: "codex", mode: "agent", attempts: 3, rejected: true } as const,
  { harness: "claude", mode: "agent", attempts: 3, rejected: true } as const,
  ...(["codex", "claude"] as const).flatMap((harness) =>
    (["ask", "agent"] as const).map((mode) => ({
      harness,
      mode,
      attempts: undefined,
      rejected: false,
    })),
  ),
])(
  "$harness $mode (attempts=$attempts, rejected=$rejected) separates effort refusal from availability fallback",
  async ({ harness, mode, attempts, rejected }) => {
    clearCodexEffortCache();
    const root = mkdtempSync(join(tmpdir(), "effort-refusal-"));
    roots.push(root);
    execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
    writeFileSync(join(root, "README.md"), "fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-m",
        "fixture",
      ],
      { cwd: root, stdio: "pipe" },
    );
    const configDir = process.env.CLAUDEXOR_CONFIG_DIR!;
    const profiles = ["a", "b"].map((id) => ({
      profile_id: id,
      harness_id: harness,
      display_name: id,
      credential_kind: "config_dir_login",
      isolation_locator: join(configDir, "profiles", `${harness}-${id}`),
    }));
    for (const profile of profiles) mkdirSync(profile.isolation_locator, { recursive: true });
    writeFileSync(
      join(configDir, "config.yaml"),
      JSON.stringify({
        credential_profiles: profiles,
        harnesses: {
          [harness]: {
            default_model: "fixture",
            fallback_model: "fallback",
            profile_policy: { limit_action: "rotate" },
          },
        },
      }),
    );
    const generation = vi.fn();
    async function* transport({ spec }: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
      if (!rejected && spec.credential_profile?.profile_id === "a")
        throw new Error("fixture transport unavailable before generation");
      generation();
      const common = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield { ...common, type: "started" };
      yield { ...common, type: "message", text: "Fixture finished", final: true };
      yield { ...common, type: "completed" };
    }
    const native =
      harness === "codex"
        ? createCodexAdapter({
            detectVersion: async () => "codex 0.156.1",
            codexApiKey: () => undefined,
            probeLogin: async () => ({ authed: true, method: "chatgpt", probeError: null }),
            probeEfforts: async () => ({
              models: { fixture: { levels: ["low", "high"], default: "low" } },
              defaultModel: "fixture",
            }),
            runCliHarness: transport,
          })
        : createClaudeAdapter({
            detectVersion: async () => "2.1.283",
            anthropicApiKey: () => null,
            claudeOAuthToken: () => null,
            probeReadonlyProfile: async () => ({
              supported: true,
              missingFlags: [],
              detail: "fixture",
            }),
            probeAuthStatus: async () => ({
              loggedIn: true,
              authed: true,
              authMethod: "claude.ai",
              probeError: null,
            }),
            probeEffortLevels: async () => ({ levels: ["low", "high"], live: true }),
            runCliHarness: transport,
          });
    const runs: Array<{ harness: string; profile: string | null; model: string | null }> = [];
    function ready(
      id: string,
    ): Pick<HarnessAdapter, "discover" | "doctor" | "probeCredentialProfile"> {
      return {
        discover: async () =>
          HarnessManifest.parse({
            id,
            display_name: id,
            kind: "local_cli",
            provider_family: "local",
            capabilities: {
              implement: true,
              repair: true,
              plan: true,
              read_files: true,
              explain: true,
              audit: true,
              known_models: ["fixture", "fallback"],
              effort_levels: ["low", "high"],
            },
            auth_modes: ["local_session"],
            access_profiles_supported: ["readonly", "workspace_write"],
          }),
        doctor: async () =>
          ConformanceReport.parse({
            harness_id: id,
            status: "ok",
            enabled_intents: ["implement", "repair", "plan", "explain", "audit"],
            auth_sources: [
              { source: "native_session", availability: "available", verification: "passed" },
            ],
          }),
        probeCredentialProfile: async (profile) => ({
          profile_id: profile.profile_id,
          harness_id: id,
          availability: "available",
          verification: "passed",
          verification_source: "local_store",
          last_verified_at: new Date().toISOString(),
        }),
      };
    }
    const adapter: HarnessAdapter = {
      ...native,
      ...ready(harness),
      prepareProcessing: undefined,
      models: undefined,
      async *run(spec) {
        runs.push({
          harness,
          profile: spec.credential_profile?.profile_id ?? null,
          model: spec.model_hint,
        });
        yield* native.run(spec);
      },
    };
    const sibling: HarnessAdapter = {
      id: "sibling",
      ...ready("sibling"),
      async *run(spec) {
        runs.push({ harness: "sibling", profile: null, model: spec.model_hint });
        generation();
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    };
    const events: string[] = [];
    const result = await new Orchestrator({
      registry: new Map([
        [harness, adapter],
        ["sibling", sibling],
      ]),
      reviewers: [],
      // Both candidate lanes are vendor-verified; these tests isolate effort
      // refusal and transport fallback, not default-login billing inheritance.
      quotaSnapshots: () =>
        profiles.map((profile) => ({
          subject: {
            harness,
            credential_route: "vendor_native",
            plan_label: null,
            subject_id: profile.profile_id,
          },
          constraints: [],
          source: harness === "codex" ? "codex_app_server" : "claude_oauth_usage",
          observed_at: new Date().toISOString(),
          freshness: "fresh",
        })),
    }).run({
      repoRoot: root,
      mode,
      prompt: "fixture",
      harnesses: [harness, "sibling"],
      models: { [harness]: "fixture" },
      effort: rejected ? "future-unplaced" : "high",
      authPreference: "subscription",
      review: false,
      web: "off",
      ...(mode === "agent" ? { inPlace: true, ...(attempts ? { attempts } : {}), n: 1 } : {}),
      onEvent: (event) => events.push(event.type),
    });
    expect(runs, result.summary).toEqual([
      { harness, profile: "a", model: "fixture" },
      ...(!rejected ? [{ harness, profile: "b", model: "fixture" }] : []),
    ]);
    expect(generation).toHaveBeenCalledTimes(rejected ? 0 : 1);
    if (rejected)
      expect(
        events.filter((type) =>
          /route\.profile\.rotat|route\.fallback|route\.transient/.test(type),
        ),
      ).toEqual([]);
    else expect(events).toContain("route.profile.rotated");
    expect(result.lifecycle, result.summary).toBe(rejected ? "failed" : "succeeded");
    const telemetry = RunTelemetry.parse(
      new ArtifactStore(root).readYaml(join(result.runDir, "final", "telemetry.yaml")),
    );
    expect(telemetry.attempts).toHaveLength(1);
    expect(telemetry.attempts[0]?.effort_resolution).toMatchObject({
      requested: rejected ? "future-unplaced" : "high",
      submitted: rejected ? null : "high",
      observed: null,
      resolution: rejected ? "rejected" : "exact",
    });
  },
);
