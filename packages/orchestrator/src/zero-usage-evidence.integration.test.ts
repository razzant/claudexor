import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import {
  BudgetLedger,
  loadHarnessMetrics,
  recordHarnessMetric,
  type BudgetSettlement,
} from "@claudexor/budget";
import type { HarnessAdapter } from "@claudexor/core";
import type { ReviewerSpec } from "@claudexor/review";
import {
  ConformanceReport,
  DecisionRecord,
  HarnessManifest,
  HarnessRunSpec,
  RunTelemetry,
  type HarnessEvent,
  type PaidBudget,
  type ProcessingCostBasis,
} from "@claudexor/schema";
import { budgetSnapshot } from "../../control-api/src/run-budget-snapshot.js";
import { COMPLETE_INTEGRITY } from "../../control-api/src/run-timeline.js";
import { createRawApiAdapter } from "../../harness-raw-api/src/index.js";
import { Orchestrator, type RunInput } from "./orchestrator.js";

/**
 * #171: a usage event's reported amount, zero included, is evidence distinct
 * from its size. These runs go through the real lanes, ledger, metrics file and
 * control-API projection, so a positive-amount gate anywhere between the adapter
 * stream and the reader shows up as a difference between runs that differ only in
 * whether `cost_usd` was reported. Every scenario runs through the read-only lane;
 * the other lanes share its owners, so each proves it reaches them with a zero and
 * an absent amount.
 */

type Knowledge = "exact" | "estimated" | "unknown";
type Route = "vendor_native" | "managed_api_key";
type Frame = Omit<HarnessEvent, "session_id" | "ts">;
interface RawEvent {
  type: string;
  payload: Record<string, unknown>;
}

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "claudexor-zero-usage-"));
  roots.push(dir);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  execFileSync("git", ["-C", dir, "add", "README.md"]);
  execFileSync("git", [
    "-C",
    dir,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "base",
  ]);
  return dir;
}

/** Frames for every dispatch, or for each dispatch by its 1-based order (a real
 * retry or another attempt is the next dispatch). */
type Script = readonly Frame[] | ((dispatch: number) => readonly Frame[]);

/** Every lane reads the same frames; only an implementing attempt also writes. */
function scripted(id: string, script: Script, onRun?: () => void): HarnessAdapter {
  let dispatches = 0;
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "openai",
        capabilities: {
          plan: true,
          implement: true,
          synthesize: true,
          read_files: true,
          web_policy: "tools",
        },
        access_profiles_supported: ["readonly", "workspace_write", "full"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["explain", "audit", "plan", "implement", "synthesize"],
      });
    },
    async *run(spec) {
      onRun?.();
      dispatches += 1;
      if (spec.intent === "implement") writeFileSync(join(spec.cwd, "CHANGED.txt"), "change\n");
      const frames = typeof script === "function" ? script(dispatches) : script;
      for (const frame of frames)
        yield { ...frame, session_id: spec.session_id, ts: new Date().toISOString() } as never;
    },
  };
}

function interval(
  route: Route,
  usage: NonNullable<HarnessEvent["usage"]>,
  basis?: ProcessingCostBasis,
): Frame[] {
  const common = {
    credential_route: route,
    ...(basis ? { processing_cost_basis: basis } : {}),
  };
  return [
    { ...common, type: "started" },
    { ...common, type: "message", text: "# Report\n\nDone.", final: true },
    { ...common, type: "usage", usage },
    { ...common, type: "completed" },
  ];
}

const LANES = {
  agent: { input: { mode: "agent", review: false } as Partial<RunInput>, attempts: 1 },
  ask: { input: { mode: "ask" } as Partial<RunInput>, attempts: 1 },
  plan: { input: { mode: "plan" } as Partial<RunInput>, attempts: 1 },
  // Two scouts plus the reducer's fixed `synth` attempt.
  "deep scan": { input: { mode: "ask", deepScan: true, n: 2 } as Partial<RunInput>, attempts: 3 },
} as const;
type Lane = keyof typeof LANES;

const SEEDED_METRIC = 0.4;
const ema = (sample: number) => SEEDED_METRIC * 0.7 + sample * 0.3;
/** Real worktrees and several attempts: generous like the suite's own hang detector. */
const RUN_TIMEOUT_MS = 180_000;

async function run(
  lane: Lane,
  id: string,
  frames: Script,
  options: {
    paidBudget?: PaidBudget;
    reviewers?: ReviewerSpec[];
    input?: Partial<RunInput>;
    keepMetric?: boolean;
  } = {},
) {
  const root = repo();
  const configDir = process.env.CLAUDEXOR_CONFIG_DIR!;
  if (!options.keepMetric) recordHarnessMetric(configDir, id, { costUsd: SEEDED_METRIC });
  const settle = vi.spyOn(BudgetLedger.prototype, "settle");
  settle.mockClear();
  const paidBudget = options.paidBudget ?? { kind: "unlimited" as const };
  let dispatched = 0;
  const result = await new Orchestrator({
    registry: new Map([[id, scripted(id, frames, () => (dispatched += 1))]]),
    reviewers: options.reviewers ?? [],
  }).run({
    repoRoot: root,
    prompt: "Do the work",
    harnesses: [id],
    paidBudget,
    ...LANES[lane].input,
    ...options.input,
  } as RunInput);
  const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RawEvent);
  const decisionPath = join(result.runDir, "arbitration", "decision.yaml");
  const store = new ArtifactStore(root);
  const decision = existsSync(decisionPath)
    ? DecisionRecord.parse(store.readYaml(decisionPath))
    : null;
  const record = {
    id: result.runId,
    state: "completed",
    runId: result.runId,
    runDir: result.runDir,
    params: { paidBudget },
  };
  const firstCash = events.findIndex((event) => event.type === "budget.cash");
  /** The live control-API reading once the run had written its first `count` events. */
  const at = (count: number) =>
    budgetSnapshot(record, null, events.slice(0, count) as never, COMPLETE_INTEGRITY);
  return {
    result,
    dispatched,
    events,
    at,
    /** Events written before the first settlement (all of them if none settled). */
    beforeSettlement: firstCash === -1 ? events.length : firstCash,
    /** Settlements the real lane handed to the real ledger. */
    settlements: settle.mock.calls.map((call) => call[1]),
    spendRows: events.filter(isSpendRow).map((event) => event.payload),
    /** The control-API reading the moment before the first settlement. */
    live: at(firstCash === -1 ? events.length : firstCash),
    /** The control-API reading of the finished run, through the real event fold. */
    terminal: budgetSnapshot(record, decision),
    metric: loadHarnessMetrics(configDir)[id]?.avg_cost_usd,
    routing: () =>
      RunTelemetry.parse(store.readYaml(join(result.runDir, "final", "telemetry.yaml")))
        .routing_rationale,
    attemptRecord: (attemptId: string) =>
      store.readYaml<Record<string, unknown>>(
        join(result.runDir, "attempts", attemptId, "attempt.yaml"),
      ),
  };
}

type Outcome = Awaited<ReturnType<typeof run>>;

const isSpendRow = (event: RawEvent) =>
  event.type === "budget.observation" && event.payload["kind"] === "spend";
const isHarness = (type: string) => (event: RawEvent) =>
  event.type === "harness.event" && event.payload["type"] === type;

/** Index of the `nth` (1-based) event matching `match`, or -1. */
function nth(events: readonly RawEvent[], match: (event: RawEvent) => boolean, n = 1): number {
  let seen = 0;
  return events.findIndex((event) => match(event) && ++seen === n);
}

/** Before any settlement the live reading is an estimate: it never states an
 * exact total, a known valuation from a zero, or the ledger's certainty, at any
 * event the run wrote, whatever reported zeros arrived. */
function expectEstimatesBeforeSettlement(outcome: Outcome): void {
  for (let count = 1; count <= outcome.beforeSettlement; count++) {
    const reading = outcome.at(count);
    const where = `after event ${count} (${outcome.events[count - 1]!.type})`;
    expect(reading.cashKnowledge, where).toBeUndefined();
    if (reading.spendUsd !== null) expect(reading.estimated, where).toBe(true);
    expect(reading.valuationKnowledge, where).not.toBe("exact");
    if (reading.valuationUsd !== null) expect(reading.valuationUsd, where).toBeGreaterThan(0);
  }
}

/** From the first settlement on, the reading after every event is exactly the
 * latest settlement's cumulative ledger disclosure, as before #171: a clean zero
 * is exact there, an unpriced try unknown, and a later row changes nothing. */
function expectEachSettlementReadsItsLedger(outcome: Outcome): void {
  let latest: Record<string, unknown> | null = null;
  outcome.events.forEach((event, index) => {
    if (event.type === "budget.cash") latest = event.payload;
    if (!latest) return;
    const cash: Record<string, unknown> = latest;
    expect(outcome.at(index + 1), `after event ${index + 1} (${event.type})`).toMatchObject({
      cashKnowledge: cash["cash_knowledge"],
      spendUsd: cash["cash_knowledge"] === "unknown" ? null : cash["cash_spend_usd"],
      estimated: cash["cash_knowledge"] !== "exact",
      valuationKnowledge: cash["valuation_knowledge"],
      valuationUsd: cash["valuation_knowledge"] === "unknown" ? null : cash["valuation_usd"],
    });
  });
}

const withoutProvenance = ({ provenance: _provenance, ...rest }: BudgetSettlement) => rest;

const TOKENS_ONLY = { input_tokens: 3, output_tokens: 2 };
const NO_DEBIT: ProcessingCostBasis = {
  nativeMode: null,
  kind: "included",
  source: "fixture.allowance",
  debit: "unobserved",
};
const PAID_CREDITS: ProcessingCostBasis = {
  nativeMode: "fast",
  kind: "paid_credits",
  source: "fixture.credits",
};

interface Scenario {
  name: string;
  route: Route;
  usage: NonNullable<HarnessEvent["usage"]>;
  basis?: ProcessingCostBasis;
  /** The attempt's one spend row; null when the event reported no amount. */
  row: { usd: number; estimated: boolean; amount_kind: "cash" | "valuation" | "unknown" } | null;
  settlement: Omit<BudgetSettlement, "provenance">;
  /** The reading just before the first settlement: an estimate, never exact. */
  live: {
    spendUsd: number | null;
    estimated: boolean;
    valuationUsd: number | null;
    valuationKnowledge: Knowledge;
  };
  terminal: {
    spendUsd: number | null;
    controllableSpendUsd: number | null;
    estimated: boolean;
    valuationUsd: number | null;
    valuationKnowledge: Knowledge;
    cashKnowledge: Knowledge;
  };
  /** The routing average after a seeded 0.4 and one clean candidate attempt. */
  metric: number | null;
  costEstimated: boolean;
}

const BY_ROUTE = "harness-usage-by-route";
const MISSING = "harness-route-usage-missing";
const NO_VALUATION = { valuationUsd: null, valuationKnowledge: "unknown" as const };

const ABSENT: Scenario = {
  name: "an absent amount on an API route",
  route: "managed_api_key",
  usage: TOKENS_ONLY,
  row: null,
  settlement: { knowledge: "unknown", cashKnowledge: "unknown", source: MISSING, cashUsd: 0 },
  live: { spendUsd: null, estimated: false, ...NO_VALUATION },
  terminal: {
    spendUsd: null,
    controllableSpendUsd: null,
    estimated: true,
    ...NO_VALUATION,
    cashKnowledge: "unknown",
  },
  metric: null,
  costEstimated: false,
};
const CASH_ZERO: Scenario = {
  name: "an exact cash zero",
  route: "managed_api_key",
  usage: { ...TOKENS_ONLY, cost_usd: 0 },
  row: { usd: 0, estimated: false, amount_kind: "cash" },
  settlement: { knowledge: "exact", cashKnowledge: "exact", source: BY_ROUTE, cashUsd: 0 },
  live: { spendUsd: 0, estimated: true, ...NO_VALUATION },
  terminal: {
    spendUsd: 0,
    controllableSpendUsd: 0,
    estimated: false,
    ...NO_VALUATION,
    cashKnowledge: "exact",
  },
  metric: ema(0),
  costEstimated: false,
};
const ESTIMATED_CASH_ZERO: Scenario = {
  name: "an estimated cash zero",
  route: "managed_api_key",
  usage: { ...TOKENS_ONLY, cost_usd: 0, estimated: true },
  row: { usd: 0, estimated: true, amount_kind: "cash" },
  settlement: {
    knowledge: "estimated",
    cashKnowledge: "estimated",
    source: BY_ROUTE,
    cashUsd: 0,
  },
  live: { spendUsd: 0, estimated: true, ...NO_VALUATION },
  terminal: {
    spendUsd: 0,
    controllableSpendUsd: 0,
    estimated: true,
    ...NO_VALUATION,
    cashKnowledge: "estimated",
  },
  metric: ema(0),
  costEstimated: true,
};
const VALUATION_ZERO: Scenario = {
  name: "an exact valuation zero",
  route: "vendor_native",
  usage: { ...TOKENS_ONLY, cost_usd: 0 },
  row: { usd: 0, estimated: false, amount_kind: "valuation" },
  settlement: {
    knowledge: "exact",
    cashKnowledge: "exact",
    valuationKnowledge: "exact",
    source: BY_ROUTE,
    cashUsd: 0,
    valuationUsd: 0,
  },
  live: { spendUsd: 0, estimated: true, ...NO_VALUATION },
  terminal: {
    spendUsd: 0,
    controllableSpendUsd: 0,
    estimated: false,
    valuationUsd: 0,
    valuationKnowledge: "exact",
    cashKnowledge: "exact",
  },
  // A zero valuation is not a cash receipt, so it cannot read as a free route.
  metric: null,
  costEstimated: false,
};
const ESTIMATED_VALUATION_ZERO: Scenario = {
  name: "an estimated valuation zero",
  route: "vendor_native",
  usage: { ...TOKENS_ONLY, cost_usd: 0, estimated: true },
  row: { usd: 0, estimated: true, amount_kind: "valuation" },
  settlement: {
    knowledge: "estimated",
    cashKnowledge: "exact",
    valuationKnowledge: "estimated",
    source: BY_ROUTE,
    cashUsd: 0,
    valuationUsd: 0,
  },
  live: { spendUsd: 0, estimated: true, ...NO_VALUATION },
  terminal: {
    spendUsd: 0,
    controllableSpendUsd: 0,
    estimated: false,
    valuationUsd: 0,
    valuationKnowledge: "estimated",
    cashKnowledge: "exact",
  },
  metric: null,
  costEstimated: true,
};
const INCLUDED_NO_AMOUNT: Scenario = {
  name: "included work reporting no amount and no debit",
  route: "vendor_native",
  usage: TOKENS_ONLY,
  basis: NO_DEBIT,
  row: null,
  // Known controllable cash is not a receipt: nothing was reported.
  settlement: {
    knowledge: "exact",
    cashKnowledge: "exact",
    allowanceDebitUnobserved: true,
    source: MISSING,
    cashUsd: 0,
  },
  live: { spendUsd: null, estimated: false, ...NO_VALUATION },
  terminal: {
    spendUsd: null,
    controllableSpendUsd: 0,
    estimated: true,
    ...NO_VALUATION,
    cashKnowledge: "unknown",
  },
  metric: null,
  costEstimated: false,
};
const INCLUDED_VALUATION_ZERO: Scenario = {
  name: "included work reporting a zero valuation and no debit",
  route: "vendor_native",
  usage: { ...TOKENS_ONLY, cost_usd: 0, cost_basis: { kind: "valuation", source: "fixture" } },
  basis: NO_DEBIT,
  row: { usd: 0, estimated: false, amount_kind: "valuation" },
  settlement: {
    knowledge: "exact",
    cashKnowledge: "exact",
    allowanceDebitUnobserved: true,
    valuationKnowledge: "exact",
    source: BY_ROUTE,
    cashUsd: 0,
    valuationUsd: 0,
  },
  live: { spendUsd: 0, estimated: true, ...NO_VALUATION },
  terminal: {
    spendUsd: null,
    controllableSpendUsd: 0,
    estimated: true,
    valuationUsd: 0,
    valuationKnowledge: "exact",
    cashKnowledge: "unknown",
  },
  metric: null,
  costEstimated: false,
};
const PAID_UNKNOWN_ZERO: Scenario = {
  name: "a paid zero of unknown meaning",
  route: "vendor_native",
  usage: { ...TOKENS_ONLY, cost_usd: 0, cost_basis: { kind: "unknown", source: "fixture" } },
  basis: PAID_CREDITS,
  row: { usd: 0, estimated: false, amount_kind: "unknown" },
  settlement: {
    knowledge: "unknown",
    cashKnowledge: "unknown",
    valuationKnowledge: "unknown",
    source: BY_ROUTE,
    cashUsd: 0,
  },
  live: { spendUsd: 0, estimated: true, ...NO_VALUATION },
  terminal: {
    spendUsd: null,
    controllableSpendUsd: null,
    estimated: true,
    ...NO_VALUATION,
    cashKnowledge: "unknown",
  },
  metric: null,
  costEstimated: false,
};
// A positive row keeps its older estimated pre-settlement reading.
const POSITIVE_CASH: Scenario = {
  name: "ordinary positive cash",
  route: "managed_api_key",
  usage: { cost_usd: 0.25 },
  row: { usd: 0.25, estimated: false, amount_kind: "cash" },
  settlement: { knowledge: "exact", cashKnowledge: "exact", source: BY_ROUTE, cashUsd: 0.25 },
  live: { spendUsd: 0.25, estimated: true, valuationUsd: 0.25, valuationKnowledge: "estimated" },
  terminal: {
    spendUsd: 0.25,
    controllableSpendUsd: 0.25,
    estimated: false,
    ...NO_VALUATION,
    cashKnowledge: "exact",
  },
  metric: ema(0.25),
  costEstimated: false,
};
const POSITIVE_VALUATION: Scenario = {
  name: "ordinary positive valuation",
  route: "vendor_native",
  usage: { cost_usd: 0.5, estimated: true },
  row: { usd: 0.5, estimated: true, amount_kind: "valuation" },
  settlement: {
    knowledge: "estimated",
    cashKnowledge: "exact",
    valuationKnowledge: "estimated",
    source: BY_ROUTE,
    cashUsd: 0,
    valuationUsd: 0.5,
  },
  live: { spendUsd: 0.5, estimated: true, valuationUsd: 0.5, valuationKnowledge: "estimated" },
  terminal: {
    spendUsd: 0,
    controllableSpendUsd: 0,
    estimated: false,
    valuationUsd: 0.5,
    valuationKnowledge: "estimated",
    cashKnowledge: "exact",
  },
  metric: ema(0.5),
  costEstimated: true,
};

const CASES: { lane: Lane; scenario: Scenario }[] = [
  ...[
    ABSENT,
    CASH_ZERO,
    ESTIMATED_CASH_ZERO,
    VALUATION_ZERO,
    ESTIMATED_VALUATION_ZERO,
    INCLUDED_NO_AMOUNT,
    INCLUDED_VALUATION_ZERO,
    PAID_UNKNOWN_ZERO,
    POSITIVE_CASH,
    POSITIVE_VALUATION,
  ].map((scenario) => ({ lane: "ask" as const, scenario })),
  ...(["plan", "deep scan"] as const).flatMap((lane) =>
    [ESTIMATED_CASH_ZERO, ABSENT].map((scenario) => ({ lane, scenario })),
  ),
  // Three trackers' clean exact zeros: an estimate until each settles exact.
  { lane: "deep scan", scenario: CASH_ZERO },
  ...[CASH_ZERO, ESTIMATED_VALUATION_ZERO, ABSENT].map((scenario) => ({
    lane: "agent" as const,
    scenario,
  })),
];

describe("an observed zero keeps its meaning through every lane (#171)", () => {
  it.each(CASES)(
    "$lane: $scenario.name",
    async ({ lane, scenario }) => {
      const id = `${lane}-${scenario.name}`.replace(/[^a-z0-9]+/g, "-");
      const frames = interval(scenario.route, scenario.usage, scenario.basis);
      const outcome = await run(lane, id, frames);
      expect(outcome.result.lifecycle, JSON.stringify(outcome.result.facts)).toBe("succeeded");
      const attempts = LANES[lane].attempts;

      expect(outcome.settlements.map(withoutProvenance)).toEqual(
        Array.from({ length: attempts }, () => scenario.settlement),
      );
      expect(outcome.spendRows).toEqual(
        scenario.row
          ? Array.from({ length: attempts }, () => expect.objectContaining(scenario.row!))
          : [],
      );
      expectEstimatesBeforeSettlement(outcome);
      expect(outcome.live).toMatchObject(scenario.live);
      expectEachSettlementReadsItsLedger(outcome);
      expect(outcome.terminal).toMatchObject(scenario.terminal);
      if (lane !== "agent") {
        // Only a candidate attempt is a routing sample.
        expect(outcome.metric).toBe(SEEDED_METRIC);
        return;
      }
      expect(outcome.metric).toBe(scenario.metric);
      expect(outcome.attemptRecord("a01")).toMatchObject({
        cost_usd: 0,
        cost_estimated: scenario.costEstimated,
      });
      // The sample reaches the next run's economy ranking as that same evidence.
      const next = await run("ask", id, frames, {
        keepMetric: true,
        input: { routingGoal: "economy" },
      });
      expect(next.routing()?.entries.find((entry) => entry.harness_id === id)).toMatchObject({
        incremental_cost_usd: scenario.route === "vendor_native" ? null : scenario.metric,
      });
    },
    RUN_TIMEOUT_MS,
  );
});

describe("an observed zero certifies nothing beyond itself (#171)", () => {
  const API = { credential_route: "managed_api_key" as const };
  /** A try the lane retries: a typed transient failure before any deliverable. */
  const failedTry = (...frames: Frame[]): Frame[] => [
    { ...API, type: "started" },
    ...frames,
    {
      ...API,
      type: "error",
      error: "connection reset",
      transient: { kind: "network", retry_delay_ms: 0 },
    },
    { ...API, type: "completed" },
  ];
  /** A delivering try that reports no amount: its paid cash stays unknown. */
  const unpricedTry: Frame[] = [
    { ...API, type: "started" },
    { ...API, type: "message", text: "# Report\n\nDone.", final: true },
    { ...API, type: "completed" },
  ];
  const ESTIMATE = { spendUsd: 0, estimated: true, cashKnowledge: undefined, ...NO_VALUATION };
  const NOTHING_PRICED = { spendUsd: null, cashKnowledge: undefined, ...NO_VALUATION };
  const UNVERIFIABLE = {
    spendUsd: null,
    controllableSpendUsd: null,
    remainingUsd: null,
    estimated: true,
    cashKnowledge: "unknown",
  };

  it(
    "an exact zero receipt, then an unpriced retry: an estimate at every boundary, unknown once settled",
    async () => {
      const outcome = await run(
        "ask",
        "zero-then-unpriced-retry",
        (dispatch) =>
          dispatch === 1
            ? failedTry({ ...API, type: "usage", usage: { cost_usd: 0 } })
            : unpricedTry,
        { paidBudget: { kind: "finite", maxUsd: 1 } },
      );
      expect(outcome.dispatched).toBe(2);
      expect(outcome.settlements.map(withoutProvenance)).toEqual([
        { knowledge: "unknown", cashKnowledge: "unknown", source: BY_ROUTE, cashUsd: 0 },
      ]);
      // The receipt itself survives as evidence of its own amount.
      expect(outcome.spendRows).toEqual([
        expect.objectContaining({ usd: 0, estimated: false, amount_kind: "cash" }),
      ]);
      const { events } = outcome;
      const receipt = nth(events, isSpendRow);
      const retryStarted = nth(events, isHarness("started"), 2);
      const retryEnded = nth(events, isHarness("completed"), 2);
      expect([receipt, retryStarted, retryEnded].every((index) => index >= 0)).toBe(true);
      expect(receipt < retryStarted && retryEnded < outcome.beforeSettlement).toBe(true);
      // The receipt, the retry's start, its end without an amount, and the
      // moment before settlement all read the same estimate with its cap headroom
      // as an estimate too; never an exact $0.
      for (const count of [receipt + 1, retryStarted + 1, retryEnded + 1, outcome.beforeSettlement])
        expect(outcome.at(count), `after event ${count}`).toMatchObject({
          ...ESTIMATE,
          remainingUsd: 1,
        });
      expectEstimatesBeforeSettlement(outcome);
      expect(outcome.at(outcome.beforeSettlement + 1)).toMatchObject(UNVERIFIABLE);
      expectEachSettlementReadsItsLedger(outcome);
      expect(outcome.terminal).toMatchObject(UNVERIFIABLE);
      expect(outcome.result.facts.reason).toBe("cost_unverifiable");
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "an unpriced try, then an exact zero retry: nothing priced, then an estimate, unknown once settled",
    async () => {
      const outcome = await run(
        "ask",
        "unpriced-then-zero-retry",
        (dispatch) => (dispatch === 1 ? failedTry() : interval("managed_api_key", { cost_usd: 0 })),
        { paidBudget: { kind: "finite", maxUsd: 1 } },
      );
      expect(outcome.dispatched).toBe(2);
      expect(outcome.settlements.map(withoutProvenance)).toEqual([
        { knowledge: "unknown", cashKnowledge: "unknown", source: BY_ROUTE, cashUsd: 0 },
      ]);
      expect(outcome.spendRows).toEqual([
        expect.objectContaining({ usd: 0, estimated: false, amount_kind: "cash" }),
      ]);
      const { events } = outcome;
      const firstStarted = nth(events, isHarness("started"));
      const firstEnded = nth(events, isHarness("completed"));
      const retryStarted = nth(events, isHarness("started"), 2);
      const receipt = nth(events, isSpendRow);
      expect(firstEnded < retryStarted && retryStarted < receipt).toBe(true);
      for (const count of [firstStarted + 1, firstEnded + 1, retryStarted + 1])
        expect(outcome.at(count), `after event ${count}`).toMatchObject(NOTHING_PRICED);
      for (const count of [receipt + 1, outcome.beforeSettlement])
        expect(outcome.at(count), `after event ${count}`).toMatchObject(ESTIMATE);
      expectEstimatesBeforeSettlement(outcome);
      expect(outcome.at(outcome.beforeSettlement + 1)).toMatchObject(UNVERIFIABLE);
      expectEachSettlementReadsItsLedger(outcome);
      expect(outcome.terminal).toMatchObject(UNVERIFIABLE);
      expect(outcome.result.facts.reason).toBe("cost_unverifiable");
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "concurrent scouts, one clean and one with a later unpriced try: estimates, then each settlement's ledger",
    async () => {
      const zero = interval("managed_api_key", { cost_usd: 0 });
      // Dispatches 1 and 2 are the two scouts in either attempt order; 3 is the synth.
      const outcome = await run("deep scan", "mixed-scouts", (dispatch) =>
        dispatch === 2
          ? [...zero, { ...API, type: "started" }, { ...API, type: "completed" }]
          : zero,
      );
      expect(outcome.result.lifecycle, JSON.stringify(outcome.result.facts)).toBe("succeeded");
      expect(outcome.dispatched).toBe(3);
      expect(outcome.settlements.map((settlement) => settlement.cashKnowledge).sort()).toEqual([
        "exact",
        "exact",
        "unknown",
      ]);
      expect(outcome.spendRows).toEqual(
        Array.from({ length: 3 }, () =>
          expect.objectContaining({ usd: 0, estimated: false, amount_kind: "cash" }),
        ),
      );
      expectEstimatesBeforeSettlement(outcome);
      expectEachSettlementReadsItsLedger(outcome);
      expect(outcome.terminal).toMatchObject({ spendUsd: null, cashKnowledge: "unknown" });
    },
    RUN_TIMEOUT_MS,
  );

  it.each([
    ["the unknown zero first", ["unknown", "valuation"]],
    ["the valuation zero first", ["valuation", "unknown"]],
  ] as const)(
    "a paid zero of unknown meaning beside a zero valuation, %s: never a known valuation",
    async (_order, kinds) => {
      const native = { credential_route: "vendor_native" as const };
      const zeroOf = (kind: "unknown" | "valuation", last: boolean): Frame[] => {
        const common =
          kind === "unknown" ? { ...native, processing_cost_basis: PAID_CREDITS } : native;
        const usage =
          kind === "unknown"
            ? { cost_usd: 0, cost_basis: { kind: "unknown" as const, source: "fixture" } }
            : { cost_usd: 0 };
        return [
          { ...common, type: "started" },
          ...(last ? [{ ...common, type: "message" as const, text: "# Report", final: true }] : []),
          { ...common, type: "usage", usage },
          { ...common, type: "completed" },
        ];
      };
      const outcome = await run("ask", `unknown-and-valuation-${kinds[0]}`, [
        ...zeroOf(kinds[0], false),
        ...zeroOf(kinds[1], true),
      ]);
      expect(outcome.result.lifecycle, JSON.stringify(outcome.result.facts)).toBe("succeeded");
      expect(outcome.spendRows).toEqual(
        kinds.map((kind) => expect.objectContaining({ usd: 0, amount_kind: kind })),
      );
      expect(outcome.settlements.map(withoutProvenance)).toEqual([
        {
          knowledge: "unknown",
          cashKnowledge: "unknown",
          valuationKnowledge: "unknown",
          source: BY_ROUTE,
          cashUsd: 0,
          valuationUsd: 0,
        },
      ]);
      const { events } = outcome;
      for (const count of [nth(events, isSpendRow) + 1, nth(events, isSpendRow, 2) + 1])
        expect(outcome.at(count), `after event ${count}`).toMatchObject(ESTIMATE);
      expectEstimatesBeforeSettlement(outcome);
      expectEachSettlementReadsItsLedger(outcome);
      expect(outcome.terminal).toMatchObject({
        spendUsd: null,
        cashKnowledge: "unknown",
        ...NO_VALUATION,
      });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "keeps a positive finite cap's headroom on a receipt and unverifiable without one",
    async () => {
      const paidBudget = { kind: "finite", maxUsd: 1 } as const;
      const receipt = await run(
        "ask",
        "finite-receipt",
        interval("managed_api_key", { cost_usd: 0 }),
        { paidBudget },
      );
      expect(receipt.result.lifecycle).toBe("succeeded");
      expect(receipt.terminal).toMatchObject({ spendUsd: 0, remainingUsd: 1 });

      const absent = await run(
        "ask",
        "finite-absent",
        interval("managed_api_key", { input_tokens: 1 }),
        { paidBudget },
      );
      expect(absent.result.facts.reason).toBe("cost_unverifiable");
      expect(absent.terminal).toMatchObject({ spendUsd: null, remainingUsd: null });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "a zero receipt the route might report never admits unproven work under finite(0)",
    async () => {
      const outcome = await run(
        "ask",
        "finite-zero",
        interval("managed_api_key", { cost_usd: 0 }),
        { paidBudget: { kind: "finite", maxUsd: 0 } },
      );
      expect(outcome.dispatched).toBe(0);
      expect(outcome.result.lifecycle).toBe("failed");
      expect(outcome.spendRows).toEqual([]);
    },
    RUN_TIMEOUT_MS,
  );
});

describe("the Raw API instance decides whether its amount is a receipt (#171)", () => {
  const KEY_ENV = "CLAUDEXOR_TEST_ZERO_USAGE_KEY";

  /** The real adapter's stream for one provider answer carrying `usage.cost: 0`. */
  async function rawFrames(providerUsageCostUnit?: "usd"): Promise<Frame[]> {
    vi.stubEnv(KEY_ENV, "fixture-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              model: "vendor/model",
              choices: [{ message: { content: "# Report" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 2, completion_tokens: 3, cost: 0 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const adapter = createRawApiAdapter({
      id: "raw-fixture",
      baseUrl: "https://raw.invalid/v1",
      keyEnv: KEY_ENV,
      defaultModel: "vendor/model",
      providerUsageCostUnit,
    });
    const frames: Frame[] = [];
    for await (const event of adapter.run(
      HarnessRunSpec.parse({
        session_id: "raw",
        intent: "review",
        prompt: "x",
        cwd: process.cwd(),
        access: "readonly",
        external_context_policy: "auto",
        tool_permission_policy: { web: "auto", allow: [], deny: [] },
      }),
    ))
      frames.push(event);
    vi.unstubAllGlobals();
    return frames;
  }

  it(
    "a declared USD instance's zero is a cash receipt and a routing sample",
    async () => {
      const frames = await rawFrames("usd");
      expect(frames.find((frame) => frame.type === "usage")?.usage?.cost_usd).toBe(0);
      const outcome = await run("agent", "raw-declared", frames);
      expect(outcome.settlements.map(withoutProvenance)).toEqual([
        { knowledge: "exact", cashKnowledge: "exact", source: BY_ROUTE, cashUsd: 0 },
      ]);
      expect(outcome.spendRows).toEqual([
        expect.objectContaining({ usd: 0, estimated: false, amount_kind: "cash" }),
      ]);
      expect(outcome.terminal).toMatchObject({ spendUsd: 0, estimated: false });
      expect(outcome.metric).toBe(ema(0));
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "a generic instance's undeclared zero never becomes a free cash sample",
    async () => {
      const frames = await rawFrames();
      expect(frames.find((frame) => frame.type === "usage")?.usage).not.toHaveProperty("cost_usd");
      const outcome = await run("agent", "raw-generic", frames);
      expect(outcome.settlements.map(withoutProvenance)).toEqual([
        { knowledge: "unknown", cashKnowledge: "unknown", source: MISSING, cashUsd: 0 },
      ]);
      expect(outcome.spendRows).toEqual([]);
      expect(outcome.terminal).toMatchObject({ spendUsd: null, cashKnowledge: "unknown" });
      expect(outcome.metric).toBeNull();
    },
    RUN_TIMEOUT_MS,
  );
});

describe("a review panel's observed zero reaches the run's projections (#171)", () => {
  function reviewer(
    id: string,
    providerFamily: "openai" | "anthropic",
    route: Route,
    usage: NonNullable<HarnessEvent["usage"]>,
  ): ReviewerSpec {
    const adapter: HarnessAdapter = {
      id,
      async discover() {
        return HarnessManifest.parse({
          id,
          display_name: id,
          kind: "local_cli",
          provider_family: providerFamily,
          access_profiles_supported: ["readonly"],
          capabilities: { review: true, known_models: [`${id}-model`] },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: id,
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        const common = { session_id: spec.session_id, ts, credential_route: route };
        yield { ...common, type: "started", observed_model: `${id}-model` };
        yield { ...common, type: "usage", usage };
        yield { ...common, type: "message", text: "```json\n[]\n```" };
        yield { ...common, type: "completed" };
      },
    };
    return { adapter, providerFamily };
  }

  it(
    "settles receipts as review usage and discloses a zero spend row",
    async () => {
      const outcome = await run(
        "agent",
        "review-zero",
        interval("managed_api_key", { cost_usd: 0.25 }),
        {
          reviewers: [
            reviewer("review-api", "openai", "managed_api_key", { cost_usd: 0 }),
            reviewer("review-native", "anthropic", "vendor_native", { cost_usd: 0 }),
          ],
          input: { review: true },
        },
      );
      expect(outcome.result.facts.review).toBe("approved");
      expect(
        outcome.settlements
          .filter((settlement) => settlement.provenance.includes("review:panel"))
          .map(withoutProvenance),
      ).toEqual([
        {
          knowledge: "exact",
          cashKnowledge: "exact",
          valuationKnowledge: "exact",
          source: "review-usage",
          cashUsd: 0,
          valuationUsd: 0,
        },
      ]);
      expect(outcome.spendRows.filter((row) => row["harness_id"] === "review-panel")).toEqual([
        expect.objectContaining({ usd: 0, cash_usd: 0, valuation_usd: 0, estimated: false }),
      ]);
      expect(outcome.terminal).toMatchObject({
        spendUsd: 0.25,
        estimated: false,
        valuationUsd: 0,
        valuationKnowledge: "exact",
      });
    },
    RUN_TIMEOUT_MS,
  );
});
