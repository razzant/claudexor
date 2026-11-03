import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetLedger } from "@claudexor/budget";
import { ArtifactStore } from "@claudexor/artifact-store";
import type { HarnessAdapter } from "@claudexor/core";
import type {
  CredentialProfile,
  CredentialProfileStatus,
  QuotaSnapshot,
  QuotaAbsence,
  RouteRankingRationale,
} from "@claudexor/schema";
import { ConformanceReport, HarnessManifest } from "@claudexor/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authRouteEvidenceFor, profileBillingVerification } from "./auth-route-classification.js";
import { PreProgressRefusalLedger } from "../../daemon/src/pre-progress-refusal-ledger.js";
import { AdmissionProfileProbes } from "./orchestrator-credentials.js";
import { Orchestrator, type OrchestratorResult, type RunInput } from "./orchestrator.js";

/**
 * #260 / community PR #261: a lane whose quota admission selected a named
 * credential profile is billed by THAT profile's evidence, never by the
 * aggregate doctor's default-store auth sources. Both misattribution
 * directions are pinned: a vendor-verified row is not demoted by a logged-out
 * default store, and a verified default store never lends its subscription
 * entitlement to a row that only has local-store evidence.
 */

const scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(path);
  return path;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of scratchDirs.splice(0)) rmSync(path, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

function initializedRepo(): string {
  const repo = scratch("claudexor-profile-billing-repo-");
  execFileSync("git", ["-C", repo, "init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# test\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "-m",
    "init",
  ]);
  return repo;
}

type DefaultStore = "logged_out" | "verified";
type RowEvidence = "local_passed" | "stale" | "throws" | "wrong_subject";

interface Lane {
  adapter: HarnessAdapter;
  probes: string[];
  ran: Array<string | null>;
}

/** A Codex-shaped lane: the default store's doctor verdict and each row's
 * local probe are independent, exactly as the real adapter reports them. */
function codexLane(
  defaultStore: DefaultStore,
  rowEvidence: RowEvidence | ((id: string) => RowEvidence) = "local_passed",
  failFirstTry: boolean | "all" = false,
  cashUsd = 0,
): Lane {
  const probes: string[] = [];
  const ran: Array<string | null> = [];
  const adapter: HarnessAdapter = {
    id: "codex",
    async discover() {
      return HarnessManifest.parse({
        id: "codex",
        display_name: "Codex",
        kind: "local_cli",
        provider_family: "openai",
        capabilities: { read_files: true, implement: true },
        access_profiles_supported: ["readonly", "workspace_write"],
      });
    },
    async doctor() {
      return defaultStore === "verified"
        ? ConformanceReport.parse({
            harness_id: "codex",
            status: "ok",
            enabled_intents: ["explain", "audit", "plan", "review", "implement"],
            auth_sources: [
              { source: "native_session", availability: "available", verification: "passed" },
            ],
          })
        : ConformanceReport.parse({
            harness_id: "codex",
            status: "unavailable",
            reasons: ["the default Codex home is not logged in"],
            auth_sources: [
              { source: "native_session", availability: "unavailable", verification: "not_run" },
            ],
          });
    },
    async probeCredentialProfile(profile): Promise<CredentialProfileStatus> {
      probes.push(profile.profile_id);
      const evidence =
        typeof rowEvidence === "function" ? rowEvidence(profile.profile_id) : rowEvidence;
      if (evidence === "throws") throw new Error("fixture profile probe failed");
      const base = {
        profile_id: evidence === "wrong_subject" ? "wrong-account" : profile.profile_id,
        harness_id: "codex",
      };
      return evidence === "stale"
        ? {
            ...base,
            availability: "unknown",
            verification: "not_run",
            verification_source: "local_store",
            stale: true,
            stale_age_ms: 60_000,
            last_verified_at: null,
          }
        : {
            ...base,
            availability: "available",
            verification: "passed",
            verification_source: "local_store",
            last_verified_at: new Date().toISOString(),
          };
    },
    async *run(spec) {
      const ts = new Date().toISOString();
      const profileId = spec.credential_profile?.profile_id ?? null;
      ran.push(profileId);
      yield {
        type: "started",
        session_id: spec.session_id,
        ts,
        credential_route: "vendor_native",
        credential_profile_id: profileId ?? undefined,
        processing: spec.processing,
        processing_cost_basis: spec.processing_cost_basis,
      } as const;
      if (failFirstTry === "all" || (failFirstTry && ran.length === 1)) {
        // An untyped pre-progress death: the structural rotation branch.
        yield {
          type: "error",
          session_id: spec.session_id,
          ts,
          error: `vendor refused ${profileId}`,
        } as const;
        yield { type: "completed", session_id: spec.session_id, ts } as const;
        return;
      }
      yield {
        type: "usage",
        session_id: spec.session_id,
        ts,
        usage: { cost_usd: cashUsd, cost_basis: { kind: "cash", source: "fixture.debit" } },
      } as const;
      yield { type: "message", session_id: spec.session_id, ts, text: "ok", final: true } as const;
      yield { type: "completed", session_id: spec.session_id, ts } as const;
    },
  };
  return { adapter, probes, ran };
}

/** The quota poller's authenticated vendor contact under one row's token. */
function vendorHonored(profileId: string): QuotaSnapshot {
  return {
    subject: {
      harness: "codex",
      credential_route: "vendor_native",
      plan_label: "pro",
      subject_id: profileId,
    },
    constraints: [],
    source: "codex_app_server",
    observed_at: new Date().toISOString(),
    freshness: "fresh",
  };
}

function writeConfig(
  configDir: string,
  paidFallback: "never" | "when_unavailable",
  rows: string[],
  extra: string[] = [],
): void {
  writeFileSync(
    join(configDir, "config.yaml"),
    [
      "routing:",
      `  paid_fallback: ${paidFallback}`,
      "credential_profiles:",
      ...rows.flatMap((id) => [
        `  - profile_id: ${id}`,
        "    harness_id: codex",
        `    display_name: ${id}`,
        "    credential_kind: config_dir_login",
        `    isolation_locator: ${JSON.stringify(join(configDir, "profiles", id))}`,
        "    secret_ref: null",
        "    enabled: true",
        "    created_at: 2026-09-01T07:05:45.812Z",
      ]),
      ...extra,
      "",
    ].join("\n"),
  );
}

async function withConfig<T>(
  paidFallback: "never" | "when_unavailable",
  rows: string[],
  body: () => Promise<T>,
  extra: string[] = [],
): Promise<T> {
  const configDir = scratch("claudexor-profile-billing-config-");
  writeConfig(configDir, paidFallback, rows, extra);
  const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = configDir;
  try {
    return await body();
  } finally {
    if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
  }
}

function ask(
  lane: Lane,
  snapshots: QuotaSnapshot[],
  credentialProfileId?: string,
  options: Partial<RunInput> = {},
): Promise<OrchestratorResult> {
  return new Orchestrator({
    registry: new Map([["codex", lane.adapter]]),
    reviewers: [],
    quotaSnapshots: () => snapshots,
  }).run({
    repoRoot: initializedRepo(),
    prompt: "hello",
    mode: "ask",
    harnesses: ["codex"],
    ...(credentialProfileId ? { credentialProfileId } : {}),
    web: "auto",
    ...options,
  });
}

function telemetry(result: OrchestratorResult): {
  routing_rationale: RouteRankingRationale | null;
  auth_route: { profile_id: string | null };
} {
  const recorded = new ArtifactStore(result.runDir).readYaml<ReturnType<typeof telemetry>>(
    join(result.runDir, "final", "telemetry.yaml"),
  );
  if (!recorded) throw new Error(`no telemetry for ${result.runId}: ${result.summary}`);
  return recorded;
}

function billingOf(result: OrchestratorResult): string | undefined {
  return telemetry(result).routing_rationale?.entries.find((entry) => entry.harness_id === "codex")
    ?.billing_knowledge;
}

function failureText(result: OrchestratorResult): string {
  const path = join(result.runDir, "final", "failure.yaml");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

describe("selected-profile billing attribution (#260)", () => {
  it("keeps a vendor-verified pinned profile eligible under paid_fallback: never while the default store is logged out", async () => {
    const lane = codexLane("logged_out");
    const result = await withConfig("never", ["work-primary"], () =>
      ask(lane, [vendorHonored("work-primary")], "work-primary"),
    );

    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(lane.ran).toEqual(["work-primary"]);
    expect(billingOf(result)).toBe("subscription_entitlement");
  });

  it("never lends a verified default store's entitlement to a pinned profile with only local-store evidence", async () => {
    const lane = codexLane("verified");
    const result = await withConfig("never", ["work-primary"], () => ask(lane, [], "work-primary"));

    expect(result.lifecycle).toBe("failed");
    expect(lane.ran).toEqual([]);
    expect(failureText(result)).toContain("after budget and quota routing");
  });

  it("classifies a local-only pinned profile as unknown billing when paid fallback may still serve it", async () => {
    const lane = codexLane("verified");
    const result = await withConfig("when_unavailable", ["work-primary"], () =>
      ask(lane, [], "work-primary"),
    );

    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(billingOf(result)).toBe("unknown");
  });

  it("treats a stale last-known-good pin as unknown billing even with vendor contact", async () => {
    const lane = codexLane("verified", "stale");
    const result = await withConfig("never", ["work-primary"], () =>
      ask(lane, [vendorHonored("work-primary")], "work-primary"),
    );

    expect(result.lifecycle).toBe("failed");
    expect(lane.ran).toEqual([]);
    expect(failureText(result)).toContain("after budget and quota routing");
  });

  it("bills an unpinned pool row by its own vendor evidence, not the logged-out default store", async () => {
    const lane = codexLane("logged_out");
    const result = await withConfig("never", ["codex-work"], () =>
      ask(lane, [vendorHonored("codex-work")]),
    );

    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(lane.ran).toEqual(["codex-work"]);
    expect(billingOf(result)).toBe("subscription_entitlement");
  });

  it("reuses the admission probe for initial billing and refreshes it before physical dispatch", async () => {
    const lane = codexLane("logged_out");
    await withConfig("never", ["work-primary"], () =>
      ask(lane, [vendorHonored("work-primary")], "work-primary"),
    );

    expect(lane.probes).toEqual(["work-primary", "work-primary"]);
  });

  it("keeps the admitted row's billing identity separate from the row a rotation actually ran", async () => {
    const lane = codexLane("verified", "local_passed", true);
    const result = await withConfig(
      "when_unavailable",
      ["a", "b"],
      () => ask(lane, [vendorHonored("a")]),
      ["harnesses:", "  codex:", "    profile_policy:", "      limit_action: rotate"],
    );

    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(lane.ran).toEqual(["a", "b"]);
    // Ranking billed the admitted row `a` by its vendor evidence; the receipt
    // names the row that produced the deliverable.
    expect(billingOf(result)).toBe("subscription_entitlement");
    expect(telemetry(result).auth_route.profile_id).toBe("b");
  });
});

describe("authRouteEvidenceFor", () => {
  const verifiedDefault = [
    {
      source: "native_session" as const,
      availability: "available" as const,
      verification: "passed" as const,
    },
  ];
  const loggedOutDefault = [
    {
      source: "native_session" as const,
      availability: "unavailable" as const,
      verification: "not_run" as const,
    },
  ];

  it("judges a selected profile by its own verification in both directions", () => {
    expect(authRouteEvidenceFor("local_session", loggedOutDefault, "passed")).toEqual({
      route: "vendor_native",
      verification: "passed",
    });
    expect(authRouteEvidenceFor("local_session", verifiedDefault, "not_run")).toEqual({
      route: "vendor_native",
      verification: "not_run",
    });
    expect(authRouteEvidenceFor("api_key", verifiedDefault, "not_run")).toEqual({
      route: "managed_api_key",
      verification: "not_run",
    });
  });

  it("keeps the doctor-source reading for profile-less routes", () => {
    expect(authRouteEvidenceFor("local_session", verifiedDefault, null)).toEqual({
      route: "vendor_native",
      verification: "passed",
    });
    expect(authRouteEvidenceFor("local_session", loggedOutDefault, null)).toEqual({
      route: "vendor_native",
      verification: "not_run",
    });
    expect(
      authRouteEvidenceFor(
        "api_key",
        [{ source: "api_key_env", availability: "available", verification: "passed" }],
        null,
      ),
    ).toEqual({ route: "managed_api_key", verification: "passed" });
    expect(authRouteEvidenceFor("unknown", verifiedDefault, null)).toBeUndefined();
  });
});

describe("profileBillingVerification", () => {
  const status = (overrides: Partial<CredentialProfileStatus>): CredentialProfileStatus => ({
    profile_id: "p",
    harness_id: "codex",
    availability: "available",
    verification: "passed",
    verification_source: "local_store",
    last_verified_at: null,
    ...overrides,
  });

  it("accepts only a fresh vendor-backed verdict", () => {
    expect(profileBillingVerification(status({ verification_source: "vendor" }))).toBe("passed");
    expect(
      profileBillingVerification(status({ verification_source: "vendor", verification: "failed" })),
    ).toBe("failed");
    expect(profileBillingVerification(status({}))).toBe("not_run");
    expect(profileBillingVerification(status({ verification_source: "vendor", stale: true }))).toBe(
      "not_run",
    );
  });
});

describe("AdmissionProfileProbes", () => {
  const row = (profileId: string, harnessId = "codex"): CredentialProfile =>
    ({ profile_id: profileId, harness_id: harnessId }) as CredentialProfile;
  const answer = (profile: CredentialProfile, detail: string): CredentialProfileStatus => ({
    profile_id: profile.profile_id,
    harness_id: profile.harness_id,
    availability: "available",
    verification: "passed",
    verification_source: "local_store",
    detail,
    last_verified_at: null,
  });

  it("reuses only the exact row's latest probe and falls back to the adapter otherwise", async () => {
    const probes = new AdmissionProfileProbes();
    let calls = 0;
    const adapterProbe = async (profile: CredentialProfile) => answer(profile, `call-${++calls}`);
    const recorded = probes.record(adapterProbe)!;
    await recorded(row("a"));
    await recorded(row("a"));

    expect((await probes.reuse(row("a"), adapterProbe)!(row("a"))).detail).toBe("call-2");
    // A sibling row, or the same id on another harness, never inherits it.
    expect((await probes.reuse(row("b"), adapterProbe)!(row("b"))).detail).toBe("call-3");
    expect((await probes.reuse(row("a", "claude"), adapterProbe)!(row("a", "claude"))).detail).toBe(
      "call-4",
    );
    expect(probes.record(undefined)).toBeUndefined();
  });
});

describe.each(["ask", "agent"] as const)("%s profile billing through physical rotation", (mode) => {
  it.each(
    [
      { evidence: "vendor", cap: 0, processing: true },
      { evidence: "local", cap: 0, processing: true },
      { evidence: "local", cap: 2, processing: true },
      { evidence: "stale_probe", cap: 0, processing: true },
      { evidence: "vendor", cap: 0, processing: false },
      { evidence: "local", cap: 0, processing: false },
      { evidence: "local", cap: 2, processing: false },
      { evidence: "local", cap: 2, processing: true, paidFallback: "never" },
      { evidence: "local", cap: 2, processing: false, paidFallback: "never" },
      { evidence: "vendor", cap: 0, processing: false, paidFallback: "never" },
    ].map((row) => ({ paidFallback: "when_unavailable" as const, ...row })) as Array<{
      evidence: "vendor" | "local" | "stale_probe";
      cap: number;
      processing: boolean;
      paidFallback: "never" | "when_unavailable";
    }>,
  )(
    "re-admits B using $evidence evidence at cap=$cap (processing=$processing, policy=$paidFallback)",
    async ({ evidence, cap, processing, paidFallback }) => {
      let bProbesAfterA = 0;
      const lane = codexLane(
        "verified",
        (id) => {
          if (
            id === "b" &&
            lane.ran.length > 0 &&
            ++bProbesAfterA > 1 &&
            evidence === "stale_probe"
          )
            return "stale";
          return "local_passed";
        },
        true,
        cap > 0 ? 0.2 : 0,
      );
      const admissions: Array<{ profile: string | undefined; billing: string }> = [];
      const original = BudgetLedger.prototype.repriceReservedLease;
      vi.spyOn(BudgetLedger.prototype, "repriceReservedLease").mockImplementation(function (
        this: BudgetLedger,
        id,
        cost,
      ) {
        admissions.push({
          profile: cost.provenance.find((p) => p.startsWith("profile:")),
          billing: cost.billing,
        });
        return original.call(this, id, cost);
      });
      if (processing)
        lane.adapter.prepareProcessing = async (input) => ({
          model: input.model,
          receipt: {
            requested: input.preference ?? null,
            submitted: "standard",
            submittedNative: "default",
            observed: "unknown",
            observedNative: [],
            reason: null,
            source: "fixture.processing",
          },
          // No account tariff evidence: only THIS profile's verification can
          // establish ordinary subscription billing.
          costBasis: { nativeMode: "default", kind: "unknown", source: "fixture.processing" },
        });
      const snapshots = [vendorHonored("a")];
      if (evidence !== "local") snapshots.push(vendorHonored("b"));
      const result = await withConfig(paidFallback, ["a", "b"], () =>
        ask(lane, snapshots, undefined, {
          mode,
          inPlace: mode === "agent",
          review: false,
          paidBudget: { kind: "finite", maxUsd: cap },
          ...(processing ? { processingPreference: "standard" as const } : {}),
        }),
      );
      const policyDenied = paidFallback === "never" && evidence !== "vendor";
      const denied = policyDenied || (evidence !== "vendor" && cap === 0);
      expect(admissions, result.summary).toEqual([
        { profile: "profile:a", billing: "subscription_entitlement" },
        ...(policyDenied
          ? []
          : [
              {
                profile: "profile:b",
                billing: evidence === "vendor" ? "subscription_entitlement" : "unknown",
              },
            ]),
      ]);
      expect(lane.ran).toEqual(denied ? ["a"] : ["a", "b"]);
      expect(result.lifecycle, result.summary).toBe(denied ? "failed" : "succeeded");
      expect(billingOf(result)).toBe("subscription_entitlement");
      expect(telemetry(result).auth_route.profile_id).toBe(denied ? "a" : "b");
      expect(result.spendUsd).toBe(!denied && cap > 0 ? 0.2 : 0);
      const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8");
      expect(events).toContain('"from_profile_id":"a","to_profile_id":"b"');
      if (denied) {
        expect(
          new ArtifactStore(result.runDir).readYaml(join(result.runDir, "final", "failure.yaml")),
        ).toMatchObject(
          policyDenied
            ? { category: "config_error", code: null }
            : { category: "budget", code: "finite_zero" },
        );
      }
    },
  );

  it("retains B's provider failure after a real A to B rotation", async () => {
    const lane = codexLane("verified", "local_passed", "all");
    const result = await withConfig("when_unavailable", ["a", "b"], () =>
      ask(lane, [vendorHonored("a"), vendorHonored("b")], undefined, {
        mode,
        inPlace: mode === "agent",
        review: false,
      }),
    );
    expect(lane.ran).toEqual(["a", "b"]);
    expect(result.lifecycle).toBe("failed");
    expect(telemetry(result).auth_route.profile_id).toBe("b");
    expect(failureText(result)).toContain("vendor refused b");
    expect(failureText(result)).not.toContain("finite_zero");
  });

  it.each(["throws", "wrong_subject"] as const)(
    "keeps failed B readiness (%s) separate from billing refusal",
    async (evidence) => {
      const lane = codexLane("verified", (id) => (id === "b" ? evidence : "local_passed"), true);
      const result = await withConfig("when_unavailable", ["a", "b"], () =>
        ask(lane, [vendorHonored("a")], undefined, {
          mode,
          inPlace: mode === "agent",
          review: false,
        }),
      );
      expect(lane.ran).toEqual(["a"]);
      expect(result.lifecycle).toBe("failed");
      expect(failureText(result)).toContain("vendor refused");
      expect(failureText(result)).not.toContain("finite_zero");
      const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8");
      expect(events).toContain("route.profile.rotation_exhausted");
      expect(events).not.toContain("route.profile.rotated");
    },
  );
});

describe.each(["ask", "agent"] as const)("%s current evidence before physical dispatch", (mode) => {
  it.each([
    { change: "generation_unknown", cap: 0, paidFallback: "when_unavailable" },
    { change: "generation_unknown", cap: 2, paidFallback: "when_unavailable" },
    { change: "generation_unknown", cap: 2, paidFallback: "never" },
    { change: "generation_vendor", cap: 0, paidFallback: "never" },
    { change: "quota_confirmed", cap: 0, paidFallback: "never" },
    { change: "quota_revoked", cap: 2, paidFallback: "never" },
  ] as const)(
    "uses $change at cap=$cap under $paidFallback",
    async ({ change, cap, paidFallback }) => {
      const lane = codexLane("verified");
      const snapshots: QuotaSnapshot[] = [vendorHonored("a")];
      const absences: QuotaAbsence[] = [];
      const memory = new PreProgressRefusalLedger();
      const generation = memory.generation("codex", "a");
      const admissions: Array<{ billing: string; provenance: string[] }> = [];
      const reprice = BudgetLedger.prototype.repriceReservedLease;
      vi.spyOn(BudgetLedger.prototype, "repriceReservedLease").mockImplementation(function (
        this: BudgetLedger,
        id,
        cost,
      ) {
        admissions.push({ billing: cost.billing, provenance: cost.provenance });
        return reprice.call(this, id, cost);
      });
      let modelReads = 0;
      lane.adapter.models = async () => {
        if (++modelReads === 1) {
          // The real orchestrator has ranked the initial account, but has not
          // dispatched it. A quota observation can change without a new login.
          expect(lane.probes).toEqual(["a"]);
          if (change.startsWith("generation_")) memory.clearSubject("codex", "a");
          snapshots.splice(0, snapshots.length);
          if (change === "generation_vendor" || change === "quota_confirmed")
            snapshots.push(vendorHonored("a"));
          if (change === "quota_revoked")
            absences.push({
              subject: vendorHonored("a").subject,
              reason: "auth_revoked",
              observed_at: new Date().toISOString(),
              detail: "fixture vendor revoked this credential",
            });
        }
        return [{ id: "model-a", label: null, context_window: null, routes: [] }];
      };
      const result = await withConfig(paidFallback, ["a"], () =>
        new Orchestrator({
          registry: new Map([["codex", lane.adapter]]),
          reviewers: [],
          quotaSnapshots: () => snapshots,
          quotaAbsences: () => absences,
          preProgressRefusals: memory,
        }).run({
          repoRoot: initializedRepo(),
          prompt: "hello",
          mode,
          harnesses: ["codex"],
          credentialProfileId: "a",
          models: { codex: "model-a" },
          web: "auto",
          inPlace: mode === "agent",
          review: false,
          paidBudget: { kind: "finite", maxUsd: cap },
        }),
      );
      const included = change === "generation_vendor" || change === "quota_confirmed";
      const denied = !included && (cap === 0 || paidFallback === "never");
      expect(modelReads).toBeGreaterThanOrEqual(2);
      expect(memory.generation("codex", "a")).toBe(
        generation + (change.startsWith("generation_") ? 1 : 0),
      );
      expect(admissions).toEqual(
        !included && paidFallback === "never"
          ? []
          : [
              {
                billing: included ? "subscription_entitlement" : "unknown",
                provenance: ["harness:codex", "profile:a"],
              },
            ],
      );
      expect(lane.ran).toEqual(denied ? [] : ["a"]);
      expect(result.lifecycle, result.summary).toBe(denied ? "failed" : "succeeded");
      // The historical selection reason remains true even when dispatch evidence changes.
      expect(billingOf(result)).toBe("subscription_entitlement");
      if (denied)
        expect(failureText(result)).toContain(
          paidFallback === "never" ? "config_error" : "finite_zero",
        );
    },
  );

  it("uses new vendor proof at initial billing without a second admission probe", async () => {
    const lane = codexLane("verified");
    const snapshots: QuotaSnapshot[] = [];
    const originalProbe = lane.adapter.probeCredentialProfile!;
    lane.adapter.probeCredentialProfile = async (profile) => {
      const answer = await originalProbe(profile);
      if (snapshots.length === 0) snapshots.push(vendorHonored(profile.profile_id));
      return answer;
    };
    const result = await withConfig("never", ["a"], () =>
      ask(lane, snapshots, "a", {
        mode,
        inPlace: mode === "agent",
        review: false,
        paidBudget: { kind: "finite", maxUsd: 0 },
      }),
    );
    expect(lane.probes).toEqual(["a", "a"]);
    expect(lane.ran).toEqual(["a"]);
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(billingOf(result)).toBe("subscription_entitlement");
  });
});

describe("model fallback billing", () => {
  it.each([
    { vendor: true, cap: 0 },
    { vendor: false, cap: 0 },
    { vendor: false, cap: 2 },
  ])("rechecks the fallback dispatch with vendor=$vendor at cap=$cap", async ({ vendor, cap }) => {
    const lane = codexLane("verified", "local_passed", true);
    const snapshots = [vendorHonored("a")];
    const seenModels: Array<string | null> = [];
    const originalRun = lane.adapter.run.bind(lane.adapter);
    lane.adapter.models = async () =>
      ["primary", "fallback"].map((id) => ({ id, label: null, context_window: null, routes: [] }));
    lane.adapter.run = async function* (spec) {
      seenModels.push(spec.model_hint ?? null);
      yield* originalRun(spec);
      if (!vendor) snapshots.splice(0, snapshots.length);
    };
    const result = await withConfig(
      "when_unavailable",
      ["a"],
      () =>
        ask(lane, snapshots, "a", {
          models: { codex: "primary" },
          paidBudget: { kind: "finite", maxUsd: cap },
        }),
      ["harnesses:", "  codex:", "    fallback_model: fallback"],
    );
    const denied = !vendor && cap === 0;
    expect(seenModels, result.summary).toEqual(denied ? ["primary"] : ["primary", "fallback"]);
    expect(result.lifecycle, result.summary).toBe(denied ? "failed" : "succeeded");
    expect(billingOf(result)).toBe("subscription_entitlement");
    if (denied) expect(failureText(result)).toContain("finite_zero");
  });
});

it.each([false, true])(
  "keeps two parallel unknown-cost scouts admitted with finite headroom (api=%s)",
  async (api) => {
    const lane = codexLane("logged_out", "local_passed", false, 0.2);
    let releaseFirst!: () => void;
    const secondAdmission = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const run = lane.adapter.run.bind(lane.adapter);
    lane.adapter.run = async function* (spec) {
      for await (const event of run(spec)) {
        yield event.type === "started" && api
          ? { ...event, credential_route: "managed_api_key" }
          : event;
        if (event.type === "started") await secondAdmission;
      }
    };
    const reprices: unknown[] = [];
    const reserves: unknown[] = [];
    const reserve = BudgetLedger.prototype.reserve;
    vi.spyOn(BudgetLedger.prototype, "reserve").mockImplementation(function (
      this: BudgetLedger,
      req,
    ) {
      const result = reserve.call(this, req);
      reserves.push(JSON.parse(JSON.stringify({ req, result })));
      if (req.attemptId === "a02" && !result.granted) releaseFirst();
      return result;
    });
    const reprice = BudgetLedger.prototype.repriceReservedLease;
    vi.spyOn(BudgetLedger.prototype, "repriceReservedLease").mockImplementation(function (
      this: BudgetLedger,
      id,
      cost,
    ) {
      const result = reprice.call(this, id, cost);
      reprices.push({ cost, result });
      if (reprices.length === 2) releaseFirst();
      return result;
    });
    const result = await withConfig("when_unavailable", ["a"], async () => {
      if (api) {
        const config = join(process.env.CLAUDEXOR_CONFIG_DIR!, "config.yaml");
        writeFileSync(
          config,
          readFileSync(config, "utf8")
            .replace("credential_kind: config_dir_login", "credential_kind: api_key")
            .replace(/isolation_locator: .*/, "isolation_locator: null")
            .replace("secret_ref: null", "secret_ref: openai:a"),
        );
      }
      return ask(lane, [], "a", {
        deepScan: true,
        n: 2,
        paidBudget: { kind: "finite", maxUsd: 2 },
      });
    });
    expect(lane.ran, JSON.stringify({ result, reserves, reprices })).toHaveLength(2);
  },
);

it.each([false, true])(
  "preserves config_error for same-profile Plan paid-fallback refusal before physical dispatch (unlimited=%s)",
  async (unlimited) => {
    const lane = codexLane("verified");
    const snapshots = [vendorHonored("a")];
    const discover = lane.adapter.discover.bind(lane.adapter);
    lane.adapter.discover = async () => {
      const m = await discover();
      return HarnessManifest.parse({ ...m, capabilities: { ...m.capabilities, plan: true } });
    };
    let modelReads = 0;
    lane.adapter.models = async () => {
      if (++modelReads === 1) snapshots.splice(0);
      return [{ id: "model-a", label: null, context_window: null, routes: [] }];
    };
    const result = await withConfig("never", ["a"], () =>
      ask(lane, snapshots, "a", {
        mode: "plan",
        models: { codex: "model-a" },
        paidBudget: unlimited ? { kind: "unlimited" } : { kind: "finite", maxUsd: 2 },
        review: false,
      }),
    );
    const failure = new ArtifactStore(result.runDir).readYaml<{ category: string }>(
      join(result.runDir, "final/failure.yaml"),
    );
    expect(lane.ran).toEqual([]);
    expect(failure?.category).toBe("config_error");
  },
);

it.each([false, true])(
  "keeps an ordinary unknown or API-key single route working at positive cap (api=%s)",
  async (api) => {
    const lane = codexLane("verified", "local_passed", false, 0.2);
    const result = await withConfig("when_unavailable", ["a"], async () => {
      if (api) {
        const config = join(process.env.CLAUDEXOR_CONFIG_DIR!, "config.yaml");
        writeFileSync(
          config,
          readFileSync(config, "utf8")
            .replace("credential_kind: config_dir_login", "credential_kind: api_key")
            .replace(/isolation_locator: .*/, "isolation_locator: null")
            .replace("secret_ref: null", "secret_ref: openai:a"),
        );
      }
      return ask(lane, [], "a", { paidBudget: { kind: "finite", maxUsd: 2 } });
    });
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(lane.ran).toEqual(["a"]);
    expect(billingOf(result)).toBe(api ? "metered" : "unknown");
  },
);

describe.each(["ask", "plan", "agent"] as const)(
  "current billing for inline continuity in %s",
  (mode) => {
    it.each([
      { revoke: false, processing: false, cap: 0 },
      { revoke: true, processing: false, cap: 0 },
      { revoke: false, processing: true, cap: 0 },
      { revoke: true, processing: true, cap: 0 },
      { revoke: true, processing: false, cap: 2 },
      { revoke: true, processing: true, cap: 2 },
    ])(
      "current exact profile before summary revoke=$revoke processing=$processing cap=$cap",
      async ({ revoke, processing, cap }) => {
        const lane = codexLane("verified");
        const discover = lane.adapter.discover.bind(lane.adapter);
        lane.adapter.discover = async () => {
          const m = await discover();
          return HarnessManifest.parse({ ...m, capabilities: { ...m.capabilities, plan: true } });
        };
        const snapshots: QuotaSnapshot[] = [vendorHonored("a")];
        const sends: Array<{
          summary: boolean;
          profile: string | null;
          probes: number;
          billing: unknown;
          paidFallback: unknown;
        }> = [];
        const run = lane.adapter.run.bind(lane.adapter);
        lane.adapter.run = async function* (spec) {
          sends.push({
            summary: spec.prompt.includes("successor agent"),
            profile: spec.credential_profile?.profile_id ?? null,
            probes: lane.probes.length,
            billing: spec.extra["routeBillingKnowledge"],
            paidFallback: spec.extra["paidFallback"],
          });
          yield* run(spec);
        };
        if (processing)
          lane.adapter.prepareProcessing = async () => ({
            model: "model-a",
            receipt: {
              requested: "standard",
              submitted: "standard",
              submittedNative: "standard",
              observed: "unknown",
              observedNative: [],
              reason: null,
              source: "fixture",
            },
            costBasis: { nativeMode: "standard", kind: "unknown", source: "fixture" },
          });
        let modelReads = 0;
        lane.adapter.models = async () => {
          if (++modelReads === 1 && revoke) snapshots.splice(0);
          return [{ id: "model-a", label: null, context_window: null, routes: [] }];
        };
        const result = await withConfig("when_unavailable", ["a"], () =>
          new Orchestrator({
            registry: new Map([["codex", lane.adapter]]),
            reviewers: [],
            quotaSnapshots: () => snapshots,
          }).run({
            repoRoot: initializedRepo(),
            prompt: "continue the thread",
            mode,
            harnesses: ["codex"],
            credentialProfileId: "a",
            models: { codex: "model-a" },
            web: "auto",
            inPlace: mode === "agent",
            review: false,
            ...(processing ? { processingPreference: "standard" as const } : {}),
            paidBudget: { kind: "finite", maxUsd: cap },
            threadId: "thread-independent-scope",
            threadContinuity: {
              turnId: "t9",
              profileId: "a",
              laneCheckpoints: [],
              priorTurns: Array.from({ length: 8 }, (_, i) => ({
                id: "t" + i,
                prompt: "prior task ".repeat(700),
                runId: null,
              })),
            },
          }),
        );
        const trace = {
          mode,
          revoke,
          processing,
          sends,
          probes: lane.probes,
          modelReads,
          lifecycle: result.lifecycle,
          summary: result.summary,
        };
        if (!revoke || cap > 0)
          expect(sends.find((send) => send.summary)?.probes).toBeGreaterThan(1);
        expect(sends.filter((send) => send.summary).length, JSON.stringify(trace)).toBe(
          revoke && cap === 0 ? 0 : 1,
        );
        if (!revoke || cap > 0) expect(result.lifecycle, JSON.stringify(trace)).toBe("succeeded");
      },
    );
  },
);

describe("eligible mixed pools", () => {
  it.each([false, true])(
    "primary preference does not borrow vendor proof (confirmed=%s)",
    async (confirmed) => {
      const named = codexLane("verified");
      const calls: string[] = [];
      const originalRun = named.adapter.run.bind(named.adapter);
      named.adapter.run = async function* (spec) {
        calls.push("named");
        yield* originalRun(spec);
      };
      const sibling: HarnessAdapter = {
        ...named.adapter,
        id: "sibling",
        probeCredentialProfile: undefined,
        discover: async () => ({ ...(await named.adapter.discover())!, id: "sibling" }),
        doctor: async (spec) => ({ ...(await named.adapter.doctor(spec)), harness_id: "sibling" }),
        run: async function* (spec) {
          calls.push("sibling");
          const common = { session_id: spec.session_id, ts: new Date().toISOString() };
          yield { ...common, type: "started", credential_route: "vendor_native" };
          yield { ...common, type: "message", text: "done", final: true };
          yield { ...common, type: "completed" };
        },
      };
      const result = await withConfig("when_unavailable", ["a"], () =>
        new Orchestrator({
          registry: new Map([
            ["codex", named.adapter],
            ["sibling", sibling],
          ]),
          reviewers: [],
          quotaSnapshots: () => (confirmed ? [vendorHonored("a")] : []),
        }).run({
          repoRoot: initializedRepo(),
          prompt: "hello",
          mode: "ask",
          harnesses: ["codex", "sibling"],
          primaryHarness: "codex",
          web: "auto",
        }),
      );
      expect(result.lifecycle, result.summary).toBe("succeeded");
      expect(calls).toEqual([confirmed ? "named" : "sibling"]);
      expect(billingOf(result)).toBe(confirmed ? "subscription_entitlement" : "unknown");
    },
  );
});

it("keeps actually started unpriced Plan work unknown instead of cancelling its lease", async () => {
  const lane = codexLane("verified");
  const discover = lane.adapter.discover.bind(lane.adapter);
  lane.adapter.discover = async () => {
    const m = await discover();
    return HarnessManifest.parse({ ...m, capabilities: { ...m.capabilities, plan: true } });
  };
  lane.adapter.run = async function* (spec) {
    lane.ran.push(spec.credential_profile?.profile_id ?? null);
    const common = {
      session_id: spec.session_id,
      ts: new Date().toISOString(),
      credential_route: "managed_api_key" as const,
    };
    yield { ...common, type: "started" };
    yield { ...common, type: "error", error: "fixture worker ended without usage" };
    yield { ...common, type: "completed" };
  };
  const result = await withConfig("when_unavailable", ["a"], async () => {
    const path = join(process.env.CLAUDEXOR_CONFIG_DIR!, "config.yaml");
    writeFileSync(
      path,
      readFileSync(path, "utf8")
        .replace("credential_kind: config_dir_login", "credential_kind: api_key")
        .replace(/isolation_locator: .*/, "isolation_locator: null")
        .replace("secret_ref: null", "secret_ref: openai:a"),
    );
    return ask(lane, [], "a", {
      mode: "plan",
      paidBudget: { kind: "finite", maxUsd: 2 },
      review: false,
    });
  });
  expect(lane.ran).toEqual(["a"]);
  expect(result.lifecycle).toBe("failed");
  expect(result.facts.reason).toBe("cost_unverifiable");
  expect(failureText(result)).toContain("budget");
});
