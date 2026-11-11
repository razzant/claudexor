/**
 * #457 and #318 through the registry's admission read and the real account
 * owners, under a controlled clock:
 * - an elapsed short window is never a breach, and does not disable a still
 *   current weekly reserve within the observation's own five-minute TTL;
 * - a strict pin refused by the owner's saved reserve says so machine-readably,
 *   distinct from proven provider exhaustion (the failure record is covered in
 *   orchestrator quotaRefusal.test.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialProfile, QuotaSnapshot } from "@claudexor/schema";
import { QuotaRegistry } from "../../daemon/src/quota-registry.js";
import { resolveAccountForRun } from "../../orchestrator/src/account-resolution.js";
import type { AccountResolutionContext } from "../../orchestrator/src/account-resolution.js";
import { selectFromAccountPool } from "../../orchestrator/src/account-pool.js";
import {
  nextEligibleProfile,
  profileHeadroomBreach,
} from "../../orchestrator/src/credential-profile-rotation.js";
import { memoryEventLedger } from "./test-support/memory-event-ledger.js";
import { createAccountEvidence } from "@claudexor/daemon";
import { buildRunOrchestrator } from "./run-orchestrator.js";

const T0 = Date.parse("2026-10-29T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function row(profileId: string): CredentialProfile {
  return {
    profile_id: profileId,
    harness_id: "codex",
    display_name: profileId,
    credential_kind: "config_dir_login",
    isolation_locator: `/tmp/claudexor-test/${profileId}`,
    secret_ref: null,
    enabled: true,
    created_at: null,
  };
}

function codexRead(
  subject: string,
  windows: Array<{ id: string; used: number | null; resetMs: number; seconds: number }>,
  observedMs = T0,
): QuotaSnapshot {
  return {
    subject: {
      harness: "codex",
      credential_route: "vendor_native",
      plan_label: null,
      subject_id: subject,
    },
    source: "codex_app_server",
    observed_at: iso(observedMs),
    freshness: "fresh",
    constraints: windows.map((window) => ({
      id: window.id,
      label: window.id,
      applies_to_request_kinds: ["text"],
      used_ratio: window.used,
      window_seconds: window.seconds,
      resets_at: iso(window.resetMs),
      cooldown_until: null,
    })),
  };
}

function context(overrides: Partial<AccountResolutionContext>): AccountResolutionContext & {
  events: Array<{ type: string; payload: Record<string, unknown> }>;
} {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return {
    harnessId: "codex",
    registry: [row("a"), row("b")],
    policy: { limit_action: "rotate", rotation_eligible: [], headroom_threshold: 0.9 },
    snapshots: [],
    quota: { snapshots: [], absences: [] },
    unusable: [],
    probe: async (profile) => ({
      profile_id: profile.profile_id,
      harness_id: profile.harness_id,
      availability: "available",
      verification: "passed",
      verification_source: "local_store",
      detail: "test probe",
      last_verified_at: null,
    }),
    pinnedProfile: null,
    boundProfileId: null,
    threadId: null,
    model: null,
    requestKind: "text",
    defaultRoute: "local_session",
    nativeCredentialsDisabled: false,
    authPreference: "subscription",
    notePoolApiKeyRoute: () => undefined,
    emit: (type, payload) => events.push({ type, payload }),
    ...overrides,
    events,
  };
}

const SHORT = 5 * 3600;
const WEEK = 7 * 86400;

describe("#457 per-window freshness at the decision instant", () => {
  afterEach(() => vi.useRealTimers());
  // The registry and every admission reader share one controlled decision clock.
  function registryAt(clock: { now: number }) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(clock.now);
    const registry = new QuotaRegistry(memoryEventLedger(iso(T0)), [], () => new Date(clock.now));
    registry.upsert(
      codexRead("a", [
        { id: "codex:primary", used: 1, resetMs: T0 + 2 * 60_000, seconds: SHORT },
        { id: "codex:secondary", used: 0.95, resetMs: T0 + 3 * 86400_000, seconds: WEEK },
      ]),
    );
    registry.upsert(
      codexRead("b", [
        { id: "codex:primary", used: 0.2, resetMs: T0 + 4 * 3600_000, seconds: SHORT },
        { id: "codex:secondary", used: 0.3, resetMs: T0 + 3 * 86400_000, seconds: WEEK },
      ]),
    );
    return registry;
  }

  it("keeps the weekly reserve after the short reset, without a false short-window breach", async () => {
    const clock = { now: T0 + 3 * 60_000 };
    const registry = registryAt(clock);
    const snapshots = registry.readAdmission().snapshots;
    const breach = profileHeadroomBreach(snapshots, "codex", "a", 0.9, null, "text", clock.now);
    expect(breach).toMatchObject({ constraint_id: "codex:secondary", used_ratio: 0.95 });

    const pin = context({ snapshots, pinnedProfile: row("a") });
    await expect(resolveAccountForRun(pin)).rejects.toMatchObject({
      code: "subscription_window_exhausted",
      quotaRefusal: { basis: "owner_reserve", constraintId: "codex:secondary", threshold: 0.9 },
    });
    // The pool takes the genuinely usable alternative.
    const pool = selectFromAccountPool({
      registry: [row("a"), row("b")],
      harnessId: "codex",
      snapshots,
      readyProfileIds: new Set(["a", "b"]),
      headroomThreshold: 0.9,
      requestKind: "text",
    });
    expect(pool).toMatchObject({
      outcome: "selected",
      candidate: { profile: { profile_id: "b" } },
    });
    // Already-tried exclusion is unchanged.
    expect(
      nextEligibleProfile(
        [row("a"), row("b")],
        "codex",
        { limit_action: "rotate", rotation_eligible: [], headroom_threshold: 0.9 },
        null,
        snapshots,
        new Set(["a", "b"]),
        new Set(["b"]),
      ),
    ).toBeNull();
  });

  it("buildRunOrchestrator injects the per-window admission read that the account resolver refuses on", async () => {
    const clock = { now: T0 + 3 * 60_000 };
    const registry = registryAt(clock);
    const orchestrator = buildRunOrchestrator({
      accounts: createAccountEvidence(),
      p: {} as Parameters<typeof buildRunOrchestrator>[0]["p"],
      delegationBudgetAuthority: undefined,
      // The registry's source class (this test imports it from src, the CLI from dist).
      quotaStore: () =>
        registry as unknown as ReturnType<Parameters<typeof buildRunOrchestrator>[0]["quotaStore"]>,
    });
    // The exact projection the Orchestrator's run admission consumes.
    const snapshots = (
      orchestrator as unknown as { deps: { quotaSnapshots: () => QuotaSnapshot[] } }
    ).deps.quotaSnapshots();
    await expect(
      resolveAccountForRun(context({ snapshots, pinnedProfile: row("a") })),
    ).rejects.toMatchObject({
      code: "subscription_window_exhausted",
      quotaRefusal: { basis: "owner_reserve", constraintId: "codex:secondary", usedRatio: 0.95 },
    });
    await expect(resolveAccountForRun(context({ snapshots }))).resolves.toMatchObject({
      profile_id: "b",
    });
  });

  it("never revives evidence past its TTL and never breaches on an elapsed window", () => {
    const clock = { now: T0 + 6 * 60_000 };
    const registry = registryAt(clock);
    // Past the five-minute TTL the observation is stale: no reserve breach.
    expect(
      profileHeadroomBreach(
        registry.readAdmission().snapshots,
        "codex",
        "a",
        0.9,
        null,
        "text",
        clock.now,
      ),
    ).toBeNull();
    // A captured fresh label reused after the short reset cannot breach on it.
    const captured = codexRead("a", [
      { id: "codex:primary", used: 1, resetMs: T0 + 2 * 60_000, seconds: SHORT },
    ]);
    expect(
      profileHeadroomBreach([captured], "codex", "a", 0.9, null, "text", T0 + 60_000),
    ).toMatchObject({
      constraint_id: "codex:primary",
    });
    expect(
      profileHeadroomBreach([captured], "codex", "a", 0.9, null, "text", T0 + 3 * 60_000),
    ).toBeNull();
    // Unknown usage is never a breach.
    const unknown = codexRead("a", [
      { id: "codex:secondary", used: null, resetMs: T0 + 86400_000, seconds: WEEK },
    ]);
    expect(
      profileHeadroomBreach([unknown], "codex", "a", 0.1, null, "text", T0 + 60_000),
    ).toBeNull();
    // The display read keeps its aggregate freshness contract.
    expect(registry.read().snapshots.every((snapshot) => snapshot.freshness === "stale")).toBe(
      true,
    );
  });
});

describe("#318 strict pin: owner reserve versus provider exhaustion", () => {
  const pinned = (snapshot: QuotaSnapshot, threshold: number) =>
    context({
      snapshots: [snapshot],
      pinnedProfile: row("a"),
      policy: { limit_action: "rotate", rotation_eligible: [], headroom_threshold: threshold },
    });
  const at90 = codexRead(
    "a",
    [{ id: "codex:primary", used: 0.9, resetMs: Date.now() + 3600_000, seconds: SHORT }],
    Date.now(),
  );
  const at100 = codexRead(
    "a",
    [{ id: "codex:primary", used: 1, resetMs: Date.now() + 3600_000, seconds: SHORT }],
    Date.now(),
  );

  it("labels a 90% pin under a 90% reserve as the owner's reserve, and 100% as provider exhaustion", async () => {
    const reserve = pinned(at90, 0.9);
    const reserveError = await resolveAccountForRun(reserve).catch((error: unknown) => error);
    expect(reserveError).toMatchObject({
      code: "subscription_window_exhausted",
      quotaRefusal: { basis: "owner_reserve", usedRatio: 0.9, threshold: 0.9 },
      problem: { context: { refusal_basis: "owner_reserve" } },
    });
    expect(String((reserveError as Error).message)).toContain("reserve");
    expect(
      reserve.events.find((event) => event.type === "route.profile.headroom_exceeded")?.payload,
    ).toMatchObject({ basis: "owner_reserve" });

    for (const threshold of [0.9, 1]) {
      const exhausted = await resolveAccountForRun(pinned(at100, threshold)).catch(
        (error: unknown) => error,
      );
      expect(exhausted).toMatchObject({
        code: "subscription_window_exhausted",
        quotaRefusal: { basis: "provider_window" },
        problem: { context: { refusal_basis: "provider_window" } },
      });
      expect(String((exhausted as Error).message)).not.toContain("reserve");
    }
    // Below the reserve the pin is admitted; a pin never rotates.
    await expect(resolveAccountForRun(pinned(at90, 0.95))).resolves.toMatchObject({
      profile_id: "a",
    });
  });
});
