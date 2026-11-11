import type { AuthSourceReadiness, ConformanceReport } from "@claudexor/schema";
import { ConformanceReport as ConformanceReportSchema } from "@claudexor/schema";
import {
  selectedAuthAvailable,
  selectedAuthReady,
  shouldVerifyApiKey,
  type DoctorSpec,
} from "@claudexor/core";
import type { ClaudeRuntimeDeps } from "./index.js";
import {
  claudeAuthSourceReadiness,
  redactClaudeDoctorDetail,
  type ClaudeAuthStatusProbe,
} from "./auth-status.js";
import { claudeMissingDetail, claudeNativeLoginRemedy } from "./doctor-remedy.js";
import { resolveClaudeBin, claudeRunPatchPath } from "./effort-probe.js";

/** Installation, native-session and API-key evidence keep independent causes. */
export async function claudeDoctor(
  _spec: DoctorSpec,
  runtime: ClaudeRuntimeDeps,
  nativeEnvironment: (
    env?: Record<string, string | null | undefined>,
  ) => Record<string, string | null | undefined>,
): Promise<ConformanceReport> {
  const patchPath = claudeRunPatchPath(_spec);
  const version = await runtime.detectVersion(_spec.abortSignal, patchPath);
  const installation = runtime.installation(resolveClaudeBin(), patchPath);
  if (version === null) {
    return ConformanceReportSchema.parse({
      harness_id: "claude",
      status: "unavailable",
      checks: [
        {
          id: "installed",
          status: "fail",
          detail: claudeMissingDetail(installation, "claude not found on PATH"),
        },
      ],
      reasons: installation.refusal
        ? [installation.refusal]
        : [
            "claude CLI not found (install Claude Code or set CLAUDEXOR_CLAUDE_BIN)",
            ...(installation.advisory ? [installation.advisory] : []),
          ],
    });
  }
  const readonlyProfile = await runtime.probeReadonlyProfile(_spec.abortSignal, patchPath);
  const requestedSource = _spec.authSource;
  const probeNative = requestedSource === undefined || requestedSource === "native_session";
  const probeOAuth = requestedSource === undefined || requestedSource === "oauth_token_env";
  const probeApi = requestedSource === undefined || requestedSource === "api_key_env";
  const nativeEnv = probeNative ? nativeEnvironment(_spec.env) : _spec.env;
  const login: ClaudeAuthStatusProbe = probeNative
    ? await runtime.probeAuthStatus(resolveClaudeBin(), {
        env: nativeEnv,
        abortSignal: _spec.abortSignal,
      })
    : { loggedIn: false, authed: false, authMethod: null, probeError: null };
  const nativeCliReady = login.authed && login.stale !== true;
  // Native-session and stored setup-token proofs are separate sources.
  const oauthToken = probeOAuth ? runtime.claudeOAuthToken() : null;
  const oauthTokenAvailable = oauthToken !== null;
  const apiKey = probeApi && runtime.anthropicApiKey() !== null;
  const preference =
    requestedSource === "native_session" || requestedSource === "oauth_token_env"
      ? "subscription"
      : requestedSource === "api_key_env"
        ? "api_key"
        : (_spec.authPreference ?? "auto");
  const shouldSmokeOAuth =
    probeOAuth && oauthToken !== null && !nativeCliReady && preference !== "api_key";
  const oauthSmoke =
    shouldSmokeOAuth && oauthToken
      ? await runtime.smokeIsolatedOAuthToken(oauthToken, _spec.abortSignal)
      : {
          ok: false,
          detail: oauthTokenAvailable
            ? "verification not run for the unselected setup-token route"
            : "no Claude setup-token available",
        };
  const nativeAvailable = login.loggedIn || oauthTokenAvailable;
  const subscriptionReady = nativeCliReady || oauthSmoke.ok;
  const shouldSmokeKey =
    probeApi &&
    shouldVerifyApiKey({ preference, apiKeyAvailable: apiKey, nativeReady: subscriptionReady });
  const apiSmoke = shouldSmokeKey
    ? await runtime.smokeIsolatedApiKey(_spec.abortSignal)
    : {
        ok: false,
        detail: apiKey
          ? "verification not run for the unselected API-key route"
          : "no API key fallback available",
      };
  const ok = selectedAuthReady({
    preference,
    nativeReady: subscriptionReady,
    apiKeyReady: apiSmoke.ok,
  });
  const selectedAvailable = selectedAuthAvailable({
    preference,
    nativeAvailable,
    apiKeyAvailable: apiKey,
  });
  const probeUnknown =
    preference !== "api_key" &&
    (login.probeError !== null || login.stale === true) &&
    !oauthTokenAvailable;
  // INV-067: name the real cause + designed remedy (see doctor-remedy.ts).
  const nativeLoginRemedy = claudeNativeLoginRemedy(nativeEnv);
  const allIntents = [
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
  ];
  const binPath = installation.path;
  const producedSources = claudeAuthSourceReadiness({
    native: login,
    oauthAvailable: oauthTokenAvailable,
    oauthVerification: oauthSmoke.ok ? "passed" : shouldSmokeOAuth ? "failed" : "not_run",
    oauthDetail: oauthSmoke.detail,
    apiKeyAvailable: apiKey,
    apiKeyVerification: apiSmoke.ok ? "passed" : shouldSmokeKey ? "failed" : "not_run",
    apiKeyDetail: apiSmoke.detail,
  });
  const authSources: AuthSourceReadiness[] =
    requestedSource === undefined
      ? producedSources
      : producedSources.filter((source) => source.source === requestedSource);
  if (requestedSource !== undefined && authSources.length === 0) {
    authSources.push({
      source: requestedSource,
      availability: "unavailable",
      verification: "not_run",
      detail: `Claude does not support ${requestedSource}`,
    });
  }
  const authReasons = ok
    ? []
    : preference === "subscription"
      ? [
          login.stale && !oauthTokenAvailable
            ? `Claude native-session auth-status probe is stale; using last-known-good session${
                login.staleAgeMs === undefined ? "" : ` (${login.staleAgeMs}ms old)`
              }`
            : login.probeError && !oauthTokenAvailable
              ? `Claude native-session probe failed: ${redactClaudeDoctorDetail(login.probeError)}`
              : oauthTokenAvailable
                ? `Claude setup-token verification failed: ${oauthSmoke.detail}`
                : `Claude subscription route is not ready: ${nativeLoginRemedy}`,
        ]
      : preference === "api_key"
        ? [
            apiKey
              ? `isolated Claude API-key smoke failed: ${apiSmoke.detail}`
              : "Claude API-key route is not configured",
          ]
        : login.stale
          ? [
              `Claude native-session auth-status probe is stale; using last-known-good session${
                login.staleAgeMs === undefined ? "" : ` (${login.staleAgeMs}ms old)`
              }`,
            ]
          : apiKey
            ? [`isolated Claude API-key smoke failed: ${apiSmoke.detail}`]
            : login.probeError
              ? [
                  `Claude native-session probe failed: ${redactClaudeDoctorDetail(login.probeError)}`,
                ]
              : [`not authenticated: ${nativeLoginRemedy}`];
  return ConformanceReportSchema.parse({
    harness_id: "claude",
    status: ok
      ? readonlyProfile.supported
        ? "ok"
        : "degraded"
      : selectedAvailable || probeUnknown
        ? "degraded"
        : "unavailable",
    checks: [
      {
        id: "installed",
        status: "pass",
        detail: [binPath ? `${version} at ${binPath}` : version, installation.advisory]
          .filter(Boolean)
          .join(" — "),
      },
      {
        id: "readonly_enforcement",
        status: readonlyProfile.supported ? "pass" : "fail",
        detail: readonlyProfile.detail,
      },
      ...(probeNative
        ? [
            {
              id: "native_session",
              status: nativeCliReady ? "pass" : "fail",
              detail: nativeCliReady
                ? "vendor status confirmed authMethod=claude.ai in the exact run environment"
                : login.stale
                  ? `auth-status probe is stale; using last-known-good native session${
                      login.staleAgeMs === undefined ? "" : ` (${login.staleAgeMs}ms old)`
                    }`
                  : login.probeError
                    ? `auth-status probe failed (NOT an auth verdict): ${redactClaudeDoctorDetail(login.probeError)}`
                    : login.loggedIn
                      ? `logged in via ${login.authMethod ?? "unknown"}, not claude.ai`
                      : "not logged in (run `claudexor auth login claude`)",
            },
          ]
        : []),
      ...(probeOAuth
        ? [
            {
              id: "oauth_setup_token",
              status: oauthSmoke.ok ? "pass" : shouldSmokeOAuth ? "fail" : "skip",
              detail: oauthSmoke.detail,
            },
          ]
        : []),
      ...(probeApi
        ? [
            {
              id: "stored_key",
              status: apiKey ? "pass" : "fail",
              detail: apiKey
                ? "anthropic secret/env available (API-key fallback)"
                : "no anthropic key fallback",
            },
            {
              id: "isolated_api_smoke",
              status: apiSmoke.ok ? "pass" : shouldSmokeKey ? "fail" : "skip",
              detail: apiSmoke.detail,
            },
          ]
        : []),
    ],
    auth_sources: authSources,
    enabled_intents: ok ? allIntents : [],
    disabled_intents: ok ? [] : allIntents,
    reasons: [...authReasons, ...(readonlyProfile.supported ? [] : [readonlyProfile.detail])],
  });
}
