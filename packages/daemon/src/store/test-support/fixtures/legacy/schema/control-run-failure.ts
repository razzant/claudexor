import { z } from "zod/v3";
import { HarnessRequestRefusal } from "./harness-input.js";

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
    "vendor_cli_too_old",
    /* Active scoped-HOME/evidence refusals plus the historical confinement
     * decoder code. Attempt-loop failures must be listed here or
     * `declaredFailure` drops them to `code: null` and the terminal states less
     * than the thrower knew. See docs/DELEGATED_CONFINEMENT.md. */
    "delegated_home_unavailable",
    "delegated_confinement_unavailable",
    "delegated_evidence_incomplete",
    "access_profile_incompatible",
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

export const RunFailure = z
  .object({
    requestRefusal: HarnessRequestRefusal.optional(),
    phase: z.string().default("unknown").describe("Pipeline phase where the failure happened."),
    category: z
      .enum([
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
      ])
      .default("unknown")
      .describe(
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
    vendorFailure: VendorFailureEvidence.nullable()
      .default(null)
      .describe(
        "The vendor's own typed failure for the attempt this record speaks for, or null when no vendor-typed evidence exists (every harness without such a channel, and any unreadable record). Facts only: carries no remedy.",
      ),
    nextActions: z.array(z.string()).default([]).describe("Suggested operator next actions."),
  })
  .describe(
    "Typed failure record for a run: phase, category, evidence references, and suggested next actions.",
  );
export type RunFailure = z.infer<typeof RunFailure>;
