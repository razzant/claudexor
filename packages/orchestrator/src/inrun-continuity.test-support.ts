/**
 * In-run continuation contract on a scripted fake harness (no vendor calls):
 * the owner's "auto-rotation inside the work". Each scenario scripts what the
 * fake does per (profile, try) and asserts the engine's carrier, the spec the
 * next process receives, the receipts and the terminal `resumable` block.
 */
import { afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessAdapter, HarnessContinuityCapability } from "@claudexor/core";
import {
  ConformanceReport,
  CredentialProfile,
  HarnessManifest,
  type HarnessEvent,
  type HarnessModel,
  type HarnessRunSpec,
  type RunEvent,
  type QuotaSnapshot,
} from "@claudexor/schema";
import { Orchestrator, type RunInput } from "./orchestrator.js";
import type { ReviewerSpec } from "@claudexor/review";
import { readSessionCapsule } from "./session-capsule.js";

const roots: string[] = [];
afterEach(
  () => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })),
  0,
); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

interface Spawn {
  profile: string;
  resume: string | null;
  prompt: string;
  model: string | null;
  tryOfProfile: number;
}

type Script = (
  ctx: Spawn & { spec: HarnessRunSpec; emit: (ev: Partial<HarnessEvent>) => HarnessEvent },
) => Generator<HarnessEvent>;

interface Scenario {
  mode: "agent" | "ask" | "plan";
  profiles: string[];
  script: Script;
  continuity?: HarnessContinuityCapability | null;
  pinned?: string;
  limitAction?: "rotate" | "fail" | "ask";
  /** The saved quota reserve (`profile_policy.headroom_threshold`; default 1). */
  headroomThreshold?: number;
  maxRetries?: number;
  /** The run's requested model; null = none (the harness default). */
  model?: string | null;
  input?: Partial<RunInput>;
  snapshots?: QuotaSnapshot[];
  reviewers?: ReviewerSpec[];
  capabilities?: Partial<HarnessManifest["capabilities"]>;
  registryProfiles?: (profiles: CredentialProfile[]) => CredentialProfile[];
  /** The live inventory each account answers (default: `m1` for every account). */
  models?: (profileId: string | null) => Promise<HarnessModel[]>;
  /** Extra Orchestrator dependencies (e.g. a Delegate drain authority). */
  deps?: Partial<ConstructorParameters<typeof Orchestrator>[0]>;
  /** Runs inside each asynchronous credential readiness probe (e.g. time
   * passing or a new quota observation landing while readiness is checked). */
  onProbe?: (profileId: string) => void | Promise<void>;
}

export const RESET = "2026-10-06T21:00:00.000Z";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cx-inrun-"));
  roots.push(root);
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
  writeFileSync(join(root, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "base"],
    { cwd: root, stdio: "pipe" },
  );
  return root;
}

/** A movable fake store: sessions live under `<locator>/sessions/<sid>.jsonl`. */
export function fileStoreContinuity(
  over: Partial<HarnessContinuityCapability> = {},
): HarnessContinuityCapability {
  const fileFor = (env: Record<string, string | null | undefined>, sid: string) =>
    join(String(env["CLAUDEXOR_PROFILE_LOCATOR"] ?? "/nowhere"), "sessions", `${sid}.jsonl`);
  return {
    async locate(ref, env) {
      const file = fileFor(env, ref.nativeSessionId);
      return existsSync(file)
        ? { found: true, file, mtimeMs: Date.now(), sidecars: [] }
        : { found: false };
    },
    async move(located, _fromEnv, toEnv, _cwd) {
      const sid = located.nativeSessionId ?? "?";
      const target = fileFor(toEnv, sid);
      execFileSync("mkdir", ["-p", join(target, "..")]);
      writeFileSync(target, readFileSync(located.file));
      return { ok: true, resumeRef: { nativeSessionId: sid }, retire: () => rmSync(located.file) };
    },
    ...over,
  };
}

export async function run(scenario: Scenario) {
  const root = gitRepo();
  const configDir = process.env.CLAUDEXOR_CONFIG_DIR!;
  const stores = Object.fromEntries(scenario.profiles.map((id) => [id, join(root, `store-${id}`)]));
  const profiles = scenario.profiles.map((id) =>
    CredentialProfile.parse({
      profile_id: id,
      harness_id: "fake",
      display_name: id,
      credential_kind: "config_dir_login",
      isolation_locator: stores[id],
    }),
  );
  writeFileSync(
    join(configDir, "config.yaml"),
    JSON.stringify({
      runtime: {
        transient_retry: {
          max_retries: scenario.maxRetries ?? 2,
          initial_delay_ms: 1,
          max_delay_ms: 2,
        },
      },
      credential_profiles: scenario.registryProfiles?.(profiles) ?? profiles,
      harnesses: {
        fake: {
          profile_policy: {
            limit_action: scenario.limitAction ?? "rotate",
            ...(scenario.headroomThreshold
              ? { headroom_threshold: scenario.headroomThreshold }
              : {}),
          },
        },
      },
    }),
  );
  const spawns: Spawn[] = [];
  const perProfile = new Map<string, number>();
  const adapter: HarnessAdapter = {
    id: "fake",
    ...(scenario.continuity === null
      ? {}
      : { continuity: scenario.continuity ?? fileStoreContinuity() }),
    async discover() {
      return HarnessManifest.parse({
        id: "fake",
        display_name: "fake",
        kind: "local_cli",
        provider_family: "local",
        capabilities: {
          implement: true,
          read_files: true,
          effort_levels: ["high"],
          repair: true,
          explain: true,
          audit: true,
          known_models: ["m1"],
          ...scenario.capabilities,
        },
        auth_modes: ["local_session"],
        access_profiles_supported: ["workspace_write", "readonly"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: "fake",
        status: "ok",
        enabled_intents: ["implement", "repair", "explain", "audit", "plan"],
        auth_sources: [
          { source: "native_session", availability: "available", verification: "passed" },
        ],
      });
    },
    async probeCredentialProfile(profile) {
      await scenario.onProbe?.(profile.profile_id);
      return {
        profile_id: profile.profile_id,
        harness_id: "fake",
        availability: "available",
        verification: "passed",
        verification_source: "local_store",
        last_verified_at: new Date().toISOString(),
      };
    },
    async models(query) {
      if (scenario.models) return scenario.models(query?.credentialProfile?.profile_id ?? null);
      return [{ id: "m1", label: null, context_window: null, routes: null }];
    },
    async *run(spec) {
      const profile = spec.credential_profile!.profile_id;
      const tryOfProfile = (perProfile.get(profile) ?? 0) + 1;
      perProfile.set(profile, tryOfProfile);
      const ctx: Spawn = {
        profile,
        resume: spec.resume_session_id ?? null,
        prompt: spec.prompt,
        model: spec.model_hint ?? null,
        tryOfProfile,
      };
      spawns.push(ctx);
      const emit = (ev: Partial<HarnessEvent>): HarnessEvent =>
        ({
          session_id: spec.session_id,
          ts: new Date().toISOString(),
          credential_route: "vendor_native",
          credential_profile_id: profile,
          ...ev,
        }) as HarnessEvent;
      yield* scenario.script({ ...ctx, spec, emit });
    },
  };
  const events: RunEvent[] = [];
  const result = await new Orchestrator({
    registry: new Map([["fake", adapter]]),
    reviewers: scenario.reviewers ?? [],
    quotaSnapshots: () => scenario.snapshots ?? [],
    ...scenario.deps,
  }).run({
    repoRoot: root,
    ...(scenario.mode === "agent" ? { inPlace: true } : {}),
    mode: scenario.mode,
    prompt: "WORK-ORDER-7f3a: build the dashboard",
    harnesses: ["fake"],
    review: false,
    ...(scenario.model === null ? {} : { models: { fake: scenario.model ?? "m1" } }),
    effort: "high",
    authPreference: "subscription",
    web: "off",
    ...(scenario.pinned ? { credentialProfileId: scenario.pinned } : {}),
    ...scenario.input,
    onEvent: (event) => events.push(event),
  });
  const attemptsDir = join(result.runDir, "attempts");
  const attemptId = existsSync(attemptsDir) ? readdirSync(attemptsDir).sort()[0] : undefined;
  const receipts = events
    .filter((e) => e.type === "run.continuity")
    .map((e) => e.payload["receipt"] as Record<string, unknown>);
  const terminal = events.find((e) =>
    ["run.failed", "run.completed", "run.blocked"].includes(e.type),
  );
  return {
    root,
    stores,
    result,
    spawns,
    events,
    receipts,
    rotated: events.filter((e) => e.type === "route.profile.rotated").map((e) => e.payload),
    resumable: terminal?.payload["resumable"] as Record<string, unknown> | undefined,
    capsule: attemptId ? readSessionCapsule(join(attemptsDir, attemptId)) : null,
    attemptDir: attemptId ? join(attemptsDir, attemptId) : null,
  };
}

/** Script helpers. */
export function seedSession(root: string, profile: string, sid: string): void {
  const dir = join(root, `store-${profile}`, "sessions");
  execFileSync("mkdir", ["-p", dir]);
  writeFileSync(join(dir, `${sid}.jsonl`), `{"sid":"${sid}"}\n`);
}
export const limit = (
  emit: (ev: Partial<HarnessEvent>) => HarnessEvent,
  resetsAt: string | null = RESET,
) => [
  emit({
    type: "status",
    status: { kind: "api_retry", error_category: "rate_limit" },
    rate_limit: { resets_at: resetsAt, retry_delay_ms: null, constraint_id: "five_hour" },
  }),
  emit({ type: "error", error: "usage limit reached" }),
  emit({ type: "completed" }),
];
export const crash = (emit: (ev: Partial<HarnessEvent>) => HarnessEvent) => [
  emit({ type: "error", error: "connection reset" }),
  emit({ type: "completed", payload: { exit_code: 1, harness_reported_error: true } }),
];
