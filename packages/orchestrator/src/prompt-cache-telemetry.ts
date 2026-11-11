import type { HarnessEvent, PromptCacheTtlReceipt } from "@claudexor/schema";
import { observedPromptCacheTtl } from "@claudexor/schema";

export interface PromptCacheTelemetry {
  promptCacheTtl?: PromptCacheTtlReceipt;
  promptCacheSessions?: PromptCacheTtlReceipt[];
  currentPromptCache?: PromptCacheTtlReceipt;
}

/** Each native session stamps its own cumulative receipt. The attempt keeps
 * every finished session (retries, account hops) so a later session cannot
 * erase an earlier one's evidence; one session without the split leaves the
 * attempt's counts unknown. */
export function observePromptCacheTtl(t: PromptCacheTelemetry, event: HarnessEvent): void {
  if (event.prompt_cache_ttl) t.currentPromptCache = event.prompt_cache_ttl;
  const current = t.currentPromptCache;
  if (!current) return;
  const sessions = [...(t.promptCacheSessions ?? []), current];
  const sum = (key: "write_5m_tokens" | "write_1h_tokens"): number | null =>
    sessions.some((receipt) => receipt[key] === null)
      ? null
      : sessions.reduce((total, receipt) => total + (receipt[key] ?? 0), 0);
  const write5m = sum("write_5m_tokens");
  const write1h = sum("write_1h_tokens");
  const reasons = [...new Set(sessions.flatMap((receipt) => receipt.reason ?? []))];
  t.promptCacheTtl = {
    ...current,
    reason: reasons.length > 0 ? reasons.join("; ") : null,
    observed: observedPromptCacheTtl(write5m, write1h),
    write_5m_tokens: write5m,
    write_1h_tokens: write1h,
  };
  if (event.type === "completed") {
    (t.promptCacheSessions ??= []).push(current);
    t.currentPromptCache = undefined;
  }
}
