import type { JobRecord } from "./server.js";

export function productCommandRecords(records: readonly JobRecord[]): JobRecord[] {
  return records.filter(({ id }) => !id.startsWith("delivery-"));
}

/** Select only expired terminal records (D8: job state is the lifecycle;
 * non-terminal = queued/running). Needs-decision (review-blocked / checks-
 * failed) retention is keyed on the run FACTS in the control-plane retention
 * pass, not on the coarse job state here. */
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
      const settledAt = Date.parse(record.finishedAt ?? "");
      return Number.isFinite(settledAt) && now - settledAt >= retentionMs;
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    .slice(0, terminal.length - cap)
    .map((record) => record.id);
}
