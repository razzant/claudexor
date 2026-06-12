import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AccessProfile, ConformanceReport, EffortHint, HarnessEvent, HarnessManifest, HarnessRunSpec } from "@claudexor/schema";
import { ConformanceReport as ConformanceReportSchema, HarnessManifest as HarnessManifestSchema } from "@claudexor/schema";
import type { DoctorSpec, HarnessAdapter } from "@claudexor/core";
import { HarnessUnavailableError, providerScrubEnv, runCapture, runCliHarness } from "@claudexor/core";
import { resolveSecret } from "@claudexor/secrets";
import { nowIso, redactSecrets } from "@claudexor/util";
import { parseCodexEvent } from "./parse.js";
import { estimateCodexCostUsd } from "./pricing.js";

const BIN = process.env.CLAUDEXOR_CODEX_BIN || "codex";

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

export function codexExecArgs(
  spec: Pick<HarnessRunSpec, "access" | "model_hint" | "effort_hint" | "external_context_policy" | "prompt"> & {
    resume_session_id?: string | null;
  },
): string[] {
  // Resume a native codex session as a follow-up turn (`codex exec resume <id>`),
  // so a thread's later moves continue the same conversation instead of restarting.
  // LIVE-VERIFIED (codex 0.137): the resume subcommand does NOT accept --sandbox;
  // sandboxing must ride as `-c sandbox_mode="..."` config overrides there.
  if (spec.resume_session_id) {
    const args = ["exec", "resume", spec.resume_session_id, "--json", ...sandboxConfigArgs(spec.access), "--skip-git-repo-check"];
    if (spec.model_hint) args.push("-m", spec.model_hint);
    if (spec.effort_hint) args.push("-c", `model_reasoning_effort="${clampCodexEffort(spec.effort_hint)}"`);
    args.push(...codexWebArgs(spec.external_context_policy ?? "auto"));
    args.push(spec.prompt);
    return args;
  }
  const args = ["exec", "--json", ...sandboxArgs(spec.access), "--skip-git-repo-check"];
  if (spec.model_hint) args.push("-m", spec.model_hint);
  if (spec.effort_hint) args.push("-c", `model_reasoning_effort="${clampCodexEffort(spec.effort_hint)}"`);
  args.push(...codexWebArgs(spec.external_context_policy ?? "auto"));
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

/**
 * Codex accepts minimal|low|medium|high|xhigh for model_reasoning_effort; the
 * cross-harness `max` hint (valid for Claude) must clamp to xhigh instead of
 * producing an invalid config value that breaks mixed-effort races.
 */
export function clampCodexEffort(effort: EffortHint): EffortHint {
  return effort === "max" ? "xhigh" : effort;
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
        adapter_version: "0.9.0",
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
          plugins: true,
          worktree_native: false,
          web_policy: "native",
          quota_signal: "observed",
          usage_signal: "native",
        },
        capability_profile: {
          execution_surfaces: [
            { kind: "cli_one_shot", input: "prompt_arg", output: "ndjson", event_schema: "native", supports_interrupt: true, supports_followup: true },
          ],
          session: { native_session_id_emitted: true, resume_latest: true, resume_by_id: true },
          output: { ndjson_events: true, tool_lifecycle: true, final_json: false, json_schema_final: false, usage_signal: "native", cost_signal: "observed" },
          auth: { supported_sources: ["native_session", "api_key_env", "provider_auth_file"], preferred_source: apiKey ? "provider_auth_file" : authed ? "native_session" : null, probe_command: ["codex", "login", "status"], env_vars: ["CODEX_API_KEY", "OPENAI_API_KEY"] },
          access_control: { readonly: true, workspace_write: true, full: true, mechanism: "codex exec --sandbox" },
        },
        auth_modes: authModes,
        access_profiles_supported: ["readonly", "workspace_write", "full", "inherit_native"],
        models: { discovery: "experimental" },
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

  // Non-envelope run (no scoped CODEX_HOME) without native login: seed a private
  // temporary CODEX_HOME with the api key (codex ignores OPENAI_API_KEY without an
  // auth.json) instead of touching the user's real ~/.codex.
  let tempCodexHome: string | null = null;
  if (!scopedHome && !nativeAuthed && key) {
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
  }

  const args = codexExecArgs(spec);
  // Codex reports tokens but no $cost; estimate it from the (hint/configured)
  // model so the budget ledger does not see every codex run as free.
  const model = spec.model_hint ?? process.env.CLAUDEXOR_CODEX_MODEL ?? null;

  try {
    yield* runCliHarness({
      bin: BIN,
      args,
      spec,
      env,
      label: "codex",
      redact: redactSecrets,
      parseEvent: (obj, sessionId) => {
        const out = parseCodexEvent(obj, sessionId);
        if (out === null) return null;
        for (const ev of out) {
          // Do NOT fabricate observed_model from the request hint: route proof
          // exists to catch silent fallback, so an unobserved model must stay
          // unobserved. Record the requested model for diagnostics only.
          if (ev.type === "started" && spec.model_hint && !ev.observed_model) {
            ev.payload = { ...(ev.payload ?? {}), requested_model: spec.model_hint, observed_model_source: "unobserved" };
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
