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
export class ContextOverflowError extends ClaudexorError {}
export class WorkspaceError extends ClaudexorError {}

/**
 * The Claudexor delegation belt (D32) cannot be made operational for this run:
 * no `cli.js` entry that hosts `mcp serve-belt` exists next to the launching
 * process OR this module. Emitting the belt descriptor anyway would spawn
 * `node <missing cli.js> mcp serve-belt`, which MODULE_NOT_FOUNDs inside the
 * harness — the belt reports `failed`, the harness silently answers from its
 * own native subagent, and the run terminalizes a false success (QA-024). We
 * refuse TYPED at preflight instead, naming the probed entry and the remedy.
 */
export class DelegationBeltUnavailableError extends ClaudexorError {}
