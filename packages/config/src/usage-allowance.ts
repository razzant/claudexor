import type { AccountTierPolicy, CredentialProfile, UsageAllowance } from "@claudexor/schema";

/** The usage allowance in force for one account row: its own, else its tier's default. */
export function accountUsageAllowance(
  profile: Pick<CredentialProfile, "tier" | "usage_allowance">,
  policy: Pick<AccountTierPolicy, "allowances"> | undefined,
): UsageAllowance | null {
  return (
    profile.usage_allowance ?? (profile.tier ? policy?.allowances[profile.tier] : null) ?? null
  );
}
