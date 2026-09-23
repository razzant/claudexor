import type { AuthPreference, AuthSourceReadiness } from "@claudexor/schema";
import { ConformanceReport as ConformanceReportSchema } from "@claudexor/schema";
import type { DoctorSpec, HarnessAccountDoctorReceipt } from "@claudexor/core";
import {
  cursorObservationAuthenticated,
  cursorObservationError,
  cursorObservationIdentity,
  selectCursorAuthRoute,
  shouldSmokeCursorApiKey,
  type CursorStatusObservation,
} from "./auth.js";

type EnvMap = Record<string, string | null | undefined>;
type CursorApiSmokeResult = { ok: boolean; detail: string };

export interface CursorDoctorDeps {
  detectVersion(abortSignal?: AbortSignal): Promise<string | null>;
  nativeAuthOk(env?: EnvMap, abortSignal?: AbortSignal): Promise<CursorStatusObservation>;
  cursorApiKey(env?: EnvMap): string | null;
  smokeApiKey(key: string, fresh: boolean): Promise<CursorApiSmokeResult>;
  nativeEnv(env?: EnvMap): EnvMap;
  /** True when the supplied env explicitly selects the vendor FILE store —
   * the only env class whose native session may be probed (D-U3). */
  fileStoreEnv(env?: EnvMap): boolean;
}

/** One Cursor doctor probe with an optional Accounts identity sidecar. */
export async function probeCursorDoctorForAccounts(
  spec: DoctorSpec,
  runtime: CursorDoctorDeps,
): Promise<HarnessAccountDoctorReceipt> {
  const version = await runtime.detectVersion(spec.abortSignal);
  if (version === null) {
    return {
      report: ConformanceReportSchema.parse({
        harness_id: "cursor",
        status: "unavailable",
        checks: [{ id: "installed", status: "fail", detail: "Cursor CLI not found (`cursor-agent` or `agent`)" }],
        reasons: ["Cursor CLI not found: neither `cursor-agent` nor a Cursor `agent` on PATH (install Cursor CLI or set CLAUDEXOR_CURSOR_BIN)"],
      }),
      identity: null,
    };
  }
  const requestedSource = spec.authSource;
  const probeNativeRequested =
    requestedSource === undefined || requestedSource === "native_session";
  // D-U3 (unified account model): a native cursor session exists ONLY inside
  // an account row's file store. Any other env would resolve the HOST
  // Keychain login, which is never read — so the probe is honestly skipped
  // and the native source reports unavailable with the remedy.
  const probeNative = probeNativeRequested && runtime.fileStoreEnv(spec.env);
  const probeApi = requestedSource === undefined || requestedSource === "api_key_env";
  const env = runtime.nativeEnv(spec.env);
  const scopedHome = Boolean(spec.env?.["HOME"]);
  const authPreference: AuthPreference =
    requestedSource === "native_session"
      ? "subscription"
      : requestedSource === "api_key_env"
        ? "api_key"
        : (spec.authPreference ?? "auto");
  const nativeProbe: CursorStatusObservation = probeNative
    ? await runtime.nativeAuthOk(env, spec.abortSignal)
    : { kind: "loggedOut" };
  const nativeAuthed = cursorObservationAuthenticated(nativeProbe);
  const nativeProbeError = cursorObservationError(nativeProbe);
  const key = probeApi ? runtime.cursorApiKey(spec.env) : null;
  const apiKey = key !== null;
  const shouldSmokeApiKey = shouldSmokeCursorApiKey({
    hasKey: apiKey,
    authPreference,
    nativeAuthed,
    nativeProbeError,
  });
  const apiSmoke =
    key && shouldSmokeApiKey
      ? await runtime.smokeApiKey(key, spec.fresh === true)
      : unsmokedApiSmoke(key);
  // Readiness doctrine: a key string alone is source availability, not
  // proven readiness. A bridged native status probe proves the exact scoped
  // environment; API fallback still requires its isolated smoke.
  const routeableIntents = [
    "plan",
    "spec",
    "implement",
    "repair",
    "create_from_scratch",
    "review",
    "verify",
    "synthesize",
    "explain",
    "audit",
  ] as const;
  const route = selectCursorAuthRoute({
    authPreference,
    hasKey: apiKey,
    apiKeyReady: apiSmoke.ok,
    nativeAuthed,
    scopedHome,
  });
  const enabled = route === "unavailable" ? [] : [...routeableIntents];
  const ok = route !== "unavailable";
  const selectedAvailable =
    authPreference === "subscription"
      ? nativeAuthed
      : authPreference === "api_key"
        ? apiKey
        : nativeAuthed || apiKey;
  const probeUnknown = authPreference !== "api_key" && nativeProbeError !== null;
  const nativeSource: AuthSourceReadiness = nativeProbeError
    ? {
        source: "native_session",
        availability: "unknown",
        verification: "not_run",
        detail: `Cursor status probe failed: ${nativeProbeError}`,
      }
    : nativeAuthed
      ? {
          source: "native_session",
          availability: "available",
          verification: "passed",
          detail: "native Cursor session passed the status probe in the exact run environment",
        }
      : {
          source: "native_session",
          availability: "unavailable",
          verification: "not_run",
          detail:
            probeNativeRequested && !probeNative
              ? "host CLI logins are not used (unified account model): connect an isolated Cursor account (`claudexor auth login cursor`)"
              : "native Cursor session is not authenticated",
        };
  const apiSource: AuthSourceReadiness = {
    source: "api_key_env",
    availability: apiKey ? "available" : "unavailable",
    verification: apiSmoke.ok ? "passed" : shouldSmokeApiKey ? "failed" : "not_run",
    detail: apiSmoke.detail,
  };
  const authSources: AuthSourceReadiness[] =
    requestedSource === "native_session"
      ? [nativeSource]
      : requestedSource === "api_key_env"
        ? [apiSource]
        : requestedSource !== undefined
          ? [
              {
                source: requestedSource,
                availability: "unavailable",
                verification: "not_run",
                detail: `Cursor does not support ${requestedSource}`,
              },
            ]
          : [nativeSource, apiSource];
  return {
    report: ConformanceReportSchema.parse({
      harness_id: "cursor",
      status: ok ? "ok" : selectedAvailable || probeUnknown ? "degraded" : "unavailable",
      checks: [
        { id: "installed", status: "pass", detail: version },
        ...(probeNative
          ? [
              {
                id: "auth",
                status: nativeAuthed ? ("pass" as const) : ("fail" as const),
                detail: nativeProbeError ?? nativeSource.detail,
              },
            ]
          : []),
        ...(probeApi
          ? [
              {
                id: "stored_key",
                status: apiKey ? ("pass" as const) : ("fail" as const),
                detail: apiKey ? "cursor secret/env available" : "no Cursor API-key fallback",
              },
              {
                id: "isolated_api_smoke",
                status: apiSmoke.ok ? ("pass" as const) : shouldSmokeApiKey ? "fail" : "skip",
                detail: apiSmoke.detail,
              },
            ]
          : []),
      ],
      auth_sources: authSources,
      enabled_intents: enabled,
      disabled_intents: routeableIntents.filter((intent) => !enabled.includes(intent)),
      reasons: ok
        ? []
        : nativeProbeError && authPreference !== "api_key"
          ? [`Cursor native-session probe failed: ${nativeProbeError}`]
          : authPreference === "subscription"
            ? ["Cursor subscription route is not ready (run `claudexor auth login cursor`)"]
            : authPreference === "api_key"
              ? [
                  apiKey
                    ? `cursor key present but route unproven: ${apiSmoke.detail}`
                    : "Cursor API-key route is not configured",
                ]
              : apiKey
                ? [`cursor key present but route unproven: ${apiSmoke.detail}`]
                : [
                    "not authenticated (run `claudexor auth login cursor` for native/subscription use, or set/store a Cursor API-key fallback)",
                  ],
    }),
    identity: probeNative ? cursorObservationIdentity(nativeProbe) : null,
  };
}

function unsmokedApiSmoke(key: string | null): CursorApiSmokeResult {
  return {
    ok: false,
    detail: key ? "Cursor API-key smoke not required for selected route" : "no Cursor API key",
  };
}
