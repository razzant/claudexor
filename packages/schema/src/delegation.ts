import { z } from "zod/v3";
import { Id } from "./primitives.js";

export const MAX_DELEGATED_CHILDREN = 8;

export const DelegatedChildRunIds = z
  .array(Id)
  .max(MAX_DELEGATED_CHILDREN)
  .default([])
  .describe(
    "At most eight server-owned direct Delegate child ids for whole-thread workspace aggregation.",
  );

/** Install + harness truth used to decide whether Delegate can be offered. */
export const DelegationCapability = z
  .object({
    available: z
      .boolean()
      .describe("Whether this harness can receive the packaged delegation belt."),
    reason: z
      .enum(["ready", "runtime_unavailable", "manifest_unsupported"])
      .describe("Stable reason for the current delegation capability verdict."),
    remediation: z
      .string()
      .nullable()
      .default(null)
      .describe("Concrete update/repair guidance when unavailable; null when ready."),
    requiresFullAccess: z
      .boolean()
      .default(false)
      .describe("Whether this harness can reach the belt only under a full-access profile."),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.available && (value.reason !== "ready" || value.remediation !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "available Delegate capability requires reason=ready and remediation=null",
      });
    }
    if (!value.available && (value.reason === "ready" || !value.remediation)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "unavailable Delegate capability requires an unavailable reason and remediation",
      });
    }
  })
  .describe("Engine-owned Delegate capability projection for one harness and installed runtime.");
export type DelegationCapability = z.infer<typeof DelegationCapability>;

/** Why a requested Delegate strategy did or did not become effective. */
export const RunDelegationReason = z.enum([
  "pending",
  "not_requested",
  "injected_unused",
  "used",
  "runtime_unavailable",
  "manifest_unsupported",
  "access_profile_incompatible",
  "partially_degraded",
  "startup_failed",
]);
export type RunDelegationReason = z.infer<typeof RunDelegationReason>;

export function delegationRemediationForReason(reason: RunDelegationReason): string | null {
  switch (reason) {
    case "runtime_unavailable":
      return "Update or repair the Claudexor runtime, then retry Delegate.";
    case "manifest_unsupported":
      return "Choose a harness with Delegate support, or continue as ordinary Agent.";
    case "access_profile_incompatible":
      return "Use full access for this harness, or choose a harness that can run Delegate in the current access profile.";
    case "startup_failed":
      return "Repair the required delegation belt startup failure, then retry the run.";
    case "partially_degraded":
      return "One selected lane continued as ordinary Agent; inspect its Delegate requirement receipt or choose only Delegate-capable lanes.";
    default:
      return null;
  }
}

/**
 * One run-level Delegate receipt. `effective` means the engine actually
 * injected the descriptor; it is not a guess that an adapter reported ready.
 * `used` requires typed belt-tool evidence and can never be inferred from prose.
 */
export const RunDelegationInfo = z
  .object({
    requested: z.boolean().default(false),
    effective: z.boolean().default(false),
    used: z.boolean().default(false),
    reason: RunDelegationReason.default("not_requested"),
    remediation: z.string().min(1).nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    const expectedRemediation = delegationRemediationForReason(value.reason);
    const valid =
      (!value.requested && !value.effective && !value.used && value.reason === "not_requested") ||
      (value.requested &&
        !value.effective &&
        !value.used &&
        [
          "pending",
          "runtime_unavailable",
          "manifest_unsupported",
          "access_profile_incompatible",
        ].includes(value.reason)) ||
      (value.requested &&
        value.effective &&
        !value.used &&
        ["injected_unused", "partially_degraded", "startup_failed"].includes(value.reason)) ||
      (value.requested &&
        value.effective &&
        value.used &&
        ["used", "partially_degraded", "startup_failed"].includes(value.reason));
    if (!valid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Delegate requested/effective/used fields contradict reason",
      });
    }
    if (value.remediation !== expectedRemediation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Delegate remediation must match the stable reason",
      });
    }
  })
  .describe(
    "Engine-owned Delegate requested/effective/used receipt; surfaces project it without parsing model output.",
  );
export type RunDelegationInfo = z.infer<typeof RunDelegationInfo>;
