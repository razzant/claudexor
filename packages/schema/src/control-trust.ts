/**
 * User-level trust control DTOs (INV-122): the NARROW surface over the
 * per-repo trust files. Split from control.ts (INV-124 ratchet).
 */
import { z } from "zod";
import { AccessProfile } from "./primitives.js";

/** User-level trust update; versioned repo config cannot grant either field. */
export const ControlTrustUpdateRequest = z
  .object({
    repoRoot: z.string().min(1).describe("Absolute repo root the trust change applies to."),
    allowFullAccess: z
      .boolean()
      .optional()
      .describe("Grant (true) or revoke (false) unsandboxed full access for the repo."),
    accessDefault: z
      .enum(["readonly", "workspace_write"])
      .optional()
      .describe("Default access profile for runs in the repo."),
  })
  .strict()
  .refine((value) => value.allowFullAccess !== undefined || value.accessDefault !== undefined, {
    message: "allowFullAccess or accessDefault is required",
  })
  .describe(
    "User-level trust update: grant/revoke full access and/or set the readonly/workspace-write default.",
  );
export type ControlTrustUpdateRequest = z.infer<typeof ControlTrustUpdateRequest>;

export const ControlTrustState = z
  .object({
    /** Repo root recorded in the trust file; null for legacy files written
     * before provenance stamping (revocable only via CLI in the repo). */
    repoRoot: z
      .string()
      .nullable()
      .describe(
        "Repo root recorded in the trust file; null for legacy files written before provenance stamping.",
      ),
    /** The user-level trust file backing this state (path disclosure, no content). */
    path: z
      .string()
      .describe("The user-level trust file backing this state (path disclosure, no content)."),
    allowFullAccess: z
      .boolean()
      .describe("Whether unsandboxed full access is allowed for the repo."),
    accessDefault: AccessProfile.describe("Default access profile for runs in the repo."),
  })
  .describe("Trust state of one repo from its user-level trust file.");
export type ControlTrustState = z.infer<typeof ControlTrustState>;

export const ControlTrustListResponse = z
  .object({
    entries: z.array(ControlTrustState).describe("Trust states for all known repos."),
  })
  .describe("Response for listing per-repo trust states.");
export type ControlTrustListResponse = z.infer<typeof ControlTrustListResponse>;
