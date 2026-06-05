import type { BudgetObservation, HarnessEvent } from "@claudex/schema";
import { nowIso } from "@claudex/util";

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

// Conservative rate-limit/quota detector: requires real rate-limit phrasing or an HTTP-429
// context, so an unrelated error that merely contains "429" or "quota" does not trip a cooldown.
const RATE_LIMIT_RE =
  /rate.?limit|usage.?limit|usagelimitexceeded|too many requests|quota[ _-]?(?:exceeded|exhausted|reached)|(?:http|status|code)[ :/]?429|429 too many/i;

/**
 * Best-effort extraction of an observed budget/quota signal from a harness event.
 * This is adapter-output parsing of stable signals (allowed), not governance —
 * subscription balancing is honest "observed best-effort", never exact-claimed.
 */
export function observationFromEvent(harnessId: string, ev: HarnessEvent): BudgetObservation | null {
  if (ev.type === "usage" && typeof ev.usage?.cost_usd === "number" && ev.usage.cost_usd > 0) {
    // Token-derived costs (e.g. codex) are honest estimates -> "observed"; only
    // natively-reported costs (e.g. claude) are "exact".
    const quality = ev.usage.estimated ? "observed" : "exact";
    return { harness_id: harnessId, ts: nowIso(), quality, kind: "spend", usd: ev.usage.cost_usd };
  }

  if (ev.type === "error" && RATE_LIMIT_RE.test(ev.error ?? "")) {
    const resets = typeof ev.payload?.["resets_at"] === "string" ? (ev.payload["resets_at"] as string) : null;
    return {
      harness_id: harnessId,
      ts: nowIso(),
      quality: "observed",
      kind: "rate_limited",
      resets_at: resets,
      cooldown_until: resets ?? new Date(Date.now() + DEFAULT_COOLDOWN_MS).toISOString(),
      detail: ev.error,
    };
  }

  if (ev.type === "thinking" && ev.payload?.["api_retry"] === true) {
    const err = String(ev.payload["error"] ?? "");
    if (/rate_limit|overloaded/i.test(err)) {
      const delay = Number(ev.payload["retry_delay_ms"] ?? 0);
      return {
        harness_id: harnessId,
        ts: nowIso(),
        quality: "observed",
        kind: "rate_limited",
        cooldown_until: new Date(Date.now() + (delay > 0 ? delay : DEFAULT_COOLDOWN_MS)).toISOString(),
        detail: err,
      };
    }
  }

  return null;
}
