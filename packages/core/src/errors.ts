/**
 * Typed error hierarchy. We fail loudly: boundaries add context, preserve the
 * original cause, and never swallow-and-continue.
 */
export class ClaudexError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

export class AdapterParseError extends ClaudexError {}
export class HarnessUnavailableError extends ClaudexError {}
export class ConformanceError extends ClaudexError {}
export class PolicyDeniedError extends ClaudexError {}
export class BudgetExhaustedError extends ClaudexError {}
export class ReviewStaleError extends ClaudexError {}
export class ContextOverflowError extends ClaudexError {}
export class SecretExposureRiskError extends ClaudexError {}
export class WorkspaceError extends ClaudexError {}
