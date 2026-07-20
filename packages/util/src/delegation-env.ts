/** Env var names the daemon injects to carry the delegation policy into the
 * `agent --delegate` belt process (`claudexor mcp serve-belt`). ONE owner for
 * the producer (the orchestrator/daemon that injects them) and the consumer (the
 * mcp-server belt that reads them). It lives in `@claudexor/util` — the lowest
 * package both already depend on — so the orchestrator never imports the
 * higher-layer `@claudexor/mcp-server` just for these names. */
export const DELEGATION_ENV = {
  parentRunId: "CLAUDEXOR_DELEGATION_PARENT_RUN_ID",
  depth: "CLAUDEXOR_DELEGATION_DEPTH",
  maxSubRuns: "CLAUDEXOR_DELEGATION_MAX_SUBRUNS",
  budget: "CLAUDEXOR_DELEGATION_BUDGET",
} as const;
