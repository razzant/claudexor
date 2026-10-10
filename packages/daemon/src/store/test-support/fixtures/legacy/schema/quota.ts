import { z } from "zod/v3";
export { ControlQuotaRefreshRequest } from "./account-target.js";
import { Id } from "./primitives.js";

export const QuotaSource = z
  .enum([
    "codex_app_server",
    "codex_rollout",
    "claude_statusline",
    "claude_api_retry",
    "claude_oauth_usage",
    "agy_command_usage",
    "cursor_rate_limit",
    "claude_rate_limit_event",
    "codex_app_server_event",
  ])
  .describe("Machine-readable source of quota evidence, classified by schema-owned traits.");
export type QuotaSource = z.infer<typeof QuotaSource>;

/** Orthogonal capabilities of every quota evidence source. Keep this
 * exhaustive registry beside the QuotaSource vocabulary so consumers cannot
 * silently invent their own source classifications. */
export interface QuotaSourceTraits {
  /** A full source replaces its inventory; an incremental source reports
   * independently aged singleton windows. */
  readonly snapshotMode: "full" | "window";
  /** The source is a vendor response authenticated with this subject's own
   * credential, and therefore evidence of credential liveness. */
  readonly vendorAuthenticated: boolean;
  /** A missing/stale primary observation from this harness creates daemon
   * refresh demand. Reactive and spool sources deliberately use null. */
  readonly refreshDemandHarness: "claude" | "codex" | "agy" | null;
  /** At least one registered top-level quota refresher can produce this
   * source. This is independent of whether it satisfies refresh demand. */
  readonly producedByRefresher: boolean;
}

export const QUOTA_SOURCE_TRAITS = {
  codex_app_server: {
    snapshotMode: "full",
    vendorAuthenticated: true,
    refreshDemandHarness: "codex",
    producedByRefresher: true,
  },
  codex_rollout: {
    snapshotMode: "full",
    vendorAuthenticated: false,
    refreshDemandHarness: null,
    producedByRefresher: false,
  },
  claude_statusline: {
    snapshotMode: "full",
    vendorAuthenticated: false,
    refreshDemandHarness: null,
    producedByRefresher: true,
  },
  claude_api_retry: {
    snapshotMode: "full",
    vendorAuthenticated: false,
    refreshDemandHarness: null,
    producedByRefresher: false,
  },
  claude_oauth_usage: {
    snapshotMode: "full",
    vendorAuthenticated: true,
    refreshDemandHarness: "claude",
    producedByRefresher: true,
  },
  agy_command_usage: {
    snapshotMode: "full",
    // agy's `/quota` print-mode command is authenticated with the profile's
    // own token, produced by a top-level refresher, and creates refresh demand
    // for agy (its profiles only — agy has no default subject, PLAN Л-4).
    vendorAuthenticated: true,
    refreshDemandHarness: "agy",
    producedByRefresher: true,
  },
  cursor_rate_limit: {
    snapshotMode: "full",
    // Reactive spool evidence classified from cursor-agent's vendor-limit
    // prose (A1/A4): cursor exposes no quota API, so no refresher can produce
    // or refresh this source — like claude_api_retry it exists only while a
    // typed `rate_limit` event's cooldown does.
    vendorAuthenticated: false,
    refreshDemandHarness: null,
    producedByRefresher: false,
  },
  claude_rate_limit_event: {
    snapshotMode: "window",
    // Measured quota telemetry is not a standalone fresh authentication receipt.
    vendorAuthenticated: false,
    refreshDemandHarness: null,
    producedByRefresher: false,
  },
  codex_app_server_event: {
    snapshotMode: "window",
    vendorAuthenticated: false,
    refreshDemandHarness: null,
    producedByRefresher: false,
  },
} as const satisfies Record<QuotaSource, QuotaSourceTraits>;

export function quotaSourceTraits(source: QuotaSource): QuotaSourceTraits {
  return QUOTA_SOURCE_TRAITS[source];
}

/** Harness → source label for reactive `rate_limit` cooldown evidence. This
 * map IS the daemon's cooldown-ingest allowlist and its expiry-predicate
 * scope: agy stays deliberately absent because its adapter emits no
 * `rate_limit` event, and a branch with no producer is a dead knob
 * (INV-022/023) — a harness joins in the same change that makes its adapter
 * emit one (cursor joined with the A1 retry-signals classifier). */
export const REACTIVE_COOLDOWN_SOURCE: Partial<Record<string, QuotaSource>> = {
  codex: "codex_rollout",
  claude: "claude_api_retry",
  cursor: "cursor_rate_limit",
};

/** Durable-journal source label the strict v3.2.0 rollback runtime can parse.
 * `cursor_rate_limit` postdates that enum, so a base upsert record carrying it
 * would crash a rolled-back engine's replay; the base record carries the
 * nearest v3.2.0 vocabulary instead (claude_api_retry has the same
 * reactive-spool trait row), while the paired scoped-prepare record preserves
 * the true source for current runtimes. `agy_command_usage` also postdates
 * v3.2.0 but predates this mapping: remapping it now would orphan its already
 * journaled prepare/commit hashes, so it stays a disclosed rollback residual. */
export function legacyV320QuotaSource(source: QuotaSource): QuotaSource {
  return source === "cursor_rate_limit" ? "claude_api_retry" : source;
}

export function quotaRefreshDemandHarnesses(): Array<"claude" | "codex" | "agy"> {
  return [
    ...new Set(
      Object.values(QUOTA_SOURCE_TRAITS)
        .map((traits) => traits.refreshDemandHarness)
        .filter((harness): harness is "claude" | "codex" | "agy" => harness !== null),
    ),
  ].sort();
}

export function quotaSourcesProducedByRefreshers(): QuotaSource[] {
  return (Object.keys(QUOTA_SOURCE_TRAITS) as QuotaSource[]).filter(
    (source) => QUOTA_SOURCE_TRAITS[source].producedByRefresher,
  );
}

export const QuotaFreshness = z
  .enum(["fresh", "stale", "unknown"])
  .describe("Freshness of a quota snapshot at read time.");
export type QuotaFreshness = z.infer<typeof QuotaFreshness>;

export const QuotaSubject = z
  .object({
    harness: Id,
    credential_route: z.enum(["vendor_native", "managed_api_key", "local"]),
    plan_label: z.string().nullable().default(null),
    /** The CREDENTIAL SUBJECT the windows belong to (release wave round-16
     * #2): a Claudexor credential-profile id, or null for the harness's
     * engine-default credential. Every producer (oauth-usage refresher,
     * typed-event registry, adapter quota events) uses exactly this
     * vocabulary; budget routing filters snapshots by exact subject so one
     * account's exhaustion never cools another. */
    subject_id: z.string().nullable().default(null),
  })
  .strict()
  .describe(
    "Quota owner and credential route; subject_id is the credential-profile id (null = the engine-default credential).",
  );
export type QuotaSubject = z.infer<typeof QuotaSubject>;

export const QuotaConstraint = z
  .object({
    id: Id,
    label: z.string().min(1),
    /** omitted/null = this vendor window applies to every model. A non-null
     * list is the producer's canonical model-id/alias scope, so a
     * model-specific cap never cools a different model on the same subject. */
    applies_to_models: z.array(Id).nullable().optional(),
    /** Vendor-declared model families, matched as literal id prefixes. These
     * augment exact ids without guessing that every unknown model belongs to
     * a known group. An absent/empty list adds no family scope. */
    applies_to_model_prefixes: z.array(Id).optional(),
    /**
     * Whether this MODEL-SCOPED window also governs a run that names no model.
     * Default (absent) is the conservative answer: a scoped window cannot
     * refuse a route whose concrete model is unknowable before spawn. A source
     * sets it when the vendor's unspecified-model route provably consumes THIS
     * window — the case where every window is scoped, so the conservative
     * default would leave an exhausted subscription unrefusable and its
     * profile rotation unreachable.
     */
    applies_to_unspecified_model: z.boolean().optional(),
    used_ratio: z.number().min(0).max(1).nullable(),
    window_seconds: z.number().positive().nullable(),
    resets_at: z.string().datetime({ offset: true }).nullable(),
    cooldown_until: z.string().datetime({ offset: true }).nullable().default(null),
  })
  .strict()
  .describe(
    "One independent vendor quota window; without model ids or declared prefixes it applies to every model, and null usage stays unknown.",
  );
export type QuotaConstraint = z.infer<typeof QuotaConstraint>;

export const QuotaSnapshot = z
  .object({
    subject: QuotaSubject,
    constraints: z.array(QuotaConstraint),
    source: QuotaSource,
    observed_at: z.string().datetime({ offset: true }),
    freshness: QuotaFreshness,
  })
  .strict()
  .describe("All independently reported quota windows for one vendor-owned subject.");
export type QuotaSnapshot = z.infer<typeof QuotaSnapshot>;

/** Stable vendor-window identity, independent of its measured value, reset,
 * label and observation time. Unknown applicability is not representable as
 * a global constraint: producers retain it as diagnostic evidence instead. */
export function quotaConstraintIdentity(constraint: QuotaConstraint): string {
  const fields: unknown[] = [
    constraint.id,
    constraint.window_seconds,
    constraint.applies_to_models == null ? null : [...new Set(constraint.applies_to_models)].sort(),
    constraint.applies_to_unspecified_model === true,
  ];
  // Preserve already-issued identities when no family scope was declared.
  if (constraint.applies_to_model_prefixes?.length) {
    fields.push([...new Set(constraint.applies_to_model_prefixes)].sort());
  }
  return JSON.stringify(fields);
}

/** One schema-owned storage identity for registry, budget and projections.
 * Existing full sources retain their inventory slot. Incremental sources
 * require one independently observed window in each stored snapshot. */
export function quotaSnapshotIdentity(
  snapshot: Pick<QuotaSnapshot, "subject" | "source" | "constraints">,
): string {
  const subject = snapshot.subject;
  const base = [
    subject.harness,
    subject.credential_route,
    subject.subject_id ?? "",
    snapshot.source,
  ].join("\0");
  if (quotaSourceTraits(snapshot.source).snapshotMode === "full") return base;
  if (snapshot.constraints.length !== 1) {
    throw new Error("incremental quota snapshots must contain exactly one window");
  }
  return `${base}\0${quotaConstraintIdentity(snapshot.constraints[0]!)}`;
}

/** New journal type carrying a partial observation. Older readers ignore
 * this type rather than replaying it as a fake complete/cooldown snapshot. */
export const QuotaWindowObservation = z
  .object({ version: z.literal(1), snapshot: QuotaSnapshot })
  .strict()
  .superRefine((value, ctx) => {
    if (
      quotaSourceTraits(value.snapshot.source).snapshotMode !== "window" ||
      value.snapshot.constraints.length !== 1
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "expected one incremental quota window",
      });
    }
  });
export type QuotaWindowObservation = z.infer<typeof QuotaWindowObservation>;

/** A newer full read superseded this exact incremental window. The cutoff
 * survives later full-inventory replacement and rejects delayed older events;
 * raw measurements remain ordinary journal history until compaction. */
export const QuotaWindowSupersession = QuotaSnapshot.pick({ subject: true, observed_at: true })
  .extend({ version: z.literal(1), snapshot_id: z.string().min(1) })
  .strict();
export type QuotaWindowSupersession = z.infer<typeof QuotaWindowSupersession>;

export const QuotaAbsenceReason = z
  .enum([
    "not_logged_in",
    "transport_unavailable",
    "platform_unsupported",
    "refresh_failed",
    "no_source",
    /** The vendor REJECTED the subject's own credential. Distinct
     * from `refresh_failed` (which cannot tell a dead token from a dead
     * network) and from `not_logged_in` (there IS a stored login): the local
     * store looks healthy while the token behind it is no longer honored. */
    "auth_revoked",
    /** The vendor rate-limited the QUOTA POLL itself (429). The credential is
     * not dead and the plan window is not proven spent — this is poll-pacing
     * evidence only and must never be journaled as a quota cooldown (a
     * throttled poll is not an exhausted window). The row carries
     * `retry_after_ms` when the vendor sent a parseable Retry-After. */
    "rate_limited",
    /** This subject or a known token-identical alias is inside a poll floor,
     * so no request was made. Distinct from `rate_limited`, which records
     * the actual refusal. Retained legacy vendor floors may also suppress
     * subjects until their recorded deadline. */
    "probe_skipped_rate_limited",
    /** The subject was not re-probed because its applicable poll rate-limit
     * cooldown is active: the POLL is paused, not the plan window. A derived
     * gap row so suppressed subjects never fall silent — surfaces
     * can say "data is stale, polling paused until T", and exhaustion
     * readers stay fail-open instead of promoting a stale spent window into
     * "window exhausted". */
    "poll_paced",
    /** The current platform policy allows only one enabled binding, but the
     * persisted registry contains several. No row was selected or probed. */
    "credential_profile_ambiguous",
  ])
  .describe(
    "Why a registered subject has no fresh quota snapshot, in the source's own vocabulary.",
  );
export type QuotaAbsenceReason = z.infer<typeof QuotaAbsenceReason>;

/** Refresh-gap reasons may coexist with a STALE snapshot: the last-known
 * data stays visible alongside a failed, skipped, or paced refresh.
 * A FRESH snapshot still silences these reasons. Credential rejection
 * and platform ambiguity retain their separate evidence-retirement rules. */
export const QUOTA_GAP_ABSENCE_REASONS: ReadonlySet<QuotaAbsenceReason> =
  new Set<QuotaAbsenceReason>([
    "refresh_failed",
    "rate_limited",
    "probe_skipped_rate_limited",
    "poll_paced",
  ]);

export const QuotaAbsence = z
  .object({
    subject: QuotaSubject,
    reason: QuotaAbsenceReason,
    detail: z.string().nullable().default(null),
    observed_at: z.string().datetime({ offset: true }),
    /** For `rate_limited` only: the vendor's Retry-After translated to
     * milliseconds from `observed_at`. Present only when the header arrived
     * and parsed (Anthropic does not always send it); absent = no vendor
     * floor is known and pacing falls back to its own exponential backoff. */
    retry_after_ms: z.number().int().nonnegative().optional(),
  })
  .strict()
  .describe(
    "A registered subject's typed quota observation gap; may accompany stale last-known data.",
  );
export type QuotaAbsence = z.infer<typeof QuotaAbsence>;

export const QuotaAvailabilityState = z
  .enum(["available", "exhausted", "cooldown"])
  .describe(
    "Spendability verdict for one snapshot: exhausted = a spent window blocks every applicable request; cooldown = an applicable window is only rate-limit-cooling; available = nothing applicable blocks.",
  );
export type QuotaAvailabilityState = z.infer<typeof QuotaAvailabilityState>;

export const QuotaModelScopedExhaustion = z
  .object({
    constraint_id: Id,
    applies_to_models: z.array(Id),
    applies_to_model_prefixes: z.array(Id).optional(),
    resets_at: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()
  .describe(
    "A spent or cooling window that applies only to the named models or declared model-id prefixes. Without a requested model only a window that DECLARES it governs the unspecified-model route can exhaust the subject; when the request names a model it covers, it blocks that request too (and is then also listed in blocking_constraints). resets_at is its earliest known release instant (null = unknown).",
  );
export type QuotaModelScopedExhaustion = z.infer<typeof QuotaModelScopedExhaustion>;

export const QuotaAvailability = z
  .object({
    state: QuotaAvailabilityState,
    blocking_constraints: z
      .array(Id)
      .describe("Ids of the constraints that produced a non-available state."),
    resets_at: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .describe(
        "Earliest known instant at which any blocking constraint may release; null when nothing blocks or no reset is known.",
      ),
    model_scoped_exhaustions: z
      .array(QuotaModelScopedExhaustion)
      .describe(
        "Every spent/cooling model-scoped window, listed regardless of state so consumers see partial exhaustion without re-deriving constraint scope.",
      ),
  })
  .strict()
  .describe(
    "Derived model-aware availability projection for one quota snapshot. Without a requested model, only windows applying to EVERY model can set exhausted/cooldown — a model-scoped spent window keeps state available and is disclosed in model_scoped_exhaustions.",
  );
export type QuotaAvailability = z.infer<typeof QuotaAvailability>;

export const ControlQuotaSnapshot = QuotaSnapshot.extend({
  snapshot_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Server-derived stable snapshot identity for consumers; absent from raw journal evidence and optional for legacy responses.",
    ),
  availability: QuotaAvailability.optional().describe(
    "Typed server-owned availability projection derived at the /v2/quota and atomic Accounts response boundaries; absent from raw journal/projection storage.",
  ),
}).describe("One vendor-owned quota snapshot plus its derived availability projection.");
export type ControlQuotaSnapshot = z.infer<typeof ControlQuotaSnapshot>;

export const QuotaRefreshSkipped = z
  .object({
    vendor: Id,
    subject: QuotaSubject.optional().describe(
      "The exact paused subject; omitted only for an existing vendor-wide floor.",
    ),
    not_before: z.string().datetime({ offset: true }),
  })
  .strict()
  .describe(
    "One subject a refresh cycle did not re-fetch because its poll rate-limit cooldown is active, or a retained legacy vendor floor when subject is absent; its snapshots/absences in the same response are last-known registry data.",
  );
export type QuotaRefreshSkipped = z.infer<typeof QuotaRefreshSkipped>;

export const ControlQuotaResponse = z
  .object({
    snapshots: z.array(ControlQuotaSnapshot),
    absences: z
      .array(QuotaAbsence)
      .default([])
      .describe(
        "Every registered subject reports a snapshot or a typed absence; a refresh gap may coexist with a stale last-known snapshot.",
      ),
    refreshed_at: z.string().datetime({ offset: true }).nullable(),
    /** Additive disclosure: present only on refresh responses that skipped at
     * least one vendor's fan-out for an active poll rate-limit cooldown
     * (foreground refreshes honor the pacer instead of hammering a vendor
     * that just said 429). Absent on plain reads and unskipped refreshes. */
    refresh_skipped: z.array(QuotaRefreshSkipped).optional(),
  })
  .strict()
  .describe("Current quota snapshots without a fabricated aggregate.");
export type ControlQuotaResponse = z.infer<typeof ControlQuotaResponse>;

/** Millisecond instant of a still-future ISO timestamp, else null. */
function futureMs(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) && at > now ? at : null;
}

/** Literal family matching belongs to the quota contract, shared by display
 * and admission. Prefixes must be declared by the vendor-specific producer;
 * neither a missing model nor an unknown family proves a match. */
export function quotaModelPrefixMatches(
  prefixes: readonly string[] | undefined,
  model: string,
): boolean {
  return prefixes?.some((prefix) => prefix.length > 0 && model.startsWith(prefix)) === true;
}

/** API-parameter model matching, deliberately looser than the router's exact
 * `quotaConstraintAppliesToModel` (@claudexor/budget): consumers pass whatever
 * model string they route with ("claude-fable-5", "fable", a bracketed
 * variant), while producers publish vendor alias lists — so match by
 * case-insensitive alias containment in either direction. A null/empty scope
 * list is a vendor-wide window and matches every model. */
function modelScopeMatches(scope: readonly string[] | null | undefined, model: string): boolean {
  if (scope == null || scope.length === 0) return true;
  const target = model.trim().toLowerCase();
  return scope.some((alias) => {
    const candidate = alias.trim().toLowerCase();
    return (
      candidate !== "" &&
      target !== "" &&
      (candidate.includes(target) || target.includes(candidate))
    );
  });
}

/** Derive one snapshot's typed model-aware availability — a pure projection
 * over the snapshot's own constraints, never an aggregate across subjects.
 * Blocking semantics mirror the router's `BudgetLedger`: a window
 * blocks while its cooldown_until is in the future, or while used_ratio >= 1
 * with a still-future resets_at (a spent ratio whose reset elapsed or is
 * unknown is stale data, not a live block). Without `model`, only windows that
 * apply to EVERY model can block; model-scoped spent windows are disclosed in
 * model_scoped_exhaustions and leave state available — including a spent
 * scoped window whose reset is UNKNOWN (disclosed with resets_at null, never
 * blocking); one whose reset ELAPSED is provably released and not disclosed.
 * With `model`, scoped windows matching it block too.
 * Full-coverage inference ("every model is
 * covered by some spent scoped window") is deliberately not attempted: the
 * model universe is unknowable here, so that case stays available + disclosed. */
export function quotaSnapshotAvailability(
  snapshot: Pick<QuotaSnapshot, "constraints">,
  opts: { now?: Date; model?: string | null } = {},
): QuotaAvailability {
  const now = (opts.now ?? new Date()).getTime();
  const model = opts.model ?? null;
  const blocking: string[] = [];
  const scopedExhaustions: QuotaModelScopedExhaustion[] = [];
  let sawExhausted = false;
  let earliestRelease: { iso: string; at: number } | null = null;
  for (const constraint of snapshot.constraints) {
    const resetAt = futureMs(constraint.resets_at, now);
    const cooldownAt = futureMs(constraint.cooldown_until, now);
    const exhausted =
      constraint.used_ratio !== null && constraint.used_ratio >= 1 && resetAt !== null;
    const cooling = cooldownAt !== null;
    // A spent ratio with an UNKNOWN reset never blocks (BudgetLedger mirror:
    // stale data, not a live block), but a scoped one is still DISCLOSED below
    // with resets_at null; an elapsed reset is provably released and stays
    // undisclosed.
    const spentUnknownReset =
      constraint.used_ratio !== null && constraint.used_ratio >= 1 && constraint.resets_at === null;
    if (!exhausted && !cooling && !spentUnknownReset) continue;
    // A constraint stays blocked until EVERY active condition lifts, so its
    // own release is the LATER of the two; the snapshot-level resets_at below
    // is the EARLIEST such release across blocking constraints. A
    // disclosure-only window (spent, unknown reset) has no release instant.
    const release =
      !exhausted && !cooling
        ? null
        : exhausted && cooling
          ? (resetAt as number) >= (cooldownAt as number)
            ? { iso: constraint.resets_at as string, at: resetAt as number }
            : { iso: constraint.cooldown_until as string, at: cooldownAt as number }
          : exhausted
            ? { iso: constraint.resets_at as string, at: resetAt as number }
            : { iso: constraint.cooldown_until as string, at: cooldownAt as number };
    const scope = constraint.applies_to_models ?? null;
    const prefixes = constraint.applies_to_model_prefixes;
    const scoped = (scope !== null && scope.length > 0) || (prefixes?.length ?? 0) > 0;
    if (scoped) {
      scopedExhaustions.push({
        constraint_id: constraint.id,
        applies_to_models: [...(scope ?? [])],
        ...(prefixes?.length ? { applies_to_model_prefixes: [...prefixes] } : {}),
        resets_at: release?.iso ?? null,
      });
    }
    if (release === null) continue;
    // The projection and the router must answer the SAME question: a scoped
    // window that declares it governs the unspecified-model route blocks a
    // bare run, or the Accounts card would read "available" for an account the
    // router is already refusing.
    if (
      scoped &&
      (model === null
        ? constraint.applies_to_unspecified_model !== true
        : !(
            quotaModelPrefixMatches(prefixes, model) ||
            (scope !== null && scope.length > 0 && modelScopeMatches(scope, model))
          ))
    )
      continue;
    blocking.push(constraint.id);
    if (exhausted) sawExhausted = true;
    if (earliestRelease === null || release.at < earliestRelease.at) {
      earliestRelease = release;
    }
  }
  return QuotaAvailability.parse({
    state: blocking.length === 0 ? "available" : sawExhausted ? "exhausted" : "cooldown",
    blocking_constraints: blocking,
    resets_at: earliestRelease?.iso ?? null,
    model_scoped_exhaustions: scopedExhaustions,
  });
}

/** Decorate a quota response with per-snapshot availability projections —
 * applied at the /v2/quota and atomic Accounts response boundaries so
 * journals and raw projection signatures stay byte-identical. */
export function withQuotaAvailability(
  response: ControlQuotaResponse,
  opts: { now?: Date; model?: string | null } = {},
): ControlQuotaResponse {
  return {
    ...response,
    snapshots: response.snapshots.map((snapshot) => ({
      ...snapshot,
      snapshot_id: quotaSnapshotIdentity(snapshot),
      availability: quotaSnapshotAvailability(snapshot, opts),
    })),
  };
}
