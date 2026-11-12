import {
  accountResourceSourceHarnesses,
  quotaRefreshDemandHarnesses,
  quotaSourceTraits,
  type AccountResourceSnapshot,
  type QuotaSnapshot,
  type QuotaSubject,
} from "@claudexor/schema";
import { quotaSnapshotDueAt } from "./quota-registry-support.js";
import { resourceRefreshEvidence } from "./quota-resource-demand.js";

// API-key resource sources refresh only on explicit request: no poll demand.
const REFRESH_CAPABLE_HARNESSES = new Set<string>([
  ...quotaRefreshDemandHarnesses(),
  ...accountResourceSourceHarnesses("account"),
]);

/** Demand identity is a credential subject, not its current route or source. */
export function quotaSubjectIdentity(subject: QuotaSubject): string {
  return [subject.harness, subject.subject_id ?? ""].join("\0");
}

/** The scheduling projection is not a quota snapshot. Resource-only sources
 * satisfy renewal demand without fabricating availability or retiring limits. */
function* satisfyingEvidence(
  snapshots: readonly QuotaSnapshot[],
  subjects: readonly QuotaSubject[] | undefined,
  resources: readonly AccountResourceSnapshot[],
): Generator<{ observedAt: number; dueAt: number; key: string }> {
  const registered =
    subjects === undefined
      ? null
      : new Set(
          subjects
            .filter((subject) => REFRESH_CAPABLE_HARNESSES.has(subject.harness))
            .map(quotaSubjectIdentity),
        );
  for (const snapshot of snapshots) {
    if (
      snapshot.freshness !== "fresh" ||
      quotaSourceTraits(snapshot.source).refreshDemandHarness !== snapshot.subject.harness
    )
      continue;
    const key = quotaSubjectIdentity(snapshot.subject);
    if (registered !== null && !registered.has(key)) continue;
    yield {
      key,
      observedAt: Date.parse(snapshot.observed_at),
      dueAt: quotaSnapshotDueAt(snapshot),
    };
  }
  for (const evidence of resourceRefreshEvidence(resources))
    if (registered === null || registered.has(evidence.key)) yield evidence;
}

/** Only fresh primary observations satisfy demand. Undefined universe retains
 * the legacy embedder rule of one primary; an empty universe has no demand. */
export function remainingQuotaRefreshDemand(
  snapshots: readonly QuotaSnapshot[],
  subjects?: readonly QuotaSubject[],
  dueBefore?: number,
  resources: readonly AccountResourceSnapshot[] = [],
): Set<string> {
  const satisfied = new Set(
    [...satisfyingEvidence(snapshots, subjects, resources)]
      .filter((evidence) => dueBefore === undefined || evidence.dueAt > dueBefore)
      .map((evidence) => evidence.key),
  );
  if (subjects === undefined) return satisfied.size ? new Set() : new Set(["legacy-unscoped"]);
  return new Set(
    subjects
      .filter(
        (subject) =>
          REFRESH_CAPABLE_HARNESSES.has(subject.harness) &&
          !satisfied.has(quotaSubjectIdentity(subject)),
      )
      .map(quotaSubjectIdentity),
  );
}

/** Earliest satisfying evidence expiry strictly after this horizon. */
export function earliestQuotaRenewalAt(
  snapshots: readonly QuotaSnapshot[],
  subjects: readonly QuotaSubject[] | undefined,
  after: number,
  resources: readonly AccountResourceSnapshot[] = [],
): number | null {
  let earliest: number | null = null;
  for (const { dueAt } of satisfyingEvidence(snapshots, subjects, resources)) {
    if (dueAt > after && (earliest === null || dueAt < earliest)) earliest = dueAt;
  }
  return earliest;
}

/** Evidence observed during this cycle whose expiry is within the next tick
 * remains renewal, rather than backing off as a missing primary. */
export function earliestFreshRenewalAt(
  snapshots: readonly QuotaSnapshot[],
  subjects: readonly QuotaSubject[] | undefined,
  since: number,
  now: number,
  deadline: number,
  resources: readonly AccountResourceSnapshot[] = [],
): number | null {
  let earliest: number | null = null;
  for (const { observedAt, dueAt } of satisfyingEvidence(snapshots, subjects, resources)) {
    if (dueAt <= now || dueAt > deadline || observedAt < since) continue;
    if (earliest === null || dueAt < earliest) earliest = dueAt;
  }
  return earliest;
}

/** New evidence installed since a retry ladder was armed can bypass the ladder
 * when renewal comes due. The vendor's poll floor is still independent. */
export function latestQuotaRenewalObservedAt(
  snapshots: readonly QuotaSnapshot[],
  subjects: readonly QuotaSubject[] | undefined,
  after: number,
  deadline: number,
  resources: readonly AccountResourceSnapshot[] = [],
): number | null {
  let latest: number | null = null;
  for (const { observedAt, dueAt } of satisfyingEvidence(snapshots, subjects, resources)) {
    if (dueAt <= after || dueAt > deadline) continue;
    if (latest === null || observedAt > latest) latest = observedAt;
  }
  return latest;
}
