import type { JobRecord } from "./server.js";

/** Select only expired terminal records; blocked commands remain operator-visible. */
export function prunableCommandIds(
  records: readonly JobRecord[],
  cap: number,
  retentionMs: number,
  now: number,
): string[] {
  const terminal = records.filter(
    (record) => !["running", "queued", "blocked"].includes(record.state),
  );
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
