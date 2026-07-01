import { harnessRuntimeEnv } from "./runtime-env.js";

/**
 * Declarative env-scrub SSOT for harness children.
 *
 * Previously each adapter hand-rolled a partial denylist: codex scrubbed only
 * OpenAI vars, claude only Anthropic/AWS/Google, cursor only its base-URL. The
 * result was a cross-provider credential LEAK — a codex child inherited the
 * user's `ANTHROPIC_API_KEY`, a claude child inherited `OPENAI_API_KEY`, etc.
 *
 * The contract is now uniform: scrub EVERY known provider credential / redirect
 * env var from a harness child, then have the adapter re-add ONLY the single
 * variable its chosen auth route legitimately needs (after the scrub). Base-URL
 * redirects are always scrubbed so a redirect can never exfiltrate a seeded
 * credential.
 */
export const PROVIDER_SECRET_ENV: readonly string[] = [
  // OpenAI / Codex
  "OPENAI_API_KEY",
  "OPENAI_ORG",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT",
  "OPENAI_PROJECT_ID",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "CLAUDEXOR_CODEX_API_KEY",
  // Anthropic / Claude
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLAUDEXOR_ANTHROPIC_API_KEY",
  // Cloud provider creds reachable by Bedrock/Vertex routing
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
  // Google / Gemini, xAI, OpenRouter, Cursor, OpenCode
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "CURSOR_API_KEY",
  "CLAUDEXOR_CURSOR_API_KEY",
  "CURSOR_API_URL",
  "OPENCODE_API_KEY",
  // Raw OpenAI-compatible API harness
  "CLAUDEXOR_RAWAPI_KEY",
  "CLAUDEXOR_RAWAPI_BASE_URL",
  // Other providers harness CLIs can read (third-party routers / clouds)
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_BASE",
];

/**
 * Build an env patch (`{VAR: null}`) that scrubs every provider secret EXCEPT the
 * ones in `keep` (the vars the adapter's chosen route legitimately uses, which it
 * sets explicitly afterward). Apply this AFTER spreading `spec.env`.
 */
export function providerScrubEnv(keep: readonly string[] = []): Record<string, null> {
  const keepSet = new Set(keep);
  const out: Record<string, null> = {};
  for (const name of PROVIDER_SECRET_ENV) {
    if (!keepSet.has(name)) out[name] = null;
  }
  return out;
}

/**
 * Minimal env an interactive CLI genuinely needs to run (locale, terminal, temp,
 * and PATH to find its own binary + tools). Everything else is dropped under
 * `env_inheritance: "clean"` — agent env isolation. Exact var values still come
 * from the parent; only the KEY SET is restricted. Provider secrets are NOT in
 * the allowlist (defense-in-depth on top of providerScrubEnv), and the adapter
 * re-adds its single chosen credential explicitly afterward.
 */
export const CLEAN_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TZ",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LANGUAGE",
  // Node/runtime discovery the spawned CLI may itself need to locate a runtime.
  "NODE_PATH",
  "NVM_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "SYSTEMROOT", // Windows CLIs fail to start without it
  // Proxy + TLS trust: NOT provider secrets, but a harness behind a corporate
  // proxy / custom CA loses egress and TLS trust without them — `clean` must keep
  // the network path working. (Both cases: curl/openssl read lower, Node reads upper.)
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
];

/**
 * Build the base child env for a given inheritance mode. `mirror_native` copies
 * the parent env (the native CLIs' default); `clean` copies only the minimal
 * allowlist (agent isolation). The adapter's `spec.env` overrides + the
 * providerScrubEnv patch are applied ON TOP of this by the spawn layer.
 */
export function composeBaseEnv(
  inheritance: "mirror_native" | "clean",
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const normalizedSource = harnessRuntimeEnv(source);
  if (inheritance !== "clean") return normalizedSource;
  const out: NodeJS.ProcessEnv = {};
  for (const key of CLEAN_ENV_ALLOWLIST) {
    const value = normalizedSource[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
