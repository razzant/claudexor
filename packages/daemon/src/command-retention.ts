import type { JobRecord } from "./server.js";

export function productCommandRecords(records: readonly JobRecord[]): JobRecord[] {
  return records.filter(({ id }) => !id.startsWith("delivery-"));
}

/** A terminal run that still needs a human decision: its lifecycle SUCCEEDED
 * but the arbitrated facts are review-blocked or checks-failed. These carry the
 * same operator obligation the old coarse `blocked` job state did, so they must
 * survive age/cap pruning (otherwise the operator loses the run they need to
 * accept-risk / rerun before its evidence is gone). */
function isNeedsDecision(record: JobRecord): boolean {
  const result = record.result as { facts?: { review?: unknown; checks?: unknown } } | null;
  const facts = result && typeof result === "object" ? result.facts : undefined;
  if (!facts || typeof facts !== "object") return false;
  return facts.review === "blocked" || facts.checks === "failed";
}

/** Select only expired terminal records (D8: job state is the lifecycle;
 * non-terminal = queued/running). Needs-decision (review-blocked / checks-
 * failed) runs are EXEMPT — they keep operator visibility parity with the old
 * `blocked` retention and are never pruned by age/cap. */
export function prunableCommandIds(
  records: readonly JobRecord[],
  cap: number,
  retentionMs: number,
  now: number,
): string[] {
  const terminal = records.filter((record) => !["running", "queued"].includes(record.state));
  if (terminal.length <= cap) return [];
  return terminal
    .filter((record) => {
      if (isNeedsDecision(record)) return false;
      const settledAt = Date.parse(record.finishedAt ?? "");
      return Number.isFinite(settledAt) && now - settledAt >= retentionMs;
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    .slice(0, terminal.length - cap)
    .map((record) => record.id);
}
