import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import type { HarnessAdapter } from "@claudexor/core";
import { QuotaRegistry, createAccountEvidence } from "@claudexor/daemon";
import { Orchestrator } from "@claudexor/orchestrator";
import {
  ConformanceReport,
  CredentialProfile,
  GlobalConfig,
  HarnessManifest,
  REOPENING_UNKNOWN_COOLDOWN_ID,
  RunFailure,
  type HarnessEvent,
} from "@claudexor/schema";
import { enumerateAccountCatalogs } from "./account-catalog.js";
import { buildRunOrchestrator } from "./run-orchestrator.js";
import { memoryEventLedger } from "./test-support/memory-event-ledger.js";

/**
 * #318: demand that meets a Codex usage refusal with no reopening time, before
 * and at the refusal's own bounded recheck. The daemon's real quota registry
 * and run-orchestrator account evidence feed the real Orchestrator and the
 * model-service account catalog, all reading one moved clock. The only fake is
 * the vendor process. It counts real starts and holds every started try at an
 * offline barrier until the whole burst has started (or a short real-time
 * bound passes), so no try can record the refusal again before another demand
 * is admitted: the burst is the simultaneous case, reported as observed.
 */
const CREDITS =
  "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.";
const T0 = Date.parse("2026-11-09T12:00:00.000Z");
const RECHECK = 5 * 60_000;
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "cx-codex-recheck-"));
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

function fixture(ids: string[], vendor: { refuses: boolean }) {
  const homes = Object.fromEntries(
    ids.map((id) => {
      const home = mkdtempSync(join(tmpdir(), `cx-codex-recheck-home-${id}-`));
      roots.push(home);
      return [id, home];
    }),
  );
  const profiles = ids.map((id) => ({
    profile_id: id,
    harness_id: "codex",
    display_name: id,
    credential_kind: "config_dir_login",
    isolation_locator: homes[id],
  }));
  writeFileSync(
    join(process.env.CLAUDEXOR_CONFIG_DIR!, "config.yaml"),
    JSON.stringify({
      runtime: { transient_retry: { max_retries: 2, initial_delay_ms: 1, max_delay_ms: 2 } },
      credential_profiles: profiles,
      harnesses: { codex: { default_model: "fixture-model" } },
    }),
  );
  const starts: Array<{ profile: string; intent: string }> = [];
  let barrier = {
    expected: 0,
    arrived: 0,
    timedOut: false,
    open: () => {},
    opened: Promise.resolve(),
  };
  const atBarrier = async () => {
    barrier.arrived += 1;
    if (barrier.arrived >= barrier.expected) barrier.open();
    // A real-time bound, so a burst smaller than expected is observed, not hung.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<"bound">((resolve) => (timer = setTimeout(resolve, 3000, "bound")));
    const first = await Promise.race([barrier.opened.then(() => "opened" as const), bound]);
    clearTimeout(timer);
    if (first === "bound") barrier.timedOut = true;
  };
  const adapter: HarnessAdapter = {
    id: "codex",
    async *run(spec) {
      const profile = spec.credential_profile!.profile_id;
      starts.push({ profile, intent: spec.intent });
      await atBarrier();
      const emit = (event: Partial<HarnessEvent>): HarnessEvent =>
        ({
          session_id: spec.session_id,
          ts: new Date().toISOString(),
          credential_route: "vendor_native",
          credential_profile_id: profile,
          ...event,
        }) as HarnessEvent;
      yield emit({ type: "started" });
      if (vendor.refuses) {
        // The Codex adapter's typed refusal (#558): no reset, no window.
        yield emit({
          type: "status",
          text: "usage_limit_exceeded",
          rate_limit: {
            applies_to_request_kinds: ["text"],
            resets_at: null,
            retry_delay_ms: null,
            reopening: "unknown",
          },
        });
        yield emit({ type: "error", error: CREDITS });
        yield emit({ type: "completed", payload: { exit_code: 1, harness_reported_error: true } });
        return;
      }
      yield emit({ type: "message", text: "done", final: true });
      yield emit({ type: "completed" });
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
          known_models: ["fixture-model"],
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
    probeCredentialProfile: async (profile) => ({
      profile_id: profile.profile_id,
      harness_id: "codex",
      availability: "available",
      verification: "passed",
      verification_source: "local_store",
      last_verified_at: new Date().toISOString(),
    }),
    async models() {
      return [{ id: "fixture-model", label: null, context_window: null, routes: null }];
    },
  };
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
  type Demand = { mode: "agent" | "ask"; pinned?: string };
  const demand = async ({ mode, pinned }: Demand) => {
    const root = repo();
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
    });
    const failure = RunFailure.nullable().parse(
      new ArtifactStore(root).readYaml(join(result.runDir, "final", "failure.yaml")),
    );
    return { lifecycle: result.lifecycle, failure };
  };
  /** Every demand at once, at the current (moved) clock. */
  const burst = async (demands: Demand[], expectedStarts: number) => {
    let open = () => {};
    const opened = new Promise<void>((resolve) => (open = resolve));
    barrier = { expected: expectedStarts, arrived: 0, timedOut: false, open, opened };
    if (expectedStarts === 0) open();
    const before = starts.length;
    const outcomes = await Promise.all(demands.map(demand));
    // `held` is true when every start waited at the barrier for the whole burst.
    return { outcomes, starts: starts.slice(before), held: !barrier.timedOut };
  };
  /** The Codex adapter's typed refusal, through the daemon's own ingest. */
  const refuse = (profile: string) =>
    quota.ingest("codex", {
      type: "status",
      session_id: "earlier-run",
      ts: new Date().toISOString(),
      credential_route: "vendor_native",
      credential_profile_id: profile,
      rate_limit: {
        applies_to_request_kinds: ["text"],
        resets_at: null,
        retry_delay_ms: null,
        reopening: "unknown",
      },
    });
  const refusals = (profile: string) =>
    quota
      .read()
      .snapshots.filter((s) => s.subject.harness === "codex" && s.subject.subject_id === profile)
      .flatMap((s) => s.constraints)
      .filter((c) => c.id === REOPENING_UNKNOWN_COOLDOWN_ID);
  /** A Refresh's newer recognized read that measured nothing (#318: it retires nothing). */
  const refresh = (profile: string) =>
    quota.upsert({
      subject: {
        harness: "codex",
        credential_route: "vendor_native",
        plan_label: null,
        subject_id: profile,
      },
      constraints: [],
      source: "codex_app_server",
      observed_at: new Date().toISOString(),
      freshness: "fresh",
    });
  /** The model-service entrance's account catalog, from the same registry read. */
  const catalog = async (profile: string) => {
    const config = GlobalConfig.parse({ credential_profiles: profiles });
    const [row] = await enumerateAccountCatalogs({
      context: { config, quota: quota.read() },
      adapter,
      profiles: [CredentialProfile.parse(profiles.find((p) => p.profile_id === profile))],
      read: async () => null,
      observationKey: "codex-usage-refusal-recheck",
    });
    return row;
  };
  return { burst, refuse, refusals, refresh, catalog, quota };
}

describe("demand at a Codex usage refusal's own recheck (#318)", () => {
  it("pinned Agent and Ask demand starts nothing before the recheck and all of it at the recheck; a refusal met again records a new one", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: T0, shouldAdvanceTime: true });
    const f = fixture(["a"], { refuses: true });
    f.refuse("a");
    const [refusal] = f.refusals("a");
    expect(refusal).toMatchObject({ cooldown_until: new Date(T0 + RECHECK).toISOString() });
    const demands = [
      { mode: "agent" as const, pinned: "a" },
      { mode: "ask" as const, pinned: "a" },
      { mode: "agent" as const, pinned: "a" },
    ];

    vi.setSystemTime(T0 + RECHECK - 60_000);
    f.refresh("a");
    const early = await f.burst(demands, 0);
    expect(early.starts).toEqual([]);
    for (const { failure } of early.outcomes)
      expect(failure).toMatchObject({
        code: null,
        resetsAt: null,
        quotaRefusal: { constraintId: REOPENING_UNKNOWN_COOLDOWN_ID },
      });
    expect(await f.catalog("a")).toMatchObject({ availability: "unavailable" });
    expect(f.refusals("a")).toEqual([refusal]);

    vi.setSystemTime(T0 + RECHECK);
    expect(await f.catalog("a")).not.toMatchObject({ availability: "unavailable" });
    const due = await f.burst(demands, demands.length);
    // Observed: nothing serializes demand at the recheck, each demand starts.
    expect(due.starts.map((start) => start.profile)).toEqual(["a", "a", "a"]);
    expect(due.held).toBe(true);
    expect(due.outcomes.map((outcome) => outcome.lifecycle)).toEqual([
      "failed",
      "failed",
      "failed",
    ]);
    const [renewed] = f.refusals("a");
    expect(Date.parse(renewed!.cooldown_until!)).toBeGreaterThanOrEqual(T0 + 2 * RECHECK);
    const after = await f.burst([{ mode: "agent", pinned: "a" }], 0);
    expect(after.starts).toEqual([]);
  }, 120_000);

  it("unpinned demand on a pool of that one account is refused typed with no other route, and starts all at once at the recheck", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: T0, shouldAdvanceTime: true });
    const vendor = { refuses: false };
    const f = fixture(["a"], vendor);
    f.refuse("a");
    const demands = [{ mode: "agent" as const }, { mode: "ask" as const }];

    vi.setSystemTime(T0 + RECHECK - 60_000);
    f.refresh("a");
    const early = await f.burst(demands, 0);
    expect(early.starts).toEqual([]);
    for (const { failure } of early.outcomes)
      expect(failure).toMatchObject({ code: "credential_pool_exhausted", resetsAt: null });

    vi.setSystemTime(T0 + RECHECK);
    const due = await f.burst(demands, demands.length);
    expect(due.starts.map((start) => start.profile)).toEqual(["a", "a"]);
    expect(due.held).toBe(true);
    expect(due.outcomes.map((outcome) => outcome.lifecycle)).toEqual(["succeeded", "succeeded"]);
  }, 120_000);
});
