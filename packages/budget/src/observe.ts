import type { BudgetObservation, HarnessEvent } from "@claudexor/schema";
import { nowIso } from "@claudexor/util";

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Project an observed budget/quota signal from a TYPED harness event. The budget
 * layer makes NO governance decisions by regex over model/CLI prose: rate-limit
 * detection lives in the adapter parse layer (where native-output translation is
 * legitimate) and arrives here as the typed `HarnessEvent.rate_limit` field.
 * Subscription balancing remains honest "observed best-effort", never exact-claimed.
 */
export function observationFromEvent(harnessId: string, ev: HarnessEvent): BudgetObservation | null {
  if (ev.type === "usage" && typeof ev.usage?.cost_usd === "number" && ev.usage.cost_usd > 0) {
    // Token-derived costs (e.g. codex) are honest estimates -> "observed"; only
    // natively-reported costs (e.g. claude) are "exact".
    const quality = ev.usage.estimated ? "observed" : "exact";
    return { harness_id: harnessId, ts: nowIso(), quality, kind: "spend", usd: ev.usage.cost_usd };
  }

  if (ev.quota) {
    // The CLI's own machine-readable window record (codex rollout
    // token_count.rate_limits) -> "native" quality used_percent observation.
    return {
      harness_id: harnessId,
      ts: nowIso(),
      quality: "native",
      kind: "used_percent",
      used_percent: ev.quota.used_percent,
      resets_at: ev.quota.resets_at ?? null,
    };
  }

  if (ev.rate_limit) {
    const resets = ev.rate_limit.resets_at ?? null;
    const delay = ev.rate_limit.retry_delay_ms ?? null;
    const cooldownUntil =
      resets ?? new Date(Date.now() + (typeof delay === "number" && delay > 0 ? delay : DEFAULT_COOLDOWN_MS)).toISOString();
    return {
      harness_id: harnessId,
      ts: nowIso(),
      quality: "observed",
      kind: "rate_limited",
      resets_at: resets,
      cooldown_until: cooldownUntil,
      detail: ev.error ?? undefined,
    };
  }

  return null;
}
