import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { QuotaAbsence } from "@claudexor/schema";
import { sha256 } from "@claudexor/util";

/** Vendor formula, live-verified: `Claude Code-credentials-<sha256(configDir)[:8]>`. */
export function claudeOauthKeychainItem(configDir: string): string {
  return `Claude Code-credentials-${sha256(configDir).replace("sha256:", "").slice(0, 8)}`;
}

export interface ClaudeOauthCredential {
  accessToken: string;
  subscriptionType: string | null;
  expiresAtMs: number | null;
  hasRefreshToken: boolean;
  scopes?: string[];
}

const execFileAsync = promisify(execFile);

/** Read the profile's OAuth credential from the vendor's own store: the
 * profile-keyed keychain item on macOS (`security`), or the vendor's
 * `<configDir>/.credentials.json` everywhere else — Linux has no keychain. */
export async function readClaudeOauthCredential(
  configDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ClaudeOauthCredential | null> {
  if (platform !== "darwin") return readClaudeOauthCredentialFile(configDir);
  try {
    const { stdout } = await execFileAsync(
      "security",
      [
        "find-generic-password",
        "-s",
        claudeOauthKeychainItem(configDir),
        "-a",
        userInfo().username,
        "-w",
      ],
      { timeout: 5_000, maxBuffer: 1024 * 1024 },
    );
    return parseClaudeOauthCredential(stdout);
  } catch {
    return null; // no item / locked keychain — honest absence
  }
}

/** The non-macOS vendor store (`.credentials.json`, documented mode 0600).
 * A missing file is the honest logged-out null; a present-but-unreadable or
 * unparseable file throws a reason-tagged error carrying only the error
 * class — never file bytes or a token (INV-146). */
async function readClaudeOauthCredentialFile(
  configDir: string,
): Promise<ClaudeOauthCredential | null> {
  let raw: string;
  try {
    raw = await readFile(join(configDir, ".credentials.json"), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw taggedRefreshFailure(`credential file unreadable (${code ?? "io_error"})`);
  }
  const credential = parseClaudeOauthCredential(raw);
  if (credential === null) {
    throw taggedRefreshFailure("credential file did not parse as a vendor credential");
  }
  return credential;
}

export function taggedRefreshFailure(detail: string): Error {
  return Object.assign(new Error(detail), {
    quotaAbsenceReason: "refresh_failed" as QuotaAbsence["reason"],
  });
}

/** Accepts both credential shapes seen in the wild: flat and `{claudeAiOauth}`. */
export function parseClaudeOauthCredential(raw: string): ClaudeOauthCredential | null {
  try {
    const parsed = JSON.parse(raw.trim()) as Record<string, unknown>;
    const body = (
      parsed["claudeAiOauth"] && typeof parsed["claudeAiOauth"] === "object"
        ? parsed["claudeAiOauth"]
        : parsed
    ) as Record<string, unknown>;
    const token = body["accessToken"];
    if (typeof token !== "string" || token.length === 0) return null;
    return {
      accessToken: token,
      subscriptionType:
        typeof body["subscriptionType"] === "string" ? body["subscriptionType"] : null,
      expiresAtMs:
        typeof body["expiresAt"] === "number" && Number.isFinite(body["expiresAt"])
          ? body["expiresAt"]
          : null,
      hasRefreshToken: typeof body["refreshToken"] === "string" && body["refreshToken"].length > 0,
      scopes: Array.isArray(body["scopes"])
        ? body["scopes"].filter((s): s is string => typeof s === "string")
        : undefined,
    };
  } catch {
    return null;
  }
}

/** Native organization binding, read only from the selected canonical store. */
export async function readClaudeOauthOrganization(
  configDir: string,
): Promise<{ organizationUuid: string; accountUuid: string | null } | null> {
  try {
    const value = JSON.parse(await readFile(join(configDir, ".claude.json"), "utf8"))?.oauthAccount;
    return typeof value?.organizationUuid === "string" && value.organizationUuid.length > 0
      ? {
          organizationUuid: value.organizationUuid,
          accountUuid: typeof value.accountUuid === "string" ? value.accountUuid : null,
        }
      : null;
  } catch {
    return null;
  }
}
