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
 * count per parent, and a conservative paid-budget draw bounded by the parent
 * ledger's launch-time headroom snapshot. The daemon-lifetime shared budget
 * authority is the authoritative cap across every belt process/child; this
 * local snapshot only refuses obvious overdraw earlier. The policy checks are
 * PURE functions so they are unit testable without a live daemon.
 */
import { MAX_DELEGATED_CHILDREN, type PaidBudget } from "@claudexor/schema";
import { DELEGATION_ENV, redactSecrets } from "@claudexor/util";
import type { McpTool, McpToolAnnotations, RunnerFn } from "./index.js";

/** Runtime policy the belt enforces, derived from the injected delegation env. */
export interface DelegationPolicy {
  /** Current top-level Delegate run. This is not the parent's own thread/retry
   * ancestor; every belt child persists this exact id as its delegation parent. */
  parentRunId: string | null;
  /** Original user project root. The parent harness itself runs in a
   * Claudexor-owned envelope, which must never be re-registered as a project;
   * every child instead starts a fresh envelope from this root. */
  repoRoot: string | null;
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

export const DEFAULT_MAX_SUBRUNS = MAX_DELEGATED_CHILDREN;

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
    ? `delegation sub-run cap reached (${started}/${maxSubRuns}); integrate the results you have or start a new parent run`
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
  if (!policy.parentRunId) {
    return { refusal: "delegation parent run id is missing; refusing untraceable sub-run" };
  }
  if (!policy.repoRoot) {
    return { refusal: "delegation project root is missing; refusing an unscoped sub-run" };
  }
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
    parentRunId:
      typeof env[DELEGATION_ENV.parentRunId] === "string" &&
      env[DELEGATION_ENV.parentRunId]!.trim().length > 0
        ? env[DELEGATION_ENV.parentRunId]!.trim()
        : null,
    repoRoot:
      typeof env[DELEGATION_ENV.repoRoot] === "string" &&
      env[DELEGATION_ENV.repoRoot]!.trim().length > 0
        ? env[DELEGATION_ENV.repoRoot]!.trim()
        : null,
    // Absent depth => 1 (fail closed: refuse), present + finite => the value.
    depth: Number.isFinite(depthRaw) ? depthRaw : 1,
    maxSubRuns: Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : DEFAULT_MAX_SUBRUNS,
    parentBudget,
  };
}

/** Build the delegation env map for one parent run (daemon-side producer). */
export function delegationEnv(opts: {
  parentRunId: string;
  repoRoot: string;
  depth: number;
  maxSubRuns: number;
  parentBudget: PaidBudget;
}): Record<string, string> {
  return {
    [DELEGATION_ENV.parentRunId]: opts.parentRunId,
    [DELEGATION_ENV.repoRoot]: opts.repoRoot,
    [DELEGATION_ENV.depth]: String(opts.depth),
    [DELEGATION_ENV.maxSubRuns]: String(opts.maxSubRuns),
    [DELEGATION_ENV.budget]: JSON.stringify(opts.parentBudget),
  };
}

const readOnly: McpToolAnnotations = { readOnlyHint: true };

type BeltRunFailureCode = "delegation_policy_denied" | "delegation_child_terminal";

function beltRunFailure(code: BeltRunFailureCode, message: string): Error {
  return Object.assign(new Error(redactSecrets(message)), { code });
}

/** Typed evidence a throwing runner attaches when its delegated child ALREADY
 * reached a durable terminal (field contract with the CLI's shared MCP/ACP
 * runner): the throw happened AFTER the terminal, so the child really ran —
 * its slot was consumed and its spend is real even though the settled amount
 * may be unknowable. Anything else on a thrown error means "the child never
 * started". */
export function childTerminalEvidence(
  error: unknown,
): { runId: string | null; status: string | null } | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as { delegationChildTerminal?: unknown }).delegationChildTerminal;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return {
    runId: typeof record["runId"] === "string" && record["runId"] ? record["runId"] : null,
    status: typeof record["status"] === "string" ? record["status"] : null,
  };
}

function failedChildTerminal(result: unknown): Error | null {
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  const status = record["status"];
  if (status !== "failed" && status !== "cancelled" && status !== "interrupted") return null;
  const runId = typeof record["runId"] === "string" && record["runId"] ? record["runId"] : null;
  return beltRunFailure(
    "delegation_child_terminal",
    `delegated sub-run${runId ? ` ${runId}` : ""} ended ${status}${runId ? `; inspect it with claudexor_run_result` : ""}`,
  );
}

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
        throw beltRunFailure("delegation_policy_denied", `delegation refused: ${decision.refusal}`);
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
            parentRunId: policy.parentRunId,
            delegatedFromRunId: policy.parentRunId,
            repoPath: policy.repoRoot,
            paidBudget: decision.budget,
          },
          ctx.signal ? { signal: ctx.signal } : {},
        );
      } catch (error) {
        if (childTerminalEvidence(error)) {
          // The child reached a durable TERMINAL before the runner threw (a
          // post-terminal projection failed): the slot was really consumed and
          // the child really spent. With the settled amount unknowable, the
          // full reservation stays committed fail-closed (added here, released
          // once in finally) — a typed detail hiccup must never hand the
          // parent an over-cap slot or invisible spend.
          ledger.committedUsd += reservedUsd;
        } else {
          // A runner that throws BEFORE its child starts never consumed a
          // usable delegated child, so it must not permanently consume this
          // belt session's count slot.
          ledger.started = Math.max(0, ledger.started - 1);
        }
        throw error;
      } finally {
        // Release the reservation; a never-started sub-run frees its headroom.
        ledger.committedUsd -= reservedUsd;
      }
      // Reconcile: commit the sub-run's real settled spend against the headroom
      // so the next draw sees the actual amount drawn. A terminal result whose
      // settled spend is unknowable (the post-terminal detail read degraded, so
      // spendUsd is null) commits the FULL reservation fail-closed — unknown
      // spend must never widen the next draw's headroom.
      const spendUsd =
        result && typeof result === "object"
          ? (result as { spendUsd?: unknown }).spendUsd
          : undefined;
      ledger.committedUsd += typeof spendUsd === "number" ? Math.max(0, spendUsd) : reservedUsd;
      const terminalFailure = failedChildTerminal(result);
      if (terminalFailure) throw terminalFailure;
      return formatBeltResult(result);
    },
  });

  const readTool = (name: string, description: string, mode: string): McpTool => ({
    name,
    description,
    inputSchema: runIdSchema,
    annotations: readOnly,
    handler: async (args) => {
      if (!policy.parentRunId) {
        return "delegation refused: delegation parent run id is missing; refusing unscoped read";
      }
      const result = await runner({
        mode,
        runId: String((args as { runId?: unknown }).runId ?? ""),
        delegatedFromRunId: policy.parentRunId,
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
