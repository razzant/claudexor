import { z } from "zod/v3";
import {
  ControlCredentialProfilesResponse,
  CredentialUnusableCode,
  PreProgressRefusalObservation,
} from "./credential-profile.js";
import {
  ControlCredentialProfilesResourcesResponse,
  ControlCredentialProfilesSnapshotResponse,
} from "./credential-profile-snapshot.js";
import { Id, IsoTimestamp } from "./primitives.js";

/** The latest request an account served for one requested model (INV-135
 * tie-break evidence). A service observation, never a quota or auth verdict. */
export const AccountLastService = z
  .object({
    harness_id: Id.describe("Harness family of the account."),
    profile_id: Id.describe("Account row that served the request."),
    requested_model: z
      .string()
      .nullable()
      .describe("Model the run asked for; null = the harness default model."),
    observed_at: IsoTimestamp.describe("When the account was observed serving that request."),
  })
  .strict()
  .describe(
    "The latest observed service of one account for one requested model under its current credential binding.",
  );
export type AccountLastService = z.infer<typeof AccountLastService>;

/** Temporary model capability ordering evidence; never account availability. */
export const ModelCapabilityMark = z
  .object({
    harness_id: Id.describe("Harness family of the account."),
    profile_id: Id.describe("Account row that refused this model before generation started."),
    requested_model: z.string().describe("Model the refused request named."),
    account_fingerprint: z
      .string()
      .nullable()
      .describe("Provider account identity the mark is bound to; null when the adapter has none."),
    provider_reason: z
      .string()
      .describe(
        "Latest refusal diagnostic, redacted and at most 1024 characters: the provider's reason for a recognized refusal, the engine's message and vendor code otherwise.",
      ),
    observed_at: IsoTimestamp.describe(
      "Start of this mark's episode, when its row was created (a recognized refusal, or the service elsewhere that confirmed an unrecognized one); renewals and probes keep it.",
    ),
    expires_at: IsoTimestamp.describe("Probe becomes eligible at this time; not a vendor reset."),
    state: z
      .enum(["provisional", "confirmed", "probe_due", "probing"])
      .describe(
        "provisional = refused here; confirmed = another account then served the correlated retry; probe_due = expired, the next selection may probe it; probing = one operation holds that probe.",
      ),
  })
  .strict()
  .describe(
    "A temporary capability mark for one account and one model. It only orders auto selection: the account stays enabled and usable as a last fallback.",
  );
export type ModelCapabilityMark = z.infer<typeof ModelCapabilityMark>;

/** A live typed `credential_unusable` observation scoped to ONE model of a
 * registered row: dated evidence beside the row, never its status. A
 * credential-wide observation (model null) is composed into the row's status
 * instead and is never listed here. */
export const ModelScopedCredentialUnusable = z
  .object({
    harness_id: Id.describe("Harness family of the account."),
    profile_id: Id.describe("Registered account row the refusal was observed on."),
    model: z
      .string()
      .describe(
        "Model the refused run requested, exactly as requested; a vendor-reported id that differs from it does not clear the observation.",
      ),
    code: CredentialUnusableCode,
    detail: z
      .string()
      .nullable()
      .describe(
        "Redacted typed evidence of the refusal, such as the vendor's error category; null when none was observed.",
      ),
    observed_at: IsoTimestamp.describe("When the refusal was observed."),
    expires_at: IsoTimestamp.describe(
      "Self-expiry of the observation (bounded retention, not a vendor reset time).",
    ),
  })
  .strict()
  .describe(
    "A live typed refusal of one model on one registered account. It affects routing for that model only and never changes the account's status, Enabled state or order.",
  );
export type ModelScopedCredentialUnusable = z.infer<typeof ModelScopedCredentialUnusable>;

/** `GET /v2/accounts/routing-evidence`: a separate additive read, so the legacy
 * strict Accounts responses stay unchanged for older clients. */
export const ControlAccountRoutingEvidenceResponse = z
  .object({
    capabilities: z
      .array(ModelCapabilityMark)
      .optional()
      .describe(
        "Temporary capability marks; absent from engines that predate them. A mark clears on a success there or a catalog or credential change; after expires_at one operation may probe the account.",
      ),
    credentialUnusable: z
      .array(ModelScopedCredentialUnusable)
      .optional()
      .describe(
        "Live model-scoped credential refusals of the registered rows, most recent first per account, present only when the client asked (includeCredentialUnusable=true). One clears on a later service of exactly that model, a credential change, or expiry.",
      ),
    refusals: z
      .array(PreProgressRefusalObservation)
      .describe("Live pre-progress refusal observations, each scoped to one requested model."),
    lastService: z
      .array(AccountLastService)
      .describe(
        "Latest observed service per registered account and requested model, most recent service first.",
      ),
  })
  .strict()
  .describe(
    "Model-scoped account routing evidence: live refusal marks, temporary capability marks, model-scoped credential refusals and the durable last-served order.",
  );
export type ControlAccountRoutingEvidenceResponse = z.infer<
  typeof ControlAccountRoutingEvidenceResponse
>;

const routingEvidenceFields = {
  routingEvidence: ControlAccountRoutingEvidenceResponse.optional().describe(
    "Model-scoped routing evidence; absent when the engine predates the read or the read failed.",
  ),
  routingEvidenceProblem: z
    .string()
    .optional()
    .describe(
      "One diagnostic when the routing-evidence read failed; the account listing is still authoritative.",
    ),
};

/** `claudexor_accounts` output: the legacy listing (or opt-in snapshot) plus the
 * additive routing evidence. `accountPools.next_up` stays the configured
 * default model's verdict. */
export const McpAccountsToolResult = z
  .union([
    ControlCredentialProfilesResponse.extend(routingEvidenceFields),
    ControlCredentialProfilesSnapshotResponse.extend(routingEvidenceFields),
    ControlCredentialProfilesResourcesResponse.extend(routingEvidenceFields),
  ])
  .describe("Accounts listing or atomic snapshot joined with model-scoped routing evidence.");
export type McpAccountsToolResult = z.infer<typeof McpAccountsToolResult>;
