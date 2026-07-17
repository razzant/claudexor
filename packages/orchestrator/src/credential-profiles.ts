import type { CredentialProfile } from "@claudexor/schema";

/**
 * The ONE resolve owner for credential profiles (INV-135): explicit id →
 * durable registry entry for exactly this harness. Unknown, disabled, or
 * harness-mismatched ids throw a typed refusal — an explicit profile must
 * never silently become the default credential ladder.
 */
export function resolveCredentialProfile(
  registry: readonly CredentialProfile[],
  wanted: string,
  harnessId: string,
): CredentialProfile {
  const match = registry.find((p) => p.profile_id === wanted && p.harness_id === harnessId);
  if (!match) {
    throw new Error(`credential profile "${wanted}" is not registered for harness "${harnessId}"`);
  }
  if (!match.enabled) {
    throw new Error(`credential profile "${wanted}" (${harnessId}) is disabled`);
  }
  return match;
}
