import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { DaemonControlApiServer } from "@claudexor/control-api";
import type { HarnessAdapter, spawnProcess } from "@claudexor/core";
import { QuotaRegistry, createAccountEvidence } from "@claudexor/daemon";
import { Orchestrator } from "@claudexor/orchestrator";
import { reviewCandidate } from "@claudexor/review";
import {
  CONTROL_PROTOCOL_MAJOR,
  ConformanceReport,
  CredentialProfile,
  GlobalConfig,
  HarnessManifest,
  REOPENING_UNKNOWN_COOLDOWN_ID,
  RunFailure,
  type ControlProblem,
  type HarnessEvent,
  type RunEvent,
} from "@claudexor/schema";
import { parseCodexAccountResources } from "../../harness-codex/src/account-resources.js";
import { runCodexAppServer } from "../../harness-codex/src/app-server-run.js";
import { decorateCodexEvent } from "../../harness-codex/src/event-decoration.js";
import { withCodexVendorFailure } from "../../harness-codex/src/vendor-failure.js";
import { credentialPoolExhausted } from "../../orchestrator/src/credential-cooldown.js";
import { enumerateAccountCatalogs } from "./account-catalog.js";
import { projectRecoveryRunDetail } from "./mcp-run-projections.js";
import { poolExhausted } from "./model-service-refusals.js";
import { buildRunOrchestrator } from "./run-orchestrator.js";
import { memoryEventLedger } from "./test-support/memory-event-ledger.js";

/**
 * #558 / #414 end to end. The vendor process is the only fake: the real Codex
 * app-server run loop, the adapter's own event decoration and post-terminal
 * rollout reader, the real orchestrator and in-run continuation, and the
 * daemon's own account-observation composition feeding the daemon's quota
 * registry, whose admission projection the next run's preflight and pool read.
 *
 * The refusing turn reproduces #558's observed shape: the root thread settles
 * in systemError with no later terminal frame, and only the session rollout
 * keeps Codex's typed `usage_limit_exceeded` (here a workspace out of credits,
 * the recorded fixture's wording, which no rate-limit phrase matches).
 */
type Frame = Record<string, unknown>;
type Behavior =
  | "refuse"
  | "refuse_wire"
  | "refuse_words"
  | "refuse_read_first"
  | "refuse_after_progress"
  | "refuse_transport"
  | "refuse_credits"
  | "transport"
  | "review_clean"
  | "succeed"
  | "overloaded_wire"
  | "overloaded_rollout"
  | "overloaded_after_edit";
const CREDITS =
  "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.";
/** Limit words with no typed code, which alone produce today's plain dated cooldown. */
const LIMIT_WORDS = "You've hit your usage limit.";
/** Words the transport classifier reads as a broken stream (a typed `transient`). */
const TRANSPORT_WORDS = "stream disconnected before completion: error sending request";
const VENDOR = { code: "usage_limit_exceeded", message: CREDITS, source: "codex_rollout" };
/**
 * #644's neutral shape: the account read names the reached type and no numbers
 * at all (no window, no balance), and only the rollout keeps the typed refusal.
 */
const CREDITS_DEPLETED = {
  rateLimits: {
    limitId: "codex",
    primary: null,
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: null },
    rateLimitReachedType: "workspace_member_credits_depleted",
  },
};
/** Assistant text a failing candidate voiced before its harness failed. */
const PARTIAL_ANSWER = "PARTIAL-ANSWER-621: the first half of the change";
/** A synthetic provider overload, typed on the wire and in the rollout record alike. */
const OVERLOADED = "Selected model is at capacity. Please try a different model.";
const SYSTEM_ERROR = "Codex app-server thread settled in systemError";

const roots: string[] = [];
afterEach(
  () => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })),
  0,
); // synchronous removal: no deadline (#376, see vitest.setup.ts)

/** The scripted vendor app-server of one spawn; it also writes that turn's rollout record. */
function vendor(
  behavior: Behavior,
  home: string,
  threadSeq: () => string,
  cwd: string,
): typeof spawnProcess {
  return async function* (_bin, _args, options = {}) {
    const replies: string[] = [];
    let wake: (() => void) | undefined;
    let stop = false;
    let thread = "";
    const turn = `turn-${Math.random().toString(16).slice(2)}`;
    const push = (...frames: Frame[]): void => {
      for (const frame of frames) replies.push(JSON.stringify(frame));
      wake?.();
      wake = undefined;
    };
    const failed = behavior !== "succeed" && behavior !== "review_clean";
    const rollout = (
      error: Frame = { message: CREDITS, codex_error_info: "usage_limit_exceeded" },
    ): void => {
      const day = join(home, "sessions", "2026", "11", "01");
      mkdirSync(day, { recursive: true });
      const at = Math.floor(Date.now() / 1000);
      const record = (payload: Frame) =>
        JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload }) + "\n";
      appendFileSync(
        join(day, `rollout-2026-11-01T00-00-00-${thread}.jsonl`),
        record({ type: "task_started", turn_id: turn, started_at: at }) +
          record({
            type: "task_complete",
            turn_id: turn,
            last_agent_message: null,
            error,
            started_at: at,
            completed_at: at,
          }),
      );
    };
    const shutdown = (): void => {
      stop = true;
      wake?.();
    };
    options.onSpawn?.({
      write(data) {
        const request = JSON.parse(data) as { id?: number; method: string; params?: Frame };
        const reply = (result: Frame) => push({ id: request.id, result });
        if (request.method === "initialize") reply({});
        if (request.method === "thread/start") {
          thread = threadSeq();
          reply({ thread: { id: thread } });
        }
        if (request.method === "thread/resume") {
          thread = String(request.params?.["threadId"]);
          reply({ thread: { id: thread } });
        }
        if (request.method === "turn/start") {
          reply({ turn: { id: turn } });
          push({ method: "turn/started", params: { threadId: thread, turn: { id: turn } } });
          const item = (method: string, value: Frame) => ({
            method,
            params: { threadId: thread, turnId: turn, item: value },
          });
          if (behavior === "refuse_after_progress" || behavior === "refuse_read_first") {
            const command = { type: "commandExecution", id: "cmd-1", command: "ls" };
            push(
              item("item/started", { ...command, status: "inProgress" }),
              item("item/completed", { ...command, status: "completed", exitCode: 0 }),
            );
          }
          if (behavior === "succeed" || behavior === "review_clean") {
            const text = behavior === "succeed" ? "done" : "```json\n[]\n```";
            push(item("item/completed", { type: "agentMessage", id: "answer", text }), {
              method: "turn/completed",
              params: { threadId: thread, turn: { id: turn, status: "completed", items: [] } },
            });
            return;
          }
          if (behavior === "refuse_transport" || behavior === "transport") {
            // One failed turn whose words read as a broken stream; only the first
            // also carries Codex's typed usage refusal. No rollout record either way.
            const error = {
              message: TRANSPORT_WORDS,
              ...(behavior === "refuse_transport" ? { codexErrorInfo: "usageLimitExceeded" } : {}),
            };
            push({
              method: "turn/completed",
              params: { threadId: thread, turn: { id: turn, status: "failed", error, items: [] } },
            });
            return;
          }
          if (behavior.startsWith("overloaded")) {
            if (behavior === "overloaded_after_edit") {
              writeFileSync(join(cwd, "edited.txt"), "half done\n");
              const command = { type: "commandExecution", id: "cmd-edit", command: "edit" };
              push(
                item("item/started", { ...command, status: "inProgress" }),
                item("item/completed", { ...command, status: "completed", exitCode: 0 }),
                item("item/completed", {
                  type: "agentMessage",
                  id: "partial",
                  text: PARTIAL_ANSWER,
                }),
              );
            }
            if (behavior === "overloaded_rollout")
              rollout({ message: OVERLOADED, codex_error_info: "server_overloaded" });
            push({
              method: "thread/status/changed",
              params: { threadId: thread, status: { type: "systemError" } },
            });
            if (behavior === "overloaded_rollout") return;
            // The recorded order: systemError, the non-retrying error, the failed turn.
            const error = { message: OVERLOADED, codexErrorInfo: "serverOverloaded" };
            push(
              {
                method: "error",
                params: { error, willRetry: false, threadId: thread, turnId: turn },
              },
              {
                method: "turn/completed",
                params: {
                  threadId: thread,
                  turn: { id: turn, status: "failed", error, items: [] },
                },
              },
            );
            return;
          }
          if (behavior === "refuse_read_first") {
            const error = { message: CREDITS, codexErrorInfo: "usageLimitExceeded" };
            push(
              {
                method: "error",
                params: { error, willRetry: false, threadId: thread, turnId: turn },
              },
              {
                method: "thread/status/changed",
                params: { threadId: thread, status: { type: "systemError" } },
              },
            );
            return;
          }
          if (behavior === "refuse_credits")
            push({ method: "account/rateLimits/updated", params: CREDITS_DEPLETED });
          rollout();
          if (behavior === "refuse_words") {
            const error = { message: LIMIT_WORDS };
            push({
              method: "turn/completed",
              params: { threadId: thread, turn: { id: turn, status: "failed", error, items: [] } },
            });
            return;
          }
          push({
            method: "thread/status/changed",
            params: { threadId: thread, status: { type: "systemError" } },
          });
          if (behavior === "refuse_wire") {
            const error = { message: CREDITS, codexErrorInfo: "usageLimitExceeded" };
            push(
              {
                method: "error",
                params: { error, willRetry: false, threadId: thread, turnId: turn },
              },
              {
                method: "turn/completed",
                params: {
                  threadId: thread,
                  turn: { id: turn, status: "failed", error, items: [] },
                },
              },
            );
          }
        }
        if (request.method === "thread/read")
          reply({ thread: { status: { type: failed ? "systemError" : "idle" } } });
        if (request.method === "thread/goal/get") reply({ goal: null });
        if (request.method === "thread/backgroundTerminals/list") reply({ data: [] });
      },
      end: shutdown,
      closed: Promise.resolve(),
    });
    options.abortSignal?.addEventListener("abort", shutdown, { once: true });
    while (!stop || replies.length) {
      if (replies.length) yield { type: "stdout", line: replies.shift()! };
      else await new Promise<void>((resolve) => (wake = resolve));
    }
  };
}

function fixture(
  behaviors: Record<string, (spawn: number) => Behavior>,
  options: { fallbackModel?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "cx-codex-usage-"));
  roots.push(root);
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
  writeFileSync(join(root, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "base"],
    { cwd: root, stdio: "pipe" },
  );
  const config = process.env.CLAUDEXOR_CONFIG_DIR!;
  const homes: Record<string, string> = {};
  const profiles = Object.keys(behaviors).map((id) => {
    homes[id] = mkdtempSync(join(tmpdir(), `cx-codex-home-${id}-`));
    roots.push(homes[id]!);
    return {
      profile_id: id,
      harness_id: "codex",
      display_name: id,
      credential_kind: "config_dir_login",
      isolation_locator: homes[id],
    };
  });
  writeFileSync(
    join(config, "config.yaml"),
    JSON.stringify({
      runtime: { transient_retry: { max_retries: 2, initial_delay_ms: 1, max_delay_ms: 2 } },
      credential_profiles: profiles,
      harnesses: {
        codex: { default_model: "fixture-model", fallback_model: options.fallbackModel ?? null },
      },
    }),
  );
  const models = ["fixture-model", ...(options.fallbackModel ? [options.fallbackModel] : [])];
  const spawns: Array<{ profile: string; resume: string | null }> = [];
  let threads = 0;
  const adapter: HarnessAdapter = {
    id: "codex",
    async *run(spec) {
      const profile = spec.credential_profile!.profile_id;
      const spawn = spawns.filter((s) => s.profile === profile).length;
      spawns.push({ profile, resume: spec.resume_session_id ?? null });
      const env = { CODEX_HOME: homes[profile] };
      // The production composition of app-server runs (index.ts): decorate, then the rollout side channel.
      const decoration = {
        spec,
        env,
        credentialRoute: "vendor_native" as const,
        credentialSource: "native_session" as const,
        tempCodexHome: null,
        model: spec.model_hint ?? null,
      } as Parameters<typeof decorateCodexEvent>[1];
      const native = runCodexAppServer({
        bin: "codex",
        args: [],
        spec,
        env,
        spawn: vendor(
          behaviors[profile]!(spawn),
          homes[profile]!,
          () => `thread-${++threads}`,
          spec.cwd,
        ),
        pollIntervalMs: 0,
      });
      const decorated = (async function* (): AsyncGenerator<HarnessEvent> {
        for await (const event of native) yield decorateCodexEvent(event, decoration);
      })();
      yield* withCodexVendorFailure(decorated, spec, env, () => decoration.nativeThreadId);
    },
    discover: async () =>
      HarnessManifest.parse({
        id: "codex",
        display_name: "fixture codex",
        kind: "local_cli",
        provider_family: "local",
        capabilities: {
          implement: true,
          explain: true,
          read_files: true,
          known_models: models,
        },
        auth_modes: ["local_session"],
        access_profiles_supported: ["readonly", "workspace_write"],
      }),
    doctor: async () =>
      ConformanceReport.parse({
        harness_id: "codex",
        status: "ok",
        enabled_intents: ["implement", "explain"],
        auth_sources: [
          { source: "native_session", availability: "available", verification: "passed" },
        ],
      }),
    probeCredentialProfile: async (p) => ({
      profile_id: p.profile_id,
      harness_id: "codex",
      availability: "available",
      verification: "passed",
      verification_source: "local_store",
      last_verified_at: new Date().toISOString(),
    }),
    async models() {
      return models.map((id) => ({ id, label: null, context_window: null, routes: null }));
    },
  };
  // The daemon's own quota registry and account-observation composition.
  const quota = new QuotaRegistry(memoryEventLedger(new Date().toISOString()));
  const daemon = buildRunOrchestrator({
    accounts: createAccountEvidence(),
    p: {} as Parameters<typeof buildRunOrchestrator>[0]["p"],
    delegationBudgetAuthority: undefined,
    quotaStore: () => quota,
  }) as unknown as { deps: ConstructorParameters<typeof Orchestrator>[0] };
  const orchestrator = new Orchestrator({
    registry: new Map([["codex", adapter]]),
    reviewers: [],
    quotaSnapshots: daemon.deps.quotaSnapshots,
    quotaAbsences: daemon.deps.quotaAbsences,
    credentialObserverFactory: daemon.deps.credentialObserverFactory,
    credentialUnusable: daemon.deps.credentialUnusable,
    credentialEvidence: daemon.deps.credentialEvidence,
    preProgressRefusals: daemon.deps.preProgressRefusals,
  });
  const runOnce = async (pinned?: string, mode: "agent" | "ask" = "agent") => {
    const events: RunEvent[] = [];
    const before = spawns.length;
    const result = await orchestrator.run({
      repoRoot: root,
      ...(mode === "agent" ? { inPlace: true } : {}),
      mode,
      prompt: "Fix the fixture.",
      harnesses: ["codex"],
      models: { codex: "fixture-model" },
      authPreference: "subscription",
      review: false,
      web: "off",
      ...(pinned ? { credentialProfileId: pinned } : {}),
      onEvent: (event) => events.push(event),
    });
    const failure = RunFailure.nullable().parse(
      new ArtifactStore(root).readYaml(join(result.runDir, "final", "failure.yaml")),
    );
    const terminal = events.find((e) => ["run.failed", "run.completed"].includes(e.type));
    const limits = events.filter(
      (e) => e.type === "harness.event" && (e.payload["rate_limit"] ?? null) !== null,
    );
    return {
      result,
      failure,
      events,
      spawns: spawns.slice(before),
      limits,
      resumable: terminal?.payload["resumable"] as Record<string, unknown> | undefined,
    };
  };
  const cooldown = (profile: string) =>
    quota
      .read()
      .snapshots.filter((s) => s.subject.harness === "codex" && s.subject.subject_id === profile)
      .flatMap((s) => s.constraints)
      .filter((c) => c.id === REOPENING_UNKNOWN_COOLDOWN_ID);
  return {
    root,
    runOnce,
    cooldown,
    quota,
    adapter,
    spawns,
    profile: (id: string) => CredentialProfile.parse(profiles.find((p) => p.profile_id === id)),
    observer: daemon.deps.credentialObserverFactory,
  };
}

/**
 * The installed Ouroboros consumer's ONE reader of window-exhausted run failures,
 * mirrored byte-for-byte in behavior (`ouroboros/gateways/claudexor.py`
 * `_window_exhausted_refusal` and `WINDOW_EXHAUSTED_CODES`, cross-repo contract
 * B1, at fee36369): `subscription_window_exhausted` ALWAYS becomes the class that
 * "heals on a timer, not on payment", whatever `resetsAt` says; a pool does only
 * when dated; any other code, null included, stays a generic unavailable.
 */
function oldOuroborosHealsOnTimer(failure: { code: string | null; resetsAt: string | null }) {
  const dated = typeof failure.resetsAt === "string" && failure.resetsAt.trim() !== "";
  const code = failure.code ?? "";
  return (
    ["subscription_window_exhausted", "credential_pool_exhausted"].includes(code) &&
    (code === "subscription_window_exhausted" || dated)
  );
}

describe("Codex typed usage refusal, adapter → orchestrator → daemon (#558, #414)", () => {
  it("a pinned account ends typed at once with the vendor's cause, and the next pinned run is refused before spawn without inventing a reset", async () => {
    const f = fixture({ a: () => "refuse_after_progress", b: () => "succeed" });

    const first = await f.runOnce("a");
    // No same-account transport resume of the refused account (the #558 loop).
    expect(first.spawns).toEqual([{ profile: "a", resume: null }]);
    expect(first.result.lifecycle).toBe("failed");
    expect(first.failure).toMatchObject({
      // No timer-healing code: this refusal may be a workspace out of credits.
      code: null,
      category: "harness_unavailable",
      resetsAt: null,
      quotaRefusal: { basis: "provider_cooldown" },
      vendorFailure: VENDOR,
    });
    expect(first.failure?.nextActions).not.toContain(
      "Retry with a narrower prompt or different harness pool",
    );
    expect(first.failure?.poolAttempts).toEqual([
      expect.objectContaining({
        profileId: "a",
        phase: "after_progress",
        category: "rate_limited",
        vendorFailure: VENDOR,
      }),
    ]);
    expect(first.resumable).toMatchObject({
      cause: "pinned_limit",
      limitCode: "vendor_limit_rejected",
      resetsAt: null,
      limitEvidence: "unspecified",
    });
    // One typed limit, from the rollout record alone (the wire said only systemError).
    expect(first.limits).toHaveLength(1);

    // The daemon keeps the refusal's provenance with no measured usage, no vendor reset and a bounded recheck.
    const [kept] = f.cooldown("a");
    expect(kept).toMatchObject({ used_ratio: null, resets_at: null });
    const recheck = Date.parse(kept!.cooldown_until!) - Date.now();
    expect(recheck).toBeGreaterThan(0);
    expect(recheck).toBeLessThanOrEqual(5 * 60_000);

    const next = await f.runOnce("a");
    expect(next.spawns).toEqual([]);
    expect(next.failure).toMatchObject({
      code: null,
      category: "harness_unavailable",
      resetsAt: null,
      quotaRefusal: {
        basis: "provider_cooldown",
        constraintId: REOPENING_UNKNOWN_COOLDOWN_ID,
        usedRatio: null,
      },
    });
    expect(next.failure?.safeMessage).toContain("no reopening time named");

    // An unpinned run's pool ranks the refused account last and serves the work elsewhere.
    const pool = await f.runOnce();
    expect(pool.spawns.map((s) => s.profile)).toEqual(["b"]);
    expect(pool.result.lifecycle).toBe("succeeded");
  });

  it("the installed Ouroboros reader never takes the unknown reopening for a timer that heals, while a known window still is one", async () => {
    const f = fixture({ a: () => "refuse_after_progress", b: () => "succeed", c: () => "succeed" });
    const later = new Date(Date.now() + 6 * 60 * 60_000).toISOString();
    // b: a vendor window the vendor dated (the poller's own spent window).
    f.quota.upsert({
      subject: {
        harness: "codex",
        credential_route: "vendor_native",
        plan_label: null,
        subject_id: "b",
      },
      constraints: [
        {
          id: "primary",
          label: "5 hour",
          used_ratio: 1,
          window_seconds: 18_000,
          resets_at: later,
          cooldown_until: null,
        },
      ],
      source: "codex_app_server",
      observed_at: new Date().toISOString(),
      freshness: "fresh",
    });

    const immediate = await f.runOnce("a");
    expect(immediate.failure).not.toBeNull();
    expect(oldOuroborosHealsOnTimer(immediate.failure!)).toBe(false);
    const preflight = await f.runOnce("a");
    expect(preflight.spawns).toEqual([]);
    expect(oldOuroborosHealsOnTimer(preflight.failure!)).toBe(false);

    // Control: the dated vendor window keeps today's timer meaning and its reset.
    const known = await f.runOnce("b");
    expect(known.spawns).toEqual([]);
    expect(known.failure).toMatchObject({ code: "subscription_window_exhausted", resetsAt: later });
    expect(oldOuroborosHealsOnTimer(known.failure!)).toBe(true);

    // A pool with the unknown refusal beside a dated member never dates the pool.
    f.quota.upsert({
      subject: {
        harness: "codex",
        credential_route: "vendor_native",
        plan_label: null,
        subject_id: "c",
      },
      constraints: [
        {
          id: "primary",
          label: "5 hour",
          used_ratio: 1,
          window_seconds: 18_000,
          resets_at: later,
          cooldown_until: null,
        },
      ],
      source: "codex_app_server",
      observed_at: new Date().toISOString(),
      freshness: "fresh",
    });
    const pool = await f.runOnce();
    expect(pool.spawns).toEqual([]);
    expect(pool.failure).toMatchObject({ code: "credential_pool_exhausted", resetsAt: null });
    expect(oldOuroborosHealsOnTimer(pool.failure!)).toBe(false);
    expect(
      pool.events.find((e) => e.type === "route.account.pool_exhausted")?.payload["resets_at"],
    ).toBeNull();
  });

  it("a root refusal read before the systemError, with no rollout record, never replays the same account", async () => {
    const pinned = fixture({ a: () => "refuse_read_first" });
    const run = await pinned.runOnce("a");
    expect(run.spawns).toEqual([{ profile: "a", resume: null }]);
    expect(run.limits).toHaveLength(1);
    expect(run.failure).toMatchObject({
      code: null,
      category: "harness_unavailable",
      resetsAt: null,
      // No rollout record: the wire's own record is the evidence, and decides nothing.
      vendorFailure: { code: "usageLimitExceeded", message: CREDITS, source: "codex_app_server" },
    });
    expect(oldOuroborosHealsOnTimer(run.failure!)).toBe(false);
    expect(pinned.cooldown("a")).toHaveLength(1);
    // Auto follows limit_action: the work moves on, never back onto the refused account.
    const auto = fixture({ a: () => "refuse_read_first", b: () => "succeed" });
    const moved = await auto.runOnce();
    expect(moved.spawns.map((spawn) => spawn.profile)).toEqual(["a", "b"]);
    expect(moved.result.lifecycle).toBe("succeeded");
  });

  it("a plain limit's dated cooldown beside the refusal never makes the account a timer (words on the wire, the typed code in the rollout)", async () => {
    const f = fixture({ a: () => "refuse_words" });
    const first = await f.runOnce("a");
    expect(first.spawns).toEqual([{ profile: "a", resume: null }]);
    expect(first.failure).toMatchObject({ code: null, resetsAt: null });
    expect(oldOuroborosHealsOnTimer(first.failure!)).toBe(false);
    const next = await f.runOnce("a");
    expect(next.spawns).toEqual([]);
    expect(next.failure).toMatchObject({
      code: null,
      category: "harness_unavailable",
      resetsAt: null,
      quotaRefusal: { constraintId: REOPENING_UNKNOWN_COOLDOWN_ID, usedRatio: null },
    });
    expect(oldOuroborosHealsOnTimer(next.failure!)).toBe(false);
  });

  it("no quota read retires or moves the refusal: its own recheck alone lets the pinned account try again (#318)", async () => {
    const f = fixture({ a: (spawn) => (spawn === 0 ? "refuse_after_progress" : "succeed") });
    await f.runOnce("a");
    const [refusal] = f.cooldown("a");
    const recheck = Date.parse(refusal!.cooldown_until!);
    const read = (observed_at: string, usedRatio: number | null | "none") =>
      f.quota.upsert({
        subject: {
          harness: "codex",
          credential_route: "vendor_native",
          plan_label: null,
          subject_id: "a",
        },
        constraints:
          usedRatio === "none"
            ? []
            : [
                {
                  id: "primary",
                  label: "5 hour",
                  used_ratio: usedRatio,
                  window_seconds: 18_000,
                  resets_at: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
                  cooldown_until: null,
                },
              ],
        source: "codex_app_server",
        observed_at,
        freshness: "fresh",
      });
    // An older in-flight read, then newer recognized measured, unknown and empty reads.
    read(new Date(Date.now() - 60_000).toISOString(), 0.2);
    for (const usedRatio of [0.2, null, "none"] as const) {
      read(new Date().toISOString(), usedRatio);
      // Neither retired nor moved: the same refusal with the same recheck.
      expect(f.cooldown("a")).toEqual([refusal]);
    }
    const early = await f.runOnce("a");
    expect(early.spawns).toEqual([]);
    expect(early.failure).toMatchObject({
      code: null,
      resetsAt: null,
      quotaRefusal: { constraintId: REOPENING_UNKNOWN_COOLDOWN_ID },
    });
    // The real registry and preflight read a moved clock: just before the
    // recheck the account is still refused before spawn, at it the demanded
    // pinned run starts. Nothing probed the vendor in between.
    vi.useFakeTimers({ toFake: ["Date"], now: recheck - 30_000, shouldAdvanceTime: true });
    try {
      expect((await f.runOnce("a")).spawns).toEqual([]);
      vi.setSystemTime(recheck);
      expect(f.cooldown("a")).toEqual([refusal]);
      const retried = await f.runOnce("a");
      expect(retried.spawns).toEqual([{ profile: "a", resume: null }]);
      expect(retried.result.lifecycle).toBe("succeeded");
    } finally {
      vi.useRealTimers();
    }
    expect(f.spawns.map((spawn) => spawn.profile)).toEqual(["a", "a"]);
  });

  it("a raw model call's account catalog and pool mapping keep the refusal out of the timer class", async () => {
    const profile = CredentialProfile.parse({
      profile_id: "a",
      harness_id: "codex",
      display_name: "a",
      credential_kind: "config_dir_login",
      isolation_locator: join(tmpdir(), "cx-codex-usage-catalog-a"),
    });
    const until = new Date(Date.now() + 5 * 60_000).toISOString();
    const [row] = await enumerateAccountCatalogs({
      context: {
        config: GlobalConfig.parse({ credential_profiles: [profile] }),
        quota: {
          absences: [],
          snapshots: [
            {
              subject: {
                harness: "codex",
                credential_route: "vendor_native",
                plan_label: null,
                subject_id: "a",
              },
              constraints: [
                {
                  id: REOPENING_UNKNOWN_COOLDOWN_ID,
                  label: "Cooldown",
                  used_ratio: null,
                  window_seconds: null,
                  resets_at: null,
                  cooldown_until: until,
                },
              ],
              source: "codex_rollout",
              observed_at: new Date().toISOString(),
              freshness: "fresh",
            },
          ],
        },
      },
      adapter: {
        id: "codex",
        probeCredentialProfile: async () => ({
          profile_id: "a",
          harness_id: "codex",
          availability: "available",
          verification: "passed",
          verification_source: "local_store",
          last_verified_at: new Date().toISOString(),
        }),
      } as unknown as HarnessAdapter,
      profiles: [profile],
      read: async () => null,
      observationKey: "codex-usage-refusal",
    });
    expect(row).toMatchObject({ availability: "unavailable" });
    expect(row!.problem?.code).toBe("vendor_limit_rejected");
    const mapped = poolExhausted(
      "codex",
      credentialPoolExhausted({
        harnessId: "codex",
        profileId: null,
        reason: "profile_headroom_preflight",
        candidates: [
          {
            profile_id: "a",
            rejected: "cooldown",
            headroom: null,
            cooldown: { resets_at: null, reopening: "unknown" },
          },
        ],
        subjectLimit: null,
      }),
      new Map([["a", row!.problem as ControlProblem]]),
    ) as Error & { problem: ControlProblem };
    expect(mapped.problem).toMatchObject({
      code: "credential_pool_exhausted",
      context: { poolCause: "unavailable", resetsAt: null },
    });
    expect(
      oldOuroborosHealsOnTimer({
        code: mapped.problem.code,
        resetsAt: mapped.problem.context["resetsAt"] as string | null,
      }),
    ).toBe(false);
  });

  it("Auto moves before progress, with ONE typed limit when the wire and the rollout both carry it", async () => {
    const f = fixture({ a: () => "refuse_wire", b: () => "succeed" });
    const run = await f.runOnce();
    expect(run.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
    expect(run.result.lifecycle).toBe("succeeded");
    expect(run.limits).toHaveLength(1);
    expect(f.cooldown("a")).toEqual([
      expect.objectContaining({ used_ratio: null, resets_at: null }),
    ]);
    expect(f.cooldown("b")).toEqual([]);
  });

  it("the same refusal with no other account ends the unpinned run without a same-account replay", async () => {
    const f = fixture({ a: () => "refuse" });
    const run = await f.runOnce();
    expect(run.spawns.map((s) => s.profile)).toEqual(["a"]);
    expect(run.failure).toMatchObject({ code: "credential_pool_exhausted", resetsAt: null });
    expect(run.failure?.poolAttempts.map((row) => row.vendorFailure)).toEqual([VENDOR]);
  });

  it("a pinned Ask whose fallback model meets the refusal at setup still records it typed", async () => {
    const f = fixture({ a: () => "refuse" }, { fallbackModel: "fixture-fallback" });
    const run = await f.runOnce("a", "ask");
    // The first try met the refusal; the fallback model's pinned preflight refused before a spawn.
    expect(run.spawns).toEqual([{ profile: "a", resume: null }]);
    expect(run.events.some((e) => e.type === "route.fallback.started")).toBe(true);
    expect(run.failure).toMatchObject({
      code: null,
      category: "harness_unavailable",
      resetsAt: null,
      quotaRefusal: {
        basis: "provider_cooldown",
        constraintId: REOPENING_UNKNOWN_COOLDOWN_ID,
        usedRatio: null,
      },
    });
    expect(oldOuroborosHealsOnTimer(run.failure!)).toBe(false);
  });
});

describe("an ordinary Codex reviewer and the typed usage refusal (#558)", () => {
  /** One review by account `a` through the fixture's real Codex composition. */
  async function review(f: ReturnType<typeof fixture>) {
    const cwd = mkdtempSync(join(tmpdir(), "cx-codex-review-"));
    roots.push(cwd);
    const evidenceDir = join(cwd, ".claudexor-review-evidence");
    mkdirSync(evidenceDir, { recursive: true });
    const mandatory = ["USER_INTENT", "FORBIDDEN_FINDINGS", "PLAN_ACCEPTED", "DECIDED_TRADEOFFS"];
    for (const name of [...mandatory.map((n) => `${n}.md`), "TESTS.txt"])
      writeFileSync(join(evidenceDir, name), "(none)\n");
    const artifactsDir = join(cwd, "review-artifacts");
    const before = f.spawns.length;
    const result = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a a",
      cwd,
      evidenceDir,
      artifactsDir,
      reviewers: [
        {
          adapter: f.adapter,
          providerFamily: "openai",
          requestedModel: "fixture-model",
          authPreference: "subscription",
          credentialProfile: f.profile("a"),
        },
      ],
      transientRetryPolicy: { maxRetries: 2, initialDelayMs: 0, maxDelayMs: 0 },
      credentialObserverFactory: f.observer,
    });
    const metadata = JSON.parse(
      readFileSync(join(artifactsDir, "01-codex", "metadata.json"), "utf8"),
    ) as Record<string, unknown>;
    return { result, metadata, spawns: f.spawns.slice(before) };
  }

  it("never replays the refused account when the refusal's words also read as a broken stream", async () => {
    const f = fixture({ a: () => "refuse_transport" });
    const { metadata, spawns } = await review(f);
    expect(spawns).toEqual([{ profile: "a", resume: null }]);
    expect(metadata).toMatchObject({ status: "failed" });
    expect(metadata).not.toHaveProperty("transient_retry");
    // The refusal still reaches the account's quota evidence, as before.
    expect(f.cooldown("a")).toHaveLength(1);
  });

  it("control: a broken stream with no typed refusal is still retried on the same account", async () => {
    const f = fixture({ a: (spawn) => (spawn === 0 ? "transport" : "review_clean") });
    const { result, metadata, spawns } = await review(f);
    expect(spawns).toEqual([
      { profile: "a", resume: null },
      { profile: "a", resume: null },
    ]);
    expect(metadata).toMatchObject({ status: "completed", transient_retry: 1 });
    expect(result.findings).toEqual([]);
    expect(f.cooldown("a")).toEqual([]);
  });
});

/**
 * #633/#635/#621 at the readers, on synthetic vendor frames (the historical runs
 * are not replayed here). The failure record the run wrote, served by the
 * real control API and projected the way the MCP status and result tools
 * project it, then through a PROXY of the installed Ouroboros reader of a cause
 * (`run_failure_cause`: `failure.safeMessage`, whitespace-collapsed, cut at 512
 * characters; mirrored here, not that reader itself). The returned summary is
 * the daemon job's error.
 */
describe("a Codex failure's own cause reaches the run's readers (#633, #635, #621)", () => {
  type Run = Awaited<ReturnType<ReturnType<typeof fixture>["runOnce"]>>;
  const reportedCause = (safeMessage: string) =>
    safeMessage.split(/\s+/).filter(Boolean).join(" ").slice(0, 512);
  const wireRecord = { code: "serverOverloaded", message: OVERLOADED, source: "codex_app_server" };
  const wireStep =
    "Read the vendor's own failure record (codex_app_server: serverOverloaded) before retrying";

  /** GET /v2/runs/:id from the real control API over the run's own record. */
  async function readers(run: Run, root: string) {
    const record = {
      id: "job-reader",
      runId: run.result.runId,
      taskId: run.result.taskId,
      runDir: run.result.runDir,
      state: run.result.lifecycle,
      error: run.result.summary,
      params: { mode: run.result.mode, scope: { kind: "project", root } },
    };
    const server = new DaemonControlApiServer({
      token: "fixture-token",
      daemon: {
        enqueue: async () => {
          throw new Error("No generation permitted");
        },
        status: async () => record,
        list: async () => [record],
        cancel: async () => ({}),
      },
    } as unknown as ConstructorParameters<typeof DaemonControlApiServer>[0]);
    const { host, port } = await server.start();
    try {
      const response = await fetch(`http://${host}:${port}/v2/runs/${run.result.runId}`, {
        headers: {
          Authorization: "Bearer fixture-token",
          "X-Claudexor-Protocol-Major": String(CONTROL_PROTOCOL_MAJOR),
        },
      });
      expect(response.status).toBe(200);
      const detail = (await response.json()) as Record<string, unknown>;
      return {
        detail,
        status: projectRecoveryRunDetail("__run_status", run.result.runId, detail),
        result: projectRecoveryRunDetail("__run_result", run.result.runId, detail),
      };
    } finally {
      await server.stop();
    }
  }

  it("agent: an overload only the wire carried names itself in the record, the job error and every reader", async () => {
    const f = fixture({ a: () => "overloaded_wire" });
    const run = await f.runOnce("a");
    expect(run.spawns).toEqual([{ profile: "a", resume: null }]);
    expect(run.result.lifecycle).toBe("failed");
    expect(run.failure).toMatchObject({ code: null, vendorFailure: wireRecord });
    // Evidence only: the opaque overload code sets no limit and marks no account.
    expect(run.limits).toEqual([]);
    expect(f.cooldown("a")).toEqual([]);
    const lead = `a01/codex: ${SYSTEM_ERROR} (vendor codex_app_server: serverOverloaded, "${OVERLOADED}")`;
    expect(run.failure!.safeMessage.split("\n")[0]).toBe(lead);
    expect(run.result.summary.split("\n")[0]).toBe(lead);
    expect(run.failure!.nextActions[0]).toBe(wireStep);
    const read = await readers(run, f.root);
    for (const failure of [read.detail["failure"], read.status["failure"], read.result["failure"]])
      expect(failure).toEqual(run.failure);
    const summary = read.detail["summary"] as Record<string, unknown>;
    expect(String(summary["error"]).split("\n")[0]).toBe(lead);
    expect(read.status["status"]).toBe("failed");
    expect(reportedCause(run.failure!.safeMessage)).toContain(`serverOverloaded, "${OVERLOADED}"`);
  });

  it("ask: a systemError whose cause only the rollout kept names it for the reader (#633)", async () => {
    const f = fixture({ a: () => "overloaded_rollout" });
    const run = await f.runOnce("a", "ask");
    expect(run.spawns).toEqual([{ profile: "a", resume: null }]);
    expect(run.result.lifecycle).toBe("failed");
    expect(run.failure).toMatchObject({
      phase: "harness",
      code: null,
      vendorFailure: { code: "server_overloaded", message: OVERLOADED, source: "codex_rollout" },
    });
    const lead = `${SYSTEM_ERROR} (vendor codex_rollout: server_overloaded, "${OVERLOADED}")`;
    expect(run.failure!.safeMessage.split("\n")[0]).toBe(lead);
    expect(run.result.summary.split("\n")[0]).toBe(lead);
    expect(run.failure!.nextActions[0]).toBe(
      "Read the vendor's own failure record (codex_rollout: server_overloaded) before retrying",
    );
    const read = await readers(run, f.root);
    expect(read.status["failure"]).toEqual(run.failure);
    expect(reportedCause(run.failure!.safeMessage)).toContain("server_overloaded");
  });

  it("agent: a candidate that changed files and then failed leads with its own cause, keeps its patch and is never a success", async () => {
    const f = fixture({ a: () => "overloaded_after_edit" });
    const run = await f.runOnce("a");
    // After progress the same work continues on the same account, as before.
    expect(run.spawns.map((spawn) => spawn.profile)).toEqual(["a", "a", "a"]);
    expect(run.result.lifecycle).toBe("failed");
    expect(run.failure).toMatchObject({
      phase: "arbitration",
      category: "harness_error",
      code: null,
      harnessId: "codex",
      attemptId: "a01",
      vendorFailure: wireRecord,
    });
    const why = new ArtifactStore(run.result.runDir).readYaml<{ why_winner: string }>(
      join(run.result.runDir, "arbitration", "decision.yaml"),
    )!.why_winner;
    expect(why).toMatch(/^Candidate A: gates=/);
    const lead = `a01/codex: ${SYSTEM_ERROR} (vendor codex_app_server: serverOverloaded, "${OVERLOADED}")`;
    // Its voiced text is retained beside the cause, never as an accepted answer.
    const notice =
      "The assistant text this run retained (not an accepted final answer) is in final/retained-output.md.";
    expect(run.failure!.safeMessage.split("\n").slice(0, 4)).toEqual([lead, "", notice, why]);
    expect(run.failure!.logRefs).toContain("final/retained-output.md");
    expect(readFileSync(join(run.result.runDir, "final", "retained-output.md"), "utf8")).toContain(
      PARTIAL_ANSWER,
    );
    expect(run.result.summary.split("\n").slice(0, 2)).toEqual([lead, why]);
    expect(run.failure!.nextActions[0]).toBe(wireStep);
    expect(readFileSync(join(run.result.runDir, "final", "patch.diff"), "utf8")).toContain(
      "half done",
    );
    const read = await readers(run, f.root);
    expect(read.status["failure"]).toEqual(run.failure);
    expect(read.result["failure"]).toEqual(run.failure);
    expect(read.status["status"]).toBe("failed");
    expect(read.status["outcomeFacts"]).toMatchObject({
      lifecycle: "failed",
      reason: "harness_failed",
    });
    // The MCP status summary (summary.md) names the same cause.
    expect(String(read.status["summary"])).toContain(`\n- Failure: ${lead}\n`);
    // The MCP result presents the retained text as such, never as an answer;
    // its banner says failed and its failure record leads with the cause.
    expect(read.result["outcomeBanner"]).toBe("Failed (harness failed)");
    expect(String(read.result["summary"])).toContain("not a completion verdict");
    expect(String(read.result["summary"])).toContain(PARTIAL_ANSWER);
    expect(reportedCause(run.failure!.safeMessage)).toContain(`serverOverloaded, "${OVERLOADED}"`);
    expect(reportedCause(run.failure!.safeMessage)).toContain("final/retained-output.md");
  });

  it("#644 shape, unchanged since 5.1.0: credits out with no numbers stays a typed refusal with no reset, window or balance invented", async () => {
    const f = fixture({ a: () => "refuse_credits" });
    const run = await f.runOnce("a");
    // One fake turn, ended (systemError, then the process closes), before any other.
    expect(run.spawns).toEqual([{ profile: "a", resume: null }]);
    expect(run.result.lifecycle).toBe("failed");
    expect(run.failure).toMatchObject({
      code: null,
      category: "harness_unavailable",
      resetsAt: null,
      quotaRefusal: { basis: "provider_cooldown" },
      vendorFailure: VENDOR,
    });
    expect(oldOuroborosHealsOnTimer(run.failure!)).toBe(false);
    // The account update named no window: one typed limit (the rollout's), and
    // the account keeps only the refusal's unknown reopening, no measured usage.
    expect(run.limits).toHaveLength(1);
    const kept = f.quota
      .read()
      .snapshots.filter((s) => s.subject.harness === "codex" && s.subject.subject_id === "a")
      .flatMap((s) => s.constraints)
      .map((c) => [c.id, c.used_ratio, c.resets_at]);
    expect(kept).toEqual([[REOPENING_UNKNOWN_COOLDOWN_ID, null, null]]);
    // The same account read keeps an unknown balance unknown (never 0).
    const resources = parseCodexAccountResources(CREDITS_DEPLETED, "fixture", new Date());
    expect(resources.balances?.value).toEqual([
      expect.objectContaining({ amount: null, has_balance: false, unlimited: false }),
    ]);
    expect(resources.diagnostics?.value).toContainEqual(
      expect.objectContaining({ code: "workspace_member_credits_depleted" }),
    );
    expect((await f.runOnce("a")).spawns).toEqual([]);
  });

  it("#644 shape, new: the record, the job error and every reader name the vendor's own code and words", async () => {
    const f = fixture({ a: () => "refuse_credits" });
    const run = await f.runOnce("a");
    const cause = `(vendor codex_rollout: usage_limit_exceeded, "${CREDITS}")`;
    expect(run.failure!.safeMessage.split("\n")[0]).toContain(cause);
    expect(run.result.summary.split("\n")[0]).toContain(cause);
    const read = await readers(run, f.root);
    for (const failure of [read.detail["failure"], read.status["failure"], read.result["failure"]])
      expect(failure).toEqual(run.failure);
    const summary = read.detail["summary"] as Record<string, unknown>;
    expect(String(summary["error"]).split("\n")[0]).toContain(cause);
    expect(reportedCause(run.failure!.safeMessage)).toContain(cause);
  });
});
