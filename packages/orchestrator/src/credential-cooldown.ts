import type { QuotaRequestKind } from "@claudexor/schema";
import type { CredentialUnusableObservation, QuotaSnapshot } from "@claudexor/schema";
import {
  ControlProblem,
  REOPENING_UNKNOWN_COOLDOWN_ID,
  quotaSnapshotAvailability,
} from "@claudexor/schema";

/**
 * Typed verdict that a credential subject's own observed quota evidence blocks
 * spending right now (A4 cooldown reader). `kind` distinguishes a spent window
 * with a known future reset (`exhausted`) from a live rate-limit cooldown
 * (`cooldown`); `resets_at` is the earliest known release instant, and the
 * id and kind describe the window that owns that instant.
 */
export interface QuotaBlock {
  blocked: true;
  constraint_id: string | null;
  /** Null while a usage refusal with no reopening time is active (#558): no
   * time is known for the account, whatever its cooldown or other windows say. */
  resets_at: string | null;
  /** Set only for that refusal: no reader may present it as a window a timer heals. */
  reopening?: "unknown";
  /** That refusal's bounded engine cooldown end: a recheck instant, never a reset. */
  recheck_at?: string;
  kind: "exhausted" | "cooldown";
}

/**
 * Does any observed quota window BLOCK this subject right now?
 *
 * Deliberately NOT a third copy of blocking semantics: each subject snapshot is
 * judged by the schema's own `quotaSnapshotAvailability` projection — the same
 * verdict the /v2/quota surface and the Accounts card show — so preflight can
 * never dispatch into a window the projection already calls unavailable.
 *
 * Two deliberate contrasts with `profileHeadroomBreach` (which stays fresh-only
 * for its configured usage threshold):
 * - STALE evidence blocks too. A cooldown/reset instant is absolute clock
 *   truth: the registry keeps a stale snapshot alive exactly because its
 *   `cooldown_until` still extends into the future (activeSnapshots), and a
 *   reactive vendor limit observed six minutes ago is still a live limit even
 *   though its snapshot has aged past the 5-minute fresh horizon.
 * - Blocking is EVIDENCE-of-limit, not usage-ratio proximity: an expired or
 *   unknown-reset window never blocks (the projection treats it as stale data).
 *
 * Model scope fails OPEN by construction: the projection matches by
 * case-insensitive alias containment, so a vendor display label
 * ("Gemini 3.7 Flash High") that cannot be proven to cover the routed slug
 * ("grok-4.6" — or even an unprovable "gemini-3.7-flash") leaves the subject
 * spendable rather than cooling every model on the account. A scoped window
 * with NO model context blocks only when it declares it governs the
 * unspecified-model route.
 *
 * The subject KEY includes `credential_route` (final-review fix): the
 * native-session default and the managed-api-key default of one harness BOTH
 * carry subject_id=null, so without the route an api_key cooldown would cool
 * the subscription session (and vice versa). `subjectRoute` speaks the
 * callers' vocabulary (`limitSubjectRoute`); `null` = honestly unknown route —
 * fail open to the legacy any-route match rather than unblocking on a
 * technicality (no current caller passes null).
 */
export function profileQuotaBlock(
  snapshots: readonly QuotaSnapshot[],
  harnessId: string,
  profileId: string | null,
  subjectRoute: "local_session" | "api_key" | null,
  model?: string | null,
  now?: Date,
  requestKind?: QuotaRequestKind,
): QuotaBlock | null {
  const wantRoute =
    subjectRoute === "local_session"
      ? "vendor_native"
      : subjectRoute === "api_key"
        ? "managed_api_key"
        : null;
  let dated: QuotaBlock | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.subject.harness !== harnessId) continue;
    if ((snapshot.subject.subject_id ?? null) !== profileId) continue;
    if (wantRoute !== null && snapshot.subject.credential_route !== wantRoute) continue;
    const opts = { now, model: model ?? null, requestKind };
    const availability = quotaSnapshotAvailability(snapshot, opts);
    if (availability.state === "available") continue;
    // #558: an active, applicable usage refusal with no reopening time decides
    // the account's verdict whatever else blocks it. Another window's date
    // keeps its meaning for that window only and promises nothing about the
    // account; the refusal's own cooldown end is a recheck, never a reset.
    const refusal = snapshot.constraints.find(
      (constraint) =>
        constraint.id === REOPENING_UNKNOWN_COOLDOWN_ID &&
        availability.blocking_constraints.includes(constraint.id),
    );
    if (refusal) {
      const recheck = quotaSnapshotAvailability({ constraints: [refusal] }, opts).resets_at;
      return {
        blocked: true,
        constraint_id: refusal.id,
        resets_at: null,
        reopening: "unknown",
        ...(recheck ? { recheck_at: recheck } : {}),
        kind: "cooldown",
      };
    }
    if (dated) continue;
    // One snapshot may block on several windows. Report the window whose own
    // release is the projection's earliest recheck instant, with that window's
    // kind, so id, kind and reset never come from different windows.
    const controlling = snapshot.constraints
      .filter((constraint) => availability.blocking_constraints.includes(constraint.id))
      .map((constraint) => ({
        id: constraint.id,
        own: quotaSnapshotAvailability({ constraints: [constraint] }, opts),
      }))
      .find(({ own }) => own.resets_at === availability.resets_at);
    dated = {
      blocked: true,
      constraint_id: controlling?.id ?? availability.blocking_constraints[0] ?? null,
      resets_at: availability.resets_at,
      kind:
        controlling && controlling.own.state !== "available"
          ? controlling.own.state
          : availability.state,
    };
  }
  return dated;
}

/**
 * One row of `route.profile.rotation_exhausted` candidate evidence, as the
 * pool-exhausted terminal consumes it. Structural on purpose: the rotation
 * module's rows satisfy it without this module importing that module (the
 * import runs the other way).
 */
export interface PoolExhaustionCandidate {
  profile_id: string;
  rejected: string;
  headroom: { resets_at: string | null } | null;
  cooldown: { resets_at: string | null; reopening?: "unknown" } | null;
  /** A7: a live `credential_unusable` verdict about this row's credential —
   * dead-credential evidence for the terminal's claim, and an exclusion from
   * the reset fold (a dead credential's windows promise no reopen). */
  unusable?: { code: string } | null;
}

/** Rejection labels that keep a row a POOL MEMBER for the reset fold. The
 * other labels (`not_ready`, `not_in_rotation_policy`,
 * `credential_kind_mismatch`) mark identities rotation could never select, so
 * their quota evidence must not shape the pool's reopen promise. */
const POOL_MEMBER_REJECTIONS = new Set([
  "current",
  "already_tried",
  "headroom_exceeded",
  "cooldown",
  "not_selected",
]);

/**
 * Whether one exhaustion row is CREDENTIAL-LAYER EVIDENCE for the pool
 * terminal's claim (final-review fix): the fold's member labels plus
 * `credential_unusable` — a dead credential IS a pool member whose typed
 * verdict is evidence, even though the reset fold excludes its windows (they
 * promise no reopen). Rows naming identities rotation could never select
 * (`not_ready`, `not_in_rotation_policy`, `credential_kind_mismatch`) never
 * count: an api_key sibling's stale cooldown must not let a subscription
 * subject's structural death terminalize as "the credential pool refused".
 */
export function poolMemberEvidence(candidate: PoolExhaustionCandidate): boolean {
  if (
    !POOL_MEMBER_REJECTIONS.has(candidate.rejected) &&
    candidate.rejected !== "credential_unusable"
  )
    return false;
  return (
    candidate.headroom !== null ||
    candidate.cooldown !== null ||
    (candidate.unusable ?? null) !== null
  );
}

/**
 * The WHOLE pool refused, MACHINE-READABLY (A5).
 *
 * Mirrors `subscriptionWindowExhausted`'s reasoning: nothing malfunctioned —
 * no credential in this harness's rotation pool can serve the run right now,
 * which is exactly what `harness_unavailable` means. The message stays human;
 * the machine reads `code` and `resetsAt`, which the run terminal lifts onto
 * `final/failure.yaml` verbatim.
 *
 * `resetsAt` folds the EARLIEST known reset WITHIN the pool — the first
 * instant any member reopens — including the current/default subject's own
 * observed limit (`subjectLimit`, consulted only when no candidate row already
 * carries the subject's evidence, and EXCLUDED entirely when the subject's
 * credential itself was observed unusable: a dead credential's quota reset
 * will never help, so it must not shape the pool's reopen promise). This is deliberately the opposite of the
 * ACROSS-CANDIDATES rule (`unanimousDeclaredFailure` keeps the LATEST reset:
 * every slot must reopen); here ONE reopened member is enough to retry. Same
 * honesty rule as there: a limit-evidenced member with an UNKNOWN reset makes
 * the pool's reset unknown — a partial answer is worse than none — while
 * members rejected without limit evidence (e.g. structurally dead) never
 * poison the fold.
 */
export function credentialPoolExhausted(args: {
  harnessId: string;
  model?: string | null;
  requestKind?: QuotaRequestKind;
  /** The triggering subject: a pinned profile id, or null for the default. */
  profileId: string | null;
  reason:
    "profile_headroom_preflight" | "vendor_limit_rejected" | "structural_pre_progress_failure";
  candidates: readonly PoolExhaustionCandidate[];
  /** The triggering subject's own observed limit evidence, when the candidate
   * rows cannot carry it (the default subject has no row; a just-observed
   * typed limit may not be ingested into the registry yet). */
  subjectLimit: { resets_at: string | null } | null;
  /** The differential probe's verdict on the triggering subject (A7), when it
   * found the credential itself dead — the terminal then says so instead of
   * promising a quota reset that will never help. */
  subjectUnusable?: Pick<CredentialUnusableObservation, "code"> | null;
}): Error {
  // A dead credential's quota windows promise no reopen: a row with a live
  // `credential_unusable` verdict never joins the fold, whatever its label.
  const members = args.candidates.filter(
    (c) =>
      POOL_MEMBER_REJECTIONS.has(c.rejected) &&
      !c.unusable &&
      (c.headroom !== null || c.cooldown !== null),
  );
  // A member refused with no known reopening (#558) promises no instant, whatever
  // else it reports: one such member leaves the pool's reset unknown.
  const limits = members.map((c) =>
    c.cooldown?.reopening === "unknown"
      ? null
      : (c.headroom?.resets_at ?? c.cooldown?.resets_at ?? null),
  );
  // Same rule for the triggering subject: its own observed limit joins the
  // fold only while its credential is not observed dead — the terminal must
  // not promise the DEAD subject's reset as the instant the pool reopens.
  if (
    args.subjectLimit &&
    !args.subjectUnusable &&
    !members.some((c) => c.profile_id === args.profileId)
  ) {
    limits.push(args.subjectLimit.resets_at);
  }
  const resetsAt =
    limits.length > 0 && limits.every((at): at is string => at !== null)
      ? limits.reduce((earliest, at) => (Date.parse(at) < Date.parse(earliest) ? at : earliest))
      : null;
  const subject = args.profileId ? `profile "${args.profileId}"` : "the default credentials";
  // Compact typed causes, not a claim inferred from "pool exhausted" prose.
  // Disabled/model-incompatible rows cannot become usable by quota or login.
  const poolCauses = [
    ...new Set(
      args.candidates
        .filter(
          (candidate) =>
            ![
              "disabled",
              "model_incompatible",
              "not_in_rotation_policy",
              "credential_kind_mismatch",
            ].includes(candidate.rejected),
        )
        .map((candidate) =>
          candidate.unusable?.code === "auth_revoked"
            ? "auth"
            : !candidate.unusable &&
                POOL_MEMBER_REJECTIONS.has(candidate.rejected) &&
                (candidate.headroom || candidate.cooldown) &&
                // A refusal of unknown nature (#558) is not known to be quota.
                candidate.cooldown?.reopening !== "unknown"
              ? "quota"
              : "unavailable",
        ),
    ),
  ];
  if (args.subjectUnusable?.code === "auth_revoked" && !poolCauses.includes("auth"))
    poolCauses.push("auth");
  const cause =
    poolCauses.length === 1 && poolCauses[0] === "auth"
      ? "the available credentials were rejected"
      : poolCauses.length === 1 && poolCauses[0] === "quota"
        ? "the available accounts have an active quota limit"
        : "the available accounts cannot serve this request";
  const error = new Error(
    `credential pool exhausted for "${args.harnessId}": ${cause}; ${subject} has no eligible replacement` +
      (args.subjectUnusable
        ? `; the subject's credential itself was observed unusable (${args.subjectUnusable.code})`
        : "") +
      (resetsAt ? `; earliest pool reset ${resetsAt}` : ""),
  );
  return Object.assign(error, {
    code: "credential_pool_exhausted",
    // Not `internal`: nothing malfunctioned. No account in the pool can
    // serve this run until a window reopens (harness_unavailable).
    category: "harness_unavailable",
    resetsAt,
    problem: ControlProblem.parse({
      code: "credential_pool_exhausted",
      message: error.message,
      retryable: false,
      context: {
        poolCauses,
        resetsAt,
        model: args.model ?? null,
        requestKind: args.requestKind ?? "text",
        subject: { harness: args.harnessId, profile_id: args.profileId },
      },
    }),
  });
}
