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

export class AdapterParseError extends ClaudexorError {}
export class HarnessUnavailableError extends ClaudexorError {}
export class ConformanceError extends ClaudexorError {}
export class PolicyDeniedError extends ClaudexorError {}
export class BudgetExhaustedError extends ClaudexorError {}
export class ReviewStaleError extends ClaudexorError {}
export class ContextOverflowError extends ClaudexorError {}
export class SecretExposureRiskError extends ClaudexorError {}
export class WorkspaceError extends ClaudexorError {}
