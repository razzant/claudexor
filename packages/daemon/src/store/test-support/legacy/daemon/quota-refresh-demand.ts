import {
  quotaRefreshDemandHarnesses,
  quotaSourceTraits,
  type QuotaSnapshot,
  type QuotaSubject,
} from "@claudexor/schema";
import { quotaSnapshotDueAt, quotaSnapshotDueBefore } from "./quota-registry-support.js";

const REFRESH_CAPABLE_HARNESSES = new Set<string>(quotaRefreshDemandHarnesses());

/** Demand identity: one credential subject regardless of route or source. */
export function quotaSubjectIdentity(subject: QuotaSubject): string {
  return [subject.harness, subject.subject_id ?? ""].join("\0");
}

/** Fresh evidence from the subject's own primary source — the only kind that
 * satisfies refresh demand; reactive/spool evidence never does. */
function satisfiesPrimaryDemand(snapshot: QuotaSnapshot): boolean {
  return (
    snapshot.freshness === "fresh" &&
    quotaSourceTraits(snapshot.source).refreshDemandHarness === snapshot.subject.harness
  );
}

/** Only fresh matching primary evidence satisfies a registered subject.
 * Reactive/spool evidence remains in the projection but is irrelevant here.
 * Undefined preserves the legacy embedder contract of one fresh primary;
 * an explicitly empty universe means no demand. */
export function remainingQuotaRefreshDemand(
  snapshots: readonly QuotaSnapshot[],
  subjects?: readonly QuotaSubject[],
  dueBefore?: number,
): Set<string> {
  const satisfied = new Set(
    snapshots
      .filter(
        (snapshot) =>
          satisfiesPrimaryDemand(snapshot) &&
          (dueBefore === undefined || !quotaSnapshotDueBefore(snapshot, dueBefore)),
      )
      .map((snapshot) => quotaSubjectIdentity(snapshot.subject)),
  );
  if (subjects === undefined) {
    return satisfied.size > 0 ? new Set() : new Set(["legacy-unscoped"]);
  }
  const demand = new Set<string>();
  for (const subject of subjects) {
    if (!REFRESH_CAPABLE_HARNESSES.has(subject.harness)) continue;
    const key = quotaSubjectIdentity(subject);
    if (!satisfied.has(key)) demand.add(key);
  }
  return demand;
}

/** Satisfying primary evidence of registered subjects, paired with its due
 * instant. An undefined universe keeps the legacy contract: every satisfying
 * primary snapshot counts. */
function* satisfyingEvidence(
  snapshots: readonly QuotaSnapshot[],
  subjects: readonly QuotaSubject[] | undefined,
): Generator<readonly [QuotaSnapshot, number]> {
  const registered =
    subjects === undefined
      ? null
      : new Set(
          subjects
            .filter((subject) => REFRESH_CAPABLE_HARNESSES.has(subject.harness))
            .map(quotaSubjectIdentity),
        );
  for (const snapshot of snapshots) {
    if (!satisfiesPrimaryDemand(snapshot)) continue;
    if (registered !== null && !registered.has(quotaSubjectIdentity(snapshot.subject))) continue;
    yield [snapshot, quotaSnapshotDueAt(snapshot)];
  }
}

/** The renewal horizon: the earliest instant strictly after `after` at which
 * a snapshot that satisfies a registered subject becomes due. Null when no
 * satisfying evidence is due later than `after`. Evidence already due by
 * `after` is unsatisfied demand and belongs to the retry ladder, never to
 * renewal — so a pre-aged result feeds the ladder instead of tight-polling. */
export function earliestQuotaRenewalAt(
  snapshots: readonly QuotaSnapshot[],
  subjects: readonly QuotaSubject[] | undefined,
  after: number,
): number | null {
  let earliest: number | null = null;
  for (const [, dueAt] of satisfyingEvidence(snapshots, subjects)) {
    if (dueAt <= after) continue;
    if (earliest === null || dueAt < earliest) earliest = dueAt;
  }
  return earliest;
}

/** The earliest due instant — strictly after `now`, no later than `deadline`
 * — of satisfying evidence observed at or after `since`: a vendor window
 * boundary (`resets_at`) that falls within the next tick of the very cycle
 * that observed the evidence. Such evidence is renewal due at the next tick,
 * never ladder demand; a pre-aged result (observed before `since`) still
 * feeds the ladder. Null when there is none. */
export function earliestFreshRenewalAt(
  snapshots: readonly QuotaSnapshot[],
  subjects: readonly QuotaSubject[] | undefined,
  since: number,
  now: number,
  deadline: number,
): number | null {
  let earliest: number | null = null;
  for (const [snapshot, dueAt] of satisfyingEvidence(snapshots, subjects)) {
    if (dueAt <= now || dueAt > deadline || Date.parse(snapshot.observed_at) < since) continue;
    if (earliest === null || dueAt < earliest) earliest = dueAt;
  }
  return earliest;
}

/** The latest observation instant among satisfying evidence whose renewal is
 * due in `(after, deadline]` — what the poll sweep compares with the retry
 * ladder's arm time: evidence observed after the ladder was armed (a
 * foreground refresh, an ingested harness event) bypasses the ladder. Null
 * when no satisfying evidence is due in that window. */
export function latestQuotaRenewalObservedAt(
  snapshots: readonly QuotaSnapshot[],
  subjects: readonly QuotaSubject[] | undefined,
  after: number,
  deadline: number,
): number | null {
  let latest: number | null = null;
  for (const [snapshot, dueAt] of satisfyingEvidence(snapshots, subjects)) {
    if (dueAt <= after || dueAt > deadline) continue;
    const observed = Date.parse(snapshot.observed_at);
    if (latest === null || observed > latest) latest = observed;
  }
  return latest;
}
