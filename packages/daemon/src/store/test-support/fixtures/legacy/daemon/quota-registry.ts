import {
  validatedRefreshBatches,
  refreshCoverage,
  refreshSubjects,
  refreshCycleCovers,
} from "./quota-refresh-batches.js";
import {
  replayQuotaJournal,
  RESOURCES_INVALIDATED,
  REMOVED,
  PROJECTION_UPDATED,
  WINDOW_SUPERSEDED,
} from "./quota-registry-replay.js";
import type { DurableJournal } from "../journal/index.js";
import {
  ControlQuotaResponse,
  AccountResourceSnapshot,
  type AccountTarget,
  observedResourceFacet,
  HarnessEvent,
  QUOTA_GAP_ABSENCE_REASONS,
  QuotaSnapshot as QuotaSnapshotSchema,
  QuotaWindowSupersession,
  REACTIVE_COOLDOWN_SOURCE,
  quotaSourceTraits,
  type CredentialRoute,
  type QuotaAbsence,
  type QuotaSnapshot,
  type QuotaSubject,
} from "../schema/index.js";
import {
  quotaSnapshotRecords,
  reconcileQuotaSnapshot,
  reactiveCooldownSnapshot,
  sameQuotaEvidence,
  snapshotKey,
} from "./quota-registry-support.js";
import {
  buildRefresherLanes,
  derivePollPacedRows,
  foldAbsenceClaims,
  laneDemand,
  noteRefreshPacing,
  performPollSweep,
  recomputeScopeFor,
  selectCycleEntries,
  subjectCoverSets,
  type PacingLane,
  type QuotaRefresher,
  type QuotaVendorRefresher,
  type RefresherLanes,
} from "./quota-poll-lanes.js";
import type { QuotaPacerStateStore } from "./quota-poll-pacer.js";
import { QuotaRefreshCoordinator } from "./quota-refresh-coordinator.js";
import { quotaSubjectIdentity } from "./quota-refresh-demand.js";

import {
  resourceKey,
  applyResourceObservation,
  recordAccountResourceObservation,
  resourceSnapshots,
  resourceQuotaSnapshots,
  quotaFreshnessRead,
  quotaProjectionSignature,
  retireAccountResourceEvidence,
} from "./quota-resources.js";
/** The registered subject UNIVERSE: every subject the daemon expects to hear
 * about, so a subject with neither snapshot nor a source claim still surfaces
 * a "no_source" absence instead of vanishing. */
export type QuotaSubjectUniverse = () => QuotaSubject[];

/** Global-journal authority for vendor-owned quota snapshots. */
export class QuotaRegistry {
  private readonly resourceCutoffs = new Map<string, string>();
  private readonly resources = new Map<string, AccountResourceSnapshot>();
  private refreshSerial = 0;
  private readonly snapshots = new Map<string, QuotaSnapshot>();
  private readonly supersededWindows = new Map<string, QuotaWindowSupersession>();
  /** Ephemeral typed-absence state, recomputed each refresh/poll cycle — NOT
   * journaled: an absence is a live derivation of "who reported nothing this
   * cycle", never a durable fact to replay. */
  private absences: QuotaAbsence[] = [];
  /** Signature carried by the last durable projection marker. Raw quota
   * evidence may span several records; this is the commit/recovery boundary
   * consumed by snapshot-then-SSE clients. */
  private lastPublishedProjectionSignature: string | null = null;
  private readonly refreshCoordinator = new QuotaRefreshCoordinator<
    Awaited<ReturnType<QuotaRegistry["performRefreshCycle"]>>
  >();
  private readonly refresherLanes: RefresherLanes;
  private pollSweepInFlight: Promise<boolean> | null = null;
  private recoveryMarkerPending = false;

  constructor(
    private readonly journal: DurableJournal,
    refreshers: readonly (QuotaRefresher | QuotaVendorRefresher)[] = [],
    private readonly now: () => Date = () => new Date(),
    private readonly subjects?: QuotaSubjectUniverse,
    pacerStore?: QuotaPacerStateStore,
  ) {
    const replay = replayQuotaJournal(journal, {
      apply: (snapshot) => this.apply(snapshot),
      applyWindowSupersession: (value) => this.applyWindowSupersession(value),
      applyResources: (observation) => applyResourceObservation(this.resources, observation),
      invalidateResources: (target, at) => this.retireResourceEvidence(target, at),
      remove: (harness, id, resources) => this.remove(harness, id, resources),
    });
    this.lastPublishedProjectionSignature = replay.projectionSignature;
    this.validateProjection();
    // A process can stop after a durable raw mutation but before its separate
    // projection marker. Replaying that state without a new marker would leave
    // already-subscribed clients permanently behind. Close the recovered
    // commit boundary synchronously before the projection becomes available.
    this.recoveryMarkerPending = replay.rawMutationAfterMarker;
    this.refresherLanes = buildRefresherLanes(refreshers, pacerStore);
  }

  /** Publish the recovered projection boundary only after bootstrap activation. */
  recoverAfterStartup(): void {
    if (!this.recoveryMarkerPending) return;
    this.appendProjectionMarker("recovery", this.now().toISOString());
    this.recoveryMarkerPending = false;
  }

  read() {
    const now = this.now().getTime();
    return ControlQuotaResponse.parse({
      snapshots: this.activeSnapshots(now),
      absences: this.activeAbsences(now),
      refreshed_at: null,
    });
  }

  /** Opt-in display read, never used for routing, demand, or journal signatures. */
  readConstraintFreshness(now = this.now().getTime()) {
    return quotaFreshnessRead(this.snapshots, this.resourceCutoffs, this.activeAbsences(now), now);
  }

  readResources(now = this.now().getTime()) {
    return resourceSnapshots(this.resources.values(), this.resourceCutoffs, now);
  }

  /** A reset makes prior usage/inventory historical, not a fabricated new count. */
  invalidateAccountResources(target: AccountTarget): void {
    const observed_at = this.now().toISOString();
    this.journal.append(RESOURCES_INVALIDATED, { version: 1, target, observed_at });
    this.retireResourceEvidence(target, observed_at);
    this.appendProjectionMarker("direct_mutation", observed_at);
  }

  private retireResourceEvidence(target: AccountTarget, at: string): void {
    retireAccountResourceEvidence(target, at, this.resourceCutoffs, this.snapshots, this.resources);
  }

  private activeSnapshots(now: number): QuotaSnapshot[] {
    return resourceQuotaSnapshots(this.snapshots.values(), this.resourceCutoffs, now);
  }

  async refresh(target?: AccountTarget, afterCurrent = false) {
    return (await this.refreshCycle(true, undefined, target, afterCurrent)).response;
  }

  /** Fresh quota plus the exact global-journal fence for snapshot-then-SSE.
   * The cursor is captured inside refreshCycle, synchronously with `response`,
   * so a later append can never be skipped by a client resuming from it. */
  async refreshWithCursor() {
    const { response, quotaEventCursor, resources } = await this.refreshCycle();
    return { response, quotaEventCursor, resources };
  }

  async refreshResources(
    target?: AccountTarget,
    afterCurrent = false,
    invalidateBeforeRead = false,
  ) {
    const cycle = await this.refreshCycle(
      true,
      undefined,
      target,
      afterCurrent,
      invalidateBeforeRead,
    );
    return { ...cycle.response, resources: cycle.resources };
  }

  /** One coalesced atomic refresh cycle; a poll passes its lane so only that
   * vendor's refreshers run. Join semantics are asymmetric on purpose: a poll
   * joining a foreground FULL cycle keeps its (superset) result, but a FULL
   * caller that joined a lane-SCOPED poll cycle re-runs a full cycle once it
   * completes — an explicit refresh must not silently return with sibling
   * vendors unre-fetched and undisclosed. Continue until the caller joins
   * a cycle covering its target and, after reset, its observation boundary. */
  private async refreshCycle(
    followCredentialChanges = true,
    scope?: PacingLane,
    target?: AccountTarget,
    afterCurrent = false,
    invalidateBeforeRead = false,
  ): Promise<Awaited<ReturnType<QuotaRegistry["performRefreshCycle"]>>> {
    const afterSerial = afterCurrent ? this.refreshSerial : -1;
    for (;;) {
      const cycle = await this.refreshCoordinator
        .run((credentialGeneration) => {
          // Drain the previous cycle before moving the reset cutoff. Even an old
          // source stamped at delivery cannot renew history after this boundary.
          if (target && invalidateBeforeRead) this.invalidateAccountResources(target);
          return this.performRefreshCycle(credentialGeneration, scope ?? null, target);
        }, followCredentialChanges)
        .catch((error) => {
          if (afterCurrent && this.refreshSerial <= afterSerial) return null;
          throw error;
        });
      if (cycle === null) continue;
      const covered = refreshCycleCovers(cycle, target, scope);
      if (covered && cycle.serial > afterSerial) return cycle;
    }
  }

  private async performRefreshCycle(
    credentialGeneration: number,
    scope: PacingLane | null,
    target?: AccountTarget,
  ) {
    const serial = ++this.refreshSerial;
    if (this.refresherLanes.entries.length === 0) {
      throw Object.assign(new Error("no live vendor-owned quota refresh source is available"), {
        code: "quota_refresh_unavailable",
        status: 503,
      });
    }
    // Foreground cycles honor each vendor lane's rate-limit cooldown; the
    // skips serve last-known registry data and are disclosed additively.
    const { running, skipped } = selectCycleEntries(
      this.refresherLanes,
      scope,
      this.now().getTime(),
      () => this.refreshCoordinator.isCurrent(credentialGeneration),
      refreshSubjects(this.subjects?.(), target),
      this.activeSnapshots(this.now().getTime()),
      target,
    );
    const settled = await Promise.allSettled(running.map(async ({ refresh }) => refresh()));
    const batches = validatedRefreshBatches(settled, target);
    // Everything below mutates the journal or live projection without an
    // await. Fence the whole commit boundary before its first write: a cycle
    // that captured retired credentials contributes no snapshot, absence,
    // marker, response, or cursor.
    if (!this.refreshCoordinator.isCurrent(credentialGeneration)) {
      throw new Error("quota refresh superseded by a credential change");
    }
    const claims: QuotaAbsence[] = [];
    for (const batch of batches) {
      if (batch === null) continue;
      // One refresh can contain many vendor subjects. Persist every source
      // event, but publish ONE projection-level marker after the full response
      // is assembled so clients never see a marker-per-item burst.
      for (const snapshot of batch.snapshots) this.recordUpsert(snapshot);
      for (const observation of batch.resources)
        recordAccountResourceObservation(this.journal, this.resources, observation);
      claims.push(...batch.absences);
    }
    const now = this.now().getTime();
    if (running.length > 0) this.recomputeAbsences(claims, now, recomputeScopeFor(running), target);
    noteRefreshPacing(
      this.refresherLanes.lanes,
      batches.flatMap((batch) => batch?.snapshots ?? []),
      claims,
      skipped,
      now,
    );
    const refreshedAt = this.now().toISOString();
    const response = ControlQuotaResponse.parse({
      snapshots: this.activeSnapshots(now),
      absences: this.activeAbsences(now),
      refreshed_at: refreshedAt,
      ...(skipped.length > 0 ? { refresh_skipped: skipped } : {}),
    });
    // No await may appear between response construction and this marker/cursor.
    // The marker makes absence-only and identical refreshes observable; its own
    // cursor is the exact last event represented by this response.
    const resources = this.readResources(now);
    const quotaEventCursor = this.appendProjectionMarker(
      "refresh",
      refreshedAt,
      response,
      resources,
    );
    // scoped: an unscoped joiner re-runs a full cycle on it (join semantics).
    return {
      response,
      quotaEventCursor,
      resources,
      scopeVendor: scope?.vendor ?? null,
      target,
      serial,
      coveredTargets: refreshCoverage(batches, skipped),
    };
  }

  /** Fold claims against (harness, subject_id): fresh snapshots silence
   * refresh gaps; stale snapshots retain their explanations. Other claims
   * keep their existing precedence and retirement rules; no evidence yields
   * "no_source". Route/source never split a subject.
   *
   * `scope` (a vendor-lane cycle) rebuilds only that vendor's rows plus every
   * REFRESHERLESS harness's rows (those can only ever be `no_source`, and
   * skipping them would leave e.g. a cursor subject silently unstated until
   * the next full cycle); other vendors' claimed rows are preserved so a
   * claude-only poll cannot degrade codex's typed reasons to no_source.
   * `null` scope (a full cycle, or an anonymous-lane cycle whose coverage is
   * unknowable) keeps the pre-existing full rebuild. */
  private recomputeAbsences(
    claims: readonly QuotaAbsence[],
    now: number,
    scope: ReadonlySet<string> | null = null,
    target?: AccountTarget,
  ): void {
    const laneVendors = new Set(
      this.refresherLanes.lanes.map((lane) => lane.vendor).filter((vendor) => vendor !== null),
    );
    const rebuilt = (harness: string, subjectId: string | null): boolean =>
      target
        ? target.harness === harness && target.profile_id === subjectId
        : scope === null || scope.has(harness) || !laneVendors.has(harness);
    // Every other reason answers "why is there no snapshot", so a snapshot
    // silences it. `auth_revoked` says the vendor rejected the credential;
    // `credential_profile_ambiguous` says current platform policy forbids
    // choosing the subject at all. Both authoritatively retire cached derived
    // evidence before their typed absence is projected.
    for (const claim of claims) {
      if (claim.reason !== "auth_revoked" && claim.reason !== "credential_profile_ambiguous")
        continue;
      const { harness, subject_id } = claim.subject;
      const present = [...this.snapshots.values()].some(
        (s) => s.subject.harness === harness && s.subject.subject_id === subject_id,
      );
      if (!present) continue;
      // Durable authority BEFORE the live projection (upsert/removeSubject
      // parity): a failed append after an in-memory delete would let replay
      // resurrect the revoked window on restart (f-dace28127b7a).
      this.journal.append(REMOVED, { harness, subject_id, preserve_resources: true });
      this.remove(harness, subject_id, false);
    }
    const { covered, freshCovered } = subjectCoverSets(this.activeSnapshots(now));
    this.absences = foldAbsenceClaims({
      claims,
      prior: this.absences,
      rebuilt,
      covered,
      freshCovered,
      subjects: this.subjects?.() ?? [],
      now,
    });
  }

  /** Refresh gaps coexist with stale snapshots and are silenced by fresh ones.
   * Other absences require no active snapshot. Floor-suppressed subjects gain
   * derived `poll_paced` rows (see derivePollPacedRows). */
  private activeAbsences(now: number): QuotaAbsence[] {
    const { covered, freshCovered } = subjectCoverSets(this.activeSnapshots(now));
    const rows = this.absences.filter(
      (absence) =>
        !(QUOTA_GAP_ABSENCE_REASONS.has(absence.reason) ? freshCovered : covered).has(
          quotaSubjectIdentity(absence.subject),
        ),
    );
    const subjects = this.subjects?.() ?? [];
    const lanes = this.refresherLanes.lanes;
    return rows.concat(derivePollPacedRows(lanes, subjects, rows, freshCovered, now));
  }

  /** Credential or routability state changed (login/profile/native/settings):
   * drop the credential-demand backoff so the next poll observes the new
   * subject universe instead of waiting out up to 15 minutes of old-state
   * pacing. Each lane's vendor rate-limit floor deliberately survives — a
   * login does not un-rate-limit the vendor endpoint. */
  noteCredentialChange(): void {
    this.refreshCoordinator.retireCredentialGeneration();
    for (const lane of this.refresherLanes.lanes) lane.pacer.noteCredentialChange();
  }

  /** Background official-source refresh for per-subject primary demand. One
   * single-flight sweep drives every vendor lane in order; each eligible lane
   * runs its own coalesced cycle, so one vendor's backoff never starves a
   * sibling vendor's freshness. Resolves true when any lane refreshed. */
  pollStale(): Promise<boolean> {
    if (this.pollSweepInFlight) return this.pollSweepInFlight;
    const sweep = performPollSweep(this.refresherLanes.lanes, {
      now: this.now,
      publishClockTransition: () => this.publishClockTransitionIfNeeded(),
      laneDemand: (vendor, now, dueBefore, since) =>
        laneDemand(
          vendor,
          this.activeSnapshots(now),
          this.subjects?.(),
          now,
          dueBefore,
          since,
          this.refresherLanes.lanes,
        ),
      currentGeneration: () => this.refreshCoordinator.currentGeneration(),
      isCurrentGeneration: (generation) => this.refreshCoordinator.isCurrent(generation),
      runLaneCycle: (lane) => this.refreshCycle(false, lane),
    }).finally(() => {
      if (this.pollSweepInFlight === sweep) this.pollSweepInFlight = null;
    });
    this.pollSweepInFlight = sweep;
    return sweep;
  }

  ingest(harnessId: string, value: unknown): void {
    const event = HarnessEvent.safeParse(value);
    if (!event.success) return;
    const quota = event.data.quota;
    const credentialRoute = event.data.credential_route;
    if (
      event.data.account_usage &&
      event.data.credential_profile_id &&
      credentialRoute === "vendor_native"
    ) {
      const diagnostics = event.data.account_usage;
      recordAccountResourceObservation(this.journal, this.resources, {
        target: { harness: harnessId, profile_id: event.data.credential_profile_id },
        diagnostics: observedResourceFacet(
          diagnostics,
          "claude_rate_limit_event",
          new Date(event.data.ts),
        ),
      });
      this.appendProjectionMarker("direct_mutation", this.now().toISOString());
    }
    if (quota && credentialRoute) {
      this.upsert({
        subject: {
          harness: harnessId,
          credential_route: credentialRoute,
          plan_label: quota.plan_label,
          // Reconcile the subject with the event's Claudexor profile stamp
          // (round-17 #2): a profiled run's quota must never register as the
          // engine-default subject just because the vendor record carries no
          // subject of its own. The profile stamp is the binding key used for
          // routing and quota attribution, not a claim about physical custody.
          subject_id: event.data.credential_profile_id ?? quota.subject_id ?? null,
        },
        constraints: quota.constraints,
        source: quota.source,
        observed_at: event.data.ts,
        freshness: "fresh",
      });
    }
    if (event.data.rate_limit && credentialRoute && harnessId in REACTIVE_COOLDOWN_SOURCE) {
      this.upsertCooldown(harnessId, credentialRoute, event.data);
    }
  }

  upsert(value: QuotaSnapshot): void {
    const snapshot = QuotaSnapshotSchema.parse(value);
    if (quotaSourceTraits(snapshot.source).snapshotMode === "window") {
      for (const constraint of snapshot.constraints) {
        this.recordUpsert({ ...snapshot, constraints: [constraint] });
      }
    } else {
      this.recordUpsert(snapshot);
    }
    this.appendProjectionMarker("direct_mutation", this.now().toISOString());
  }

  private recordUpsert(value: QuotaSnapshot): void {
    const valueSnapshot = QuotaSnapshotSchema.parse(value);
    const key = snapshotKey(valueSnapshot);
    const cutoff = this.supersededWindows.get(key);
    if (cutoff && Date.parse(cutoff.observed_at) > Date.parse(valueSnapshot.observed_at)) return;
    const current = this.snapshots.get(key);
    if (current && Date.parse(current.observed_at) > Date.parse(valueSnapshot.observed_at)) return;
    const { snapshot, updates, supersessions, reconciled } = reconcileQuotaSnapshot(
      valueSnapshot,
      [...this.snapshots.values()],
      this.now(),
    );
    if (!reconciled && current && sameQuotaEvidence(current, snapshot)) {
      this.apply(snapshot);
      return;
    }
    const records = [
      ...updates.flatMap(quotaSnapshotRecords),
      ...supersessions.map((payload) => ({ type: WINDOW_SUPERSEDED, payload })),
    ];
    if (records.length === 1) this.journal.append(records[0]!.type, records[0]!.payload);
    else this.journal.appendBatch(records);
    for (const update of updates) this.apply(update);
    for (const supersession of supersessions) this.applyWindowSupersession(supersession);
  }

  /** `subjectId: null` retires a harness's legacy default/native subject —
   * the unified-accounts migration's quota step (no replay alias: the new row
   * refreshes fresh, legacy null evidence is removed here or ages out). */
  removeSubject(harness: string, subjectId: string | null): number {
    // Fence held official work at the earliest credential-deletion boundary.
    this.noteCredentialChange();
    const removed = [...this.snapshots.values()].filter(
      (snapshot) =>
        snapshot.subject.harness === harness && (snapshot.subject.subject_id ?? null) === subjectId,
    ).length;
    this.journal.append(REMOVED, { harness, subject_id: subjectId });
    this.remove(harness, subjectId);
    this.appendProjectionMarker("direct_mutation", this.now().toISOString());
    return removed;
  }

  private appendProjectionMarker(
    reason: "refresh" | "direct_mutation" | "recovery" | "clock_transition",
    observedAt: string,
    response = this.read(),
    resources = this.readResources(),
  ): string {
    const projectionSignature = quotaProjectionSignature(response, resources);
    const marker = this.journal.append(PROJECTION_UPDATED, {
      reason,
      observed_at: observedAt,
      projection_signature: projectionSignature,
    });
    this.lastPublishedProjectionSignature = projectionSignature;
    return this.journal.cursorFor(marker);
  }

  private publishClockTransitionIfNeeded(): void {
    const response = this.read();
    const resources = this.readResources();
    const signature = quotaProjectionSignature(response, resources);
    if (signature === this.lastPublishedProjectionSignature) return;
    this.appendProjectionMarker("clock_transition", this.now().toISOString(), response, resources);
  }

  validateProjection(): void {
    for (const row of this.resources.values()) AccountResourceSnapshot.parse(row);
    for (const snapshot of this.snapshots.values()) QuotaSnapshotSchema.parse(snapshot);
  }

  private upsertCooldown(
    harness: string,
    credentialRoute: CredentialRoute,
    event: ReturnType<typeof HarnessEvent.parse>,
  ): void {
    const source = REACTIVE_COOLDOWN_SOURCE[harness] ?? "codex_rollout";
    // The event's profile stamp scopes the cooldown to ITS subject (round-11):
    // a profiled limit never cools the default subject down (or vice versa).
    const profileId = event.credential_profile_id ?? null;
    const existing = [...this.snapshots.values()].find(
      (snapshot) =>
        snapshot.subject.harness === harness &&
        snapshot.subject.credential_route === credentialRoute &&
        (snapshot.subject.subject_id ?? null) === profileId &&
        snapshot.source === source,
    );
    this.upsert(
      reactiveCooldownSnapshot({ harness, credentialRoute, event, source, existing }, this.now()),
    );
  }

  private apply(snapshot: QuotaSnapshot): void {
    const key = snapshotKey(snapshot);
    const cutoff = this.supersededWindows.get(key);
    if (!cutoff || Date.parse(snapshot.observed_at) >= Date.parse(cutoff.observed_at))
      this.snapshots.set(key, snapshot);
  }

  private applyWindowSupersession(value: QuotaWindowSupersession): void {
    const current = this.supersededWindows.get(value.snapshot_id);
    if (current && Date.parse(current.observed_at) >= Date.parse(value.observed_at)) return;
    this.supersededWindows.set(value.snapshot_id, value);
    const snapshot = this.snapshots.get(value.snapshot_id);
    if (snapshot && Date.parse(snapshot.observed_at) < Date.parse(value.observed_at))
      this.snapshots.delete(value.snapshot_id);
  }

  private remove(harness: string, subjectId: string | null, removeResources = true): number {
    if (subjectId !== null && removeResources) {
      this.resources.delete(resourceKey({ harness, profile_id: subjectId }));
      this.resourceCutoffs.delete(resourceKey({ harness, profile_id: subjectId }));
    }
    for (const [key, value] of this.supersededWindows) {
      if (value.subject.harness === harness && value.subject.subject_id === subjectId)
        this.supersededWindows.delete(key);
    }
    let removed = 0;
    for (const [key, snapshot] of this.snapshots) {
      if (snapshot.subject.harness === harness && snapshot.subject.subject_id === subjectId) {
        this.snapshots.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}
