import {
  brokenInstallAdvisory,
  normalizedHarnessPath,
  resolveHarnessCommandOnPath,
} from "@claudexor/core";
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
  return "open Accounts → Claude → Login (or Settings → Harnesses → Claude → Manage), then complete Native setup; alternatively configure an API key fallback";
}

/** Describe the same entrypoint whose version/help probe uses this PATH. */
export function claudeInstallation(
  binary: string,
  patchPath?: string,
): { path: string | null; advisory: string | null; refusal?: string } {
  const selected = resolveHarnessCommandOnPath(binary, patchPath ?? normalizedHarnessPath());
  return {
    path: selected.command?.entrypoint ?? null,
    advisory:
      selected.advisory ??
      (patchPath === undefined && !selected.command ? brokenInstallAdvisory(binary) : null),
    // The probes' launch was refused before spawning: name that file, not "not found".
    ...(selected.refusal ? { refusal: selected.refusal.message } : {}),
  };
}

/** Why claude answered no `--version`: the refused launch names its file;
 * otherwise the caller's not-found wording with any install evidence. */
export function claudeMissingDetail(
  installation: { advisory: string | null; refusal?: string },
  notFound: string,
): string {
  return installation.refusal ?? [notFound, installation.advisory].filter(Boolean).join(" — ");
}
