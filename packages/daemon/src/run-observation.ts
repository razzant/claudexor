import { createHash } from "node:crypto";
import { setImmediate as yieldToAdmission } from "node:timers/promises";
import {
  RunObservationRecord,
  type RunWaitManyBlockingSummary,
  type RunWaitManySummary,
} from "@claudexor/schema";
import { digestPendingIdentities, type InteractionRegistry } from "./interactions.js";
import type { CommandQueries, PendingIdentityDigest } from "./store-contracts.js";
import { StoreError } from "./store/errors.js";

/** Body-free observation token: a digest of the observed facts. */
function observationToken(facts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(facts)).digest("base64url");
}

function unavailable(
  problem: "not_found" | "snapshot_unavailable" | "not_observed",
): RunWaitManySummary {
  return { status: null, pending: null, token: null, problem };
}

/** A caller that asks adds the blocking fact to rows with pending questions;
 * every other row, and every row of a caller that does not ask, is unchanged. */
export interface RunObservationOptions {
  includeBlocking?: boolean;
}

type Queries = Pick<CommandQueries, "observationRecords">;
type Interactions = Pick<InteractionRegistry, "snapshotPendingIdentities">;

/** One body-free snapshot pass. It preserves caller positions, not a globally
 * atomic history; only completed observations replace not_observed rows. */
export function readRunObservations(
  queries: Queries,
  interactions: Interactions,
  storeId: string,
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<RunWaitManySummary[]>;
export function readRunObservations(
  queries: Queries,
  interactions: Interactions,
  storeId: string,
  ids: readonly string[],
  signal: AbortSignal | undefined,
  options?: RunObservationOptions,
): Promise<Array<RunWaitManySummary | RunWaitManyBlockingSummary>>;
export async function readRunObservations(
  queries: Queries,
  interactions: Interactions,
  storeId: string,
  ids: readonly string[],
  signal?: AbortSignal,
  options: RunObservationOptions = {},
): Promise<Array<RunWaitManySummary | RunWaitManyBlockingSummary>> {
  const requested = [...ids];
  const summaries: Array<RunWaitManySummary | RunWaitManyBlockingSummary> = requested.map(() =>
    unavailable("not_observed"),
  );
  if (signal?.aborted) return summaries;
  const select = queries.observationRecords;
  if (!select)
    throw new StoreError(
      "run_observation_unavailable",
      503,
      false,
      "body-free command observation unavailable",
    );
  let records: RunObservationRecord[];
  try {
    records = select.call(queries, [...new Set(requested)]);
  } catch (error) {
    if (signal?.aborted) return summaries;
    throw error;
  }
  if (signal?.aborted) return summaries;

  const byJob = new Map<string, RunObservationRecord | null>();
  const byRun = new Map<string, RunObservationRecord | null>();
  const runIds = new Set<string>();
  for (let i = 0; i < records.length; i++) {
    if (i > 0 && i % 64 === 0) await yieldToAdmission();
    if (signal?.aborted) return summaries;
    const raw = records[i]!;
    const parsed = RunObservationRecord.safeParse(raw);
    const record = parsed.success ? parsed.data : null;
    // Keep a malformed row's addresses so it is unknown, never a fabricated miss.
    byJob.set(raw.jobId, record);
    if (raw.runId !== null) byRun.set(raw.runId, record);
    if (record && record.runId !== null) runIds.add(record.runId);
  }

  let snapshots = new Map<string, PendingIdentityDigest | Error>();
  try {
    if (runIds.size)
      snapshots = await (signal
        ? interactions.snapshotPendingIdentities([...runIds], signal)
        : interactions.snapshotPendingIdentities([...runIds]));
  } catch (error) {
    if (signal?.aborted) return summaries;
    throw error;
  }
  const empty = digestPendingIdentities([]);
  for (let i = 0; i < requested.length; i++) {
    if (i > 0 && i % 64 === 0) await yieldToAdmission();
    if (signal?.aborted) break;
    const id = requested[i]!;
    const record = byJob.has(id) ? byJob.get(id) : byRun.get(id);
    if (record === undefined) {
      summaries[i] = unavailable("not_found");
      continue;
    }
    if (record === null) {
      summaries[i] = unavailable("snapshot_unavailable");
      continue;
    }
    const pending = record.runId === null ? empty : snapshots.get(record.runId);
    if (pending instanceof StoreError) throw pending;
    if (!pending || pending instanceof Error) {
      summaries[i] = unavailable("snapshot_unavailable");
      continue;
    }
    // The blocking fact never enters the token: it is fixed per pending
    // question, whose identity the digest already names.
    const token = observationToken([
      "claudexor.run-observation",
      1,
      storeId,
      record.partition,
      record.epoch,
      record.jobId,
      record.runId,
      record.state,
      pending.digest,
    ]);
    summaries[i] =
      options.includeBlocking && pending.pending
        ? {
            status: record.state,
            pending: true,
            token,
            problem: null,
            // A port that cannot tell async from blocking keeps the historical meaning.
            blocking: pending.blocking !== false,
          }
        : { status: record.state, pending: pending.pending, token, problem: null };
  }
  return summaries;
}
