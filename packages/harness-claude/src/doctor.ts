import type { AuthSourceReadiness, ConformanceReport } from "@claudexor/schema";
import { ConformanceReport as ConformanceReportSchema } from "@claudexor/schema";
import {
  DIAGNOSTIC_GENERATION_WITHHELD,
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
  // Both smokes are generation requests; a stored setup-token's diagnostic
  // cost is unknown even when its source is a subscription.
  const generationForbidden = _spec.diagnosticGeneration === "forbidden";
  const oauthNeedsProof =
    probeOAuth && oauthToken !== null && !nativeCliReady && preference !== "api_key";
  const shouldSmokeOAuth = oauthNeedsProof && !generationForbidden;
  const oauthSmoke =
    shouldSmokeOAuth && oauthToken
      ? await runtime.smokeIsolatedOAuthToken(oauthToken, _spec.abortSignal)
      : {
          ok: false,
          detail: oauthTokenAvailable
            ? oauthNeedsProof
              ? DIAGNOSTIC_GENERATION_WITHHELD
              : "verification not run for the unselected setup-token route"
            : "no Claude setup-token available",
        };
  const nativeAvailable = login.loggedIn || oauthTokenAvailable;
  const subscriptionReady = nativeCliReady || oauthSmoke.ok;
  const keyNeedsProof =
    probeApi &&
    shouldVerifyApiKey({ preference, apiKeyAvailable: apiKey, nativeReady: subscriptionReady });
  const shouldSmokeKey = keyNeedsProof && !generationForbidden;
  const apiSmoke = shouldSmokeKey
    ? await runtime.smokeIsolatedApiKey(_spec.abortSignal)
    : {
        ok: false,
        detail: apiKey
          ? keyNeedsProof
            ? DIAGNOSTIC_GENERATION_WITHHELD
            : "verification not run for the unselected API-key route"
          : "no API key fallback available",
      };
  // A withheld proof is "not run", never a failed smoke.
  const oauthReason =
    oauthNeedsProof && generationForbidden
      ? `Claude setup-token ${oauthSmoke.detail}`
      : `Claude setup-token verification failed: ${oauthSmoke.detail}`;
  const apiReason =
    keyNeedsProof && generationForbidden
      ? `Claude API-key ${apiSmoke.detail}`
      : `isolated Claude API-key smoke failed: ${apiSmoke.detail}`;
  // A setup-token whose proof the $0 mode withheld stays "not run" in every Auto reason.
  const tokenWithheld = oauthNeedsProof && generationForbidden;
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
                ? oauthReason
                : `Claude subscription route is not ready: ${nativeLoginRemedy}`,
        ]
      : preference === "api_key"
        ? [apiKey ? apiReason : "Claude API-key route is not configured"]
        : login.stale
          ? [
              `Claude native-session auth-status probe is stale; using last-known-good session${
                login.staleAgeMs === undefined ? "" : ` (${login.staleAgeMs}ms old)`
              }`,
              ...(apiKey && keyNeedsProof && generationForbidden ? [apiReason] : []),
              ...(tokenWithheld ? [oauthReason] : []),
            ]
          : apiKey
            ? [apiReason, ...(tokenWithheld ? [oauthReason] : [])]
            : login.probeError
              ? [
                  `Claude native-session probe failed: ${redactClaudeDoctorDetail(login.probeError)}`,
                  ...(tokenWithheld ? [oauthReason] : []),
                ]
              : tokenWithheld
                ? [oauthReason]
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
