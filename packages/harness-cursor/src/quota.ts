import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CredentialProfile } from "@claudexor/schema";
import { cursorProfilePathEnv } from "./profile.js";

export class CursorDashboardError extends Error {
  constructor(
    readonly reason:
      | "credential_binding_unavailable"
      | "transport_failed"
      | "http_refused"
      | "invalid_content_type"
      | "invalid_json",
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(`cursor_dashboard_${reason}${status === null ? "" : `_${status}`}`);
  }
}

/** One bounded dashboard read using only this named row's vendor file store.
 * No OAuth refresh, keychain access, login or credential persistence. Internal
 * dashboard failures do not establish execution-auth failure. Never includes
 * provider bodies, paths, identity or secrets in an error. */
export async function readCursorDashboard(
  profile: CredentialProfile,
  request: typeof fetch = fetch,
  platform: NodeJS.Platform = process.platform,
): Promise<unknown> {
  let accessToken: string, sub: string;
  try {
    if (
      profile.harness_id !== "cursor" ||
      profile.credential_kind !== "config_dir_login" ||
      !profile.isolation_locator
    )
      throw new Error();
    const env = cursorProfilePathEnv(profile.isolation_locator);
    // Vendor file-store resolver (2026.08.11-e8db854): auth follows the OS
    // selector, while cli-config follows CURSOR_CONFIG_DIR on every platform.
    // Both selectors come from the named profile, never the host environment.
    const authDir =
      platform === "win32"
        ? join(env.APPDATA!, "Cursor")
        : platform === "darwin"
          ? join(env.HOME!, ".cursor")
          : join(env.XDG_CONFIG_HOME!, "cursor");
    const auth = JSON.parse(readFileSync(join(authDir, "auth.json"), "utf8"));
    const config = JSON.parse(
      readFileSync(join(env.CURSOR_CONFIG_DIR!, "cli-config.json"), "utf8"),
    );
    accessToken = auth.accessToken;
    if (typeof accessToken !== "string" || !accessToken) throw new Error();
    const body = accessToken.split(".")[1];
    const claims = JSON.parse(Buffer.from(body ?? "", "base64url").toString("utf8"));
    sub = claims.sub;
    if (typeof sub !== "string" || !sub || sub !== config.authInfo?.authId) throw new Error();
  } catch {
    throw new CursorDashboardError("credential_binding_unavailable");
  }
  let response: Response;
  try {
    response = await request("https://cursor.com/api/usage-summary", {
      headers: {
        Cookie: `WorkosCursorSessionToken=${encodeURIComponent(sub + "::" + accessToken)}`,
        Accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new CursorDashboardError("transport_failed");
  }
  if (!response.ok) {
    const retry = response.headers.get("retry-after");
    const delay =
      retry && /^\d+$/.test(retry)
        ? Number(retry) * 1000
        : retry
          ? Date.parse(retry) - Date.now()
          : null;
    throw new CursorDashboardError(
      "http_refused",
      response.status,
      delay !== null && Number.isFinite(delay) ? Math.max(0, delay) : null,
    );
  }
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new CursorDashboardError("invalid_content_type");
  try {
    return await response.json();
  } catch {
    throw new CursorDashboardError("invalid_json");
  }
}
