import { z } from "zod/v3";
import { namespacedSecretRefBase } from "@claudexor/util";
import { Id, IsoTimestamp } from "./primitives.js";
import { AuthAvailability, AuthVerification } from "./auth.js";

/** Exact profile-policy problem vocabulary shared by mutation and admission
 * surfaces. ControlProblem remains open for unrelated domain errors. */
export const CredentialProfileProblemCode = z.enum([
  "credential_profile_required",
  "credential_profile_exists",
  "credential_profile_limit_exceeded",
  "credential_profile_ambiguous",
]);
export type CredentialProfileProblemCode = z.infer<typeof CredentialProfileProblemCode>;

/**
 * The binding kind a profile uses (INV-135, unified account model).
 * `config_dir_login` owns Claudexor-scoped vendor state in a config dir or HOME
 * (Claude CLAUDE_CONFIG_DIR / Codex
 * CODEX_HOME / Cursor file-store HOME). The Claudexor-owned LEGACY native
 * dirs are legal locators — the startup migration registers them as the
 * `claude-default`/`codex-default` rows without moving bytes; the vendor's
 * ordinary host stores (~/.claude, ~/.codex) stay outside the owned root and
 * are never a locator. A vendor OS-user credential may live outside that
 * state and remain unchanged when the binding is removed. `oauth_token` and
 * `api_key` are managed secret-store references.
 */
export const CredentialKind = z
  .enum(["config_dir_login", "oauth_token", "api_key"])
  .describe(
    "Binding kind for a profile: Claudexor-owned scoped vendor state, a managed OAuth secret, or a managed API-key secret; a vendor OS-user credential may remain outside that state.",
  );
export type CredentialKind = z.infer<typeof CredentialKind>;

/**
 * Durable, NON-SECRET named binding for one harness (INV-135). Secret material
 * never lives here: `config_dir_login` points at Claudexor-owned scoped vendor
 * state while effective platform policy may keep the credential at OS-user
 * scope; token/key kinds point at a namespaced managed-secret name. Readiness
 * is intentionally NOT durable — it is the doctor's
 * `CredentialProfileStatus` projection.
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
        "Canonical absolute path to Claudexor-owned scoped vendor state for config_dir_login bindings; null for secret-ref kinds.",
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
    "Durable non-secret named binding for one harness; credential material may live in Claudexor-owned scoped state, a managed secret store, or a platform-declared vendor/OS-user store, never in this row.",
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
    /** WHAT the `verification` verdict is worth. `local_store` means only that
     * this binding's required local state or managed secret is present and
     * well-formed — it cannot tell a live token from a revoked one. `vendor`
     * means the vendor answered under THIS binding's exact environment and
     * effective platform credential policy. A router that needs "configured
     * AND healthy" must read this alongside `verification`; `passed` +
     * `local_store` promises strictly less than it sounds. */
    verification_source: z
      .enum(["local_store", "vendor"])
      .default("local_store")
      .describe(
        "How the verification verdict was reached: local_store = the binding's required local state or managed secret is present (says nothing about a token being live); vendor = the vendor answered under the exact binding environment and effective platform credential policy.",
      ),
    /** A bounded last-known-good transport observation. */
    stale: z
      .boolean()
      .optional()
      .describe(
        "True only for a bounded stale last-known-good observation; stale is never a fresh passed verification.",
      ),
    stale_age_ms: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Age in milliseconds of the bounded stale observation, when stale is true."),
    detail: z.string().optional().describe("Redacted human-readable probe evidence."),
    last_verified_at: IsoTimestamp.nullable()
      .default(null)
      .describe(
        "When the verification verdict was established, by the method named in verification_source; null = never verified.",
      ),
  })
  .strict()
  .describe("Doctor-owned readiness projection for one credential profile; never durable config.");
export type CredentialProfileStatus = z.infer<typeof CredentialProfileStatus>;

/** Why an observed credential is unusable, in the OBSERVER's typed vocabulary:
 * `auth_revoked` = the vendor rejected the credential itself (401/403);
 * `capability_refused` = a typed non-retryable entitlement refusal was observed
 * on the attempt stream (org-disabled, model-not-entitled — model-scoped when
 * the attempt carried a model hint); `verification_failed` = the profile's own
 * doctor probe failed verification. */
export const CredentialUnusableCode = z
  .enum(["auth_revoked", "capability_refused", "verification_failed"])
  .describe(
    "Typed reason an observed credential is unusable: vendor rejection, entitlement refusal, or a failed profile verification probe.",
  );
export type CredentialUnusableCode = z.infer<typeof CredentialUnusableCode>;

/**
 * ONE typed observation that a credential subject is UNUSABLE — dead as a
 * credential, not merely quota-spent (A7 differential probe). Deliberately a
 * bounded, self-expiring OBSERVATION, never durable config: profile readiness
 * stays the doctor's projection (`CredentialProfileStatus`), and quota-spent
 * evidence stays the quota registry's cooldown snapshots. The clearing
 * contract is threefold: `expires_at` self-expiry (bounded TTL), a successful
 * model response for the same subject, and any credential-generation change
 * (re-login / profile mutation).
 */
export const CredentialUnusableObservation = z
  .object({
    harness_id: Id.describe("Harness family the observed subject belongs to."),
    profile_id: Id.nullable().describe(
      "Observed credential profile, or null for the harness's default subject.",
    ),
    /** Model the refusal was observed under, when the evidence cannot prove it
     * is credential-wide (an entitlement refusal may be model-scoped). Null =
     * the evidence condemns the credential for every model. */
    model: z
      .string()
      .nullable()
      .describe(
        "Model hint the refusal was observed under (entitlement refusals may be model-scoped); null = credential-wide.",
      ),
    code: CredentialUnusableCode,
    source: z
      .enum(["vendor_poller", "attempt_stream", "local_probe"])
      .describe(
        "Where the evidence came from: the quota poller's typed absence, a typed refusal on the attempt stream, or the profile's own doctor probe.",
      ),
    detail: z.string().nullable().describe("Redacted human-readable evidence."),
    observed_at: IsoTimestamp.describe("When the unusable verdict was observed."),
    expires_at: IsoTimestamp.describe(
      "Self-expiry instant (bounded TTL); after this the observation is ignored.",
    ),
  })
  .strict()
  .describe(
    "A bounded, self-expiring typed observation that a credential subject is unusable (dead credential, not spent quota); never durable config.",
  );
export type CredentialUnusableObservation = z.infer<typeof CredentialUnusableObservation>;

/**
 * NON-SECRET account identity projection (INV-067/INV-135): the email and plan
 * label derived DAEMON-SIDE from a sanctioned per-account source. Codex and
 * Claude may use their scoped credential stores; Cursor may expose an
 * allowlisted email from the harness CLI's anchored status observation. Only
 * these two allowlisted, non-token fields ever cross the wire; raw status text
 * and token material stay inside the daemon. A macOS surface MUST render this
 * projection, never re-read a store or invoke a harness. Both fields are
 * optional so a source that discloses only one still projects.
 */
export const AccountIdentity = z
  .object({
    email: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Login email of the account (codex id_token `email`, claude oauthAccount `emailAddress`, or an allowlisted harness CLI status observation).",
      ),
    plan: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Subscription/plan label (codex `chatgpt_plan_type` / claude oauthAccount `organizationType`).",
      ),
  })
  .strict()
  .describe(
    "Non-secret {email, plan} identity of one account, derived daemon-side from a sanctioned scoped credential source or an allowlisted harness CLI status observation; never carries raw status or token material.",
  );
export type AccountIdentity = z.infer<typeof AccountIdentity>;

/**
 * The identity routing WOULD pick next for a harness's UNPINNED run (INV-135) —
 * purely informational, never user-set. Server-computed by the routing owner
 * from enabled profiles + native readiness + quota so no surface re-derives it:
 * `profile` names the enabled credential profile a quota-rotation would land on;
 * `native` is the existing unprofiled/default subject (normally the CLI login,
 * or the configured key for an API-only harness); `none` means an unpinned run has nothing routable (the default is disabled and no
 * account is pinned) with a human reason. Explicit control stays a per-run
 * `--profile` pin or a per-thread pin — this field never gates routing.
 */
export const ControlNextUpIdentity = z
  .discriminatedUnion("kind", [
    z
      .object({ kind: z.literal("profile"), profileId: Id })
      .strict()
      .describe("An enabled credential profile is who an unpinned run routes to next."),
    z
      .object({
        kind: z.literal("native"),
        route: z
          .enum(["local_session", "api_key"])
          .optional()
          .describe("Effective route of the unprofiled/default subject; omitted by older daemons."),
      })
      .strict()
      .describe("The unprofiled/default credential is the subject of an unpinned run."),
    z
      .object({ kind: z.literal("none"), reason: z.string() })
      .strict()
      .describe(
        "An unpinned run has nothing routable (the default credential is disabled and no account is pinned).",
      ),
  ])
  .describe("Server-computed identity an unpinned run of this harness would route to next.");
export type ControlNextUpIdentity = z.infer<typeof ControlNextUpIdentity>;

/**
 * The account an UNPINNED run of a harness would route to next under the
 * UNIFIED account model (INV-135): every account is a named registry row, so
 * the pool verdict is either an enabled row, the policy-governed API-key
 * ROUTE (INV-061 — a route, never a row), or nothing routable. This union is
 * carried ONLY by `accountPools` — the legacy `ControlNextUpIdentity` stays
 * untouched because old strict decoders throw on unknown kinds.
 */
export const ControlPoolNextUp = z
  .discriminatedUnion("kind", [
    z
      .object({ kind: z.literal("profile"), profileId: Id })
      .strict()
      .describe("An enabled account row is who an unpinned run routes to next."),
    z
      .object({ kind: z.literal("api_key_route") })
      .strict()
      .describe(
        "The account pool is empty or exhausted; the unpinned route is the policy-governed API key (INV-061) — a route, never an account row.",
      ),
    z
      .object({ kind: z.literal("none"), reason: z.string() })
      .strict()
      .describe("An unpinned run has nothing routable, with a human reason."),
  ])
  .describe(
    "Server-computed pool routing verdict for one harness's unpinned runs (unified account model).",
  );
export type ControlPoolNextUp = z.infer<typeof ControlPoolNextUp>;

/** Per-harness POOL AUTHORITY of the unified account model: routing facts live
 * here; account facts live on the profile rows. */
export const ControlHarnessAccountPool = z
  .object({
    harness_id: Id.describe("Harness family this pool verdict belongs to."),
    next_up: ControlPoolNextUp,
  })
  .strict()
  .describe(
    "Per-harness pool authority (unified account model): who an unpinned run routes to next.",
  );
export type ControlHarnessAccountPool = z.infer<typeof ControlHarnessAccountPool>;

/** GET /account-pools — the pool-authority read AND the unified-accounts
 * feature marker (its catalog presence is absent from 3.5.0 engines). */
export const ControlAccountPoolsResponse = z
  .object({
    accountPools: z
      .array(ControlHarnessAccountPool)
      .describe("Pool routing verdict per harness, computed by the routing owner."),
  })
  .strict()
  .describe("Per-harness account-pool authority under the unified account model.");
export type ControlAccountPoolsResponse = z.infer<typeof ControlAccountPoolsResponse>;

/**
 * Per-harness ACCOUNTS AUTHORITY projection (INV-135, the accounts symmetry):
 * the native "CLI login" pseudo-row state and the informational `next_up`
 * identity, computed ONCE on the server so no client re-derives the symmetry.
 * Every credential profile of this harness appears in the top-level `profiles`
 * list with its own `enabled` flag — the only user-settable routing control.
 * This row adds the authority the profile rows cannot carry.
 */
export const ControlHarnessAccounts = z
  .object({
    harness_id: Id.describe("Harness family these accounts belong to."),
    native_credentials_enabled: z
      .boolean()
      .describe("Whether the native/CLI login participates in this harness's credential ladder."),
    native_login_detected: z
      .boolean()
      .describe(
        "Whether a native/default vendor login is currently detected available (the CLI login pseudo-row state).",
      ),
    identity: AccountIdentity.nullable()
      .default(null)
      .describe(
        "Non-secret {email, plan} of the native/CLI login, derived daemon-side from a sanctioned credential source or allowlisted harness CLI status observation; null when absent/undisclosed.",
      ),
    next_up: ControlNextUpIdentity,
  })
  .strict()
  .describe(
    "Per-harness accounts authority: native CLI-login state + the informational next-up identity.",
  );
export type ControlHarnessAccounts = z.infer<typeof ControlHarnessAccounts>;

/** Control response: every registered profile with its doctor projection, plus
 * the per-harness accounts authority (native CLI-login row + next-up identity). */
export const ControlCredentialProfilesResponse = z
  .object({
    profiles: z
      .array(
        z
          .object({
            profile: CredentialProfile,
            status: CredentialProfileStatus,
            identity: AccountIdentity.nullable()
              .default(null)
              .describe(
                "Non-secret {email, plan} of this profile, derived daemon-side from its scoped credential source or allowlisted harness CLI status observation; null when absent/undisclosed.",
              ),
          })
          .strict(),
      )
      .describe(
        "Every registered credential profile paired with its doctor readiness projection and non-secret identity.",
      ),
    harnessAccounts: z
      .array(ControlHarnessAccounts)
      .default([])
      .describe(
        "Per-harness accounts authority (INV-135): the native CLI-login pseudo-row state and the server-computed Active identity, so no surface re-derives the accounts symmetry. A unified-model engine emits [] here (the key must stay present for legacy strict clients) and carries routing facts in accountPools instead.",
      ),
    accountPools: z
      .array(ControlHarnessAccountPool)
      .default([])
      .describe(
        "Additive per-harness pool authority of the unified account model: routing facts (next_up incl. the api_key_route kind) live here so legacy strict next_up decoders never see unknown kinds. Old clients ignore this key.",
      ),
  })
  .strict()
  .describe(
    "Credential-profile registry listing with per-profile doctor readiness and per-harness accounts authority.",
  );
export type ControlCredentialProfilesResponse = z.infer<typeof ControlCredentialProfilesResponse>;

/** PATCH /credential-profiles/:harness/:id — toggle a profile's `enabled`
 * (the Enabled row of the accounts symmetry). The native CLI login has the same
 * toggle semantics via the harness settings surface, not this route. */
export const ControlCredentialProfileUpdateRequest = z
  .object({
    enabled: z
      .boolean()
      .describe("Whether this credential profile is routable (the Enabled toggle)."),
  })
  .strict()
  .describe("Request body for PATCH /credential-profiles/:harness/:id.");
export type ControlCredentialProfileUpdateRequest = z.infer<
  typeof ControlCredentialProfileUpdateRequest
>;

/** Receipt for a credential-profile update: the updated registry entry with its
 * refreshed doctor projection. */
export const ControlCredentialProfileUpdateResponse = z
  .object({ profile: CredentialProfile, status: CredentialProfileStatus })
  .strict()
  .describe("The updated credential profile with its doctor readiness projection.");
export type ControlCredentialProfileUpdateResponse = z.infer<
  typeof ControlCredentialProfileUpdateResponse
>;

/** Register a config-dir login profile (agy/claude/codex/cursor) from a UI surface —
 * the same ONE locked registration owner `claudexor profiles add` uses. */
export const ControlCredentialProfileCreateRequest = z
  .object({
    harnessId: Id.describe(
      "Harness family (agy | claude | codex | cursor) for the config-dir login profile.",
    ),
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

/** DELETE /credential-profiles/:harness/:id — removes the binding and any state
 * Claudexor owns (a scoped state dir, migrated owned locator, or namespaced
 * secret). Success proves that owned cleanup; a partial failure is retryable
 * and keeps the row registered. A typed disposition says when a vendor-owned
 * OS-user credential was deliberately left unchanged. */
export const ControlCredentialProfileDeleteResponse = z
  .object({
    profile: CredentialProfile.describe("The removed registry entry."),
    removed: z.literal(true),
    credentialCleanup: z
      .enum(["config_dir_removed", "secret_deleted", "none"])
      .describe(
        "What Claudexor-owned state or managed secret was removed with the binding; this does not assert that a vendor OS-user credential changed.",
      ),
    cleanupWarning: z
      .string()
      .optional()
      .describe(
        "DEPRECATED (wire-compat only): a unified-model engine never emits it — partial cleanup is a typed retryable error instead of a removed-with-warning receipt.",
      ),
    vendorCredentialDisposition: z
      .object({
        owner: z.literal("vendor"),
        state: z.literal("left_unchanged"),
        scope: z.literal("os_user"),
      })
      .strict()
      .optional()
      .describe(
        "Exact disclosure that profile binding removal left a vendor-owned OS-user credential unchanged; absence preserves legacy receipts.",
      ),
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
