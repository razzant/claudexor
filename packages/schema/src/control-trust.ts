/**
 * User-level trust control DTOs (INV-122): the NARROW surface over the
 * per-repo trust files. Split from control.ts (INV-124 ratchet).
 */
import { z } from "zod";
import { AccessProfile } from "./primitives.js";

/**
 * NARROW trust update (the ONLY trust field the control API exposes): grant or
 * revoke unsandboxed full access for one repo in the USER-LEVEL trust file —
 * the same file `claudexor trust` writes. Everything else about trust stays
 * CLI-only; unknown fields are refused (strict).
 */
export const ControlTrustUpdateRequest = z
  .object({
    repoRoot: z.string().min(1).describe("Absolute repo root the trust change applies to."),
    allowFullAccess: z
      .boolean()
      .describe("Grant (true) or revoke (false) unsandboxed full access for the repo."),
  })
  .strict()
  .describe(
    "Narrow trust update — the only trust field the control API exposes: grant or revoke unsandboxed full access for one repo in the user-level trust file.",
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
