import { z } from "zod";
import { AccessProfile, ModeKind } from "./primitives.js";
import { Portfolio } from "./budget.js";
import { AdapterStatus, HarnessManifest } from "./harness.js";
import { DecisionRecord } from "./decision.js";
import { WorkProduct } from "./workproduct.js";

export const ControlRunStartRequest = z.object({
  prompt: z.string().default(""),
  mode: ModeKind.default("agent"),
  harnesses: z.array(z.string()).optional(),
  primaryHarness: z.string().optional(),
  portfolio: Portfolio.optional(),
  model: z.string().optional(),
  reviewerModels: z.record(z.string(), z.string()).optional(),
  n: z.number().int().positive().optional(),
  attempts: z.number().int().positive().nullable().optional(),
  maxUsd: z.number().nonnegative().nullable().optional(),
  access: AccessProfile.optional(),
  tests: z.array(z.string()).optional(),
  repoRoot: z.string().optional(),
  inPlace: z.boolean().optional(),
  envProfile: z.string().optional(),
});
export type ControlRunStartRequest = z.infer<typeof ControlRunStartRequest>;

export const ControlRunStartInfo = z.object({
  jobId: z.string().optional(),
  runId: z.string(),
  taskId: z.string().optional(),
  runDir: z.string(),
});
export type ControlRunStartInfo = z.infer<typeof ControlRunStartInfo>;

export const ControlRunState = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "exhausted",
  "not_converged",
]);
export type ControlRunState = z.infer<typeof ControlRunState>;

export const ControlQueuedRunInfo = z.object({
  jobId: z.string(),
  state: ControlRunState,
  error: z.string().optional(),
});
export type ControlQueuedRunInfo = z.infer<typeof ControlQueuedRunInfo>;

export const ControlRunSummary = z.object({
  jobId: z.string(),
  runId: z.string(),
  taskId: z.string().optional(),
  state: ControlRunState,
  runDir: z.string().optional(),
  error: z.string().optional(),
  mode: ModeKind.optional(),
  prompt: z.string().optional(),
  harnesses: z.array(z.string()).optional(),
  primaryHarness: z.string().optional(),
  portfolio: Portfolio.optional(),
  model: z.string().optional(),
  n: z.number().int().optional(),
  maxUsd: z.number().nullable().optional(),
  access: AccessProfile.optional(),
  tests: z.array(z.string()).optional(),
  createdAt: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
});
export type ControlRunSummary = z.infer<typeof ControlRunSummary>;

export const ControlArtifactInfo = z.object({
  path: z.string(),
  kind: z.enum(["file", "directory"]),
  bytes: z.number().int().nonnegative().optional(),
});
export type ControlArtifactInfo = z.infer<typeof ControlArtifactInfo>;

export const ControlRunDetail = z.object({
  summary: ControlRunSummary,
  artifacts: z.array(ControlArtifactInfo).default([]),
  finalSummary: z.string().nullable().default(null),
  decision: DecisionRecord.nullable().default(null),
  workProduct: WorkProduct.nullable().default(null),
});
export type ControlRunDetail = z.infer<typeof ControlRunDetail>;

export const ControlApplyCheckRequest = z.object({
  repoRoot: z.string().optional(),
});
export type ControlApplyCheckRequest = z.infer<typeof ControlApplyCheckRequest>;

export const ControlApplyRequest = z.object({
  repoRoot: z.string().optional(),
  mode: z.enum(["artifact_only", "apply", "branch", "commit", "pr"]).default("apply"),
  branch: z.string().optional(),
  message: z.string().optional(),
});
export type ControlApplyRequest = z.infer<typeof ControlApplyRequest>;

export const HarnessStatusDto = z.object({
  id: z.string(),
  status: AdapterStatus,
  manifest: HarnessManifest.nullable().optional(),
  enabledIntents: z.array(z.string()).default([]),
  disabledIntents: z.array(z.string()).default([]),
  reasons: z.array(z.string()).default([]),
});
export type HarnessStatusDto = z.infer<typeof HarnessStatusDto>;

export const ControlHarnessListResponse = z.object({
  harnesses: z.array(HarnessStatusDto).default([]),
});
export type ControlHarnessListResponse = z.infer<typeof ControlHarnessListResponse>;

export const ControlSettingsSnapshot = z.object({
  sources: z.array(z.string()).default([]),
  defaultPortfolio: Portfolio.default("subscription-first"),
  routing: z
    .object({
      defaultPolicy: z.enum(["auto", "primary", "portfolio"]).default("auto"),
      primaryHarness: z.string().nullable().default(null),
      eligibleHarnesses: z.array(z.string()).default([]),
      defaultModel: z.string().nullable().default(null),
      envInheritance: z.enum(["mirror_native", "clean", "profile_only"]).default("mirror_native"),
    })
    .default({}),
  budget: z
    .object({
      maxUsdPerRun: z.number().nullable().default(null),
      maxUsdPerDay: z.number().nullable().default(null),
    })
    .default({}),
});
export type ControlSettingsSnapshot = z.infer<typeof ControlSettingsSnapshot>;

export const ControlSettingsUpdateRequest = z
  .object({
    defaultPortfolio: Portfolio.optional(),
    routingPolicy: z.enum(["auto", "primary", "portfolio"]).optional(),
    primaryHarness: z.string().nullable().optional(),
    defaultModel: z.string().nullable().optional(),
    eligibleHarnesses: z.array(z.string()).optional(),
    envInheritance: z.enum(["mirror_native", "clean", "profile_only"]).optional(),
    maxUsdPerRun: z.number().nonnegative().optional(),
    maxUsdPerDay: z.number().nonnegative().optional(),
    clearMaxUsdPerRun: z.boolean().optional(),
    clearMaxUsdPerDay: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.maxUsdPerRun !== undefined && value.clearMaxUsdPerRun === true) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["maxUsdPerRun"], message: "maxUsdPerRun and clearMaxUsdPerRun are mutually exclusive" });
    }
    if (value.maxUsdPerDay !== undefined && value.clearMaxUsdPerDay === true) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["maxUsdPerDay"], message: "maxUsdPerDay and clearMaxUsdPerDay are mutually exclusive" });
    }
  });
export type ControlSettingsUpdateRequest = z.infer<typeof ControlSettingsUpdateRequest>;

export const SecretMetadata = z.object({
  name: z.string(),
  backend: z.enum(["keychain", "file"]),
  present: z.boolean().default(true),
  harnesses: z.array(z.string()).default([]),
  env: z.string().optional(),
  description: z.string().optional(),
});
export type SecretMetadata = z.infer<typeof SecretMetadata>;

export const ControlSecretListResponse = z.object({
  backend: z.enum(["keychain", "file"]),
  secrets: z.array(SecretMetadata).default([]),
});
export type ControlSecretListResponse = z.infer<typeof ControlSecretListResponse>;
