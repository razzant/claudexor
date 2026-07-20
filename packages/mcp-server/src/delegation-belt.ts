/**
 * The delegation belt (D32): a SCOPED Claudexor MCP surface injected into an
 * agent harness's sandbox when `agent --delegate` is on. The harness drives it
 * to spawn BOUNDED, ISOLATED sub-runs (industry pattern: CC Task tool, Cursor
 * subagents, Codex spawn) and integrate their results in its own workspace.
 *
 * It exposes ONLY: claudexor_ask, claudexor_plan, claudexor_run (isolated
 * sub-run), claudexor_best_of, claudexor_run_status, claudexor_run_result.
 * There is NO apply/decision/thread/settings tool — the PARENT integrates
 * results; the belt never mutates the live tree or the thread.
 *
 * Server-side policy is enforced at the tool boundary (never trusting the
 * harness): nesting depth = 1 (a belt at depth>0 refuses — structurally the
 * sub-runs it spawns carry no belt, so this is defense-in-depth), a max sub-run
 * count per parent, and a paid-budget draw bounded by the parent ledger's
 * headroom snapshot. The policy checks are PURE functions so they are unit
 * testable without a live daemon.
 */
import type { PaidBudget } from "@claudexor/schema";
import { DELEGATION_ENV } from "@claudexor/util";
import type { McpTool, McpToolAnnotations, RunnerFn } from "./index.js";

/** Runtime policy the belt enforces, derived from the injected delegation env. */
export interface DelegationPolicy {
  /** This belt's nesting depth. A top-level delegate run injects depth 0; a
   * belt observing depth>0 refuses every sub-run (belt-and-suspenders — the
   * sub-runs a belt spawns are delegate-less and carry no belt of their own). */
  depth: number;
  /** Max sub-runs this belt may start for its parent (default 8). */
  maxSubRuns: number;
  /** The parent run's remaining paid-budget headroom at belt-launch. Each
   * sub-run is bounded by what is left of it after prior sub-runs. */
  parentBudget: PaidBudget;
}

export const DEFAULT_MAX_SUBRUNS = 8;

/** Depth guard: a belt may only run at depth 0. Returns a typed refusal string
 * (never throws) when nested, else null. */
export function delegationDepthRefusal(depth: number): string | null {
  return depth > 0
    ? `delegation is limited to depth 1: this sub-run is already delegated (depth ${depth}) and may not itself delegate`
    : null;
}

/** Count-cap guard. `started` = sub-runs already started this belt session. */
export function subRunCountRefusal(started: number, maxSubRuns: number): string | null {
  return started >= maxSubRuns
    ? `delegation sub-run cap reached (${started}/${maxSubRuns}); integrate the results you have or raise the parent's budget`
    : null;
}

export interface DelegationBudgetDraw {
  /** The paid budget to hand the next sub-run, or null when the parent budget
   * is unlimited (sub-runs inherit unlimited). */
  budget: PaidBudget;
  /** Set when there is no headroom left — the belt refuses the sub-run. */
  refusal: string | null;
}

/**
 * Compute the paid budget for the next sub-run, drawn from the parent ledger's
 * headroom snapshot. `spentUsd` = the belt's own accounting of what prior
 * sub-runs already committed against that headroom. An unlimited parent yields
 * unlimited sub-runs; a finite parent yields the REMAINING headroom, and zero
 * (or negative) headroom is a typed refusal — never a silent unlimited run.
 */
export function delegationBudgetDraw(
  parentBudget: PaidBudget,
  spentUsd: number,
): DelegationBudgetDraw {
  if (parentBudget.kind === "unlimited") {
    return { budget: { kind: "unlimited" }, refusal: null };
  }
  const remaining = parentBudget.maxUsd - Math.max(0, spentUsd);
  if (remaining <= 0) {
    return {
      budget: { kind: "finite", maxUsd: 0 },
      refusal: `no parent budget headroom left for another sub-run (parent cap $${parentBudget.maxUsd.toFixed(2)}, already committed $${spentUsd.toFixed(2)})`,
    };
  }
  return { budget: { kind: "finite", maxUsd: remaining }, refusal: null };
}

/** Mutable per-session accounting for one belt process (one parent run). */
export interface BeltLedger {
  started: number;
  committedUsd: number;
}

export function newBeltLedger(): BeltLedger {
  return { started: 0, committedUsd: 0 };
}

/**
 * The combined boundary check for a run-producing belt tool. Returns a refusal
 * string when policy blocks the sub-run, else the bounded paid budget to attach.
 * PURE w.r.t. the ledger snapshot — the caller advances the ledger only on a
 * granted run.
 */
export function evaluateBeltRun(
  policy: DelegationPolicy,
  ledger: BeltLedger,
): { refusal: string } | { budget: PaidBudget } {
  const depthRefusal = delegationDepthRefusal(policy.depth);
  if (depthRefusal) return { refusal: depthRefusal };
  const countRefusal = subRunCountRefusal(ledger.started, policy.maxSubRuns);
  if (countRefusal) return { refusal: countRefusal };
  const draw = delegationBudgetDraw(policy.parentBudget, ledger.committedUsd);
  if (draw.refusal) return { refusal: draw.refusal };
  return { budget: draw.budget };
}

/** Parse the delegation policy from a process env (the belt-serve entrypoint's
 * first read). Missing/invalid values fail CLOSED: depth defaults high (refuse),
 * count defaults to the cap, budget defaults to finite(0) (refuse) — a belt with
 * no honest policy never spawns an unbounded sub-run. */
export function readDelegationPolicy(env: NodeJS.ProcessEnv): DelegationPolicy {
  const depthRaw = Number.parseInt(env[DELEGATION_ENV.depth] ?? "", 10);
  const maxRaw = Number.parseInt(env[DELEGATION_ENV.maxSubRuns] ?? "", 10);
  let parentBudget: PaidBudget = { kind: "finite", maxUsd: 0 };
  const budgetRaw = env[DELEGATION_ENV.budget];
  if (budgetRaw) {
    try {
      const parsed = JSON.parse(budgetRaw) as PaidBudget;
      if (parsed && (parsed.kind === "unlimited" || parsed.kind === "finite"))
        parentBudget = parsed;
    } catch {
      /* fail closed: keep finite(0) */
    }
  }
  return {
    // Absent depth => 1 (fail closed: refuse), present + finite => the value.
    depth: Number.isFinite(depthRaw) ? depthRaw : 1,
    maxSubRuns: Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : DEFAULT_MAX_SUBRUNS,
    parentBudget,
  };
}

/** Build the delegation env map for one parent run (daemon-side producer). */
export function delegationEnv(opts: {
  parentRunId: string;
  depth: number;
  maxSubRuns: number;
  parentBudget: PaidBudget;
}): Record<string, string> {
  return {
    [DELEGATION_ENV.parentRunId]: opts.parentRunId,
    [DELEGATION_ENV.depth]: String(opts.depth),
    [DELEGATION_ENV.maxSubRuns]: String(opts.maxSubRuns),
    [DELEGATION_ENV.budget]: JSON.stringify(opts.parentBudget),
  };
}

const readOnly: McpToolAnnotations = { readOnlyHint: true };

/**
 * The scoped belt tool surface. `runner` is the SAME daemon-crossing runner the
 * public MCP surface uses (isolated envelope, no thread by construction); the
 * belt layers policy + budget-draw on the run-producing tools and passes the
 * read tools straight through. `ledger` is the per-process accounting the belt
 * advances on each granted sub-run.
 */
export function beltClaudexorTools(
  runner: RunnerFn,
  policy: DelegationPolicy,
  ledger: BeltLedger = newBeltLedger(),
): McpTool[] {
  const runPromptSchema = (minN = 1) => ({
    type: "object",
    additionalProperties: false,
    properties: {
      prompt: {
        type: "string",
        minLength: 1,
        pattern: "\\S",
        description: "The sub-task or question to run as an isolated Claudexor sub-run.",
      },
      harness: {
        type: "string",
        minLength: 1,
        description: "Optional harness id to force for this sub-run.",
      },
      n: {
        type: "integer",
        minimum: minN,
        description: "Number of best-of-N candidates (claudexor_best_of).",
      },
    },
    required: ["prompt"],
  });
  const runIdSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      runId: {
        type: "string",
        minLength: 1,
        description: "Sub-run id returned by a belt run tool's runId trailer.",
      },
    },
    required: ["runId"],
  };

  /** A run-producing belt tool: policy-gate, then start an ISOLATED sub-run
   * (envelope + no thread are enforced by the shared runner) bounded by the
   * drawn budget, advancing the belt ledger. */
  const runTool = (
    name: string,
    description: string,
    params: Record<string, unknown>,
    minN = 1,
  ): McpTool => ({
    name,
    description,
    inputSchema: runPromptSchema(minN),
    annotations: params["mode"] === "agent" ? { readOnlyHint: false } : readOnly,
    handler: async (args, ctx) => {
      const decision = evaluateBeltRun(policy, ledger);
      if ("refusal" in decision) {
        return `delegation refused: ${decision.refusal}`;
      }
      ledger.started += 1;
      // Reserve the drawn headroom into committedUsd BEFORE awaiting the run so
      // concurrent draws in the same belt see the reservation and cannot
      // over-commit the parent's cap. On completion we reconcile the reservation
      // down to the sub-run's real settled spend (threaded through the runner
      // result as spendUsd). An unlimited draw reserves nothing (no cap to
      // exhaust).
      const reservedUsd =
        decision.budget.kind === "finite" ? Math.max(0, decision.budget.maxUsd) : 0;
      ledger.committedUsd += reservedUsd;
      let result: unknown;
      try {
        result = await runner(
          {
            ...args,
            ...params,
            // Isolated by construction (the runner posts execution.isolation:
            // envelope and binds no thread); belt sub-runs never delegate again.
            deferred: false,
            delegate: false,
            paidBudget: decision.budget,
          },
          ctx.signal ? { signal: ctx.signal } : {},
        );
      } finally {
        // Release the reservation; a throwing sub-run frees its headroom.
        ledger.committedUsd -= reservedUsd;
      }
      // Reconcile: commit the sub-run's real settled spend against the headroom
      // so the next draw sees the actual amount drawn.
      const spent =
        result &&
        typeof result === "object" &&
        typeof (result as { spendUsd?: unknown }).spendUsd === "number"
          ? (result as { spendUsd: number }).spendUsd
          : 0;
      ledger.committedUsd += Math.max(0, spent);
      return formatBeltResult(result);
    },
  });

  const readTool = (name: string, description: string, mode: string): McpTool => ({
    name,
    description,
    inputSchema: runIdSchema,
    annotations: readOnly,
    handler: async (args) => {
      const result = await runner({
        mode,
        runId: String((args as { runId?: unknown }).runId ?? ""),
      });
      return formatBeltResult(result);
    },
  });

  return [
    runTool(
      "claudexor_ask",
      "Delegate a read-only question to an isolated Claudexor sub-run; returns the answer and runId.",
      { mode: "ask" },
    ),
    runTool(
      "claudexor_plan",
      "Delegate a read-only implementation plan to an isolated Claudexor sub-run.",
      { mode: "plan" },
    ),
    runTool(
      "claudexor_run",
      "Delegate a task to an isolated Claudexor agent sub-run; returns its work-product summary and runId (integrate it yourself — the belt has no apply tool).",
      { mode: "agent" },
    ),
    runTool(
      "claudexor_best_of",
      "Delegate a task as a best-of-N isolated Claudexor sub-run with cross-family review.",
      { mode: "agent", race: true },
      2,
    ),
    readTool(
      "claudexor_run_status",
      "Read the current daemon-acknowledged state of a delegated sub-run.",
      "__run_status",
    ),
    readTool(
      "claudexor_run_result",
      "Read a delegated sub-run's terminal result; a non-terminal run reports its current state honestly.",
      "__run_result",
    ),
  ];
}

/** Render a belt sub-run result: summary first, then the runId handle so the
 * parent harness can follow it up with run_status/run_result. */
function formatBeltResult(result: unknown): string {
  if (typeof result === "string") return result.trim();
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    const summary = ["summary", "answer", "text"]
      .map((k) => r[k])
      .find((v): v is string => typeof v === "string" && v.trim().length > 0);
    const trailer: string[] = [];
    if (typeof r["runId"] === "string" && r["runId"]) trailer.push(`runId: ${r["runId"]}`);
    if (typeof r["status"] === "string" && r["status"]) trailer.push(`status: ${r["status"]}`);
    if (!summary && trailer.length === 0) return JSON.stringify(result);
    return [summary, trailer.join("\n")].filter(Boolean).join("\n\n");
  }
  return result == null ? "" : String(result);
}
