/**
 * Harness-error remediation (GH #31), the transient-taxonomy sibling of the
 * QA-050 budget classifier (budgetFailure.ts). A terminal harness error used to
 * emit "Check harness authentication" unconditionally — doomed guidance when the
 * cause was a timeout, a rate limit, or a process crash. This module maps the
 * classified failure category onto the right required-actions: authentication
 * guidance appears ONLY on `auth_failed`, exactly as budget guidance appears
 * only on a real budget refusal.
 */
import type { HarnessFailureCategory } from "@claudexor/schema";
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
        "The route was rate-limited; wait for the window to reset or route another account/profile",
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
