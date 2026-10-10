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
/** A final-route effort preference cannot be placed; changing routes cannot repair it. */
export class EffortPreferenceRejectedError extends ClaudexorError {
  readonly code = "effort_preference_rejected";
  readonly retryable = false;
}
export class ContextOverflowError extends ClaudexorError {}
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
