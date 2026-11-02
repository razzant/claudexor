import {
  quotaConstraintAppliesToRequestKind,
  quotaWindowFreshness,
  type QuotaRefusalBasis,
  type QuotaRequestKind,
} from "@claudexor/schema";
import type {
  CredentialProfile,
  ModelSubstitutionObservation,
  PreProgressRefusalObservation,
  QuotaSnapshot,
} from "@claudexor/schema";
import { quotaConstraintAppliesToModel } from "@claudexor/budget";
import { profileQuotaBlock } from "./credential-cooldown.js";
import { limitSubjectRoute, profileHeadroomBreach } from "./credential-profile-rotation.js";
import { liveRefusalMarks } from "./pre-progress-refusal.js";
import { quotaRefusalBasis, quotaRefusalResetsAt } from "./quota-refusal-scope.js";

/**
 * Quota-aware ACCOUNT POOL of the unified account model (INV-135 rewrite,
 * owner decisions D-U1 + K.5): with no explicit pin and no thread binding, an
 * unpinned run routes to the best enabled+ready account row of its harness.
 *
 * Ranking (D3 freshness preserved — stale quota never authorizes routing):
 *   1. rows with FRESH model-applicable quota evidence and headroom below the
 *      exhaustion bound, by known headroom DESCENDING;
 *   2. rows with unknown/stale quota (eligible, but never ranked as known
 *      headroom);
 *   3. exhausted rows (fresh evidence at/over the policy threshold) — never
 *      selected; they only count toward "the pool is exhausted".
 * Ties break deterministically by profile id (ascending).
 *
 * One key precedes that order among the SELECTABLE rows (1 and 2): a row with a
 * live mark for the requested model ranks after every other selectable row,
 * oldest mark first (a row's newest mark counts), so a fully marked pool takes
 * turns instead of re-picking its top-headroom row. Two observations mark a
 * row: a model-substitution observation — it recently answered this model's
 * request with a different model (model operations only) — and a pre-progress
 * refusal observation — its started session recently refused this model's
 * request before any progress (#363, Agent Runs). A mark never excludes a row
 * and never makes a pool exhausted.
 *
 * Among rows that are otherwise equal with UNKNOWN headroom, the row that most
 * recently served this requested model ranks first (durable last-served facts,
 * INV-135), before the profile-id tie-break. It never outranks known headroom,
 * a mark, a cooldown or a pin, and a row with no service history keeps id order.
 *
 * The pool contains SUBSCRIPTION-kind rows only: an api_key row is a paid
 * route and is never silently selected (INV-061); it remains an explicit pin
 * target. Pool exhaustion is the typed `credential_pool_exhausted` terminal
 * (owner Q3=A); the paid API-key ROUTE serves it only under the EXPLICIT
 * api_key preference — never silently under auto.
 */

export type PoolQuotaVerdict =
  | { kind: "fresh_headroom"; headroom: number }
  | { kind: "unknown" }
  | {
      kind: "exhausted";
      resets_at: string | null;
      basis: QuotaRefusalBasis;
      /** A usage refusal with no reopening time (#558): no instant heals this row. */
      reopening?: "unknown";
    };

export interface PoolCandidate {
  profile: CredentialProfile;
  verdict: PoolQuotaVerdict;
}

/** Durable last-served facts, read once per ranking (higher = more recent). */
export interface LastServiceReader {
  orders(
    harnessId: string,
    model: string | null,
    profiles: readonly CredentialProfile[],
  ): ReadonlyMap<string, number>;
}

/** The subscription-kind enabled rows of one harness (the static pool). */
export function accountPoolRows(
  registry: readonly CredentialProfile[],
  harnessId: string,
): CredentialProfile[] {
  return registry.filter(
    (profile) =>
      profile.harness_id === harnessId && profile.enabled && profile.credential_kind !== "api_key",
  );
}

/** Worst-window FRESH model-applicable headroom for one subject, or null when
 * no fresh applicable evidence exists (unknown/stale — D3: display-only). Each
 * window's freshness is judged at the decision instant (#457). */
function freshModelHeadroom(
  snapshots: readonly QuotaSnapshot[],
  harnessId: string,
  profileId: string,
  model: string | null | undefined,
  requestKind: QuotaRequestKind | undefined,
  now: number,
): number | null {
  let worst: number | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.subject.harness !== harnessId) continue;
    if ((snapshot.subject.subject_id ?? null) !== profileId) continue;
    for (const constraint of snapshot.constraints) {
      if (quotaWindowFreshness(snapshot, constraint, now) !== "fresh") continue;
      if (!quotaConstraintAppliesToRequestKind(constraint, requestKind)) continue;
      if (!quotaConstraintAppliesToModel(constraint, model)) continue;
      if (constraint.used_ratio === null) continue;
      const headroom = 1 - constraint.used_ratio;
      if (worst === null || headroom < worst) worst = headroom;
    }
  }
  return worst;
}

/**
 * Rank one harness's READY pool rows per the unified-model comparator. Rows
 * outside `readyProfileIds` are excluded entirely (not ready ≠ exhausted).
 */
export function rankAccountPool(args: {
  registry: readonly CredentialProfile[];
  harnessId: string;
  snapshots: readonly QuotaSnapshot[];
  readyProfileIds: ReadonlySet<string>;
  excludedProfileIds?: ReadonlySet<string>;
  headroomThreshold: number;
  model?: string | null;
  requestKind?: QuotaRequestKind;
  /** Live model-substitution observations; only this harness and model apply. */
  substitutions?: readonly ModelSubstitutionObservation[];
  /** Live pre-progress refusal observations; only this harness and model apply. */
  refusals?: readonly PreProgressRefusalObservation[];
  /** Durable last-served facts for the final unknown-headroom tie-break. */
  lastService?: LastServiceReader | null;
}): PoolCandidate[] {
  const now = Date.now();
  const markedAt = liveRefusalMarks(args.refusals ?? [], args.harnessId, args.model, now);
  for (const obs of args.substitutions ?? []) {
    if (obs.harness_id !== args.harnessId || obs.requested_model !== args.model) continue;
    const observed = Date.parse(obs.observed_at);
    const expires = Date.parse(obs.expires_at);
    if (!Number.isFinite(observed) || !Number.isFinite(expires) || expires <= now) continue;
    markedAt.set(obs.profile_id, Math.max(observed, markedAt.get(obs.profile_id) ?? observed));
  }
  const candidates: PoolCandidate[] = [];
  for (const profile of accountPoolRows(args.registry, args.harnessId)) {
    if (args.excludedProfileIds?.has(profile.profile_id)) continue;
    if (!args.readyProfileIds.has(profile.profile_id)) continue;
    const breach = profileHeadroomBreach(
      args.snapshots,
      args.harnessId,
      profile.profile_id,
      args.headroomThreshold,
      args.model,
      args.requestKind,
      now,
    );
    // A4 cooldown reader: a row under an OBSERVED live block (reactive
    // vendor-limit cooldown or spent window, stale-but-live included) ranks
    // exhausted with its earliest known release instant — selecting it would
    // burn an attempt to rediscover the limit the registry already holds. The
    // block is read route-scoped (the row's own credential kind), so an
    // api-key sibling's window can never cool a subscription row. Its basis
    // separates the owner's reserve from provider exhaustion (#318).
    const block = profileQuotaBlock(
      args.snapshots,
      args.harnessId,
      profile.profile_id,
      limitSubjectRoute(profile),
      args.model,
      undefined,
      args.requestKind,
    );
    const refusal = quotaRefusalBasis(breach, block);
    if (refusal) {
      candidates.push({
        profile,
        verdict: {
          kind: "exhausted",
          resets_at: quotaRefusalResetsAt(breach, block),
          basis: refusal.basis,
          ...(block?.reopening ? { reopening: block.reopening } : {}),
        },
      });
      continue;
    }
    const headroom = freshModelHeadroom(
      args.snapshots,
      args.harnessId,
      profile.profile_id,
      args.model,
      args.requestKind,
      now,
    );
    candidates.push({
      profile,
      verdict: headroom === null ? { kind: "unknown" } : { kind: "fresh_headroom", headroom },
    });
  }
  const unknown = candidates.filter((candidate) => candidate.verdict.kind === "unknown");
  const served =
    unknown.length > 1 && args.lastService
      ? args.lastService.orders(
          args.harnessId,
          args.model ?? null,
          unknown.map((candidate) => candidate.profile),
        )
      : new Map<string, number>();
  const rankOf = (verdict: PoolQuotaVerdict): number =>
    verdict.kind === "fresh_headroom" ? 0 : verdict.kind === "unknown" ? 1 : 2;
  // Exhausted rows keep their place at the end whatever their mark says.
  const orderOf = (candidate: PoolCandidate): number =>
    candidate.verdict.kind === "exhausted" ? 2 : markedAt.has(candidate.profile.profile_id) ? 1 : 0;
  return candidates.sort((a, b) => {
    const byOrder = orderOf(a) - orderOf(b);
    if (byOrder !== 0) return byOrder;
    if (orderOf(a) === 1) {
      const byAge = markedAt.get(a.profile.profile_id)! - markedAt.get(b.profile.profile_id)!;
      if (byAge !== 0) return byAge;
    }
    const byRank = rankOf(a.verdict) - rankOf(b.verdict);
    if (byRank !== 0) return byRank;
    if (a.verdict.kind === "fresh_headroom" && b.verdict.kind === "fresh_headroom") {
      const byHeadroom = b.verdict.headroom - a.verdict.headroom;
      if (byHeadroom !== 0) return byHeadroom;
    }
    if (a.verdict.kind === "unknown" && b.verdict.kind === "unknown") {
      const byService =
        (served.get(b.profile.profile_id) ?? 0) - (served.get(a.profile.profile_id) ?? 0);
      if (byService !== 0) return byService;
    }
    return a.profile.profile_id < b.profile.profile_id
      ? -1
      : a.profile.profile_id > b.profile.profile_id
        ? 1
        : 0;
  });
}

export type PoolSelection =
  | { outcome: "selected"; candidate: PoolCandidate }
  | {
      /** Every ready row is exhausted, or nothing is ready at all: the run
       * terminalizes on the typed `credential_pool_exhausted` refusal (Q3=A)
       * unless the EXPLICIT api_key preference opts into the paid route. */
      outcome: "exhausted" | "empty";
      /** Earliest known window reset among exhausted rows, when any. */
      resets_at: string | null;
      /** Every exhausted row stopped only at the owner's saved reserve. */
      reserveOnly?: boolean;
    };

/** Select the unpinned-run account from the pool (or report why not). */
export function selectFromAccountPool(args: Parameters<typeof rankAccountPool>[0]): PoolSelection {
  const ranked = rankAccountPool(args);
  const selectable = ranked.find((candidate) => candidate.verdict.kind !== "exhausted");
  if (selectable) return { outcome: "selected", candidate: selectable };
  if (ranked.length === 0) return { outcome: "empty", resets_at: null };
  let resetsAt: string | null = null;
  let reserveOnly = true;
  let reopeningUnknown = false;
  for (const candidate of ranked) {
    if (candidate.verdict.kind !== "exhausted") continue;
    if (candidate.verdict.basis !== "owner_reserve") reserveOnly = false;
    if (candidate.verdict.reopening === "unknown") reopeningUnknown = true;
    if (candidate.verdict.resets_at === null) continue;
    if (resetsAt === null || candidate.verdict.resets_at < resetsAt) {
      resetsAt = candidate.verdict.resets_at;
    }
  }
  // As in the pool terminal's fold: one member with no known reopening dates nothing.
  return { outcome: "exhausted", resets_at: reopeningUnknown ? null : resetsAt, reserveOnly };
}
