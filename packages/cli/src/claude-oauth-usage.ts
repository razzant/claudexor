import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "@claudexor/config";
import type { QuotaRefreshResult } from "@claudexor/daemon";
import { canonicalProfileConfigDir, defaultNativeClaudeConfigDir } from "@claudexor/harness-claude";
import {
  QuotaSnapshot as QuotaSnapshotSchema,
  type QuotaAbsence,
  type QuotaSnapshot,
} from "@claudexor/schema";
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
 * vendor store — the keychain item on macOS, the vendor's
 * `<configDir>/.credentials.json` (documented 0600 file store) elsewhere —
 * held transiently for exactly one usage request, and never persisted,
 * logged, or included in errors. A failing endpoint yields NO snapshot
 * (fail-to-unknown) and never degrades auth readiness.
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
 * class — never file bytes or a token (INV-062). */
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

function taggedRefreshFailure(detail: string): Error {
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
  platform: NodeJS.Platform;
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

function claudeOauthAbsence(
  subjectId: string | null,
  reason: QuotaAbsence["reason"],
  detail: string,
  observedAt: Date,
): QuotaAbsence {
  return {
    subject: {
      harness: "claude",
      credential_route: "vendor_native",
      plan_label: null,
      subject_id: subjectId,
    },
    reason,
    detail,
    observed_at: observedAt.toISOString(),
  };
}

/** One subject per logged-in config dir: the default native dir (subject null)
 * plus every enabled claude config_dir_login profile (subject = profile_id).
 * The PRIMARY claude source (release cut V11a) — it owns the claude subject
 * universe, so every candidate resolves to a snapshot OR a typed absence:
 * a null credential is not_logged_in (on macOS the keychain read cannot tell
 * a missing item from an unavailable keychain, so its detail states both; off
 * macOS a missing credential file IS the vendor's logged-out state), a store
 * read fault is the tagged reason it carries, and a fetch refusal is
 * refresh_failed. Absence is stated, never inferred. */
export async function refreshClaudeOauthUsageQuota(
  deps: Partial<ClaudeOauthUsageDeps> = {},
): Promise<QuotaRefreshResult> {
  const readCredential = deps.readCredential ?? readClaudeOauthCredential;
  const fetchUsage = deps.fetchUsage ?? fetchUsageDefault;
  const now = deps.now ?? (() => new Date());
  const platform = deps.platform ?? process.platform;
  const notLoggedInDetail =
    platform === "darwin"
      ? "no OAuth credential in the keychain item (no login, or the keychain tool is unavailable)"
      : "no vendor credential file in the config dir (not logged in)";
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
  const absences: QuotaAbsence[] = [];
  for (const candidate of candidates) {
    let credential: ClaudeOauthCredential | null;
    try {
      credential = await readCredential(candidate.configDir, platform);
    } catch (error) {
      const tagged = (error as { quotaAbsenceReason?: QuotaAbsence["reason"] })?.quotaAbsenceReason;
      absences.push(
        claudeOauthAbsence(
          candidate.subjectId,
          tagged ?? "refresh_failed",
          error instanceof Error ? error.message : String(error),
          now(),
        ),
      );
      continue;
    }
    if (!credential) {
      absences.push(
        claudeOauthAbsence(candidate.subjectId, "not_logged_in", notLoggedInDetail, now()),
      );
      continue;
    }
    try {
      const usage = await fetchUsage(credential.accessToken);
      const snapshot = parseClaudeOauthUsage(
        usage,
        candidate.subjectId,
        credential.subscriptionType,
        now(),
      );
      if (snapshot) snapshots.push(snapshot);
      else
        // BACKLOG Q-a (v3.0.3 S8): an HTTP 200 whose body parses to no quota
        // windows must yield a typed absence, never silent nothing — the
        // registry needs the observation to back off instead of re-polling.
        absences.push(
          claudeOauthAbsence(
            candidate.subjectId,
            "refresh_failed",
            "oauth/usage returned HTTP 200 without parseable quota windows",
            now(),
          ),
        );
    } catch (error) {
      absences.push(
        claudeOauthAbsence(
          candidate.subjectId,
          "refresh_failed",
          error instanceof Error ? error.message : String(error),
          now(),
        ),
      );
    }
  }
  return { snapshots, absences };
}
