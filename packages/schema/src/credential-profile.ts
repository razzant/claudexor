import { z } from "zod";
import { namespacedSecretRefBase } from "@claudexor/util";
import { Id, IsoTimestamp } from "./primitives.js";
import { AuthAvailability, AuthVerification } from "./auth.js";

/**
 * The credential transport a profile isolates (INV-135). `config_dir_login` is
 * a vendor-owned login living in a Claudexor-scoped config dir (claude
 * CLAUDE_CONFIG_DIR / codex CODEX_HOME); `oauth_token` and `api_key` are
 * secret-store references. The default vendor dirs (~/.claude, native codex
 * home) are NEVER a profile's isolation locator — profiles are additive.
 */
export const CredentialKind = z
  .enum(["config_dir_login", "oauth_token", "api_key"])
  .describe(
    "Credential transport a profile isolates: a scoped vendor config-dir login, a stored OAuth token, or a stored API key.",
  );
export type CredentialKind = z.infer<typeof CredentialKind>;

/**
 * Durable, NON-SECRET registry entry for one credential identity of one
 * harness (INV-135). Secret material never lives here: `config_dir_login`
 * points at a vendor-owned directory, token/key kinds point at a namespaced
 * secret-store name. Readiness is intentionally NOT durable — it is the
 * doctor's `CredentialProfileStatus` projection.
 */
export const CredentialProfile = z
  .object({
    profile_id: Id.describe("Stable user-chosen profile identifier (unique per harness)."),
    harness_id: Id.describe("Harness family this profile belongs to."),
    display_name: z.string().min(1).describe("Human label shown wherever the profile appears."),
    credential_kind: CredentialKind,
    isolation_locator: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "Canonical absolute config-dir path for config_dir_login profiles; null for secret-ref kinds.",
      ),
    secret_ref: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "Namespaced secret-store name (e.g. claude_oauth:work) for oauth_token/api_key profiles; null for config_dir_login.",
      ),
    enabled: z.boolean().default(true).describe("Disabled profiles are never routable."),
    created_at: IsoTimestamp.nullable()
      .default(null)
      .describe("When the profile was registered; null for hand-written config entries."),
  })
  .strict()
  .superRefine((profile, ctx) => {
    if (profile.credential_kind === "config_dir_login") {
      if (!profile.isolation_locator)
        ctx.addIssue({
          code: "custom",
          message: "config_dir_login profiles require isolation_locator (the scoped config dir)",
        });
      if (profile.secret_ref)
        ctx.addIssue({
          code: "custom",
          message: "config_dir_login profiles must not carry secret_ref",
        });
    } else {
      if (!profile.secret_ref)
        ctx.addIssue({
          code: "custom",
          message: `${profile.credential_kind} profiles require secret_ref`,
        });
      // Release wave round-15 #5: a profile's ref must be NAMESPACED
      // (`base:profile`). A bare engine-default slot (e.g. "anthropic") would
      // silently alias the default credential — profiles are ADDITIVE.
      else if (namespacedSecretRefBase(profile.secret_ref) === null)
        ctx.addIssue({
          code: "custom",
          message: `secret_ref "${profile.secret_ref}" must be a namespaced managed slot (base:profile, e.g. claude_oauth:work); bare engine-default slots would alias the default credential`,
        });
      if (profile.isolation_locator)
        ctx.addIssue({
          code: "custom",
          message: `${profile.credential_kind} profiles must not carry isolation_locator`,
        });
    }
  })
  .describe(
    "Durable non-secret registry entry for one credential identity of one harness; secret material lives in the vendor dir or the secret store, never here.",
  );
export type CredentialProfile = z.infer<typeof CredentialProfile>;

/**
 * Doctor-owned readiness projection for one profile — deliberately separate
 * from the durable registry entry so stored config never asserts liveness.
 */
export const CredentialProfileStatus = z
  .object({
    profile_id: Id,
    harness_id: Id,
    availability: AuthAvailability,
    verification: AuthVerification,
    detail: z.string().optional().describe("Redacted human-readable probe evidence."),
    last_verified_at: IsoTimestamp.nullable()
      .default(null)
      .describe("When a probe last verified this profile; null = never verified."),
  })
  .strict()
  .describe("Doctor-owned readiness projection for one credential profile; never durable config.");
export type CredentialProfileStatus = z.infer<typeof CredentialProfileStatus>;

/** Control response: every registered profile with its doctor projection. */
export const ControlCredentialProfilesResponse = z
  .object({
    profiles: z
      .array(z.object({ profile: CredentialProfile, status: CredentialProfileStatus }).strict())
      .describe("Every registered credential profile paired with its doctor readiness projection."),
  })
  .strict()
  .describe("Credential-profile registry listing with per-profile doctor readiness.");
export type ControlCredentialProfilesResponse = z.infer<typeof ControlCredentialProfilesResponse>;

/** Register a config-dir login profile (claude/codex) from a UI surface —
 * the same ONE locked registration owner `claudexor profiles add` uses. */
export const ControlCredentialProfileCreateRequest = z
  .object({
    harnessId: Id.describe("Harness family (claude | codex) for the config-dir login profile."),
    profileId: Id.describe("New profile id (bounded slug, unique per harness)."),
    displayName: z
      .string()
      .min(1)
      .optional()
      .describe("Human label shown wherever the account appears; defaults to the id."),
  })
  .strict()
  .describe("Request body for POST /credential-profiles.");
export type ControlCredentialProfileCreateRequest = z.infer<
  typeof ControlCredentialProfileCreateRequest
>;

/** DELETE /credential-profiles/:harness/:id — removes the registry entry and
 * the profile's OWN credential material (its scoped login dir, or its
 * namespaced secret). The default vendor store is untouchable by design. */
export const ControlCredentialProfileDeleteResponse = z
  .object({
    profile: CredentialProfile.describe("The removed registry entry."),
    removed: z.literal(true),
    credentialCleanup: z
      .enum(["config_dir_removed", "secret_deleted", "none"])
      .describe("What credential material was deleted alongside the registry entry."),
    cleanupWarning: z
      .string()
      .optional()
      .describe("Present when the registry entry was removed but cleanup failed (orphan left)."),
  })
  .strict()
  .describe("Receipt for a credential-profile removal.");
export type ControlCredentialProfileDeleteResponse = z.infer<
  typeof ControlCredentialProfileDeleteResponse
>;

export const ControlCredentialProfileCreateResponse = z
  .object({ profile: CredentialProfile, status: CredentialProfileStatus })
  .strict()
  .describe("The registered profile with its initial doctor readiness projection.");
export type ControlCredentialProfileCreateResponse = z.infer<
  typeof ControlCredentialProfileCreateResponse
>;
