import { CLAUDE_KEYCHAIN_BRIDGE_ENV } from "./native-home.js";

/**
 * The honest native-login remedy for Claude doctor reasons (INV-067).
 *
 * Native setup is the product path. Scoped macOS runs receive a Claude-only
 * Keychain bridge; if that bridge cannot be prepared, disclose the
 * infrastructure cause instead of claiming the user is logged out.
 */
export function claudeNativeLoginRemedy(
  env: Record<string, string | null | undefined> | undefined,
): string {
  if (env?.[CLAUDE_KEYCHAIN_BRIDGE_ENV] === "unavailable") {
    return "the scoped Claude process could not bridge the macOS login Keychain — reopen Claudexor and retry Native setup, or configure an API key fallback";
  }
  return "open Settings → Harnesses → Claude → Manage and run Native setup (or run `claude auth login --claudeai`), or configure an API key fallback";
}
