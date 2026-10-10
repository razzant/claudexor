import type { AccessProfile, ModeKind } from "./primitives.js";

export interface RunReviewRequest {
  mode?: ModeKind;
  review?: boolean;
  n?: number;
  attempts?: number | null;
  untilClean?: boolean;
  reviewerPanel?: unknown;
  reviewerModels?: unknown;
  reviewerEfforts?: unknown;
}

/** Resolve review intent independently of executor routing. Persist the result
 * at acceptance; historical requests must use restoreRecordedRunReviewRequest. */
export function resolveRunReviewRequested(value: RunReviewRequest): boolean {
  if ((value.mode ?? "agent") !== "agent") return false;
  return (
    value.review ??
    (hasArrayEntries(value.reviewerPanel) ||
      hasRecordEntries(value.reviewerModels) ||
      hasRecordEntries(value.reviewerEfforts) ||
      (value.n ?? 1) > 1 ||
      value.untilClean === true ||
      value.attempts != null)
  );
}

/** Absence on a previously accepted Agent means the historical review-on
 * contract. Never apply the new ordinary-run default to a replay. */
export function restoreRecordedRunReviewRequest<T extends RunReviewRequest>(value: T): T {
  return (value.mode ?? "agent") === "agent" && value.review === undefined
    ? { ...value, review: true }
    : value;
}

/**
 * Resolve the requested/effective access pair once for every run producer.
 * Ask and Plan clamp to readonly; Agent inherits the configured default only
 * when the caller omitted an explicit access profile.
 */
export function resolveRunAccess(
  value: { mode?: ModeKind; access?: AccessProfile },
  accessDefault: AccessProfile,
): { requested: AccessProfile; effective: AccessProfile } {
  const mode = value.mode ?? "agent";
  const readOnlyMode = mode === "ask" || mode === "plan";
  const requested = value.access ?? (readOnlyMode ? "readonly" : accessDefault);
  return {
    requested,
    effective: readOnlyMode ? "readonly" : requested,
  };
}

export interface RunAccessStrategyViolation {
  code: "strategy_access_incompatible";
  message: string;
  retryable: false;
  requiredActions: readonly [string];
}

export interface RunExecutionWorkspaceViolation {
  code: "execution_workspace_required";
  message: string;
  retryable: false;
  requiredActions: readonly [string];
}

/**
 * Where `execution.workspaceRoot` is a real execution address: a project-scoped
 * delegated run that executes the Agent live (or copies/reads its explicit
 * directory footprint from there), or a read-only Ask/Plan that reads it — the
 * shape a delegated thread records for every turn. Elsewhere it would be a
 * dead knob or a silent redirect, so the shared normalizer refuses it.
 */
export function runExecutionWorkspaceRootAllowed(value: {
  mode?: ModeKind;
  scope?: { kind: string };
  execution?: {
    isolation?: "envelope" | "live";
    delegated?: boolean;
    workspaceKind?: "git" | "directory";
  };
}): boolean {
  if (value.scope?.kind !== "project" || value.execution?.delegated !== true) return false;
  const mode = value.mode ?? "agent";
  if (mode !== "agent") return true;
  return value.execution.isolation === "live" || value.execution.workspaceKind === "directory";
}

/**
 * A fresh delegated live write must name the caller-owned execution tree.
 * Exact Retry may replay the bounded historical shape whose stable scope root
 * was itself the frozen execution tree.
 */
export function runExecutionWorkspaceViolation(
  value: {
    mode?: ModeKind;
    retryOf?: string | null;
    execution?: {
      isolation?: "envelope" | "live";
      delegated?: boolean;
      workspaceRoot?: string;
    };
  },
  effectiveAccess: AccessProfile,
): RunExecutionWorkspaceViolation | null {
  if (
    effectiveAccess !== "readonly" &&
    (value.mode ?? "agent") === "agent" &&
    value.execution?.delegated === true &&
    value.execution.isolation === "live" &&
    value.execution.workspaceRoot === undefined &&
    !value.retryOf
  ) {
    return {
      code: "execution_workspace_required",
      message:
        "execution.workspaceRoot is required for a new delegated live run with mutating access",
      retryable: false,
      requiredActions: [
        "Provide execution.workspaceRoot as an absolute existing directory for this delegated live run.",
      ],
    };
  }
  return null;
}

/** Write-backed strategy controls cannot honestly run under readonly access. */
export function runAccessStrategyViolation(
  value: { attempts?: number | null; untilClean?: boolean; tests?: readonly unknown[] | null },
  effectiveAccess: AccessProfile,
): RunAccessStrategyViolation | null {
  const convergence =
    value.untilClean === true || (value.attempts !== undefined && value.attempts !== null);
  const gates = (value.tests?.length ?? 0) > 0;
  if (effectiveAccess === "readonly" && (convergence || gates)) {
    return {
      code: "strategy_access_incompatible",
      message:
        "readonly access cannot use write-backed controls (attempts/untilClean/tests); drop those controls or choose workspace_write/full",
      retryable: false,
      requiredActions: ["Drop attempts/untilClean/tests, or choose workspace_write/full access."],
    };
  }
  return null;
}

export interface RunControlApplicabilityItem {
  applicable: boolean;
  reason?: string;
}

export interface RunControlApplicability {
  reviewerPanel: RunControlApplicabilityItem;
  protectedPathApprovals: RunControlApplicabilityItem;
}

const REVIEWER_UNAVAILABLE_REASON =
  "Reviewer controls only apply to Agent runs; Council is the Plan critique path.";
const APPROVAL_UNAVAILABLE_REASON =
  "Protected-path approvals only apply to Agent runs; Ask and Plan are read-only.";

/**
 * Focused applicability owner for the two run-control families that authorize
 * Agent review/change behavior. Surfaces project this result; they do not
 * independently infer mode applicability from read-only labels or UI layout.
 */
export function runControlApplicability(value: { mode?: ModeKind }): RunControlApplicability {
  const applicable = (value.mode ?? "agent") === "agent";
  return {
    reviewerPanel: applicable
      ? { applicable: true }
      : { applicable: false, reason: REVIEWER_UNAVAILABLE_REASON },
    protectedPathApprovals: applicable
      ? { applicable: true }
      : { applicable: false, reason: APPROVAL_UNAVAILABLE_REASON },
  };
}

/** Mode/strategy coherence (D11): meaningless flag combinations are refused
 * at every wire boundary instead of being silently ignored. ONE owner — the
 * control-api normalization funnel throws these as 400s; kept beside the
 * schema (not baked in as a union) so `.omit`/`.shape` consumers survive. */
export function runStartStrategyViolations(value: {
  mode?: ModeKind;
  review?: boolean;
  deepScan?: boolean;
  untilClean?: boolean;
  attempts?: number | null;
  create?: boolean;
  council?: boolean;
  n?: number;
  delegate?: boolean;
  reviewerPanel?: unknown;
  reviewerModels?: unknown;
  reviewerEfforts?: unknown;
  protectedPathApprovals?: unknown;
  synthesis?: unknown;
  tests?: unknown;
  denyPaths?: unknown;
  outputSchema?: unknown;
}): string[] {
  const mode = value.mode ?? "agent";
  const violations: string[] = [];
  if (value.review !== undefined && mode !== "agent") {
    violations.push(`review only applies to agent runs; mode is '${mode}'`);
  }
  if (
    value.review === false &&
    (hasArrayEntries(value.reviewerPanel) ||
      hasRecordEntries(value.reviewerModels) ||
      hasRecordEntries(value.reviewerEfforts) ||
      (value.n ?? 1) > 1 ||
      value.untilClean === true)
  ) {
    violations.push(
      "review=false conflicts with explicit reviewer controls, best-of, or untilClean",
    );
  }
  if (value.deepScan === true && mode !== "ask") {
    violations.push(`deepScan is an ask strategy; mode is '${mode}'`);
  }
  if (value.untilClean === true && mode !== "agent") {
    violations.push(`untilClean is an agent strategy; mode is '${mode}'`);
  }
  if (value.attempts != null && mode !== "agent") {
    violations.push(`attempts is an agent strategy; mode is '${mode}'`);
  }
  if (value.create === true && mode !== "agent") {
    violations.push(`create is an agent strategy; mode is '${mode}'`);
  }
  // Council (INV-031) is a PLAN strategy: N harnesses draft in parallel, the
  // primary merges into one plan + one question set. The configured maximum is
  // startup-owned and therefore checked by the daemon runner, not this
  // transport-only coherence validator.
  if (value.council === true && mode !== "plan") {
    violations.push(`council is a plan strategy; mode is '${mode}'`);
  }
  // `n` widens best-of (agent), deep-scan (ask), or council membership (plan).
  // On a PLAIN plan run (no council) it is meaningless and refused; council is
  // the one flag that legalizes `n` on a plan.
  const nLegal =
    mode === "agent" ||
    (mode === "ask" && value.deepScan === true) ||
    (mode === "plan" && value.council === true);
  if (value.n !== undefined && !nLegal) {
    violations.push(
      mode === "plan"
        ? `n sets council membership width on a plan run; pass --council (mode is 'plan' without council)`
        : `n sets the best-of race width (agent) or deep-scan width (ask); mode is '${mode}'`,
    );
  }
  if (value.council === true && value.n !== undefined && value.n < 2) {
    violations.push(`council membership n must be at least 2 (got ${value.n})`);
  }
  if (value.delegate === true && mode !== "agent") {
    violations.push(`delegate is an agent strategy; mode is '${mode}'`);
  }
  const applicability = runControlApplicability({ mode });
  if (value.reviewerPanel !== undefined && !applicability.reviewerPanel.applicable) {
    violations.push(
      `reviewerPanel only applies to agent runs (plan review was retired in v3; Council is the plan critique path); mode is '${mode}'`,
    );
  }
  if (hasRecordEntries(value.reviewerModels) && !applicability.reviewerPanel.applicable) {
    violations.push(
      `reviewerModels only applies to agent runs (plan review was retired in v3; Council is the plan critique path); mode is '${mode}'`,
    );
  }
  if (hasRecordEntries(value.reviewerEfforts) && !applicability.reviewerPanel.applicable) {
    violations.push(
      `reviewerEfforts only applies to agent runs (plan review was retired in v3; Council is the plan critique path); mode is '${mode}'`,
    );
  }
  if (
    hasArrayEntries(value.protectedPathApprovals) &&
    !applicability.protectedPathApprovals.applicable
  ) {
    violations.push(
      `protectedPathApprovals only applies to agent runs (read-only modes do not change protected paths); mode is '${mode}'`,
    );
  }
  if (value.synthesis !== undefined && mode !== "agent") {
    violations.push(`synthesis only applies to agent best-of runs; mode is '${mode}'`);
  }
  if (value.tests !== undefined && mode !== "agent") {
    violations.push(`tests only applies to agent runs; mode is '${mode}'`);
  }
  if (value.denyPaths !== undefined && mode !== "agent") {
    violations.push(`denyPaths only applies to agent runs; mode is '${mode}'`);
  }
  if (value.outputSchema !== undefined && mode === "plan") {
    violations.push(`outputSchema applies to agent/ask runs, not plan runs`);
  }
  return violations;
}

function hasRecordEntries(value: unknown): boolean {
  return (
    !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0
  );
}

function hasArrayEntries(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/**
 * Whether this run shape needs a Git-backed workspace before a provider can
 * start. Read-only runs never require Git; an already-materialized durable
 * thread worktree can be read directly without provisioning it. Agent
 * race/create/single always do; the one existing non-Git write
 * path is live convergence, whose copy-baseline workspace is explicitly
 * implemented by the engine.
 */
export function runStartRequiresGit(
  value: {
    mode?: ModeKind;
    access?: AccessProfile;
    untilClean?: boolean;
    attempts?: number | null;
    execution?: { isolation?: "envelope" | "live"; workspaceKind?: "git" | "directory" };
  },
  context: {
    effectiveWorkspaceRequiresGit?: boolean;
    accessDefault?: AccessProfile;
    effectiveAccess?: AccessProfile;
  } = {},
): boolean {
  const effectiveAccess =
    context.effectiveAccess ??
    resolveRunAccess(value, context.accessDefault ?? "workspace_write").effective;
  if (effectiveAccess === "readonly") return false;
  if (value.execution?.workspaceKind === "directory") return false;
  // A thread may execute "live" *inside a worktree*: isolated threads and
  // protected-path promotion are resolved by the daemon from durable thread /
  // project state, not from the wire isolation flag. That effective workspace
  // must win over the convergence exception below, because creating/reusing it
  // requires Git before any provider can start.
  if (context.effectiveWorkspaceRequiresGit === true) return true;
  if ((value.mode ?? "agent") !== "agent") return false;
  const convergence = value.untilClean === true || value.attempts != null;
  return !(convergence && value.execution?.isolation === "live");
}
