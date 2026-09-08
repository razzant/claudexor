import type { RouteAuthEvidence } from "@claudexor/budget";
import type { AuthPreference, AuthSourceReadiness, AuthVerification } from "@claudexor/schema";

/**
 * Auth-mode classification for route ranking and billing evidence (#121
 * part 1). Two small total maps keep the ladder in `orderPool` /
 * `routeBillingKnowledge` honest: a lane's classification comes from the
 * FROZEN quota-admission credential route when one exists, else from the
 * RESOLVED auth preference (per-run > per-harness config > global config via
 * `authPreferenceForHarness`) — never from the raw run input, which reads
 * `auto` for every config-level preference user.
 */

/** The routing auth mode a frozen quota-admission credential route proves. */
export function authModeForCredentialRoute(
  route: "managed_api_key" | "vendor_native" | null,
): "api_key" | "local_session" | null {
  if (route === "managed_api_key") return "api_key";
  if (route === "vendor_native") return "local_session";
  return null;
}

/** The routing auth mode a RESOLVED preference claims; `auto` claims none
 * (the caller falls back to settled-metric/manifest evidence). */
export function authModeForPreference(
  preference: AuthPreference,
): "api_key" | "local_session" | null {
  if (preference === "api_key") return "api_key";
  if (preference === "subscription") return "local_session";
  return null;
}

/** Typed auth evidence for the concrete route selected before budget ranking. */
export function authRouteEvidenceFor(
  authMode: "local_session" | "api_key" | "unknown",
  sources: AuthSourceReadiness[],
  profileVerification: AuthVerification | null,
): RouteAuthEvidence | undefined {
  const usable = (source: AuthSourceReadiness): boolean =>
    source.availability === "available" && source.verification !== "failed";
  if (authMode === "local_session") {
    if (profileVerification !== null) {
      return { route: "vendor_native", verification: profileVerification };
    }
    const native = sources.find(
      (source) =>
        usable(source) &&
        (source.source === "native_session" || source.source === "oauth_token_env"),
    );
    return { route: "vendor_native", verification: native?.verification ?? "not_run" };
  }
  if (authMode === "api_key") {
    const key = sources.find(
      (source) =>
        usable(source) &&
        (source.source === "api_key_env" ||
          source.source === "api_key_flag" ||
          source.source === "provider_auth_file"),
    );
    return { route: "managed_api_key", verification: key?.verification ?? "not_run" };
  }
  return undefined;
}
