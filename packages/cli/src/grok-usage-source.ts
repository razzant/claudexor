import { join } from "node:path";
import { accountUsageAllowance, loadConfigCached } from "@claudexor/config";
import type { QuotaRefreshCycle, QuotaRefreshResult } from "@claudexor/daemon";
import {
  canonicalGrokProfileHome,
  readGrokUsageSpend,
  type GrokUsageSpend,
} from "@claudexor/harness-grok";
import {
  USAGE_PERIOD_CONSTRAINT_ID,
  usagePeriodAt,
  type AccountTierPolicy,
  type CredentialProfile,
  type QuotaAbsence,
  type QuotaSnapshot,
  type QuotaSubject,
} from "@claudexor/schema";
import { noProjectRepoRoot } from "@claudexor/util";

/**
 * Grok quota (source `grok_local_usage`): spend summed from the Grok CLI's own
 * local usage records against the account's configured allowance, published as
 * one ordinary quota window. Grok's usage endpoint can report nothing spent
 * until the vendor refuses outright, so it is not asked.
 *
 * The window has the same shape every other source feeds: a used ratio, a
 * length and a reset at the end of the allowance period. Nothing downstream
 * knows where the number came from. An account with no allowance has no
 * window and creates no refresh demand; a reading that cannot be completed is
 * a typed absence, never a smaller number.
 */
export async function refreshGrokUsageQuota(
  options: {
    profiles?: readonly CredentialProfile[];
    policy?: Pick<AccountTierPolicy, "allowances">;
    read?: typeof readGrokUsageSpend;
    now?: () => Date;
  } = {},
  cycle?: QuotaRefreshCycle,
): Promise<QuotaRefreshResult> {
  const global =
    options.profiles && options.policy ? null : loadConfigCached(noProjectRepoRoot()).global;
  const profiles = options.profiles ?? global?.credential_profiles ?? [];
  const policy = options.policy ?? global?.routing.account_tiers;
  const now = options.now ?? (() => new Date());
  const snapshots: QuotaSnapshot[] = [];
  const absences: QuotaAbsence[] = [];
  for (const profile of profiles) {
    if (profile.harness_id !== "grok" || profile.credential_kind !== "config_dir_login") continue;
    if (
      cycle?.target
        ? cycle.target.harness !== "grok" || cycle.target.profile_id !== profile.profile_id
        : !profile.enabled
    )
      continue;
    const allowance = accountUsageAllowance(profile, policy);
    if (!allowance) continue;
    const subject: QuotaSubject = {
      harness: "grok",
      credential_route: "vendor_native",
      plan_label: null,
      subject_id: profile.profile_id,
    };
    if (cycle?.shouldRefresh?.(subject) === false) continue;
    const at = now();
    const absent = (detail: string) =>
      absences.push({
        subject,
        reason: "refresh_failed",
        detail,
        observed_at: at.toISOString(),
      });
    const period = usagePeriodAt(allowance, at.getTime());
    if (!period) {
      absent(`the usage allowance period starts at ${allowance.period_start}`);
      continue;
    }
    let spend: GrokUsageSpend;
    try {
      const home = canonicalGrokProfileHome(profile.isolation_locator ?? "");
      spend = await (options.read ?? readGrokUsageSpend)(join(home, ".grok"), period);
    } catch {
      absent("the local Grok usage records could not be read");
      continue;
    }
    if (spend.unreadable > 0) {
      // Unknown is not zero: a partial sum would overstate the room left.
      absent(
        `${spend.unreadable} local Grok usage record(s) of this period could not be read, so the spend is unknown`,
      );
      continue;
    }
    snapshots.push({
      subject,
      source: "grok_local_usage",
      observed_at: at.toISOString(),
      freshness: "fresh",
      constraints: [
        {
          id: USAGE_PERIOD_CONSTRAINT_ID,
          label: "Usage allowance",
          used_ratio: Math.min(1, spend.usd / allowance.usd),
          window_seconds: Math.round(allowance.period_days * 86_400),
          resets_at: new Date(period.end).toISOString(),
          cooldown_until: null,
        },
      ],
    });
  }
  return { snapshots, absences };
}
