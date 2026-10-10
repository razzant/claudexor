import { QUOTA_GAP_ABSENCE_REASONS, quotaSourceTraits } from "@claudexor/schema";
import type {
  AccountTarget,
  AccountResourceObservation,
  QuotaAbsence,
  QuotaSnapshot,
  QuotaSubject,
} from "@claudexor/schema";
import { QuotaPollPacer, type QuotaPacerStateStore } from "./quota-poll-pacer.js";
import {
  earliestFreshRenewalAt,
  earliestQuotaRenewalAt,
  latestQuotaRenewalObservedAt,
  quotaSubjectIdentity,
  remainingQuotaRefreshDemand,
} from "./quota-refresh-demand.js";

export const QUOTA_POLL_INTERVAL_MS = 60_000;

/** One refresh cycle's fruit: the snapshots a source observed, plus the typed
 * absences it CLAIMS for subjects it tried and could not observe. Absence is
 * stated by the source, never inferred from an empty snapshot list. */
export interface QuotaRefreshResult {
  snapshots: QuotaSnapshot[];
  resources?: AccountResourceObservation[];
  absences?: QuotaAbsence[];
}

/** Which kind of cycle is asking: a paced background poll of one vendor lane,
 * or an explicit foreground refresh (`POST /v2/quota`, the atomic Accounts
 * snapshot) — the user's "ask the vendor again now", which a source may honor
 * by re-presenting a credential it would otherwise leave alone. A source that
 * ignores the argument keeps the pre-existing contract. */
export interface QuotaRefreshCycle {
  readonly foreground: boolean;
  readonly target?: AccountTarget;
  /** Background cycles fetch only due primary evidence. Explicit refreshes
   * still ask every eligible subject; floor and alias checks remain separate. */
  readonly shouldRefresh?: (subject: QuotaSubject) => boolean;
  /** Host-only callbacks; token identity is an ephemeral hash, never wire data. */
  readonly pacing?: {
    bindCredentials(
      bindings: ReadonlyArray<{ subject: QuotaSubject; credentialHash: string }>,
    ): void;
    cooldownUntil(subject: QuotaSubject, now: number): number | null;
    noteRateLimited(subject: QuotaSubject, observedAt: number, retryAfterMs: number | null): void;
  };
}

export type QuotaRefresher = (cycle?: QuotaRefreshCycle) => Promise<QuotaRefreshResult>;

/** A refresher bound to its vendor pacing lane. Refreshers of one vendor
 * share ONE QuotaPollPacer, so a permanently unsatisfiable subject of one
 * vendor backs off alone instead of pinning every vendor's cadence at the
 * 15-minute ceiling. A bare QuotaRefresher (legacy embedders, tests) rides an
 * anonymous lane with the pre-existing global-demand semantics. */
export interface QuotaVendorRefresher {
  readonly vendor: string;
  readonly refresh: QuotaRefresher;
}

export interface PacingLane {
  readonly vendor: string | null;
  readonly pacer: QuotaPollPacer;
}

export interface RefresherLanes {
  /** Declaration-ordered refreshers, each bound to its pacing lane. */
  readonly entries: ReadonlyArray<{ lane: PacingLane; refresh: QuotaRefresher }>;
  /** Distinct pacing lanes in first-appearance order. */
  readonly lanes: readonly PacingLane[];
}

export function buildRefresherLanes(
  refreshers: readonly (QuotaRefresher | QuotaVendorRefresher)[],
  pacerStore?: QuotaPacerStateStore,
): RefresherLanes {
  const laneByVendor = new Map<string, PacingLane>();
  const entries = refreshers.map((registration) => {
    if (typeof registration === "function") {
      return { lane: { vendor: null, pacer: new QuotaPollPacer() }, refresh: registration };
    }
    let lane = laneByVendor.get(registration.vendor);
    if (!lane) {
      lane = {
        vendor: registration.vendor,
        pacer: new QuotaPollPacer(registration.vendor, pacerStore),
      };
      laneByVendor.set(registration.vendor, lane);
    }
    return { lane, refresh: registration.refresh };
  });
  return { entries, lanes: [...new Set(entries.map((entry) => entry.lane))] };
}

/** One lane's demand at a poll horizon. The three facts answer different
 * questions: `remains` (some registered subject lacks satisfying primary
 * evidence by the horizon) drives the retry ladder; `renewalNotBefore` (the
 * last poll tick before the earliest evidence satisfied at this horizon
 * expires — or the next tick, when evidence observed since the cycle began
 * hits a vendor window boundary before it; null when none) caps it;
 * `renewalDueObservedAt` (the latest
 * observation instant of satisfying evidence whose renewal is due by the
 * horizon; null when none) lets evidence installed after the ladder was armed
 * bypass it. */
export interface LaneDemand {
  readonly remains: boolean;
  readonly renewalNotBefore: number | null;
  readonly renewalDueObservedAt: number | null;
}

export interface PollSweepDeps {
  readonly now: () => Date;
  readonly publishClockTransition: () => void;
  readonly laneDemand: (
    vendor: string | null,
    now: number,
    dueBefore: number,
    since: number,
  ) => LaneDemand;
  readonly currentGeneration: () => number;
  readonly isCurrentGeneration: (generation: number) => boolean;
  readonly runLaneCycle: (lane: PacingLane) => Promise<unknown>;
}

/** One background poll sweep: drive every vendor lane in order, running a
 * coalesced cycle for each lane that still has refresh demand and is past its
 * pacer gates, so one vendor's backoff never starves a sibling vendor's
 * freshness. The retry ladder paces subjects that produced no evidence and
 * never postpones a renewal: after a cycle it advances on remaining demand
 * but is capped at the renewal tick of the evidence the cycle DID satisfy,
 * and evidence installed while it is armed (a foreground refresh, an ingested
 * harness event) bypasses it when its renewal comes due — one revoked or
 * never-logged-in profile used to pin every healthy sibling of its vendor to
 * the 15-minute ceiling. The vendor rate-limit floor is never bypassed.
 * Resolves true when any lane refreshed. Single-flight of the sweep itself
 * belongs to the caller. */
export async function performPollSweep(
  lanes: readonly PacingLane[],
  deps: PollSweepDeps,
): Promise<boolean> {
  deps.publishClockTransition();
  let ran = false;
  for (const lane of lanes) {
    const now = deps.now().getTime();
    const due = deps.laneDemand(lane.vendor, now, now + QUOTA_POLL_INTERVAL_MS, now);
    if (!due.remains || !lane.pacer.pollEligible(now, due.renewalDueObservedAt)) continue;
    const generation = deps.currentGeneration();
    try {
      await deps.runLaneCycle(lane);
      ran = true;
      // A cycle fenced away by a credential change reports no pacing
      // outcome: the fresh-generation poll re-decides from scratch.
      if (!deps.isCurrentGeneration(generation)) continue;
      const completedAt = deps.now().getTime();
      const demand = deps.laneDemand(
        lane.vendor,
        completedAt,
        completedAt + QUOTA_POLL_INTERVAL_MS,
        now,
      );
      lane.pacer.notePollSuccess(completedAt, demand.remains, demand.renewalNotBefore);
    } catch {
      if (deps.isCurrentGeneration(generation)) {
        const failedAt = deps.now().getTime();
        const demand = deps.laneDemand(
          lane.vendor,
          failedAt,
          failedAt + QUOTA_POLL_INTERVAL_MS,
          now,
        );
        lane.pacer.notePollFailure(failedAt, demand.renewalNotBefore);
      }
    }
  }
  return ran;
}

/** Per-lane refresh demand: a vendor lane sees only its own subjects and
 * snapshots; an anonymous lane keeps the pre-existing global semantics.
 * `since` is the start of the cycle being judged: evidence it observed whose
 * window resets before the next tick is renewal due at that tick. */
export function laneDemand(
  vendor: string | null,
  snapshots: readonly QuotaSnapshot[],
  subjects: readonly QuotaSubject[] | undefined,
  now: number,
  dueBefore: number,
  since: number,
  lanes: readonly PacingLane[] = [],
): LaneDemand {
  // A paced subject contributes neither demand nor a renewal horizon until
  // its floor expires, so healthy siblings keep their ordinary cadence.
  subjects = subjects?.filter((subject) => {
    const lane = lanes.find((item) => item.vendor === subject.harness);
    return lane?.pacer.rateLimitCooldownUntil(now, subject) == null;
  });
  const laneSnapshots =
    vendor === null
      ? snapshots
      : snapshots.filter((snapshot) => snapshot.subject.harness === vendor);
  const laneSubjects =
    vendor === null ? subjects : subjects?.filter((subject) => subject.harness === vendor);
  const renewalAt =
    earliestFreshRenewalAt(laneSnapshots, laneSubjects, since, now, dueBefore) ??
    earliestQuotaRenewalAt(laneSnapshots, laneSubjects, dueBefore);
  return {
    remains: remainingQuotaRefreshDemand(laneSnapshots, laneSubjects, dueBefore).size > 0,
    renewalNotBefore: renewalAt === null ? null : renewalAt - QUOTA_POLL_INTERVAL_MS,
    renewalDueObservedAt: latestQuotaRenewalObservedAt(laneSnapshots, laneSubjects, now, dueBefore),
  };
}

export interface LaneCycleSelection {
  readonly running: ReadonlyArray<{ lane: PacingLane; refresh: QuotaRefresher }>;
  readonly skipped: Array<{ vendor: string; not_before: string; subject?: QuotaSubject }>;
}

/** Select which refreshers one cycle runs. A full (foreground) cycle honors
 * legacy vendor floors and current subject floors. Fully paced lanes stay
 * idle; a partially paced source receives the same floor callbacks and
 * continues its serial sweep for eligible accounts. Skips are disclosed. A poll-scoped cycle was already gated by the sweep. Anonymous
 * lanes never carry a floor and always run. Every running refresher is bound
 * to the cycle kind (foreground vs poll), so a source can honor an explicit
 * refresh while the registry keeps calling `refresh()`. */
export function selectCycleEntries(
  refresherLanes: RefresherLanes,
  scope: PacingLane | null,
  nowMs: number,
  isCurrent: () => boolean = () => true,
  subjects: readonly QuotaSubject[] = [],
  snapshots: readonly QuotaSnapshot[] = [],
  target?: AccountTarget,
): LaneCycleSelection {
  subjects = target
    ? subjects.filter(
        (subject) => subject.harness === target.harness && subject.subject_id === target.profile_id,
      )
    : subjects;
  const skipped =
    scope === null
      ? refresherLanes.lanes.flatMap((lane) => {
          const until = lane.vendor === null ? null : lane.pacer.rateLimitCooldownUntil(nowMs);
          return until === null
            ? []
            : [{ vendor: lane.vendor as string, not_before: new Date(until).toISOString() }];
        })
      : [];
  const skippedVendors = new Set(skipped.map((row) => row.vendor));
  const subjectSkips = subjects.flatMap((subject) => {
    if (skippedVendors.has(subject.harness) || (scope !== null && scope.vendor !== subject.harness))
      return [];
    const lane = refresherLanes.lanes.find((item) => item.vendor === subject.harness);
    const until = lane?.pacer.rateLimitCooldownUntil(nowMs, subject) ?? null;
    return until === null
      ? []
      : [{ vendor: subject.harness, subject, not_before: new Date(until).toISOString() }];
  });
  for (const lane of refresherLanes.lanes) {
    if (lane.vendor === null) continue;
    const owned = subjects.filter((subject) => subject.harness === lane.vendor);
    if (
      owned.length > 0 &&
      owned.every((subject) => lane.pacer.rateLimitCooldownUntil(nowMs, subject) !== null)
    ) {
      skippedVendors.add(lane.vendor);
    }
  }
  const running = refresherLanes.entries
    .filter(
      (entry) => !target || entry.lane.vendor === null || entry.lane.vendor === target.harness,
    )
    .filter((entry) =>
      scope === null
        ? entry.lane.vendor === null || !skippedVendors.has(entry.lane.vendor)
        : entry.lane === scope &&
          (entry.lane.vendor === null || !skippedVendors.has(entry.lane.vendor)),
    )
    .map((entry) => ({
      lane: entry.lane,
      refresh: () =>
        entry.refresh({
          foreground: scope === null,
          ...(target ? { target } : {}),
          shouldRefresh: (subject) =>
            target
              ? subject.harness === target.harness && subject.subject_id === target.profile_id
              : scope === null ||
                remainingQuotaRefreshDemand(
                  snapshots.filter(
                    (snapshot) => snapshot.subject.credential_route === subject.credential_route,
                  ),
                  [subject],
                  nowMs + QUOTA_POLL_INTERVAL_MS,
                ).size > 0,
          pacing: {
            bindCredentials: (bindings) => {
              if (isCurrent()) entry.lane.pacer.bindCredentials(bindings);
            },
            cooldownUntil: (subject, now) => entry.lane.pacer.rateLimitCooldownUntil(now, subject),
            noteRateLimited: (subject, observedAt, retryAfterMs) => {
              if (isCurrent()) entry.lane.pacer.noteRateLimited(observedAt, retryAfterMs, subject);
            },
          },
        }),
    }));
  return {
    running,
    skipped: [...skipped, ...subjectSkips].filter(
      (row) => !target || row.vendor === target.harness,
    ),
  };
}

/** Commit validated source pacing independently of quota facts. Immediate
 * producer callbacks already protect token aliases in the serial source pass;
 * re-stating the same 429 here is idempotent. Sources without such callbacks
 * still receive the subject floor after their batch validates. */
export function noteRefreshPacing(
  lanes: readonly PacingLane[],
  snapshots: readonly QuotaSnapshot[],
  claims: readonly QuotaAbsence[],
  skipped: LaneCycleSelection["skipped"],
  now: number,
): void {
  for (const snapshot of snapshots) {
    if (quotaSourceTraits(snapshot.source).refreshDemandHarness !== snapshot.subject.harness)
      continue;
    lanes
      .find((lane) => lane.vendor === snapshot.subject.harness)
      ?.pacer.noteSubjectSuccess(snapshot.subject);
  }
  for (const claim of claims) {
    const lane = lanes.find((item) => item.vendor === claim.subject.harness);
    if (claim.reason === "rate_limited") {
      lane?.pacer.noteRateLimited(
        Date.parse(claim.observed_at),
        claim.retry_after_ms ?? null,
        claim.subject,
      );
    }
    if (claim.reason !== "poll_paced" && claim.reason !== "probe_skipped_rate_limited") continue;
    const until = lane?.pacer.rateLimitCooldownUntil(now, claim.subject);
    const alreadySkipped = skipped.some(
      (row) =>
        row.subject &&
        row.subject.harness === claim.subject.harness &&
        row.subject.subject_id === claim.subject.subject_id &&
        row.subject.credential_route === claim.subject.credential_route,
    );
    if (until && !alreadySkipped)
      skipped.push({
        vendor: claim.subject.harness,
        subject: claim.subject,
        not_before: new Date(until).toISOString(),
      });
  }
}

/** Absence recomputation covers exactly the lanes that RAN: an anonymous
 * lane's coverage is unknowable, so its cycle keeps the full rebuild. */
export function recomputeScopeFor(
  running: LaneCycleSelection["running"],
): ReadonlySet<string> | null {
  const ranLanes = [...new Set(running.map((entry) => entry.lane))];
  return ranLanes.some((lane) => lane.vendor === null)
    ? null
    : new Set(ranLanes.map((lane) => lane.vendor as string));
}

/** Derived `poll_paced` gap rows: while a subject or legacy vendor floor is
 * active, each affected universe subject lacking FRESH snapshot cover
 * and lacking a stored absence row is stated as paused — a live projection
 * (never journaled), stable per floor so the projection signature does not
 * churn markers on every read. Keeps a suppressed vendor's subjects from
 * falling silent (daemon restarts with a store-loaded floor included) and
 * downstream exhaustion readers fail-open. */
export function derivePollPacedRows(
  lanes: readonly PacingLane[],
  subjects: readonly QuotaSubject[],
  existingRows: readonly QuotaAbsence[],
  freshCovered: ReadonlySet<string>,
  now: number,
): QuotaAbsence[] {
  const present = new Set(existingRows.map((row) => quotaSubjectIdentity(row.subject)));
  const rows: QuotaAbsence[] = [];
  for (const lane of lanes) {
    if (lane.vendor === null) continue;
    for (const subject of subjects) {
      if (subject.harness !== lane.vendor) continue;
      const until = lane.pacer.rateLimitCooldownUntil(now, subject);
      if (until === null) continue;
      const key = quotaSubjectIdentity(subject);
      if (freshCovered.has(key) || present.has(key)) continue;
      present.add(key);
      rows.push({
        subject,
        reason: "poll_paced",
        detail: `quota poll paused by rate-limit cooldown until ${new Date(until).toISOString()}`,
        observed_at: new Date(lane.pacer.rateLimitObservedAt(now, subject)).toISOString(),
      });
    }
  }
  return rows;
}

/** Subject-identity cover sets over one active-snapshot view. A partial
 * measured window cannot cover a failed or paced full-inventory read. */
export function subjectCoverSets(active: readonly QuotaSnapshot[]): {
  covered: ReadonlySet<string>;
  freshCovered: ReadonlySet<string>;
} {
  return {
    covered: new Set(active.map((snapshot) => quotaSubjectIdentity(snapshot.subject))),
    freshCovered: new Set(
      active
        .filter(
          (snapshot) =>
            snapshot.freshness === "fresh" &&
            quotaSourceTraits(snapshot.source).snapshotMode === "full",
        )
        .map((snapshot) => quotaSubjectIdentity(snapshot.subject)),
    ),
  };
}

/** Pure absence fold for one cycle (V11a semantics): preserved out-of-scope
 * rows first, then first-claim-wins claims, then `no_source` for uncovered
 * in-scope universe subjects. Failed, skipped, or paced refresh claims are
 * silenced only by a FRESH
 * snapshot — a stale one is exactly the state the gap row explains, and
 * dropping the row there would let a stale spent window read as exhausted
 * downstream. */
export function foldAbsenceClaims(input: {
  claims: readonly QuotaAbsence[];
  prior: readonly QuotaAbsence[];
  rebuilt: (harness: string, subjectId: string | null) => boolean;
  covered: ReadonlySet<string>;
  freshCovered: ReadonlySet<string>;
  subjects: readonly QuotaSubject[];
  now: number;
}): QuotaAbsence[] {
  const preserved = input.prior.filter(
    (absence) => !input.rebuilt(absence.subject.harness, absence.subject.subject_id),
  );
  const result: QuotaAbsence[] = [];
  const claimed = new Set<string>(preserved.map((item) => quotaSubjectIdentity(item.subject)));
  for (const claim of input.claims) {
    const key = quotaSubjectIdentity(claim.subject);
    const cover = QUOTA_GAP_ABSENCE_REASONS.has(claim.reason) ? input.freshCovered : input.covered;
    if (cover.has(key) || claimed.has(key)) continue;
    claimed.add(key);
    result.push(claim);
  }
  for (const subject of input.subjects) {
    if (!input.rebuilt(subject.harness, subject.subject_id)) continue;
    const key = quotaSubjectIdentity(subject);
    if (input.covered.has(key) || claimed.has(key)) continue;
    claimed.add(key);
    result.push({
      subject,
      reason: "no_source",
      detail: null,
      observed_at: new Date(input.now).toISOString(),
    });
  }
  return [...preserved, ...result];
}
