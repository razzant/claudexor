/**
 * Pure per-snapshot helpers of the QuotaRegistry, split to a smaller owner
 * (complexity ratchet): durable-journal v3.2.0 rollback shaping, snapshot
 * keying, freshness aging, and expired scoped-cooldown pruning. No registry
 * state lives here.
 */
import {
  QUOTA_FRESHNESS_TTL_MS,
  REACTIVE_COOLDOWN_SOURCE,
  REOPENING_UNKNOWN_COOLDOWN_ID,
  legacyV320QuotaSource,
  quotaWindowFreshness,
  quotaSourceTraits,
  quotaSnapshotIdentity,
  quotaConstraintIdentity,
  type QuotaWindowSupersession,
  QuotaWindowObservation,
  vendorResetDayCooldownEnd,
  type CredentialRoute,
  type HarnessEvent,
  type QuotaConstraint,
  type ControlQuotaFreshnessSnapshot,
  type QuotaSnapshot,
  type QuotaSource,
} from "@claudexor/schema";
import { hashJson } from "@claudexor/util";

/** The reactive vendor-limit cooldown snapshot for a harness event: the
 * existing subject's constraints minus the superseded/expired cooldown, plus
 * the new bounded cooldown window. Pure: it only reads the snapshots it is handed. */
export function reactiveCooldownSnapshot(
  input: {
    harness: string;
    credentialRoute: CredentialRoute;
    event: HarnessEvent;
    source: QuotaSource;
    /** The registry's current snapshots; this subject's own cooldown record is extended. */
    current: Iterable<QuotaSnapshot>;
  },
  now: Date,
): QuotaSnapshot {
  const { harness, credentialRoute, event, source } = input;
  // The event's profile stamp scopes the cooldown to ITS subject (round-11):
  // a profiled limit never cools the default subject down (or vice versa).
  const profileId = event.credential_profile_id ?? null;
  const existing = [...input.current].find(
    (snapshot) =>
      snapshot.subject.harness === harness &&
      snapshot.subject.credential_route === credentialRoute &&
      (snapshot.subject.subject_id ?? null) === profileId &&
      snapshot.source === source,
  );
  const reset = event.rate_limit?.resets_at ?? null;
  const delay = event.rate_limit?.retry_delay_ms ?? null;
  // A day-granular vendor reset (A1 payload) bounds the cooldown at end-of-day UTC.
  const cooldownUntil =
    reset ??
    vendorResetDayCooldownEnd(event.payload) ??
    new Date(now.getTime() + (typeof delay === "number" ? delay : 5 * 60_000)).toISOString();
  // #558: a usage refusal with no reopening time keeps its provenance in the
  // cooldown's own engine-owned identity: no usage or reset is invented for it.
  const constraintId =
    event.rate_limit?.reopening === "unknown"
      ? REOPENING_UNKNOWN_COOLDOWN_ID
      : event.rate_limit?.constraint_id
        ? `cooldown:${event.rate_limit.constraint_id}`
        : "cooldown";
  return {
    subject: existing?.subject ?? {
      harness,
      credential_route: credentialRoute,
      plan_label: null,
      subject_id: event.credential_profile_id ?? null,
    },
    source,
    observed_at: event.ts,
    freshness: "fresh",
    constraints: [
      ...(existing?.constraints.filter(
        (constraint) =>
          constraint.id !== constraintId &&
          !isExpiredScopedCooldown(source, constraint, now.getTime()),
      ) ?? []),
      {
        id: constraintId,
        label: "Cooldown",
        ...(event.rate_limit?.applies_to_models !== undefined
          ? { applies_to_models: event.rate_limit.applies_to_models }
          : {}),
        ...(event.rate_limit?.applies_to_model_prefixes
          ? { applies_to_model_prefixes: event.rate_limit.applies_to_model_prefixes }
          : {}),
        ...(event.rate_limit?.applies_to_request_kinds
          ? { applies_to_request_kinds: event.rate_limit.applies_to_request_kinds }
          : {}),
        used_ratio: null,
        window_seconds: null,
        resets_at: reset,
        cooldown_until: cooldownUntil,
      },
    ],
  };
}

/** Snapshots older than this are pruned from every projection read (W17):
 * a day-old observation is not quota truth, just footer clutter. */
const MAX_SNAPSHOT_AGE_MS = 24 * 60 * 60_000;

/** Freshness-annotated snapshots with expired (>24h) observations pruned.
 * An old observation whose constraint still EXTENDS into the future (a
 * weekly cooldown/reset seen once) is kept and stale-marked: pruning it
 * would hide a live cap from both the footer and the router's ledger.
 * `age` is `staleAt` for display/demand; admission passes `observationStaleAt`
 * and judges each window's own reset at its decision (quotaWindowFreshness). */
export function activeQuotaSnapshots(
  snapshots: readonly QuotaSnapshot[],
  now: number,
  age: (snapshot: QuotaSnapshot, now: number) => QuotaSnapshot = staleAt,
): QuotaSnapshot[] {
  return activeRawQuotaSnapshots(snapshots, now).map((snapshot) => age(snapshot, now));
}

/** Passive display projection. Apply the SAME aging rule to each singleton
 * window using raw freshness, before aggregate aging can erase that evidence. */
export function activeQuotaSnapshotsWithConstraintFreshness(
  snapshots: readonly QuotaSnapshot[],
  now: number,
): ControlQuotaFreshnessSnapshot[] {
  return activeRawQuotaSnapshots(snapshots, now).map((snapshot) => ({
    ...staleAt(snapshot, now),
    constraints: snapshot.constraints.map((constraint) => ({
      ...constraint,
      freshness: quotaWindowFreshness(snapshot, constraint, now),
    })),
  }));
}

function activeRawQuotaSnapshots(
  snapshots: readonly QuotaSnapshot[],
  now: number,
): QuotaSnapshot[] {
  return snapshots
    .map((snapshot) => withoutExpiredScopedCooldowns(snapshot, now))
    .filter((snapshot): snapshot is QuotaSnapshot => snapshot !== null)
    .filter((snapshot) => {
      const observed = Date.parse(snapshot.observed_at);
      if (!Number.isFinite(observed)) return false;
      if (now - observed <= MAX_SNAPSHOT_AGE_MS) return true;
      return snapshot.constraints.some((constraint) =>
        [constraint.cooldown_until, constraint.resets_at].some((raw) => {
          const at = raw ? Date.parse(raw) : Number.NaN;
          return Number.isFinite(at) && at > now;
        }),
      );
    });
}

export { QUOTA_FRESHNESS_TTL_MS };

/** Same quota EVIDENCE: everything but the observation time (a freshness flip
 * is evidence). A poll that only re-observed unchanged evidence keeps the fresh
 * `observed_at` in memory without a journal frame. */
export function sameQuotaEvidence(a: QuotaSnapshot, b: QuotaSnapshot): boolean {
  return hashJson({ ...a, observed_at: null }) === hashJson({ ...b, observed_at: null });
}

/** Retire only restrictions superseded by a later authenticated primary read.
 * The registry must journal a changed result even when the primary read only
 * changed its timestamp. Keep the old observation's time and unrelated facts. */
export function withoutSupersededQuotaConstraints(
  existing: QuotaSnapshot,
  observation: QuotaSnapshot,
  now: Date,
): QuotaSnapshot {
  const traits = quotaSourceTraits(observation.source);
  if (
    !traits.vendorAuthenticated ||
    traits.refreshDemandHarness !== observation.subject.harness ||
    staleAt(observation, now.getTime()).freshness !== "fresh" ||
    REACTIVE_COOLDOWN_SOURCE[existing.subject.harness] !== existing.source ||
    existing.subject.harness !== observation.subject.harness ||
    existing.subject.credential_route !== observation.subject.credential_route ||
    existing.subject.subject_id !== observation.subject.subject_id ||
    !(Date.parse(observation.observed_at) > Date.parse(existing.observed_at))
  ) {
    return existing;
  }
  const constraints = existing.constraints.filter((constraint) => {
    // A usage refusal with no reopening time (#558) outlives every read
    // (#318): an empty, unknown or measured window does not show that the
    // refused usage or credits returned. Only its own bounded recheck
    // (`cooldown_until`, which no read moves) ends the block.
    if (constraint.id === REOPENING_UNKNOWN_COOLDOWN_ID) return true;
    // A generic refusal retained no window identity. A successful recognized
    // read permits the next requested attempt, including unknown/empty quota;
    // it does not promise that the provider will accept that attempt. Its
    // request-kind scope narrows what it blocks, not which read retires it.
    if (
      constraint.id === "cooldown" &&
      !constraint.applies_to_models?.length &&
      !constraint.applies_to_model_prefixes?.length
    ) {
      return false;
    }
    // Independently identified windows require a measured replacement of the
    // same window and scope. Absence/unknown usage cannot disprove one.
    return !observation.constraints.some(
      (current) =>
        current.used_ratio !== null &&
        sameQuotaWindow(existing.source, constraint.id, current.id) &&
        sameModelScope(constraint, legacyKindComparable(constraint, current)),
    );
  });
  return constraints.length === existing.constraints.length
    ? existing
    : { ...existing, constraints };
}

function sameQuotaWindow(source: QuotaSource, oldId: string, newId: string): boolean {
  const id = oldId.startsWith("cooldown:") ? oldId.slice("cooldown:".length) : oldId;
  if (id === newId) return true;
  // Codex rollout omits the native default bucket id that app-server includes.
  // A different bucket (for example review) is an independent constraint.
  return source === "codex_rollout" && (newId === `codex:${id}` || newId === `default:${id}`);
}

/** Journals written before request-kind scope recorded known windows without
 * one, which meant universal. Compare a newer explicit-kind measurement
 * without that kind only when its duration is identical (null matches only
 * null, as in quotaConstraintIdentity): the reactive path's scope comparison
 * does not see duration. Explicit text/image scopes never cross. */
function legacyKindComparable(old: QuotaConstraint, current: QuotaConstraint): QuotaConstraint {
  if (
    old.applies_to_request_kinds ||
    !current.applies_to_request_kinds ||
    old.window_seconds !== current.window_seconds
  )
    return current;
  const { applies_to_request_kinds: _kinds, ...unscoped } = current;
  return unscoped;
}

function sameModelScope(a: QuotaConstraint, b: QuotaConstraint): boolean {
  return hashJson(quotaModelScope(a)) === hashJson(quotaModelScope(b));
}

function quotaModelScope(constraint: QuotaConstraint) {
  const { id, label, used_ratio, window_seconds, resets_at, cooldown_until, ...scope } = constraint;
  return {
    ...scope,
    applies_to_models: [...(scope.applies_to_models ?? [])].sort(),
    applies_to_unspecified_model: scope.applies_to_unspecified_model ?? false,
  };
}

/** Match only a measured replacement of the exact known window, never an
 * absent window, unknown usage, another credential or a different scope. */
function windowSupersession(
  existing: QuotaSnapshot,
  observation: QuotaSnapshot,
  now: Date,
): QuotaWindowSupersession | null {
  if (
    quotaSourceTraits(existing.source).snapshotMode !== "window" ||
    !quotaSourceTraits(observation.source).vendorAuthenticated ||
    quotaSourceTraits(observation.source).refreshDemandHarness !== observation.subject.harness ||
    staleAt(observation, now.getTime()).freshness !== "fresh" ||
    existing.subject.harness !== observation.subject.harness ||
    existing.subject.credential_route !== observation.subject.credential_route ||
    existing.subject.subject_id !== observation.subject.subject_id ||
    Date.parse(observation.observed_at) <= Date.parse(existing.observed_at)
  )
    return null;
  const identity = quotaConstraintIdentity(existing.constraints[0]!);
  if (
    !observation.constraints.some(
      (constraint) =>
        constraint.used_ratio !== null &&
        (quotaConstraintIdentity(legacyKindComparable(existing.constraints[0]!, constraint)) ===
          identity ||
          (existing.source === "codex_image_response" &&
            existing.constraints[0]!.window_seconds === null &&
            sameQuotaWindow(existing.source, existing.constraints[0]!.id, constraint.id) &&
            sameModelScope(existing.constraints[0]!, constraint))),
    )
  )
    return null;
  return {
    version: 1,
    subject: existing.subject,
    snapshot_id: snapshotKey(existing),
    observed_at: observation.observed_at,
  };
}

/** One reconciliation over the current raw snapshots; the registry commits all
 * returned facts together before updating any in-memory projection. */
export function reconcileQuotaSnapshot(
  value: QuotaSnapshot,
  existing: readonly QuotaSnapshot[],
  now: Date,
) {
  let snapshot = value;
  const witnesses: QuotaSnapshot[] = [];
  const supersessions: QuotaWindowSupersession[] = [];
  for (const observation of existing) {
    const atObservation = new Date(observation.observed_at);
    const reduced = withoutSupersededQuotaConstraints(snapshot, observation, atObservation);
    const supersession = windowSupersession(snapshot, observation, atObservation);
    if (reduced !== snapshot || supersession) witnesses.push(observation);
    if (supersession) supersessions.push(supersession);
    snapshot = reduced;
  }
  const retired = existing.flatMap((prior) => {
    const supersession = windowSupersession(prior, snapshot, now);
    if (supersession) supersessions.push(supersession);
    const next = withoutSupersededQuotaConstraints(prior, snapshot, now);
    return next === prior ? [] : [next];
  });
  return {
    snapshot,
    updates: [...witnesses, snapshot, ...retired],
    supersessions,
    reconciled: witnesses.length > 0 || retired.length > 0 || supersessions.length > 0,
  };
}

/** Existing prepare/upsert wire shape, reusable for an atomic reconciliation. */
export function quotaSnapshotRecords(
  snapshot: QuotaSnapshot,
): Array<{ type: string; payload: unknown }> {
  if (quotaSourceTraits(snapshot.source).snapshotMode === "window") {
    return [
      {
        type: "quota.window.observed",
        payload: QuotaWindowObservation.parse({ version: 1, snapshot }),
      },
    ];
  }
  const legacy = legacyV320Snapshot(snapshot);
  const upsert = { type: "quota.snapshot.upserted", payload: legacy };
  if (
    legacy.source === snapshot.source &&
    !snapshot.constraints.some(
      (c) =>
        c.applies_to_models !== undefined ||
        c.applies_to_model_prefixes !== undefined ||
        c.applies_to_request_kinds !== undefined,
    )
  )
    return [upsert];
  return [
    {
      type: "quota.snapshot.scoped_prepared",
      payload: { version: 1, base_hash: hashJson(legacy), snapshot },
    },
    upsert,
  ];
}

export function snapshotKey(snapshot: QuotaSnapshot): string {
  return quotaSnapshotIdentity(snapshot);
}

/** Exact durable payload accepted by the strict v3.2.0 quota schemas. Keep an
 * explicit allowlist at every nested level so a future additive field cannot
 * silently make updater rollback boot-incompatible again. */
export function legacyV320Snapshot(snapshot: QuotaSnapshot): QuotaSnapshot {
  return {
    subject: {
      harness: snapshot.subject.harness,
      credential_route: snapshot.subject.credential_route,
      plan_label: snapshot.subject.plan_label,
      subject_id: snapshot.subject.subject_id,
    },
    constraints: snapshot.constraints
      .filter(
        (constraint) =>
          !constraint.applies_to_request_kinds ||
          constraint.applies_to_request_kinds.includes("text"),
      )
      .map((constraint): QuotaConstraint => ({
        id: constraint.id,
        label: constraint.label,
        used_ratio: constraint.used_ratio,
        window_seconds: constraint.window_seconds,
        resets_at: constraint.resets_at,
        cooldown_until: constraint.cooldown_until,
      })),
    source: legacyV320QuotaSource(snapshot.source),
    observed_at: snapshot.observed_at,
    freshness: snapshot.freshness,
  };
}

/** Aggregate freshness: stale once the observation TTL passes or ANY window's
 * reset is reached (display, demand and journal signatures). */
export function staleAt(snapshot: QuotaSnapshot, now: number): QuotaSnapshot {
  const aged = observationStaleAt(snapshot, now);
  if (aged.freshness !== "fresh") return aged;
  const resetExpired = snapshot.constraints.some(
    (constraint) => quotaWindowFreshness(snapshot, constraint, now) !== "fresh",
  );
  return resetExpired ? { ...snapshot, freshness: "stale" } : snapshot;
}

/** The snapshot-wide part of `staleAt` only: raw label and observation TTL.
 * A sibling window's elapsed reset does not age the other windows. */
export function observationStaleAt(snapshot: QuotaSnapshot, now: number): QuotaSnapshot {
  if (snapshot.freshness !== "fresh") return snapshot;
  const observed = Date.parse(snapshot.observed_at);
  const tooOld = !Number.isFinite(observed) || now - observed > QUOTA_FRESHNESS_TTL_MS;
  return tooOld ? { ...snapshot, freshness: "stale" } : snapshot;
}

/** The instant at which a fresh snapshot stops satisfying primary demand: its
 * TTL expiry or its earliest reset boundary, whichever comes first. A stale or
 * unreadable observation is already due (-Infinity). One owner for "when is
 * this evidence due" — the demand horizon check and the lane renewal cap both
 * read it, so they can never disagree by a tick. */
export function quotaSnapshotDueAt(snapshot: QuotaSnapshot): number {
  if (snapshot.freshness !== "fresh") return Number.NEGATIVE_INFINITY;
  const observed = Date.parse(snapshot.observed_at);
  if (!Number.isFinite(observed)) return Number.NEGATIVE_INFINITY;
  const resets = snapshot.constraints
    .map((constraint) => (constraint.resets_at ? Date.parse(constraint.resets_at) : Number.NaN))
    .filter((at) => Number.isFinite(at));
  return Math.min(observed + QUOTA_FRESHNESS_TTL_MS, ...resets);
}

function resetExpiredAt(constraint: Pick<QuotaConstraint, "resets_at">, now: number): boolean {
  const reset = constraint.resets_at ? Date.parse(constraint.resets_at) : Number.NaN;
  return Number.isFinite(reset) && reset <= now;
}

export function isExpiredScopedCooldown(
  source: QuotaSnapshot["source"],
  constraint: QuotaConstraint,
  now: number,
): boolean {
  // Every reactive cooldown source (the upsertCooldown producers), not a claude-only
  // name check: an expired scoped sibling never hides a newer active one (Q24 generalized).
  return (
    Object.values(REACTIVE_COOLDOWN_SOURCE).includes(source) &&
    constraint.id.startsWith("cooldown:") &&
    resetExpiredAt(constraint, now)
  );
}

export function withoutExpiredScopedCooldowns(
  snapshot: QuotaSnapshot,
  now: number,
): QuotaSnapshot | null {
  const constraints = snapshot.constraints.filter(
    (constraint) => !isExpiredScopedCooldown(snapshot.source, constraint, now),
  );
  if (constraints.length === snapshot.constraints.length) return snapshot;
  return constraints.length === 0 ? null : { ...snapshot, constraints };
}
