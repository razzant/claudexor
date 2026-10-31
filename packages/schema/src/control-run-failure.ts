import { z } from "zod/v3";
import { CaptureChangeInventory } from "./capture-inventory.js";
import { HarnessRequestRefusal } from "./harness-input.js";
import { RawContextShortfall } from "./raw.js";
import { HarnessFailureCategory } from "./telemetry.js";

/**
 * The typed run-failure contract, split out of `control.ts` for the reason the
 * complexity ratchet exists (INV-124): `control.ts` is the file every new
 * control-surface field lands in, and this family — the failure sub-code plus
 * the `RunFailure` record that carries it — is a self-contained unit with its
 * own consumers (budget classifier, quota refusal, CLI/MCP projections).
 * Re-exported through `index.ts` like the other `control-*` splits, so every
 * caller keeps importing it from `@claudexor/schema`.
 */
export const RunFailureCode = z
  .enum([
    "finite_zero",
    "hard_cap",
    "estimate_headroom",
    "unknown_paid_in_flight",
    "budget_overshoot",
    "cost_unverifiable",
    "delegation_child_drain_timeout",
    "subscription_window_exhausted",
    /* The WHOLE credential pool of a harness is blocked (every rotation
     * candidate spent/cooling/ineligible, the current subject included), so a
     * limit-triggered or structural failover has nowhere to go. resetsAt folds
     * the EARLIEST known release inside the pool — the first instant any
     * member reopens — or null when any member's reset is unknown. */
    "credential_pool_exhausted",
    "input_too_large",
    /* A raw-api packet refused before its request was sent (#147): a project
     * mandatory file is missing/unreadable/sensitive or absent from the bound
     * base tree, or the mandatory content cannot fit the model's KNOWN window. */
    "raw_context_mandatory_unavailable",
    "raw_context_exceeds_window",
    /* An explicit model whose authoritative live catalog read found no usable
     * credential or had it rejected (HTTP 401/403): refused with that typed
     * cause, never reported as absent. Other failed reads forward the model
     * unverified on the same key (#393, owner decision A). */
    "model_catalog_unavailable",
    "vendor_cli_too_old",
    /* The vendor's own startup frame reported a credential source other than
     * the session login a subscription route requires (Grok `apiKeySource`). */
    "credential_source_unconfirmed",
    /* Active scoped-HOME/evidence refusals plus the historical confinement
     * decoder code. Attempt-loop failures must be listed here or
     * `declaredFailure` drops them to `code: null` and the terminal states less
     * than the thrower knew. See docs/DELEGATED_CONFINEMENT.md. */
    "delegated_home_unavailable",
    "delegated_confinement_unavailable",
    "delegated_evidence_incomplete",
    "access_profile_incompatible",
    "auxiliary_writable_roots_unsupported",
    "retired_access_profile",
  ])
  .describe(
    "Machine-readable failure sub-code within a RunFailure category, including historical delegated-run failures and active access-profile refusals.",
  );
export type RunFailureCode = z.infer<typeof RunFailureCode>;

/** A vendor's OWN typed failure, forwarded as evidence. `code` is opaque: no
 * Claudexor code path may branch on its value; retry, rotation, cooldown and
 * credential verdicts never read it. `source` is an open vocabulary rather than
 * an enum because every surface projects the whole `RunFailure` parse-or-null:
 * a closed member list would make an older client drop the entire failure
 * record the day a second producer appears. */
export const VendorFailureEvidence = z
  .object({
    code: z
      .string()
      .min(1)
      .max(128)
      .nullable()
      .describe(
        "The vendor's own machine-readable failure code, verbatim; null when the vendor recorded an error without one.",
      ),
    message: z
      .string()
      .max(4000)
      .nullable()
      .describe(
        "The vendor's own words from the same record, verbatim (redacted); null when absent.",
      ),
    source: z
      .string()
      .min(1)
      .max(64)
      .describe(
        "Evidence channel the code was read from (codex: `codex_rollout`). An open vocabulary: consumers display it, never branch on it.",
      ),
  })
  .describe(
    "Vendor-typed failure evidence read from a vendor-owned machine-readable record, never parsed from prose.",
  );
export type VendorFailureEvidence = z.infer<typeof VendorFailureEvidence>;

/** Capture evidence is separate from native harness failure and never inferred from prose. */
export const WorkspaceCaptureFailure = z.object({
  code: z.enum([
    "capture_output_exceeded",
    "capture_output_incomplete",
    "capture_preview_truncated",
    "capture_space_insufficient",
    "capture_git_stalled",
    "capture_git_signal",
    "capture_read_failed",
    "capture_object_missing",
    "capture_failed",
  ]),
  message: z.string(),
  causeCode: z.string().optional(),
  bufferBudgetBytes: z.number().int().nonnegative().optional(),
  stream: z.enum(["stdout", "stderr"]).optional(),
  drain: z.literal("truncated").optional(),
  requiredBytes: z.number().int().nonnegative().optional(),
  availableBytes: z.number().int().nonnegative().optional(),
  signal: z.string().max(32).optional(),
  stallMs: z.number().int().nonnegative().optional(),
  cleanup: z.object({ code: z.string().nullable(), message: z.string() }).optional(),
  inventory: CaptureChangeInventory.optional(),
});
export type WorkspaceCaptureFailure = z.infer<typeof WorkspaceCaptureFailure>;

/** One actual execution try that ended in an error, attributed to the account it
 * ran on. Diagnostic evidence only: retry, rotation and routing never read it,
 * and a selected successor that never started has no row. */
export const PoolAttemptFailure = z
  .object({
    harnessId: z.string().min(1).describe("Harness the try ran on."),
    profileId: z
      .string()
      .nullable()
      .describe("Account row the try ran on; null = the harness default route."),
    profileDisplayName: z
      .string()
      .nullable()
      .describe("The row's display name at try time (redacted); null for the default route."),
    requestedModel: z
      .string()
      .nullable()
      .describe("Model the try asked for; null = the harness default model."),
    attemptId: z.string().min(1).describe("Attempt the try belongs to."),
    tryIndex: z.number().int().nonnegative().describe("Zero-based try index within the attempt."),
    observedAt: z
      .string()
      .datetime({ offset: true })
      .describe("When the try's first error was observed."),
    phase: z
      .enum(["pre_start", "pre_progress", "after_progress"])
      .describe(
        "How far the try got: before a typed session start, after start but before agent progress, or after progress.",
      ),
    category: HarnessFailureCategory.describe(
      "Typed failure category of the try; untyped errors are unknown_harness_error.",
    ),
    error: z
      .string()
      .describe("The try's own error text with its original wording and whitespace, redacted."),
    vendorFailure: VendorFailureEvidence.nullable().describe(
      "The vendor's own typed failure for this try, when the adapter attached one.",
    ),
  })
  .describe("Per-try account attribution of a failed execution try (diagnostic evidence only).");
export type PoolAttemptFailure = z.infer<typeof PoolAttemptFailure>;

/** Why quota admission refused an account: the owner's saved headroom reserve
 * (the provider may still serve it) or the provider's own observed limit. */
export const QuotaRefusalBasis = z.enum(["owner_reserve", "provider_window", "provider_cooldown"]);
export type QuotaRefusalBasis = z.infer<typeof QuotaRefusalBasis>;

export const QuotaRefusal = z
  .object({
    basis: QuotaRefusalBasis.describe(
      "owner_reserve: usage reached the saved headroom_threshold below 100% while the provider reports quota left; provider_window: the provider reports the window spent; provider_cooldown: a provider rate-limit cooldown is in force.",
    ),
    constraintId: z.string().nullable().describe("The refusing quota window, when known."),
    usedRatio: z.number().min(0).max(1).nullable().describe("Its observed usage, when known."),
    threshold: z
      .number()
      .nullable()
      .describe("The headroom_threshold the decision applied, when it applied one."),
  })
  .describe(
    "Machine-readable basis of a quota-admission refusal; it is not an authentication or billing verdict.",
  );
export type QuotaRefusal = z.infer<typeof QuotaRefusal>;

/** The typed category axis of a run failure, shared by the failure record and
 * the route-health groups that count failures by it. Described at each use. */
export const RunFailureCategory = z.enum([
  "validation",
  "project",
  "auth",
  "harness_unavailable",
  "harness_error",
  "config_error",
  "budget",
  "policy",
  "cancelled",
  "internal",
  "unknown",
]);
export type RunFailureCategory = z.infer<typeof RunFailureCategory>;

export const RunFailure = z
  .object({
    requestRefusal: HarnessRequestRefusal.optional(),
    rawContextShortfall: RawContextShortfall.optional().describe(
      "Typed sizes behind code raw_context_exceeds_window: the window, the request's parts and every mandatory file, so surfaces never read them from safeMessage.",
    ),
    captureFailure: WorkspaceCaptureFailure.optional(),
    phase: z.string().default("unknown").describe("Pipeline phase where the failure happened."),
    category: RunFailureCategory.default("unknown").describe(
      "Typed failure category (validation, project, auth, harness, config, budget, policy, cancelled, internal, unknown). config_error is a settings/routing misconfiguration (e.g. quality routing with no comparable tier), corrected by changing configuration, not by re-auth or waiting for a harness.",
    ),
    code: RunFailureCode.nullable()
      .default(null)
      .describe(
        "Machine-readable failure sub-code within the category; null when the category alone is sufficient. Surfaces choose remediation from this, never by parsing safeMessage.",
      ),
    harnessId: z
      .string()
      .nullable()
      .default(null)
      .describe("Harness involved in the failure, when known."),
    attemptId: z
      .string()
      .nullable()
      .default(null)
      .describe("Attempt involved in the failure, when known."),
    safeMessage: z.string().describe("Redacted human-readable failure message."),
    rawDetailRef: z
      .string()
      .nullable()
      .default(null)
      .describe("Artifact path holding the raw (redacted) failure detail."),
    logRefs: z
      .array(z.string())
      .default([])
      .describe("Log artifact paths relevant to the failure."),
    eventRefs: z
      .array(z.string())
      .default([])
      .describe("Event references relevant to the failure."),
    runDir: z.string().nullable().default(null).describe("Run artifact directory."),
    /** STRUCTURAL reset time. A refusal that only says "resets 2026-08-02T…"
     * inside safeMessage forces every caller to parse prose to decide when to
     * come back — the thing typed contracts exist to prevent. */
    resetsAt: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .default(null)
      .describe(
        "When the refused window reopens (a spent subscription quota window), or null when the failure has no such time. Callers schedule a retry off this field, never off safeMessage.",
      ),
    quotaRefusal: QuotaRefusal.optional().describe(
      "Present when quota admission refused the account (code subscription_window_exhausted): separates the owner's saved reserve from provider exhaustion. Absent on other failures and on records written before this field existed.",
    ),
    vendorFailure: VendorFailureEvidence.nullable()
      .default(null)
      .describe(
        "The vendor's own typed failure for the attempt this record speaks for, or null when no vendor-typed evidence exists (every harness without such a channel, and any unreadable record). Facts only: carries no remedy.",
      ),
    poolAttempts: z
      .array(PoolAttemptFailure)
      .default([])
      .describe(
        "Every failed execution try in order, each with its own account and error text; empty when no try failed (and for records written before this field existed).",
      ),
    nextActions: z.array(z.string()).default([]).describe("Suggested operator next actions."),
  })
  .describe(
    "Typed failure record for a run: phase, category, evidence references, and suggested next actions.",
  );
export type RunFailure = z.infer<typeof RunFailure>;
