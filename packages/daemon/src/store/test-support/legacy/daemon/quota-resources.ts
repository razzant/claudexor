import type { DurableJournal } from "@claudexor/journal";
import { RESOURCES_OBSERVED } from "./quota-registry-replay.js";
import { sha256 } from "@claudexor/util";
import {
  activeQuotaSnapshots,
  activeQuotaSnapshotsWithConstraintFreshness,
} from "./quota-registry-support.js";
import {
  ACCOUNT_RESOURCE_FACETS,
  AccountResourceSnapshot,
  ControlQuotaFreshnessResponse,
  emptyResourceFacet,
  type AccountResourceObservation,
  type AccountTarget,
  type QuotaAbsence,
  type QuotaSnapshot,
} from "@claudexor/schema";

export const resourceKey = (target: AccountTarget) =>
  JSON.stringify([target.harness, target.profile_id]);
export function emptyResources(target: AccountTarget): AccountResourceSnapshot {
  return {
    target,
    balances: emptyResourceFacet(),
    spending: emptyResourceFacet(),
    resets: emptyResourceFacet(),
    diagnostics: emptyResourceFacet(),
  };
}
/** Merge independently observed facets. A failed read preserves the successful
 * observation, including its original source and clock. */
export function mergeResources(
  prior: AccountResourceSnapshot | undefined,
  update: AccountResourceObservation,
): AccountResourceSnapshot {
  const result = structuredClone(prior ?? emptyResources(update.target));
  for (const key of ACCOUNT_RESOURCE_FACETS) {
    const next = update[key];
    if (!next) continue;
    const old = result[key];
    if (next.last_attempt_at && old.last_attempt_at && next.last_attempt_at < old.last_attempt_at)
      continue;
    if (key === "resets" && update.resets?.value && result.resets.value) {
      const reported = new Set(update.resets.value.map((offer) => offer.id));
      const resolved = new Set(update.resets_resolved_ids ?? []);
      const retained = result.resets.value.filter(
        (offer) => !reported.has(offer.id) && !resolved.has(offer.id),
      );
      if (retained.length) {
        result.resets = {
          ...update.resets,
          value: [...update.resets.value, ...retained],
          freshness: "stale",
          observed_at: result.resets.observed_at,
        };
        continue;
      }
    }
    Object.assign(result, {
      [key]:
        next.value === null
          ? {
              ...old,
              last_attempt_at: next.last_attempt_at,
              last_error: next.last_error,
              freshness: old.value === null ? "unknown" : "stale",
            }
          : next,
    });
  }
  return result;
}
export function ageResources(
  snapshot: AccountResourceSnapshot,
  now: number,
): AccountResourceSnapshot {
  const result = structuredClone(snapshot);
  for (const key of ACCOUNT_RESOURCE_FACETS) {
    const facet = result[key];
    if (facet.value === null) facet.freshness = "unknown";
    else if (
      facet.last_error !== null ||
      facet.observed_at === null ||
      now - Date.parse(facet.observed_at) >= 300_000
    )
      facet.freshness = "stale";
  }
  return result;
}

export function resourceSnapshots(
  values: Iterable<AccountResourceSnapshot>,
  cutoffs: ReadonlyMap<string, string>,
  now: number,
) {
  return [...values].map((value) => {
    const row = ageResources(value, now);
    const cutoff = cutoffs.get(resourceKey(row.target));
    if (cutoff)
      for (const facet of ACCOUNT_RESOURCE_FACETS) {
        if (
          row[facet].value !== null &&
          (!row[facet].observed_at || row[facet].observed_at! < cutoff)
        )
          row[facet].freshness = "stale";
      }
    return row;
  });
}

function beforeResourceCutoff(snapshot: QuotaSnapshot, cutoffs: ReadonlyMap<string, string>) {
  const subject = snapshot.subject;
  const cutoff =
    subject.subject_id === null
      ? undefined
      : cutoffs.get(resourceKey({ harness: subject.harness, profile_id: subject.subject_id }));
  return Boolean(cutoff && snapshot.observed_at < cutoff);
}

export function resourceQuotaSnapshots(
  values: Iterable<QuotaSnapshot>,
  cutoffs: ReadonlyMap<string, string>,
  now: number,
): QuotaSnapshot[] {
  return activeQuotaSnapshots([...values], now).map((snapshot) =>
    beforeResourceCutoff(snapshot, cutoffs) ? { ...snapshot, freshness: "stale" } : snapshot,
  );
}

/** The opt-in display read: evidence observed before an account reset is
 * historical for every window, exactly as for the aggregate snapshot. */
export function quotaFreshnessRead(
  values: ReadonlyMap<string, QuotaSnapshot>,
  cutoffs: ReadonlyMap<string, string>,
  absences: QuotaAbsence[],
  now: number,
): ControlQuotaFreshnessResponse {
  const snapshots = activeQuotaSnapshotsWithConstraintFreshness([...values.values()], now);
  return ControlQuotaFreshnessResponse.parse({
    snapshots: snapshots.map((snapshot) =>
      beforeResourceCutoff(snapshot, cutoffs)
        ? {
            ...snapshot,
            freshness: "stale",
            constraints: snapshot.constraints.map((item) => ({ ...item, freshness: "stale" })),
          }
        : snapshot,
    ),
    absences,
    refreshed_at: null,
  });
}

export function quotaProjectionSignature(
  response: import("@claudexor/schema").ControlQuotaResponse,
  resources: AccountResourceSnapshot[],
): string {
  // refreshed_at is request metadata, not projection identity. Snapshot
  // freshness and absence coverage are logical facts and remain included.
  // The marker carries the digest, never the projection: consumers only
  // compare signatures for equality (a legacy JSON-string marker simply
  // differs once, publishing one extra clock-transition marker).
  return sha256(
    JSON.stringify({
      snapshots: response.snapshots,
      absences: response.absences,
      ...(resources.length ? { resources } : {}),
    }),
  );
}

/** The journal order disambiguates observations sharing a millisecond with
 * reset. Existing facts become historical; a later successful read may renew
 * them at the same clock tick. The timestamp floor also covers late old polls. */
export function retireAccountResourceEvidence(
  target: AccountTarget,
  at: string,
  cutoffs: Map<string, string>,
  snapshots: Map<string, QuotaSnapshot>,
  resources: Map<string, AccountResourceSnapshot>,
): void {
  const key = resourceKey(target);
  cutoffs.set(key, at);
  for (const [id, snapshot] of snapshots) {
    if (
      snapshot.subject.harness === target.harness &&
      snapshot.subject.subject_id === target.profile_id
    )
      snapshots.set(id, { ...snapshot, freshness: "stale" });
  }
  const row = resources.get(key);
  if (row) {
    const retired = structuredClone(row);
    for (const facet of ACCOUNT_RESOURCE_FACETS)
      if (retired[facet].value !== null) retired[facet].freshness = "stale";
    resources.set(key, retired);
  }
}

export function applyResourceObservation(
  resources: Map<string, AccountResourceSnapshot>,
  observation: AccountResourceObservation,
): void {
  const key = resourceKey(observation.target);
  // Journal writes contain the completed merge. Re-merging a full snapshot
  // would resurrect resolved-absent offers in an unfolded journal. Legacy
  // partial payloads remain deltas; complete rows install exactly as written.
  const snapshot = AccountResourceSnapshot.safeParse(observation);
  resources.set(
    key,
    snapshot.success ? snapshot.data : mergeResources(resources.get(key), observation),
  );
}
/** The existing quota journal stores a complete resource row so its fold slot
 * cannot lose an older independently observed facet. */
export function recordAccountResourceObservation(
  journal: DurableJournal,
  resources: Map<string, AccountResourceSnapshot>,
  observation: AccountResourceObservation,
): void {
  const key = resourceKey(observation.target);
  const snapshot = mergeResources(resources.get(key), observation);
  journal.append(RESOURCES_OBSERVED, { version: 1, observation: snapshot });
  resources.set(key, snapshot);
}
