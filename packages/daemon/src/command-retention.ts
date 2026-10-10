import type { JobRecord } from "./job-record.js";

/** A terminal run that still needs a human decision: its lifecycle SUCCEEDED
 * but the arbitrated facts are review-blocked or checks-failed. These carry the
 * same operator obligation the old coarse `blocked` job state did, so they must
 * survive age/cap pruning (otherwise the operator loses the run they need to
 * accept-risk / rerun before its evidence is gone). */
export function isNeedsDecision(record: JobRecord): boolean {
  const result = record.result as { facts?: { review?: unknown; checks?: unknown } } | null;
  const facts = result && typeof result === "object" ? result.facts : undefined;
  if (!facts || typeof facts !== "object") return false;
  return facts.review === "blocked" || facts.checks === "failed";
}
