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
/**
 * ONE event can carry SEVERAL budget signals (a codex usage event carries
 * both an estimated cost AND its rollout quota record) — returning a single
 * observation dropped the quota for exactly the real codex shape. Callers
 * observe every entry.
 */
export function observationsFromEvent(harnessId: string, ev: HarnessEvent): BudgetObservation[] {
  const out: BudgetObservation[] = [];
  // The credential subject rides EVERY observation (round-17 #2): a profiled
  // run's rate-limit/quota signal belongs to that profile's account, and an
  // unstamped observation would penalize the whole harness — profile B and
  // the engine default included.
  const subject = {
    ...(ev.credential_route ? { credential_route: ev.credential_route } : {}),
    subject_id: ev.credential_profile_id ?? null,
  };
  if (ev.type === "usage" && typeof ev.usage?.cost_usd === "number" && ev.usage.cost_usd > 0) {
    // Token-derived costs (e.g. codex) are honest estimates -> "observed"; only
    // natively-reported costs (e.g. claude) are "exact".
    const quality = ev.usage.estimated ? "observed" : "exact";
    out.push({
      harness_id: harnessId,
      ...subject,
      ts: nowIso(),
      quality,
      kind: "spend",
      usd: ev.usage.cost_usd,
    });
  }
  if (ev.quota) {
    for (const constraint of ev.quota.constraints) {
      out.push({
        harness_id: harnessId,
        ...subject,
        ts: nowIso(),
        quality: "native",
        kind: "quota_constraint",
        constraint_id: constraint.id,
        used_ratio: constraint.used_ratio,
        window_seconds: constraint.window_seconds,
        resets_at: constraint.resets_at,
        cooldown_until: constraint.cooldown_until,
      });
    }
  }
  const single = singleObservationFromEvent(harnessId, ev);
  if (single) out.push({ ...single, ...subject });
  return out;
}

function singleObservationFromEvent(harnessId: string, ev: HarnessEvent): BudgetObservation | null {
  if (ev.rate_limit) {
    const resets = ev.rate_limit.resets_at ?? null;
    const delay = ev.rate_limit.retry_delay_ms ?? null;
    const cooldownUntil =
      resets ??
      new Date(
        Date.now() + (typeof delay === "number" && delay > 0 ? delay : DEFAULT_COOLDOWN_MS),
      ).toISOString();
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
