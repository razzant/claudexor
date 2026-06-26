import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AccessProfile, ConformanceReport, EffortHint, HarnessEvent, HarnessManifest, HarnessRunSpec } from "@claudexor/schema";
import { ConformanceReport as ConformanceReportSchema, HarnessManifest as HarnessManifestSchema } from "@claudexor/schema";
import type { DoctorSpec, HarnessAdapter } from "@claudexor/core";
import { HarnessUnavailableError, normalizeEffort, playwrightMcpArgs, providerScrubEnv, resolveNpxBin, runCapture, runCliHarness } from "@claudexor/core";
import { resolveSecret } from "@claudexor/secrets";
import { CLAUDEXOR_VERSION, nowIso, redactSecrets } from "@claudexor/util";
import { parseCodexEvent } from "./parse.js";
import { estimateCodexCostUsd } from "./pricing.js";

const BIN = process.env.CLAUDEXOR_CODEX_BIN || "codex";

/**
 * Ordered (weakest→strongest) reasoning-effort levels codex's
 * `model_reasoning_effort` config accepts. SINGLE source: the manifest's
 * `effort_levels` and the run-time normalizer both read this. The cross-harness
 * `max` hint clamps to `xhigh` (the ceiling) via the shared normalizer.
 */
const CODEX_EFFORT_LEVELS: readonly EffortHint[] = ["low", "medium", "high", "xhigh"];

/**
 * Resolve an OpenAI API key for codex from the environment. Claudexor-managed
 * `api_key` auth mirrors the harness's own variable (`OPENAI_API_KEY`); a
 * dedicated `CLAUDEXOR_CODEX_API_KEY` can override it for multi-key setups.
 */
function codexApiKey(): string | undefined {
  const stored = process.env.CLAUDEXOR_DISABLE_STORED_SECRETS === "1" ? null : resolveSecret("openai");
  return process.env.CLAUDEXOR_CODEX_API_KEY || process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || stored || undefined;
}

/**
 * Seed `api_key` auth into an isolated CODEX_HOME. Codex does not read
 * `OPENAI_API_KEY` from the environment when run against an empty config dir
 * (it requires `auth.json`), so an envelope-scoped CODEX_HOME would otherwise
 * fail with 401 even though a key is available. We write the same file
 * `codex login --with-api-key` produces. No-op when not isolated (use codex's
 * native auth), when no key is available, or when auth already exists.
 */
export function ensureCodexApiAuth(env?: Record<string, string>, allowApiKey = true): void {
  if (!allowApiKey) return;
  const home = env?.["CODEX_HOME"];
  if (!home) return;
  const apiKey = codexApiKey();
  if (!apiKey) return;
  const authPath = join(home, "auth.json");
  if (existsSync(authPath)) return;
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(authPath, JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: apiKey }) + "\n", { mode: 0o600 });
  } catch {
    /* best-effort: codex will surface an auth error if this did not take */
  }
}

/** The user's real codex home (native ChatGPT/subscription session lives here). */
export function defaultNativeCodexHome(): string {
  const override = process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
  if (override && override.trim()) return override;
  return join(homedir(), ".codex");
}

/**
 * Seed the user's NATIVE codex session (`auth.json`, ChatGPT/subscription mode)
 * into an isolated CODEX_HOME so a Max/Pro subscriber with NO API key can run
 * inside a Claudexor envelope. This is the "subscription-first must actually
 * work" fix: previously the scoped empty CODEX_HOME hid the native session and
 * the run failed demanding an API key.
 *
 * Copies ONLY if the scoped auth is absent and a native `auth.json` exists; never
 * overwrites (codex refreshes the token in place). Returns true when scoped auth
 * is present afterwards. No-op when not isolated or no native session exists.
 */
export function ensureCodexNativeAuth(
  env?: Record<string, string>,
  nativeHome: string = defaultNativeCodexHome(),
): boolean {
  const home = env?.["CODEX_HOME"];
  if (!home) return false;
  const dest = join(home, "auth.json");
  if (existsSync(dest)) return true; // already seeded (api or native)
  const src = join(nativeHome, "auth.json");
  if (!existsSync(src)) return false;
  try {
    mkdirSync(home, { recursive: true });
    copyFileSync(src, dest);
    try {
      chmodSync(dest, 0o600);
    } catch {
      /* best-effort: perms */
    }
    return existsSync(dest);
  } catch {
    return false;
  }
}

/** True when a native codex session exists and can be seeded into an envelope. */
function nativeCodexSeedable(): boolean {
  return existsSync(join(defaultNativeCodexHome(), "auth.json"));
}

function sandboxArgs(access: AccessProfile): string[] {
  switch (access) {
    case "readonly":
      return ["--sandbox", "read-only"];
    case "workspace_write":
      return ["--sandbox", "workspace-write"];
    case "full":
    case "external_sandbox_full":
      return ["--sandbox", "danger-full-access"];
    case "inherit_native":
      return [];
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

async function loggedIn(): Promise<boolean> {
  try {
    const r = await runCapture(BIN, ["login", "status"], { timeoutMs: 10_000 });
    return r.code === 0;
  } catch {
    return false;
  }
}

function hasApiKey(): boolean {
  return Boolean(codexApiKey());
}

function hasScopedCodexAuth(env?: Record<string, string>): boolean {
  const home = env?.["CODEX_HOME"];
  return Boolean(home && existsSync(join(home, "auth.json")));
}

async function smokeIsolatedApiKey(): Promise<{ ok: boolean; detail: string }> {
  if (!codexApiKey()) return { ok: false, detail: "no API key fallback available" };
  const dir = mkdtempSync(join(tmpdir(), "claudexor-codex-smoke-"));
  const codexHome = join(dir, ".codex");
  try {
    ensureCodexApiAuth({ CODEX_HOME: codexHome });
    const r = await runCapture(
      BIN,
      ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "Reply exactly OK"],
      {
        cwd: dir,
        env: {
          HOME: dir,
          XDG_CONFIG_HOME: join(dir, ".config"),
          CODEX_HOME: codexHome,
          OPENAI_API_KEY: null,
          CODEX_API_KEY: null,
          CLAUDEXOR_CODEX_API_KEY: null,
        },
        timeoutMs: 25_000,
      },
    );
    const text = `${r.stdout}\n${r.stderr}`;
    if (r.code === 0 && text.includes("\"turn.completed\"") && text.includes("OK")) {
      return { ok: true, detail: "isolated CODEX_HOME smoke passed" };
    }
    return { ok: false, detail: redactCodexDoctorDetail(text || `codex exited with code ${r.code}`) };
  } catch (err) {
    return { ok: false, detail: redactCodexDoctorDetail(err instanceof Error ? err.message : String(err)) };
  } finally {
    // codex can still be flushing session files into CODEX_HOME when the smoke
    // returns. Cleanup is best-effort: a leaked OS tmp dir must never decide
    // doctor/readiness truth (the smoke verdict is the codex run itself).
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* OS tmp reaper owns the leftovers */
    }
  }
}

function redactCodexDoctorDetail(text: string): string {
  return redactSecrets(text).slice(0, 500);
}

/** Codex forwards images via `-i/--image <FILE>` (repeatable; file path only —
 *  it rejects remote URLs). Non-image attachments have no native codex surface. */
function codexImageArgs(attachments: HarnessRunSpec["attachments"] | undefined): string[] {
  const out: string[] = [];
  for (const a of attachments ?? []) {
    if (a.kind === "image") out.push("-i", a.path);
  }
  return out;
}

/**
 * Inject the Playwright browser MCP as stateless `-c mcp_servers.browser.*`
 * config overrides (live-verified: codex accepts array-valued `-c` overrides and
 * surfaces the tools as `mcp_tool_call` events the parser already maps). Stateless
 * means NO scoped config.toml write — the user's `~/.codex/config.toml` is never
 * touched. Empty when no browser this run.
 */
export function codexBrowserArgs(browser: HarnessRunSpec["browser"]): string[] {
  if (!browser) return [];
  return [
    "-c",
    `mcp_servers.browser.command=${JSON.stringify(resolveNpxBin())}`,
    "-c",
    `mcp_servers.browser.args=${JSON.stringify(playwrightMcpArgs(browser))}`,
    "-c",
    "mcp_servers.browser.startup_timeout_sec=90",
    "-c",
    "mcp_servers.browser.tool_timeout_sec=120",
  ];
}

/**
 * True only when the config codex WILL load (the scoped `CODEX_HOME` if set,
 * else `~/.codex`) actually defines `[mcp_servers.node_repl]`. We only ever
 * disable node_repl when it already exists — a `-c mcp_servers.node_repl.*`
 * override against a config that has NO node_repl creates a partial entry with
 * no transport and codex refuses to load it ("invalid transport in
 * mcp_servers.node_repl"), which broke every scoped-home / api_key / MCP run.
 */
export function codexConfigHasNodeRepl(codexHome: string | null | undefined): boolean {
  const cfg = join(codexHome || defaultNativeCodexHome(), "config.toml");
  try {
    return existsSync(cfg) && readFileSync(cfg, "utf8").includes("[mcp_servers.node_repl]");
  } catch {
    return false;
  }
}

export function codexExecArgs(
  spec: Pick<HarnessRunSpec, "access" | "model_hint" | "effort_hint" | "external_context_policy" | "prompt" | "attachments" | "browser"> & {
    resume_session_id?: string | null;
  },
  opts: { suppressNodeRepl?: boolean } = {},
): string[] {
  // Codex.app's inherited `node_repl` MCP (its in-app-browser controller) can't
  // run in headless `codex exec` and fails every call → it used to flip an
  // otherwise-clean run to "errored". Disable it — but ONLY when it is actually
  // present in the loaded config (codexConfigHasNodeRepl), never unconditionally
  // (that is what created the invalid partial entry above).
  const nodeReplArgs = opts.suppressNodeRepl ? ["-c", "mcp_servers.node_repl.enabled=false"] : [];
  // Resume a native codex session as a follow-up turn (`codex exec resume <id>`),
  // so a thread's later moves continue the same conversation instead of restarting.
  // LIVE-VERIFIED (codex 0.137): the resume subcommand does NOT accept --sandbox;
  // sandboxing must ride as `-c sandbox_mode="..."` config overrides there.
  // Clamp the requested effort onto codex's supported ladder via the shared
  // normalizer (single source: CODEX_EFFORT_LEVELS). Null = not requested OR
  // effort not tunable -> pass no flag.
  const effort = normalizeEffort(spec.effort_hint, CODEX_EFFORT_LEVELS);
  if (spec.resume_session_id) {
    const args = ["exec", "resume", spec.resume_session_id, "--json", ...sandboxConfigArgs(spec.access), "--skip-git-repo-check"];
    if (spec.model_hint) args.push("-m", spec.model_hint);
    if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
    args.push(...codexWebArgs(spec.external_context_policy ?? "auto"));
    // ALL `-c` config overrides go BEFORE `-i` so the variadic `-i/--image
    // <FILE>...` can't swallow them as image paths; then images, then `--` so the
    // positional prompt survives, then the prompt.
    args.push(...codexBrowserArgs(spec.browser));
    args.push(...nodeReplArgs);
    const imageArgs = codexImageArgs(spec.attachments);
    args.push(...imageArgs);
    // `codex exec -i/--image <FILE>...` is VARIADIC, so a positional prompt placed
    // right after it is swallowed as another "image" — the model then receives no
    // prompt and never sees the attachment (the v0.13 "I don't see the image" bug).
    // LIVE-VERIFIED on codex 0.142: `-i <path> -- "<prompt>"` => image IS described.
    if (imageArgs.length > 0) args.push("--");
    args.push(spec.prompt);
    return args;
  }
  const args = ["exec", "--json", ...sandboxArgs(spec.access), "--skip-git-repo-check"];
  if (spec.model_hint) args.push("-m", spec.model_hint);
  if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
  args.push(...codexWebArgs(spec.external_context_policy ?? "auto"));
  // ALL `-c` config overrides BEFORE `-i` (variadic) so they can't be eaten as
  // image paths; then images, then `--`, then the prompt. See resume branch.
  args.push(...codexBrowserArgs(spec.browser));
  args.push(...nodeReplArgs);
  const imageArgs = codexImageArgs(spec.attachments);
  args.push(...imageArgs);
  if (imageArgs.length > 0) args.push("--");
  args.push(spec.prompt);
  return args;
}

/** Sandbox as `-c sandbox_mode=...` config (the only spelling `exec resume` accepts). */
function sandboxConfigArgs(access: AccessProfile): string[] {
  switch (access) {
    case "readonly":
      return ["-c", 'sandbox_mode="read-only"'];
    case "workspace_write":
      return ["-c", 'sandbox_mode="workspace-write"'];
    case "full":
    case "external_sandbox_full":
      return ["-c", 'sandbox_mode="danger-full-access"'];
    case "inherit_native":
      return [];
  }
}

function codexWebArgs(policy: HarnessRunSpec["external_context_policy"]): string[] {
  switch (policy) {
    case "off":
      return ["-c", 'web_search="disabled"'];
    case "live":
      return ["-c", 'web_search="live"'];
    case "cached":
    case "auto":
      return ["-c", 'web_search="cached"'];
  }
}

export function createCodexAdapter(): HarnessAdapter {
  return {
    id: "codex",

    async discover(): Promise<HarnessManifest> {
      const version = await detectVersion();
      if (version === null) {
        throw new HarnessUnavailableError(
          "codex CLI not found on PATH (set CLAUDEXOR_CODEX_BIN to override)",
        );
      }
      const apiKey = hasApiKey();
      const authed = await loggedIn();
      const authModes = [
        ...(authed ? ["local_session"] : []),
        ...(apiKey ? ["api_key"] : []),
      ];
      return HarnessManifestSchema.parse({
        id: "codex",
        display_name: "Codex CLI",
        kind: "local_cli",
        version,
        adapter_version: CLAUDEXOR_VERSION,
        provider_family: "openai",
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
          orchestrate: true,
          shell: true,
          read_files: true,
          edit_files: true,
          apply_patch: true,
          structured_events: true,
          structured_output: true,
          json_schema_output: false,
          resume: true,
          cancel: true,
          mcp: true,
          // Codex is an MCP client; we inject Playwright MCP as `-c
          // mcp_servers.browser.*` overrides (live-verified) — gated on web policy.
          browser_tool: true,
          plugins: true,
          worktree_native: false,
          web_policy: "native",
          quota_signal: "observed",
          usage_signal: "native",
          // codex model_reasoning_effort accepts low|medium|high|xhigh (max clamps
          // to xhigh). Single source for the manifest AND the run-time normalizer.
          effort_levels: [...CODEX_EFFORT_LEVELS],
          // Known-good model ids (NOT exhaustive — the codex CLI is the final
          // authority; non-authoritative, so an unknown model is warned, not
          // blocked). Data-driven like effort_levels.
          known_models: ["gpt-5.5", "gpt-5", "gpt-5-codex", "gpt-5-mini", "o3", "o4-mini"],
          models_authoritative: false,
        },
        capability_profile: {
          execution_surfaces: [
            { kind: "cli_one_shot", input: "prompt_arg", output: "ndjson", event_schema: "native", supports_interrupt: true, supports_followup: true },
          ],
          session: { native_session_id_emitted: true, resume_latest: true, resume_by_id: true },
          output: { ndjson_events: true, tool_lifecycle: true, final_json: false, json_schema_final: false, usage_signal: "native", cost_signal: "observed" },
          auth: { supported_sources: ["native_session", "api_key_env", "provider_auth_file"], preferred_source: apiKey ? "provider_auth_file" : authed ? "native_session" : null, probe_command: ["codex", "login", "status"], env_vars: ["CODEX_API_KEY", "OPENAI_API_KEY"] },
          access_control: { readonly: true, workspace_write: true, full: true, mechanism: "codex exec --sandbox" },
          // Codex accepts images via `codex exec -i/--image <FILE>` (file path; remote URLs rejected).
          image_input: "file_path",
        },
        auth_modes: authModes,
        access_profiles_supported: ["readonly", "workspace_write", "full", "inherit_native"],
      });
    },

    async doctor(_spec: DoctorSpec): Promise<ConformanceReport> {
      const version = await detectVersion();
      if (version === null) {
        return ConformanceReportSchema.parse({
          harness_id: "codex",
          status: "unavailable",
          checks: [{ id: "installed", status: "fail", detail: "codex not found on PATH" }],
          reasons: ["codex CLI not found (install Codex or set CLAUDEXOR_CODEX_BIN)"],
        });
      }
      const apiKey = hasApiKey();
      const authed = await loggedIn();
      // Native session readiness is FIRST-CLASS: a logged-in subscription whose
      // auth.json we can seed into the envelope is `ok` with no paid API smoke.
      // (Bible: a stored key STRING alone is still not proof -> api-key route
      // keeps the isolated smoke.) This is what makes subscription-first real.
      const nativeReady = authed && nativeCodexSeedable();
      const smoke = !nativeReady && apiKey ? await smokeIsolatedApiKey() : { ok: false, detail: nativeReady ? "skipped (native session ready)" : "no API key fallback available" };
      const ok = nativeReady || smoke.ok;
      const allIntents = ["plan", "spec", "implement", "repair", "create_from_scratch", "review", "verify", "compare", "arbitrate", "synthesize", "explain", "audit", "orchestrate"];
      return ConformanceReportSchema.parse({
        harness_id: "codex",
        status: ok ? "ok" : authed || apiKey ? "degraded" : "unavailable",
        checks: [
          { id: "installed", status: "pass", detail: version },
          { id: "native_session", status: nativeReady ? "pass" : "fail", detail: nativeReady ? "native codex session seedable into envelope" : authed ? "logged in but ~/.codex/auth.json not found" : "not logged in (run `codex login`)" },
          { id: "stored_key", status: apiKey ? "pass" : "fail", detail: apiKey ? "openai secret/env available (api-key fallback)" : "no openai key fallback" },
          { id: "isolated_api_smoke", status: smoke.ok ? "pass" : nativeReady ? "skip" : apiKey ? "fail" : "skip", detail: smoke.detail },
        ],
        enabled_intents: ok ? allIntents : [],
        disabled_intents: ok ? [] : allIntents,
        reasons: ok
          ? []
          : apiKey
            ? [`isolated Codex API-key smoke failed: ${smoke.detail}`]
            : ["not authenticated (run `codex login` for native/subscription use, or store an openai API key fallback)"],
      });
    },

    run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runCodex(spec);
    },

    review(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runCodex(spec);
    },
  };
}

/**
 * B9 / route proof: recover the model codex ACTUALLY ran from its own session
 * rollout file (`$CODEX_HOME/sessions/<Y>/<M>/<D>/rollout-*-<threadId>.jsonl`,
 * `turn_context.payload.model`). This is the codex CLI's OWN record — a real
 * observation, not an argv echo — so it honestly upgrades the cross-family route
 * proof to `verified` (CLAUDEXOR_BIBLE §5) for a CLI whose `--json` stream never
 * carries the model. Best-effort: any missing/ambiguous/unreadable state returns
 * null and the proof stays unobserved (safe degradation, never throws).
 */
export function codexTranscriptModel(codexHome: string | null | undefined, threadId: string | undefined): string | null {
  if (!threadId) return null;
  const home = codexHome && codexHome.trim() ? codexHome : join(homedir(), ".codex");
  const rollout = findCodexRollout(join(home, "sessions"), threadId);
  if (!rollout) return null;
  let observed: string | null = null;
  try {
    for (const line of readFileSync(rollout, "utf8").split("\n")) {
      if (!line.includes("turn_context")) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const model = (obj as { payload?: { model?: unknown } })?.payload?.model;
      // Keep the LAST turn_context, not the first: a RESUMED codex session
      // (`exec resume <id>`) accumulates multiple turns in one rollout, so the
      // observed model must reflect the most recent turn — the one the usage
      // event this is attached to actually ran — not a stale earlier turn.
      if (typeof model === "string" && model.trim()) observed = model;
    }
  } catch {
    /* unreadable rollout: stay unobserved */
  }
  return observed;
}

/** Locate the rollout file whose name binds to this run's threadId (the id is unique per session). */
function findCodexRollout(sessionsDir: string, threadId: string): string | null {
  if (!existsSync(sessionsDir)) return null;
  try {
    for (const y of listDirsDesc(sessionsDir)) {
      for (const m of listDirsDesc(join(sessionsDir, y))) {
        for (const d of listDirsDesc(join(sessionsDir, y, m))) {
          const dayDir = join(sessionsDir, y, m, d);
          const hit = readdirSync(dayDir).find((f) => f.includes(threadId) && f.endsWith(".jsonl"));
          if (hit) return join(dayDir, hit);
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Subdirectory names sorted newest-first (date partitions), directories only. */
function listDirsDesc(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => {
        try {
          return statSync(join(dir, n)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  } catch {
    return [];
  }
}

async function* runCodex(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
  const nativeAuthed = await loggedIn();
  const key = codexApiKey();
  const preferApi = spec.auth_preference === "api_key";
  const scopedHome = Boolean(spec.env?.["CODEX_HOME"]);
  const scopedHomeNeedsAuth = scopedHome && !hasScopedCodexAuth(spec.env);

  // Seed credentials into the scoped CODEX_HOME. BOTH auth routes are supported
  // with auto-fallback: `subscription` seeds the native session (auth.json copied
  // from ~/.codex — the fix that makes subscription-first actually work inside an
  // envelope); `api_key` seeds the OpenAI key. Order follows auth_preference, and
  // each falls back to the other so a run is not stranded when one source is gone.
  let authRoute: "subscription" | "api_key" | null = null;
  if (scopedHomeNeedsAuth) {
    const trySub = (): boolean => {
      const ok = nativeAuthed ? ensureCodexNativeAuth(spec.env as Record<string, string>) : false;
      if (ok) authRoute = "subscription";
      return ok;
    };
    const tryKey = (): boolean => {
      if (!key) return false;
      ensureCodexApiAuth(spec.env, true);
      const ok = hasScopedCodexAuth(spec.env);
      if (ok) authRoute = "api_key";
      return ok;
    };
    const seeded = preferApi ? tryKey() || trySub() : trySub() || tryKey();
    if (!seeded) {
      yield {
        type: "error",
        session_id: spec.session_id,
        ts: nowIso(),
        error:
          "no usable codex auth for this envelope: native session not seedable (run `codex login`) and no OpenAI API key fallback available",
      };
      yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
      return;
    }
    // An EXPLICIT auth preference that could not be honored is disclosed as a
    // typed marker; the orchestrator lifts it into route.fallback.auth_switched.
    const preferred = preferApi ? "api_key" : "subscription";
    if (spec.auth_preference !== "auto" && authRoute && authRoute !== preferred) {
      yield {
        type: "message",
        session_id: spec.session_id,
        ts: nowIso(),
        text: `[auth] ${preferred} route unavailable; fell back to ${authRoute}`,
        payload: { auth_switched: true, from_auth_mode: preferred === "subscription" ? "local_session" : "api_key", to_auth_mode: authRoute === "subscription" ? "local_session" : "api_key" },
      };
    }
  }

  // Codex authenticates from the seeded auth.json (never an env key), so scrub
  // EVERY provider secret + base-URL redirect from the child — including other
  // providers' keys (the cross-provider leak fix), via the single core table.
  const env: Record<string, string | null | undefined> = {
    ...spec.env,
    ...providerScrubEnv(),
  };

  // Non-envelope run (no scoped CODEX_HOME): an explicit `api_key` preference is
  // HONORED even when natively logged in (a private temp CODEX_HOME seeded with
  // the key; codex ignores OPENAI_API_KEY without an auth.json) — and a missing
  // key falls back to the native session with a typed disclosure. Without a
  // preference, the key route is only the no-native fallback.
  let tempCodexHome: string | null = null;
  if (!scopedHome && key && (preferApi || !nativeAuthed)) {
    tempCodexHome = mkdtempSync(join(tmpdir(), "claudexor-codex-auth-"));
    env["CODEX_HOME"] = tempCodexHome;
    ensureCodexApiAuth({ CODEX_HOME: tempCodexHome });
    // Same disclosure as the envelope path: an explicit subscription preference
    // that lands on the billed key route is never silent.
    if (spec.auth_preference === "subscription") {
      yield {
        type: "message",
        session_id: spec.session_id,
        ts: nowIso(),
        text: "[auth] subscription route unavailable (not logged in); fell back to api_key",
        payload: { auth_switched: true, from_auth_mode: "local_session", to_auth_mode: "api_key" },
      };
    }
  } else if (!scopedHome && preferApi && !key && nativeAuthed) {
    yield {
      type: "message",
      session_id: spec.session_id,
      ts: nowIso(),
      text: "[auth] api_key route unavailable (no key); fell back to subscription",
      payload: { auth_switched: true, from_auth_mode: "api_key", to_auth_mode: "local_session" },
    };
  }

  // Disable Codex.app's headless-incompatible node_repl MCP, but ONLY when the
  // config codex will actually load (the resolved CODEX_HOME, else ~/.codex)
  // already defines it — never create a transport-less partial entry on a scoped
  // home (that broke codex startup, the "invalid transport" regression).
  const args = codexExecArgs(spec, { suppressNodeRepl: codexConfigHasNodeRepl(env["CODEX_HOME"]) });
  // Codex reports tokens but no $cost; estimate it from the (hint/configured)
  // model so the budget ledger does not see every codex run as free.
  const model = spec.model_hint ?? process.env.CLAUDEXOR_CODEX_MODEL ?? null;
  // B9: capture the native thread id (thread.started) so we can read the model
  // codex recorded in its own rollout transcript; cache that one read.
  let codexThreadId: string | undefined;
  let transcriptModel: string | null | undefined;

  try {
    yield* runCliHarness({
      bin: BIN,
      args,
      spec,
      env,
      label: "codex",
      redact: redactSecrets,
      parseEvent: (obj, sessionId) => {
        // Bind the rollout transcript to THIS run via the native thread id.
        const raw = obj as { type?: unknown; thread_id?: unknown };
        if (raw?.type === "thread.started" && typeof raw.thread_id === "string") codexThreadId = raw.thread_id;
        const out = parseCodexEvent(obj, sessionId);
        if (out === null) return null;
        for (const ev of out) {
          // Do NOT fabricate observed_model from the request hint: route proof
          // exists to catch silent fallback, so an unobserved model must stay
          // unobserved. Record the requested model for diagnostics only.
          if (ev.type === "started" && spec.model_hint && !ev.observed_model) {
            ev.payload = { ...(ev.payload ?? {}), requested_model: spec.model_hint, observed_model_source: "unobserved" };
          }
          // B9: codex's --json stream never carries the model, but the CLI
          // records it in its own session rollout. Read that transcript ONCE and
          // attach it as a real `transcript`-sourced observation on the usage
          // event, so cross-family route proof verifies honestly (§5). The
          // transcript's turn_context is written at turn start, so it is on disk
          // by turn.completed (the usage event); a missing read stays unobserved.
          if (ev.type === "usage" && !ev.observed_model) {
            if (transcriptModel === undefined) transcriptModel = codexTranscriptModel(env["CODEX_HOME"], codexThreadId);
            if (transcriptModel) {
              ev.observed_model = transcriptModel;
              ev.payload = { ...(ev.payload ?? {}), observed_model_source: "transcript" };
            }
          }
          // #16: an api_key run uses a TEMPORARY CODEX_HOME that this process
          // deletes on exit, so the native session it created is gone next turn.
          // Strip its id from the event so it never poisons the thread resume map
          // (a later `codex exec resume <ghost>` would deterministically fail).
          if (ev.type === "started" && tempCodexHome && ev.payload && "native_session_id" in ev.payload) {
            const { native_session_id: _dropped, ...rest } = ev.payload as Record<string, unknown>;
            ev.payload = { ...rest, resume_disabled: "ephemeral_codex_home" };
          }
          if (ev.type === "usage" && ev.usage && ev.usage.cost_usd === undefined) {
            const est = estimateCodexCostUsd(model, ev.usage);
            if (est !== undefined) {
              ev.usage.cost_usd = est;
              ev.usage.estimated = true;
            }
          }
        }
        return out;
      },
    });
  } finally {
    if (tempCodexHome) {
      try {
        rmSync(tempCodexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        /* best-effort: OS tmp reaper owns the leftovers */
      }
    }
  }
}
