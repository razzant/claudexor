import {
  ControlProblem,
  REOPENING_UNKNOWN_REFUSAL_CODE,
  type HarnessEvent,
  type QuotaRefusal,
  type QuotaRequestKind,
} from "@claudexor/schema";
import type { QuotaBlock } from "./credential-cooldown.js";
import type { HeadroomBreach } from "./credential-profile-rotation.js";

/**
 * Why quota admission refused an account. A provider block (spent window with
 * a future reset, or a live cooldown) outranks the owner's reserve whatever the
 * threshold or check order; a breach at 100% is provider-reported spending; a
 * breach below 100% is the owner's saved reserve while the provider still
 * reports quota left. Authentication and billing are never quota bases.
 */
export function quotaRefusalBasis(
  breach: HeadroomBreach | null,
  block: QuotaBlock | null,
): QuotaRefusal | null {
  if (block) {
    const same = breach !== null && breach.constraint_id === block.constraint_id;
    return {
      basis: block.kind === "cooldown" ? "provider_cooldown" : "provider_window",
      constraintId: block.constraint_id,
      usedRatio: same ? breach.used_ratio : null,
      threshold: breach?.threshold ?? null,
    };
  }
  if (!breach) return null;
  return {
    basis: breach.used_ratio >= 1 ? "provider_window" : "owner_reserve",
    constraintId: breach.constraint_id,
    usedRatio: breach.used_ratio,
    threshold: breach.threshold,
  };
}

/** When the refusal's controlling evidence says to recheck: the block's own
 * release when a provider block decides, else the breaching window's reset.
 * An earliest recheck instant, not a promise the whole account is ready then. */
export function quotaRefusalResetsAt(
  breach: HeadroomBreach | null,
  block: QuotaBlock | null,
): string | null {
  return block ? block.resets_at : (breach?.resets_at ?? null);
}

/**
 * A pinned account the vendor refused with no reopening time (#558). Nothing
 * malfunctioned and the account cannot serve, but no timer is known to heal it
 * (the same vendor code covers a workspace out of credits), so it never wears
 * `subscription_window_exhausted`, which every reader takes for "waiting cures
 * it". `declaredFailure` leaves the run record's code null; the category, the
 * null reset, the basis and the vendor's own evidence state the facts.
 */
function pinnedUsageRefusal(message: string, quotaRefusal: QuotaRefusal | null): QuotaRefusalError {
  return Object.assign(new Error(message), {
    code: REOPENING_UNKNOWN_REFUSAL_CODE,
    category: "harness_unavailable",
    resetsAt: null,
    quotaRefusal,
  });
}

/** A typed provider limit observed on a pinned subject's own try (Agent, Ask or
 * Plan): a pin never rotates, so the try's own limit is the typed terminal,
 * with the window the vendor named when it named one. */
export function pinnedTypedLimit(
  profileId: string,
  harnessId: string,
  limit: {
    resetsAt: string | null;
    constraintId?: string | null;
    reopening?: "unknown" | null;
  } | null,
  afterProgress = false,
): QuotaRefusalError {
  if (limit?.reopening === "unknown")
    return pinnedUsageRefusal(
      `credential profile "${profileId}" (${harnessId}) was refused further usage by the vendor` +
        `${afterProgress ? " after progress" : ""}, with no reopening time named; a pinned account never rotates`,
      {
        basis: "provider_cooldown",
        constraintId: limit.constraintId ?? null,
        usedRatio: null,
        threshold: null,
      },
    );
  const resetsAt = limit?.resetsAt ?? null;
  return Object.assign(
    new Error(
      `credential profile "${profileId}" (${harnessId}) hit a typed vendor limit` +
        `${afterProgress ? " after progress" : ""} and a pinned account never rotates` +
        `${resetsAt ? `; resets ${resetsAt}` : ""}`,
    ),
    {
      code: "subscription_window_exhausted",
      category: "harness_unavailable",
      resetsAt,
      quotaRefusal: {
        basis: "provider_cooldown" as const,
        constraintId: limit?.constraintId ?? null,
        usedRatio: null,
        threshold: null,
      },
    },
  );
}

/** A later event that retires a pending typed limit as the explanation of a
 * try's end: the adapter's typed native API failure (`api_error_status`) with a
 * status other than 429 is the vendor's own non-quota terminal (authentication,
 * billing, invalid request, server error). A 429, an untyped error, limit prose
 * and a crash keep the limit; a limit observed afterwards re-arms it. */
export function endsPendingLimit(ev: HarnessEvent): boolean {
  if (ev.type !== "error" || ev.rate_limit) return false;
  const status = ev.payload?.["api_error_status"];
  return Number.isInteger(status) && status !== 429;
}

const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;

/** A quota refusal carrying its typed basis (null only when none applies). */
export type QuotaRefusalError = Error & { quotaRefusal: QuotaRefusal | null };

/** A pin never rotates. Typed code, reset and basis reach final/failure.yaml;
 * consumers do not recover scope, reset times or the basis from this message. */
export function subscriptionWindowExhausted(
  profileId: string,
  harnessId: string,
  breach: HeadroomBreach,
): QuotaRefusalError {
  const refusal = quotaRefusalBasis(breach, null)!;
  const evidence =
    refusal.basis === "owner_reserve"
      ? `has reached its saved quota reserve (${breach.constraint_id} at ${percent(breach.used_ratio)} used, headroom_threshold ${percent(breach.threshold)}); the provider still reports quota left`
      : `is over a provider-reported spent window (${breach.constraint_id} at ${percent(breach.used_ratio)})`;
  return Object.assign(
    new Error(
      `credential profile "${profileId}" (${harnessId}) ${evidence}; a pinned account never rotates` +
        `${breach.resets_at ? `; resets ${breach.resets_at}` : ""}`,
    ),
    {
      code: "subscription_window_exhausted",
      // Not `internal`: nothing malfunctioned. The account cannot serve this
      // run until its window reopens, which is what harness_unavailable means.
      category: "harness_unavailable",
      resetsAt: breach.resets_at,
      quotaRefusal: refusal,
    },
  );
}

/** The strict pin's refusal for an OBSERVED live block (A4): same typed code
 * and category as the headroom form — a consumer asks "when can I come back" —
 * with the provider basis machine-readable and the block's evidence in prose. */
export function pinnedWindowBlocked(
  profileId: string,
  harnessId: string,
  block: QuotaBlock,
  breach: HeadroomBreach | null = null,
): QuotaRefusalError {
  if (block.reopening === "unknown")
    return pinnedUsageRefusal(
      `credential profile "${profileId}" (${harnessId}) was refused further usage by the vendor, ` +
        `with no reopening time named (${block.constraint_id ?? "cooldown"}; a pinned account never rotates` +
        `${block.recheck_at ? `; not retried before ${block.recheck_at}` : ""})`,
      quotaRefusalBasis(breach, block),
    );
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
      quotaRefusal: quotaRefusalBasis(breach, block),
    },
  );
}

/** Attach already-known request scope at the refusal producer. The context is
 * not recovered from its human message or generalized to the whole harness. */
export function quotaRefusalWithScope(
  error: Error,
  scope: {
    harness: string;
    profileId: string | null;
    model?: string | null;
    requestKind?: QuotaRequestKind;
    constraintId?: string | null;
  },
): Error {
  const typed = error as Error & {
    code?: string;
    resetsAt?: string | null;
    problem?: ControlProblem;
    quotaRefusal?: QuotaRefusal | null;
  };
  typed.problem = ControlProblem.parse({
    code: typed.code ?? "subscription_window_exhausted",
    message: error.message,
    retryable: false,
    context: {
      ...typed.problem?.context,
      resetsAt: typed.resetsAt ?? null,
      subject: { harness: scope.harness, profile_id: scope.profileId },
      model: scope.model ?? null,
      requestKind: scope.requestKind ?? "text",
      ...(scope.constraintId ? { constraint_id: scope.constraintId } : {}),
      ...(typed.quotaRefusal ? { refusal_basis: typed.quotaRefusal.basis } : {}),
    },
  });
  return typed;
}
