import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialProfile, CredentialProfileStatus } from "@claudexor/schema";
import { CredentialProfileStatus as CredentialProfileStatusSchema } from "@claudexor/schema";
import { namespacedSecretRefBase } from "@claudexor/secrets";
import { nowIso, redactSecrets } from "@claudexor/util";
import { codexAuthModeAt, defaultNativeCodexHome, ensureCodexApiAuth } from "./auth.js";
import { canonicalIsolationLocator, normalizeThroughExistingAncestor } from "@claudexor/core";
import { BIN, codexNativeEnv, type CodexProfileRuntimeDeps } from "./index.js";

/**
 * Canonicalize a profile's CODEX_HOME (INV-135): absolute, symlinks resolved
 * when the dir exists, and NEVER the default native home — profiles are
 * additive identities; the vendor-owned default is never a profile target.
 */
export function canonicalCodexProfileHome(locator: string): string {
  const dir = canonicalIsolationLocator(locator, "credential profile CODEX_HOME");
  const defaultDir = normalizeThroughExistingAncestor(defaultNativeCodexHome());
  if (dir === defaultDir) {
    throw new Error(
      "credential profile CODEX_HOME must not be the default native codex home (profiles are additive; INV-135)",
    );
  }
  return dir;
}

/**
 * INV-135 strict profile routing for a run: exactly the profile's transport
 * or a typed refusal — never the default ladder, never a cross-profile
 * fallback. Pure resolution; the caller yields the refusal into the stream.
 */
export async function resolveCodexProfileRoute(
  profile: CredentialProfile,
  specEnv: Record<string, string>,
  runtime: CodexProfileRuntimeDeps,
  abortSignal?: AbortSignal,
): Promise<
  | {
      route: "subscription" | "api_key";
      nativeEnv: Record<string, string | null | undefined>;
      tempCodexHome: string | null;
      key: string | null;
      refusal: null;
    }
  | { refusal: string }
> {
  let nativeEnv = codexNativeEnv(specEnv);
  if (profile.credential_kind === "config_dir_login") {
    try {
      const home = canonicalCodexProfileHome(profile.isolation_locator ?? "");
      nativeEnv = codexNativeEnv(specEnv, home);
      // codexHome rides EXPLICITLY (round-17 BLOCK): the production probe
      // re-normalizes its env, and without the explicit home it would inspect
      // the DEFAULT store while claiming to verify the profile.
      const login = await runtime.probeLogin(BIN, { env: nativeEnv, codexHome: home, abortSignal });
      if (login.method === "chatgpt" && login.probeError === null)
        return { route: "subscription", nativeEnv, tempCodexHome: null, key: null, refusal: null };
      return {
        refusal: login.probeError
          ? `credential profile "${profile.profile_id}": login probe failed — ${login.probeError}`
          : `credential profile "${profile.profile_id}" has no ChatGPT login in its CODEX_HOME (run the profile login first)`,
      };
    } catch (err) {
      return { refusal: err instanceof Error ? err.message : String(err) };
    }
  }
  if (profile.credential_kind === "api_key") {
    const slotRefusal = codexProfileSlotRefusal(profile);
    if (slotRefusal) return { refusal: slotRefusal };
    const key = profile.secret_ref ? runtime.resolveProfileSecret(profile.secret_ref) : null;
    if (!key)
      return {
        refusal: `credential profile "${profile.profile_id}": secret "${profile.secret_ref ?? "(missing ref)"}" is not stored`,
      };
    const tempCodexHome = mkdtempSync(join(tmpdir(), "claudexor-codex-auth-"));
    ensureCodexApiAuth({ CODEX_HOME: tempCodexHome }, true, key);
    if (codexAuthModeAt(tempCodexHome) === "api_key")
      return { route: "api_key", nativeEnv, tempCodexHome, key, refusal: null };
    rmSync(tempCodexHome, { recursive: true, force: true });
    return {
      refusal: `credential profile "${profile.profile_id}": scoped auth.json could not be established`,
    };
  }
  return {
    refusal: `credential profile "${profile.profile_id}": codex does not support the ${profile.credential_kind} transport`,
  };
}

/** ONE owner of the codex slot binding, shared by the run route and the
 * doctor probe (INV-135): the ref must be a NAMESPACED openai slot — a
 * foreign-provider ref would send that key to OpenAI, and a bare "openai"
 * would alias the engine-default credential. Null = the binding holds. */
function codexProfileSlotRefusal(profile: CredentialProfile): string | null {
  if (namespacedSecretRefBase(profile.secret_ref) === "openai") return null;
  return `credential profile "${profile.profile_id}": api_key secret_ref must use a namespaced openai slot (base:profile, e.g. openai:${profile.profile_id}; got "${profile.secret_ref ?? ""}")`;
}

/** Doctor projection for one codex profile (INV-135). */
export async function probeCodexCredentialProfile(
  profile: CredentialProfile,
  runtime: CodexProfileRuntimeDeps,
  abortSignal?: AbortSignal,
): Promise<CredentialProfileStatus> {
  const base = { profile_id: profile.profile_id, harness_id: "codex" };
  try {
    if (profile.credential_kind === "config_dir_login") {
      const home = canonicalCodexProfileHome(profile.isolation_locator ?? "");
      const login = await runtime.probeLogin(BIN, {
        env: codexNativeEnv(undefined, home),
        codexHome: home,
        abortSignal,
      });
      if (login.method === "chatgpt" && login.probeError === null)
        return CredentialProfileStatusSchema.parse({
          ...base,
          availability: "available",
          verification: "passed",
          detail: "ChatGPT login verified in the profile CODEX_HOME",
          last_verified_at: nowIso(),
        });
      // Readiness-edge contract (ARCHITECTURE §auth / DEVELOPMENT): probe
      // failure = unknown+not_run; a cleanly logged-out home is absent →
      // unavailable+NOT_RUN; a home logged in under a NON-ChatGPT method
      // (api_key / access_token) is present-but-wrong → available+failed.
      if (login.probeError)
        return CredentialProfileStatusSchema.parse({
          ...base,
          availability: "unknown",
          verification: "not_run",
          detail: login.probeError,
        });
      if (login.authed)
        return CredentialProfileStatusSchema.parse({
          ...base,
          availability: "available",
          verification: "failed",
          detail: `logged in via ${login.method}, not ChatGPT subscription auth`,
        });
      return CredentialProfileStatusSchema.parse({
        ...base,
        availability: "unavailable",
        verification: "not_run",
        detail: "no ChatGPT login in the profile CODEX_HOME (run the profile login)",
      });
    }
    if (profile.credential_kind === "api_key") {
      // The probe enforces the SAME slot binding as the run path (release
      // wave round-15 #4) — a foreign-provider or bare ref is unavailable,
      // never admitted-then-rejected at execution; the slot is never read.
      const slotRefusal = codexProfileSlotRefusal(profile);
      if (slotRefusal)
        return CredentialProfileStatusSchema.parse({
          ...base,
          availability: "unavailable",
          verification: "failed",
          detail: slotRefusal,
        });
      // PRESENCE is the honest doctor fact here; liveness is the
      // capability smoke's job, not a listing probe's.
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
    }
    return CredentialProfileStatusSchema.parse({
      ...base,
      availability: "unavailable",
      verification: "failed",
      detail: `codex does not support the ${profile.credential_kind} transport`,
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
