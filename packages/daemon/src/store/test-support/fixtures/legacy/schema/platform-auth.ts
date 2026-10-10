import { z } from "zod/v3";
import { AuthSourceKind } from "./auth.js";

export const CredentialTransportKind = z
  .enum(["config_file", "env_var", "oauth_token_env", "os_keychain", "http_header", "none"])
  .describe(
    "Mechanism that carries a credential to the harness process (config file, env var, OAuth token env, OS keychain, HTTP header, or none).",
  );
export type CredentialTransportKind = z.infer<typeof CredentialTransportKind>;

/** Host platforms whose credential/login behavior can differ materially. */
export const HarnessPlatform = z
  .enum(["darwin", "linux", "win32"])
  .describe("Host platform used to resolve credential and managed-login policy.");
export type HarnessPlatform = z.infer<typeof HarnessPlatform>;

export const CredentialRelocation = z
  .enum(["HOME", "CONFIG_DIR", "ENV", "none"])
  .describe(
    "Which relocation lever moves the credential into a scoped environment (HOME, a config dir override, env injection, or none).",
  );
export type CredentialRelocation = z.infer<typeof CredentialRelocation>;

export const CredentialTransport = z
  .object({
    source: AuthSourceKind,
    kind: CredentialTransportKind,
    relocatable_by: z
      .array(CredentialRelocation)
      .default([])
      .describe("Relocation levers that can move this transport into a scoped environment."),
    platforms: z
      .array(HarnessPlatform)
      .min(1)
      .optional()
      .superRefine((platforms, context) => {
        if (platforms && new Set(platforms).size !== platforms.length) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "credential transport platforms must not contain duplicates",
          });
        }
      })
      .describe(
        "Host platforms on which this physical credential transport applies; absent means every supported platform for backward compatibility.",
      ),
  })
  .describe("How a credential from one auth source physically reaches the harness process.");
export type CredentialTransport = z.infer<typeof CredentialTransport>;

export const CredentialIdentityScope = z
  .enum(["profile", "os_user"])
  .describe(
    "Identity boundary selected by a credential profile: the named profile itself or the host OS user/login vault.",
  );
export type CredentialIdentityScope = z.infer<typeof CredentialIdentityScope>;

export const CredentialCleanupOwner = z
  .enum(["claudexor", "vendor"])
  .describe("Who owns cleanup of the credential when its Claudexor profile binding is removed.");
export type CredentialCleanupOwner = z.infer<typeof CredentialCleanupOwner>;

/** One platform-specific cardinality and cleanup policy for an auth source. */
export const CredentialProfilePolicy = z
  .object({
    source: AuthSourceKind,
    platforms: z
      .array(HarnessPlatform)
      .min(1)
      .superRefine((platforms, context) => {
        if (new Set(platforms).size !== platforms.length) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "credential profile policy platforms must not contain duplicates",
          });
        }
      })
      .describe("Nonempty host-platform set governed by this policy row."),
    identity_scope: CredentialIdentityScope,
    max_enabled_profiles: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe("Maximum enabled profile bindings on these platforms; null means unbounded."),
    cleanup_owner: CredentialCleanupOwner,
  })
  .strict()
  .describe(
    "Platform-specific identity scope, enabled-profile cardinality, and credential cleanup ownership for one auth source.",
  );
export type CredentialProfilePolicy = z.infer<typeof CredentialProfilePolicy>;

/** The sole managed-login input fact owned by the harness manifest. */
export const ManagedLogin = z
  .object({
    stdin: z
      .enum(["none", "pipe", "terminal"])
      .describe("Input transport the vendor login command requires."),
  })
  .strict()
  .describe(
    "Managed-login input requirement; command, argv, flow, and time window remain owned by the native-login registry.",
  );
export type ManagedLogin = z.infer<typeof ManagedLogin>;

export const AuthCapabilities = z
  .object({
    supported_sources: z
      .array(AuthSourceKind)
      .default([])
      .describe("Auth sources this harness supports."),
    preferred_source: AuthSourceKind.nullable()
      .default(null)
      .describe("Auth source the adapter prefers; null when it has no preference."),
    credential_transports: z
      .array(CredentialTransport)
      .default([])
      .describe("Declared credential transports per auth source."),
    credential_profile_policies: z
      .array(CredentialProfilePolicy)
      .optional()
      .describe(
        "Platform-specific profile identity/cardinality/cleanup policy; absent uses the backward-compatible profile-scoped, unbounded, Claudexor-owned defaults.",
      ),
    managed_login: ManagedLogin.nullable()
      .optional()
      .describe(
        "Managed subscription-login input requirement; null means this harness defines no managed login, absent is a legacy manifest.",
      ),
  })
  .superRefine((auth, context) => {
    const claimed = new Map<string, number>();
    for (const [index, policy] of (auth.credential_profile_policies ?? []).entries()) {
      for (const platform of policy.platforms) {
        const key = `${policy.source}:${platform}`;
        const previous = claimed.get(key);
        if (previous !== undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["credential_profile_policies", index, "platforms"],
            message: `credential profile policy overlaps row ${previous} for ${policy.source} on ${platform}`,
          });
        } else {
          claimed.set(key, index);
        }
      }
    }
  })
  .default({})
  .describe("Declared auth routing facts for a harness.");
export type AuthCapabilities = z.infer<typeof AuthCapabilities>;

/** Candidate credential transports applicable on `platform`. Transport rows
 * may overlap intentionally (for example Claude config-file + keychain). */
export function credentialTransportsForPlatform(
  auth: AuthCapabilities,
  platform: HarnessPlatform,
): CredentialTransport[] {
  return auth.credential_transports.filter(
    (transport) => !transport.platforms || transport.platforms.includes(platform),
  );
}

export interface EffectiveCredentialProfilePolicy {
  readonly identity_scope: CredentialIdentityScope;
  readonly max_enabled_profiles: number | null;
  readonly cleanup_owner: CredentialCleanupOwner;
}

/** Resolve the one profile policy row for source+platform. Absence retains the
 * historical profile-scoped, unbounded, Claudexor-owned behavior without
 * injecting serialized defaults into old manifests. */
export function credentialProfilePolicyForPlatform(
  auth: AuthCapabilities,
  source: AuthSourceKind,
  platform: HarnessPlatform,
): EffectiveCredentialProfilePolicy {
  const policy = auth.credential_profile_policies?.find(
    (candidate) => candidate.source === source && candidate.platforms.includes(platform),
  );
  return policy
    ? {
        identity_scope: policy.identity_scope,
        max_enabled_profiles: policy.max_enabled_profiles,
        cleanup_owner: policy.cleanup_owner,
      }
    : {
        identity_scope: "profile",
        max_enabled_profiles: null,
        cleanup_owner: "claudexor",
      };
}
