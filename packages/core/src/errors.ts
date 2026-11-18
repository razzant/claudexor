import type { RawContextShortfall } from "@claudexor/schema";
import type { ModelCatalogFailure } from "./adapter.js";

/**
 * Typed error hierarchy. We fail loudly: boundaries add context, preserve the
 * original cause, and never swallow-and-continue.
 */
export class ClaudexorError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

export class HarnessUnavailableError extends ClaudexorError {}

/** Whether repeating a failed catalog read can succeed: no answer, a timeout,
 * or a transient HTTP status. A missing or rejected credential and an unusable
 * answer stay failed until something changes. */
export function modelCatalogFailureRetryable(failure: ModelCatalogFailure): boolean {
  if (failure.cause === "network" || failure.cause === "timeout") return true;
  const status = failure.httpStatus ?? 0;
  return failure.cause === "http_status" && (status >= 500 || status === 408 || status === 429);
}

/** An explicit model whose authoritative live catalog read found no usable
 * credential or had it rejected (#393): refused with that typed cause, never
 * reported as absent. Only those causes refuse (`modelCatalogFailureRefuses`);
 * another failed read forwards the model unverified (owner decision A). */
export class ModelCatalogUnavailableError extends HarnessUnavailableError {
  readonly code = "model_catalog_unavailable";
  readonly category = "auth";
  readonly retryable = false;
  constructor(
    message: string,
    readonly failure: ModelCatalogFailure,
  ) {
    super(message);
  }
}
/** A route whose request must name a model has none (#395). Refused before anything
 * is sent; choosing a model repairs it, and no other model or route stands in. */
export class ModelSelectionRequiredError extends HarnessUnavailableError {
  readonly code = "model_selection_required";
  readonly category = "config_error";
  readonly retryable = false;
}
/** A final-route effort preference cannot be placed; changing routes cannot repair it. */
export class EffortPreferenceRejectedError extends ClaudexorError {
  readonly code = "effort_preference_rejected";
  readonly retryable = false;
}
export class ContextOverflowError extends ClaudexorError {}

/** An explicitly configured mandatory file is missing, unreadable or out of
 * bounds in the execution root. `code` is an OPEN-vocabulary refusal term for
 * the HTTP problem surfaces (ControlProblem/TurnEnqueueProblem). It is
 * deliberately NOT a `RunFailureCode`: a late Plan failure records category
 * `project` with `code: null`, because released strict readers parse the whole
 * RunFailure or drop it (precedent: `vendor_limit_rejected`). */
export class MandatoryContextUnavailableError extends ClaudexorError {
  readonly code = "mandatory_context_unavailable";
  readonly category = "project";
  readonly status = 409;
  readonly retryable = false;
  // A recorded turn can replay its params once the workspace has been repaired.
  readonly turnRetryable = true;
  readonly requiredActions = [
    "Check the required paths in project configuration and make the files readable inside the execution root before retrying.",
  ];
  constructor(
    readonly context: {
      executionRoot: string;
      unavailableFiles: { path: string; reason: string }[];
    },
  ) {
    const files = context.unavailableFiles.map(({ path, reason }) => `${path} (${reason})`);
    super(`mandatory context missing/unreadable in ${context.executionRoot}: ${files.join(", ")}`);
  }
}

/** A raw-api RawContextPacket that cannot be delivered as the project requires
 * (#147). It is refused before any request is sent; a retry cannot repair it.
 * An over-window refusal carries its typed sizes for the failure record. */
export class RawContextRefusalError extends ClaudexorError {
  readonly category: "project" | "validation";
  readonly retryable = false;
  constructor(
    readonly code: "raw_context_mandatory_unavailable" | "raw_context_exceeds_window",
    message: string,
    readonly rawContextShortfall?: RawContextShortfall,
  ) {
    super(message);
    this.category = code === "raw_context_exceeds_window" ? "validation" : "project";
  }
}
export class WorkspaceError extends ClaudexorError {}

/**
 * A known pre-start condition prevents construction of the Claudexor
 * delegation belt descriptor. Agent start may catch this exact typed error and
 * continue without Delegate while recording the durable degradation receipt;
 * errors after descriptor injection remain hard failures.
 */
export class DelegationBeltUnavailableError extends ClaudexorError {
  readonly code = "delegation_belt_unavailable";
  readonly status = 503;
}

/**
 * A run marked `execution.delegated` could not be assigned its scoped harness
 * HOME. The attempt refuses instead of degrading onto the operator's real home.
 */
export class DelegatedHomeUnavailableError extends ClaudexorError {
  readonly code = "delegated_home_unavailable";
  readonly category = "internal" as const;
}

/** A terminal mutating delegated run whose attempts do not all carry complete
 * applied HOME/access/profile/boundary-disclosure facts. */
export class DelegatedEvidenceIncompleteError extends ClaudexorError {
  readonly code = "delegated_evidence_incomplete";
  readonly category = "internal" as const;
}

/** A writable lane cannot natively apply the run's explicit auxiliary writable roots. */
export class AuxiliaryWritableRootsUnsupportedError extends ClaudexorError {
  readonly code = "auxiliary_writable_roots_unsupported";
  readonly category = "harness_unavailable" as const;
  readonly status = 400;
  readonly retryable = false;
  readonly requiredActions = [
    "Select a harness whose catalog row declares accessControl.auxiliaryWritableRoots, or omit execution.auxiliaryWritableRoots. For continueFrom, replace the complete execution group through POST /v2/runs (auxiliaryWritableRoots: [] clears it), or start a new run; claudexor_run_continue inherits execution.",
  ];
}

/** A requested access mode cannot be represented by the selected native adapter. */
export class AccessProfileIncompatibleError extends ClaudexorError {
  readonly code = "access_profile_incompatible";
  readonly category = "harness_unavailable" as const;
  readonly status = 400;
  readonly retryable = false;
  readonly requiredActions = [
    "Choose workspace_write on a compatible harness, or explicitly trust the repository and choose full.",
  ];
}
