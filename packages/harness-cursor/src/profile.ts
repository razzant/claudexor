import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { join } from "node:path";
import {
  canonicalIsolationLocator,
  credentialProfilePinned,
  credentialProfileUnpinned,
  providerScrubEnv,
  type CredentialAccountProbeReceipt,
  type CredentialProfileProbeOptions,
} from "@claudexor/core";
import type { AuthPreference, CredentialProfile, CredentialProfileStatus } from "@claudexor/schema";
import { CredentialProfileStatus as CredentialProfileStatusSchema } from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";
import {
  cursorObservationAuthenticated,
  cursorObservationError,
  cursorObservationIdentity,
  cursorProfileKeyOrRefusal,
  type CursorAuthRoute,
  type CursorStatusObservation,
} from "./auth.js";
import type { CursorEventParser } from "./parse.js";
import { CURSOR_PINNED_STATUS_WAIT_MS, type CursorStatusRead } from "./status-cache.js";

type EnvMap = Record<string, string | null | undefined>;

export interface CursorProfileRuntimeDeps {
  nativeAuthOk: CursorStatusRead;
  resolveProfileSecret: (ref: string) => string | null;
}

/** Canonical, Claudexor-owned HOME for one additive Cursor identity. */
export function canonicalCursorProfileHome(locator: string): string {
  return canonicalIsolationLocator(locator, "credential profile Cursor HOME");
}

/**
 * Cursor's vendor-supported file credential store is selected by HOME on
 * macOS, XDG_CONFIG_HOME on Linux, and APPDATA on Windows. Cursor's mutable
 * config/session data remains independently relocatable, so a run can keep
 * that state in its lane/envelope HOME while reading auth only from the named
 * profile HOME.
 */
export function cursorProfilePathEnv(
  profileHome: string,
  stateHome: string = profileHome,
): Record<string, string> {
  const home = canonicalCursorProfileHome(profileHome);
  const state = stateHome.trim() || home;
  return {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    XDG_CONFIG_HOME: join(home, ".config"),
    CURSOR_CONFIG_DIR: join(state, ".cursor"),
    CURSOR_DATA_DIR: join(state, ".cursor"),
    AGENT_CLI_CREDENTIAL_STORE: "file",
  };
}

/** The HOME a native profile child receives (applied attempt evidence). An
 * API-key row and the profile-less route keep the engine-scoped HOME. */
export function cursorChildHome(spec: Pick<HarnessRunSpec, "credential_profile">): string | null {
  const profile = spec.credential_profile;
  if (profile?.credential_kind !== "config_dir_login" || !profile.isolation_locator) return null;
  try {
    return canonicalCursorProfileHome(profile.isolation_locator);
  } catch {
    return null;
  }
}

/** Exact strict-profile run/probe environment; never bridges the host Keychain. */
export function cursorProfileRunEnv(profileHome: string, specEnv: EnvMap = {}): EnvMap {
  const stateHome = specEnv["HOME"] || profileHome;
  return {
    ...specEnv,
    ...providerScrubEnv(),
    ...cursorProfilePathEnv(profileHome, stateHome),
    CURSOR_API_KEY: null,
  };
}

/** A row store's bounded last positive status answer, standing in after a
 * probe that did not answer (#363); disclosed, never a fresh pass. */
export type CursorStaleAuth = { observedAt: string; ageMs: number };

export type CursorResolvedProfileRoute =
  | { kind: "native"; env: EnvMap; staleAuth?: CursorStaleAuth }
  | { kind: "api_key"; key: string }
  | { refusal: string };

/** Readiness wording for a timed-out probe that carries a bounded last positive. */
function cursorStaleDetail(probeError: string, stale: CursorStaleAuth): string {
  return `${probeError}; the last positive status answer (${stale.observedAt}, ${stale.ageMs}ms old) stands in for unpinned routing only`;
}

/** A pin waited for its status answer up to the bound and none came (#532):
 * the honest refusal names the bound, never a logout or a stale pass. */
function cursorPinUnconfirmed(probe: CursorStatusObservation): string | null {
  if (probe.kind !== "unknown" || probe.timedOut !== true) return null;
  return `Cursor did not confirm sign-in within ${CURSOR_PINNED_STATUS_WAIT_MS / 1000}s (${cursorObservationError(probe)}); a pinned account waits for that answer and never starts on an older one`;
}

/** Strict profile resolution: the named identity or a typed refusal, never default auth.
 * Both options are the caller's engine facts, never inferred from the profile:
 * absent `admitLastPositive`, a timeout's bounded last positive refuses like
 * any unknown answer; `pinned` (an explicit pin) also waits for the status
 * answer up to the pinned bound (#532). */
export async function resolveCursorProfileRoute(
  profile: CredentialProfile,
  specEnv: EnvMap,
  runtime: CursorProfileRuntimeDeps,
  abortSignal?: AbortSignal,
  options: { admitLastPositive?: boolean; pinned?: boolean } = {},
): Promise<CursorResolvedProfileRoute> {
  if (profile.credential_kind === "config_dir_login") {
    try {
      const env = cursorProfileRunEnv(profile.isolation_locator ?? "", specEnv);
      const pinned = options.pinned === true;
      const probe = await runtime.nativeAuthOk(env, abortSignal, pinned ? { pinned } : undefined);
      if (cursorObservationAuthenticated(probe)) return { kind: "native", env };
      // INV-135 #363: the bounded last positive starts only an unpinned
      // choice, disclosed; an explicit pin refuses on it below.
      const lastPositive = probe.kind === "unknown" ? probe.lastPositive : undefined;
      if (lastPositive && options.admitLastPositive === true)
        return { kind: "native", env, staleAuth: lastPositive };
      const probeError = cursorObservationError(probe);
      const unconfirmed = pinned ? cursorPinUnconfirmed(probe) : null;
      // Unknown is not a logout: only a positive logged-out answer carries
      // login advice (#363).
      return {
        refusal: unconfirmed
          ? `credential profile "${profile.profile_id}": ${unconfirmed}`
          : probeError
            ? `credential profile "${profile.profile_id}": Cursor login state is unknown (status probe failed — ${probeError})${
                lastPositive
                  ? `; its last positive status answer (${lastPositive.observedAt}) serves unpinned routing only, never an explicit pin`
                  : ""
              }`
            : `credential profile "${profile.profile_id}" has no Cursor login in its profile HOME (run the profile login first)`,
      };
    } catch (err) {
      return { refusal: err instanceof Error ? err.message : String(err) };
    }
  }
  const gate = cursorProfileKeyOrRefusal(profile, runtime.resolveProfileSecret);
  return "refusal" in gate ? gate : { kind: "api_key", key: gate.key };
}

/** The resolved auth route a cursor run executes with (profile or default ladder). */
export type CursorRunRoute = {
  route: CursorAuthRoute;
  env: EnvMap;
  key: string | null;
  nativeAuthed: boolean;
  scopedHome: boolean;
  staleAuth?: CursorStaleAuth;
};

export type CursorDefaultRouteInput = {
  env: EnvMap;
  authPreference: AuthPreference;
  abortSignal: AbortSignal | undefined;
  /** Set only for API-key profiles: overrides the default key lookup (INV-146 transient). */
  cursorApiKey?: (env?: EnvMap) => string | null;
};

/**
 * INV-135 strict profile routing for a run: named native profiles use Cursor's
 * own file credential store; API-key profiles keep their existing smoked route.
 * The host Keychain is never bridged or read (owner decision D-U3): without a
 * profile the caller-supplied default resolver can only select the API-key
 * route — an unprofiled cursor run has no native session to find.
 */
export async function resolveCursorRunRoute(
  spec: {
    credential_profile: CredentialProfile | null;
    env: EnvMap;
    auth_preference: AuthPreference;
  },
  runtime: CursorProfileRuntimeDeps,
  resolveDefaultRoute: (input: CursorDefaultRouteInput) => Promise<CursorRunRoute>,
  abortSignal: AbortSignal | undefined,
  /** Whether a named row may ride its bounded last positive (#363) and
   * whether it is an explicit pin that waits for its answer (#532). */
  options: { admitLastPositive: boolean; pinned?: boolean },
): Promise<CursorRunRoute | { refusal: string }> {
  const profile = spec.credential_profile;
  const profileRoute = profile
    ? await resolveCursorProfileRoute(profile, spec.env, runtime, abortSignal, options)
    : null;
  if (profileRoute && "refusal" in profileRoute) return profileRoute;
  if (profileRoute?.kind === "native")
    return {
      route: "local_session",
      env: profileRoute.env,
      key: null,
      nativeAuthed: true,
      scopedHome: Boolean(spec.env["HOME"]),
      ...(profileRoute.staleAuth ? { staleAuth: profileRoute.staleAuth } : {}),
    };
  const keyOverride = profileRoute?.kind === "api_key" ? profileRoute.key : null;
  return resolveDefaultRoute({
    env: spec.env,
    authPreference: profile ? "api_key" : spec.auth_preference,
    abortSignal,
    ...(keyOverride === null ? {} : { cursorApiKey: () => keyOverride }),
  });
}

/** The engine's pin facts a spawn-time route check reads from its spec. */
export function cursorSpawnPinFacts(spec: Pick<HarnessRunSpec, "credential_profile" | "extra">) {
  return {
    admitLastPositive: credentialProfileUnpinned(spec),
    pinned: credentialProfilePinned(spec),
  };
}

/** Run-stream disclosure that a row's spawn rides its bounded last positive
 * status answer (same payload keys as the Claude adapter's stale disclosure).
 * A `status` event: it never joins the answer text or reads as a deliverable. */
export function staleCursorAuthEvent(sessionId: string, stale: CursorStaleAuth): HarnessEvent {
  return {
    type: "status",
    session_id: sessionId,
    ts: nowIso(),
    text: `[auth] cursor-agent status did not answer; using the last positive status answer from ${stale.observedAt} (${stale.ageMs}ms old)`,
    payload: { auth_status_stale: true, auth_status_stale_age_ms: stale.ageMs },
  };
}

/** INV-135 attribution: stamp every parsed run event with the profile that ran it. */
export function stampCursorProfileEvents(
  profile: CredentialProfile | null,
  parse: CursorEventParser,
): CursorEventParser {
  if (!profile) return parse;
  return (obj, sessionId) => {
    const out = parse(obj, sessionId);
    if (out) for (const ev of out) ev.credential_profile_id = profile.profile_id;
    return out;
  };
}

function cursorProfileNativeStatus(
  profile: CredentialProfile,
  probe: CursorStatusObservation,
  pinned: boolean,
): CredentialProfileStatus {
  const base = { profile_id: profile.profile_id, harness_id: "cursor" };
  // A pin never consumes a last positive, so its unanswered wait is plain unknown.
  const unconfirmed = pinned ? cursorPinUnconfirmed(probe) : null;
  if (unconfirmed)
    return CredentialProfileStatusSchema.parse({
      ...base,
      availability: "unknown",
      verification: "not_run",
      detail: unconfirmed,
    });
  if (probe.kind === "authenticated")
    return CredentialProfileStatusSchema.parse({
      ...base,
      availability: "available",
      verification: "passed",
      verification_source: probe.vendorAuthenticated ? "vendor" : "local_store",
      detail: probe.vendorAuthenticated
        ? "Cursor server accepted the profile HOME login"
        : "Cursor login verified in the profile HOME file store",
      // A reused positive answer keeps the instant the vendor gave it.
      last_verified_at: probe.observedAt ?? nowIso(),
    });
  const probeError = cursorObservationError(probe);
  // Still unknown/not_run: the stale basis lets unpinned admission alone
  // consume the bounded last positive answer (INV-135 #363).
  if (probeError && probe.kind === "unknown" && probe.lastPositive)
    return CredentialProfileStatusSchema.parse({
      ...base,
      availability: "unknown",
      verification: "not_run",
      stale: true,
      stale_age_ms: probe.lastPositive.ageMs,
      stale_basis: "last_positive_after_timeout",
      detail: cursorStaleDetail(probeError, probe.lastPositive),
    });
  if (probeError)
    return CredentialProfileStatusSchema.parse({
      ...base,
      availability: "unknown",
      verification: "not_run",
      detail: probeError,
    });
  return CredentialProfileStatusSchema.parse({
    ...base,
    availability: "unavailable",
    verification: "not_run",
    detail: "no Cursor login in the profile HOME (run the profile login)",
  });
}

/**
 * Doctor projection for one Cursor profile, using the same route resolver
 * facts. INV-135 (release wave round-15 #1): a valid cursor profile must admit
 * the route even when the default store is logged out — the orchestrator
 * consults THIS probe to override the default auth verdict.
 */
export async function probeCursorCredentialProfile(
  profile: CredentialProfile,
  runtime: CursorProfileRuntimeDeps,
  abortSignal?: AbortSignal,
  options?: CredentialProfileProbeOptions,
): Promise<CredentialProfileStatus> {
  return (await probeCursorCredentialAccount(profile, runtime, abortSignal, options)).status;
}

/** Accounts-only rich probe: readiness and optional email share one status call.
 * Only run admission passes `options.pinned` (#532); Accounts keeps the ordinary wait. */
export async function probeCursorCredentialAccount(
  profile: CredentialProfile,
  runtime: CursorProfileRuntimeDeps,
  abortSignal?: AbortSignal,
  options?: CredentialProfileProbeOptions,
): Promise<CredentialAccountProbeReceipt> {
  if (profile.credential_kind !== "config_dir_login") {
    const base = { profile_id: profile.profile_id, harness_id: "cursor" };
    try {
      const gate = cursorProfileKeyOrRefusal(profile, runtime.resolveProfileSecret);
      if ("refusal" in gate)
        return {
          status: CredentialProfileStatusSchema.parse({
            ...base,
            availability: "unavailable",
            verification: gate.reason === "missing_secret" ? "not_run" : "failed",
            detail: gate.refusal,
          }),
          identity: null,
        };
      return {
        status: CredentialProfileStatusSchema.parse({
          ...base,
          availability: "available",
          verification: "not_run",
          detail: `secret "${profile.secret_ref}" is stored`,
        }),
        identity: null,
      };
    } catch (err) {
      return {
        status: CredentialProfileStatusSchema.parse({
          ...base,
          availability: "unavailable",
          verification: "failed",
          detail: redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300),
        }),
        identity: null,
      };
    }
  }
  try {
    const env = cursorProfileRunEnv(profile.isolation_locator ?? "");
    const observation = await runtime.nativeAuthOk(env, abortSignal, options);
    return {
      status: cursorProfileNativeStatus(profile, observation, options?.pinned === true),
      identity: cursorObservationIdentity(observation),
    };
  } catch (err) {
    return {
      status: CredentialProfileStatusSchema.parse({
        profile_id: profile.profile_id,
        harness_id: "cursor",
        availability: "unavailable",
        verification: "failed",
        detail: redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300),
      }),
      identity: null,
    };
  }
}

// Ask + sandbox bound readonly; force approves optional native web unless it is off.
export function cursorAccessArgs(spec: HarnessRunSpec): string[] {
  if (spec.access === "readonly") {
    const force = spec.external_context_policy === "off" ? [] : ["--force"];
    return [...force, "--sandbox", "enabled", "--trust"];
  }
  if (spec.access === "workspace_write") return ["--force", "--sandbox", "enabled", "--trust"];
  if (spec.access === "inherit_native") return ["--trust"];
  return ["--force", "--sandbox", "disabled", "--trust"];
}
