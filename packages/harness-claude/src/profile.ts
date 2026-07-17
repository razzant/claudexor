import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { CredentialProfile, CredentialProfileStatus } from "@claudexor/schema";
import { CredentialProfileStatus as CredentialProfileStatusSchema } from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";
import { canonicalIsolationLocator } from "@claudexor/core";
import {
  claudeNativeEnv,
  defaultNativeClaudeConfigDir,
  BIN,
  type ClaudeProfileRuntimeDeps,
} from "./index.js";

/**
 * Canonicalize a profile's isolation locator (INV-135): absolute, trailing
 * separators stripped, symlinks resolved when the dir exists. Refuses the
 * default native dir — profiles are ADDITIVE identities; the user's real
 * ~/.claude is never a profile target, so profile operations cannot touch it.
 */
export function canonicalProfileConfigDir(locator: string): string {
  const dir = canonicalIsolationLocator(locator, "credential profile config dir");
  let defaultDir = resolve(defaultNativeClaudeConfigDir());
  try {
    defaultDir = realpathSync(defaultDir);
  } catch {
    /* default dir may not exist; compare resolved paths */
  }
  if (dir === defaultDir) {
    throw new Error(
      "credential profile config dir must not be the default native Claude dir (profiles are additive; INV-135)",
    );
  }
  return dir;
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
      refusal: null;
    }
  | { refusal: string }
> {
  let nativeEnv = claudeNativeEnv(specEnv);
  let key: string | null = null;
  let oauthToken: string | null = null;
  let subscriptionSource: "native_session" | "oauth_token_env" | null = null;
  if (profile.credential_kind === "config_dir_login") {
    try {
      const configDir = canonicalProfileConfigDir(profile.isolation_locator ?? "");
      nativeEnv = claudeNativeEnv(specEnv, configDir);
      const probe = await runtime.probeAuthStatus(BIN, { env: nativeEnv, abortSignal });
      if (probe.authed) subscriptionSource = "native_session";
      else
        return {
          refusal: probe.probeError
            ? `credential profile "${profile.profile_id}": auth probe failed — ${probe.probeError}`
            : `credential profile "${profile.profile_id}" has no verified claude.ai login in its config dir (run the profile login first)`,
        };
    } catch (err) {
      return { refusal: err instanceof Error ? err.message : String(err) };
    }
  } else if (profile.credential_kind === "oauth_token") {
    oauthToken = profile.secret_ref ? runtime.resolveProfileSecret(profile.secret_ref) : null;
    if (oauthToken) subscriptionSource = "oauth_token_env";
    else
      return {
        refusal: `credential profile "${profile.profile_id}": secret "${profile.secret_ref ?? "(missing ref)"}" is not stored`,
      };
  } else {
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
        abortSignal,
      });
      if (probe.authed)
        return CredentialProfileStatusSchema.parse({
          ...base,
          availability: "available",
          verification: "passed",
          detail: "claude.ai login verified in the profile config dir",
          last_verified_at: nowIso(),
        });
      return CredentialProfileStatusSchema.parse({
        ...base,
        availability: probe.probeError ? "unknown" : "unavailable",
        verification: probe.probeError ? "not_run" : "failed",
        detail:
          probe.probeError ??
          "no verified claude.ai login in the profile config dir (run the profile login)",
      });
    }
    // Secret-ref kinds: PRESENCE is the honest doctor fact here; liveness
    // is the capability smoke's job, not a listing probe's.
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
