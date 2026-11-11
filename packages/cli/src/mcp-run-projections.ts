import {
  ControlRetainedEnvelope,
  DeferredMessageProjection,
  Id,
  isTerminalLifecycle,
  RunContinuityReceipt,
  RunFactsInvalidError,
  RunResumable,
  ObjectResultDisclosure,
  SecretLikeDisclosure,
  type RunOutcomeFacts,
} from "@claudexor/schema";
import { CliError } from "./cli-error.js";
import {
  describeRunDetailProblem,
  projectApplyEligibility,
  projectOutcomeBanner,
  presentRunPrimaryOutput,
  projectRunFailure,
  projectRunCouncil,
  projectRunLineage,
  projectRunPrimaryOutput,
  projectRunSpendUsd,
  projectRunControllableSpendUsd,
} from "./run-detail-projections.js";
import { projectRunOutcomeFacts } from "./daemon-outcome.js";
import { projectRunFacts, type ExpectedRunFactsIdentity } from "./run-facts-projection.js";

export function projectImmediateRunDetail(
  detail: Record<string, unknown> | null,
  expected: ExpectedRunFactsIdentity = {},
) {
  return {
    attemptExecution: detail?.["attemptExecution"],
    deferredMessage: DeferredMessageProjection.nullable().parse(
      detail?.["deferredMessage"] ?? null,
    ),
    runFacts: projectRunFacts(detail, expected),
    outcomeFacts: projectRunOutcomeFacts(detail),
    applyEligibility: projectApplyEligibility(detail),
    spendUsd: projectRunSpendUsd(detail),
    controllableSpendUsd: projectRunControllableSpendUsd(detail),
    council: projectRunCouncil(detail),
    outcomeBanner: projectOutcomeBanner(detail),
    planReadiness:
      detail?.["planReadiness"] && typeof detail["planReadiness"] === "object"
        ? detail["planReadiness"]
        : null,
    failure: projectRunFailure(detail),
    ...projectRunLineage(detail),
  };
}

/**
 * Historical disclosure as a consumable fact: runs written under the retired
 * INV-062 masked their saved copies and recorded what they hid in
 * `workProduct.meta.secret_like`. Current runs save exact bytes (INV-146) and
 * record nothing, so this is null for them (and for an absent/malformed record).
 */
export function projectSecretLikeDisclosure(
  detail: Record<string, unknown> | null,
): SecretLikeDisclosure | null {
  const meta = (detail?.["workProduct"] as { meta?: Record<string, unknown> } | null | undefined)
    ?.meta;
  const finding = meta?.["secret_like"] as Record<string, unknown> | undefined;
  const redactedCopy = meta?.["persisted_patch"] === "redacted";
  if (!finding && !redactedCopy) return null;
  const parsed = SecretLikeDisclosure.safeParse({
    totalMatches: finding?.["total_matches"] ?? 0,
    answerMatches: finding?.["answer_matches"] ?? 0,
    files: finding?.["files"] ?? [],
    binaryPaths: finding?.["binary_paths"] ?? [],
    mediaWithheld: finding?.["media_withheld"] ?? [],
    persistedPatch: redactedCopy ? "redacted" : "exact",
    exactPatchRecorded: redactedCopy ? typeof meta?.["exact_patch_object"] === "string" : null,
  });
  return parsed.success ? parsed.data : null;
}

/** #535 object result as a consumable fact (from `workProduct.meta`); null without one. */
export function projectObjectResultDisclosure(
  detail: Record<string, unknown> | null,
): ObjectResultDisclosure | null {
  const meta = (detail?.["workProduct"] as { meta?: Record<string, unknown> } | null | undefined)
    ?.meta;
  const result = meta?.["git_result"] as { digest?: unknown } | undefined;
  if (!result) return null;
  const view = meta?.["patch_view"] as Record<string, unknown> | undefined;
  const inventory = meta?.["change_inventory"] as { changedFiles?: unknown } | undefined;
  const unavailable = view?.["available"] === false;
  const parsed = ObjectResultDisclosure.safeParse({
    digest: result.digest,
    patchView: unavailable ? "unavailable" : "rendered",
    reason: unavailable ? (view?.["reason"] ?? null) : null,
    estimatedBytes: unavailable ? (view?.["estimatedBytes"] ?? null) : null,
    changedFiles: unavailable ? (inventory?.changedFiles ?? null) : null,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * The canonical run id of an addressed detail. A job handle remains usable
 * after the daemon binds its run, and then converges on that run id; any
 * other identity is a service fault, never a silent substitution.
 */
export function canonicalRunId(requested: string, rawSummary: unknown): string {
  const summary = (rawSummary ?? {}) as Record<string, unknown>;
  if (summary["runId"] === requested) return requested;
  if (summary["jobId"] === requested && typeof summary["runId"] === "string")
    return summary["runId"];
  throw new CliError(
    "operational",
    `run detail identity does not match requested run ${requested}`,
    {
      code: "invalid_service_response",
      retryable: true,
    },
  );
}

/** Continuation facts verbatim; a key the detail does not carry stays unknown (omitted). */
function projectContinuationFacts(summary: Record<string, unknown>): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  const continueFrom = Id.nullable().safeParse(summary["continueFrom"]);
  if ("continueFrom" in summary && continueFrom.success) facts["continueFrom"] = continueFrom.data;
  const resumable = RunResumable.nullable().safeParse(summary["resumable"]);
  if ("resumable" in summary && resumable.success) facts["resumable"] = resumable.data;
  const continuity = RunContinuityReceipt.array().safeParse(summary["continuity"]);
  if (continuity.success) facts["continuity"] = continuity.data;
  const retained = ControlRetainedEnvelope.nullable().safeParse(summary["retainedEnvelope"]);
  if ("retainedEnvelope" in summary && retained.success) facts["retainedEnvelope"] = retained.data;
  return facts;
}

/** One typed read projection for inspect/status/result from a single detail snapshot. */
export function projectRecoveryRunDetail(
  mode: string,
  requestedRunId: string,
  detail: Record<string, unknown>,
  delegationParentRunId?: string,
): Record<string, unknown> {
  const summary = (detail["summary"] ?? {}) as Record<string, unknown>;
  const runId = canonicalRunId(requestedRunId, summary);
  if (
    delegationParentRunId !== undefined &&
    summary["delegatedFromRunId"] !== delegationParentRunId
  ) {
    throw Object.assign(new Error(`run ${runId} is not a child of this delegation parent`), {
      code: "delegation_child_scope_violation",
      status: 403,
    });
  }
  const decision = (detail["decision"] ?? null) as Record<string, unknown> | null;
  const status =
    (typeof summary["state"] === "string" ? summary["state"] : null) ??
    (typeof summary["status"] === "string" ? summary["status"] : null) ??
    null;
  const runFacts =
    status === "queued" || status === "running"
      ? null
      : projectRunFacts(detail, {
          runId,
          ...(status && isTerminalLifecycle(status)
            ? { lifecycle: status as RunOutcomeFacts["lifecycle"] }
            : {}),
        });
  const base = {
    attemptExecution: detail["attemptExecution"],
    runId,
    runDir: typeof summary["runDir"] === "string" ? summary["runDir"] : null,
    status,
    runFacts,
    decisionStatus: decision ? ((decision["status"] as string | null) ?? null) : null,
    pendingInteractions: Array.isArray(detail["pendingInteractions"])
      ? (detail["pendingInteractions"] as unknown[]).length
      : null,
    outcomeFacts: projectRunOutcomeFacts(detail),
    outcomeBanner: typeof detail["outcomeBanner"] === "string" ? detail["outcomeBanner"] : null,
    applyEligibility: detail["applyEligibility"] ?? null,
    planReadiness: detail["planReadiness"] ?? null,
    council: detail["council"] && typeof detail["council"] === "object" ? detail["council"] : null,
    budget: detail["budget"] && typeof detail["budget"] === "object" ? detail["budget"] : null,
    failure: projectRunFailure(detail),
    parentRunId: typeof summary["parentRunId"] === "string" ? summary["parentRunId"] : null,
    delegatedFromRunId:
      typeof summary["delegatedFromRunId"] === "string" ? summary["delegatedFromRunId"] : null,
    delegation:
      summary["delegation"] && typeof summary["delegation"] === "object"
        ? summary["delegation"]
        : null,
    ...projectContinuationFacts(summary),
    secretLike: projectSecretLikeDisclosure(detail),
    objectResult: projectObjectResultDisclosure(detail),
    deferredMessage: DeferredMessageProjection.nullable().parse(detail["deferredMessage"] ?? null),
  };
  if (mode !== "__run_result") {
    return {
      summary:
        typeof detail["finalSummary"] === "string" && detail["finalSummary"]
          ? detail["finalSummary"]
          : `run ${runId}: ${String(status ?? "unknown")}`,
      ...base,
    };
  }
  const primary = projectRunPrimaryOutput(detail);
  const presented = presentRunPrimaryOutput(primary);
  const primaryKind = primary?.kind ?? null;
  const outcomeBanner = projectOutcomeBanner(detail);
  const terminalSummary =
    presented && primaryKind !== "patch"
      ? presented
      : outcomeBanner
        ? outcomeBanner
        : typeof detail["finalSummary"] === "string" && detail["finalSummary"]
          ? detail["finalSummary"]
          : primaryKind === "patch"
            ? "patch produced (see artifact handles)"
            : `run ${runId}: ${String(status ?? "unknown")}`;
  return { summary: terminalSummary, ...base };
}

/** Only canonical detail-integrity failures preserve a public recovery handle. */
export function isRecoverableRunDetailIntegrityProblem(error: unknown): boolean {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const code = record["code"];
  if (code !== "run_facts_invalid" && code !== "invalid_service_response") return false;
  if (typeof record["mcpRecoveryTypedControlProblem"] === "boolean") {
    return record["mcpRecoveryTypedControlProblem"] === true;
  }
  return error instanceof RunFactsInvalidError || error instanceof CliError;
}

/** Minimal schema-valid handle when public recovery cannot trust run detail. */
export function projectDegradedRecoveryRunDetail(
  runId: string,
  error: unknown,
): Record<string, unknown> {
  return {
    summary: `run ${runId}: detail unavailable`,
    runId,
    runDir: null,
    status: null,
    runFacts: null,
    decisionStatus: null,
    pendingInteractions: null,
    outcomeFacts: null,
    failure: null,
    outcomeBanner: null,
    applyEligibility: null,
    planReadiness: null,
    council: null,
    budget: null,
    parentRunId: null,
    delegatedFromRunId: null,
    delegation: null,
    secretLike: null,
    objectResult: null,
    detailProblem: describeRunDetailProblem(error),
  };
}
