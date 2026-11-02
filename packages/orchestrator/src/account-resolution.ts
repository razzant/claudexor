import type { QuotaRequestKind } from "@claudexor/schema";
import {
  pinnedWindowBlocked,
  quotaRefusalBasis,
  quotaRefusalResetsAt,
  quotaRefusalWithScope,
  subscriptionWindowExhausted,
} from "./quota-refusal-scope.js";
import type {
  AuthPreference,
  CredentialProfile,
  CredentialProfileStatus,
  CredentialUnusableObservation,
  ModelSubstitutionObservation,
  PreProgressRefusalObservation,
  QuotaSnapshot,
} from "@claudexor/schema";
import { accountPoolRows, selectFromAccountPool, type LastServiceReader } from "./account-pool.js";
import {
  credentialProfilePolicyProblem,
  HarnessUnavailableError,
  type CredentialProfilePolicyState,
} from "@claudexor/core";
import {
  credentialPoolExhausted,
  profileQuotaBlock,
  type PoolExhaustionCandidate,
} from "./credential-cooldown.js";
import { readyProfilesForRotation } from "./credential-differential.js";
import { applicableCredentialUnusable } from "./account-evidence.js";
import { preflightDefaultSubject } from "./credential-preflight.js";
import {
  effectiveLimitAction,
  limitSubjectRoute,
  profileHeadroomBreach,
  type ProfilePolicy,
} from "./credential-profile-rotation.js";
import {
  selectedProfileAvailability,
  vendorCredentialObservation,
  type VendorQuotaObservations,
} from "./credential-profiles.js";

/**
 * The ONE account-resolution owner for a run's harness (INV-135 unified
 * account model, owner decisions D-U1/D-U6/Q1/Q3), extracted from the
 * orchestrator god-file (INV-124):
 *
 * 1. An explicit pin is STRICT — a fresh exhausted window OR an observed live
 *    quota block (A4: reactive cooldown / spent window, stale-but-live
 *    included) is a typed `subscription_window_exhausted` refusal, never a
 *    silent rotation.
 * 2. Below the pin, an EXPLICIT `api_key` preference is the user's paid
 *    election: it takes the disclosed API-key ROUTE before binding/pool
 *    resolution — a healthy subscription pool must never spend subscription
 *    quota over that explicit choice (ARCHITECTURE: explicit `api_key`
 *    excludes native fallback).
 * 3. An unpinned thread turn stays on its durable bound account while that
 *    row is ready, else switches to the pool with a DISCLOSED lane switch. A
 *    live typed `credential_unusable` observation (A7) condemns the bound row
 *    at this composition point too.
 * 4. Unbound runs take the best row of the quota-aware pool.
 * 5. An empty/exhausted pool is the typed `credential_pool_exhausted`
 *    TERMINAL carrying the pool's earliest known reset (owner Q3=A: PR-A's
 *    semantics supersede Q2 — waiting for the reset is the default). The paid
 *    API-key ROUTE serves it ONLY under the EXPLICIT `api_key` preference
 *    (disclosed; never a row) — never silently under `auto`. Harnesses with
 *    no registered rows keep the legacy default-subject ladder (unmigrated
 *    stores).
 */

export type AccountResolutionEmit = (
  type:
    | "route.profile.headroom_exceeded"
    | "route.profile.rotated"
    | "route.profile.rotation_exhausted"
    | "route.profile.credential_unusable"
    | "route.account.pool_selected"
    | "route.account.lane_switch"
    | "route.account.pool_exhausted",
  payload: Record<string, unknown>,
) => void;

export interface AccountResolutionContext {
  harnessId: string;
  registry: readonly CredentialProfile[];
  policy: ProfilePolicy;
  /** Static platform cardinality, resolved without vendor discovery/probes. */
  profileCardinality?: CredentialProfilePolicyState;
  snapshots: readonly QuotaSnapshot[];
  quota: VendorQuotaObservations;
  /** Live typed `credential_unusable` observations (A7): a condemned row is
   * refused at the readiness composition point, never re-discovered by
   * spending an attempt. */
  unusable: readonly CredentialUnusableObservation[];
  /** Live model-substitution observations, passed by model operations only.
   * They order the unbound pool choice below; a pin and a usable bound
   * account are resolved before them and never consult them. */
  substitutions?: readonly ModelSubstitutionObservation[];
  /** Live pre-progress refusal observations (#363): they order the unbound
   * pool choice exactly like substitutions and never reach a pin or a usable
   * bound account. */
  refusals?: readonly PreProgressRefusalObservation[];
  /** Durable last-served facts: only the final tie-break among unknown-headroom rows. */
  lastService?: LastServiceReader | null;
  probe: ((profile: CredentialProfile) => Promise<CredentialProfileStatus>) | undefined;
  /** The explicit pin, already resolved/validated by the caller (null = unpinned). */
  pinnedProfile: CredentialProfile | null;
  /** The thread's durable per-harness binding for unpinned turns (D-U1 order 2). */
  boundProfileId: string | null;
  threadId: string | null;
  model: string | null;
  requestKind?: QuotaRequestKind;
  /** Model incompatibility exclusions for this unpinned selection epoch. */
  excludedProfileIds?: ReadonlySet<string>;
  /** Default-route estimate of the legacy unprofiled ladder (no-rows harnesses). */
  defaultRoute: "local_session" | "api_key" | null;
  /** Whether the legacy native login is excluded (`native_credentials_enabled: false`). */
  nativeCredentialsDisabled: boolean;
  /** Effective auth preference (run > harness > routing config). */
  authPreference: AuthPreference;
  /** Record that this harness's unpinned route fell to the PAID api_key route. */
  notePoolApiKeyRoute: () => void;
  emit: AccountResolutionEmit;
}

/** A live credential ledger verdict outranks bounded stale auth evidence even
 * on a strict pin. Keep the refusal typed as harness unavailability without
 * inventing a quota/reset code for a credential that is actually revoked. */
function pinnedCredentialUnusable(
  profileId: string,
  harnessId: string,
  observation: CredentialUnusableObservation,
): Error {
  return new HarnessUnavailableError(
    `credential profile "${profileId}" (${harnessId}) credential is unusable ` +
      `(${observation.code}; a pinned account never rotates)`,
  );
}

/**
 * Per-candidate rejection evidence of one exhausted POOL decision, in the
 * shape the typed `credential_pool_exhausted` terminal consumes: every
 * subscription-kind row of the harness with its own quota evidence (fresh
 * breach / observed live block / live dead-credential verdict), so the
 * terminal's earliest-reset fold and its message never disagree with the
 * ranking that refused the pool.
 */
function poolExhaustionCandidates(ctx: AccountResolutionContext, ready: ReadonlySet<string>) {
  const { harnessId, registry, policy, snapshots, model } = ctx;
  return registry
    .filter((row) => row.harness_id === harnessId && row.credential_kind !== "api_key")
    .map((row): PoolExhaustionCandidate => {
      const breach = profileHeadroomBreach(
        snapshots,
        harnessId,
        row.profile_id,
        policy.headroom_threshold,
        model,
        ctx.requestKind,
      );
      // A breach speaks for a dated block, but never hides the row's own refusal
      // with no reopening time (#558) from the terminal's fold.
      const observed = profileQuotaBlock(
        snapshots,
        harnessId,
        row.profile_id,
        limitSubjectRoute(row),
        model,
        undefined,
        ctx.requestKind,
      );
      const block = breach && !observed?.reopening ? null : observed;
      const vendor = vendorCredentialObservation(ctx.quota, harnessId, row.profile_id);
      const dead =
        applicableCredentialUnusable(
          { harness_id: harnessId, profile_id: row.profile_id },
          {
            unusable: ctx.unusable,
            quota: ctx.quota,
            model,
            route: row.credential_kind === "api_key" ? "managed_api_key" : "vendor_native",
          },
        ) ?? (vendor?.outcome === "revoked" ? { code: "auth_revoked" } : null);
      // Label precedence mirrors PR-A's rotationExhaustionCandidates: a
      // not-ready row is not a POOL MEMBER, so its windows never join the
      // earliest-reset fold (an unready row's reset promises no reopen).
      const rejected = ctx.excludedProfileIds?.has(row.profile_id)
        ? "model_incompatible"
        : !row.enabled
          ? "disabled"
          : dead
            ? "credential_unusable"
            : !ready.has(row.profile_id)
              ? "not_ready"
              : breach
                ? "headroom_exceeded"
                : block
                  ? "cooldown"
                  : "not_selected";
      return {
        profile_id: row.profile_id,
        rejected,
        headroom: breach,
        cooldown: block,
        unusable: dead ? { code: dead.code } : null,
      };
    });
}

/** Per-run record of harnesses whose unpinned route took the PAID API-key
 * route under the EXPLICIT `api_key` preference (Q3=A) — the user's paid
 * election over a healthy pool, or the only permitted service of an
 * empty/exhausted one: the spec then carries auth_preference=api_key so the
 * adapter can never spawn back into an exhausted or excluded native login.
 * Keyed by the run-input object. */
export class PoolRouteFlags {
  private readonly flags = new WeakMap<object, Set<string>>();
  note(runKey: object, harnessId: string): void {
    const set = this.flags.get(runKey) ?? new Set<string>();
    set.add(harnessId);
    this.flags.set(runKey, set);
  }
  has(runKey: object, harnessId: string): boolean {
    return this.flags.get(runKey)?.has(harnessId) ?? false;
  }
}

export async function resolveAccountForRun(
  ctx: AccountResolutionContext,
): Promise<CredentialProfile | null> {
  const { harnessId, registry, policy, snapshots, quota, model, emit } = ctx;
  // D13: persisted over-limit rows are not candidates to rank or probe. Fail
  // before the explicit pin, durable binding, paid preference, or pool can
  // choose one identity and make an OS-user-scoped credential look isolated.
  if (ctx.profileCardinality?.ambiguous) {
    throw credentialProfilePolicyProblem(ctx.profileCardinality, "credential_profile_ambiguous");
  }
  // A7-aware readiness (ONE composition point, `readyProfilesForRotation`):
  // probe wrapper + vendor overlay + admission predicate + the live
  // `credential_unusable` refusal.
  const readyIds = () =>
    readyProfilesForRotation({
      registry,
      harnessId,
      policy,
      current: null,
      probe: ctx.probe,
      quota,
      unusable: ctx.unusable,
      excluded: ctx.excludedProfileIds,
      model,
    });
  if (ctx.pinnedProfile) {
    // D-U6: strict pin. A fresh exhausted window refuses with its reset time;
    // unknown/stale quota never refuses (D3 freshness) — but an OBSERVED live
    // block (A4: reactive cooldown / spent window, stale-but-live included)
    // refuses too, since a cooldown instant is absolute clock truth.
    const pinned = ctx.pinnedProfile;
    // A7: a prior typed auth/credential failure is stronger than the adapter's
    // bounded stale LKG. Check the ledger before quota or stale admission so a
    // revoked pinned token can never reach the vendor CLI.
    const dead = applicableCredentialUnusable(
      { harness_id: harnessId, profile_id: pinned.profile_id },
      {
        unusable: ctx.unusable,
        quota,
        model,
        route: pinned.credential_kind === "api_key" ? "managed_api_key" : "vendor_native",
      },
    );
    if (dead) throw pinnedCredentialUnusable(pinned.profile_id, harnessId, dead);
    const breach = profileHeadroomBreach(
      snapshots,
      harnessId,
      pinned.profile_id,
      policy.headroom_threshold,
      model,
      ctx.requestKind,
    );
    // A provider block outranks the owner's reserve whatever the threshold
    // (#318): a spent window is never relabelled as a discretionary reserve.
    const block = profileQuotaBlock(
      snapshots,
      harnessId,
      pinned.profile_id,
      limitSubjectRoute(pinned),
      model,
      undefined,
      ctx.requestKind,
    );
    if (!breach && !block) return pinned;
    const refusal = block
      ? pinnedWindowBlocked(pinned.profile_id, harnessId, block, breach)
      : subscriptionWindowExhausted(pinned.profile_id, harnessId, breach!);
    // Window, usage, reset and basis all describe the refusal's controlling evidence.
    const basis = refusal.quotaRefusal;
    emit("route.profile.headroom_exceeded", {
      harness_id: harnessId,
      profile_id: pinned.profile_id,
      action: "refuse",
      constraint_id: basis?.constraintId ?? null,
      used_ratio: basis?.usedRatio ?? null,
      threshold: policy.headroom_threshold,
      resets_at: quotaRefusalResetsAt(breach, block),
      basis: basis?.basis ?? null,
    });
    throw quotaRefusalWithScope(refusal, {
      harness: harnessId,
      profileId: pinned.profile_id,
      model,
      requestKind: ctx.requestKind,
      constraintId: basis?.constraintId,
    });
  }
  const pool = accountPoolRows(registry, harnessId);
  // The legacy ladder serves ONLY harnesses with no REGISTERED subscription
  // rows (unmigrated stores). A harness whose rows are all DISABLED must fall
  // through to the pool path below and refuse typed (or take the disclosed
  // paid route) — the ladder would silently spawn back into the same
  // account's default store the owner just toggled off.
  const hasRegisteredRows = registry.some(
    (p) => p.harness_id === harnessId && p.credential_kind !== "api_key",
  );
  if (pool.length === 0 && !hasRegisteredRows) {
    if (ctx.nativeCredentialsDisabled) {
      // No rows AND the native login is excluded: nothing subscription-shaped
      // can serve — never a silent spawn back INTO the disabled login. The
      // paid route serves ONLY the EXPLICIT `api_key` preference (Q3=A);
      // `auto`/`subscription` refuse typed (the admission gate already
      // dropped non-api_key requests for auto pools).
      if (ctx.authPreference !== "api_key") {
        emit("route.account.pool_exhausted", {
          harness_id: harnessId,
          reason: "the CLI login is disabled and no account is registered",
          resets_at: null,
          fallback: null,
        });
        throw Object.assign(
          new Error(
            `no routable ${harnessId} account: the CLI login is disabled ` +
              `(harnesses.${harnessId}.native_credentials_enabled=false), no account is ` +
              `registered, and the paid API-key route requires the explicit api_key ` +
              `preference — connect an account or pin one (--profile)`,
          ),
          {
            code: "credential_pool_exhausted",
            category: "harness_unavailable",
            resetsAt: null,
          },
        );
      }
      ctx.notePoolApiKeyRoute();
      emit("route.account.pool_exhausted", {
        harness_id: harnessId,
        reason: "the CLI login is disabled and no account is registered",
        resets_at: null,
        fallback: "api_key_route",
      });
      return null;
    }
    // Legacy default-subject ladder (unmigrated stores): under an EFFECTIVE
    // `rotate` (explicit, or the A6 kind-aware `auto` on a subscription
    // route), a fresh default-subject headroom breach — or its observed live
    // block (A4) — starts on the next eligible subscription profile instead;
    // effective `fail`/`ask` change nothing.
    const breach = profileHeadroomBreach(
      snapshots,
      harnessId,
      null,
      policy.headroom_threshold,
      model,
      ctx.requestKind,
    );
    const readyProfileIds =
      effectiveLimitAction(policy, ctx.defaultRoute) === "rotate" &&
      ctx.defaultRoute === "local_session" &&
      (breach !== null ||
        profileQuotaBlock(
          snapshots,
          harnessId,
          null,
          ctx.defaultRoute,
          model,
          undefined,
          ctx.requestKind,
        ) !== null)
        ? await readyIds()
        : new Set<string>();
    return preflightDefaultSubject({
      harnessId,
      policy,
      registry,
      snapshots,
      readyProfileIds,
      defaultRoute: ctx.defaultRoute,
      unusable: ctx.unusable,
      model,
      emit,
    });
  }
  // The EXPLICIT `api_key` preference is the user's paid election (Q3=A): it
  // takes the disclosed PAID route BEFORE binding/pool resolution — a healthy
  // subscription pool must never spend subscription quota over that explicit
  // choice (ARCHITECTURE: explicit `api_key` excludes native fallback). Only
  // an explicit pin outranks it (strict pin doctrine, handled above). Mirrors
  // the exhausted-pool paid branch below: noted, disclosed, never a row.
  if (ctx.authPreference === "api_key") {
    ctx.notePoolApiKeyRoute();
    emit("route.account.pool_exhausted", {
      harness_id: harnessId,
      reason: "explicit api_key preference excludes the subscription pool",
      resets_at: null,
      fallback: "api_key_route",
    });
    return null;
  }
  const boundId = ctx.boundProfileId;
  let boundSwitchReason: string | null = null;
  if (boundId) {
    // D-U1 order 2: the thread's bound account resolves BEFORE the pool —
    // stickiness is not a pool ranking preference, so an explicit
    // rotation_eligible list cannot evict a healthy binding.
    const bound = pool.find((row) => row.profile_id === boundId);
    // A7: a live typed `credential_unusable` observation condemns the BOUND
    // row at this composition point too (this file's contract: condemned rows
    // are refused at readiness composition, never re-discovered by spending
    // an attempt) — the binding re-pools with the disclosed lane switch.
    const dead = bound
      ? applicableCredentialUnusable(
          { harness_id: harnessId, profile_id: boundId },
          {
            unusable: ctx.unusable,
            quota,
            model,
            route: "vendor_native",
          },
        )
      : null;
    if (ctx.excludedProfileIds?.has(boundId)) {
      boundSwitchReason = "the bound account does not support the requested model";
    } else if (bound && dead) {
      boundSwitchReason = `the bound account's credential is unusable (${dead.code})`;
    } else if (bound) {
      const verdict = await selectedProfileAvailability({
        registry,
        profileId: boundId,
        harnessId,
        probe: ctx.probe,
        quota,
        // A durable binding is already selected, like an explicit pin, yet it
        // is unpinned: it may also consume a last positive after a timeout.
        // Pool rotation below admits only that stale basis (INV-135 #363).
        allowStale: true,
        unpinned: true,
      });
      const breach = profileHeadroomBreach(
        snapshots,
        harnessId,
        boundId,
        policy.headroom_threshold,
        model,
        ctx.requestKind,
      );
      // A4: an observed live block on the bound row (reactive cooldown /
      // spent window) unbinds it exactly like a fresh breach would.
      const block = profileQuotaBlock(
        snapshots,
        harnessId,
        boundId,
        limitSubjectRoute(bound),
        model,
        undefined,
        ctx.requestKind,
      );
      if (verdict === "available" && !breach && !block) return bound;
      const reserveOnly = quotaRefusalBasis(breach, block)?.basis === "owner_reserve";
      const resetsAt = quotaRefusalResetsAt(breach, block);
      boundSwitchReason = block?.reopening
        ? "the vendor refused further usage, with no reopening time named"
        : breach || block
          ? `${reserveOnly ? "saved quota reserve reached" : "quota window exhausted"}${
              resetsAt ? ` (resets ${resetsAt})` : ""
            }`
          : (verdict ?? "not ready");
    } else {
      boundSwitchReason = "the bound account was disabled or removed";
    }
  }
  const readyProfileIds = await readyIds();
  const selection = selectFromAccountPool({
    registry,
    harnessId,
    snapshots,
    readyProfileIds,
    excludedProfileIds: ctx.excludedProfileIds,
    headroomThreshold: policy.headroom_threshold,
    requestKind: ctx.requestKind,
    model,
    substitutions: ctx.substitutions,
    refusals: ctx.refusals,
    lastService: ctx.lastService,
  });
  if (selection.outcome === "selected") {
    const chosen = selection.candidate.profile;
    if (boundId && boundId !== chosen.profile_id) {
      // Q1=A: a lane switch is DISCLOSED, never silent (the continuity layer
      // additionally discloses the hydration on the turn).
      emit("route.account.lane_switch", {
        harness_id: harnessId,
        thread_id: ctx.threadId,
        from_profile_id: boundId,
        to_profile_id: chosen.profile_id,
        reason: boundSwitchReason,
      });
    }
    emit("route.account.pool_selected", {
      harness_id: harnessId,
      profile_id: chosen.profile_id,
      quota: selection.candidate.verdict.kind,
      ...(selection.candidate.verdict.kind === "fresh_headroom"
        ? { headroom: selection.candidate.verdict.headroom }
        : {}),
    });
    return chosen;
  }
  // Pool empty/exhausted (owner Q3=A, superseding Q2=A): the PRIMARY verdict
  // is the typed `credential_pool_exhausted` TERMINAL carrying the pool's
  // earliest known reset — an unpinned run under `auto` (and under explicit
  // `subscription`) WAITS for a window instead of silently taking the paid
  // route (the same principle as PR-A's kind-aware `limit_action: auto`,
  // which resolves a metered subject to `fail`: `auto` never silently spends
  // money). The EXPLICIT `api_key` preference never reaches this point — its
  // paid election already returned before binding/pool resolution above.
  emit("route.account.pool_exhausted", {
    harness_id: harnessId,
    reason: selection.outcome,
    resets_at: selection.resets_at,
    fallback: null,
    ...(boundId ? { from_profile_id: boundId } : {}),
  });
  throw credentialPoolExhausted({
    harnessId,
    model,
    requestKind: ctx.requestKind,
    // The triggering subject of a preflight pool refusal is the thread's
    // bound row when one exists (its exhaustion is what forced the pool
    // decision); a fresh unbound run has no subject of its own.
    profileId: boundId,
    reason: "profile_headroom_preflight",
    candidates: poolExhaustionCandidates(ctx, readyProfileIds),
    subjectLimit: null,
  });
}
