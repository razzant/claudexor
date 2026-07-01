import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AccessProfile,
  AuthPreference,
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
  HarnessUnavailableError,
  needsScopedHomeKeychainBridge,
  providerScrubEnv,
  runCapture,
  runCliHarness as runCliHarnessDefault,
} from "@claudexor/core";
import { resolveSecret } from "@claudexor/secrets";
import { CLAUDEXOR_VERSION, nowIso, redactSecrets } from "@claudexor/util";
import { createCursorParser } from "./parse.js";

const BIN = process.env.CLAUDEXOR_CURSOR_BIN || "cursor-agent";
// Long enough for one sequential reviewer panel pass; still bounded so revoked
// keys do not remain smoke-proven for a whole daemon lifetime.
const CURSOR_API_SMOKE_CACHE_TTL_MS = 60 * 60_000;
const CURSOR_API_SMOKE_FAILURE_CACHE_TTL_MS = 30_000;

const CURSOR_CAPABILITY_PROFILE: HarnessCapabilityProfile = HarnessCapabilityProfileSchema.parse({
  execution_surfaces: [
    { kind: "cli_one_shot", input: "prompt_arg", output: "ndjson", event_schema: "native" },
  ],
  session: { native_session_id_emitted: true, resume_latest: true, resume_by_id: true },
  output: {
    ndjson_events: true,
    tool_lifecycle: true,
    file_changes: true,
    final_json: false,
    json_schema_final: false,
    usage_signal: "observed",
    cost_signal: "observed",
  },
  auth: {
    supported_sources: ["native_session", "api_key_env"],
    preferred_source: null,
    probe_command: ["cursor-agent", "status"],
    env_vars: ["CURSOR_API_KEY"],
    credential_transports: [
      {
        source: "native_session",
        kind: "os_keychain",
        relocatable_by: ["HOME"],
        requires_user_session: false,
        bypass_env_vars: [],
      },
      {
        source: "api_key_env",
        kind: "env_var",
        relocatable_by: ["ENV"],
        requires_user_session: false,
        bypass_env_vars: ["CURSOR_API_KEY"],
      },
    ],
  },
  access_control: {
    readonly: true,
    workspace_write: true,
    full: false,
    mechanism: "cursor-agent --sandbox enabled",
    readonly_mechanism: "fs_sandbox",
  },
  isolation: {
    path_redirect_sufficient: false,
    requires_user_session: false,
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

async function detectVersion(): Promise<string | null> {
  try {
    const r = await runCapture(BIN, ["--version"], { timeoutMs: 10_000 });
    return r.stdout.trim() || `${BIN} (version unknown)`;
  } catch {
    return null;
  }
}

async function nativeAuthOk(env?: Record<string, string | null | undefined>): Promise<boolean> {
  try {
    const r = await runCapture(BIN, ["status"], { env, timeoutMs: 10_000 });
    return cursorStatusAuthenticated(r.code, `${r.stdout}\n${r.stderr}`);
  } catch {
    return false;
  }
}

export function cursorStatusAuthenticated(code: number | null, text: string): boolean {
  if (code !== 0) return false;
  const normalized = text.toLowerCase();
  if (normalized.includes("not logged in") || normalized.includes("authentication required"))
    return false;
  return (
    normalized.includes("logged in") ||
    normalized.includes("authenticated") ||
    normalized.includes("account")
  );
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

type CursorAuthRoute = "api_key" | "local_session" | "unavailable";
type CursorApiSmokeResult = { ok: boolean; detail: string };
type CursorApiSmokeCacheEntry = { result: CursorApiSmokeResult; expiresAtMs: number };
type CursorApiSmokeOptions = {
  makeBaseDir?: () => string;
  runCapture?: typeof runCapture;
  cleanupBase?: typeof cleanupCursorSmokeBase;
};
type CursorRuntimeDeps = {
  detectVersion: typeof detectVersion;
  nativeAuthOk: typeof nativeAuthOk;
  cursorApiKey: typeof cursorApiKey;
  listCursorModels: typeof listCursorModels;
  smokeIsolatedApiKey: typeof smokeIsolatedApiKey;
  apiSmokeCache: Map<string, CursorApiSmokeCacheEntry>;
  apiSmokeCacheTtlMs: number;
  apiSmokeFailureCacheTtlMs: number;
  nowMs: () => number;
  runCliHarness: typeof runCliHarnessDefault;
};

export function selectCursorAuthRoute(input: {
  authPreference: AuthPreference;
  hasKey: boolean;
  apiKeyReady: boolean;
  nativeAuthed: boolean;
  scopedHome: boolean;
}): CursorAuthRoute {
  const keyRouteReady = input.hasKey && input.apiKeyReady;
  if (input.authPreference === "api_key") {
    if (keyRouteReady) return "api_key";
    if (input.nativeAuthed) return "local_session";
    return "unavailable";
  }
  if (input.authPreference === "subscription") {
    if (input.nativeAuthed) return "local_session";
    return "unavailable";
  }
  if (input.scopedHome && keyRouteReady) return "api_key";
  if (input.nativeAuthed) return "local_session";
  if (keyRouteReady) return "api_key";
  return "unavailable";
}

export function shouldDiscloseCursorAutoApiRoute(input: {
  authPreference: AuthPreference;
  route: CursorAuthRoute;
  nativeAuthed: boolean;
}): boolean {
  return input.authPreference === "auto" && input.route === "api_key" && input.nativeAuthed;
}

function shouldSmokeCursorApiKey(input: {
  hasKey: boolean;
  authPreference: AuthPreference;
  nativeAuthed: boolean;
  scopedHome: boolean;
}): boolean {
  if (!input.hasKey) return false;
  if (input.authPreference === "subscription") return false;
  if (input.authPreference === "api_key") return true;
  return !input.nativeAuthed || input.scopedHome;
}

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
): Promise<CursorApiSmokeResult> {
  const cacheKey = cursorApiSmokeCacheKey(key);
  const now = deps.nowMs();
  const cached = deps.apiSmokeCache.get(cacheKey);
  if (cached && cached.expiresAtMs > now) return cached.result;
  if (cached) deps.apiSmokeCache.delete(cacheKey);
  const result = await deps.smokeIsolatedApiKey(key);
  const ttlMs = result.ok ? deps.apiSmokeCacheTtlMs : deps.apiSmokeFailureCacheTtlMs;
  if (ttlMs > 0) deps.apiSmokeCache.set(cacheKey, { result, expiresAtMs: now + ttlMs });
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
  input: { env?: Record<string, string | null | undefined>; authPreference?: AuthPreference },
): Promise<{
  route: CursorAuthRoute;
  env: Record<string, string | null | undefined>;
  key: string | null;
  nativeAuthed: boolean;
  apiSmoke: CursorApiSmokeResult;
  scopedHome: boolean;
}> {
  const env = cursorBaseEnv(input.env);
  const scopedHome = Boolean(input.env?.["HOME"]);
  if (scopedHome) maybeBridgeScopedHome(env);
  const key = deps.cursorApiKey(input.env);
  const authPreference = input.authPreference ?? "auto";
  const nativeAuthed = await deps.nativeAuthOk(env);
  const shouldSmokeApiKey = shouldSmokeCursorApiKey({
    hasKey: Boolean(key),
    authPreference,
    nativeAuthed,
    scopedHome,
  });
  const apiSmoke =
    shouldSmokeApiKey && key
      ? await smokeCursorApiKey(deps, key)
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
  return { route, env, key, nativeAuthed, apiSmoke, scopedHome };
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
  if (spec?.env || spec?.authPreference) {
    const authPreference = spec.authPreference ?? "auto";
    const resolved = await resolveCursorAuthRoute(deps, {
      env: spec.env,
      authPreference,
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
  if (await deps.nativeAuthOk(nativeEnv)) {
    const nativeModels = await deps.listCursorModels(nativeEnv);
    if (nativeModels.length > 0) return nativeModels;
  }
  const key = deps.cursorApiKey();
  if (!key) return catalogOnly();
  const apiSmoke = await smokeCursorApiKey(deps, key);
  if (apiSmoke.ok) {
    const models = await deps.listCursorModels({ ...providerScrubEnv(), CURSOR_API_KEY: key });
    if (models.length > 0) return models;
  }
  return catalogOnly();
}

export function createCursorAdapter(deps: Partial<CursorRuntimeDeps> = {}): HarnessAdapter {
  const runtime: CursorRuntimeDeps = {
    detectVersion,
    nativeAuthOk,
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
      const nativeAuthed = await runtime.nativeAuthOk(cursorNativeEnv());
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
          spec: true,
          implement: true,
          create_from_scratch: true,
          repair: true,
          review: true,
          verify: true,
          compare: true,
          synthesize: true,
          shell: true,
          read_files: true,
          edit_files: true,
          apply_patch: true,
          structured_events: true,
          structured_output: true,
          json_schema_output: false,
          resume: true,
          cancel: false,
          mcp: true,
          // MCP-capable, but Claudexor has not wired a browser-MCP injector for
          // cursor-agent yet — honest false until that path exists + is verified.
          browser_tool: false,
          plugins: true,
          worktree_native: true,
          web_policy: "uncontrolled",
          // No real rate-limit detector for cursor yet (a detector waits on a
          // recorded rate-limited transcript) -> honest `unknown`, not `observed`.
          quota_signal: "unknown",
          usage_signal: "observed",
          // cursor-agent exposes no reasoning-effort flag -> effort is not tunable.
          effort_levels: [],
        },
        capability_profile: {
          ...CURSOR_CAPABILITY_PROFILE,
          auth: {
            ...CURSOR_CAPABILITY_PROFILE.auth,
            // Static source preference mirrors the normal non-scoped route.
            // Scoped/envelope runs may still choose a smoke-proven API key at
            // runtime because that decision depends on the run environment.
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
      const version = await runtime.detectVersion();
      if (version === null) {
        return ConformanceReportSchema.parse({
          harness_id: "cursor",
          status: "unavailable",
          checks: [{ id: "installed", status: "fail", detail: "cursor-agent not found" }],
          reasons: ["cursor-agent not found (install Cursor CLI or set CLAUDEXOR_CURSOR_BIN)"],
        });
      }
      const env = cursorNativeEnv(_spec.env);
      const scopedHome = Boolean(_spec.env?.["HOME"]);
      const authPreference = _spec.authPreference ?? "auto";
      if (scopedHome) maybeBridgeScopedHome(env);
      const nativeAuthed = await runtime.nativeAuthOk(env);
      const key = runtime.cursorApiKey(_spec.env);
      const apiKey = key !== null;
      const shouldSmokeApiKey = shouldSmokeCursorApiKey({
        hasKey: apiKey,
        authPreference,
        nativeAuthed,
        scopedHome,
      });
      const apiSmoke =
        key && shouldSmokeApiKey
          ? await smokeCursorApiKey(runtime, key)
          : {
              ok: false,
              detail: key
                ? "Cursor API-key smoke not required for selected route"
                : "no Cursor API key",
            };
      // Readiness doctrine: a key string alone is source availability, not
      // proven readiness. Native auth proves read-only/session reuse; an isolated
      // API-key smoke proves envelope/write routes.
      const routeableIntents = [
        "plan",
        "spec",
        "implement",
        "repair",
        "create_from_scratch",
        "review",
        "verify",
        "compare",
        "synthesize",
        "explain",
        "audit",
      ];
      const allIntents = [
        ...routeableIntents,
        "arbitrate",
        "orchestrate",
      ];
      // Write-class intents run in isolated envelopes with a scoped HOME where
      // the native cursor session is unreachable — they REQUIRE the key
      // fallback. Native-only auth honestly enables only the non-envelope
      // (read-only) intents so doctor-ok can never precede a guaranteed run
      // failure (readiness/routing contract).
      const readOnlyIntents = [
        "plan",
        "spec",
        "review",
        "verify",
        "compare",
        "synthesize",
        "explain",
        "audit",
      ];
      const route = selectCursorAuthRoute({
        authPreference,
        hasKey: apiKey,
        apiKeyReady: apiSmoke.ok,
        nativeAuthed,
        scopedHome,
      });
      const enabled =
        route === "api_key" ? routeableIntents : route === "local_session" ? readOnlyIntents : [];
      const ok = route !== "unavailable";
      return ConformanceReportSchema.parse({
        harness_id: "cursor",
        status: ok ? "ok" : apiKey ? "degraded" : "unavailable",
        checks: [
          { id: "installed", status: "pass", detail: version },
          { id: "auth", status: nativeAuthed ? "pass" : "fail" },
          {
            id: "stored_key",
            status: apiKey ? "pass" : "fail",
            detail: apiKey
              ? "cursor secret/env available"
              : "no cursor key fallback (write/envelope intents disabled)",
          },
          {
            id: "isolated_api_smoke",
            status: apiSmoke.ok ? "pass" : apiKey ? "fail" : "skip",
            detail: apiSmoke.detail,
          },
        ],
        enabled_intents: enabled,
        disabled_intents: allIntents.filter((i) => !enabled.includes(i)),
        reasons: ok
          ? apiSmoke.ok
            ? []
            : [
                "native session only: isolated envelope (write) intents need a passing Cursor API-key smoke",
              ]
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
  });
  const preferApi = spec.auth_preference === "api_key";
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
    if (preferApi) {
      yield {
        type: "message",
        session_id: spec.session_id,
        ts: nowIso(),
        payload: {
          auth_switched: true,
          from_auth_mode: "api_key",
          to_auth_mode: "local_session",
          reason: "auth_unavailable",
        },
      };
    }
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
    parseEvent: createCursorParser(),
  });
}
