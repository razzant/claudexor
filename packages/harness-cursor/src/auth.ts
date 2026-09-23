import { namespacedSecretRefBase, resolveSecret } from "@claudexor/secrets";
import type { AuthPreference } from "@claudexor/schema";
import { runCapture } from "@claudexor/core";
import { redactSecrets } from "@claudexor/util";
import { resolveCursorBin } from "./bin.js";

const BIN = resolveCursorBin();
const CURSOR_LOGGED_OUT =
  /not logged in|not authenticated|unauthenticated|authentication required|no account|account\s*:\s*(?:none|unknown|not configured|-)(?:\s|$)|authenticated\s*:\s*(?:false|no|none|0)|logged in\s*:\s*(?:false|no|none|0)/i;
const CURSOR_JSON_STATUS_UNSUPPORTED =
  /(?:unknown|unrecognized|unsupported|invalid|unimplemented)\s+(?:option|flag|argument)[^\n]*--format|--format[^\n]*(?:unknown|unrecognized|unsupported|invalid|unimplemented)\s+(?:option|flag|argument)|(?:unknown|unrecognized|unsupported|invalid|unimplemented)[^\n]*(?:--format|json status)/i;

const MAX_CURSOR_ACCOUNT_EMAIL_LENGTH = 320;

/**
 * Typed, allowlisted observation from `cursor-agent status`. Raw status output
 * never leaves this parser. Only an anchored email principal may become an
 * Accounts identity; every other successful-but-unknown shape fails closed.
 */
export type CursorStatusObservation =
  | { kind: "authenticated"; email?: string }
  | { kind: "loggedOut" }
  | { kind: "unknown"; error?: string };

/** Probe only Cursor's vendor-owned native session in the supplied run env. */
export async function probeCursorNativeAuth(
  env?: Record<string, string | null | undefined>,
  abortSignal?: AbortSignal,
  capture: typeof runCapture = runCapture,
): Promise<CursorStatusObservation> {
  try {
    const profileScoped = Boolean(
      env?.["AGENT_CLI_CREDENTIAL_STORE"] || env?.["CURSOR_CONFIG_DIR"],
    );
    const result = await capture(BIN, profileScoped ? ["status", "--format", "json"] : ["status"], {
      env,
      timeoutMs: 10_000,
      abortSignal,
      cancelSignal: "SIGTERM",
      cancelKillDelayMs: 0,
    });
    const text = `${result.stdout}\n${result.stderr}`;
    if (result.code !== 0) {
      // Older Cursor binaries may reject the JSON status flag. One bounded
      // text retry preserves profile-scoped readiness without treating a
      // failed JSON probe as proof that the account is logged out. A signal,
      // timeout, or an unrelated non-zero status is unknown transport
      // evidence, not a capability/format negotiation result.
      if (
        profileScoped &&
        result.signal === null &&
        typeof result.code === "number" &&
        result.code !== 0 &&
        cursorJsonStatusUnsupported(text)
      ) {
        const fallback = await capture(BIN, ["status"], {
          env,
          timeoutMs: 10_000,
          abortSignal,
          cancelSignal: "SIGTERM",
          cancelKillDelayMs: 0,
        });
        const fallbackText = `${fallback.stdout}\n${fallback.stderr}`;
        if (fallback.code === 0 && fallback.signal === null) {
          const observed = cursorAuthenticatedObservation(fallbackText);
          if (observed) return observed;
          if (cursorStatusLoggedOut(fallbackText)) return { kind: "loggedOut" };
        }
      }
      return {
        kind: "unknown",
        error: `cursor-agent status failed (${result.code ?? result.signal ?? "unknown result"})`,
      };
    }
    if (profileScoped) {
      const jsonObservation = cursorJsonStatusObservation(result.stdout);
      if (jsonObservation) return jsonObservation;
      // A successful JSON-capable probe owns the profile-scoped evidence. If
      // its output is malformed or an unknown shape, do not reinterpret stdout
      // or stderr through the legacy text grammar: diagnostics can mention an
      // unrelated host account. Text parsing is reached only through the
      // explicit unsupported-JSON fallback above.
      return {
        kind: "unknown",
        error: `cursor-agent status returned unrecognized JSON output (${result.code})`,
      };
    }
    const authenticated = cursorAuthenticatedObservation(text);
    if (authenticated) return authenticated;
    if (cursorStatusLoggedOut(text)) return { kind: "loggedOut" };
    // Status output can contain the signed-in account principal. Unknown
    // output is not evidence and must not be copied into doctor/setup logs.
    return {
      kind: "unknown",
      error: `cursor-agent status returned unrecognized output (${result.code})`,
    };
  } catch (err) {
    return {
      kind: "unknown",
      error: redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 500),
    };
  }
}

function cursorJsonStatusUnsupported(text: string): boolean {
  return CURSOR_JSON_STATUS_UNSUPPORTED.test(text);
}

/**
 * Profile-scoped Cursor status supports a machine-readable form. Keep the
 * parser deliberately allowlisted: a successful JSON blob with an unfamiliar
 * shape is still unknown evidence, never an authenticated account.
 */
function cursorJsonStatusObservation(text: string): CursorStatusObservation | null {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const verdict = ["authenticated", "isAuthenticated", "loggedIn", "logged_in"].find(
    (key) => typeof record[key] === "boolean",
  );
  if (!verdict) return null;
  if (record[verdict] !== true) return { kind: "loggedOut" };
  const candidates = [
    record.email,
    (record.account as Record<string, unknown> | null)?.email,
    (record.user as Record<string, unknown> | null)?.email,
  ];
  const email = candidates.find(
    (candidate): candidate is string =>
      typeof candidate === "string" &&
      candidate.length <= MAX_CURSOR_ACCOUNT_EMAIL_LENGTH &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate),
  );
  return email ? { kind: "authenticated", email } : { kind: "authenticated" };
}

export function cursorStatusAuthenticated(code: number | null, text: string): boolean {
  return code === 0 && cursorAuthenticatedObservation(text) !== null;
}

function cursorAuthenticatedObservation(
  text: string,
): Extract<CursorStatusObservation, { kind: "authenticated" }> | null {
  if (cursorStatusLoggedOut(text)) return null;
  let authenticated = false;
  let email: string | undefined;
  // Accepted grammar is intentionally narrow and vendor-facing: an explicit
  // "logged in" / "authenticated" verdict, or an Account field containing an
  // email-shaped principal. Bare "account" prose is never readiness proof.
  for (const rawLine of text.replaceAll("\r", "").split("\n")) {
    const line = rawLine.trim().replace(/^✓\s+/, "");
    const principal =
      /^logged in\s+as\s+(\S+@\S+\.\S+?)[.!]?$/i.exec(line)?.[1] ??
      /^account\s*:\s*(\S+@\S+\.\S+?)[.!]?$/i.exec(line)?.[1];
    if (principal && principal.length <= MAX_CURSOR_ACCOUNT_EMAIL_LENGTH) {
      authenticated = true;
      email ??= principal;
      continue;
    }
    if (/^logged in(?:\s+as\s+\S+)?[.!]?$/i.test(line) || /^authenticated[.!]?$/i.test(line)) {
      authenticated = true;
    }
  }
  if (!authenticated) return null;
  return email ? { kind: "authenticated", email } : { kind: "authenticated" };
}

export function cursorStatusLoggedOut(text: string): boolean {
  return CURSOR_LOGGED_OUT.test(text);
}

export function cursorObservationAuthenticated(observation: CursorStatusObservation): boolean {
  return observation.kind === "authenticated";
}

export function cursorObservationError(observation: CursorStatusObservation): string | null {
  return observation.kind === "unknown"
    ? (observation.error ?? "cursor-agent status probe returned unknown evidence")
    : null;
}

export function cursorObservationIdentity(
  observation: CursorStatusObservation,
): { email: string } | null {
  return observation.kind === "authenticated" && observation.email
    ? { email: observation.email }
    : null;
}

export type CursorAuthRoute = "api_key" | "local_session" | "unavailable";

/** Explicit preferences are strict; auto is invariantly native-first. */
export function selectCursorAuthRoute(input: {
  authPreference: AuthPreference;
  hasKey: boolean;
  apiKeyReady: boolean;
  nativeAuthed: boolean;
  scopedHome: boolean;
}): CursorAuthRoute {
  const keyRouteReady = input.hasKey && input.apiKeyReady;
  if (input.authPreference === "api_key") return keyRouteReady ? "api_key" : "unavailable";
  if (input.authPreference === "subscription")
    return input.nativeAuthed ? "local_session" : "unavailable";
  if (input.nativeAuthed) return "local_session";
  return keyRouteReady ? "api_key" : "unavailable";
}

export function shouldDiscloseCursorAutoApiRoute(input: {
  authPreference: AuthPreference;
  route: CursorAuthRoute;
  nativeAuthed: boolean;
}): boolean {
  return input.authPreference === "auto" && input.route === "api_key";
}

/** A probe error is unknown, not proof that native is unavailable. */
export function shouldSmokeCursorApiKey(input: {
  hasKey: boolean;
  authPreference: AuthPreference;
  nativeAuthed: boolean;
  nativeProbeError: string | null;
}): boolean {
  if (!input.hasKey || input.authPreference === "subscription") return false;
  if (input.authPreference === "api_key") return true;
  return !input.nativeAuthed && input.nativeProbeError === null;
}

/**
 * INV-135: an API-key cursor profile is exactly its namespaced secret-ref key.
 * `config_dir_login` profiles are supported but resolved earlier by the
 * profile route owner (profile.ts), so this helper only ever sees the
 * remaining kinds: a non-api_key kind here (e.g. `oauth_token`), a
 * non-namespaced or foreign-slot ref (which would alias the engine default or
 * route another provider's key), and a missing secret are a typed refusal,
 * never the default ladder. ONE owner for the run route and the doctor probe.
 */
export function cursorProfileKeyOrRefusal(
  profile: {
    profile_id: string;
    credential_kind: string;
    secret_ref: string | null;
  },
  resolve: (ref: string) => string | null = resolveSecret,
): { key: string } | { refusal: string; reason: "misconfigured" | "missing_secret" } {
  if (profile.credential_kind !== "api_key")
    return {
      refusal: `credential profile "${profile.profile_id}": cursor credential kind "${profile.credential_kind}" is not supported (use api_key or config_dir_login)`,
      reason: "misconfigured",
    };
  const ref = profile.secret_ref ?? "";
  if (namespacedSecretRefBase(ref) !== "cursor")
    return {
      refusal: `credential profile "${profile.profile_id}": api_key secret_ref must use a namespaced cursor slot (base:profile, e.g. cursor:${profile.profile_id}; got "${ref}")`,
      reason: "misconfigured",
    };
  const key = resolve(ref);
  if (!key)
    return {
      refusal: `credential profile "${profile.profile_id}": secret "${ref}" is not stored`,
      reason: "missing_secret",
    };
  return { key };
}
