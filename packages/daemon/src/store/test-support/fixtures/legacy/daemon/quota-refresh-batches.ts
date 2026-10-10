import {
  AccountResourceObservation,
  QuotaSnapshot as QuotaSnapshotSchema,
  QuotaAbsence as QuotaAbsenceSchema,
  type QuotaSnapshot,
  type QuotaAbsence,
  type AccountTarget,
} from "../schema/index.js";
import type { QuotaRefreshResult } from "./quota-poll-lanes.js";
import { resourceKey } from "./quota-resources.js";
export function validatedRefreshBatches(
  settled: PromiseSettledResult<QuotaRefreshResult>[],
  target?: AccountTarget,
) {
  const batches: Array<{
    snapshots: QuotaSnapshot[];
    absences: QuotaAbsence[];
    resources: AccountResourceObservation[];
  } | null> = [];
  const failures: string[] = [];
  // Validate EVERY fulfilled source batch before the first durable write.
  // Declaration order below, not completion order, remains the deterministic
  // authority for both snapshot writes and first-claim absence precedence.
  for (const result of settled) {
    if (result.status === "rejected") {
      failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
      batches.push(null);
      continue;
    }
    try {
      batches.push({
        resources: (result.value.resources ?? [])
          .map((value) => AccountResourceObservation.parse(value))
          .filter((value) => !target || resourceKey(value.target) === resourceKey(target)),
        snapshots: result.value.snapshots
          .filter(
            (value) =>
              !target ||
              (value.subject.harness === target.harness &&
                value.subject.subject_id === target.profile_id),
          )
          .map((snapshot) => QuotaSnapshotSchema.parse(snapshot)),
        absences: (result.value.absences ?? [])
          .filter(
            (value) =>
              !target ||
              (value.subject.harness === target.harness &&
                value.subject.subject_id === target.profile_id),
          )
          .map((absence) => QuotaAbsenceSchema.parse(absence)),
      });
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      batches.push(null);
    }
  }
  // An all-cooled full cycle (running empty, skips disclosed) is a served
  // last-known response, not a failure; only attempted-and-failed sources
  // make the cycle unavailable.
  if (settled.length > 0 && batches.every((batch) => batch === null)) {
    throw Object.assign(new Error(`quota refresh failed: ${failures.join("; ")}`), {
      code: "quota_refresh_unavailable",
      status: 503,
    });
  }
  return batches;
}

export function refreshCoverage(
  batches: ReturnType<typeof validatedRefreshBatches>,
  skipped: ReadonlyArray<{ subject?: import("../schema/index.js").QuotaSubject }>,
) {
  return [
    ...batches.flatMap((batch) => [
      ...(batch?.snapshots ?? []).map((value) => value.subject),
      ...(batch?.absences ?? []).map((value) => value.subject),
    ]),
    ...skipped.flatMap((row) => (row.subject ? [row.subject] : [])),
  ].flatMap((subject) =>
    subject.subject_id === null
      ? []
      : [resourceKey({ harness: subject.harness, profile_id: subject.subject_id })],
  );
}

/** Exact management targets may be disabled and therefore absent from the
 * routing universe. Include them once without widening the source sweep. */
export function refreshSubjects(
  subjects: readonly import("../schema/index.js").QuotaSubject[] = [],
  target?: AccountTarget,
) {
  if (!target) return subjects;
  return [
    ...subjects.filter((s) => s.harness !== target.harness || s.subject_id !== target.profile_id),
    {
      harness: target.harness,
      subject_id: target.profile_id,
      credential_route: "vendor_native" as const,
      plan_label: null,
    },
  ];
}

export function refreshCycleCovers(
  cycle: { target?: AccountTarget; scopeVendor: string | null; coveredTargets: readonly string[] },
  target?: AccountTarget,
  scope?: { vendor: string | null },
): boolean {
  return target
    ? cycle.target
      ? resourceKey(cycle.target) === resourceKey(target)
      : cycle.scopeVendor === null && cycle.coveredTargets.includes(resourceKey(target))
    : scope
      ? !cycle.target && (cycle.scopeVendor === null || cycle.scopeVendor === scope.vendor)
      : cycle.scopeVendor === null && !cycle.target;
}
