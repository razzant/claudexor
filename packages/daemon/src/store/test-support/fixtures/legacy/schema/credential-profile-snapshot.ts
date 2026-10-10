import { ControlAccountResourcesResponse } from "./account-resources.js";
import { z } from "zod/v3";
import { ControlCredentialProfilesResponse } from "./credential-profile.js";
import { GitCapability } from "./git-capability.js";
import { ControlQuotaResponse } from "./quota.js";
import { HarnessStatusDto } from "./readiness.js";

/** Opt-in atomic Accounts snapshot (`GET /credential-profiles?snapshot=true`).
 * The legacy response stays byte/shape compatible for older strict clients. */
export const ControlCredentialProfilesSnapshotResponse = ControlCredentialProfilesResponse.extend({
  harnesses: z
    .array(HarnessStatusDto)
    .describe("Fresh harness readiness used for the account next-up projection."),
  git: GitCapability.describe("Git readiness from the same Accounts refresh cycle."),
  quota: ControlQuotaResponse.describe(
    "Fresh quota response used to compute next-up in this exact Accounts snapshot epoch, decorated with the same server-owned availability projection as /v2/quota.",
  ),
  quotaEventCursor: z
    .string()
    .min(1)
    .max(4096)
    .describe(
      "Opaque global-journal cursor fencing the returned quota response; pass it verbatim as Last-Event-ID only for the dedicated quota event observer, never the general stream.",
    ),
})
  .strict()
  .describe(
    "Atomic Accounts snapshot: profiles, next-up authority, fresh harness readiness, Git capability, and quota from one server-authored epoch.",
  );
export type ControlCredentialProfilesSnapshotResponse = z.infer<
  typeof ControlCredentialProfilesSnapshotResponse
>;

export const ControlCredentialProfilesResourcesResponse =
  ControlCredentialProfilesSnapshotResponse.extend({
    quota: ControlAccountResourcesResponse,
  }).strict();

/** Operation-catalog response contract for the query-shaped endpoint. The
 * actual route selects exactly one member from the validated `snapshot` query;
 * this union keeps discovery/docs honest without changing the legacy shape. */
export const ControlCredentialProfilesQueryResponse = z
  .union([
    ControlCredentialProfilesResponse,
    ControlCredentialProfilesSnapshotResponse,
    ControlCredentialProfilesResourcesResponse,
  ])
  .describe("Legacy credential-profile listing or the opt-in atomic Accounts snapshot.");
export type ControlCredentialProfilesQueryResponse = z.infer<
  typeof ControlCredentialProfilesQueryResponse
>;
