import type {
  AuthPreference,
  CredentialProfile,
  CredentialProfileStatus,
  CredentialUnusableObservation,
  QuotaSnapshot,
} from "@claudexor/schema";
import { accountPoolRows, selectFromAccountPool } from "./account-pool.js";
import {
  credentialProfilePolicyProblem,
  HarnessUnavailableError,
  type CredentialProfilePolicyState,
} from "@claudexor/core";
import {
  credentialPoolExhausted,
  liveUnusableFor,
  profileQuotaBlock,
  type PoolExhaustionCandidate,
  type QuotaBlock,
} from "./credential-cooldown.js";
import { readyProfilesForRotation } from "./credential-differential.js";
import { preflightDefaultSubject } from "./credential-preflight.js";
import {
  effectiveLimitAction,
  limitSubjectRoute,
  profileHeadroomBreach,
  type HeadroomBreach,
  type ProfilePolicy,
} from "./credential-profile-rotation.js";
import {
  selectedProfileAvailability,
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
  probe: ((profile: CredentialProfile) => Promise<CredentialProfileStatus>) | undefined;
  /** The explicit pin, already resolved/validated by the caller (null = unpinned). */
  pinnedProfile: CredentialProfile | null;
  /** The thread's durable per-harness binding for unpinned turns (D-U1 order 2). */
  boundProfileId: string | null;
  threadId: string | null;
  model: string | null;
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

/**
 * A spent subscription window on an EXPLICITLY PINNED account, refused
 * MACHINE-READABLY (D-U6: a pin is strict — never a silent rotation). Homed
 * beside its A4 sibling `pinnedWindowBlocked` in the pinned-lane owner.
 *
 * The verdict a caller actually needs from this refusal is "not now, come back
 * at T" — and the only honest way to deliver T is as a field. Gluing it into
 * the sentence and shipping the terminal as `category: internal, code: null`
 * left every consumer (a surface, a scheduler, an automating host) to regex
 * the prose for a timestamp, which no contract in this repo permits. The
 * message stays human-readable; the machine reads `code` and `resetsAt`, which
 * the run terminal lifts onto `final/failure.yaml` verbatim.
 */
export function subscriptionWindowExhausted(
  profileId: string,
  harnessId: string,
  breach: HeadroomBreach,
): Error {
  return Object.assign(
    new Error(
      `credential profile "${profileId}" (${harnessId}) is over its headroom threshold ` +
        `(${breach.constraint_id} at ${Math.round(breach.used_ratio * 100)}% >= ${Math.round(breach.threshold * 100)}%; ` +
        `a pinned account never rotates${breach.resets_at ? `; resets ${breach.resets_at}` : ""})`,
    ),
    {
      code: "subscription_window_exhausted",
      // Not `internal`: nothing malfunctioned. The account cannot serve this
      // run until its window reopens, which is what harness_unavailable means.
      category: "harness_unavailable",
      resetsAt: breach.resets_at,
    },
  );
}

/** The strict pin's refusal for an OBSERVED live block (A4): same typed code
 * and category as the headroom form — a consumer asks "when can I come back",
 * not which detector fired — with the block's own evidence in the prose. */
function pinnedWindowBlocked(profileId: string, harnessId: string, block: QuotaBlock): Error {
  return Object.assign(
    new Error(
      `credential profile "${profileId}" (${harnessId}) is ${
        block.kind === "exhausted"
          ? "over an observed vendor window"
          : "in a vendor rate-limit cooldown"
      } (${block.constraint_id ?? "cooldown"}; a pinned account never rotates${
        block.resets_at ? `; resets ${block.resets_at}` : ""
      })`,
    ),
    {
      code: "subscription_window_exhausted",
      category: "harness_unavailable",
      resetsAt: block.resets_at,
    },
  );
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
      );
      const block = breach
        ? null
        : profileQuotaBlock(snapshots, harnessId, row.profile_id, limitSubjectRoute(row), model);
      const dead = liveUnusableFor(ctx.unusable, harnessId, row.profile_id, model);
      // Label precedence mirrors PR-A's rotationExhaustionCandidates: a
      // not-ready row is not a POOL MEMBER, so its windows never join the
      // earliest-reset fold (an unready row's reset promises no reopen).
      const rejected = !row.enabled
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
    const dead = liveUnusableFor(ctx.unusable, harnessId, pinned.profile_id, model);
    if (dead) throw pinnedCredentialUnusable(pinned.profile_id, harnessId, dead);
    const breach = profileHeadroomBreach(
      snapshots,
      harnessId,
      pinned.profile_id,
      policy.headroom_threshold,
      model,
    );
    const block = breach
      ? null
      : profileQuotaBlock(
          snapshots,
          harnessId,
          pinned.profile_id,
          limitSubjectRoute(pinned),
          model,
        );
    if (!breach && !block) return pinned;
    emit("route.profile.headroom_exceeded", {
      harness_id: harnessId,
      profile_id: pinned.profile_id,
      action: "refuse",
      constraint_id: breach?.constraint_id ?? block?.constraint_id ?? null,
      used_ratio: breach?.used_ratio ?? null,
      threshold: policy.headroom_threshold,
      resets_at: breach?.resets_at ?? block?.resets_at ?? null,
    });
    throw breach
      ? subscriptionWindowExhausted(pinned.profile_id, harnessId, breach)
      : pinnedWindowBlocked(pinned.profile_id, harnessId, block as QuotaBlock);
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
    );
    const readyProfileIds =
      effectiveLimitAction(policy, ctx.defaultRoute) === "rotate" &&
      ctx.defaultRoute === "local_session" &&
      (breach !== null ||
        profileQuotaBlock(snapshots, harnessId, null, ctx.defaultRoute, model) !== null)
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
    const dead = bound ? liveUnusableFor(ctx.unusable, harnessId, boundId, model) : null;
    if (bound && dead) {
      boundSwitchReason = `the bound account's credential is unusable (${dead.code})`;
    } else if (bound) {
      const verdict = await selectedProfileAvailability({
        registry,
        profileId: boundId,
        harnessId,
        probe: ctx.probe,
        quota,
        // A durable binding is already selected, like an explicit pin. Pool
        // rotation below remains fresh-only.
        allowStale: true,
      });
      const breach = profileHeadroomBreach(
        snapshots,
        harnessId,
        boundId,
        policy.headroom_threshold,
        model,
      );
      // A4: an observed live block on the bound row (reactive cooldown /
      // spent window) unbinds it exactly like a fresh breach would.
      const block = breach
        ? null
        : profileQuotaBlock(snapshots, harnessId, boundId, limitSubjectRoute(bound), model);
      if (verdict === "available" && !breach && !block) return bound;
      boundSwitchReason =
        breach || block
          ? `quota window exhausted${
              (breach?.resets_at ?? block?.resets_at)
                ? ` (resets ${breach?.resets_at ?? block?.resets_at})`
                : ""
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
    headroomThreshold: policy.headroom_threshold,
    model,
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
    // The triggering subject of a preflight pool refusal is the thread's
    // bound row when one exists (its exhaustion is what forced the pool
    // decision); a fresh unbound run has no subject of its own.
    profileId: boundId,
    reason: "profile_headroom_preflight",
    candidates: poolExhaustionCandidates(ctx, readyProfileIds),
    subjectLimit: null,
  });
}
