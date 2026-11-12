/**
 * Harness-error remediation (GH #31), the transient-taxonomy sibling of the
 * QA-050 budget classifier (budgetFailure.ts). A terminal harness error used to
 * emit "Check harness authentication" unconditionally — doomed guidance when the
 * cause was a timeout, a rate limit, or a process crash. This module maps the
 * classified failure category onto the right required-actions: authentication
 * guidance appears ONLY on `auth_failed`, exactly as budget guidance appears
 * only on a real budget refusal.
 */
import type { HarnessFailureCategory, VendorFailureEvidence } from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import type { TransientFailureObservation } from "./transientClassify.js";

/**
 * The category that best explains a terminal harness failure across a run's
 * attempt telemetries. `auth_failed` and `capability_refused` are deterministic
 * refusals that dominate (retrying never clears them, so they are the true
 * cause even when a later transient also fired); otherwise the most recent
 * classified failure wins. Null when no transient failure was classified.
 */
export function dominantHarnessFailureCategory(
  transientFailures: TransientFailureObservation[],
): HarnessFailureCategory | null {
  if (transientFailures.length === 0) return null;
  const refusal = transientFailures.find(
    (f) => f.category === "auth_failed" || f.category === "capability_refused",
  );
  if (refusal) return refusal.category;
  return transientFailures.at(-1)?.category ?? null;
}

/**
 * Required-actions for a terminal harness failure, keyed off the classified
 * category. Authentication guidance appears ONLY on `auth_failed`; every other
 * category gets remediation that fits its actual cause. A null category (no
 * classified transient) keeps the neutral diagnostics/retry guidance.
 */
export function harnessFailureNextActions(category: HarnessFailureCategory | null): string[] {
  switch (category) {
    case "auth_failed":
      return [
        "Re-authenticate this harness (run `claudexor doctor`, then the vendor login it names)",
        "Open diagnostics",
        "Retry the run once the login is restored",
      ];
    case "capability_refused":
      return [
        "The route refused the requested capability (model/org/permission); choose a permitted model or route",
        "Open diagnostics",
        "Retry with a supported capability",
      ];
    case "config_error":
      return [
        "The harness could not start or accepted an invalid request; check its install and the run's settings",
        "Open diagnostics",
        "Retry after fixing the configuration",
      ];
    case "rate_limited":
      return [
        "The route was rate-limited; route another account/profile, or retry once the limit has cleared (resetsAt names the time when the vendor gave one)",
        "Open diagnostics",
        "Retry the run",
      ];
    case "timeout":
      return [
        "The harness went silent past the inactivity window; raise runtime.harness_inactivity_timeout_ms if the workload is legitimately quiet",
        "Open diagnostics",
        "Retry the run",
      ];
    case "process_crash":
      return ["The harness process crashed; open diagnostics for the exit detail", "Retry the run"];
    case "unknown_harness_error":
    case null:
      return ["Open diagnostics", "Retry the run"];
  }
}

/**
 * The vendor's own typed failure for the attempt a terminal failure record
 * speaks for: the named attempt, else the last one, and only its LAST try —
 * an earlier try's evidence (before a profile rotation) must never sit beside
 * a later try's message (#414: with or without OS exit evidence). null =
 * honestly unknown. Opaque evidence only — nothing here or downstream branches
 * on its `code`.
 */
export function attemptVendorFailure(
  attempts: { attemptId: string; telemetry: { vendorFailure: VendorFailureEvidence | null } }[],
  attemptId: string | null | undefined,
): VendorFailureEvidence | null {
  const owner = attempts.find((a) => a.attemptId === attemptId) ?? attempts.at(-1);
  return owner?.telemetry.vendorFailure ?? null;
}

/** The most of the vendor's own words a cause line quotes (`vendorFailure` keeps them all). */
const QUOTED_VENDOR_WORDS = 240;

/**
 * An attempt's error with the vendor's own failure for that same try beside it
 * (#633, #635): its source and code, and its words when the error does not
 * already carry them (such as a synthetic `settled in systemError` line).
 * Masked, one line, bounded. Display only: nothing branches on the code.
 */
export function withVendorCause(
  error: string,
  vendor: VendorFailureEvidence | null | undefined,
): string {
  if (!vendor) return error;
  const flat = (text: string) => redactSecrets(text).replace(/\s+/g, " ").trim();
  const words = vendor.message ? flat(vendor.message) : "";
  const cut =
    words.length > QUOTED_VENDOR_WORDS ? `${words.slice(0, QUOTED_VENDOR_WORDS - 1)}…` : words;
  const parts = [
    vendor.code && redactSecrets(vendor.code),
    words && !flat(error).includes(words) && `"${cut}"`,
  ].filter(Boolean);
  return parts.length ? `${error} (vendor ${vendor.source}: ${parts.join(", ")})` : error;
}

/** Each attempt's cause line, with its OWN last try's vendor failure, never another's. */
export function attemptCauseLines(
  attempts: readonly { attemptId: string; harnessId: string; error?: string | null }[],
  telemetries: readonly {
    attemptId: string;
    telemetry: { vendorFailure: VendorFailureEvidence | null };
  }[],
): string[] {
  return attempts.map((attempt) => {
    const own = telemetries.find((t) => t.attemptId === attempt.attemptId);
    const cause = withVendorCause(attempt.error ?? "failed", own?.telemetry.vendorFailure);
    return `${attempt.attemptId}/${attempt.harnessId}: ${cause}`;
  });
}

/** The record's own vendor evidence as an inspection step: attributed, the same for every code. */
export function vendorFailureAction(vendor: VendorFailureEvidence): string {
  const code = vendor.code ? `: ${redactSecrets(vendor.code)}` : "";
  return `Read the vendor's own failure record (${vendor.source}${code}) before retrying`;
}
