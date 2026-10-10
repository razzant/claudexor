import {
  credentialProfilePolicyForPlatform,
  type AuthSourceKind,
  type CredentialProfile,
  type CredentialProfileProblemCode,
  type EffectiveCredentialProfilePolicy,
  type HarnessPlatform,
} from "../schema/index.js";
import type { HarnessAdapter } from "./adapter.js";

export interface CredentialProfilePolicyState {
  readonly harnessId: string;
  readonly platform: HarnessPlatform | null;
  readonly policy: EffectiveCredentialProfilePolicy;
  readonly enabledProfileCount: number;
  readonly ambiguous: boolean;
}

const DEFAULT_POLICY: EffectiveCredentialProfilePolicy = {
  identity_scope: "profile",
  max_enabled_profiles: null,
  cleanup_owner: "claudexor",
};

/** Node supports more platform literals than the public harness contract. */
export function harnessPlatform(
  platform: NodeJS.Platform = process.platform,
): HarnessPlatform | null {
  return platform === "darwin" || platform === "linux" || platform === "win32" ? platform : null;
}

/**
 * Resolve static profile policy without running discover() or any vendor
 * probe. This is the early fail-loud seam: a persisted ambiguity must be
 * diagnosed before choosing or contacting one of the conflicting rows.
 */
export function credentialProfilePolicyState(input: {
  adapter: Pick<HarnessAdapter, "id" | "capabilityProfile"> | undefined;
  registry: readonly CredentialProfile[];
  source?: AuthSourceKind;
  platform?: NodeJS.Platform;
}): CredentialProfilePolicyState {
  const platform = harnessPlatform(input.platform);
  const source = input.source ?? "native_session";
  const policy =
    platform && input.adapter?.capabilityProfile
      ? credentialProfilePolicyForPlatform(input.adapter.capabilityProfile.auth, source, platform)
      : DEFAULT_POLICY;
  const enabledProfileCount = input.registry.filter(
    (profile) =>
      profile.harness_id === input.adapter?.id &&
      profile.enabled &&
      // Static source policy is applied to the native subscription rows. A
      // separately stored metered key is a different auth source/payment path.
      profile.credential_kind !== "api_key",
  ).length;
  const maximum = policy.max_enabled_profiles;
  return {
    harnessId: input.adapter?.id ?? "unknown",
    platform,
    policy,
    enabledProfileCount,
    ambiguous: maximum !== null && enabledProfileCount > maximum,
  };
}

export interface CredentialProfilePolicyProblem extends Error {
  status: 409;
  code: CredentialProfileProblemCode;
  retryable: false;
  fieldErrors: Record<string, string[]>;
  requiredActions: string[];
  context: {
    harnessId: string;
    platform: HarnessPlatform | null;
    maxEnabledProfiles: number;
    enabledProfileCount: number;
  };
}

/** Exact typed 409 shared by create, enable, setup, and run admission. */
export function credentialProfilePolicyProblem(
  state: CredentialProfilePolicyState,
  code: "credential_profile_limit_exceeded" | "credential_profile_ambiguous",
  field?: "/profileId" | "/enabled",
): CredentialProfilePolicyProblem {
  const maximum = state.policy.max_enabled_profiles;
  if (maximum === null)
    throw new Error("cannot create a profile-limit problem for an unbounded policy");
  const ambiguous = code === "credential_profile_ambiguous";
  const message = ambiguous
    ? `${state.harnessId} has ${state.enabledProfileCount} enabled profile bindings on ${state.platform ?? "this host"}, but the current policy permits ${maximum}; disable extra profiles before continuing`
    : `${state.harnessId} permits at most ${maximum} enabled profile binding${maximum === 1 ? "" : "s"} on ${state.platform ?? "this host"}; disable another profile first`;
  return Object.assign(new Error(message), {
    status: 409 as const,
    code,
    retryable: false as const,
    fieldErrors: field
      ? {
          [field]: [
            ambiguous
              ? "The persisted enabled profile set is ambiguous; disable extra profiles first."
              : `Enabling this profile would exceed the platform limit of ${maximum}.`,
          ],
        }
      : {},
    requiredActions: ["disable_extra_profiles"],
    context: {
      harnessId: state.harnessId,
      platform: state.platform,
      maxEnabledProfiles: maximum,
      enabledProfileCount: state.enabledProfileCount,
    },
  });
}
