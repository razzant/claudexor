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
  const requiredHarnesses = pool.length > 0 ? pool : primary ? [primary] : [];
  const missing = requiredHarnesses.filter(
    (harness) =>
      !registry.some(
        (profile) =>
          profile.enabled && profile.harness_id === harness && profile.profile_id === profileId,
      ),
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
