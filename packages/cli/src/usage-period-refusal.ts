import { accountUsageAllowance } from "@claudexor/config";
import {
  USAGE_PERIOD_CONSTRAINT_ID,
  usagePeriodAt,
  type GlobalConfig,
  type HarnessEvent,
} from "@claudexor/schema";

/**
 * A typed usage refusal that names no reopening time (`reopening: unknown`),
 * on an account whose operator configured a usage allowance: the refused
 * allowance returns when its period does, so the refusal is dated to the end
 * of the current period and the account comes back to routing by itself then.
 *
 * It reads only the typed signal and the account's configuration, for any
 * harness. Without an allowance, or for a refusal the vendor dated itself,
 * the event passes unchanged and keeps the engine's bounded recheck.
 */
export function dateUsageRefusal(
  harnessId: string,
  event: HarnessEvent,
  config: Pick<GlobalConfig, "credential_profiles" | "routing">,
  now: number = Date.now(),
): HarnessEvent {
  const limit = event.rate_limit;
  if (limit?.reopening !== "unknown" || limit.resets_at) return event;
  const profileId = event.credential_profile_id ?? null;
  const profile = config.credential_profiles.find(
    (row) => row.harness_id === harnessId && row.profile_id === profileId,
  );
  const allowance = profile && accountUsageAllowance(profile, config.routing.account_tiers);
  const period = allowance ? usagePeriodAt(allowance, now) : null;
  if (!period) return event;
  const { reopening: _reopening, ...dated } = limit;
  return {
    ...event,
    rate_limit: {
      ...dated,
      constraint_id: USAGE_PERIOD_CONSTRAINT_ID,
      resets_at: new Date(period.end).toISOString(),
    },
  };
}
