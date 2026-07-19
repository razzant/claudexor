import type { CredentialProfile } from "@claudexor/schema";

/** Fail before a thread mutation can persist a profile that one explicit lane
 * cannot resolve (INV-135). Empty/auto pools are filtered later by run preflight. */
export function assertCredentialProfileCompatibility(
  profileId: string | null | undefined,
  primary: string | null | undefined,
  pool: string[],
  registry: readonly CredentialProfile[],
): void {
  if (!profileId) return;
  const enabledMatches = registry.filter(
    (profile) => profile.enabled && profile.profile_id === profileId,
  );
  if (enabledMatches.length === 0) {
    throw Object.assign(
      new Error(`credential profile "${profileId}" is not registered or enabled`),
      { status: 400 },
    );
  }
  const requiredHarnesses = pool.length > 0 ? pool : primary ? [primary] : [];
  const missing = requiredHarnesses.filter(
    (harness) => !enabledMatches.some((profile) => profile.harness_id === harness),
  );
  if (missing.length > 0) {
    throw Object.assign(
      new Error(
        `credential profile "${profileId}" is not registered for eligible harness(es): ${missing.join(", ")}`,
      ),
      { status: 400 },
    );
  }
}

export function assertCredentialProfileRegistered(
  registry: readonly CredentialProfile[],
  harnessId: string,
  profileId: string,
): void {
  if (
    registry.some((profile) => profile.harness_id === harnessId && profile.profile_id === profileId)
  )
    return;
  throw Object.assign(
    new Error(`credential profile "${profileId}" is not registered for harness "${harnessId}"`),
    { status: 404 },
  );
}
