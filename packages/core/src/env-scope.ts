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
  // Google / Gemini, xAI, OpenRouter, Cursor
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "CURSOR_API_KEY",
  "CURSOR_API_URL",
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
