import { harnessRuntimeEnv } from "./runtime-env.js";
import { inheritedScopeMarkers } from "./process-scope.js";

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
  "CODEX_ACCESS_TOKEN",
  "CLAUDEXOR_CODEX_API_KEY",
  // Anthropic / Claude
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "CLAUDEXOR_ANTHROPIC_API_KEY",
  // Cloud provider creds reachable by Bedrock/Vertex routing
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
  // Azure credentials and route selectors reachable by Foundry auth.
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_TENANT_ID",
  "AZURE_SUBSCRIPTION_ID",
  "AZURE_FEDERATED_TOKEN_FILE",
  "AZURE_AUTHORITY_HOST",
  "AZURE_TOKEN_CREDENTIALS",
  "AZURE_CONFIG_DIR",
  // Google / Gemini, xAI, OpenRouter, Cursor, OpenCode
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "XAI_API_KEY",
  "XAI_BASE_URL",
  "XAI_API_BASE_URL",
  "GROK_API_KEY",
  "GROK_API_BASE_URL",
  "GROK_CLI_CHAT_PROXY_BASE_URL",
  "GROK_CODE_XAI_API_KEY",
  "GROK_XAI_API_BASE_URL",
  "GROK_MODELS_BASE_URL",
  "GROK_MODELS_LIST_URL",
  // Grok login selectors: another credential, login store, deployment key,
  // token helper or identity provider would replace a named profile's own
  // grok.com login (documented in the Grok Build user guide).
  "GROK_AUTH",
  "GROK_AUTH_PATH",
  "GROK_DEPLOYMENT_KEY",
  "GROK_AUTH_PROVIDER_COMMAND",
  "GROK_OIDC_ISSUER",
  "GROK_OIDC_CLIENT_ID",
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
 * Windows' default process environment: machine identity, standard folders and
 * shell/runtime discovery. One owner for every scrubbed Windows spawn, including
 * vendor installers. These are OS inputs, not provider secrets or vendor homes.
 * Standard variables: https://learn.microsoft.com/windows/win32/api/shellapi/nf-shellapi-doenvironmentsubsta
 * Architecture/folders: https://learn.microsoft.com/windows/win32/winprog64/wow64-implementation-details
 * PowerShell: https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_environment_variables
 * Match case-insensitively; Windows does not impose a spelling on inherited keys.
 */
export const WINDOWS_RUNTIME_ENV_KEYS: readonly string[] = [
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "OS",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_ARCHITEW6432",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "PROGRAMDATA",
  "ALLUSERSPROFILE",
  "PUBLIC",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "COMPUTERNAME",
  "LOGONSERVER",
  "USERDOMAIN",
  "USERNAME",
  "PSMODULEPATH",
];

/**
 * Copy allowlisted keys out of `source`. Windows spells its own variables
 * `SystemRoot`, `ComSpec`, `windir`, and a plain object copy of `process.env`
 * loses the case-insensitive lookup the live object has, so there the match is
 * case-insensitive and the value lands under the canonical spelling (Windows
 * is case-insensitive at CreateProcess). On POSIX, where `http_proxy` and
 * `HTTP_PROXY` are genuinely different variables, the match stays exact.
 */
export function pickAllowlistedEnv(
  source: NodeJS.ProcessEnv,
  keys: readonly string[],
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const insensitive =
    platform === "win32"
      ? new Map(Object.entries(source).map(([key, value]) => [key.toUpperCase(), value]))
      : null;
  const out: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = source[key] ?? insensitive?.get(key.toUpperCase());
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Build the base child env for a given inheritance mode. `mirror_native` copies
 * the parent env (the native CLIs' default); `clean` copies only the minimal
 * allowlist (agent isolation) PLUS every inherited scope marker: custody is not
 * a secret and not a preference — an enclosing custodian (the host that started
 * this daemon) must be able to end what it owns however the child env is
 * composed, so names matching the shared marker grammar (`process-scope.ts`)
 * with value `1` are forwarded in both modes. The adapter's `spec.env`
 * overrides + the providerScrubEnv patch are applied ON TOP of this by the
 * spawn layer.
 */
export function composeBaseEnv(
  inheritance: "mirror_native" | "clean",
  source: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const normalizedSource = harnessRuntimeEnv(source, execPath, platform);
  if (inheritance !== "clean") return normalizedSource;
  return {
    ...pickAllowlistedEnv(normalizedSource, CLEAN_ENV_ALLOWLIST, platform),
    ...(platform === "win32"
      ? pickAllowlistedEnv(normalizedSource, WINDOWS_RUNTIME_ENV_KEYS, platform)
      : {}),
    ...inheritedScopeMarkers(normalizedSource),
  };
}

/** Apply the run patch once, after baseline PATH/OS identity preparation. */
export function composeSpawnEnv(
  inheritance: "mirror_native" | "clean" = "mirror_native",
  patch: Record<string, string | null | undefined> = {},
): NodeJS.ProcessEnv {
  const env = composeBaseEnv(inheritance);
  for (const [key, value] of Object.entries(patch)) {
    if (process.platform === "win32")
      for (const existing of Object.keys(env)) {
        if (existing.toUpperCase() === key.toUpperCase()) delete env[existing];
      }
    if (value === null || value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}
