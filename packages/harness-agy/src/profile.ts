import { AGY_PROGRAM } from "./program.js";
import { join } from "node:path";
import { canonicalIsolationLocator, providerScrubEnv } from "@claudexor/core";
import type { CredentialProfile, CredentialProfileStatus, HarnessRunSpec } from "@claudexor/schema";
import { CredentialProfileStatus as CredentialProfileStatusSchema } from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";
import { isAgyProfileKeychainUnsafe } from "./keychain.js";
import { classifyAgyPrintResult, runAgyPrintCommand } from "./print-command.js";

type EnvMap = Record<string, string | null | undefined>;

export const AGY_BIN = () => process.env.CLAUDEXOR_AGY_BIN || "agy";

/** Canonical, Claudexor-owned HOME for one named Antigravity binding. */
export function canonicalAgyProfileHome(locator: string): string {
  return canonicalIsolationLocator(locator, "credential profile Antigravity HOME");
}

/** Diagnostic-only path for stale-file precedence fixtures. Credential
 * readiness and routing never infer auth from this file: the effective
 * transport is platform/version dependent and only the vendor probe proves it. */
export function agyTokenPath(profileHome: string): string {
  return join(profileHome, ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

/**
 * Exact strict-profile env: the profile HOME selects the vendor's whole
 * config root (`$HOME/.gemini/...`) — agy has no config-dir env var, HOME is
 * the single lever. `USERPROFILE` mirrors HOME for the win32 resolver, the
 * auto-updater is pinned off so the closed vendor binary cannot replace
 * itself mid-run, and the provider scrub drops every API-key route
 * (`GEMINI_API_KEY` included) so a native subscription run can never silently
 * turn metered (INV-061).
 *
 * Unlike Cursor — whose mutable state is separately relocatable via
 * `CURSOR_CONFIG_DIR`, so a run keeps state in its LANE home and reads auth
 * from the profile — agy has exactly one lever. Overriding HOME therefore
 * moves the vendor's conversations/brain/cache into the profile HOME too, and
 * the per-lane home is unused for agy runs. Deliberate, not an oversight: a
 * lane-scoped `.gemini` would be a dead directory the vendor never reads.
 * What holds today is per-lane RESUME: a lane replays its own vendor
 * conversation by id (`--conversation`, INV-137). Nothing scopes those
 * conversations to a lane yet — the vendor's project mechanism
 * (`--new-project`/`--project`, Л-19) is not wired here — so one profile HOME
 * accumulates every thread's vendor state, and conversations are NOT scoped per
 * chat thread.
 */
export function agyProfileRunEnv(profileHome: string, specEnv: EnvMap = {}): EnvMap {
  const home = canonicalAgyProfileHome(profileHome);
  return {
    ...specEnv,
    ...providerScrubEnv(),
    HOME: home,
    USERPROFILE: home,
    ...AGY_PROGRAM.childUpdateEnv,
  };
}

export type AgyResolvedProfileRoute = { home: string; env: EnvMap } | { refusal: string };

/**
 * INV-135 route construction only: validate the named binding and build the
 * exact scoped environment. Credential evidence belongs exclusively to the
 * vendor probe; this resolver never treats a fallback token file (or its
 * absence) as an auth oracle.
 */
export function resolveAgyProfileRoute(
  profile: Pick<CredentialProfile, "profile_id" | "credential_kind" | "isolation_locator">,
  specEnv: EnvMap = {},
): AgyResolvedProfileRoute {
  if (profile.credential_kind !== "config_dir_login")
    return {
      refusal: `credential profile "${profile.profile_id}": agy supports only the config_dir_login transport (a named profile HOME)`,
    };
  try {
    const home = canonicalAgyProfileHome(profile.isolation_locator ?? "");
    return { home, env: agyProfileRunEnv(home, specEnv) };
  } catch (err) {
    return { refusal: err instanceof Error ? err.message : String(err) };
  }
}

/** The HOME an agy child receives: the named binding's own HOME (applied
 * attempt evidence), since agy has no config-dir variable. */
export function agyChildHome(spec: Pick<HarnessRunSpec, "credential_profile">): string | null {
  const route = spec.credential_profile ? resolveAgyProfileRoute(spec.credential_profile) : null;
  return route && !("refusal" in route) ? route.home : null;
}

export interface AgyProfileProbeDeps {
  /** Injectable live probe (tests): print-mode `/model` under the profile env. */
  runModelProbe: (env: EnvMap, abortSignal?: AbortSignal) => Promise<AgyModelProbe>;
  /** Production adapter seam: prepare the profile before the vendor probe. */
  prepareProfileKeychain?: (home: string) => void;
}

export type AgyModelProbe =
  | { kind: "authenticated"; modelId: string | null }
  | { kind: "unauthenticated"; detail: string }
  | { kind: "probe_failed"; detail: string };

/**
 * Quota-free liveness probe: `agy -p "/model" --output-format json` answers
 * from the CLI without spending a turn (vendor 1.1.11+ print-mode
 * slash-commands). SUCCESS proves the named binding authenticates in the
 * exact env its runs will spawn with (INV-067); an auth error is an honest
 * logged-out/revoked verdict, and a spawn/parse failure stays `unknown`.
 */
export async function defaultAgyModelProbe(
  env: EnvMap,
  abortSignal?: AbortSignal,
): Promise<AgyModelProbe> {
  try {
    const classified = classifyAgyPrintResult(
      await runAgyPrintCommand(AGY_BIN(), "/model", env, { abortSignal }),
    );
    if (classified.kind === "unauthenticated") return classified;
    if (classified.kind === "probe_failed") return classified;
    const command = classified.envelope["command"];
    const data =
      command && typeof command === "object" && !Array.isArray(command)
        ? (command as Record<string, unknown>)["data"]
        : null;
    const id =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)["id"]
        : null;
    if (typeof id !== "string" || !id.trim()) {
      return { kind: "probe_failed", detail: "agy model envelope carried no model id" };
    }
    return { kind: "authenticated", modelId: id };
  } catch (err) {
    return {
      kind: "probe_failed",
      detail: redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300),
    };
  }
}

/**
 * Doctor projection for one agy profile (INV-135): the SAME route resolution
 * the run uses, then the quota-free live probe. A valid profile must admit
 * the route even though agy has no default store at all — the orchestrator
 * consults THIS probe for pinned routing.
 */
export async function probeAgyCredentialProfile(
  profile: CredentialProfile,
  deps: AgyProfileProbeDeps = { runModelProbe: defaultAgyModelProbe },
  abortSignal?: AbortSignal,
): Promise<CredentialProfileStatus> {
  const base = { profile_id: profile.profile_id, harness_id: "agy" };
  const route = resolveAgyProfileRoute(profile);
  if ("refusal" in route)
    return CredentialProfileStatusSchema.parse({
      ...base,
      availability: "unavailable",
      verification: "not_run",
      detail: route.refusal,
    });
  let keychainSetupWarning: string | null = null;
  try {
    deps.prepareProfileKeychain?.(route.home);
  } catch (error) {
    if (isAgyProfileKeychainUnsafe(error)) {
      return CredentialProfileStatusSchema.parse({
        ...base,
        availability: "unavailable",
        verification: "not_run",
        detail: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 300),
      });
    }
    // A custom operational seam may model a recoverable security-tool miss.
    // Keep the vendor file fallback and disclose the degraded container on
    // the profile status rather than presenting a completely clean proof.
    keychainSetupWarning = redactSecrets(
      error instanceof Error ? error.message : String(error),
    ).slice(0, 300);
  }
  const probe = await deps.runModelProbe(route.env, abortSignal);
  if (probe.kind === "authenticated")
    return CredentialProfileStatusSchema.parse({
      ...base,
      availability: "available",
      verification: "passed",
      verification_source: "vendor",
      detail:
        `Antigravity accepted the named binding${probe.modelId ? ` (model ${probe.modelId})` : ""}; whether the credential is backed by a keyring or file is not inferred` +
        (keychainSetupWarning
          ? `; private profile keychain setup degraded: ${keychainSetupWarning}`
          : ""),
      last_verified_at: nowIso(),
    });
  if (probe.kind === "unauthenticated")
    return CredentialProfileStatusSchema.parse({
      ...base,
      availability: "unavailable",
      verification: "failed",
      verification_source: "vendor",
      detail: `Antigravity rejected the named binding credential: ${probe.detail}`,
    });
  return CredentialProfileStatusSchema.parse({
    ...base,
    availability: "unknown",
    verification: "not_run",
    detail: probe.detail,
  });
}
