import { GcKeepCounts, GcLastPass, type ControlGcReceipt, type GcHold } from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import type { EngineStore } from "@claudexor/daemon";
import { finalizeRetention, type RetentionRunner } from "./retention-lifetime.js";

const KEY = "retention_last_pass";

function passHistory(
  outcome: GcLastPass["outcome"],
  finishedAt: string,
  previous: GcLastPass | null,
) {
  return {
    last_completed_at:
      outcome === "completed"
        ? finishedAt
        : (previous?.last_completed_at ??
          (previous?.outcome === "completed" ? previous.finished_at : null)),
    failed_or_held_streak:
      outcome === "completed"
        ? 0
        : (previous?.failed_or_held_streak ?? 0) +
          (outcome === "failed" || outcome === "held" ? 1 : 0),
  };
}

export function readLastRetention(
  store: EngineStore,
  onUnreadable?: (diagnostic: string) => void,
): GcLastPass | null {
  const row = store.prepare("SELECT value FROM meta WHERE key=?").get(KEY) as
    { value: string } | undefined;
  if (!row) return null;
  let value: unknown;
  try {
    value = JSON.parse(row.value);
  } catch {
    // Invalid JSON and invalid schema both represent unavailable evidence.
  }
  const parsed = GcLastPass.safeParse(value);
  if (parsed.success) return parsed.data;
  onUnreadable?.("Stored retention summary is unreadable; a new pass will replace it.");
  return null;
}

function summarize(
  startedAt: string,
  receipt: ControlGcReceipt | undefined,
  failure: unknown,
  failed: boolean,
  cancelled: boolean,
  inventoryObserved: boolean,
  previous: GcLastPass | null,
): GcLastPass {
  const holds = new Map<GcHold["class"], GcHold>();
  for (const hold of (inventoryObserved ? receipt?.holds : previous?.holds) ?? []) {
    const existing = holds.get(hold.class);
    if (existing) existing.count += hold.count;
    else holds.set(hold.class, { ...hold });
  }
  const errors = [...(receipt?.errors ?? []), ...(failed ? [String(failure)] : [])];
  const held = {
    ...((inventoryObserved ? receipt?.held : previous?.held) ?? { roots: 0, native_homes: 0 }),
  };
  // A partial pass cannot prove that a hold evaluated later has cleared.
  if (cancelled || receipt?.truncated) {
    for (const hold of previous?.holds ?? [])
      if (!holds.has(hold.class)) holds.set(hold.class, { ...hold });
    held.roots = Math.max(held.roots, previous?.held.roots ?? 0);
    held.native_homes = Math.max(held.native_homes, previous?.held.native_homes ?? 0);
  }
  const outcome = cancelled
    ? "truncated"
    : failed
      ? "failed"
      : receipt?.truncated
        ? "truncated"
        : holds.size || held.roots || held.native_homes
          ? "held"
          : errors.length
            ? "failed"
            : "completed";
  const finishedAt = new Date().toISOString();
  return GcLastPass.parse({
    outcome,
    started_at: startedAt,
    finished_at: finishedAt,
    ...passHistory(outcome, finishedAt, previous),
    freed_bytes: receipt?.freed_bytes ?? 0,
    // Without a receipt, or with a deletion that stopped partway, nothing was fully
    // measured; never a claim that nothing happened.
    effects: receipt ? (receipt.effects ?? "measured") : "unknown",
    kept: receipt?.kept ?? GcKeepCounts.parse({}),
    held,
    holds: [...holds.values()].map((hold) => ({
      ...hold,
      example: redactSecrets(hold.example).slice(0, 160),
      since: previous?.holds.find((prior) => prior.class === hold.class)?.since ?? startedAt,
    })),
    errors: {
      count: errors.length,
      first: errors[0] === undefined ? null : redactSecrets(errors[0]).slice(0, 512),
    },
  });
}

function writeLastRetention(store: EngineStore, record: GcLastPass): void {
  const value = JSON.stringify(record);
  if (Buffer.byteLength(value) > 16 * 1024) throw new Error("retention summary exceeds 16 KiB");
  store.transaction(() => {
    store
      .prepare(
        "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(KEY, value);
  });
}

/** Outermost composition: finalization runs after every cleanup, even a throw,
 * and remains in the cancellation drain through the store's durability barrier. */
export function recordLastRetention(run: RetentionRunner, store: EngineStore): RetentionRunner {
  return finalizeRetention(run, async (request, result) => {
    if (request.dry_run) return;
    const previous = readLastRetention(store);
    const record = summarize(
      result.startedAt,
      result.receipt,
      result.error,
      result.failed,
      result.cancelled,
      result.inventoryObserved,
      previous,
    );
    writeLastRetention(store, record);
    try {
      await store.flushed();
    } catch (error) {
      // The SQL commit may be readable despite a failed power-loss barrier.
      // Do not leave that attempt looking completed to GET while propagating
      // failure to POST. This diagnostic write cannot promise durability either.
      record.outcome = "failed";
      record.finished_at = new Date().toISOString();
      Object.assign(record, passHistory("failed", record.finished_at, previous));
      record.errors.count += 1;
      record.errors.first ??= redactSecrets(String(error)).slice(0, 512);
      try {
        writeLastRetention(store, record);
      } catch {
        // Preserve the original persistence failure, even if storage is closed.
      }
      throw error;
    }
  });
}
