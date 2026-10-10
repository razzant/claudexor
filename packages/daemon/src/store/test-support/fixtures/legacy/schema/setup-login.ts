/**
 * The internal, file-backed protocol between claudexord and the DETACHED
 * native-login runner: the sealed manifest the runner executes, the transient
 * device-code/URL disclosure it publishes, its observable state, the permit
 * that authorizes the spawn, and its durable result. Split out of setup.ts so
 * the control-plane setup DTOs and the runner wire contract each stay one
 * readable file.
 */
import { z } from "zod/v3";
import { harnessHasDefaultCredentialStore } from "./credential-store.js";
import * as SetupLoginProtocol from "./setup-login-protocol.js";
import {
  ControlHarnessSetupHarness,
  SetupAppServerLoginFlow,
  SetupExecutableEvidence,
  SetupLoginDisclosureFlow,
  SetupNativeCommandReceipt,
  SetupNativeCommandReceiptShape,
  SetupProcessGroupHandle,
  SetupTimestamp,
  Sha256Hex,
} from "./setup.js";

/** Internal, file-backed protocol between claudexord and the detached native-login runner. */
export const SetupLoginProtocolVersion = z.literal(2);

export const SetupLoginManifest = z
  .object({
    version: SetupLoginProtocolVersion,
    jobId: SetupLoginProtocol.SetupLoginJobId,
    executionId: SetupLoginProtocol.SetupLoginExecutionId,
    harness: ControlHarnessSetupHarness,
    jobDir: SetupLoginProtocol.SetupLoginAbsolutePath,
    binary: SetupLoginProtocol.SetupLoginAbsolutePath,
    args: z.array(z.string()),
    /** Optional physical transport for a sealed logical Node entrypoint. The
     * entrypoint's existing executable evidence remains authoritative. */
    interpreter: z
      .object({
        binary: SetupLoginProtocol.SetupLoginAbsolutePath,
        args: z.array(z.string()),
        env: z.record(z.string()).optional(),
      })
      .strict()
      .optional(),
    cwd: SetupLoginProtocol.SetupLoginAbsolutePath,
    /** Scoped config dir for an INV-135 profile login (claude CLAUDE_CONFIG_DIR /
     * codex CODEX_HOME). OPTIONAL, not defaulted: absent on default-store jobs so
     * pre-existing manifests keep their sealed digest across a daemon upgrade. */
    profileConfigDir: SetupLoginProtocol.SetupLoginAbsolutePath.optional(),
    /** How the runner performs the login: "terminal" (codex browser_redirect
     * fallback only), "device_code" (codex app-server), "url_disclosure"
     * (daemon-hosted, URL captured into the sidecar — cursor), or
     * "url_disclosure_with_input" (same + one-shot stdin input — claude).
     * OPTIONAL/undefaulted so pre-upgrade manifests keep their digest. */
    loginMode: z
      .enum(["terminal", "device_code", "url_disclosure", "url_disclosure_with_input"])
      .optional(),
    /** Which app-server auth flow the device_code runner requests. Present only
     * with loginMode "device_code". */
    appServerFlow: SetupAppServerLoginFlow.optional(),
    /** Sidecar the runner writes its transient disclosure to; read by the
     * daemon for the snapshot overlay, never journaled. device_code manifests
     * REQUIRE it; terminal manifests MAY carry it (the runner then captures the
     * vendor login's OAuth URL into it as an `oauth_url` disclosure). Optional
     * so pre-upgrade sealed manifests keep their digest. */
    deviceCodePath: SetupLoginProtocol.SetupLoginAbsolutePath.optional(),
    /** One-shot input sidecar (url_disclosure_with_input only): transient,
     * never journaled, delivered to the vendor CLI's stdin by the runner. */
    inputPath: SetupLoginProtocol.SetupLoginAbsolutePath.optional(),
    /** Whether the vendor reads its pasted code only from a REAL terminal
     * (agy answers a plain pipe with "authentication required"); the runner
     * then interposes a tty. Absent = a pipe, as every prior manifest. */
    ptyStdin: z.boolean().optional(),
    statePath: SetupLoginProtocol.SetupLoginAbsolutePath,
    resultPath: SetupLoginProtocol.SetupLoginAbsolutePath,
    permitPath: SetupLoginProtocol.SetupLoginAbsolutePath,
    permitDeadlineAt: SetupTimestamp,
    permitWaitMs: SetupLoginProtocol.SetupClientPtyPermitWaitMs,
    executable: SetupExecutableEvidence,
    commandDigest: Sha256Hex,
    manifestDigest: Sha256Hex,
  })
  .strict()
  .superRefine((value, context) => {
    const deny = (path: string[], message: string) =>
      context.addIssue({ code: z.ZodIssueCode.custom, path, message });
    const deviceCode = value.loginMode === "device_code";
    const urlDisclosure =
      value.loginMode === "url_disclosure" || value.loginMode === "url_disclosure_with_input";
    if (deviceCode && value.harness !== "codex")
      deny(["loginMode"], "device_code login mode exists only for the codex app-server");
    if (deviceCode && (!value.appServerFlow || !value.deviceCodePath))
      deny(["appServerFlow"], "device_code manifests require appServerFlow and deviceCodePath");
    // deviceCodePath is legal on terminal manifests too (the runner captures
    // the vendor login's OAuth URL into it); only the app-server flow selector
    // stays device_code-exclusive.
    if (!deviceCode && value.appServerFlow)
      deny(["appServerFlow"], "appServerFlow requires loginMode device_code");
    if (urlDisclosure && !value.deviceCodePath)
      deny(["deviceCodePath"], "url_disclosure manifests require the disclosure sidecar path");
    if ((value.loginMode === "url_disclosure_with_input") !== (value.inputPath !== undefined))
      deny(["inputPath"], "inputPath rides url_disclosure_with_input manifests, exactly");
    // A tty exists only to deliver the pasted code; claiming it elsewhere
    // would wrap a login that never reads stdin.
    // A harness with no default credential store has nowhere to sign in
    // EXCEPT a named profile, so a manifest without one is malformed rather
    // than merely unlucky — the runner would otherwise fail opaquely and the
    // reason (INV-135 / owner decision Л-4) would never reach the user.
    if (!harnessHasDefaultCredentialStore(value.harness) && !value.profileConfigDir)
      deny(
        ["profileConfigDir"],
        `${value.harness} has no default credential store: its login manifest must target a named profile HOME`,
      );
    if (value.ptyStdin && value.loginMode !== "url_disclosure_with_input")
      deny(["ptyStdin"], "ptyStdin exists only for url_disclosure_with_input manifests");
  });
export type SetupLoginManifest = z.infer<typeof SetupLoginManifest>;

/**
 * TRANSIENT device-code sidecar the device_code runner writes after
 * `account/login/start` succeeds. Bound to the job + execution like the state
 * sidecar. The daemon reads it to overlay {@link SetupDeviceCodeDisclosure} on
 * snapshots/SSE; its `userCode` is NEVER journaled, logged, or copied into the
 * durable result receipt (INV-062 / D-17).
 */
export const SetupLoginDeviceCode = z
  .object({
    version: SetupLoginProtocolVersion,
    jobId: SetupLoginProtocol.SetupLoginJobId,
    executionId: SetupLoginProtocol.SetupLoginExecutionId,
    flow: SetupLoginDisclosureFlow,
    verificationUrl: z.string().url(),
    userCode: z.string(),
    disclosedAt: SetupTimestamp,
  })
  .strict();
export type SetupLoginDeviceCode = z.infer<typeof SetupLoginDeviceCode>;

export const SetupLoginRunnerState = z
  .object({
    version: SetupLoginProtocolVersion,
    jobId: SetupLoginProtocol.SetupLoginJobId,
    executionId: SetupLoginProtocol.SetupLoginExecutionId,
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
    jobId: SetupLoginProtocol.SetupLoginJobId,
    executionId: SetupLoginProtocol.SetupLoginExecutionId,
    issuedAt: SetupTimestamp,
    commandDigest: Sha256Hex,
    manifestDigest: Sha256Hex,
  })
  .strict();
export type SetupLoginPermit = z.infer<typeof SetupLoginPermit>;

export const SetupLoginRunnerResult = z
  .object({
    version: SetupLoginProtocolVersion,
    jobId: SetupLoginProtocol.SetupLoginJobId,
    ...SetupNativeCommandReceiptShape,
    /** Bounded, ANSI-stripped tail of the vendor command's captured output —
     * diagnostic evidence for classifying a failed login (e.g. the device-code
     * toggle being disabled). RESULT-FILE ONLY: the durable control receipt
     * deliberately does not carry it (the ≤600-char slice in the failure
     * message is the only journal/API exposure). Only tee'd flows (codex). */
    outputTail: z.string().max(4000).optional(),
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
