/**
 * Harness side of the profile-admission integration fixture
 * (`../profile-admission.integration.test.ts`): the REAL Codex and Claude
 * adapters over vendor runtime stubs (their own manifests, doctor and profile
 * probes; no binary, no credential) plus the real fake harness. Discovery and
 * readiness reads are counted. Each adapter's `run` is replaced by a recorder
 * that captures the spec and the env the Codex adapter resolves for the
 * selected profile, then answers with the stream its route declares: no
 * provider can start.
 */
import { resolve } from "node:path";
import type { HarnessAdapter } from "@claudexor/core";
import { CLAUDE_EFFORT_SNAPSHOT, createClaudeAdapter } from "@claudexor/harness-claude";
import {
  CODEX_VENDOR_CLI_VERSION,
  canonicalCodexProfileHome,
  codexNativeEnv,
  createCodexAdapter,
} from "@claudexor/harness-codex";
import { createFakeHarness } from "@claudexor/harness-fake";
import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";

/** Reads, spawns and login state shared by the daemon fixture and the scenarios. */
export const recorder = {
  calls: {} as Record<string, number>,
  /** `calls` when the current request began. */
  mark: {} as Record<string, number>,
  spawns: [] as Array<Record<string, unknown>>,
  /** Ingress reads, snapshotted when the Control API enqueues a job. */
  enqueues: [] as Array<Record<string, number>>,
  /** Canonical credential stores that answer a login probe. */
  loggedIn: new Set<string>(),
};

export function resetRecorder(): void {
  recorder.calls = {};
  recorder.mark = {};
  recorder.spawns = [];
  recorder.enqueues = [];
  recorder.loggedIn = new Set();
}

export const count = (name: string) => {
  recorder.calls[name] = (recorder.calls[name] ?? 0) + 1;
};
/** Adapter and thread reads since the current request began (ingress only
 * when taken at enqueue or right after a refusal). */
export const ingress = () =>
  Object.fromEntries(
    Object.entries(recorder.calls)
      .map(([name, value]) => [name, value - (recorder.mark[name] ?? 0)] as const)
      .filter(([, value]) => value > 0),
  );
export const sum = (calls: Record<string, number>, pattern: RegExp) =>
  Object.entries(calls)
    .filter(([name]) => pattern.test(name))
    .reduce((total, [, value]) => total + value, 0);

/** Count the real adapter's discovery/readiness reads; record any spawn. */
function instrumented(real: HarnessAdapter): HarnessAdapter {
  const id = real.id;
  return {
    id,
    capabilityProfile: real.capabilityProfile,
    ...(real.effortParameter ? { effortParameter: real.effortParameter } : {}),
    discover: async () => {
      count(`${id}.discover`);
      return real.discover();
    },
    doctor: async (spec) => {
      count(`${id}.doctor`);
      return real.doctor(spec);
    },
    probeCredentialProfile: async (profile, signal, options) => {
      count(`${id}.probe`);
      return real.probeCredentialProfile!(profile, signal, options);
    },
    async *run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      const profile = spec.credential_profile ?? null;
      // The same resolution the Codex adapter's profile route performs.
      const env =
        id === "codex"
          ? codexNativeEnv(
              spec.env,
              profile?.credential_kind === "config_dir_login"
                ? canonicalCodexProfileHome(profile.isolation_locator ?? "")
                : undefined,
            )
          : { ...spec.env };
      recorder.spawns.push({
        harness: id,
        profile: profile?.profile_id ?? null,
        home: env["HOME"] ?? null,
        codexHome: env["CODEX_HOME"] ?? null,
        model: spec.model_hint ?? null,
        browser: spec.browser != null,
        attachments: (spec.attachments ?? []).map((item) => item.mime),
      });
      const ts = new Date().toISOString();
      const session = `native-${id}-${profile?.profile_id ?? "default"}-${recorder.spawns.length}`;
      // The identity stamp the real adapters put on every event (subscription route).
      const stamp = {
        credential_route: "vendor_native" as const,
        credential_source: "native_session" as const,
        ...(profile ? { credential_profile_id: profile.profile_id } : {}),
      };
      yield {
        type: "started",
        session_id: spec.session_id,
        ts,
        payload: { native_session_id: session },
        ...stamp,
      } as HarnessEvent;
      // A constrained route answers with the structured envelope its spec asks for.
      const text = spec.output_schema
        ? JSON.stringify({
            work_report: { state: "completed", required_inputs: [] },
            output: "done",
          })
        : "done";
      yield {
        type: "message",
        session_id: spec.session_id,
        ts,
        text,
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

const loggedIn = (home: string | undefined | null) =>
  Boolean(home) && recorder.loggedIn.has(resolve(home!));
export const fixtureRegistry = new Map<string, HarnessAdapter>([
  [
    "codex",
    instrumented(
      createCodexAdapter({
        detectVersion: async () => CODEX_VENDOR_CLI_VERSION,
        brokenInstallAdvisory: () => null,
        probeLogin: async (_bin, options = {}) =>
          loggedIn(options.codexHome ?? (options.env?.["CODEX_HOME"] as string | undefined))
            ? { authed: true, method: "chatgpt", probeError: null }
            : { authed: false, method: "logged_out", probeError: null },
        hasApiKey: () => false,
        codexApiKey: () => undefined,
        probeEfforts: async () => null,
      }),
    ),
  ],
  [
    "claude",
    instrumented(
      createClaudeAdapter({
        detectVersion: async () => "2.1.261",
        installation: () => ({ path: null, advisory: null }),
        probeAuthStatus: async (_bin, options = {}) => {
          const ok = loggedIn(
            options.configDir ?? (options.env?.["CLAUDE_CONFIG_DIR"] as string | undefined),
          );
          return {
            loggedIn: ok,
            authed: ok,
            authMethod: ok ? "claude.ai" : null,
            probeError: null,
          };
        },
        anthropicApiKey: () => null,
        claudeOAuthToken: () => null,
        probeReadonlyProfile: async () => ({
          supported: true,
          missingFlags: [],
          detail: "fixture",
        }),
        probeEffortLevels: async () => ({ levels: CLAUDE_EFFORT_SNAPSHOT, live: false }),
      }),
    ),
  ],
  ["fake-success", createFakeHarness("fake-success")],
]);
