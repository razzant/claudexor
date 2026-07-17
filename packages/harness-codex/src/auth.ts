import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { labelStreams, providerScrubEnv, runCapture } from "@claudexor/core";
import { resolveSecret } from "@claudexor/secrets";
import { ensureDir, redactSecrets, userConfigDir } from "@claudexor/util";

const BIN = process.env.CLAUDEXOR_CODEX_BIN || "codex";
export const CODEX_FILE_AUTH_OVERRIDE = 'cli_auth_credentials_store="file"';
export const CODEX_FILE_AUTH_ARGS = ["-c", CODEX_FILE_AUTH_OVERRIDE] as const;

/**
 * Resolve an OpenAI API key for codex from the environment. Claudexor-managed
 * `api_key` auth mirrors the harness's own variable (`OPENAI_API_KEY`); a
 * dedicated `CLAUDEXOR_CODEX_API_KEY` can override it for multi-key setups.
 */
export function codexApiKey(): string | undefined {
  // The hermetic kill switch is honored inside resolveSecret (single owner).
  const stored = resolveSecret("openai");
  return (
    process.env.CLAUDEXOR_CODEX_API_KEY ||
    process.env.CODEX_API_KEY ||
    process.env.OPENAI_API_KEY ||
    stored ||
    undefined
  );
}

/**
 * Seed `api_key` auth into an isolated CODEX_HOME. Codex does not read
 * `OPENAI_API_KEY` from the environment when run against an empty config dir
 * (it requires `auth.json`), so an envelope-scoped CODEX_HOME would otherwise
 * fail with 401 even though a key is available. We write the same file
 * `codex login --with-api-key` produces. No-op when not isolated (use codex's
 * native auth), when no key is available, or when auth already exists.
 */
export function ensureCodexApiAuth(
  env?: Record<string, string>,
  allowApiKey = true,
  apiKeyOverride?: string | null,
): void {
  if (!allowApiKey) return;
  const home = env?.["CODEX_HOME"];
  if (!home) return;
  if (resolve(home) === resolve(defaultNativeCodexHome())) {
    throw new Error("refusing to read or write the vendor-owned native Codex auth store");
  }
  // A profile's namespaced key (INV-135) beats the engine-default slot; the
  // override is exact — a missing profile secret never falls back.
  const apiKey = apiKeyOverride !== undefined ? apiKeyOverride : codexApiKey();
  if (!apiKey) return;
  const authPath = join(home, "auth.json");
  if (existsSync(authPath)) return;
  mkdirSync(home, { recursive: true });
  writeFileSync(authPath, JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: apiKey }) + "\n", {
    mode: 0o600,
  });
}

/** Claudexor's independent Codex profile; never the operator's ordinary ~/.codex. */
export function defaultNativeCodexHome(): string {
  const override = process.env.CLAUDEXOR_CODEX_NATIVE_HOME;
  if (override && override.trim()) return override;
  return join(userConfigDir(), "native", "codex");
}

export type CodexLoginMethod = "chatgpt" | "api_key" | "access_token" | "logged_out" | "unknown";
export interface CodexLoginProbe {
  /** True for any typed authenticated status; native readiness additionally requires method=chatgpt. */
  authed: boolean;
  method: CodexLoginMethod;
  probeError: string | null;
}

export interface CodexLoginProbeOptions {
  /** Exact environment the eventual Codex child will use. */
  env?: Record<string, string | null | undefined>;
  /** Explicit CODEX_HOME for the probe (INV-135, release wave round-17
   * BLOCK): without it the probe re-normalizes onto the DEFAULT native home —
   * a credential-profile probe must inspect ITS OWN store, never the
   * default's. Callers without a profile omit it and keep the default. */
  codexHome?: string;
  abortSignal?: AbortSignal;
  runCapture?: typeof runCapture;
}

/**
 * Native-session probe with a distinct PROBE-FAILURE state. `codex login
 * status` exits non-zero both when logged out AND when the CLI cannot even
 * load `~/.codex/config.toml` (e.g. the config uses a newer option enum than
 * the resolved binary understands — the stale-shim case). Collapsing those
 * into "not logged in" hid a real subscription behind a config error; doctor
 * must fail loudly with the CLI's own message instead.
 */
export async function probeLogin(
  bin: string = BIN,
  options: CodexLoginProbeOptions = {},
): Promise<CodexLoginProbe> {
  try {
    const home = options.codexHome ?? defaultNativeCodexHome();
    ensureDir(home);
    const env: Record<string, string | null | undefined> = {
      ...(options.env ?? {}),
      ...providerScrubEnv(),
      CODEX_HOME: home,
    };
    const r = await (options.runCapture ?? runCapture)(
      bin,
      [...CODEX_FILE_AUTH_ARGS, "login", "status"],
      {
        env,
        timeoutMs: 10_000,
        abortSignal: options.abortSignal,
        cancelSignal: "SIGTERM",
        cancelKillDelayMs: 0,
      },
    );
    const text = `${r.stdout}\n${r.stderr}`;
    const statusLines = text
      .replaceAll("\r", "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    // "Not logged in" is codex's NORMAL logged-out answer (exit 1, no error
    // prefix). Anything else on a failing probe is a probe error, not an auth
    // verdict (adapter-local knowledge of the native CLI's output is allowed).
    if (statusLines.some((line) => /^not logged in[.!]?$/i.test(line))) {
      return { authed: false, method: "logged_out", probeError: null };
    }
    if (r.code === 0 && statusLines.some((line) => /^logged in using chatgpt[.!]?$/i.test(line))) {
      return { authed: true, method: "chatgpt", probeError: null };
    }
    if (
      r.code === 0 &&
      statusLines.some((line) => /^logged in using (?:an? )?api key[.!]?$/i.test(line))
    ) {
      return { authed: true, method: "api_key", probeError: null };
    }
    if (
      r.code === 0 &&
      statusLines.some((line) => /^logged in using (?:an? )?access token[.!]?$/i.test(line))
    ) {
      return { authed: true, method: "access_token", probeError: null };
    }
    // Redact BEFORE labelStreams truncates: truncation could split a token
    // into a prefix the redactor no longer recognizes.
    const detail = labelStreams(r.stderr, r.stdout, { transform: redactSecrets });
    const reason =
      detail ?? `codex login status exited with ${r.code ?? r.signal ?? "unknown result"}`;
    return {
      authed: false,
      method: "unknown",
      probeError: r.code === 0 ? `unrecognized login status: ${reason}` : reason,
    };
  } catch (err) {
    return {
      authed: false,
      method: "unknown",
      probeError: [...redactSecrets(err instanceof Error ? err.message : String(err))]
        .slice(0, 300)
        .join(""),
    };
  }
}

export function hasApiKey(): boolean {
  return Boolean(codexApiKey());
}

/**
 * Auth route the codex child will ACTUALLY run under, read from the same
 * `auth.json` codex itself loads in a Claudexor-created scoped CODEX_HOME.
 * The vendor-owned native home is deliberately not a fallback and must remain
 * opaque. The file's own `auth_mode` field is the typed source of truth:
 * "chatgpt" = subscription session, "apikey" = API key. Null when the file is
 * absent/unreadable or carries an unknown mode — callers must treat that as
 * undisclosed, never guess.
 */
export function codexAuthModeAt(home: string): "local_session" | "api_key" | null {
  if (!home.trim() || resolve(home) === resolve(defaultNativeCodexHome())) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(home, "auth.json"), "utf8")) as {
      auth_mode?: unknown;
    };
    if (parsed.auth_mode === "chatgpt") return "local_session";
    if (parsed.auth_mode === "apikey") return "api_key";
    return null;
  } catch {
    return null;
  }
}
