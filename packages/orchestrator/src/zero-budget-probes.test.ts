import { describe, expect, it, vi } from "vitest";
import { GlobalConfig } from "@claudexor/schema";
import type { DoctorSpec, HarnessAdapter, PreparedHarnessProcessing } from "@claudexor/core";
import { DIAGNOSTIC_GENERATION_WITHHELD } from "@claudexor/core";
import type { RunInput, RoutedAdapter } from "./orchestrator.js";
import { prepareRoutedProcessing } from "./processing-routing.js";
import { effectivePaidBudget, probeCandidateStatuses, probeModeOf } from "./readiness-probe.js";
import { resolveCandidateHarnessIds } from "./route-admission.js";
import { candidateStatusInRouteContext } from "./routeContext.js";
import { pinnedNativeAdmission } from "./auth-route-classification.js";

const ZERO = { kind: "finite", maxUsd: 0 } as const;
const UNLIMITED = { kind: "unlimited" } as const;
const prepared: PreparedHarnessProcessing = {
  model: "m",
  receipt: {
    requested: null,
    submitted: null,
    submittedNative: null,
    observed: "unknown",
    observedNative: [],
    reason: null,
    source: "fixture",
  },
  costBasis: { nativeMode: null, kind: "unknown", source: "fixture" },
};

describe("effective paid budget", () => {
  it("resolves request, then execution defaults, then Settings", () => {
    const config = GlobalConfig.parse({ budget: { paid_budget_per_run: ZERO } });
    expect(effectivePaidBudget({}, {}, config)).toEqual(ZERO);
    expect(effectivePaidBudget({}, { paidBudget: UNLIMITED }, config)).toEqual(UNLIMITED);
    expect(effectivePaidBudget({ paidBudget: ZERO }, { paidBudget: UNLIMITED }, config)).toEqual(
      ZERO,
    );
    // The documented default is unlimited; a finite $0 is only ever explicit.
    expect(effectivePaidBudget({}, {}, GlobalConfig.parse({}))).toEqual(UNLIMITED);
  });
});

describe("automatic readiness probes carry the diagnostic mode", () => {
  it("host probes carry the mode from the effective budget, skip disabled harnesses and probe nothing when none remain", async () => {
    const statusAll = vi.fn(async () => []);
    const registry = new Map<string, HarnessAdapter>([
      ["claude", {} as HarnessAdapter],
      ["codex", {} as HarnessAdapter],
    ]);
    const config = GlobalConfig.parse({ harnesses: { codex: { enabled: false } } });
    const probe = (input: object, harnesses?: string[]) =>
      probeCandidateStatuses(
        { statusAll },
        registry,
        { repoRoot: "/repo", mode: "ask", ...input },
        {},
        config,
        harnesses,
      );
    expect(await probe({ paidBudget: ZERO })).toMatchObject({ diagnosticGeneration: "forbidden" });
    expect(statusAll).toHaveBeenLastCalledWith(
      { cwd: "/repo", diagnosticGeneration: "forbidden" },
      ["claude"],
    );
    expect(await probe({ paidBudget: UNLIMITED })).toMatchObject({
      diagnosticGeneration: "allowed",
    });
    expect(statusAll).toHaveBeenLastCalledWith({ cwd: "/repo", diagnosticGeneration: "allowed" }, [
      "claude",
    ]);
    // The same $0 beside any other mode or strategy keeps today's probes: Plan, Agent
    // and an Ask's separate Deep Scan sweep are untouched.
    for (const other of [
      { mode: "plan" },
      { mode: "agent" },
      { mode: "ask", deepScan: true },
    ] as const) {
      expect(await probe({ paidBudget: ZERO, ...other })).toMatchObject({
        diagnosticGeneration: "allowed",
      });
      expect(statusAll).toHaveBeenLastCalledWith(
        { cwd: "/repo", diagnosticGeneration: "allowed" },
        ["claude"],
      );
    }
    statusAll.mockClear();
    expect((await probe({}, ["codex"])).statuses).toEqual([]);
    expect(statusAll).not.toHaveBeenCalled();
  });

  it("the scoped route probe forwards a forbidden mode and adds nothing when allowed", async () => {
    const seen: DoctorSpec[] = [];
    const gateway = {
      routeStatus: async (_id: string, spec: DoctorSpec) => {
        seen.push(spec);
        return { id: "claude", status: "ok", manifest: { id: "claude" } } as never;
      },
    };
    const host = new Map([["claude", { id: "claude", status: "ok", manifest: {} } as never]]);
    const ctx = { cwd: "/scoped", env: {} } as never;
    await candidateStatusInRouteContext(gateway, ctx, "claude", "auto", host, "forbidden");
    await candidateStatusInRouteContext(gateway, ctx, "claude", "auto", host);
    expect(seen[0]).toMatchObject({
      cwd: "/scoped",
      fresh: true,
      diagnosticGeneration: "forbidden",
    });
    expect(seen[1]).not.toHaveProperty("diagnosticGeneration");
  });

  it("an exhausted run ledger forbids, and the contract's own ledger outranks later Settings", () => {
    const unlimitedSettings = GlobalConfig.parse({ budget: { paid_budget_per_run: UNLIMITED } });
    const zeroSettings = GlobalConfig.parse({ budget: { paid_budget_per_run: ZERO } });
    const spent = { remainingUsd: () => 0 };
    const open = { remainingUsd: () => null };
    const ask = { mode: "ask" } as const;
    expect(probeModeOf(ask, {}, unlimitedSettings, spent)).toBe("forbidden");
    expect(probeModeOf(ask, {}, zeroSettings, open)).toBe("allowed");
    expect(probeModeOf({ ...ask, paidBudget: ZERO }, {}, unlimitedSettings, open)).toBe(
      "forbidden",
    );
    expect(probeModeOf(ask, {}, zeroSettings)).toBe("forbidden");
    // A spent ledger or a $0 Settings value never reaches a Plan or an Agent run.
    expect(probeModeOf({ mode: "plan" }, {}, zeroSettings, spent)).toBe("allowed");
    expect(probeModeOf({ mode: "ask", deepScan: true }, {}, zeroSettings, spent)).toBe("allowed");
    expect(probeModeOf({ mode: "agent", paidBudget: ZERO }, {}, zeroSettings)).toBe("allowed");
  });

  it("route model preparation forwards exactly the mode the admission probed under", async () => {
    const calls: Array<string | undefined> = [];
    const adapter = {
      id: "fixture",
      prepareProcessing: async (spec: { diagnosticGeneration?: string }) => {
        calls.push(spec.diagnosticGeneration);
        return prepared;
      },
    } as unknown as HarnessAdapter;
    const config = GlobalConfig.parse({});
    const input = { repoRoot: "/repo" } as RunInput;
    const route = () =>
      ({
        adapter,
        quotaAdmission: { model: null, profile: null, route: null, profileVerification: null },
      }) as unknown as RoutedAdapter;
    // Never re-derived from the budget: a $0 Plan keeps its probes, and an Ask whose
    // inherited ledger is spent withholds them under an unlimited Settings budget.
    for (const [budget, mode] of [
      [ZERO, "forbidden"],
      [ZERO, "allowed"],
      [UNLIMITED, "allowed"],
      [UNLIMITED, "forbidden"],
    ] as const)
      await prepareRoutedProcessing([route()], input, "/repo", config, budget, undefined, mode);
    expect(calls).toEqual(["forbidden", "allowed", "allowed", "forbidden"]);
  });

  it("reads a prepared included class at $0 only on the lane's own proof, a named row's too", async () => {
    const included = {
      ...prepared,
      costBasis: { ...prepared.costBasis, kind: "included" as const },
    };
    const adapter = { id: "fixture", prepareProcessing: async () => included };
    const base = { model: null, profile: null, route: null, profileVerification: null };
    const lane = (admission: object) =>
      ({ adapter, quotaAdmission: { ...base, ...admission } }) as unknown as RoutedAdapter;
    const named = { profile: { profile_id: "acct" }, route: "vendor_native" };
    const kinds = async (budget: typeof ZERO | typeof UNLIMITED) => {
      // A local login file only, the vendor's own verdict, the verified native pin, no proof.
      const lanes = [
        lane({ ...named, profileVerification: "not_run" }),
        lane({ ...named, profileVerification: "passed" }),
        lane({ pinnedNative: true }),
        lane({}),
      ];
      const input = { repoRoot: "/repo" } as RunInput;
      // An ordinary Ask's admission withholds paid probes exactly at $0 here.
      const mode = budget.kind === "finite" ? "forbidden" : "allowed";
      const config = GlobalConfig.parse({});
      await prepareRoutedProcessing(lanes, input, "/repo", config, budget, undefined, mode);
      return lanes.map((l) => l.processing?.costBasis.kind);
    };
    expect(await kinds(ZERO)).toEqual(["unknown", "included", "included", "unknown"]);
    // Not vacuous: an Ask that may pay keeps every receipt's own class.
    expect(await kinds(UNLIMITED)).toEqual(["included", "included", "included", "included"]);
  });
});

describe("a withheld proof is not a missing route", () => {
  it("names each unproven harness's own reasons in the Auto refusal", () => {
    const config = GlobalConfig.parse({});
    const refusal = () =>
      resolveCandidateHarnessIds({
        config,
        registry: new Map([["claude", {} as HarnessAdapter]]),
        intent: "explain",
        statuses: [
          {
            id: "claude",
            status: "degraded",
            enabledIntents: [],
            reasons: [
              "Claude API-key verification not run: paid diagnostic generation is disabled",
            ],
          },
        ],
      });
    expect(refusal).toThrow(/no doctor-OK default route or enabled account row/);
    expect(refusal).toThrow(/claude: Claude API-key verification not run/);
  });

  it("advises the paid limit, not the paid doctor, when the mode is forbidden", () => {
    const statuses = [
      {
        id: "claude",
        status: "degraded" as const,
        enabledIntents: [],
        reasons: [`Claude setup-token ${DIAGNOSTIC_GENERATION_WITHHELD}`],
      },
    ];
    const messageOf = (diagnosticGeneration?: "forbidden") => {
      try {
        resolveCandidateHarnessIds({
          config: GlobalConfig.parse({}),
          registry: new Map([["claude", {} as HarnessAdapter]]),
          intent: "explain",
          statuses,
          ...(diagnosticGeneration ? { diagnosticGeneration } : {}),
        });
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    expect(messageOf("forbidden")).toMatch(/no paid budget remains for this Ask/);
    expect(messageOf("forbidden")).not.toMatch(/pass --harness explicitly/);
    expect(messageOf()).toMatch(/pass --harness explicitly/);
  });

  it("does not promise that raising the paid limit fixes a route no withheld proof explains", () => {
    let message = "";
    try {
      resolveCandidateHarnessIds({
        config: GlobalConfig.parse({}),
        registry: new Map([["claude", {} as HarnessAdapter]]),
        intent: "explain",
        statuses: [
          {
            id: "claude",
            status: "unavailable" as const,
            enabledIntents: [],
            reasons: ["claude CLI not found"],
          },
        ],
        diagnosticGeneration: "forbidden",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/claude CLI not found/);
    expect(message).toMatch(/pass --harness explicitly/);
    expect(message).not.toMatch(/raise the paid limit/);
  });
});

describe("a withheld-mode read-only Ask pins only a vendor-verified native session", () => {
  type Args = Parameters<typeof pinnedNativeAdmission>;
  const source = (name: string, verification: string) =>
    [{ source: name, availability: "available", verification, detail: "fixture" }] as never;
  const pin = (
    sources: Args[3],
    over: { mode?: Args[0]; profile?: Args[1]; route?: Args[2] } = {},
  ) =>
    pinnedNativeAdmission(
      over.mode ?? "forbidden",
      over.profile ?? null,
      over.route ?? "vendor_native",
      sources,
    );

  it("pins a verified native session on a read-only Ask", () => {
    expect(pin(source("native_session", "passed"))).toEqual({ pinnedNative: true });
  });

  it("never pins an unverified or non-native source, an allowed mode, an account row or another route", () => {
    expect(pin(source("oauth_token_env", "not_run"))).toEqual({});
    expect(pin(source("oauth_token_env", "passed"))).toEqual({});
    expect(pin(source("api_key_env", "passed"))).toEqual({});
    expect(pin(source("native_session", "not_run"))).toEqual({});
    const verified = source("native_session", "passed");
    expect(pin(verified, { mode: "allowed" })).toEqual({});
    expect(pin(verified, { route: "managed_api_key" })).toEqual({});
    expect(pin(verified, { profile: { profile_id: "acct" } as never })).toEqual({});
  });
});
