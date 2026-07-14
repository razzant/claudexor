import { z } from "zod";
import { AuthCapabilityLifecycle } from "./auth.js";
import { Id } from "./primitives.js";

const SetupTimestamp = z.string().datetime({ offset: true });
const Sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

export const ProcessIdentityKnown = z
  .object({
    status: z.literal("known"),
    pid: z.number().int().positive(),
    platform: z.enum(["linux", "darwin"]),
    source: z.enum(["procfs_stat", "proc_pidinfo"]),
    startToken: z.string().min(1),
    processGroupId: z.number().int().positive(),
  })
  .strict();
export type ProcessIdentityKnown = z.infer<typeof ProcessIdentityKnown>;

export const ProcessIdentity = z.discriminatedUnion("status", [
  ProcessIdentityKnown,
  z
    .object({
      status: z.literal("missing"),
      pid: z.number().int().positive(),
      platform: z.string().min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal("unknown"),
      pid: z.number().int().positive(),
      platform: z.string().min(1),
      reason: z.enum([
        "invalid_pid",
        "unsupported_platform",
        "permission_denied",
        "malformed_response",
        "helper_unavailable",
        "helper_failed",
        "io_error",
      ]),
    })
    .strict(),
]);
export type ProcessIdentity = z.infer<typeof ProcessIdentity>;

export const SetupProcessGroupHandle = z
  .object({
    schemaVersion: z.literal(1),
    pgid: z.number().int().positive(),
    leader: ProcessIdentityKnown,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.leader.pid !== value.pgid || value.leader.processGroupId !== value.pgid) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "process group leader must own the recorded pgid",
      });
    }
  });
export type SetupProcessGroupHandle = z.infer<typeof SetupProcessGroupHandle>;

export const SetupExecutionEvidence = z
  .object({
    executionId: z.string().regex(/^[A-Za-z0-9-]+$/),
    commandDigest: Sha256Hex,
    manifestDigest: Sha256Hex,
    processGroup: SetupProcessGroupHandle,
    observedAt: SetupTimestamp,
    permitIssuedAt: SetupTimestamp.optional(),
  })
  .strict();
export type SetupExecutionEvidence = z.infer<typeof SetupExecutionEvidence>;

export const SetupExecutableEvidence = z
  .object({
    realpath: z.string().startsWith("/"),
    sha256: Sha256Hex,
    size: z.number().int().nonnegative(),
    mode: z.number().int().nonnegative(),
    device: z.string().regex(/^[0-9]+$/),
    inode: z.string().regex(/^[0-9]+$/),
  })
  .strict();
export type SetupExecutableEvidence = z.infer<typeof SetupExecutableEvidence>;

export const SetupCommandAuthorization = z
  .object({
    executionId: z.string().regex(/^[A-Za-z0-9-]+$/),
    executable: SetupExecutableEvidence,
    args: z.array(z.string()),
    commandDigest: Sha256Hex,
    manifestDigest: Sha256Hex,
  })
  .strict();
export type SetupCommandAuthorization = z.infer<typeof SetupCommandAuthorization>;

const SetupNativeCommandReceiptShape = {
  executionId: z.string().regex(/^[A-Za-z0-9-]+$/),
  commandDigest: Sha256Hex,
  manifestDigest: Sha256Hex,
  permitIssuedAt: SetupTimestamp.nullable(),
  commandStarted: z.boolean(),
  exitCode: z.number().int().nonnegative().nullable(),
  signal: z.string().nullable(),
  errorCode: z.enum(["permit_timeout", "spawn_failed"]).optional(),
  finishedAt: SetupTimestamp,
};

export const SetupNativeCommandReceipt = z
  .object(SetupNativeCommandReceiptShape)
  .strict()
  .superRefine((value, context) => {
    if (value.commandStarted && value.permitIssuedAt === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["permitIssuedAt"],
        message: "a started native command requires the exact durable permit timestamp",
      });
    }
    if (
      value.errorCode === "permit_timeout" &&
      (value.commandStarted || value.permitIssuedAt !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorCode"],
        message: "permit_timeout must prove that no command and no permit existed",
      });
    }
    if (value.errorCode === "spawn_failed" && value.commandStarted) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorCode"],
        message: "spawn_failed cannot claim that the command started",
      });
    }
  })
  .describe("Durable, hash-bound result of the allowlisted native setup command.");
export type SetupNativeCommandReceipt = z.infer<typeof SetupNativeCommandReceipt>;

/** Harness ids with a daemon-managed native-login flow. */
export const ControlHarnessSetupHarness = z
  .enum(["codex", "claude", "cursor"])
  .describe("Harness ids with a managed native-login flow.");
export type ControlHarnessSetupHarness = z.infer<typeof ControlHarnessSetupHarness>;

export const ControlSetupJobAction = z
  .literal("login")
  .describe("The daemon-managed native-login action.");
export type ControlSetupJobAction = z.infer<typeof ControlSetupJobAction>;

export const ControlSetupJobState = z
  .enum([
    "queued",
    "running",
    "waiting_for_input",
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "interrupted_unknown",
    "not_supported",
  ])
  .describe(
    "Lifecycle state of a setup job, including waiting_for_input (needs user confirmation/input) and not_supported.",
  );
export type ControlSetupJobState = z.infer<typeof ControlSetupJobState>;

/** Canonical terminal-state catalog shared by setup producers and projections. */
export const TERMINAL_CONTROL_SETUP_JOB_STATES = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted_unknown",
  "not_supported",
] as const satisfies readonly ControlSetupJobState[];

const TERMINAL_CONTROL_SETUP_JOB_STATE_SET = new Set<ControlSetupJobState>(
  TERMINAL_CONTROL_SETUP_JOB_STATES,
);

export function isTerminalControlSetupJobState(state: ControlSetupJobState): boolean {
  return TERMINAL_CONTROL_SETUP_JOB_STATE_SET.has(state);
}

export const ControlSetupJobPhase = z
  .enum(["preparing", "launching", "awaiting_user", "verifying", "cancelling", "completed"])
  .describe(
    "Fine-grained setup phase; cancellation remains a phase until the underlying process has actually stopped.",
  );
export type ControlSetupJobPhase = z.infer<typeof ControlSetupJobPhase>;

export const ControlSetupJobOutcome = z
  .object({
    reason: z.enum([
      "completed",
      "not_supported",
      "launch_failed",
      "command_failed",
      "auth_not_ready",
      "capability_verification_failed",
      "credential_route_mismatch",
      "timed_out",
      "cancelled_by_user",
      "cancelled_on_restart",
      "interrupted",
      "interrupted_unknown",
      "termination_unconfirmed",
    ]),
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().nullable().optional(),
  })
  .strict()
  .describe("Typed terminal setup outcome with native command evidence when available.");
export type ControlSetupJobOutcome = z.infer<typeof ControlSetupJobOutcome>;

export const ControlSetupJobCreateRequest = z
  .object({
    harness: ControlHarnessSetupHarness,
    action: ControlSetupJobAction,
    authRequest: z.literal("subscription"),
  })
  .strict()
  .describe("Request body to create an exact-subscription native-login job.");
export type ControlSetupJobCreateRequest = z.infer<typeof ControlSetupJobCreateRequest>;

export const ControlSetupJob = z
  .object({
    jobId: Id.describe("Setup job id."),
    harness: ControlHarnessSetupHarness,
    action: ControlSetupJobAction,
    state: ControlSetupJobState,
    phase: ControlSetupJobPhase,
    deadlineAt: SetupTimestamp.optional().describe(
      "Current native-login deadline when the job has one.",
    ),
    outcome: ControlSetupJobOutcome.optional(),
    command: z
      .string()
      .nullable()
      .describe("Display-only native-login command description, when available."),
    guideUrl: z.string().url().nullable().describe("Official vendor login guide URL."),
    message: z.string().describe("Human-readable status message."),
    createdAt: SetupTimestamp.describe("When the job was created."),
    startedAt: SetupTimestamp.nullable().describe("When the job started running."),
    finishedAt: SetupTimestamp.nullable().describe("When the job finished."),
    authCapability: AuthCapabilityLifecycle.optional().describe(
      "Single durable lifecycle for the exact-route same-harness capability proof.",
    ),
    execution: SetupExecutionEvidence.optional().describe(
      "Durable process-group and pre-execution permit evidence.",
    ),
    authorization: SetupCommandAuthorization.optional().describe(
      "Immutable hash-bound command authorized before external handoff.",
    ),
    nativeCommand: SetupNativeCommandReceipt.optional().describe(
      "Durable result of the hash-bound native login command, persisted before capability verification.",
    ),
  })
  .strict()
  .superRefine((value, context) => {
    const disclosure = value.authCapability?.disclosure;
    if (
      !disclosure ||
      disclosure.harness !== value.harness ||
      disclosure.requested !== "subscription" ||
      disclosure.requiredRoute !== "vendor_native" ||
      disclosure.requiredSource !== "native_session"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authCapability"],
        message: "login jobs require one exact native-subscription capability lifecycle",
      });
    }
    if (value.authCapability?.state === "completed") {
      const receipt = value.authCapability.receipt;
      if (
        receipt.harness !== value.harness ||
        receipt.requested !== disclosure?.requested ||
        receipt.requiredRoute !== disclosure?.requiredRoute ||
        receipt.requiredSource !== disclosure?.requiredSource
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["authCapability"],
          message: "capability receipt contradicts its login job",
        });
      }
    }
    if (value.nativeCommand) {
      if (
        !value.authorization ||
        value.nativeCommand.executionId !== value.authorization.executionId ||
        value.nativeCommand.commandDigest !== value.authorization.commandDigest ||
        value.nativeCommand.manifestDigest !== value.authorization.manifestDigest
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nativeCommand"],
          message: "native command evidence must match the immutable command authorization",
        });
      }
      if (
        value.nativeCommand.permitIssuedAt !== null &&
        (!value.execution ||
          value.execution.permitIssuedAt !== value.nativeCommand.permitIssuedAt ||
          value.execution.executionId !== value.nativeCommand.executionId ||
          value.execution.commandDigest !== value.nativeCommand.commandDigest ||
          value.execution.manifestDigest !== value.nativeCommand.manifestDigest)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nativeCommand"],
          message: "permitted native command evidence must match durable execution evidence",
        });
      }
    }
    const receipt =
      value.authCapability?.state === "completed" ? value.authCapability.receipt : undefined;
    if (
      value.state === "succeeded" &&
      (receipt?.verification !== "passed" ||
        receipt.effective !== "vendor_native" ||
        receipt.effectiveSource !== "native_session")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state"],
        message: "login success requires a passed exact native-session capability receipt",
      });
    }
    if (
      value.state === "interrupted_unknown" &&
      value.authCapability?.state !== "interrupted_unknown"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authCapability"],
        message: "interrupted_unknown setup state requires interrupted auth capability evidence",
      });
    }
  })
  .describe("One daemon-managed exact-subscription native-login job.");
export type ControlSetupJob = z.infer<typeof ControlSetupJob>;

export const ControlSetupJobListFilter = z
  .object({
    harness: ControlHarnessSetupHarness.optional(),
    action: ControlSetupJobAction.optional(),
    active: z.boolean().optional(),
    limit: z.number().int().positive().max(500).optional(),
  })
  .strict()
  .describe("Supported GET /setup/jobs filters.");
export type ControlSetupJobListFilter = z.infer<typeof ControlSetupJobListFilter>;

export const ControlSetupJobEvent = z
  .object({
    jobId: Id.describe("Setup job the event belongs to."),
    cursor: z
      .string()
      .min(1)
      .max(4096)
      .describe("Opaque durable global-journal cursor for exact SSE resume."),
    previousCursor: z
      .string()
      .min(1)
      .max(4096)
      .nullable()
      .describe(
        "Exact client-relative predecessor cursor; null only at the beginning of the global journal.",
      ),
    sequence: z
      .number()
      .int()
      .positive()
      .safe()
      .describe(
        "Global partition sequence used to reject duplicate or regressive frames; gaps are valid.",
      ),
    time: SetupTimestamp.describe("Event timestamp."),
    kind: z.enum(["status"]).describe("Event kind; only status is ever produced."),
    state: ControlSetupJobState,
    message: z.string().describe("Human-readable status message."),
    job: ControlSetupJob.describe("Full authoritative setup-job snapshot at this cursor."),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.previousCursor === value.cursor) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["previousCursor"],
        message: "setup event cannot point to itself as its predecessor",
      });
    }
    if (value.job.jobId !== value.jobId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "setup event job identity mismatch",
      });
    }
    if (value.job.state !== value.state || value.job.message !== value.message) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "setup event summary contradicts its job snapshot",
      });
    }
  })
  .describe("Status event on a setup job's event stream.");
export type ControlSetupJobEvent = z.infer<typeof ControlSetupJobEvent>;

export const ControlSetupJobSnapshot = z
  .object({
    job: ControlSetupJob,
    cursor: z
      .string()
      .min(1)
      .max(4096)
      .describe("Opaque durable cursor fencing the returned snapshot."),
    sequence: z
      .number()
      .int()
      .nonnegative()
      .safe()
      .describe("Global partition sequence fenced by the snapshot."),
  })
  .strict()
  .describe("Atomically fenced setup-job snapshot used before attaching or reattaching SSE.");
export type ControlSetupJobSnapshot = z.infer<typeof ControlSetupJobSnapshot>;

export const ControlSetupJobListResponse = z
  .object({ jobs: z.array(ControlSetupJob).describe("All known setup jobs.") })
  .describe("Response for listing setup jobs.");
export type ControlSetupJobListResponse = z.infer<typeof ControlSetupJobListResponse>;

/** Internal, file-backed protocol between claudexord and the detached native-login runner. */
export const SetupLoginProtocolVersion = z.literal(2);

const SetupLoginJobId = z.string().regex(/^setup-[A-Za-z0-9-]+$/);
const SetupLoginExecutionId = z.string().regex(/^[A-Za-z0-9-]+$/);
const AbsolutePath = z.string().startsWith("/");

export const SetupLoginManifest = z
  .object({
    version: SetupLoginProtocolVersion,
    jobId: SetupLoginJobId,
    executionId: SetupLoginExecutionId,
    harness: z.enum(["codex", "claude", "cursor"]),
    jobDir: AbsolutePath,
    binary: AbsolutePath,
    args: z.array(z.string()),
    cwd: AbsolutePath,
    statePath: AbsolutePath,
    resultPath: AbsolutePath,
    permitPath: AbsolutePath,
    permitDeadlineAt: SetupTimestamp,
    executable: SetupExecutableEvidence,
    commandDigest: Sha256Hex,
    manifestDigest: Sha256Hex,
  })
  .strict();
export type SetupLoginManifest = z.infer<typeof SetupLoginManifest>;

export const SetupLoginRunnerState = z
  .object({
    version: SetupLoginProtocolVersion,
    jobId: SetupLoginJobId,
    executionId: SetupLoginExecutionId,
    processGroup: SetupProcessGroupHandle,
    stage: z.enum(["awaiting_permit", "running"]),
    observedAt: SetupTimestamp,
    commandDigest: Sha256Hex,
    manifestDigest: Sha256Hex,
  })
  .strict();
export type SetupLoginRunnerState = z.infer<typeof SetupLoginRunnerState>;

export const SetupLoginPermit = z
  .object({
    version: SetupLoginProtocolVersion,
    jobId: SetupLoginJobId,
    executionId: SetupLoginExecutionId,
    issuedAt: SetupTimestamp,
    commandDigest: Sha256Hex,
    manifestDigest: Sha256Hex,
  })
  .strict();
export type SetupLoginPermit = z.infer<typeof SetupLoginPermit>;

export const SetupLoginRunnerResult = z
  .object({
    version: SetupLoginProtocolVersion,
    jobId: SetupLoginJobId,
    ...SetupNativeCommandReceiptShape,
  })
  .strict()
  .superRefine((value, context) => {
    const parsed = SetupNativeCommandReceipt.safeParse({
      executionId: value.executionId,
      commandDigest: value.commandDigest,
      manifestDigest: value.manifestDigest,
      permitIssuedAt: value.permitIssuedAt,
      commandStarted: value.commandStarted,
      exitCode: value.exitCode,
      signal: value.signal,
      ...(value.errorCode ? { errorCode: value.errorCode } : {}),
      finishedAt: value.finishedAt,
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) context.addIssue(issue);
    }
  });
export type SetupLoginRunnerResult = z.infer<typeof SetupLoginRunnerResult>;
