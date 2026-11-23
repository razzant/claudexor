/**
 * Harness side of the zero-budget diagnostics fixture
 * (`../zero-budget-diagnostics.integration.test.ts`): the REAL Claude and Codex
 * adapters over vendor runtime stubs (their own manifests and doctor; fictitious
 * key strings, no binary, no network). Every paid diagnostic generation request
 * (a key or setup-token smoke) lands on a counter, and each adapter's `run` is a
 * recorder that names the credential route the spawn actually carries, so no
 * provider can start.
 */
import { resolve } from "node:path";
import type { HarnessAdapter, HarnessModelSpec } from "@claudexor/core";
import { CLAUDE_EFFORT_SNAPSHOT, createClaudeAdapter } from "@claudexor/harness-claude";
import { CODEX_VENDOR_CLI_VERSION, createCodexAdapter } from "@claudexor/harness-codex";
import {
  ConformanceReport,
  HarnessManifest,
  HarnessModel,
  type HarnessEvent,
  type HarnessRunSpec,
} from "@claudexor/schema";
import { recorder } from "./profile-admission-adapters.js";

/** Fictitious credential material: never a real provider key. */
const FAKE_KEY = "fixture-not-a-real-key";
/** The one model the stubbed vendor inventory lists. */
const FIXTURE_MODEL = "fixture-model";

export const zero = {
  /** Which credential sources the vendor stubs report as present (keys are fictitious). */
  sources: { nativeClaude: false, anthropicKey: false, claudeSetupToken: false, openaiKey: false },
  /** Physical diagnostic generation requests (the paid smoke boundary). */
  paidProbeCalls: { claudeApiKey: 0, claudeSetupToken: 0, codexApiKey: 0 },
  /** Run spawns, by what the engine's own spec asks of the adapter. */
  spawns: [] as Array<{
    harness: string;
    /** The spec's auth preference: `auto` stays `auto` until the engine pins it. */
    authPreference: string;
    /** The route the stand-in actually carried, resolved after the spec was read. */
    route: "subscription" | "api_key";
    profile: string | null;
    model: string | null;
  }>,
  /** Doctor reads, by harness. */
  doctors: [] as Array<{ harness: string; diagnosticGeneration: string | null }>,
  /** Model catalog reads, by harness and the mode each carried. */
  catalogs: [] as Array<{ harness: string; diagnosticGeneration: string | null }>,
  /** The synthetic metered lane: whether the registry offers it, and its physical sends. */
  metered: { present: false, runs: 0 },
};

export function resetZero(): void {
  zero.sources = {
    nativeClaude: false,
    anthropicKey: false,
    claudeSetupToken: false,
    openaiKey: false,
  };
  zero.paidProbeCalls = { claudeApiKey: 0, claudeSetupToken: 0, codexApiKey: 0 };
  zero.spawns = [];
  zero.doctors = [];
  zero.catalogs = [];
  zero.metered = { present: false, runs: 0 };
}

const loggedIn = (home: string | undefined | null) =>
  Boolean(home) && recorder.loggedIn.has(resolve(home!));

function recorded(real: HarnessAdapter): HarnessAdapter {
  const id = real.id;
  // The real adapter with every member kept (catalog, processing, account probe,
  // manifest); only the doctor read, the catalog reads and the spawn are observed.
  // `program` is left out so no read resolves or starts a vendor binary.
  const { program: _program, ...adapter } = real;
  void _program;
  const observeCatalog = (spec?: HarnessModelSpec) =>
    zero.catalogs.push({ harness: id, diagnosticGeneration: spec?.diagnosticGeneration ?? null });
  return {
    ...adapter,
    doctor: async (spec) => {
      zero.doctors.push({ harness: id, diagnosticGeneration: spec.diagnosticGeneration ?? null });
      return real.doctor(spec);
    },
    ...(real.models
      ? {
          models: async (spec?: HarnessModelSpec) => {
            observeCatalog(spec);
            return real.models!(spec);
          },
        }
      : {}),
    ...(real.modelCatalog
      ? {
          modelCatalog: async (spec?: HarnessModelSpec) => {
            observeCatalog(spec);
            return real.modelCatalog!(spec);
          },
        }
      : {}),
    async *run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      const profile = spec.credential_profile ?? null;
      // What the engine's own spec asks for: a pinned account names its kind,
      // otherwise the spec's preference stands and `auto` is left unresolved.
      const asked = profile
        ? profile.credential_kind === "api_key"
          ? "api_key"
          : "subscription"
        : spec.auth_preference === "api_key"
          ? "api_key"
          : spec.auth_preference === "subscription"
            ? "subscription"
            : "auto";
      // No vendor process exists to resolve `auto`: the stand-in answers from the
      // sources the stubs report.
      const route =
        asked !== "auto"
          ? asked
          : id === "claude" && zero.sources.nativeClaude
            ? "subscription"
            : "api_key";
      // The recorder keeps the resolved route; what the engine's spec asked for stays
      // apart in `authPreference`, so a named key is never counted as a subscription.
      zero.spawns.push({
        harness: id,
        authPreference: spec.auth_preference,
        route,
        profile: profile?.profile_id ?? null,
        model: spec.model_hint ?? null,
      });
      const ts = new Date().toISOString();
      const stamp = {
        credential_route:
          route === "subscription" ? ("vendor_native" as const) : ("managed_api_key" as const),
        credential_source:
          route === "subscription" ? ("native_session" as const) : ("api_key_env" as const),
        ...(profile ? { credential_profile_id: profile.profile_id } : {}),
      };
      yield {
        type: "started",
        session_id: spec.session_id,
        ts,
        payload: { native_session_id: `zero-${id}-${zero.spawns.length}` },
        ...stamp,
      } as HarnessEvent;
      yield {
        type: "message",
        session_id: spec.session_id,
        ts,
        text: "done",
        final: true,
        ...stamp,
      } as HarnessEvent;
      yield {
        type: "completed",
        session_id: spec.session_id,
        ts,
        payload: { exit_code: 0 },
        ...stamp,
      } as HarnessEvent;
    },
  };
}

/**
 * A synthetic METERED executor: a remote-API lane with no subscription source and no network.
 * Its `run` is the physical-send counter; the same minimal adapter shape other engine tests use.
 */
const METERED_ID = "fixture-metered";
export const meteredAdapter: HarnessAdapter = {
  id: METERED_ID,
  async discover() {
    // Explicit and minimal, in the shape of the real raw-api manifest: `capability_profile`
    // is required input. `read_files: true` keeps a project-scope Ask from dropping the lane.
    return HarnessManifest.parse({
      id: METERED_ID,
      display_name: METERED_ID,
      kind: "remote_api",
      provider_family: "openai",
      capabilities: {
        plan: true,
        implement: false,
        implementation_transport: "workspace",
        create_from_scratch: false,
        review: false,
        verify: false,
        synthesize: false,
        read_files: true,
        browser_tool: false,
        web_policy: "none",
        work_report_transport: "unsupported",
        effort_levels: [],
      },
      capability_profile: {
        auth: {
          supported_sources: ["api_key_env"],
          preferred_source: "api_key_env",
          credential_transports: [
            { source: "api_key_env", kind: "http_header", relocatable_by: ["ENV"] },
          ],
        },
        access_control: {
          readonly_mechanism: "none",
          write_mechanism: "none",
          auxiliary_writable_roots: false,
        },
        isolation: { supported_containment: ["env_or_file_injection"] },
      },
      auth_modes: ["api_key"],
      access_profiles_supported: ["readonly"],
    });
  },
  async doctor() {
    return ConformanceReport.parse({
      harness_id: METERED_ID,
      status: "ok",
      enabled_intents: ["explain"],
    });
  },
  async *run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
    zero.metered.runs += 1;
    const ts = new Date().toISOString();
    yield { type: "started", session_id: spec.session_id, ts };
    yield { type: "message", session_id: spec.session_id, ts, text: "done", final: true };
    yield { type: "completed", session_id: spec.session_id, ts, payload: { exit_code: 0 } };
  },
};

export const zeroRegistry = new Map<string, HarnessAdapter>([
  [
    "claude",
    recorded(
      createClaudeAdapter({
        detectVersion: async () => "2.1.261",
        installation: () => ({ path: null, advisory: null }),
        probeAuthStatus: async (_bin, options = {}) => {
          const ok =
            zero.sources.nativeClaude ||
            loggedIn(
              options.configDir ?? (options.env?.["CLAUDE_CONFIG_DIR"] as string | undefined),
            );
          return {
            loggedIn: ok,
            authed: ok,
            authMethod: ok ? "claude.ai" : null,
            probeError: null,
          };
        },
        anthropicApiKey: () => (zero.sources.anthropicKey ? FAKE_KEY : null),
        claudeOAuthToken: () => (zero.sources.claudeSetupToken ? FAKE_KEY : null),
        smokeIsolatedApiKey: async () => {
          zero.paidProbeCalls.claudeApiKey += 1;
          return { ok: true, detail: "fixture API-key smoke" };
        },
        smokeIsolatedOAuthToken: async () => {
          zero.paidProbeCalls.claudeSetupToken += 1;
          return { ok: true, detail: "fixture setup-token smoke" };
        },
        probeReadonlyProfile: async () => ({
          supported: true,
          missingFlags: [],
          detail: "fixture",
        }),
        probeModels: async () => [HarnessModel.parse({ id: FIXTURE_MODEL })],
        probeEffortLevels: async () => ({ levels: CLAUDE_EFFORT_SNAPSHOT, live: false }),
      }),
    ),
  ],
  [
    "codex",
    recorded(
      createCodexAdapter({
        detectVersion: async () => CODEX_VENDOR_CLI_VERSION,
        brokenInstallAdvisory: () => null,
        probeLogin: async (_bin, options = {}) =>
          loggedIn(options.codexHome ?? (options.env?.["CODEX_HOME"] as string | undefined))
            ? { authed: true, method: "chatgpt", probeError: null }
            : { authed: false, method: "logged_out", probeError: null },
        hasApiKey: () => zero.sources.openaiKey,
        codexApiKey: () => (zero.sources.openaiKey ? FAKE_KEY : undefined),
        smokeIsolatedApiKey: async () => {
          zero.paidProbeCalls.codexApiKey += 1;
          return { ok: true, detail: "fixture API-key smoke" };
        },
        probeEfforts: async () => null,
      }),
    ),
  ],
]);
