import { describe, it, expect } from "vitest";
import { DELEGATION_ENV } from "@claudexor/util";
import {
  DEFAULT_MAX_SUBRUNS,
  beltClaudexorTools,
  delegationBudgetDraw,
  delegationDepthRefusal,
  delegationEnv,
  evaluateBeltRun,
  newBeltLedger,
  readDelegationPolicy,
  subRunCountRefusal,
  type DelegationPolicy,
} from "./delegation-belt.js";
import type { RunnerFn } from "./index.js";

const unlimited: DelegationPolicy = {
  depth: 0,
  maxSubRuns: DEFAULT_MAX_SUBRUNS,
  parentBudget: { kind: "unlimited" },
};

describe("delegation belt policy (D32)", () => {
  it("refuses depth > 0 (nesting is limited to depth 1)", () => {
    expect(delegationDepthRefusal(0)).toBeNull();
    expect(delegationDepthRefusal(1)).toMatch(/depth 1/);
    expect(delegationDepthRefusal(2)).toMatch(/may not itself delegate/);
  });

  it("caps the sub-run count per parent", () => {
    expect(subRunCountRefusal(0, 8)).toBeNull();
    expect(subRunCountRefusal(7, 8)).toBeNull();
    expect(subRunCountRefusal(8, 8)).toMatch(/cap reached \(8\/8\)/);
    expect(subRunCountRefusal(9, 8)).not.toBeNull();
  });

  it("draws each sub-run budget from the parent headroom, refusing when exhausted", () => {
    // Unlimited parent => unlimited sub-runs.
    expect(delegationBudgetDraw({ kind: "unlimited" }, 0)).toEqual({
      budget: { kind: "unlimited" },
      refusal: null,
    });
    // Finite parent => the REMAINING headroom.
    const first = delegationBudgetDraw({ kind: "finite", maxUsd: 1 }, 0);
    expect(first.refusal).toBeNull();
    expect(first.budget).toEqual({ kind: "finite", maxUsd: 1 });
    const second = delegationBudgetDraw({ kind: "finite", maxUsd: 1 }, 0.6);
    expect(second.budget).toEqual({ kind: "finite", maxUsd: 0.4 });
    // No headroom left => typed refusal, never a silent unlimited run.
    const exhausted = delegationBudgetDraw({ kind: "finite", maxUsd: 1 }, 1);
    expect(exhausted.refusal).toMatch(/no parent budget headroom/);
    expect(exhausted.budget).toEqual({ kind: "finite", maxUsd: 0 });
  });

  it("evaluateBeltRun combines the three guards (depth, count, budget)", () => {
    const ledger = newBeltLedger();
    // Grant path.
    const grant = evaluateBeltRun(unlimited, ledger);
    expect(grant).toEqual({ budget: { kind: "unlimited" } });
    // Depth wins.
    expect(evaluateBeltRun({ ...unlimited, depth: 1 }, ledger)).toHaveProperty("refusal");
    // Count wins.
    expect(
      evaluateBeltRun(unlimited, { started: DEFAULT_MAX_SUBRUNS, committedUsd: 0 }),
    ).toHaveProperty("refusal");
    // Budget wins.
    expect(
      evaluateBeltRun(
        { ...unlimited, parentBudget: { kind: "finite", maxUsd: 1 } },
        { started: 0, committedUsd: 1 },
      ),
    ).toHaveProperty("refusal");
  });

  it("reads the delegation policy from env and FAILS CLOSED on missing/garbage", () => {
    const env = delegationEnv({
      parentRunId: "run-1",
      depth: 0,
      maxSubRuns: 3,
      parentBudget: { kind: "finite", maxUsd: 2 },
    });
    const policy = readDelegationPolicy(env);
    expect(policy.depth).toBe(0);
    expect(policy.maxSubRuns).toBe(3);
    expect(policy.parentBudget).toEqual({ kind: "finite", maxUsd: 2 });
    // Missing env => fail closed: depth 1 (refuse), finite(0) budget (refuse).
    const empty = readDelegationPolicy({});
    expect(empty.depth).toBe(1);
    expect(empty.maxSubRuns).toBe(DEFAULT_MAX_SUBRUNS);
    expect(empty.parentBudget).toEqual({ kind: "finite", maxUsd: 0 });
    // Garbage budget => fail closed.
    expect(readDelegationPolicy({ [DELEGATION_ENV.budget]: "not json" }).parentBudget).toEqual({
      kind: "finite",
      maxUsd: 0,
    });
  });
});

describe("delegation belt tool surface (D32)", () => {
  it("exposes EXACTLY the six scoped tools — no apply/decision/thread/settings", () => {
    const names = beltClaudexorTools(async () => ({}), unlimited)
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([
      "claudexor_ask",
      "claudexor_best_of",
      "claudexor_plan",
      "claudexor_run",
      "claudexor_run_result",
      "claudexor_run_status",
    ]);
  });

  it("a run tool starts an isolated sub-run with a forced-envelope, non-delegating, budget-bounded call", async () => {
    const calls: Record<string, unknown>[] = [];
    const runner: RunnerFn = async (params) => {
      calls.push(params as Record<string, unknown>);
      return { runId: "sub-1", status: "succeeded", summary: "done", spendUsd: 0.2 };
    };
    const ledger = newBeltLedger();
    const tools = beltClaudexorTools(
      runner,
      {
        depth: 0,
        maxSubRuns: 8,
        parentBudget: { kind: "finite", maxUsd: 1 },
      },
      ledger,
    );
    const run = tools.find((t) => t.name === "claudexor_run")!;
    const out = await run.handler({ prompt: "fix the bug" }, {});
    expect(String(typeof out === "string" ? out : out.text)).toContain("runId: sub-1");
    expect(calls).toHaveLength(1);
    // Forced: agent mode, no delegation re-entry, bounded budget = full headroom.
    expect(calls[0]).toMatchObject({
      mode: "agent",
      delegate: false,
      prompt: "fix the bug",
      paidBudget: { kind: "finite", maxUsd: 1 },
    });
    // The belt committed the sub-run's real spend against the headroom.
    expect(ledger.started).toBe(1);
    expect(ledger.committedUsd).toBeCloseTo(0.2, 5);
  });

  it("reserves the drawn headroom BEFORE awaiting the run so a concurrent draw cannot over-commit", async () => {
    // A slow sub-run that stays in flight until we release it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const runner: RunnerFn = async () => {
      started += 1;
      await gate;
      return { runId: `sub-${started}`, status: "succeeded", spendUsd: 0.3 };
    };
    const ledger = newBeltLedger();
    const tools = beltClaudexorTools(
      runner,
      { depth: 0, maxSubRuns: 8, parentBudget: { kind: "finite", maxUsd: 1 } },
      ledger,
    );
    const run = tools.find((t) => t.name === "claudexor_run")!;
    // First sub-run starts and reserves the FULL $1 headroom before its await.
    const first = run.handler({ prompt: "a" }, {});
    expect(ledger.committedUsd).toBeCloseTo(1, 5); // reservation is visible immediately
    // A concurrent draw sees the reservation and is refused (no over-draw).
    const second = await run.handler({ prompt: "b" }, {});
    expect(String(typeof second === "string" ? second : second.text)).toMatch(
      /no parent budget headroom/,
    );
    expect(started).toBe(1); // the second never reached the runner
    // Complete the first: the reservation reconciles DOWN to the real spend.
    release();
    await first;
    expect(ledger.committedUsd).toBeCloseTo(0.3, 5);
    // Now that headroom is freed, a fresh draw is granted again.
    const third = await run.handler({ prompt: "c" }, {});
    expect(String(typeof third === "string" ? third : third.text)).toContain("runId:");
  });

  it("releases the reservation when a sub-run throws (headroom is not stranded)", async () => {
    const ledger = newBeltLedger();
    const runner: RunnerFn = async () => {
      throw new Error("sub-run blew up");
    };
    const tools = beltClaudexorTools(
      runner,
      { depth: 0, maxSubRuns: 8, parentBudget: { kind: "finite", maxUsd: 1 } },
      ledger,
    );
    const run = tools.find((t) => t.name === "claudexor_run")!;
    await expect(run.handler({ prompt: "a" }, {})).rejects.toThrow("blew up");
    // The reservation was released on the throw — headroom is fully available.
    expect(ledger.committedUsd).toBeCloseTo(0, 5);
  });

  it("refuses further sub-runs once the count cap is hit (server-side, not trusting the harness)", async () => {
    let runs = 0;
    const runner: RunnerFn = async () => {
      runs += 1;
      return { runId: `sub-${runs}`, status: "succeeded", spendUsd: 0 };
    };
    const tools = beltClaudexorTools(runner, {
      depth: 0,
      maxSubRuns: 2,
      parentBudget: { kind: "unlimited" },
    });
    const run = tools.find((t) => t.name === "claudexor_run")!;
    await run.handler({ prompt: "a" }, {});
    await run.handler({ prompt: "b" }, {});
    const third = await run.handler({ prompt: "c" }, {});
    expect(String(typeof third === "string" ? third : third.text)).toMatch(/cap reached \(2\/2\)/);
    expect(runs).toBe(2); // the third never reached the runner
  });

  it("refuses every sub-run when injected at depth > 0 (defense-in-depth)", async () => {
    let runs = 0;
    const runner: RunnerFn = async () => {
      runs += 1;
      return {};
    };
    const tools = beltClaudexorTools(runner, {
      depth: 1,
      maxSubRuns: 8,
      parentBudget: { kind: "unlimited" },
    });
    const ask = tools.find((t) => t.name === "claudexor_ask")!;
    const out = await ask.handler({ prompt: "q" }, {});
    expect(String(typeof out === "string" ? out : out.text)).toMatch(/limited to depth 1/);
    expect(runs).toBe(0);
  });

  it("read tools pass through to the daemon recovery projections without policy gating", async () => {
    const modes: string[] = [];
    const runner: RunnerFn = async (params) => {
      modes.push((params as { mode: string }).mode);
      return { runId: "sub-1", status: "running", summary: "in progress" };
    };
    const tools = beltClaudexorTools(runner, {
      depth: 1,
      maxSubRuns: 0,
      parentBudget: { kind: "finite", maxUsd: 0 },
    });
    await tools.find((t) => t.name === "claudexor_run_status")!.handler({ runId: "sub-1" }, {});
    await tools.find((t) => t.name === "claudexor_run_result")!.handler({ runId: "sub-1" }, {});
    // Read tools work even under the most restrictive policy (they never spawn).
    expect(modes).toEqual(["__run_status", "__run_result"]);
  });
});
