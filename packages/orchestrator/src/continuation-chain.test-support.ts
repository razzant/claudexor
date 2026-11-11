/**
 * A `continueFrom` chain of real Orchestrator runs on one scripted fake
 * harness (no vendor calls): each run is labelled (A, B, C...) so a script
 * can answer per run and per spawn, and the successor receives exactly the
 * continuation facts the daemon runner resolves.
 */
import { afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessAdapter, HarnessContinuityCapability } from "@claudexor/core";
import {
  ConformanceReport,
  HarnessManifest,
  type HarnessEvent,
  type HarnessRunSpec,
  type RunEvent,
} from "@claudexor/schema";
import { Orchestrator, type OrchestratorResult, type RunInput } from "./orchestrator.js";
import type { RunContinuation } from "./continuation-custody.js";

const roots: string[] = [];
afterEach(
  () => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })),
  0,
); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

export const WORK_ORDER = "WORK-ORDER-7f3a: build the dashboard";

export interface ChainSpawn {
  label: string;
  nth: number;
  profile: string;
  resume: string | null;
  prompt: string;
  model: string | null;
  cwd: string;
}

export type Emit = (ev: Partial<HarnessEvent>) => HarnessEvent;
export type ChainScript = (
  ctx: ChainSpawn & { spec: HarnessRunSpec; emit: Emit; seed: (sid: string) => void },
) => Generator<HarnessEvent>;

export interface ChainFixture {
  root: string;
  stores: Record<string, string>;
  spawns: ChainSpawn[];
  adapter: HarnessAdapter;
  label: { current: string };
}

/** A movable fake store: sessions live under `<locator>/sessions/<sid>.jsonl`. */
export function movableStore(
  retire: (file: string) => void = (file) => rmSync(file),
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
    async move(located, _fromEnv, toEnv) {
      const sid = located.nativeSessionId ?? "?";
      const target = fileFor(toEnv, sid);
      execFileSync("mkdir", ["-p", join(target, "..")]);
      writeFileSync(target, readFileSync(located.file));
      return { ok: true, resumeRef: { nativeSessionId: sid }, retire: () => retire(located.file) };
    },
  };
}

export function chainFixture(
  opts: {
    profiles: string[];
    maxRetries?: number;
    fallbackModel?: string;
    continuity?: HarnessContinuityCapability;
  },
  script: ChainScript,
): ChainFixture {
  const root = mkdtempSync(join(tmpdir(), "cx-chain-"));
  roots.push(root);
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
  writeFileSync(join(root, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "base"],
    { cwd: root, stdio: "pipe" },
  );
  const stores = Object.fromEntries(opts.profiles.map((id) => [id, join(root, `store-${id}`)]));
  writeFileSync(
    join(process.env.CLAUDEXOR_CONFIG_DIR!, "config.yaml"),
    JSON.stringify({
      runtime: {
        transient_retry: {
          max_retries: opts.maxRetries ?? 0,
          initial_delay_ms: 1,
          max_delay_ms: 2,
        },
      },
      credential_profiles: opts.profiles.map((id) => ({
        profile_id: id,
        harness_id: "fake",
        display_name: id,
        credential_kind: "config_dir_login",
        isolation_locator: stores[id],
      })),
      harnesses: {
        fake: {
          ...(opts.fallbackModel ? { fallback_model: opts.fallbackModel } : {}),
          profile_policy: { limit_action: "rotate" },
        },
      },
    }),
  );
  const spawns: ChainSpawn[] = [];
  const label = { current: "A" };
  const adapter: HarnessAdapter = {
    id: "fake",
    continuity: opts.continuity ?? movableStore(),
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
          known_models: ["m1", "m2"],
        },
        auth_modes: ["local_session"],
        access_profiles_supported: ["workspace_write", "readonly"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: "fake",
        status: "ok",
        enabled_intents: ["implement", "repair", "explain", "audit"],
        auth_sources: [
          { source: "native_session", availability: "available", verification: "passed" },
        ],
      });
    },
    async probeCredentialProfile(profile) {
      return {
        profile_id: profile.profile_id,
        harness_id: "fake",
        availability: "available",
        verification: "passed",
        verification_source: "local_store",
        last_verified_at: new Date().toISOString(),
      };
    },
    async models() {
      return ["m1", "m2"].map((id) => ({ id, label: null, context_window: null, routes: null }));
    },
    async *run(spec) {
      const profile = spec.credential_profile!.profile_id;
      const ctx: ChainSpawn = {
        label: label.current,
        nth: spawns.filter((s) => s.label === label.current).length + 1,
        profile,
        resume: spec.resume_session_id ?? null,
        prompt: spec.prompt,
        model: spec.model_hint ?? null,
        cwd: spec.cwd,
      };
      spawns.push(ctx);
      const emit: Emit = (ev) =>
        ({
          session_id: spec.session_id,
          ts: new Date().toISOString(),
          credential_route: "vendor_native",
          credential_profile_id: profile,
          ...ev,
        }) as HarnessEvent;
      const seed = (sid: string) => {
        execFileSync("mkdir", ["-p", join(stores[profile]!, "sessions")]);
        writeFileSync(join(stores[profile]!, "sessions", `${sid}.jsonl`), `{"sid":"${sid}"}\n`);
      };
      yield* script({ ...ctx, spec, emit, seed });
    },
  };
  return { root, stores, spawns, adapter, label };
}

export interface ChainRun {
  result: OrchestratorResult;
  events: RunEvent[];
  receipts: Record<string, unknown>[];
  resumable: Record<string, unknown> | undefined;
}

export async function runLabelled(
  f: ChainFixture,
  label: string,
  input: Partial<RunInput>,
): Promise<ChainRun> {
  f.label.current = label;
  const events: RunEvent[] = [];
  const result = await new Orchestrator({
    registry: new Map([["fake", f.adapter]]),
    reviewers: [],
  }).run({
    repoRoot: f.root,
    mode: "agent",
    prompt: WORK_ORDER,
    harnesses: ["fake"],
    review: false,
    models: { fake: "m1" },
    effort: "high",
    authPreference: "subscription",
    web: "off",
    ...input,
    onEvent: (event) => events.push(event),
  });
  const terminal = events.find((e) =>
    ["run.failed", "run.completed", "run.blocked"].includes(e.type),
  );
  return {
    result,
    events,
    receipts: events
      .filter((e) => e.type === "run.continuity")
      .map((e) => e.payload["receipt"] as Record<string, unknown>),
    resumable: terminal?.payload["resumable"] as Record<string, unknown> | undefined,
  };
}

/** The facts the daemon resolves for a successor of `pred` (its own ancestors first). */
export function continuing(
  pred: ChainRun,
  workOrder: string,
  ancestors: ChainRun[] = [],
  over: Partial<NonNullable<RunContinuation["from"]>> = {},
): RunContinuation {
  return {
    retain: true,
    from: {
      runId: pred.result.runId,
      runDir: pred.result.runDir,
      state: pred.result.lifecycle,
      workOrder,
      preference: "auto",
      ancestors: ancestors.map((run) => ({
        runId: run.result.runId,
        runDir: run.result.runDir,
        state: run.result.lifecycle,
      })),
      ...over,
    },
  };
}

export const limitStop = (emit: Emit) => [
  emit({
    type: "status",
    status: { kind: "api_retry", error_category: "rate_limit" },
    rate_limit: {
      resets_at: "2026-10-06T21:00:00.000Z",
      retry_delay_ms: null,
      constraint_id: "five_hour",
    },
  }),
  emit({ type: "error", error: "usage limit reached" }),
  emit({ type: "completed" }),
];

export const crash = (emit: Emit) => [
  emit({ type: "error", error: "connection reset" }),
  emit({ type: "completed", payload: { exit_code: 1, harness_reported_error: true } }),
];
