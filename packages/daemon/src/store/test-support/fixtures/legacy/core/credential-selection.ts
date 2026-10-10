import type { HarnessRunSpec } from "../schema/index.js";

/** `spec.extra` key of the engine's unpinned-choice stamp (INV-135 #363). */
const UNPINNED_PROFILE_KEY = "unpinnedCredentialProfileId";

/**
 * Record whether a spec's resolved credential profile was an explicit pin.
 * Only the engine's resolve owner knows this (the run's or reviewer entry's
 * explicit pin), so an adapter never infers it from profile fields. It rides
 * `spec.extra` like the abort signal — a runtime routing fact, not a request
 * field — and names the profile it describes, so a spec whose profile later
 * changes never inherits it.
 */
export function stampCredentialProfileSelection(
  spec: HarnessRunSpec,
  selection: { pinned: boolean },
): void {
  const profileId = spec.credential_profile?.profile_id;
  if (profileId && !selection.pinned) spec.extra[UNPINNED_PROFILE_KEY] = profileId;
  else delete spec.extra[UNPINNED_PROFILE_KEY];
}

/** True only when the engine stamped THIS spec's profile as an unpinned choice
 * (a durable binding, the pool, rotation). Unstamped reads as the strict pin
 * contract. */
export function credentialProfileUnpinned(
  spec: Pick<HarnessRunSpec, "credential_profile" | "extra">,
): boolean {
  const profileId = spec.credential_profile?.profile_id;
  return profileId !== undefined && spec.extra?.[UNPINNED_PROFILE_KEY] === profileId;
}
