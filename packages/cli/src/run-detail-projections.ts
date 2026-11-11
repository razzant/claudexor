import {
  ControlPrimaryOutput,
  CouncilProjection,
  RunFailure,
  type ControlPrimaryOutput as ControlPrimaryOutputType,
  type DecisionRecord,
  type RunFailure as RunFailureType,
} from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";

export type PrimaryOutputPresentation = Pick<ControlPrimaryOutputType, "kind" | "path" | "text"> & {
  truncated?: boolean;
};

/** Schema-validate the Control API's single primary-output owner. */
export function projectRunPrimaryOutput(
  detail: Record<string, unknown> | null,
): ControlPrimaryOutputType | null {
  const parsed = ControlPrimaryOutput.safeParse(detail?.["primaryOutput"]);
  return parsed.success ? parsed.data : null;
}

/** Inline non-patch output with an honest bounded-preview disclosure. */
export function presentRunPrimaryOutput(output: PrimaryOutputPresentation | null): string | null {
  if (!output || output.kind === "patch" || typeof output.text !== "string") return null;
  const text = output.text.trim();
  if (!text) return null;
  return output.truncated === true
    ? `${text}\n\n[Inline preview bounded; full artifact: ${output.path}]`
    : text;
}

export type ApplyEligibilityProjection = {
  eligible: boolean;
  state: string | null;
  reason: string | null;
  requiredAction: string | null;
};

export function projectApplyEligibility(
  detail: Record<string, unknown> | null,
): ApplyEligibilityProjection | null {
  const value = detail?.["applyEligibility"];
  return value && typeof value === "object" ? (value as ApplyEligibilityProjection) : null;
}

export function projectRunSpendUsd(detail: Record<string, unknown> | null): number | null {
  const summary = detail?.["summary"];
  const spend =
    summary && typeof summary === "object"
      ? (summary as { spendUsd?: unknown }).spendUsd
      : undefined;
  return typeof spend === "number" && Number.isFinite(spend) ? spend : null;
}

/** Cash a finite cap governs. It stays known when an included subscription
 * reports no actual debit and the total `spendUsd` is therefore unknown. */
export function projectRunControllableSpendUsd(
  detail: Record<string, unknown> | null,
): number | null {
  const budget = detail?.["budget"];
  const spend =
    budget && typeof budget === "object"
      ? (budget as { controllableSpendUsd?: unknown }).controllableSpendUsd
      : undefined;
  return typeof spend === "number" && Number.isFinite(spend) ? spend : null;
}

/** `inspect` budget line. An unknown total is never printed as its known
 * subtotal; the cap-governed part is shown separately when known. */
export function inspectBudgetLine(budget: DecisionRecord["budget_summary"]): string {
  if (budget.spend_usd === null && typeof budget.controllable_cash_usd === "number")
    return `budget: spend=unknown controllable=${budget.controllable_cash_usd}`;
  return `budget: spend=${budget.spend_usd ?? "unknown"}${budget.estimated ? " estimated" : ""}`;
}

export function projectRunCouncil(detail: Record<string, unknown> | null): unknown {
  const parsed = CouncilProjection.safeParse(detail?.["council"]);
  return parsed.success ? parsed.data : null;
}

/** Preserve only the schema-owned typed terminal failure. Every surface uses
 * this projection instead of forwarding an arbitrary failure-shaped object. */
export function projectRunFailure(detail: Record<string, unknown> | null): RunFailureType | null {
  const parsed = RunFailure.safeParse(detail?.["failure"]);
  return parsed.success ? parsed.data : null;
}

export function projectRunLineage(detail: Record<string, unknown> | null): {
  parentRunId: string | null;
  delegatedFromRunId: string | null;
  delegation: Record<string, unknown> | null;
} {
  const summary =
    detail?.["summary"] && typeof detail["summary"] === "object"
      ? (detail["summary"] as Record<string, unknown>)
      : null;
  return {
    parentRunId: typeof summary?.["parentRunId"] === "string" ? summary["parentRunId"] : null,
    delegatedFromRunId:
      typeof summary?.["delegatedFromRunId"] === "string" ? summary["delegatedFromRunId"] : null,
    delegation:
      summary?.["delegation"] && typeof summary["delegation"] === "object"
        ? (summary["delegation"] as Record<string, unknown>)
        : null,
  };
}

export function projectOutcomeBanner(detail: Record<string, unknown> | null): string | null {
  const banner = detail?.["outcomeBanner"];
  return typeof banner === "string" && banner.length > 0 ? banner : null;
}

/** Typed description of a raised post-terminal run-detail problem for surfaces
 * that must DEGRADE instead of failing the caller (MCP results, ACP turn
 * results, --json outcome projections): the finished run's result survives with
 * its runId, and this field discloses WHY its detail projections are absent.
 * The CLI's own terminal path keeps the raise (renderCliFailure, non-zero
 * exit) — there the run result IS the process outcome. */
export interface RunDetailProblem {
  code: string | null;
  message: string;
  retryable: boolean | null;
}

export function describeRunDetailProblem(error: unknown): RunDetailProblem {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  return {
    code: typeof record["code"] === "string" && record["code"] ? (record["code"] as string) : null,
    message: redactSecrets(error instanceof Error ? error.message : String(error)),
    retryable: typeof record["retryable"] === "boolean" ? (record["retryable"] as boolean) : null,
  };
}
