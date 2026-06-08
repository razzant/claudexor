import { z } from "zod";
import { AccessProfile, ContentHash, Id, ModeKind } from "./primitives.js";
import { Portfolio } from "./budget.js";
import { AdapterStatus, EffortHint, HarnessManifest } from "./harness.js";
import { DecisionRecord } from "./decision.js";
import { WorkProduct } from "./workproduct.js";
import { ReviewFinding } from "./review.js";

export const RunScopeContext = z.enum(["auto", "deep"]);
export type RunScopeContext = z.infer<typeof RunScopeContext>;

export const RunScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), root: z.string(), context: RunScopeContext.default("auto") }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);
export type RunScope = z.infer<typeof RunScope>;

export const RunExecution = z
  .object({
    isolation: z.enum(["envelope", "live"]).default("envelope"),
  })
  .strict();
export type RunExecution = z.infer<typeof RunExecution>;

export const ControlRunStartRequest = z
  .object({
    prompt: z.string().default(""),
    mode: ModeKind.default("agent"),
    scope: RunScope.default({ kind: "none" }),
    execution: RunExecution.default({ isolation: "envelope" }),
    harnesses: z.array(z.string()).optional(),
    primaryHarness: z.string().optional(),
    portfolio: Portfolio.optional(),
    model: z.string().optional(),
    effort: EffortHint.optional(),
    reviewerModels: z.record(z.string(), z.string()).optional(),
    reviewerEfforts: z
      .object({
        anthropic: EffortHint.optional(),
      })
      .strict()
      .optional(),
    n: z.number().int().positive().optional(),
    attempts: z.number().int().positive().nullable().optional(),
    maxUsd: z.number().nonnegative().nullable().optional(),
    access: AccessProfile.optional(),
    tests: z.array(z.string()).optional(),
    envProfile: z.string().optional(),
    specPath: z.string().optional(),
    specId: z.string().optional(),
    specHash: ContentHash.optional(),
  })
  .strict();
export type ControlRunStartRequest = z.infer<typeof ControlRunStartRequest>;

export const ControlHarnessSetupAction = z.enum(["install_guide", "install", "login", "doctor"]);
export type ControlHarnessSetupAction = z.infer<typeof ControlHarnessSetupAction>;
export const ControlHarnessSetupHarness = z.enum(["codex", "claude", "cursor", "opencode", "raw"]);
export type ControlHarnessSetupHarness = z.infer<typeof ControlHarnessSetupHarness>;

export const ControlHarnessSetupRequest = z.object({
  harness: ControlHarnessSetupHarness,
  action: ControlHarnessSetupAction.default("login"),
}).strict();
export type ControlHarnessSetupRequest = z.infer<typeof ControlHarnessSetupRequest>;

export const ControlHarnessSetupResponse = z.object({
  harness: ControlHarnessSetupHarness,
  action: ControlHarnessSetupAction,
  status: z.enum(["prepared", "not_supported"]),
  command: z.string().nullable().default(null),
  guideUrl: z.string().url().nullable().default(null),
  logPath: z.string().nullable().default(null),
  message: z.string(),
});
export type ControlHarnessSetupResponse = z.infer<typeof ControlHarnessSetupResponse>;

export const ControlSetupJobAction = z.enum(["install", "login", "doctor", "store_key"]);
export type ControlSetupJobAction = z.infer<typeof ControlSetupJobAction>;

export const ControlSetupJobState = z.enum([
  "queued",
  "running",
  "waiting_for_input",
  "succeeded",
  "failed",
  "cancelled",
  "not_supported",
]);
export type ControlSetupJobState = z.infer<typeof ControlSetupJobState>;

export const ControlSetupJobCreateRequest = z
  .object({
    harness: ControlHarnessSetupHarness,
    action: ControlSetupJobAction,
  })
  .strict();
export type ControlSetupJobCreateRequest = z.infer<typeof ControlSetupJobCreateRequest>;

export const ControlSetupJob = z
  .object({
    jobId: Id,
    harness: ControlHarnessSetupHarness,
    action: ControlSetupJobAction,
    state: ControlSetupJobState,
    command: z.string().nullable().default(null),
    guideUrl: z.string().url().nullable().default(null),
    logPath: z.string().nullable().default(null),
    message: z.string(),
    riskFlags: z.array(z.string()).default([]),
    requiresConfirmation: z.boolean().default(false),
    createdAt: z.string(),
    startedAt: z.string().nullable().default(null),
    finishedAt: z.string().nullable().default(null),
  })
  .strict();
export type ControlSetupJob = z.infer<typeof ControlSetupJob>;

export const ControlSetupJobEvent = z
  .object({
    jobId: Id,
    seq: z.number().int().nonnegative(),
    time: z.string(),
    kind: z.enum(["status", "log", "end"]),
    state: ControlSetupJobState.optional(),
    message: z.string(),
  })
  .strict();
export type ControlSetupJobEvent = z.infer<typeof ControlSetupJobEvent>;

export const ControlSetupJobListResponse = z.object({
  jobs: z.array(ControlSetupJob),
});
export type ControlSetupJobListResponse = z.infer<typeof ControlSetupJobListResponse>;

export const ControlSetupJobConfirmRequest = z.object({
  confirmed: z.boolean().default(true),
}).strict();
export type ControlSetupJobConfirmRequest = z.infer<typeof ControlSetupJobConfirmRequest>;

export const ControlSpecQuestionsRequest = z
  .object({
    prompt: z.string(),
    scope: z.object({ kind: z.literal("project"), root: z.string() }).strict(),
    harnesses: z.array(z.string()).optional(),
  })
  .strict();
export type ControlSpecQuestionsRequest = z.infer<typeof ControlSpecQuestionsRequest>;

export const ControlSpecFreezeRequest = z
  .object({
    prompt: z.string(),
    scope: z.object({ kind: z.literal("project"), root: z.string() }).strict(),
    planDir: z.string().optional(),
    plan: z.string().optional(),
    answers: z.array(z.unknown()).optional(),
  })
  .strict();
export type ControlSpecFreezeRequest = z.infer<typeof ControlSpecFreezeRequest>;

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
  "blocked",
  "succeeded",
  "no_op",
  "ungated",
  "review_not_run",
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

export const RunFailure = z.object({
  phase: z.string().default("unknown"),
  category: z
    .enum([
      "validation",
      "project",
      "auth",
      "harness_unavailable",
      "harness_error",
      "budget",
      "policy",
      "cancelled",
      "internal",
      "unknown",
    ])
    .default("unknown"),
  harnessId: z.string().nullable().default(null),
  attemptId: z.string().nullable().default(null),
  safeMessage: z.string(),
  rawDetailRef: z.string().nullable().default(null),
  logRefs: z.array(z.string()).default([]),
  eventRefs: z.array(z.string()).default([]),
  runDir: z.string().nullable().default(null),
  nextActions: z.array(z.string()).default([]),
});
export type RunFailure = z.infer<typeof RunFailure>;

export const ControlProjectMetadata = z.object({
  kind: z.enum(["project", "none"]).default("none"),
  root: z.string().nullable().default(null),
  projectName: z.string().nullable().default(null),
  context: z.enum(["off", "auto", "deep"]).default("off"),
});
export type ControlProjectMetadata = z.infer<typeof ControlProjectMetadata>;

export const ControlRunSummary = z.object({
  jobId: z.string(),
  runId: z.string(),
  taskId: z.string().optional(),
  state: ControlRunState,
  runDir: z.string().optional(),
  error: z.string().optional(),
  failure: RunFailure.nullable().default(null),
  project: ControlProjectMetadata.default({}),
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
  specId: z.string().optional(),
  specHash: ContentHash.optional(),
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
  reviewFindings: z.array(ReviewFinding).default([]),
  failure: RunFailure.nullable().default(null),
});
export type ControlRunDetail = z.infer<typeof ControlRunDetail>;

export const RunControlTarget = z.object({
  attemptId: z.string().optional(),
  harnessId: z.string().optional(),
  sessionId: z.string().optional(),
  requestId: z.string().optional(),
});
export type RunControlTarget = z.infer<typeof RunControlTarget>;

export const RunControl = z.object({
  kind: z.enum(["cancel", "interrupt", "successor_run", "answer_question", "approve", "reject"]),
  target: RunControlTarget.default({}),
  reason: z.string().optional(),
  idempotencyKey: z.string().optional(),
});
export type RunControl = z.infer<typeof RunControl>;

export const RunInput = z.object({
  kind: z.enum(["message", "answer", "approval", "rejection", "correction"]),
  target: RunControlTarget.default({}),
  text: z.string().optional(),
  answers: z.array(z.record(z.string(), z.unknown())).default([]),
  idempotencyKey: z.string().optional(),
});
export type RunInput = z.infer<typeof RunInput>;

export const ControlRunControlRequest = z.object({
  control: RunControl,
});
export type ControlRunControlRequest = z.infer<typeof ControlRunControlRequest>;

export const ControlRunInputRequest = z.object({
  input: RunInput,
});
export type ControlRunInputRequest = z.infer<typeof ControlRunInputRequest>;

export const ControlRunControlResponse = z.object({
  accepted: z.boolean(),
  status: z.enum(["applied", "queued", "rejected", "unsupported"]).default("queued"),
  runId: Id.optional(),
  successorRunId: Id.optional(),
  message: z.string().optional(),
});
export type ControlRunControlResponse = z.infer<typeof ControlRunControlResponse>;

export const ApplyTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("original_project") }).strict(),
  z.object({ kind: z.literal("project"), root: z.string() }).strict(),
]);
export type ApplyTarget = z.infer<typeof ApplyTarget>;

export const ControlApplyCheckRequest = z
  .object({
    target: ApplyTarget.default({ kind: "original_project" }),
  })
  .strict();
export type ControlApplyCheckRequest = z.infer<typeof ControlApplyCheckRequest>;

export const ControlApplyRequest = z
  .object({
    target: ApplyTarget.default({ kind: "original_project" }),
    mode: z.enum(["artifact_only", "apply", "branch", "commit", "pr"]).default("apply"),
    branch: z.string().optional(),
    message: z.string().optional(),
  })
  .strict();
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
