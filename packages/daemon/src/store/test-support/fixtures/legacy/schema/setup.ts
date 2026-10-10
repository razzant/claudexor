import { z } from "zod/v3";
import { AuthCapabilityLifecycle } from "./auth.js";
import { Id } from "./primitives.js";
import { setupDeviceCodeProjectionEnvelope } from "./setup-device-code-envelope.js";
import * as SetupLoginProtocol from "./setup-login-protocol.js";
import * as SetupTransport from "./setup-transport.js";
export * from "./setup-transport.js";

export const SetupTimestamp = z.string().datetime({ offset: true });
export const Sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

export const ProcessIdentityKnown = z
  .object({
    status: z.literal("known"),
    pid: z.number().int().positive(),
    platform: z.enum(["linux", "darwin", "win32"]),
    source: z.enum(["procfs_stat", "proc_pidinfo", "win32_process_times"]),
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
    realpath: SetupLoginProtocol.SetupLoginAbsolutePath,
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

export const SETUP_TERMINAL_TRANSPORT_ERROR_CODES = [
  "terminal_transport_unavailable",
  "terminal_transport_unsupported",
  "terminal_transport_probe_failed",
  "terminal_transport_failed",
] as const;

/** Exact terminal-backend failures shared by setup admission, the PTY resolver,
 * the detached runner receipt, and strict client decoders. */
export const SetupTerminalTransportErrorCode = z
  .enum(SETUP_TERMINAL_TRANSPORT_ERROR_CODES)
  .describe("Typed setup-login terminal transport failure.");
export type SetupTerminalTransportErrorCode = z.infer<typeof SetupTerminalTransportErrorCode>;

export const SetupNativeCommandErrorCode = z.enum([
  "permit_timeout",
  "spawn_failed",
  "device_auth_unsupported",
  ...SETUP_TERMINAL_TRANSPORT_ERROR_CODES,
]);
export type SetupNativeCommandErrorCode = z.infer<typeof SetupNativeCommandErrorCode>;

export const SetupNativeCommandReceiptShape = {
  executionId: z.string().regex(/^[A-Za-z0-9-]+$/),
  commandDigest: Sha256Hex,
  manifestDigest: Sha256Hex,
  permitIssuedAt: SetupTimestamp.nullable(),
  commandStarted: z.boolean(),
  exitCode: z.number().int().nonnegative().nullable(),
  signal: z.string().nullable(),
  errorCode: SetupNativeCommandErrorCode.optional(),
  finishedAt: SetupTimestamp,
};

export const SetupNativeCommandReceipt = z
  .object(SetupNativeCommandReceiptShape)
  .strict()
  .superRefine((value, context) => {
    const deny = (path: string[], message: string) =>
      context.addIssue({ code: z.ZodIssueCode.custom, path, message });
    if (value.commandStarted && value.permitIssuedAt === null)
      deny(
        ["permitIssuedAt"],
        "a started native command requires the exact durable permit timestamp",
      );
    if (
      value.errorCode === "permit_timeout" &&
      (value.commandStarted || value.permitIssuedAt !== null)
    )
      deny(["errorCode"], "permit_timeout must prove that no command and no permit existed");
    if (value.errorCode === "spawn_failed" && value.commandStarted)
      deny(["errorCode"], "spawn_failed cannot claim that the command started");
    if (value.errorCode === "device_auth_unsupported" && value.commandStarted)
      deny(["errorCode"], "device_auth_unsupported means the vendor command was never started");
    if (
      [
        "terminal_transport_unavailable",
        "terminal_transport_unsupported",
        "terminal_transport_probe_failed",
      ].includes(value.errorCode ?? "") &&
      value.commandStarted
    )
      deny(
        ["errorCode"],
        `${value.errorCode} means the authorized vendor command was never started`,
      );
  })
  .describe("Durable, hash-bound result of the allowlisted native setup command.");
export type SetupNativeCommandReceipt = z.infer<typeof SetupNativeCommandReceipt>;

/** Harness ids with a daemon-managed native-login flow. */
export const ControlHarnessSetupHarness = z
  .enum(["codex", "claude", "cursor", "agy"])
  .describe("Harness ids with a managed native-login flow.");
export type ControlHarnessSetupHarness = z.infer<typeof ControlHarnessSetupHarness>;

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

const ActiveControlSetupJobState = ControlSetupJobState.exclude(TERMINAL_CONTROL_SETUP_JOB_STATES);

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
      // The live monitor proved the permitted process group empty without a result.
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

export const SetupTerminationReconciliation = z
  .object({
    status: z.literal("empty"),
    observedAt: SetupTimestamp,
  })
  .strict()
  .describe("Server-owned proof that a previously unconfirmed setup process group is empty.");
export type SetupTerminationReconciliation = z.infer<typeof SetupTerminationReconciliation>;

export const ControlSetupJobCreateRequest = z
  .object({
    harness: ControlHarnessSetupHarness,
    action: SetupTransport.ControlSetupJobAction,
    authRequest: z.literal("subscription"),
    /** Target a REGISTERED config-dir credential binding (INV-135): the vendor
     * login runs under the binding's exact scoped environment and verification
     * probes that binding under its effective platform credential policy.
     * Absent = the harness's default session (unchanged behavior). */
    profileId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Registered config_dir_login binding to log in under its exact scoped environment; absent = the default session.",
      ),
    /** Codex-only interactive login flow selection. Default (absent) is
     * device_auth — the D-17 primary flow: typed device-code over the official
     * codex app-server (NO Terminal), completed in an isolated browser context
     * it avoids the account-switch trigger that revokes sibling OpenAI sessions
     * (v3.0.3 S6, live-verified). browser_callback is the secondary opt-in
     * app-server flow (`account/login/start {type:"chatgpt"}` → authUrl, no
     * one-time code). browser_redirect is the explicit legacy Terminal
     * localhost-callback flow (the typed fallback when the app-server lacks
     * the auth methods). */
    loginFlow: z
      .enum(["device_auth", "browser_callback", "browser_redirect"])
      .optional()
      .describe(
        "Codex-only: device_auth (default; app-server device-code, isolated browser window), browser_callback (app-server browser-callback opt-in), or browser_redirect (legacy Terminal localhost callback / fallback).",
      ),
    transport: SetupTransport.ControlSetupJobTransportField,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.loginFlow && value.harness !== "codex") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["loginFlow"],
        message: "loginFlow selection exists only for the codex harness",
      });
    }
    SetupTransport.validateSetupTransport(value, context);
  })
  .describe("Request body to create an exact-subscription native-login job.");
export type ControlSetupJobCreateRequest = z.infer<typeof ControlSetupJobCreateRequest>;

export const ControlSetupJob = z
  .object({
    jobId: Id.describe("Setup job id."),
    harness: ControlHarnessSetupHarness,
    action: SetupTransport.ControlSetupJobAction,
    transport: SetupTransport.ControlSetupJobTransport.default("daemon"),
    /** Credential profile this login job targets; null = the default session. */
    profileId: z
      .string()
      .nullable()
      .default(null)
      .describe("Registered profile this login targets; null = the default session."),
    state: ControlSetupJobState,
    phase: ControlSetupJobPhase,
    deadlineAt: SetupTimestamp.optional().describe(
      "Current native-login deadline when the job has one.",
    ),
    deadlineFixed: z
      .boolean()
      .optional()
      .describe(
        "Whether the deadline is the VENDOR's own window and cannot be extended (agy waits exactly 60s for its pasted code); absent = the engine owns the window and extending it is honest.",
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
    terminationReconciliation: SetupTerminationReconciliation.optional(),
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
    // DEFAULT-store logins prove success with the exact-route capability
    // receipt. PROFILE jobs (INV-135) succeed on the profile's own doctor
    // probe — the smoke attests the DEFAULT route only, so requiring it here
    // would either spend quota on the wrong store's proof or forbid honest
    // profile success (same contract as `claudexor profiles login`).
    if (
      value.state === "succeeded" &&
      value.profileId === null &&
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
    if (
      value.terminationReconciliation &&
      (value.outcome?.reason !== "termination_unconfirmed" || !value.execution)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["terminationReconciliation"],
        message: "termination reconciliation requires the original unconfirmed process evidence",
      });
    }
  })
  .describe("One daemon-managed exact-subscription native-login job.");
export type ControlSetupJob = z.infer<typeof ControlSetupJob>;

/** The two app-server device-code login flows (D-17 primary path). */
export const SetupAppServerLoginFlow = z.enum(["chatgptDeviceCode", "chatgpt"]);
export type SetupAppServerLoginFlow = z.infer<typeof SetupAppServerLoginFlow>;

/**
 * Every flow a login disclosure sidecar can carry: the two codex app-server
 * flows, plus `oauth_url` — an OAuth/sign-in URL the runner captured from a
 * TERMINAL-mode vendor login's own output (claude/cursor, and codex's legacy
 * fallback). `oauth_url` disclosures are URL-only (`userCode` is empty), the
 * same card shape as the browser-callback (`chatgpt`) flow, so any UI can
 * render "open this link" without a terminal.
 */
// oauth_url_input: the with-input variant — URL plus a one-shot paste field
// delivered via POST /v2/setup/jobs/:id/input.
export const SetupLoginDisclosureFlow = z.enum([
  "chatgptDeviceCode",
  "chatgpt",
  "oauth_url",
  "oauth_url_input",
]);
export type SetupLoginDisclosureFlow = z.infer<typeof SetupLoginDisclosureFlow>;

/**
 * TRANSIENT device-code disclosure surfaced by the D-17 app-server login flow.
 *
 * This is a READ-TIME PROJECTION ONLY: it is overlaid on a setup-job snapshot /
 * SSE frame from the runner's transient device-code sidecar and is NEVER a
 * field of the journaled {@link ControlSetupJob}. The one-time `userCode` is
 * never journaled, logged, or persisted to the durable result receipt
 * (INV-062 / D-17); the journal records only THAT a code was disclosed via the
 * awaiting_user phase transition. `userCode` is empty for the browser-callback
 * (`chatgpt`) flow, which surfaces only an authUrl.
 */
export const SetupDeviceCodeDisclosure = z
  .object({
    flow: SetupLoginDisclosureFlow,
    verificationUrl: z.string().url().describe("Where the operator completes the sign-in."),
    userCode: z
      .string()
      .describe(
        "Transient one-time code (empty for the browser-callback and oauth_url flows); never journaled.",
      ),
  })
  .strict()
  .describe("Transient device-code disclosure — read-time projection only, never journaled.");
export type SetupDeviceCodeDisclosure = z.infer<typeof SetupDeviceCodeDisclosure>;

export const ControlSetupJobListFilter = z
  .object({
    harness: ControlHarnessSetupHarness.optional(),
    action: SetupTransport.ControlSetupJobAction.optional(),
    active: z.boolean().optional(),
    limit: z.number().int().positive().max(500).optional(),
  })
  .strict()
  .describe("Supported GET /v2/setup/jobs filters.");
export type ControlSetupJobListFilter = z.infer<typeof ControlSetupJobListFilter>;

export const ControlSetupJobEvent = setupDeviceCodeProjectionEnvelope(
  {
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
  },
  ControlSetupJob,
  ActiveControlSetupJobState,
  SetupDeviceCodeDisclosure,
)
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

export const ControlSetupJobSnapshot = setupDeviceCodeProjectionEnvelope(
  {
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
  },
  ControlSetupJob,
  ActiveControlSetupJobState,
  SetupDeviceCodeDisclosure,
).describe("Atomically fenced setup-job snapshot used before attaching or reattaching SSE.");
export type ControlSetupJobSnapshot = z.infer<typeof ControlSetupJobSnapshot>;

export const ControlSetupJobListResponse = z
  .object({ jobs: z.array(ControlSetupJob).describe("All known setup jobs.") })
  .describe("Response for listing setup jobs.");
export type ControlSetupJobListResponse = z.infer<typeof ControlSetupJobListResponse>;
