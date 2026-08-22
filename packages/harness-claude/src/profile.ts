import type { CredentialProfile, CredentialProfileStatus } from "@claudexor/schema";
import { CredentialProfileStatus as CredentialProfileStatusSchema } from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";
import { canonicalIsolationLocator } from "@claudexor/core";
import { namespacedSecretRefBase } from "@claudexor/secrets";
import { claudeNativeEnv, BIN, type ClaudeProfileRuntimeDeps } from "./index.js";

/**
 * Canonicalize a profile's isolation locator (INV-135): absolute, trailing
 * separators stripped, symlinks resolved when the dir exists. Under the
 * unified account model the Claudexor-owned legacy native dir IS a legal row
 * locator — the exact dir the startup migration auto-registers as
 * `claude-default` (bytes never move; Claude Code keys its Keychain item by
 * this exact path). Ordinary ~/.claude stays outside the owned root and is
 * still refused by the shared isolation-locator authority check.
 */
export function canonicalProfileConfigDir(locator: string): string {
  return canonicalIsolationLocator(locator, "credential profile config dir");
}

/**
 * INV-135 strict profile routing for a run: exactly the profile's transport
 * or a typed refusal — never the default ladder, never a cross-profile
 * fallback. Pure resolution; the caller yields the refusal into the stream.
 */
export async function resolveClaudeProfileRoute(
  profile: CredentialProfile,
  specEnv: Record<string, string>,
  runtime: ClaudeProfileRuntimeDeps,
  abortSignal?: AbortSignal,
): Promise<
  | {
      route: "subscription" | "api_key";
      nativeEnv: Record<string, string | null | undefined>;
      subscriptionSource: "native_session" | "oauth_token_env" | null;
      key: string | null;
      oauthToken: string | null;
      authStatusStale?: boolean;
      authStatusStaleAgeMs?: number;
      refusal: null;
    }
  | { refusal: string }
> {
  let nativeEnv = claudeNativeEnv(specEnv);
  let key: string | null = null;
  let oauthToken: string | null = null;
  let subscriptionSource: "native_session" | "oauth_token_env" | null = null;
  let authStatusStale = false;
  let authStatusStaleAgeMs: number | undefined;
  if (profile.credential_kind === "config_dir_login") {
    try {
      const configDir = canonicalProfileConfigDir(profile.isolation_locator ?? "");
      nativeEnv = claudeNativeEnv(specEnv, configDir);
      // configDir rides EXPLICITLY (round-17 BLOCK): the production probe
      // re-normalizes its env, and without the explicit dir it would inspect
      // the DEFAULT store while claiming to verify the profile.
      const probe = await runtime.probeAuthStatus(BIN, { env: nativeEnv, configDir, abortSignal });
      if (probe.authed) {
        subscriptionSource = "native_session";
        authStatusStale = probe.stale === true;
        authStatusStaleAgeMs = probe.staleAgeMs;
      } else
        return {
          refusal: probe.probeError
            ? `credential profile "${profile.profile_id}": auth probe failed — ${probe.probeError}`
            : `credential profile "${profile.profile_id}" has no verified claude.ai login in its config dir (run the profile login first)`,
        };
    } catch (err) {
      return { refusal: err instanceof Error ? err.message : String(err) };
    }
  } else if (profile.credential_kind === "oauth_token") {
    const slotRefusal = claudeProfileSlotRefusal(profile);
    if (slotRefusal) return { refusal: slotRefusal };
    oauthToken = profile.secret_ref ? runtime.resolveProfileSecret(profile.secret_ref) : null;
    if (oauthToken) subscriptionSource = "oauth_token_env";
    else
      return {
        refusal: `credential profile "${profile.profile_id}": secret "${profile.secret_ref ?? "(missing ref)"}" is not stored`,
      };
  } else {
    const slotRefusal = claudeProfileSlotRefusal(profile);
    if (slotRefusal) return { refusal: slotRefusal };
    key = profile.secret_ref ? runtime.resolveProfileSecret(profile.secret_ref) : null;
    if (!key)
      return {
        refusal: `credential profile "${profile.profile_id}": secret "${profile.secret_ref ?? "(missing ref)"}" is not stored`,
      };
  }
  return {
    route: subscriptionSource !== null ? "subscription" : "api_key",
    nativeEnv,
    subscriptionSource,
    key,
    oauthToken,
    ...(authStatusStale ? { authStatusStale: true, authStatusStaleAgeMs } : {}),
    refusal: null,
  };
}

/** Doctor projection for one claude profile (INV-135). */
export async function probeClaudeCredentialProfile(
  profile: CredentialProfile,
  runtime: ClaudeProfileRuntimeDeps,
  abortSignal?: AbortSignal,
): Promise<CredentialProfileStatus> {
  const base = { profile_id: profile.profile_id, harness_id: "claude" };
  try {
    if (profile.credential_kind === "config_dir_login") {
      const dir = canonicalProfileConfigDir(profile.isolation_locator ?? "");
      const probe = await runtime.probeAuthStatus(BIN, {
        env: claudeNativeEnv(undefined, dir),
        configDir: dir,
        abortSignal,
      });
      if (probe.authed)
        return CredentialProfileStatusSchema.parse({
          ...base,
          availability: probe.stale ? "unknown" : "available",
          verification: probe.stale ? "not_run" : "passed",
          ...(probe.stale
            ? {
                stale: true,
                ...(probe.staleAgeMs === undefined ? {} : { stale_age_ms: probe.staleAgeMs }),
              }
            : {}),
          detail: probe.stale
            ? `auth-status probe is stale; using last-known-good claude.ai login${
                probe.staleAgeMs === undefined ? "" : ` (${probe.staleAgeMs}ms old)`
              }`
            : "claude.ai login verified in the profile config dir",
          ...(probe.stale ? {} : { last_verified_at: nowIso() }),
        });
      // Readiness-edge contract (ARCHITECTURE §auth / DEVELOPMENT): a probe
      // that could not decide is unknown+not_run; a cleanly logged-out dir is
      // absent → unavailable+NOT_RUN (there is no login to have failed); a dir
      // logged in under the WRONG method (e.g. an API key, not claude.ai) is
      // present-but-wrong → available+failed.
      if (probe.probeError)
        return CredentialProfileStatusSchema.parse({
          ...base,
          availability: "unknown",
          verification: "not_run",
          detail: probe.probeError,
        });
      if (!probe.loggedIn)
        return CredentialProfileStatusSchema.parse({
          ...base,
          availability: "unavailable",
          verification: "not_run",
          detail: "no claude.ai login in the profile config dir (run the profile login)",
        });
      return CredentialProfileStatusSchema.parse({
        ...base,
        availability: "available",
        verification: "failed",
        detail: `logged in via ${probe.authMethod ?? "an unknown method"}, not claude.ai subscription auth`,
      });
    }
    // Secret-ref kinds: the probe enforces the SAME slot binding as the run
    // path (release wave round-15 #4) — a foreign-provider or bare ref is
    // unavailable, never admitted-then-rejected at execution. The foreign
    // slot is never even read.
    const slotRefusal = claudeProfileSlotRefusal(profile);
    if (slotRefusal)
      return CredentialProfileStatusSchema.parse({
        ...base,
        availability: "unavailable",
        verification: "failed",
        detail: slotRefusal,
      });
    // PRESENCE is the honest doctor fact here; liveness is the capability
    // smoke's job, not a listing probe's.
    const stored = profile.secret_ref
      ? runtime.resolveProfileSecret(profile.secret_ref) !== null
      : false;
    return CredentialProfileStatusSchema.parse({
      ...base,
      availability: stored ? "available" : "unavailable",
      verification: "not_run",
      detail: stored
        ? `secret "${profile.secret_ref}" is stored`
        : `secret "${profile.secret_ref ?? "(missing ref)"}" is not stored`,
    });
  } catch (err) {
    return CredentialProfileStatusSchema.parse({
      ...base,
      availability: "unavailable",
      verification: "failed",
      detail: redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
  }
}

/** ONE owner of the claude slot binding, shared by the run route and the
 * doctor probe (INV-135): a profile's ref must be a NAMESPACED managed slot
 * bound to its own provider — a claude profile referencing openai:* would
 * transmit that key to Anthropic, and a bare ref (e.g. "anthropic") would
 * alias the engine-default credential. Null = the binding holds. */
function claudeProfileSlotRefusal(profile: CredentialProfile): string | null {
  const expected = profile.credential_kind === "oauth_token" ? "claude_oauth" : "anthropic";
  if (namespacedSecretRefBase(profile.secret_ref) === expected) return null;
  return `credential profile "${profile.profile_id}": ${profile.credential_kind} secret_ref must use a namespaced ${expected} slot (base:profile, e.g. ${expected}:${profile.profile_id}; got "${profile.secret_ref ?? ""}")`;
}
