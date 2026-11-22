import {
  quotaConstraintAppliesToRequestKind,
  quotaWindowFreshness,
  type AccountTier,
  type AccountTierPolicy,
  type CredentialProfile,
  type QuotaRequestKind,
  type QuotaSnapshot,
} from "@claudexor/schema";
import { quotaConstraintAppliesToModel } from "@claudexor/budget";
import { profileHeadroomBreach, type HeadroomBreach } from "./credential-profile-rotation.js";

/**
 * Account tiers for a run that states a complexity (INV-135). The policy is
 * harness-agnostic: it reads a row's `tier` and the quota windows every source
 * reports in one model, never which vendor the account belongs to.
 *
 * - Auxiliary rows serve first. Among those with known room, the one whose
 *   limiting window resets soonest goes first, since its unused quota is lost
 *   at that reset.
 * - Untiered rows keep the ordinary pool order and come next.
 * - A primary row serves last, and only while every fresh window is below the
 *   configured reserve. The remainder belongs to runs that state no complexity,
 *   so a primary row at or over the reserve is refused as the owner's reserve.
 * - Unknown or stale quota ranks after every row with known room and is never
 *   room on a primary row: such a row is not selectable.
 *
 * A run without a complexity never builds this policy, so its routing is
 * exactly the pool order it had before.
 */
export interface TierRouting {
  reserve: AccountTierPolicy["primary_reserve"];
}

export function tierRoutingFor(
  complexity: unknown,
  policy: AccountTierPolicy | undefined,
): TierRouting | null {
  return complexity && policy ? { reserve: policy.primary_reserve } : null;
}

export const PRIMARY_QUOTA_UNKNOWN = "primary_quota_unknown";

export type PrimaryReserveVerdict =
  { kind: "room" } | { kind: "unknown" } | { kind: "reserved"; breach: HeadroomBreach };

/** Judge one primary row against the reserve, from fresh applicable windows only. */
export function primaryReserveVerdict(
  tier: TierRouting,
  snapshots: readonly QuotaSnapshot[],
  harnessId: string,
  profileId: string,
  model?: string | null,
  requestKind?: QuotaRequestKind,
  now: number = Date.now(),
): PrimaryReserveVerdict {
  let known = false;
  let breach: HeadroomBreach | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.subject.harness !== harnessId) continue;
    if ((snapshot.subject.subject_id ?? null) !== profileId) continue;
    for (const constraint of snapshot.constraints) {
      if (quotaWindowFreshness(snapshot, constraint, now) !== "fresh") continue;
      if (!quotaConstraintAppliesToRequestKind(constraint, requestKind)) continue;
      if (!quotaConstraintAppliesToModel(constraint, model)) continue;
      if (constraint.used_ratio === null) continue;
      known = true;
      const short =
        constraint.window_seconds !== null &&
        constraint.window_seconds <= tier.reserve.short_window_max_seconds;
      const threshold = short
        ? tier.reserve.short_window_used_ratio
        : tier.reserve.weekly_used_ratio;
      if (constraint.used_ratio < threshold) continue;
      // The most used reserved window speaks; a tie keeps the first one read.
      if (breach && constraint.used_ratio <= breach.used_ratio) continue;
      breach = {
        constraint_id: constraint.id,
        used_ratio: constraint.used_ratio,
        threshold,
        resets_at: constraint.resets_at,
      };
    }
  }
  if (breach) return { kind: "reserved", breach };
  return known ? { kind: "room" } : { kind: "unknown" };
}

type BreachReader = typeof profileHeadroomBreach;

/**
 * `profileHeadroomBreach` with the primary reserve folded in: for a primary
 * row of a complexity run, a window at or over the reserve is a breach below
 * 100%, which every consumer already states as the owner's reserve. Without a
 * tier policy this is the ordinary reader.
 */
export function tierHeadroomBreach(
  tier: TierRouting | null | undefined,
  registry: readonly CredentialProfile[],
): BreachReader {
  if (!tier) return profileHeadroomBreach;
  return (snapshots, harnessId, profileId, threshold, model, requestKind, now) => {
    const base = profileHeadroomBreach(
      snapshots,
      harnessId,
      profileId,
      threshold,
      model,
      requestKind,
      now,
    );
    if (base || profileId === null) return base;
    if (tierOf(registry, harnessId, profileId) !== "primary") return null;
    const verdict = primaryReserveVerdict(
      tier,
      snapshots,
      harnessId,
      profileId,
      model,
      requestKind,
      now,
    );
    return verdict.kind === "reserved" ? verdict.breach : null;
  };
}

export function tierOf(
  registry: readonly CredentialProfile[],
  harnessId: string,
  profileId: string | null,
): AccountTier | null {
  if (profileId === null) return null;
  return (
    registry.find((row) => row.harness_id === harnessId && row.profile_id === profileId)?.tier ??
    null
  );
}

/** A primary row whose quota is unknown or stale cannot prove it is below the reserve. */
export function primaryQuotaUnknown(
  tier: TierRouting | null | undefined,
  profile: Pick<CredentialProfile, "harness_id" | "profile_id" | "tier">,
  snapshots: readonly QuotaSnapshot[],
  model?: string | null,
  requestKind?: QuotaRequestKind,
  now?: number,
): boolean {
  if (!tier || profile.tier !== "primary") return false;
  return (
    primaryReserveVerdict(
      tier,
      snapshots,
      profile.harness_id,
      profile.profile_id,
      model,
      requestKind,
      now,
    ).kind === "unknown"
  );
}

/** The typed refusal of a pinned primary row whose quota cannot be read. */
export function primaryQuotaUnknownRefusal(profile: CredentialProfile): Error {
  return Object.assign(
    new Error(
      `credential profile "${profile.profile_id}" (${profile.harness_id}) is a primary account ` +
        `whose quota is unknown or stale, so a run that states a complexity cannot prove it is ` +
        `below the primary reserve; a pinned account never rotates`,
    ),
    {
      code: PRIMARY_QUOTA_UNKNOWN,
      category: "harness_unavailable",
      resetsAt: null,
    },
  );
}

/** Tier position among selectable rows: lower serves first. */
export function tierGroup(tier: AccountTier | null | undefined, knownRoom: boolean): number {
  if (knownRoom) return tier === "auxiliary" ? 0 : tier === "primary" ? 2 : 1;
  return tier === "auxiliary" ? 3 : 4;
}

/** Soonest reset first; a window with no known reset has nothing to lose and goes last. */
export function bySoonestReset(a: string | null, b: string | null): number {
  const at = a ? Date.parse(a) : Number.NaN;
  const bt = b ? Date.parse(b) : Number.NaN;
  const av = Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
  const bv = Number.isFinite(bt) ? bt : Number.POSITIVE_INFINITY;
  return av === bv ? 0 : av < bv ? -1 : 1;
}

/** In-run rotation order for a complexity run: auxiliary, untiered, then primary. */
export function tierRotationOrder(
  registry: readonly CredentialProfile[],
  harnessId: string,
  eligible: readonly string[],
): string[] {
  const rows = registry.filter((row) => row.harness_id === harnessId && row.enabled);
  const ordered =
    eligible.length > 0
      ? eligible.flatMap((id) => rows.filter((row) => row.profile_id === id))
      : rows;
  const rank = (row: CredentialProfile) =>
    row.tier === "auxiliary" ? 0 : row.tier === "primary" ? 2 : 1;
  return ordered
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
    .map(({ row }) => row.profile_id);
}

/** A complexity run never rotates into a primary row at or over its reserve,
 * or one whose quota is unknown. Without a tier policy nothing is added. */
export function tierRotationExcluded(
  tier: TierRouting | null,
  registry: readonly CredentialProfile[],
  snapshots: readonly QuotaSnapshot[],
  harnessId: string,
  excluded: ReadonlySet<string>,
  model: string | null,
): ReadonlySet<string> {
  if (!tier) return excluded;
  const out = new Set(excluded);
  for (const row of registry) {
    if (row.harness_id !== harnessId || row.tier !== "primary") continue;
    const verdict = primaryReserveVerdict(tier, snapshots, harnessId, row.profile_id, model);
    if (verdict.kind !== "room") out.add(row.profile_id);
  }
  return out;
}
