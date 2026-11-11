import type { HarnessRunSpec } from "@claudexor/schema";

/** `spec.extra` keys of the engine's choice stamp (INV-135 #363, #532). */
const UNPINNED_PROFILE_KEY = "unpinnedCredentialProfileId";
const PINNED_PROFILE_KEY = "pinnedCredentialProfileId";

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
  delete spec.extra[UNPINNED_PROFILE_KEY];
  delete spec.extra[PINNED_PROFILE_KEY];
  if (profileId)
    spec.extra[selection.pinned ? PINNED_PROFILE_KEY : UNPINNED_PROFILE_KEY] = profileId;
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

/** True only when the engine stamped THIS spec's profile as an explicit pin of
 * the run or reviewer seat (#532). An unstamped spec, such as a side pass that
 * carries no pin fact, keeps the strict contract without a pin's longer wait. */
export function credentialProfilePinned(
  spec: Pick<HarnessRunSpec, "credential_profile" | "extra">,
): boolean {
  const profileId = spec.credential_profile?.profile_id;
  return profileId !== undefined && spec.extra?.[PINNED_PROFILE_KEY] === profileId;
}

/** The pin fact for a profile readiness probe, which carries no spec (#532). */
export interface CredentialProfileProbeOptions {
  /** The engine is admitting an explicit pin, which is never admitted on an
   * unanswered or older answer (INV-135). An adapter whose native sign-in check
   * can outlast its ordinary budget keeps this caller waiting for that same
   * check, up to a bound the adapter owns; the probe's abort signal ends the
   * wait sooner. Absent, the ordinary budget decides. */
  pinned?: boolean;
}
