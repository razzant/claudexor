import { parseCommandListQuery, selectCommandRecords } from "./command-list-select.js";
import { retainedEnvelopeOfRun } from "@claudexor/workspace";
import type { JobRecord } from "./job-record.js";
import { continuedRunOf, isHarnessMaintenanceOperation, isModelOperation } from "@claudexor/schema";

/** Agent run commands only: model and harness-maintenance operations are
 * commands without a run and have their own typed read surfaces. */
export function productCommandRecords(records: readonly JobRecord[]): JobRecord[] {
  return records.filter(
    (record) =>
      !record.id.startsWith("account-reset-") &&
      !isDeliveryCommand(record) &&
      !isModelOperation(record.params) &&
      !isHarnessMaintenanceOperation(record.params),
  );
}

/** Addressed selection is shared by socket reads and in-process consumers. */
export function selectProductCommands(records: readonly JobRecord[], query: unknown): JobRecord[] {
  const addressed = parseCommandListQuery(query);
  return selectCommandRecords(productCommandRecords(records), addressed);
}

/** Delivery commands persist the full run params of the apply they serve;
 * they keep their existing age/cap retention and are outside the byte budget. */
function isDeliveryCommand(record: JobRecord): boolean {
  return record.id.startsWith("delivery-");
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

/** Pure exemptions: keep custody addressable and claims while their predecessor is retained.
 * The input is the current kept set; if a predecessor is removed in this pass,
 * its successor becomes eligible on the next pass. No lifetime is invented. */
function continuationExemptions(records: readonly JobRecord[]): Set<string> {
  const identities = new Set(
    records.flatMap((record) => [record.id, ...(record.runId ? [record.runId] : [])]),
  );
  return new Set(
    records
      .filter((record) => {
        const predecessor = continuedRunOf(record.params);
        return (
          (predecessor !== null && identities.has(predecessor)) ||
          !!(record.runDir && record.runId && retainedEnvelopeOfRun(record.runDir, record.runId))
        );
      })
      .map((record) => record.id),
  );
}

/** Cap on the serialized `params` bytes retained across terminal product
 * commands (journal sprint owner decision D3, release 1). Prompts stay inline
 * in the command journal, so once their sum passes this bound the OLDEST
 * terminal product commands are pruned regardless of age; the 500/30-day rule
 * is unchanged. Model-operation receipts, needs-decision and continuation references are exempt;
 * delivery commands (`delivery-*`, which carry a copy of the applied run's
 * params) keep their own age/cap policy and neither count nor get pruned here. */
export const MAX_RETAINED_COMMAND_PARAMS_BYTES = 256 * 1024 * 1024;

/** Select only expired terminal records (D8: job state is the lifecycle;
 * non-terminal = queued/running). Needs-decision (review-blocked / checks-
 * failed) runs are EXEMPT — they keep operator visibility parity with the old
 * `blocked` retention and are never pruned by age/cap or by the byte budget. */
export function prunableCommandIds(
  records: readonly JobRecord[],
  cap: number,
  retentionMs: number,
  now: number,
  maxParamsBytes = MAX_RETAINED_COMMAND_PARAMS_BYTES,
): string[] {
  // Model bodies have their own custody lifetime. Their compact receipts and
  // idempotency keys survive it, and must not consume Agent history capacity.
  // Delivery commands retain their existing age/cap policy.
  const terminal = records
    .filter(
      (record) =>
        !record.id.startsWith("account-reset-") &&
        !isModelOperation(record.params) &&
        !["running", "queued"].includes(record.state),
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const pruned = new Set<string>();
  const continuation = continuationExemptions(records);
  const exempt = (record: JobRecord) => isNeedsDecision(record) || continuation.has(record.id);
  if (terminal.length > cap) {
    for (const record of terminal
      .filter((record) => {
        if (exempt(record)) return false;
        const settledAt = Date.parse(record.finishedAt ?? "");
        return Number.isFinite(settledAt) && now - settledAt >= retentionMs;
      })
      .slice(0, terminal.length - cap)) {
      pruned.add(record.id);
    }
  }
  // Byte budget over the PRODUCT commands that survive the age/cap rule,
  // oldest first. Only the records the rule can reach are counted: a
  // needs-decision run is exempt, a delivery command is outside the rule
  // (model receipts never enter `terminal`), so their params must not push
  // every reachable command out — the budget bounds exactly what it may prune.
  let bytes = 0;
  const sizes = new Map<string, number>();
  for (const record of terminal) {
    if (pruned.has(record.id) || exempt(record) || isDeliveryCommand(record)) continue;
    const size = paramsBytes(record);
    sizes.set(record.id, size);
    bytes += size;
  }
  for (const record of terminal) {
    if (bytes <= maxParamsBytes) break;
    const size = sizes.get(record.id);
    if (size === undefined) continue; // already pruned, or exempt
    pruned.add(record.id);
    bytes -= size;
  }
  return [...pruned];
}

/** Serialized UTF-8 size of a command's params, measured once: params are
 * pinned at acceptance (`update()` keeps the same object), so the size keyed by
 * that object never goes stale, and a prune pass never re-serializes history. */
const paramsByteCache = new WeakMap<object, number>();

function paramsBytes(record: JobRecord): number {
  const params = record.params;
  const cacheable = typeof params === "object" && params !== null;
  if (cacheable) {
    const known = paramsByteCache.get(params);
    if (known !== undefined) return known;
  }
  let size = 0;
  try {
    const serialized = JSON.stringify(params);
    size = serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
  } catch {
    size = 0;
  }
  if (cacheable) paramsByteCache.set(params, size);
  return size;
}
