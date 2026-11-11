import {
  QuotaSnapshot as QuotaSnapshotSchema,
  claudeQuotaFamilyScope,
  type QuotaSnapshot,
} from "@claudexor/schema";

/** A measured window whose model scope the vendor did not name. */
export interface UnknownQuotaScope {
  id: string;
  used_ratio: number;
  resets_at: string | null;
}

/** Pure mapping of the oauth/usage response onto QuotaSnapshot (testable). A
 * weekly_scoped limit without a recognizable family is reported to
 * `onUnknownScope` and never becomes an account-wide constraint. */
export function parseClaudeOauthUsage(
  value: unknown,
  subjectId: string | null,
  planLabel: string | null,
  observedAt = new Date(),
  onUnknownScope?: (window: UnknownQuotaScope) => void,
): QuotaSnapshot | null {
  const root = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!root) return null;
  const constraints = [
    windowConstraint(root["five_hour"], "five_hour", "5 hour", 5 * 60 * 60),
    windowConstraint(root["seven_day"], "seven_day", "7 day", 7 * 24 * 60 * 60),
    ...scopedConstraints(root["limits"], onUnknownScope),
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
    source: "claude_oauth_usage",
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
function scopedConstraints(
  value: unknown,
  onUnknownScope?: (window: UnknownQuotaScope) => void,
): Array<Record<string, unknown> | null> {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const limit = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
    if (!limit || limit["kind"] !== "weekly_scoped") return null;
    const percent = limit["percent"];
    if (typeof percent !== "number") return null;
    const scope = limit["scope"] as Record<string, unknown> | undefined;
    const model = scope?.["model"] as Record<string, unknown> | undefined;
    const displayName =
      typeof model?.["display_name"] === "string" ? model["display_name"].trim() : "";
    const name = displayName || "scoped";
    const familyScope = claudeQuotaFamilyScope(displayName);
    const window = {
      id: `weekly_scoped:${name}`,
      used_ratio: Math.min(Math.max(percent / 100, 0), 1),
      resets_at: typeof limit["resets_at"] === "string" ? limit["resets_at"] : null,
    };
    if (!familyScope) {
      onUnknownScope?.(window);
      return null;
    }
    return {
      ...window,
      label: `7 day (${name})`,
      ...familyScope,
      window_seconds: 7 * 24 * 60 * 60,
      cooldown_until: null,
    };
  });
}
