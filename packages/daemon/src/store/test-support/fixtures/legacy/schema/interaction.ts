import type { InteractionAnswerSet } from "./harness.js";

/** Internal answer-surface release with provenance. External integrations may
 * still return null as an unclassified decline; the daemon uses this tagged
 * form so its own expiry cannot be confused with run-terminal cleanup. */
export type InteractionHandlerRelease = {
  kind: "released";
  reason: "timeout" | "run_terminal" | "interrupted";
};

export type InteractionHandlerResult = InteractionAnswerSet | InteractionHandlerRelease | null;
