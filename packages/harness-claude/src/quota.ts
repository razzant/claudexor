import type { HarnessEvent, QuotaConstraint } from "@claudexor/schema";
import { claudeQuotaFamilyScope } from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";

type ObjectValue = Record<string, unknown>;

const WINDOWS = {
  five_hour: { label: "5 hour", seconds: 5 * 60 * 60, family: null },
  seven_day: { label: "7 day", seconds: 7 * 24 * 60 * 60, family: null },
  seven_day_opus: { label: "7 day (Opus)", seconds: 7 * 24 * 60 * 60, family: "Opus" },
  seven_day_sonnet: { label: "7 day (Sonnet)", seconds: 7 * 24 * 60 * 60, family: "Sonnet" },
} as const;

/** Stream utilization is a ratio, unlike the OAuth usage endpoint's percentage.
 * A native frame reports only its measured windows, not a subscription inventory.
 * Conditional/unknown scopes remain diagnostic: null applicability means ALL
 * models to existing consumers, so it cannot stand in for an unknown scope. */
export function claudeQuotaEvents(value: unknown, sessionId: string, ts: string): HarnessEvent[] {
  const info = object(value);
  if (!info) return [];
  const windows = new Map<string, ObjectValue>();
  const dominant = info["rateLimitType"];
  if (typeof dominant === "string") windows.set(dominant, info);
  for (const [id, window] of Object.entries(object(info["unifiedWindows"]) ?? {})) {
    const measurement = object(window);
    if (measurement) windows.set(id, measurement);
  }
  const events: HarnessEvent[] = [];
  for (const [id, window] of windows) {
    const ratio = window["utilization"];
    const usedRatio =
      typeof ratio === "number" && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1
        ? ratio
        : null;
    const resetsAt = claudeQuotaReset(window["resetsAt"]);
    if (usedRatio === null && resetsAt === null) continue;
    const definition = Object.hasOwn(WINDOWS, id) ? WINDOWS[id as keyof typeof WINDOWS] : null;
    const event: HarnessEvent = { type: "status", session_id: sessionId, ts };
    if (definition) {
      const constraint: QuotaConstraint = {
        id,
        label: definition.label,
        used_ratio: usedRatio,
        window_seconds: definition.seconds,
        resets_at: resetsAt,
        cooldown_until: null,
        ...(definition.family ? claudeQuotaFamilyScope(definition.family) : {}),
      };
      event.quota = {
        source: "claude_rate_limit_event",
        plan_label: null,
        subject_id: null,
        constraints: [constraint],
      };
    } else {
      event.payload = {
        native_quota: {
          source: "claude_rate_limit_event",
          window_id: redactSecrets(id).slice(0, 160),
          used_ratio: usedRatio,
          resets_at: resetsAt,
          applicability: "unknown",
        },
      };
    }
    events.push(event);
  }
  if (["overageStatus", "isUsingOverage", "overageDisabledReason"].some((key) => key in info)) {
    const event = events[0] ?? { type: "status" as const, session_id: sessionId, ts };
    event.account_usage = claudeOverageDiagnostics(info).map((d) => ({
      code: redactSecrets(d.code).slice(0, 160),
      detail: redactSecrets(d.detail).slice(0, 240),
    }));
    if (events.length === 0) events.push(event);
  }
  return events;
}

export function claudeQuotaReset(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : null;
}
import { claudeOverageDiagnostics } from "./account-resources.js";
