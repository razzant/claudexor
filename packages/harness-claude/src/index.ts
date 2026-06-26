import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AccessProfile, ConformanceReport, EffortHint, HarnessEvent, HarnessManifest, HarnessRunSpec } from "@claudexor/schema";
import { ConformanceReport as ConformanceReportSchema, HarnessManifest as HarnessManifestSchema } from "@claudexor/schema";
import type { DoctorSpec, HarnessAdapter, InteractionChannel } from "@claudexor/core";
import { HarnessUnavailableError, interactionChannelFromSpec, normalizeEffort, playwrightMcpArgs, providerScrubEnv, resolveNpxBin, runCapture, runCliHarness, PROVIDER_SECRET_ENV } from "@claudexor/core";
import { resolveSecret } from "@claudexor/secrets";
import { CLAUDEXOR_VERSION, nowIso, redactSecrets } from "@claudexor/util";
import { createClaudeParser } from "./parse.js";
import { handleControlRequestFrame, initialSessionFrames, isControlRequestFrame, isResultFrame, type ClaudeImageBlock } from "./interactive.js";

const BIN = process.env.CLAUDEXOR_CLAUDE_BIN || "claude";
const CLAUDE_PROVIDER_ENV_DENYLIST = PROVIDER_SECRET_ENV.filter((k) => k !== "ANTHROPIC_API_KEY");

/**
 * Ordered (weakest→strongest) reasoning-effort levels `claude --effort` accepts.
 * Claude does NOT accept `xhigh`/`max`, so they clamp to `high` via the shared
 * normalizer (the ADP2 "claude xhigh" bug fix). SINGLE source for the manifest's
 * `effort_levels` and the run-time normalizer.
 */
const CLAUDE_EFFORT_LEVELS: readonly EffortHint[] = ["low", "medium", "high"];

function permissionArgs(access: AccessProfile): string[] {
  switch (access) {
    case "readonly":
      return ["--permission-mode", "plan"];
    case "workspace_write":
      return ["--permission-mode", "acceptEdits"];
    case "full":
    case "external_sandbox_full":
      return ["--permission-mode", "bypassPermissions"];
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

async function authStatusOk(): Promise<boolean> {
  try {
    const env = Object.fromEntries(CLAUDE_PROVIDER_ENV_DENYLIST.map((name) => [name, null]));
    // Probe a REAL native/subscription session only: `claude auth status` reports
    // loggedIn:true for a bare ANTHROPIC_API_KEY (authMethod:api_key), which would
    // make the run path mistake an API key for a native session and pick the
    // subscription route (scrubs the key -> "Not logged in"). Scrub it here so this
    // probe reflects native-session readiness alone; the api_key route is chosen
    // separately by runClaude when no native session exists.
    env.ANTHROPIC_API_KEY = null;
    const r = await runCapture(BIN, ["auth", "status"], { env, timeoutMs: 10_000 });
    return r.code === 0;
  } catch {
    return false;
  }
}

function anthropicApiKey(): string | null {
  return process.env.CLAUDEXOR_ANTHROPIC_API_KEY || resolveSecret("anthropic") || process.env.ANTHROPIC_API_KEY || null;
}

/** A stored/long-lived Claude Code OAuth (`claude setup-token`) for headless subscription auth. */
function claudeOAuthToken(): string | null {
  if (process.env.CLAUDEXOR_DISABLE_STORED_SECRETS === "1") return process.env.CLAUDE_CODE_OAUTH_TOKEN || null;
  return resolveSecret("claude_oauth") || process.env.CLAUDE_CODE_OAUTH_TOKEN || null;
}

/** The user's real Claude config dir (native subscription session lives here). */
export function defaultNativeClaudeConfigDir(): string {
  const override = process.env.CLAUDEXOR_CLAUDE_NATIVE_DIR;
  if (override && override.trim()) return override;
  return join(homedir(), ".claude");
}

/**
 * Seed the user's NATIVE Claude session (`.credentials.json`, subscription OAuth)
 * into an isolated CLAUDE_CONFIG_DIR so a Pro/Max subscriber with NO API key can
 * run inside a Claudexor envelope. Copies only if scoped creds are absent and a
 * native credentials file exists; never overwrites. Returns true when scoped
 * creds are present afterwards.
 *
 * Caveats encoded by the caller: `ANTHROPIC_API_KEY` takes precedence over the
 * OAuth session, and `--bare` disables it — so the subscription route must set
 * neither.
 */
export function ensureClaudeNativeAuth(
  env?: Record<string, string>,
  nativeDir: string = defaultNativeClaudeConfigDir(),
): boolean {
  const dir = env?.["CLAUDE_CONFIG_DIR"];
  if (!dir) return false;
  const dest = join(dir, ".credentials.json");
  if (existsSync(dest)) return true;
  const src = join(nativeDir, ".credentials.json");
  if (!existsSync(src)) return false;
  try {
    mkdirSync(dir, { recursive: true });
    copyFileSync(src, dest);
    try {
      chmodSync(dest, 0o600);
    } catch {
      /* best-effort perms */
    }
    return existsSync(dest);
  } catch {
    return false;
  }
}

/** True when a native Claude session exists and can be seeded into an envelope. */
function nativeClaudeSeedable(): boolean {
  return existsSync(join(defaultNativeClaudeConfigDir(), ".credentials.json"));
}

async function smokeIsolatedApiKey(): Promise<{ ok: boolean; detail: string }> {
  const key = anthropicApiKey();
  if (!key) return { ok: false, detail: "no API key fallback available" };
  const dir = mkdtempSync(`${tmpdir()}/claudexor-claude-smoke-`);
  try {
    const env: Record<string, string | null | undefined> = Object.fromEntries(CLAUDE_PROVIDER_ENV_DENYLIST.map((name) => [name, null]));
    env.HOME = dir;
    env.XDG_CONFIG_HOME = `${dir}/.config`;
    env.CLAUDE_CONFIG_DIR = dir;
    env.ANTHROPIC_API_KEY = key;
    const r = await runCapture(
      BIN,
      ["-p", "Reply exactly OK", "--output-format", "stream-json", "--verbose", "--permission-mode", "plan"],
      { cwd: dir, env, timeoutMs: 60_000 },
    );
    const text = `${r.stdout}\n${r.stderr}`;
    if (r.code === 0 && text.includes("OK")) return { ok: true, detail: "isolated CLAUDE_CONFIG_DIR smoke passed" };
    return { ok: false, detail: redactClaudeDoctorDetail(text || `claude exited with code ${r.code}`) };
  } catch (err) {
    return { ok: false, detail: redactClaudeDoctorDetail(err instanceof Error ? err.message : String(err)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function redactClaudeDoctorDetail(text: string): string {
  return redactSecrets(text).slice(0, 500);
}

export function createClaudeAdapter(): HarnessAdapter {
  return {
    id: "claude",

    async discover(): Promise<HarnessManifest> {
      const version = await detectVersion();
      if (version === null) {
        throw new HarnessUnavailableError(
          "claude CLI not found on PATH (set CLAUDEXOR_CLAUDE_BIN to override)",
        );
      }
      const apiKey = anthropicApiKey() !== null;
      const authed = await authStatusOk();
      const authModes = [
        ...(authed ? ["local_session"] : []),
        ...(apiKey ? ["api_key"] : []),
      ];
      return HarnessManifestSchema.parse({
        id: "claude",
        display_name: "Claude Code",
        kind: "local_cli",
        version,
        adapter_version: CLAUDEXOR_VERSION,
        provider_family: "anthropic",
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
          cancel: true,
          mcp: true,
          // Claude is an MCP client; we inject Playwright MCP via `--mcp-config`
          // inline JSON (no disk write) — gated on web policy.
          browser_tool: true,
          plugins: true,
          worktree_native: true,
          web_policy: "tools",
          max_turns: true,
          tool_lists: true,
          interactive: true,
          orchestrate: true,
          quota_signal: "observed",
          usage_signal: "exact",
          // claude --effort accepts low|medium|high ONLY (xhigh/max clamp to high
          // via the shared normalizer). Single source for the run-time normalizer.
          effort_levels: [...CLAUDE_EFFORT_LEVELS],
          // Known-good model aliases/ids (NOT exhaustive — the claude CLI is the
          // final authority and gains models over time, so this is non-authoritative:
          // an unknown model is warned about, never blocked). Stable aliases plus
          // current ids; data-driven like effort_levels.
          known_models: ["sonnet", "opus", "haiku", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
          models_authoritative: false,
        },
        capability_profile: {
          execution_surfaces: [
            { kind: "cli_one_shot", input: "prompt_arg", output: "ndjson", event_schema: "native", supports_interrupt: true },
            { kind: "stdin_stream_session", input: "stdin_stream", output: "ndjson", event_schema: "native", supports_interrupt: true, supports_permission_reply: true, supports_followup: true },
          ],
          session: { native_session_id_emitted: true, resume_latest: true, resume_by_id: true },
          output: { ndjson_events: true, partial_deltas: true, tool_lifecycle: true, final_json: false, json_schema_final: false, usage_signal: "exact", cost_signal: "exact" },
          auth: { supported_sources: ["native_session", "api_key_env"], preferred_source: apiKey ? "api_key_env" : authed ? "native_session" : null, probe_command: ["claude", "auth", "status"], env_vars: ["ANTHROPIC_API_KEY"] },
          access_control: { readonly: true, workspace_write: true, full: true, mechanism: "claude --permission-mode" },
          // Claude accepts images as base64 blocks on the stdin stream-json transport.
          image_input: "base64_stream",
        },
        auth_modes: authModes,
        access_profiles_supported: ["readonly", "workspace_write", "full", "inherit_native"],
      });
    },

    async doctor(_spec: DoctorSpec): Promise<ConformanceReport> {
      const version = await detectVersion();
      if (version === null) {
        return ConformanceReportSchema.parse({
          harness_id: "claude",
          status: "unavailable",
          checks: [{ id: "installed", status: "fail", detail: "claude not found on PATH" }],
          reasons: ["claude CLI not found (install Claude Code or set CLAUDEXOR_CLAUDE_BIN)"],
        });
      }
      const apiKey = anthropicApiKey() !== null;
      const authed = await authStatusOk();
      // Native subscription readiness is FIRST-CLASS: a logged-in session whose
      // .credentials.json we can seed into the envelope is `ok` with no paid API
      // smoke. A stored OAuth token (claude setup-token) is also native-ready.
      const nativeReady = (authed && nativeClaudeSeedable()) || claudeOAuthToken() !== null;
      const smoke = !nativeReady && apiKey ? await smokeIsolatedApiKey() : { ok: false, detail: nativeReady ? "skipped (native session ready)" : "no API key fallback available" };
      const ok = nativeReady || smoke.ok;
      const allIntents = ["plan", "spec", "implement", "repair", "create_from_scratch", "review", "verify", "compare", "arbitrate", "synthesize", "explain", "audit", "orchestrate"];
      return ConformanceReportSchema.parse({
        harness_id: "claude",
        status: ok ? "ok" : authed || apiKey ? "degraded" : "unavailable",
        checks: [
          { id: "installed", status: "pass", detail: version },
          { id: "native_session", status: nativeReady ? "pass" : "fail", detail: nativeReady ? "native Claude session seedable into envelope" : authed ? "logged in but ~/.claude/.credentials.json not found" : "not logged in (run `claude /login` or store a setup-token)" },
          { id: "stored_key", status: apiKey ? "pass" : "fail", detail: apiKey ? "anthropic secret/env available (api-key fallback)" : "no anthropic key fallback" },
          { id: "isolated_api_smoke", status: smoke.ok ? "pass" : nativeReady ? "skip" : apiKey ? "fail" : "skip", detail: smoke.detail },
        ],
        enabled_intents: ok ? allIntents : [],
        disabled_intents: ok ? [] : allIntents,
        reasons: ok
          ? []
          : apiKey
            ? [`isolated Claude API-key smoke failed: ${smoke.detail}`]
            : ["not authenticated (run `claude /login` for native/subscription use, or store an anthropic API key fallback)"],
      });
    },

    run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runClaude(spec);
    },

    review(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
      return runClaude(spec);
    },
  };
}

/** Claude's native names for web-permissioned tools. This knowledge lives ONLY in the adapter. */
const CLAUDE_WEB_TOOLS = ["WebSearch", "WebFetch"];

export function claudeArgsForSpec(spec: HarnessRunSpec, interactive = false, suppressBare = false): string[] {
  // Interactive sessions deliver the prompt as a stream-json user message on
  // stdin (the control protocol's transport); one-shot runs keep the prompt arg.
  // `--permission-prompt-tool stdio` is the live-verified switch that routes
  // permission prompts (AskUserQuestion included) onto the control channel as
  // control_request frames instead of headless auto-denial.
  const args = interactive
    ? ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--permission-prompt-tool", "stdio", ...permissionArgs(spec.access)]
    : ["-p", spec.prompt, "--output-format", "stream-json", "--verbose", ...permissionArgs(spec.access)];
  if (spec.model_hint) args.push("--model", spec.model_hint);
  // Clamp onto claude's supported effort ladder (xhigh/max -> high); null = not
  // requested OR not tunable -> pass no flag. Never sends an invalid level.
  const eff = normalizeEffort(spec.effort_hint, CLAUDE_EFFORT_LEVELS);
  if (eff) args.push("--effort", eff);
  if (spec.max_turns !== null && spec.max_turns > 0) args.push("--max-turns", String(spec.max_turns));
  // Resume a native Claude session as a follow-up turn of the same conversation.
  if (spec.resume_session_id) args.push("--resume", spec.resume_session_id);
  args.push(...claudeBrowserArgs(spec));
  args.push(...toolPermissionArgs(spec));
  // `--bare` disables OAuth/keychain auth, so it is mutually exclusive with the
  // subscription (native session) route — suppress it there or the run 401s.
  if (spec.extra?.["bare"] === true && !suppressBare) args.push("--bare");
  return args;
}

/**
 * Map the external-context policy plus the user's per-harness tool allow/deny
 * lists to Claude flags. Uses the single comma-separated form: the repeated
 * variadic form is a known-fragile area of the Claude CLI.
 * Note `cached` executes as live web here (Claude has no cached web index);
 * the orchestrator discloses that upgrade via `policy.web.upgraded`.
 */
function toolPermissionArgs(spec: HarnessRunSpec): string[] {
  const policy = spec.external_context_policy;
  const allow = new Set(spec.tool_permission_policy.allow);
  const deny = new Set(spec.tool_permission_policy.deny);
  if (policy === "off") {
    for (const tool of CLAUDE_WEB_TOOLS) {
      deny.add(tool);
      allow.delete(tool);
    }
  } else {
    for (const tool of CLAUDE_WEB_TOOLS) {
      if (!deny.has(tool)) allow.add(tool);
    }
  }
  // A browser-tool run allows the injected MCP server's tools (claude names them
  // `mcp__browser__*`; the server prefix `mcp__browser` allows the whole set).
  // Gated on policy: under `off` the MCP is never injected (claudeBrowserArgs is
  // empty), so this allow has no tool to match anyway.
  if (spec.browser && policy !== "off") allow.add("mcp__browser");
  const args: string[] = [];
  if (allow.size > 0) args.push("--allowedTools", [...allow].join(","));
  if (deny.size > 0) args.push("--disallowedTools", [...deny].join(","));
  return args;
}

/**
 * Inject the Playwright browser MCP via `--mcp-config` inline JSON (no disk
 * write — fits the scoped HOME and works under `--bare`). Empty when no browser
 * this run OR when web policy is `off` (the browser is live egress and must ride
 * `external_context_policy`, mirroring web-tool gating).
 */
function claudeBrowserArgs(spec: HarnessRunSpec): string[] {
  if (!spec.browser || spec.external_context_policy === "off") return [];
  const cfg = JSON.stringify({ mcpServers: { browser: { command: resolveNpxBin(), args: playwrightMcpArgs(spec.browser) } } });
  return ["--mcp-config", cfg];
}

/** Build Claude base64 image blocks from image attachments (read at spec time). */
function claudeImageBlocks(attachments: HarnessRunSpec["attachments"] | undefined): ClaudeImageBlock[] {
  const blocks: ClaudeImageBlock[] = [];
  for (const a of attachments ?? []) {
    if (a.kind !== "image") continue;
    try {
      blocks.push({ type: "image", source: { type: "base64", media_type: a.mime, data: readFileSync(a.path).toString("base64") } });
    } catch {
      // A late-deleted attachment is non-fatal: proceed with the text prompt.
    }
  }
  return blocks;
}

async function* runClaude(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
  const channel: InteractionChannel | undefined = interactionChannelFromSpec(spec);
  const imageBlocks = claudeImageBlocks(spec.attachments);
  // Images ride ONLY the stdin stream-json transport, so an attachment forces
  // the interactive path even with no interaction channel (control frames then
  // auto-decline). claudeArgsForSpec(interactive) selects --input-format stream-json.
  const interactive = channel !== undefined || imageBlocks.length > 0;
  const nativeAuthed = await authStatusOk();
  const key = anthropicApiKey();
  const oauthToken = claudeOAuthToken();
  const preferApi = spec.auth_preference === "api_key";
  const scopedConfig = Boolean(spec.env?.["CLAUDE_CONFIG_DIR"]);

  // Choose the auth route (BOTH supported, auto-fallback). Subscription seeds the
  // native session (credentials copy) or uses a stored OAuth token; api_key sets
  // ANTHROPIC_API_KEY. ANTHROPIC_API_KEY overrides OAuth and --bare disables it,
  // so the subscription route sets neither (and suppresses --bare).
  let seededCreds = false;
  const trySub = (): boolean => {
    if (scopedConfig && nativeAuthed && ensureClaudeNativeAuth(spec.env as Record<string, string>)) {
      seededCreds = true;
      return true;
    }
    return (!scopedConfig && nativeAuthed) || oauthToken !== null;
  };
  const canKey = key !== null;
  const route: "subscription" | "api_key" | null = preferApi
    ? canKey
      ? "api_key"
      : trySub()
        ? "subscription"
        : null
    : trySub()
      ? "subscription"
      : canKey
        ? "api_key"
        : null;

  // An EXPLICIT auth preference that could not be honored is disclosed as a
  // typed marker; the orchestrator lifts it into route.fallback.auth_switched.
  const preferredRoute = preferApi ? "api_key" : "subscription";
  if (spec.auth_preference !== "auto" && route !== null && route !== preferredRoute) {
    yield {
      type: "message",
      session_id: spec.session_id,
      ts: nowIso(),
      text: `[auth] ${preferredRoute} route unavailable; fell back to ${route}`,
      payload: {
        auth_switched: true,
        from_auth_mode: preferredRoute === "subscription" ? "local_session" : "api_key",
        to_auth_mode: route === "subscription" ? "local_session" : "api_key",
      },
    };
  }

  if (route === null) {
    yield {
      type: "error",
      session_id: spec.session_id,
      ts: nowIso(),
      error:
        "no usable claude auth for this envelope: native session not seedable (run `claude /login` or store a setup-token) and no Anthropic API key fallback available",
    };
    yield { type: "completed", session_id: spec.session_id, ts: nowIso() };
    return;
  }

  const useSubscription = route === "subscription";
  const args = claudeArgsForSpec(spec, interactive, useSubscription);
  // Scrub EVERY provider secret (incl. OpenAI/others — the cross-provider leak
  // fix) via the single core table, then re-add only the var this route needs.
  const env: Record<string, string | null | undefined> = { ...spec.env, ...providerScrubEnv() };
  if (route === "api_key" && key) {
    env.ANTHROPIC_API_KEY = key;
  } else if (route === "subscription" && !seededCreds && oauthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  }

  yield* runCliHarness({
    bin: BIN,
    args,
    spec,
    env,
    label: "claude",
    redact: redactSecrets,
    parseEvent: createClaudeParser(),
    ...(interactive
      ? {
          session: {
            initialStdin: initialSessionFrames(spec.prompt, imageBlocks),
            matches: isControlRequestFrame,
            handle: (obj, io) => handleControlRequestFrame(obj, io, spec.session_id, channel),
            closeStdinOn: isResultFrame,
          },
        }
      : {}),
  });
}
