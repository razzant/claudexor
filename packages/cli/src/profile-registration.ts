import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { updateGlobalConfig } from "@claudexor/config";
import type { CredentialProfile } from "@claudexor/schema";
import { claudexorOwnedRoot, nowIso } from "@claudexor/util";

/**
 * The ONE owner of config-dir credential-profile registration (INV-135),
 * shared by `claudexor profiles add` and POST /v2/credential-profiles: a
 * locked, schema-validated global-config write (duplicate ids refused by the
 * registry schema), with the login dir created under the engine's confinement
 * root. Never a raw YAML append — that can duplicate the top-level key and
 * brick the config.
 */

const PROFILE_ID_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface RegisterProfileInput {
  harnessId: string;
  profileId: string;
  displayName?: string;
}

export function registerConfigDirProfile(input: RegisterProfileInput): {
  profile: CredentialProfile;
  configPath: string;
} {
  const { harnessId, profileId } = input;
  if (harnessId !== "claude" && harnessId !== "codex") {
    throw Object.assign(
      new Error(
        `harness "${harnessId}" has no isolated config-dir login; register claude or codex profiles here (secret-ref profiles for other harnesses are hand-registered in the global config)`,
      ),
      { status: 400 },
    );
  }
  if (!PROFILE_ID_SLUG.test(profileId)) {
    throw Object.assign(
      new Error(`profile id "${profileId}" must be a bounded slug ([a-z0-9][a-z0-9_-]{0,63})`),
      { status: 400 },
    );
  }
  const locator = join(claudexorOwnedRoot(), "profiles", `${harnessId}-${profileId}`);
  mkdirSync(locator, { recursive: true });
  const entry: CredentialProfile = {
    profile_id: profileId,
    harness_id: harnessId,
    display_name: input.displayName?.trim() || profileId,
    credential_kind: "config_dir_login",
    isolation_locator: locator,
    secret_ref: null,
    enabled: true,
    created_at: nowIso(),
  };
  try {
    const { path } = updateGlobalConfig((config) => ({
      ...config,
      credential_profiles: [...config.credential_profiles, entry],
    }));
    return { profile: entry, configPath: path };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw Object.assign(new Error(`could not register the profile: ${message}`), {
      status: /duplicate/i.test(message) ? 409 : 400,
    });
  }
}

/** The ONE owner of registry removal (mirror of registerConfigDirProfile):
 * locked global-config write returning the removed entry; unknown ids refuse
 * with a typed 404. Credential-material cleanup stays with the caller. */
export function removeProfileFromRegistry(harnessId: string, profileId: string): CredentialProfile {
  let removed: CredentialProfile | undefined;
  updateGlobalConfig((config) => {
    removed = config.credential_profiles.find(
      (profile) => profile.harness_id === harnessId && profile.profile_id === profileId,
    );
    if (!removed) {
      throw Object.assign(
        new Error(`no credential profile "${profileId}" for harness "${harnessId}"`),
        { status: 404 },
      );
    }
    // INV-135 durable-pin invalidation: a deleted account must not dangle as a
    // harness's `rotation_eligible` entry (rotation would then target a
    // removed profile). Clear it in the SAME locked write.
    const harnesses = Object.fromEntries(
      Object.entries(config.harnesses).map(([id, h]) => [
        id,
        {
          ...h,
          profile_policy: {
            ...h.profile_policy,
            rotation_eligible:
              id === harnessId
                ? h.profile_policy.rotation_eligible.filter((rid) => rid !== profileId)
                : h.profile_policy.rotation_eligible,
          },
        },
      ]),
    );
    return {
      ...config,
      harnesses,
      credential_profiles: config.credential_profiles.filter(
        (profile) => !(profile.harness_id === harnessId && profile.profile_id === profileId),
      ),
    };
  });
  if (!removed) {
    throw Object.assign(new Error("profile removal did not persist"), { status: 500 });
  }
  return removed;
}
