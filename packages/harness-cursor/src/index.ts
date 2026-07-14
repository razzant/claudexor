import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AccessProfile,
  AuthPreference,
  AuthSourceReadiness,
  ConformanceReport,
  HarnessCapabilityProfile,
  HarnessEvent,
  HarnessManifest,
  HarnessModel,
  HarnessRunSpec,
} from "@claudexor/schema";
import {
  ConformanceReport as ConformanceReportSchema,
  HarnessCapabilityProfile as HarnessCapabilityProfileSchema,
  HarnessManifest as HarnessManifestSchema,
} from "@claudexor/schema";
import type { DoctorSpec, HarnessAdapter } from "@claudexor/core";
import {
  abortSignalFromSpec,
  HarnessUnavailableError,
  needsScopedHomeKeychainBridge,
  providerScrubEnv,
  runCapture,
  runCliHarness as runCliHarnessDefault,
} from "@claudexor/core";
import { resolveSecret } from "@claudexor/secrets";
import { CLAUDEXOR_VERSION, nowIso, redactSecrets } from "@claudexor/util";
import { createCursorParser } from "./parse.js";
import {
  probeCursorNativeAuth,
  selectCursorAuthRoute,
  shouldDiscloseCursorAutoApiRoute,
  shouldSmokeCursorApiKey,
  type CursorAuthRoute,
  type CursorNativeAuthProbe,
} from "./auth.js";
export { cursorStatusAuthenticated, cursorStatusLoggedOut, selectCursorAuthRoute, shouldDiscloseCursorAutoApiRoute } from "./auth.js";

const BIN = process.env.CLAUDEXOR_CURSOR_BIN || "cursor-agent";
// Long enough for one sequential reviewer panel pass; still bounded so revoked
// keys do not remain smoke-proven for a whole daemon lifetime.
const CURSOR_API_SMOKE_CACHE_TTL_MS = 60 * 60_000;
const CURSOR_API_SMOKE_FAILURE_CACHE_TTL_MS = 30_000;

const CURSOR_CAPABILITY_PROFILE: HarnessCapabilityProfile = HarnessCapabilityProfileSchema.parse({
  auth: {
    supported_sources: ["native_session", "api_key_env"],
    preferred_source: null,
    credential_transports: [
      { source: "native_session", kind: "os_keychain", relocatable_by: ["HOME"] },
      { source: "api_key_env", kind: "env_var", relocatable_by: ["ENV"] },
    ],
  },
  access_control: { readonly_mechanism: "fs_sandbox" },
  isolation: {
    supported_containment: ["scoped_home_keychain_bridge", "env_or_file_injection"],
  },
  image_input: "none",
});

function accessArgs(access: AccessProfile): string[] {
  switch (access) {
    case "readonly":
      return ["--sandbox", "enabled", "--trust"];
    case "workspace_write":
      // `--force` alone force-allows commands with NO sandbox — materially
      // broader than claude acceptEdits / codex --sandbox workspace-write for
      // the same profile. Keep the sandbox on for workspace_write parity.
      return ["--force", "--sandbox", "enabled", "--trust"];
    case "full":
    case "external_sandbox_full":
      return ["--force", "--sandbox", "disabled", "--trust"];
    case "inherit_native":
      return ["--trust"];
  }
}

async function detectVersion(abortSignal?: AbortSignal): Promise<string | null> {
  try {
    const r = await runCapture(BIN, ["--version"], {
      timeoutMs: 10_000,
      abortSignal,
      cancelSignal: "SIGTERM",
      cancelKillDelayMs: 0,
    });
    return r.stdout.trim() || `${BIN} (version unknown)`;
  } catch {
    return null;
  }
}

function cursorApiKey(env?: Record<string, string | null | undefined>): string | null {
  if (env && Object.prototype.hasOwnProperty.call(env, "CLAUDEXOR_CURSOR_API_KEY"))
    return env["CLAUDEXOR_CURSOR_API_KEY"] || null;
  if (env && Object.prototype.hasOwnProperty.call(env, "CURSOR_API_KEY"))
    return env["CURSOR_API_KEY"] || null;
  return (
    process.env.CLAUDEXOR_CURSOR_API_KEY ||
    resolveSecret("cursor") ||
    process.env.CURSOR_API_KEY ||
    null
  );
}

type CursorApiSmokeResult = { ok: boolean; detail: string };
type CursorApiSmokeCacheEntry = { result: CursorApiSmokeResult; expiresAtMs: number };
type CursorApiSmokeOptions = {
  makeBaseDir?: () => string;
  runCapture?: typeof runCapture;
  cleanupBase?: typeof cleanupCursorSmokeBase;
};
type CursorRuntimeDeps = {
  detectVersion: typeof detectVersion;
  nativeAuthOk: typeof probeCursorNativeAuth;
  cursorApiKey: typeof cursorApiKey;
  listCursorModels: typeof listCursorModels;
  smokeIsolatedApiKey: typeof smokeIsolatedApiKey;
  apiSmokeCache: Map<string, CursorApiSmokeCacheEntry>;
  apiSmokeCacheTtlMs: number;
  apiSmokeFailureCacheTtlMs: number;
  nowMs: () => number;
  runCliHarness: typeof runCliHarnessDefault;
};

function isCursorModelId(id: string): boolean {
  if (!id) return false;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(id)) return false;
  for (const ch of id) {
    if (
      (ch >= "a" && ch <= "z") ||
      (ch >= "A" && ch <= "Z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "-" ||
      ch === "." ||
      ch === "_" ||
      ch === "/" ||
      ch === ":"
    )
      continue;
    return false;
  }
  return true;
}

export function parseCursorModelList(text: string): HarnessModel[] {
  const out: HarnessModel[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.replaceAll("\r", "").split("\n")) {
    const line = rawLine.trim();
    if (!line || line === "Available models" || line.startsWith("Tip:")) continue;
    const sep = line.indexOf(" - ");
    if (sep <= 0) continue;
    const id = line.slice(0, sep).trim();
    const label = line.slice(sep + 3).trim() || null;
    if (!isCursorModelId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label, context_window: null });
  }
  return out;
}

export function cursorApiSmokeFinalText(stdout: string): string | null {
  const replies: string[] = [];
  for (const rawLine of stdout.replaceAll("\r", "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const record = obj as Record<string, unknown>;
    if (record["type"] === "assistant") {
      const message = record["message"];
      const content =
        message && typeof message === "object"
          ? (message as Record<string, unknown>)["content"]
          : undefined;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const text = (block as Record<string, unknown>)["text"];
        if (typeof text === "string" && text.trim()) replies.push(text);
      }
    } else if (record["type"] === "result") {
      const result = record["result"];
      if (typeof result === "string" && result.trim()) replies.push(result);
    }
  }
  return replies.at(-1)?.trim() ?? null;
}

export function cursorApiSmokeUsedEnvKey(stdout: string): boolean {
  for (const rawLine of stdout.replaceAll("\r", "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const record = obj as Record<string, unknown>;
    if (record["type"] === "system" && record["apiKeySource"] === "env") return true;
  }
  return false;
}

export function cursorApiSmokePassed(code: number | null, stdout: string): boolean {
  return code === 0 && cursorApiSmokeUsedEnvKey(stdout) && cursorApiSmokeFinalText(stdout) === "OK";
}

export async function cleanupCursorSmokeBase(
  base: string,
  opts: {
    remove?: (path: string) => void;
    sleepMs?: (ms: number) => Promise<void>;
    retries?: number;
  } = {},
): Promise<void> {
  const remove = opts.remove ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
  const sleepMs =
    opts.sleepMs ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt += 1) {
    try {
      remove(base);
      return;
    } catch {
      if (attempt >= retries) return;
      await sleepMs(25 * (attempt + 1));
    }
  }
}

function bridgeMacLoginKeychain(home: string): void {
  if (process.platform !== "darwin") return;
  const realHome = process.env.HOME;
  if (!realHome || realHome === home) return;
  const source = join(realHome, "Library", "Keychains");
  if (!existsSync(source)) return;
  const targetParent = join(home, "Library");
  const target = join(targetParent, "Keychains");
  if (existsSync(target)) return;
  try {
    mkdirSync(targetParent, { recursive: true, mode: 0o700 });
    symlinkSync(source, target, "dir");
  } catch {
    // The smoke will fail honestly if the OS credential bridge cannot be created.
  }
}

export async function smokeIsolatedApiKey(
  key: string | null = cursorApiKey(),
  options: CursorApiSmokeOptions = {},
): Promise<CursorApiSmokeResult> {
  if (!key) return { ok: false, detail: "no Cursor API key" };
  const base = options.makeBaseDir?.() ?? mkdtempSync(join(tmpdir(), "claudexor-cursor-smoke-"));
  const home = join(base, "home");
  try {
    mkdirSync(join(home, ".config"), { recursive: true, mode: 0o700 });
    bridgeMacLoginKeychain(home);
    const env: Record<string, string | null> = {
      ...providerScrubEnv(),
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      CURSOR_API_KEY: key,
    };
    const r = await (options.runCapture ?? runCapture)(
      BIN,
      ["-p", "--output-format", "stream-json", "--mode", "plan", "--trust", "Reply exactly OK"],
      {
        env,
        timeoutMs: 45_000,
      },
    );
    const text = `${r.stdout}\n${r.stderr}`;
    if (cursorApiSmokePassed(r.code, r.stdout))
      return { ok: true, detail: "isolated cursor-agent API-key smoke passed" };
    return {
      ok: false,
      detail: `isolated cursor-agent API-key smoke failed (exit ${r.code ?? "signal"}): ${redactSecrets(text).trim().split("\n").slice(-3).join(" ").slice(0, 500)}`,
    };
  } catch (err) {
    return {
      ok: false,
      detail: `isolated cursor-agent API-key smoke failed (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`,
    };
  } finally {
    await (options.cleanupBase ?? cleanupCursorSmokeBase)(base);
  }
}

function cursorApiSmokeCacheKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

async function smokeCursorApiKey(
  deps: CursorRuntimeDeps,
  key: string,
  fresh = false,
): Promise<CursorApiSmokeResult> {
  const cacheKey = cursorApiSmokeCacheKey(key);
  const now = deps.nowMs();
  const cached = fresh ? undefined : deps.apiSmokeCache.get(cacheKey);
  if (cached && cached.expiresAtMs > now) return cached.result;
  if (cached) deps.apiSmokeCache.delete(cacheKey);
  const result = await deps.smokeIsolatedApiKey(key);
  const ttlMs = result.ok ? deps.apiSmokeCacheTtlMs : deps.apiSmokeFailureCacheTtlMs;
  if (!fresh && ttlMs > 0) deps.apiSmokeCache.set(cacheKey, { result, expiresAtMs: now + ttlMs });
  return result;
}

async function listCursorModels(
  env: Record<string, string | null | undefined> = { ...providerScrubEnv() },
): Promise<HarnessModel[]> {
  try {
    const r = await runCapture(BIN, ["--list-models"], { env, timeoutMs: 30_000 });
    if (r.code !== 0) return [];
    return parseCursorModelList(r.stdout);
  } catch {
    return [];
  }
}

function cursorBaseEnv(
  env?: Record<string, string | null | undefined>,
): Record<string, string | null | undefined> {
  return {
    ...(env ?? {}),
    ...providerScrubEnv(),
  };
}

function cursorNativeEnv(
  env?: Record<string, string | null | undefined>,
): Record<string, string | null | undefined> {
  return {
    ...cursorBaseEnv(env),
    CURSOR_API_KEY: null,
  };
}

function maybeBridgeScopedHome(env: Record<string, string | null | undefined>): void {
  const home = env["HOME"];
  if (home && needsScopedHomeKeychainBridge(CURSOR_CAPABILITY_PROFILE))
    bridgeMacLoginKeychain(home);
}

async function resolveCursorAuthRoute(
  deps: CursorRuntimeDeps,
  input: { env?: Record<string, string | null | undefined>; authPreference?: AuthPreference; fresh?: boolean; abortSignal?: AbortSignal },
): Promise<{
  route: CursorAuthRoute;
  env: Record<string, string | null | undefined>;
  key: string | null;
  nativeAuthed: boolean;
  nativeProbeError: string | null;
  apiSmoke: CursorApiSmokeResult;
  scopedHome: boolean;
}> {
  const env = cursorBaseEnv(input.env);
  const scopedHome = Boolean(input.env?.["HOME"]);
  if (scopedHome) maybeBridgeScopedHome(env);
  const authPreference = input.authPreference ?? "auto";
  const key = authPreference === "subscription" ? null : deps.cursorApiKey(input.env);
  const nativeProbe = authPreference === "api_key"
    ? { authed: false, probeError: null }
    : await deps.nativeAuthOk(env, input.abortSignal);
  const nativeAuthed = nativeProbe.authed;
  const shouldSmokeApiKey = shouldSmokeCursorApiKey({
    hasKey: Boolean(key),
    authPreference,
    nativeAuthed,
    nativeProbeError: nativeProbe.probeError,
  });
  const apiSmoke =
    shouldSmokeApiKey && key
      ? await smokeCursorApiKey(deps, key, input.fresh === true)
      : {
          ok: false,
          detail: key
            ? "Cursor API-key smoke not required for selected route"
            : "no Cursor API key",
        };
  const route = selectCursorAuthRoute({
    authPreference,
    hasKey: Boolean(key),
    apiKeyReady: apiSmoke.ok,
    nativeAuthed,
    scopedHome,
  });
  return { route, env, key, nativeAuthed, nativeProbeError: nativeProbe.probeError, apiSmoke, scopedHome };
}

async function listCursorModelsFromReadyRoute(
  deps: CursorRuntimeDeps,
  spec?: DoctorSpec,
): Promise<HarnessModel[]> {
  const catalogOnly = () => {
    const key = deps.cursorApiKey(spec?.env);
    return deps.listCursorModels({
      ...providerScrubEnv(),
      CURSOR_API_KEY: key ?? null,
    });
  };
  if (spec?.env || spec?.authPreference || spec?.fresh) {
    const authPreference = spec.authPreference ?? "auto";
    const resolved = await resolveCursorAuthRoute(deps, {
      env: spec.env,
      authPreference,
      fresh: spec?.fresh,
      abortSignal: spec?.abortSignal,
    });
    if (resolved.route === "local_session") {
      const models = await deps.listCursorModels({ ...resolved.env, CURSOR_API_KEY: null });
      if (models.length > 0) return models;
      if (authPreference === "subscription") return [];
    }
    if (resolved.route === "api_key" && resolved.key) {
      const models = await deps.listCursorModels({ ...resolved.env, CURSOR_API_KEY: resolved.key });
      if (models.length > 0) return models;
    }
    return [];
  }
  const nativeEnv = cursorNativeEnv();
  const nativeProbe = await deps.nativeAuthOk(nativeEnv, spec?.abortSignal);
  if (nativeProbe.authed) {
    const nativeModels = await deps.listCursorModels(nativeEnv);
    if (nativeModels.length > 0) return nativeModels;
  }
  if (nativeProbe.probeError) return [];
  const key = deps.cursorApiKey();
  if (!key) return catalogOnly();
  const apiSmoke = await smokeCursorApiKey(deps, key, spec?.fresh === true);
  if (apiSmoke.ok) {
    const models = await deps.listCursorModels({ ...providerScrubEnv(), CURSOR_API_KEY: key });
    if (models.length > 0) return models;
  }
  return catalogOnly();
}

export function createCursorAdapter(deps: Partial<CursorRuntimeDeps> = {}): HarnessAdapter {
  const runtime: CursorRuntimeDeps = {
    detectVersion,
    nativeAuthOk: probeCursorNativeAuth,
    cursorApiKey,
    listCursorModels,
    smokeIsolatedApiKey,
    apiSmokeCache: new Map(),
    apiSmokeCacheTtlMs: CURSOR_API_SMOKE_CACHE_TTL_MS,
    apiSmokeFailureCacheTtlMs: CURSOR_API_SMOKE_FAILURE_CACHE_TTL_MS,
    nowMs: () => Date.now(),
    runCliHarness: runCliHarnessDefault,
    ...deps,
  };
  return {
    id: "cursor",

    async discover(): Promise<HarnessManifest> {
      const version = await runtime.detectVersion();
      if (version === null) {
        throw new HarnessUnavailableError(
          "cursor-agent not found on PATH (set CLAUDEXOR_CURSOR_BIN)",
        );
      }
      const nativeProbe = await runtime.nativeAuthOk(cursorNativeEnv());
      const nativeAuthed = nativeProbe.authed;
      const apiKey = runtime.cursorApiKey() !== null;
      return HarnessManifestSchema.parse({
        id: "cursor",
        display_name: "Cursor CLI",
        kind: "local_cli",
        version,
        adapter_version: CLAUDEXOR_VERSION,
        provider_family: "cursor",
        capabilities: {
          plan: true,
          implement: true,
          create_from_scratch: true,
          review: true,
          verify: true,
          synthesize: true,
          read_files: true,
          // No browser-MCP injection path exists for cursor-agent yet —
          // honest false until that path exists + is verified.
          browser_tool: false,
          web_policy: "uncontrolled",
          // cursor-agent exposes no reasoning-effort flag -> effort is not tunable.
          effort_levels: [],
        },
        capability_profile: {
          ...CURSOR_CAPABILITY_PROFILE,
          auth: {
            ...CURSOR_CAPABILITY_PROFILE.auth,
            // Native-first is invariant across host and scoped environments;
            // a key becomes auto fallback only after native is unavailable.
            preferred_source: nativeAuthed ? "native_session" : apiKey ? "api_key_env" : null,
          },
        },
        // Source AVAILABILITY truth: each mode is listed only when its source
        // actually exists right now (a native session does not imply a key).
        auth_modes: [
          ...(nativeAuthed ? ["local_session" as const] : []),
          ...(apiKey ? ["api_key" as const] : []),
        ],
        access_profiles_supported: ["readonly", "workspace_write", "inherit_native"],
      });
    },

    async doctor(_spec: DoctorSpec): Promise<ConformanceReport> {
      const version = await runtime.detectVersion(_spec.abortSignal);
      if (version === null) {
        return ConformanceReportSchema.parse({
          harness_id: "cursor",
          status: "unavailable",
          checks: [{ id: "installed", status: "fail", detail: "cursor-agent not found" }],
          reasons: ["cursor-agent not found (install Cursor CLI or set CLAUDEXOR_CURSOR_BIN)"],
        });
      }
      const requestedSource = _spec.authSource;
      const probeNative = requestedSource === undefined || requestedSource === "native_session";
      const probeApi = requestedSource === undefined || requestedSource === "api_key_env";
      const env = cursorNativeEnv(_spec.env);
      const scopedHome = Boolean(_spec.env?.["HOME"]);
      const authPreference = requestedSource === "native_session"
        ? "subscription"
        : requestedSource === "api_key_env"
          ? "api_key"
          : _spec.authPreference ?? "auto";
      if (probeNative && scopedHome) maybeBridgeScopedHome(env);
      const nativeProbe: CursorNativeAuthProbe = probeNative
        ? await runtime.nativeAuthOk(env, _spec.abortSignal)
        : { authed: false, probeError: null };
      const nativeAuthed = nativeProbe.authed;
      const key = probeApi ? runtime.cursorApiKey(_spec.env) : null;
      const apiKey = key !== null;
      const shouldSmokeApiKey = shouldSmokeCursorApiKey({
        hasKey: apiKey,
        authPreference,
        nativeAuthed,
        nativeProbeError: nativeProbe.probeError,
      });
      const apiSmoke =
        key && shouldSmokeApiKey
          ? await smokeCursorApiKey(runtime, key, _spec.fresh === true)
          : {
              ok: false,
              detail: key
                ? "Cursor API-key smoke not required for selected route"
                : "no Cursor API key",
            };
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
      ];
      const allIntents = [
        ...routeableIntents,
        "orchestrate",
      ];
      const route = selectCursorAuthRoute({
        authPreference,
        hasKey: apiKey,
        apiKeyReady: apiSmoke.ok,
        nativeAuthed,
        scopedHome,
      });
      const enabled = route === "unavailable" ? [] : routeableIntents;
      const ok = route !== "unavailable";
      const selectedAvailable = authPreference === "subscription"
        ? nativeAuthed
        : authPreference === "api_key"
          ? apiKey
          : nativeAuthed || apiKey;
      const probeUnknown = authPreference !== "api_key" && nativeProbe.probeError !== null;
      const nativeSource: AuthSourceReadiness = nativeProbe.probeError
        ? {
            source: "native_session",
            availability: "unknown",
            verification: "not_run",
            detail: `Cursor status probe failed: ${nativeProbe.probeError}`,
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
              detail: "native Cursor session is not authenticated",
            };
      const apiSource: AuthSourceReadiness = {
        source: "api_key_env",
        availability: apiKey ? "available" : "unavailable",
        verification: apiSmoke.ok ? "passed" : shouldSmokeApiKey ? "failed" : "not_run",
        detail: apiSmoke.detail,
      };
      const authSources: AuthSourceReadiness[] = requestedSource === "native_session"
        ? [nativeSource]
        : requestedSource === "api_key_env"
          ? [apiSource]
          : requestedSource !== undefined
            ? [{ source: requestedSource, availability: "unavailable", verification: "not_run", detail: `Cursor does not support ${requestedSource}` }]
            : [nativeSource, apiSource];
      return ConformanceReportSchema.parse({
        harness_id: "cursor",
        status: ok ? "ok" : selectedAvailable || probeUnknown ? "degraded" : "unavailable",
        checks: [
          { id: "installed", status: "pass", detail: version },
          ...(probeNative ? [{
            id: "auth",
            status: nativeAuthed ? "pass" : "fail",
            detail: nativeProbe.probeError ?? nativeSource.detail,
          }] : []),
          ...(probeApi ? [{
            id: "stored_key",
            status: apiKey ? "pass" : "fail",
            detail: apiKey
              ? "cursor secret/env available"
              : "no Cursor API-key fallback",
          },
          {
            id: "isolated_api_smoke",
            status: apiSmoke.ok ? "pass" : shouldSmokeApiKey ? "fail" : "skip",
            detail: apiSmoke.detail,
          }] : []),
        ],
        auth_sources: authSources,
        enabled_intents: enabled,
        disabled_intents: allIntents.filter((i) => !enabled.includes(i)),
        reasons: ok
          ? []
          : nativeProbe.probeError && authPreference !== "api_key"
            ? [`Cursor native-session probe failed: ${nativeProbe.probeError}`]
          : authPreference === "subscription"
            ? ["Cursor subscription route is not ready (run `cursor-agent login`)"]
            : authPreference === "api_key"
              ? [apiKey ? `cursor key present but route unproven: ${apiSmoke.detail}` : "Cursor API-key route is not configured"]
              : apiKey
                ? [`cursor key present but route unproven: ${apiSmoke.detail}`]
                : ["not authenticated (cursor-agent login or set CURSOR_API_KEY)"],
      });
    },

    run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runCursor(spec, runtime);
    },

    review(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runCursor(spec, runtime);
    },

    async models(spec?: DoctorSpec): Promise<HarnessModel[]> {
      return listCursorModelsFromReadyRoute(runtime, spec);
    },
  };
}

async function* runCursor(
  spec: HarnessRunSpec,
  deps: CursorRuntimeDeps,
): AsyncIterable<HarnessEvent> {
  if (spec.access === "full" || spec.access === "external_sandbox_full") {
    yield {
      type: "error",
      session_id: spec.session_id,
      ts: nowIso(),
      error: "cursor full access is not conformance-proven; use workspace_write or another harness",
    };
    yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
    return;
  }
  const args = ["-p", "--output-format", "stream-json", ...accessArgs(spec.access)];
  if (spec.model_hint) args.push("--model", spec.model_hint);
  // Resume the thread's native cursor chat as a follow-up turn.
  if (spec.resume_session_id) args.push("--resume", spec.resume_session_id);
  args.push(spec.prompt);
  const { route, env, key, nativeAuthed, scopedHome } = await resolveCursorAuthRoute(deps, {
    env: spec.env,
    authPreference: spec.auth_preference,
    abortSignal: abortSignalFromSpec(spec),
  });
  if (route === "api_key" && key) {
    env.CURSOR_API_KEY = key;
    if (
      shouldDiscloseCursorAutoApiRoute({
        authPreference: spec.auth_preference,
        route,
        nativeAuthed,
      })
    ) {
      yield {
        type: "message",
        session_id: spec.session_id,
        ts: nowIso(),
        payload: {
          auth_switched: true,
          from_auth_mode: "local_session",
          to_auth_mode: "api_key",
          reason: "readiness_preferred",
        },
      };
    }
  } else if (route === "local_session") {
    env.CURSOR_API_KEY = null;
  } else {
    yield {
      type: "error",
      session_id: spec.session_id,
      ts: nowIso(),
      error: scopedHome
        ? "scoped Cursor HOME requires either a bridged native session or a smoke-proven Cursor API key fallback"
        : "Cursor requires either a native session or a smoke-proven Cursor API key fallback",
    };
    yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
    return;
  }

  yield* deps.runCliHarness({
    bin: BIN,
    args,
    spec,
    env,
    label: "cursor-agent",
    redact: redactSecrets,
    parseEvent: createCursorParser(
      route === "local_session" ? "vendor_native" : "managed_api_key",
      route === "local_session" ? "native_session" : "api_key_env",
    ),
  });
}
