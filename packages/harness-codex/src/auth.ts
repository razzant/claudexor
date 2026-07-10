import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { labelStreams, runCapture } from "@claudexor/core";
import { resolveSecret } from "@claudexor/secrets";
import { redactSecrets } from "@claudexor/util";

const BIN = process.env.CLAUDEXOR_CODEX_BIN || "codex";

/**
 * Resolve an OpenAI API key for codex from the environment. Claudexor-managed
 * `api_key` auth mirrors the harness's own variable (`OPENAI_API_KEY`); a
 * dedicated `CLAUDEXOR_CODEX_API_KEY` can override it for multi-key setups.
 */
export function codexApiKey(): string | undefined {
  // The hermetic kill switch is honored inside resolveSecret (single owner).
  const stored = resolveSecret("openai");
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
export function nativeCodexSeedable(): boolean {
  return existsSync(join(defaultNativeCodexHome(), "auth.json"));
}

/**
 * Native-session probe with a distinct PROBE-FAILURE state. `codex login
 * status` exits non-zero both when logged out AND when the CLI cannot even
 * load `~/.codex/config.toml` (e.g. the config uses a newer option enum than
 * the resolved binary understands — the stale-shim case). Collapsing those
 * into "not logged in" hid a real subscription behind a config error; doctor
 * must fail loudly with the CLI's own message instead.
 */
export async function probeLogin(bin: string = BIN): Promise<{ authed: boolean; probeError: string | null }> {
  try {
    const r = await runCapture(bin, ["login", "status"], { timeoutMs: 10_000 });
    if (r.code === 0) return { authed: true, probeError: null };
    // "Not logged in" is codex's NORMAL logged-out answer (exit 1, no error
    // prefix). Anything else on a failing probe is a probe error, not an auth
    // verdict (adapter-local knowledge of the native CLI's output is allowed).
    if (/not logged in/i.test(`${r.stderr}\n${r.stdout}`)) return { authed: false, probeError: null };
    // Redact BEFORE labelStreams truncates: truncation could split a token
    // into a prefix the redactor no longer recognizes.
    const detail = labelStreams(r.stderr, r.stdout, { transform: redactSecrets });
    if (detail === null) return { authed: false, probeError: null };
    return { authed: false, probeError: detail };
  } catch (err) {
    return { authed: false, probeError: [...redactSecrets(err instanceof Error ? err.message : String(err))].slice(0, 300).join("") };
  }
}

export async function loggedIn(): Promise<boolean> {
  return (await probeLogin()).authed;
}

export function hasApiKey(): boolean {
  return Boolean(codexApiKey());
}

export function hasScopedCodexAuth(env?: Record<string, string>): boolean {
  const home = env?.["CODEX_HOME"];
  return Boolean(home && existsSync(join(home, "auth.json")));
}
