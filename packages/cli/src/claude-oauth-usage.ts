import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import { loadConfig } from "@claudexor/config";
import { canonicalProfileConfigDir, defaultNativeClaudeConfigDir } from "@claudexor/harness-claude";
import { QuotaSnapshot as QuotaSnapshotSchema, type QuotaSnapshot } from "@claudexor/schema";
import { noProjectRepoRoot, sha256 } from "@claudexor/util";

const SOURCE = "claude_oauth_usage" as const;
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
const FETCH_TIMEOUT_MS = 10_000;

/**
 * The PRIMARY subscription-quota source (W5.3, live-proven 2026-07-17):
 * `GET api.anthropic.com/api/oauth/usage` with a profile's OAuth access token
 * returns proactive five_hour/seven_day utilization — the stream's rate-limit
 * signals arrive only reactively, AFTER a limit bites.
 *
 * Security (INV-062 class): the access token is read from the profile's OWN
 * keychain item, held transiently for exactly one usage request, and never
 * persisted, logged, or included in errors. A failing endpoint yields NO
 * snapshot (fail-to-unknown) and never degrades auth readiness.
 */

/** Vendor formula, live-verified: `Claude Code-credentials-<sha256(configDir)[:8]>`. */
export function claudeOauthKeychainItem(configDir: string): string {
  return `Claude Code-credentials-${sha256(configDir).replace("sha256:", "").slice(0, 8)}`;
}

export interface ClaudeOauthCredential {
  accessToken: string;
  subscriptionType: string | null;
}

const execFileAsync = promisify(execFile);

/** Read the profile's OAuth credential from ITS keychain item (macOS `security`). */
export async function readClaudeOauthCredential(
  configDir: string,
): Promise<ClaudeOauthCredential | null> {
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
    return null; // no item / not macOS / locked keychain — honest absence
  }
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
    };
  } catch {
    return null;
  }
}

/** Pure mapping of the oauth/usage response onto QuotaSnapshot (testable). */
export function parseClaudeOauthUsage(
  value: unknown,
  subjectId: string | null,
  planLabel: string | null,
  observedAt = new Date(),
): QuotaSnapshot | null {
  const root = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!root) return null;
  const constraints = [
    windowConstraint(root["five_hour"], "five_hour", "5 hour", 5 * 60 * 60),
    windowConstraint(root["seven_day"], "seven_day", "7 day", 7 * 24 * 60 * 60),
    ...scopedConstraints(root["limits"]),
  ].filter((item) => item !== null);
  if (constraints.length === 0) return null;
  return QuotaSnapshotSchema.parse({
    subject: {
      harness: "claude",
      credential_route: "vendor_native",
      plan_label: planLabel,
      subject_id: subjectId,
    },
    constraints,
    source: SOURCE,
    observed_at: observedAt.toISOString(),
    freshness: "fresh",
  });
}

function windowConstraint(
  value: unknown,
  id: string,
  label: string,
  windowSeconds: number,
): Record<string, unknown> | null {
  const window = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!window) return null;
  const utilization = window["utilization"];
  if (typeof utilization !== "number") return null;
  return {
    id,
    label,
    used_ratio: Math.min(Math.max(utilization / 100, 0), 1),
    window_seconds: windowSeconds,
    resets_at: typeof window["resets_at"] === "string" ? window["resets_at"] : null,
    cooldown_until: null,
  };
}

/** Per-model scoped weekly limits ride as extra constraints (label carries the model). */
function scopedConstraints(value: unknown): Array<Record<string, unknown> | null> {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const limit = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
    if (!limit || limit["kind"] !== "weekly_scoped") return null;
    const percent = limit["percent"];
    if (typeof percent !== "number") return null;
    const scope = limit["scope"] as Record<string, unknown> | undefined;
    const model = scope?.["model"] as Record<string, unknown> | undefined;
    const name = typeof model?.["display_name"] === "string" ? model["display_name"] : "scoped";
    return {
      id: `weekly_scoped:${name}`,
      label: `7 day (${name})`,
      used_ratio: Math.min(Math.max(percent / 100, 0), 1),
      window_seconds: 7 * 24 * 60 * 60,
      resets_at: typeof limit["resets_at"] === "string" ? limit["resets_at"] : null,
      cooldown_until: null,
    };
  });
}

export interface ClaudeOauthUsageDeps {
  readCredential: typeof readClaudeOauthCredential;
  fetchUsage: (accessToken: string) => Promise<unknown>;
  now: () => Date;
}

async function fetchUsageDefault(accessToken: string): Promise<unknown> {
  const res = await fetch(USAGE_URL, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "anthropic-beta": OAUTH_BETA_HEADER,
      accept: "application/json",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`oauth/usage responded ${res.status}`);
  return res.json();
}

/** One subject per logged-in config dir: the default native dir (subject null)
 * plus every enabled claude config_dir_login profile (subject = profile_id). */
export async function refreshClaudeOauthUsageQuota(
  deps: Partial<ClaudeOauthUsageDeps> = {},
): Promise<QuotaSnapshot[]> {
  const readCredential = deps.readCredential ?? readClaudeOauthCredential;
  const fetchUsage = deps.fetchUsage ?? fetchUsageDefault;
  const now = deps.now ?? (() => new Date());
  const candidates: Array<{ subjectId: string | null; configDir: string }> = [
    { subjectId: null, configDir: defaultNativeClaudeConfigDir() },
  ];
  for (const profile of loadConfig(noProjectRepoRoot()).global.credential_profiles) {
    if (profile.harness_id !== "claude" || !profile.enabled) continue;
    if (profile.credential_kind !== "config_dir_login" || !profile.isolation_locator) continue;
    try {
      candidates.push({
        subjectId: profile.profile_id,
        configDir: canonicalProfileConfigDir(profile.isolation_locator),
      });
    } catch {
      /* a mis-registered locator is a doctor problem, not a quota crash */
    }
  }
  const snapshots: QuotaSnapshot[] = [];
  for (const candidate of candidates) {
    const credential = await readCredential(candidate.configDir);
    if (!credential) continue;
    try {
      const usage = await fetchUsage(credential.accessToken);
      const snapshot = parseClaudeOauthUsage(
        usage,
        candidate.subjectId,
        credential.subscriptionType,
        now(),
      );
      if (snapshot) snapshots.push(snapshot);
    } catch {
      /* endpoint refusal = no snapshot; NEVER an auth-readiness signal */
    }
  }
  if (snapshots.length === 0) {
    throw new Error("Claude oauth/usage quota is not available (no logged-in subject responded)");
  }
  return snapshots;
}
