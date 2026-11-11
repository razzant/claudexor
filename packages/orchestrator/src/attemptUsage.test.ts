import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  attemptUsageCostSettlement,
  BudgetLedger,
  loadHarnessMetrics,
  recordHarnessMetric,
} from "@claudexor/budget";
import { processAttemptUsage } from "./attemptUsage.js";
import {
  AttemptPostStreamError,
  attemptFailureCost,
  attemptFailureRecord,
  newAttemptUsageCost,
  observeAttemptUsageEvent,
  settleGrantedAttemptLease,
  withAttemptFailureCost,
} from "./attemptUsageCost.js";
import { createAttemptTelemetry, observeAttemptTelemetry } from "./attemptTelemetry.js";
import { appliedAttemptFacts } from "./delegatedHome.js";
import { attemptTelemetryRecord } from "./attemptTelemetry.js";
import { recordCleanAttemptMetrics } from "./runSupport.js";
import { AttemptTelemetryRecord, HarnessEvent } from "@claudexor/schema";

const usageEvent = (estimated: boolean) =>
  ({
    type: "usage",
    session_id: "s",
    ts: new Date().toISOString(),
    usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0.37, estimated },
  }) as const;

describe("a clean attempt's routing cost sample (#171)", () => {
  const configDirs: string[] = [];
  afterAll(() => configDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })), 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)
  const NO_DEBIT = {
    nativeMode: null,
    kind: "included" as const,
    source: "fixture.allowance",
    debit: "unobserved" as const,
  };
  const frame = (type: string, route: "vendor_native" | "managed_api_key", extra: object = {}) =>
    HarnessEvent.parse({
      type,
      session_id: "s",
      ts: "2026-11-02T00:00:00.000Z",
      credential_route: route,
      ...extra,
    });
  const interval = (route: "vendor_native" | "managed_api_key", extra: object = {}) => [
    frame("started", route, extra),
    frame("completed", route, extra),
  ];
  const paidUsage = (usage: object) => [
    frame("started", "managed_api_key"),
    frame("usage", "managed_api_key", { usage }),
    frame("completed", "managed_api_key"),
  ];
  /** The average after a seeded 0.4 and one clean attempt over these real frames. */
  function averageAfter(frames: HarnessEvent[], outcome = { errored: false, aborted: false }) {
    const configDir = mkdtempSync(join(tmpdir(), "claudexor-routing-sample-"));
    configDirs.push(configDir);
    recordHarnessMetric(configDir, "h", { costUsd: 0.4 });
    const telemetry = createAttemptTelemetry("auto", false);
    let cost = 0;
    for (const event of frames) {
      observeAttemptTelemetry(telemetry, event);
      if (event.type === "usage")
        cost = processAttemptUsage({
          event,
          telemetry,
          harnessId: "h",
          attemptId: "a01",
          cost,
          costEstimated: false,
          cancel: vi.fn(),
        }).cost;
    }
    recordCleanAttemptMetrics(configDir, "h", {
      costUsd: cost,
      usageCost: telemetry.usageCost,
      streamMs: 5,
      authMode: telemetry.authMode,
      ...outcome,
    });
    return loadHarnessMetrics(configDir)["h"]?.avg_cost_usd;
  }
  const moved = (sample: number) => 0.4 * 0.7 + sample * 0.3;

  it.each([
    ["an exact cash receipt of zero", paidUsage({ cost_usd: 0 }), moved(0)],
    ["an estimated cash receipt of zero", paidUsage({ cost_usd: 0, estimated: true }), moved(0)],
    ["ordinary positive cash", paidUsage({ cost_usd: 0.25 }), moved(0.25)],
    ["an API route that reported no amount", paidUsage({ input_tokens: 1 }), null],
    [
      "a zero valuation",
      [
        frame("started", "vendor_native"),
        frame("usage", "vendor_native", { usage: { cost_usd: 0 } }),
        frame("completed", "vendor_native"),
      ],
      null,
    ],
    ["ordinary included work with no amount", interval("vendor_native"), null],
    [
      "included work with no debit and no amount",
      interval("vendor_native", { processing_cost_basis: NO_DEBIT }),
      null,
    ],
    [
      "a zero receipt after an unpriced paid interval",
      [...interval("managed_api_key"), ...paidUsage({ cost_usd: 0 })],
      null,
    ],
    [
      "a zero receipt after included work whose debit is unobserved",
      [
        ...interval("vendor_native", { processing_cost_basis: NO_DEBIT }),
        ...paidUsage({ cost_usd: 0 }),
      ],
      null,
    ],
  ])("%s", (_label, frames, expected) => {
    const average = averageAfter(frames);
    if (expected === null) expect(average).toBeNull();
    else expect(average).toBeCloseTo(expected, 10);
  });

  it.each([
    { errored: true, aborted: false },
    { errored: false, aborted: true },
  ])("leaves the average alone when the attempt is not clean: %o", (outcome) => {
    expect(averageAfter(paidUsage({ cost_usd: 0 }), outcome)).toBe(0.4);
  });
});

describe("processAttemptUsage", () => {
  it.each(["included", "paid_credits"] as const)(
    "keeps %s processing unknown amount honest in stream guard, settlement and telemetry",
    (kind) => {
      const telemetry = createAttemptTelemetry("auto", false);
      const mode = kind === "included" ? "standard" : "fast";
      const common = {
        session_id: "s",
        ts: new Date().toISOString(),
        credential_route: "vendor_native" as const,
        processing: {
          requested: mode,
          submitted: mode,
          submittedNative: mode,
          observed: "unknown",
          observedNative: [],
          reason: null,
          source: "fixture",
        },
        processing_cost_basis: { kind, nativeMode: mode, source: "fixture" },
      };
      observeAttemptTelemetry(telemetry, HarnessEvent.parse({ ...common, type: "started" }));
      const usage = HarnessEvent.parse({
        ...common,
        type: "usage",
        usage: {
          cost_usd: 2,
          cost_basis: { kind: "unknown", source: "native-scalar-without-proof" },
        },
      });
      observeAttemptTelemetry(telemetry, usage);
      const guard = vi.fn(() => true),
        cancel = vi.fn();
      const streamed = processAttemptUsage({
        event: usage,
        telemetry,
        harnessId: "claude",
        attemptId: "a",
        cost: 0,
        costEstimated: false,
        budgetGuard: guard,
        cancel,
      });
      expect(streamed.hardCapReached).toBe(kind === "paid_credits");
      expect(cancel).toHaveBeenCalledTimes(kind === "paid_credits" ? 1 : 0);
      observeAttemptTelemetry(telemetry, HarnessEvent.parse({ ...common, type: "completed" }));
      const stored = AttemptTelemetryRecord.parse(
        JSON.parse(JSON.stringify(attemptTelemetryRecord("a", "claude", telemetry))),
      );
      expect(stored.usage_cost).toEqual({
        cashUsd: 0,
        valuationUsd: 0,
        unknownUsd: 2,
        cashKnowledge: kind === "included" ? "exact" : "unknown",
        valuationKnowledge: "unknown",
      });
      const settlement = attemptUsageCostSettlement(
        2,
        false,
        "a",
        "claude",
        "local_session",
        telemetry.usageCost,
      );
      expect(settlement.cashUsd).toBe(0);
      expect(settlement.cashKnowledge).toBe(kind === "included" ? "exact" : "unknown");
    },
  );
  it("carries route-specific settlement when post-stream persistence throws", () => {
    const settlement = attemptUsageCostSettlement(1, false, "a01", "claude", "local_session", {
      cashUsd: 0.25,
      valuationUsd: 0.75,
      unknownUsd: 0,
      cashKnowledge: "exact",
      valuationKnowledge: "estimated",
    });

    const error = (() => {
      try {
        withAttemptFailureCost(
          () => {
            throw new Error("artifact persistence failed");
          },
          { totalUsd: 1, estimated: true, settlement },
        );
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(AttemptPostStreamError);
    expect((error as AttemptPostStreamError).attemptCost).toMatchObject({
      totalUsd: 1,
      estimated: true,
      settlement: {
        cashUsd: 0.25,
        valuationUsd: 0.75,
        cashKnowledge: "exact",
        valuationKnowledge: "estimated",
      },
    });

    for (const source of ["attempt-error", "continuation-error", "synthesis-error"]) {
      expect(attemptFailureCost(error, source).settlement).toBe(settlement);
    }
  });

  it("keeps ordinary pre-stream failure fallbacks unknown", () => {
    expect(attemptFailureCost(new Error("setup failed"), "attempt-error")).toMatchObject({
      totalUsd: 0,
      settlement: { knowledge: "unknown", source: "attempt-error" },
    });
    expect(attemptFailureCost({ costUsd: 0.4 }, "post-stream-error", 0)).toMatchObject({
      totalUsd: 0.4,
      estimated: true,
      settlement: { knowledge: "unknown", source: "post-stream-error", cashUsd: 0.4 },
    });
    expect(attemptFailureCost({ costUsd: 0 }, "post-stream-error")).toMatchObject({
      totalUsd: 0,
      estimated: false,
      settlement: { knowledge: "unknown", source: "post-stream-error", cashUsd: 0 },
    });
    expect(attemptFailureCost({ costUsd: Number.NaN }, "post-stream-error")).toMatchObject({
      totalUsd: 0,
      estimated: false,
      settlement: { knowledge: "unknown", source: "post-stream-error" },
    });
    expect(
      attemptFailureRecord(
        "a01",
        "claude",
        attemptFailureCost({ costUsd: 0.4 }, "post-stream-error"),
        "harness",
        "redacted failure",
        appliedAttemptFacts(
          {
            isolated: true,
            homeDir: "/scoped",
            outerBoundaryUnavailableReason: null,
          },
          "workspace_write",
          "prof-1",
        ),
      ),
    ).toEqual({
      attempt_id: "a01",
      harness_id: "claude",
      cost_usd: 0.4,
      cost_estimated: true,
      errored: true,
      phase: "harness",
      errors: ["redacted failure"],
      // A failed attempt still states what it ran under; the success record
      // carries the SAME block.
      harness_home_isolated: true,
      harness_home_dir: "/scoped",
      access_applied: "workspace_write",
      credential_profile_applied: "prof-1",
      confinement_mechanism: null,
      confinement_profile_digest: null,
      confinement_verified_denied_path: null,
      confinement_unavailable_reason: null,
    });
  });

  it("releases a granted lease on a pre-stream failure without inventing exact-zero cost", () => {
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    const first = ledger.reserve({
      taskId: "task",
      attemptId: "p01",
      intent: "plan",
      harnessId: "claude",
    });
    expect(first.granted).toBe(true);
    settleGrantedAttemptLease({
      ledger,
      leaseId: first.lease?.lease_id ?? "",
      attemptId: "p01",
      harnessId: "claude",
      costUsd: 0,
      costEstimated: false,
      preStreamFailureSource: "planner-pre-stream",
    });
    const second = ledger.reserve({
      taskId: "task",
      attemptId: "p02",
      intent: "plan",
      harnessId: "claude",
    });
    expect(second.granted).toBe(true);
  });

  it("splits usage by each event route when a retry changes auth", () => {
    const telemetry = createAttemptTelemetry("auto", false);
    observeAttemptTelemetry(telemetry, {
      ...usageEvent(false),
      credential_route: "vendor_native",
      usage: { cost_usd: 0.75, estimated: true },
    });
    observeAttemptTelemetry(telemetry, {
      ...usageEvent(false),
      credential_route: "managed_api_key",
      usage: { cost_usd: 0.25 },
    });
    expect(telemetry.authMode).toBe("local_session");
    expect(telemetry.currentAuthMode).toBe("api_key");
    expect(telemetry.usageCost).toEqual({
      cashUsd: 0.25,
      valuationUsd: 0.75,
      unknownUsd: 0,
      cashEstimated: false,
      valuationEstimated: true,
    });
  });

  it("does not turn a pre-start API fallback disclosure into an unpaid interval", () => {
    const telemetry = createAttemptTelemetry("auto", false);
    const ts = new Date().toISOString();
    observeAttemptTelemetry(telemetry, {
      type: "message",
      session_id: "s",
      ts,
      text: "switching route",
      payload: { auth_switched: true, to_auth_mode: "api_key" },
    });
    observeAttemptTelemetry(telemetry, {
      type: "started",
      session_id: "s",
      ts,
      credential_route: "managed_api_key",
    });
    observeAttemptTelemetry(telemetry, {
      ...usageEvent(false),
      credential_route: "managed_api_key",
    });
    observeAttemptTelemetry(telemetry, { type: "completed", session_id: "s", ts });

    expect(telemetry.usageCost.cashKnowledge).toBe("exact");
    expect(telemetry.usageCost.cashUsd).toBe(0.37);
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 1.5 });
    const lease = ledger.reserve({
      taskId: "pre-start-api-fallback",
      intent: "explain",
      harnessId: "claude",
    }).lease!;
    ledger.settle(
      lease.lease_id,
      attemptUsageCostSettlement(
        0.37,
        false,
        "a01",
        "claude",
        telemetry.authMode,
        telemetry.usageCost,
      ),
    );
    expect(ledger.spend()).toBe(0.37);
    expect(ledger.terminal()).toBeNull();
  });

  it("settles an explicit zero-cost managed API receipt with exact cash knowledge", () => {
    const usageCost = newAttemptUsageCost();
    const ts = new Date().toISOString();
    let authMode: "local_session" | "api_key" | null = null;

    authMode = observeAttemptUsageEvent(
      usageCost,
      {
        type: "started",
        session_id: "s",
        ts,
        credential_route: "managed_api_key",
      },
      authMode,
    );
    authMode = observeAttemptUsageEvent(
      usageCost,
      {
        type: "usage",
        session_id: "s",
        ts,
        credential_route: "managed_api_key",
        usage: { cost_usd: 0 },
      },
      authMode,
    );
    authMode = observeAttemptUsageEvent(
      usageCost,
      { type: "completed", session_id: "s", ts },
      authMode,
    );

    expect(usageCost.cashUsd).toBe(0);
    expect(usageCost.cashEstimated).toBe(false);
    expect(usageCost.cashKnowledge).toBe("exact");

    const settlement = attemptUsageCostSettlement(0, false, "a01", "raw-api", authMode, usageCost);
    expect(settlement.cashUsd).toBe(0);
    expect(settlement.cashKnowledge).toBe("exact");

    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    const lease = ledger.reserve({
      taskId: "exact-zero-api-receipt",
      intent: "explain",
      harnessId: "raw-api",
    }).lease!;
    ledger.settle(lease.lease_id, settlement);

    expect(ledger.spend()).toBe(0);
    expect(ledger.terminal()).toBeNull();
  });

  it("keeps a real API interval without usage unresolved across a later retry", () => {
    const telemetry = createAttemptTelemetry("auto", false);
    const ts = new Date().toISOString();
    observeAttemptTelemetry(telemetry, {
      type: "message",
      session_id: "s",
      ts,
      text: "switching route",
      payload: { auth_switched: true, to_auth_mode: "api_key" },
    });
    observeAttemptTelemetry(telemetry, {
      type: "started",
      session_id: "s",
      ts,
      credential_route: "managed_api_key",
    });
    observeAttemptTelemetry(telemetry, { type: "completed", session_id: "s", ts });
    observeAttemptTelemetry(telemetry, {
      type: "started",
      session_id: "s",
      ts,
      credential_route: "managed_api_key",
    });
    observeAttemptTelemetry(telemetry, {
      ...usageEvent(false),
      credential_route: "managed_api_key",
    });
    observeAttemptTelemetry(telemetry, { type: "completed", session_id: "s", ts });

    expect(telemetry.usageCost.cashKnowledge).toBe("unknown");
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 1.5 });
    const lease = ledger.reserve({
      taskId: "missing-first-api-receipt",
      intent: "explain",
      harnessId: "claude",
    }).lease!;
    ledger.settle(
      lease.lease_id,
      attemptUsageCostSettlement(
        0.37,
        false,
        "a01",
        "claude",
        telemetry.authMode,
        telemetry.usageCost,
      ),
    );
    expect(ledger.spend()).toBe(0.37);
    expect(ledger.terminal()).toBe("cost_unverifiable");
  });

  it("keeps native completion separate from a paid retry with a pre-start fallback", () => {
    const telemetry = createAttemptTelemetry("auto", false);
    const ts = new Date().toISOString();
    observeAttemptTelemetry(telemetry, {
      type: "started",
      session_id: "s",
      ts,
      credential_route: "vendor_native",
    });
    observeAttemptTelemetry(telemetry, { type: "completed", session_id: "s", ts });
    observeAttemptTelemetry(telemetry, {
      type: "message",
      session_id: "s",
      ts,
      text: "switching route",
      payload: { auth_switched: true, to_auth_mode: "api_key" },
    });
    observeAttemptTelemetry(telemetry, {
      type: "started",
      session_id: "s",
      ts,
      credential_route: "managed_api_key",
    });
    observeAttemptTelemetry(telemetry, {
      ...usageEvent(false),
      credential_route: "managed_api_key",
    });
    observeAttemptTelemetry(telemetry, { type: "completed", session_id: "s", ts });

    expect(telemetry.usageCost.cashKnowledge).toBe("exact");
    expect(telemetry.usageCost.cashUsd).toBe(0.37);
  });

  it("fails cash certainty closed when a native attempt switches to API without usage", () => {
    const telemetry = createAttemptTelemetry("auto", false);
    const ts = new Date().toISOString();
    observeAttemptTelemetry(telemetry, {
      type: "started",
      session_id: "s",
      ts,
      credential_route: "vendor_native",
    });
    observeAttemptTelemetry(telemetry, {
      type: "usage",
      session_id: "s",
      ts,
      credential_route: "vendor_native",
      usage: { cost_usd: 0.75, estimated: true },
    });
    observeAttemptTelemetry(telemetry, {
      type: "message",
      session_id: "s",
      ts,
      text: "switching route",
      payload: { auth_switched: true, to_auth_mode: "api_key" },
    });
    observeAttemptTelemetry(telemetry, { type: "completed", session_id: "s", ts });

    expect(telemetry.usageCost.cashKnowledge).toBe("unknown");
    expect(telemetry.usageCost.valuationKnowledge).toBe("estimated");
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    const lease = ledger.reserve({
      taskId: "mixed-no-api-usage",
      intent: "implement",
      harnessId: "claude",
    }).lease!;
    ledger.settle(
      lease.lease_id,
      attemptUsageCostSettlement(
        0.75,
        true,
        "a01",
        "claude",
        telemetry.authMode,
        telemetry.usageCost,
      ),
    );
    expect(ledger.spend()).toBe(0);
    expect(ledger.valuation()).toBe(0.75);
    expect(ledger.terminal()).toBe("cost_unverifiable");
  });

  it("never trips the cash guard for exact or estimated native subscription valuation", () => {
    for (const estimated of [false, true]) {
      const guard = vi.fn(() => true);
      const cancel = vi.fn();
      const result = processAttemptUsage({
        event: usageEvent(estimated),
        telemetry: {
          usageCost: {
            cashUsd: 0,
            valuationUsd: 0.37,
            unknownUsd: 0,
            cashEstimated: false,
            valuationEstimated: estimated,
          },
        },
        harnessId: "claude",
        attemptId: "a01",
        cost: 0,
        costEstimated: false,
        budgetGuard: guard,
        cancel,
      });
      expect(result).toMatchObject({
        cost: 0.37,
        costEstimated: estimated,
        hardCapReached: false,
      });
      expect(guard).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
    }
  });

  it("discloses a reported zero with its status but never consults the cap guard (#171)", () => {
    const telemetry = createAttemptTelemetry("auto", false);
    const zero = (estimated: boolean) =>
      HarnessEvent.parse({
        ...usageEvent(estimated),
        credential_route: "managed_api_key",
        usage: { cost_usd: 0, estimated },
      });
    for (const event of [
      { type: "started", session_id: "s", ts: "2026-11-02T00:00:00.000Z" },
      {
        ...usageEvent(false),
        credential_route: "managed_api_key",
        usage: { cost_usd: 0.25, estimated: false },
      },
      zero(true),
    ])
      observeAttemptTelemetry(telemetry, HarnessEvent.parse(event));
    const guard = vi.fn(() => true);
    const cancel = vi.fn();
    const emitted: Array<Record<string, unknown>> = [];
    const result = processAttemptUsage({
      event: zero(true),
      telemetry,
      harnessId: "raw-api",
      attemptId: "a01",
      cost: 0.25,
      costEstimated: false,
      emit: (_type, payload) => emitted.push(payload),
      budgetGuard: guard,
      cancel,
    });
    expect(result).toEqual({ cost: 0.25, costEstimated: true, hardCapReached: false });
    expect(guard).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(emitted).toEqual([
      {
        harness_id: "raw-api",
        attempt_id: "a01",
        kind: "spend",
        usd: 0,
        estimated: true,
        amount_kind: "cash",
      },
    ]);
  });

  it("emits nothing and leaves the status alone when no amount was reported (#171)", () => {
    const guard = vi.fn(() => true);
    const emit = vi.fn();
    const result = processAttemptUsage({
      event: { ...usageEvent(true), usage: { input_tokens: 1, estimated: true } },
      telemetry: createAttemptTelemetry("auto", false),
      harnessId: "raw-api",
      attemptId: "a01",
      cost: 0,
      costEstimated: false,
      emit,
      budgetGuard: guard,
      cancel: vi.fn(),
    });
    expect(result).toEqual({ cost: 0, costEstimated: false, hardCapReached: false });
    expect(emit).not.toHaveBeenCalled();
    expect(guard).not.toHaveBeenCalled();
  });

  it("trips the guard and cancels metered API usage", () => {
    const cancel = vi.fn();
    const emitted: string[] = [];
    const result = processAttemptUsage({
      event: usageEvent(false),
      telemetry: {
        usageCost: {
          cashUsd: 0.37,
          valuationUsd: 0,
          unknownUsd: 0,
          cashEstimated: false,
          valuationEstimated: false,
        },
      },
      harnessId: "claude",
      attemptId: "a01",
      cost: 0,
      costEstimated: false,
      budgetGuard: () => true,
      cancel,
      emit: (type) => emitted.push(type),
    });
    expect(result.hardCapReached).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(emitted).toEqual(["budget.observation", "budget.observation"]);
  });
});
