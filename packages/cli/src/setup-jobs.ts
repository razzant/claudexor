import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  AuthCapabilityVerifier,
  ProcessGroupService,
  parseProcessGroupHandle,
  type ProcessGroupHandle,
} from "@claudexor/core";
import { daemonDir } from "@claudexor/daemon";
import {
  type AuthSourceReadiness,
  type AuthCapabilityBinding,
  type AuthCapabilityReceipt,
  type ControlHarnessSetupHarness,
  ControlSetupJobCreateRequest,
  type CredentialProfileStatus,
  SetupNativeCommandReceipt,
  type ControlSetupJob,
  type ControlSetupJobListFilter,
} from "@claudexor/schema";
import { noProjectRepoRoot } from "@claudexor/util";
import * as NativeLogin from "./native-login.js";
import {
  SETUP_PROFILES,
  processGroupFromJob,
  profileDoctorProbe,
  resolveProfileBinding,
  resolveSetupLoginRunnerPath,
  shellQuote,
  stateMatchesDurableExecution,
  waitWithAbort,
  withAbortAndTimeout,
} from "./setup-job-support.js";
import { buildGateway } from "./registry.js";
import { ACTIVE_SETUP_STATES, SetupJobStore, TERMINAL_SETUP_STATES } from "./setup-job-store.js";
import {
  SETUP_LOGIN_PROTOCOL_VERSION,
  atomicPrivateJson,
  captureExecutableEvidence,
  commandDigest,
  readLoginManifest,
  readRunnerResult,
  readRunnerState,
  sealLoginManifest,
  verifyExecutableEvidence,
  type SetupLoginPermit,
  type SetupLoginManifest,
  type SetupLoginRunnerResult,
  type SetupLoginRunnerState,
} from "./setup-login-protocol.js";
import { SetupSupervisor } from "./setup-supervisor.js";

const NO_PROJECT_ROOT = noProjectRepoRoot();
const LOGIN_EXTENSION_MS = 15 * 60_000;
type NativeLoginSpec = NativeLogin.NativeLoginSpec;
export interface SetupJobManagerOptions {
  rootDir?: string;
  store?: SetupJobStore;
  probeAuthSource?: (
    harness: string,
    source: "native_session",
    opts: { fresh: true; authPreference: "subscription"; abortSignal: AbortSignal },
  ) => Promise<AuthSourceReadiness | null>;
  /** INV-135 profile jobs verify the PROFILE's scoped store, never the default
   * native session; the doctor probe is the verification truth (same contract
   * as `claudexor profiles login`). */
  probeCredentialProfile?: (
    harness: string,
    profileId: string,
    abortSignal: AbortSignal,
  ) => Promise<CredentialProfileStatus | null>;
  authCapabilityVerifier?: {
    prepare(input: {
      attemptId: string;
      harness: string;
      requested: "subscription";
      requiredRoute: "vendor_native";
      requiredSource: "native_session";
    }): { binding: AuthCapabilityBinding };
    verify(input: {
      binding: AuthCapabilityBinding;
      startedAt: string;
      abortSignal?: AbortSignal;
    }): Promise<AuthCapabilityReceipt>;
    cleanup(attemptId: string): void;
  };
  onCredentialStateMayHaveChanged?: (harness: ControlHarnessSetupHarness) => void;
  launcherTimeoutMs?: number;
  loginTimeoutMs?: number;
  verifyTimeoutMs?: number;
  capabilityTimeoutMs?: number;
  verifyPollMs?: number;
  monitorPollMs?: number;
  terminationGraceMs?: number;
  platform?: NodeJS.Platform;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  spawn?: typeof spawn;
  openTerminal?: (scriptPath: string) => ChildProcess;
  processGroups?: ProcessGroupService;
  runnerPath?: string;
  nodePath?: string;
}
export function createSetupJobManager(opts: SetupJobManagerOptions = {}) {
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
  const spawnProcess = opts.spawn ?? spawn;
  const rootDir = opts.rootDir ?? daemonDir();
  const store = opts.store ?? new SetupJobStore(rootDir, { now });
  const processGroups =
    opts.processGroups ?? new ProcessGroupService({ platform: opts.platform ?? process.platform });
  const processing = new Map<string, Promise<void>>();
  const terminations = new Map<string, Promise<ControlSetupJob>>();
  const verificationControllers = new Map<string, AbortController>();
  const gateway =
    opts.probeAuthSource && opts.authCapabilityVerifier
      ? null
      : buildGateway({ includeFakes: false });
  const probeAuthSource =
    opts.probeAuthSource ??
    ((harness, source, probe) =>
      gateway!.probeAuthSource(harness, source, { cwd: NO_PROJECT_ROOT, ...probe }));
  const probeCredentialProfile =
    opts.probeCredentialProfile ??
    (gateway
      ? profileDoctorProbe((harness) => gateway.get(harness))
      : () => {
          // Injected auth probes without an injected profile probe would
          // silently verify the WRONG store — refuse loudly instead.
          throw new Error(
            "probeCredentialProfile hook is required when probeAuthSource is injected",
          );
        });
  const authCapabilityVerifier =
    opts.authCapabilityVerifier ??
    new AuthCapabilityVerifier((harness) => gateway!.get(harness), {
      now,
      scratchRoot: join(rootDir, "auth-smokes"),
    });
  const runnerPath = opts.runnerPath ?? resolveSetupLoginRunnerPath();
  const nodePath = opts.nodePath ?? process.execPath;
  if (!isAbsolute(runnerPath) || !isAbsolute(nodePath))
    throw new Error("setup login runnerPath and nodePath must be absolute");
  const platform = opts.platform ?? process.platform;
  const launcherTimeoutMs = opts.launcherTimeoutMs ?? 10_000;
  const loginTimeoutMs = opts.loginTimeoutMs ?? 15 * 60_000;
  const verifyTimeoutMs = opts.verifyTimeoutMs ?? 30_000;
  const capabilityTimeoutMs = opts.capabilityTimeoutMs ?? 60_000;
  const verifyPollMs = opts.verifyPollMs ?? 2_000;
  const terminationGraceMs = opts.terminationGraceMs ?? 5_000;
  let supervisor!: SetupSupervisor;
  const openTerminal =
    opts.openTerminal ??
    ((scriptPath: string) =>
      spawnProcess("/usr/bin/open", ["-a", "Terminal", scriptPath], {
        detached: true,
        stdio: "ignore",
      }));
  function iso(): string {
    return now().toISOString();
  }
  function update(jobId: string, patch: Partial<ControlSetupJob>): ControlSetupJob {
    return store.update(jobId, patch);
  }
  function log(jobId: string, line: string): void {
    store.appendLog(jobId, line);
  }
  function logAfterMutation(jobId: string, line: string): void {
    try {
      log(jobId, line);
    } catch (error) {
      supervisor.reportFailure(error, "setup-log");
    }
  }

  function finish(
    jobId: string,
    state: Extract<
      ControlSetupJob["state"],
      "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted_unknown" | "not_supported"
    >,
    reason: NonNullable<ControlSetupJob["outcome"]>["reason"],
    message: string,
    evidence: { exitCode?: number | null; signal?: string | null } = {},
    // A pre-launch failure still keeps the operator's manual command selectable
    // (DESIGN_SYSTEM setup contract, INV-093) — never a null command with the
    // reason buried in one HTTP response.
    command?: string,
  ): ControlSetupJob {
    const done = update(jobId, {
      state,
      phase: "completed",
      outcome: { reason, ...evidence },
      finishedAt: iso(),
      message,
      ...(command ? { command } : {}),
    });
    logAfterMutation(jobId, message);
    return done;
  }

  function persistNativeCommandOutcome(
    jobId: string,
    result: SetupLoginRunnerResult,
  ): ControlSetupJob {
    let job = store.status(jobId);
    const receipt = SetupNativeCommandReceipt.parse({
      executionId: result.executionId,
      commandDigest: result.commandDigest,
      manifestDigest: result.manifestDigest,
      permitIssuedAt: result.permitIssuedAt,
      commandStarted: result.commandStarted,
      exitCode: result.exitCode,
      signal: result.signal,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      finishedAt: result.finishedAt,
    });
    if (job.nativeCommand) {
      if (JSON.stringify(job.nativeCommand) !== JSON.stringify(receipt)) {
        throw new Error(`native command outcome changed for setup job '${jobId}'`);
      }
      return job;
    }
    job = update(jobId, {
      nativeCommand: receipt,
      message: `Persisted hash-bound ${job.harness} native command evidence before verification.`,
    });
    if (receipt.commandStarted) opts.onCredentialStateMayHaveChanged?.(job.harness);
    return job;
  }

  function probeNativeSession(
    harness: string,
    controller: AbortController,
    timeoutMs: number,
  ): Promise<AuthSourceReadiness | null> {
    return withAbortAndTimeout(
      () =>
        probeAuthSource(harness, "native_session", {
          fresh: true,
          authPreference: "subscription",
          abortSignal: controller.signal,
        }),
      controller,
      timeoutMs,
      "native auth verification",
    );
  }

  function probeProfileStatus(
    harness: string,
    profileId: string,
    controller: AbortController,
    timeoutMs: number,
  ): Promise<CredentialProfileStatus | null> {
    return withAbortAndTimeout(
      () => probeCredentialProfile(harness, profileId, controller.signal),
      controller,
      timeoutMs,
      "profile auth verification",
    );
  }

  function finishCapabilityReceipt(
    jobId: string,
    receipt: AuthCapabilityReceipt,
    loginEvidence: { exitCode?: number | null; signal?: string | null } = {},
  ): ControlSetupJob {
    if (
      receipt.verification === "passed" &&
      receipt.effective === "vendor_native" &&
      receipt.effectiveSource === "native_session"
    ) {
      return finish(
        jobId,
        "succeeded",
        "completed",
        `${receipt.harness} native subscription completed a real same-harness capability smoke. Billing remains unknown.`,
        loginEvidence,
      );
    }
    const routeMismatch =
      receipt.selectionReason === "route_mismatch" ||
      receipt.selectionReason === "source_mismatch" ||
      receipt.selectionReason === "route_missing" ||
      receipt.selectionReason === "source_missing";
    return finish(
      jobId,
      "failed",
      routeMismatch ? "credential_route_mismatch" : "capability_verification_failed",
      routeMismatch
        ? `${receipt.harness} capability smoke did not use the exact vendor-native session route.`
        : `${receipt.harness} capability smoke failed (${receipt.selectionReason}).`,
      loginEvidence,
    );
  }

  async function runCapabilitySmoke(
    jobId: string,
    controller: AbortController,
    loginEvidence: { exitCode?: number | null; signal?: string | null },
  ): Promise<void> {
    let job = store.status(jobId);
    if (!ACTIVE_SETUP_STATES.has(job.state) || job.phase === "cancelling") return;
    const lifecycle = job.authCapability;
    if (!lifecycle) {
      finish(
        jobId,
        "failed",
        "capability_verification_failed",
        `${job.harness} login is missing its durable capability disclosure.`,
        loginEvidence,
      );
      return;
    }
    if (lifecycle.state !== "disclosed") {
      settleDurableCapability(job, "restart");
      return;
    }

    const startedAt = iso();
    const running = { ...lifecycle, state: "running" as const, startedAt };
    update(jobId, {
      state: "running",
      phase: "verifying",
      authCapability: running,
      message: `Running one ${job.harness} capability smoke on native_session; it may consume quota and billing is unknown.`,
    });
    let receipt: AuthCapabilityReceipt;
    try {
      const { state: _state, ...binding } = lifecycle;
      receipt = await withAbortAndTimeout(
        () =>
          authCapabilityVerifier.verify({
            binding,
            startedAt,
            abortSignal: controller.signal,
          }),
        controller,
        capabilityTimeoutMs,
        "auth capability smoke",
      );
    } catch (error) {
      const current = store.status(jobId);
      if (!ACTIVE_SETUP_STATES.has(current.state) || current.phase === "cancelling") return;
      const interruptedAt = iso();
      update(jobId, {
        authCapability: { ...running, state: "interrupted_unknown", interruptedAt },
        message: `${job.harness} capability smoke ended without a verifiable receipt.`,
      });
      finish(
        jobId,
        "interrupted_unknown",
        "interrupted_unknown",
        `${job.harness} capability smoke outcome is unknown${error instanceof Error && "code" in error && error.code === "setup_timeout" ? " after timeout" : ""}; it was not replayed.`,
        loginEvidence,
      );
      return;
    }
    try {
      authCapabilityVerifier.cleanup(lifecycle.attemptId);
    } catch {
      /* receipt remains authoritative */
    }
    const current = store.status(jobId);
    if (!ACTIVE_SETUP_STATES.has(current.state) || current.phase === "cancelling") return;
    update(jobId, {
      authCapability: {
        ...running,
        state: "completed",
        completedAt: receipt.completedAt,
        receipt,
      },
      message: `${job.harness} capability receipt persisted (${receipt.verification}).`,
    });
    finishCapabilityReceipt(jobId, receipt, loginEvidence);
  }

  function runNativeVerification(
    jobId: string,
    loginEvidence: { exitCode?: number | null; signal?: string | null } = {},
  ): Promise<void> {
    const existing = processing.get(jobId);
    if (existing) return existing;
    const controller = new AbortController();
    verificationControllers.set(jobId, controller);
    const operation = supervisor.track(`native-verification:${jobId}`, () =>
      runNativeVerificationOnce(jobId, loginEvidence, controller),
    );
    processing.set(jobId, operation);
    const cleanup = () => {
      if (processing.get(jobId) === operation) processing.delete(jobId);
      if (verificationControllers.get(jobId) === controller) verificationControllers.delete(jobId);
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }

  async function runNativeVerificationOnce(
    jobId: string,
    loginEvidence: { exitCode?: number | null; signal?: string | null },
    verificationController: AbortController,
  ): Promise<void> {
    const job = store.status(jobId);
    if (!ACTIVE_SETUP_STATES.has(job.state)) return;
    update(jobId, {
      state: "running",
      phase: "verifying",
      message: job.profileId
        ? `Verifying the scoped ${job.harness} profile "${job.profileId}" via its doctor probe.`
        : `Verifying the exact ${job.harness} native subscription source.`,
    });
    const deadline = now().getTime() + verifyTimeoutMs;
    let lastDetail: string | undefined;
    for (;;) {
      const current = store.status(jobId);
      if (
        !ACTIVE_SETUP_STATES.has(current.state) ||
        current.phase === "cancelling" ||
        verificationController.signal.aborted
      )
        return;
      const remaining = deadline - now().getTime();
      if (remaining <= 0) break;
      // INV-135 profile jobs verify the PROFILE's scoped store via the doctor
      // probe — the default native_session probe would attest the WRONG store.
      let readiness: AuthSourceReadiness | null = null;
      let profileStatus: CredentialProfileStatus | null = null;
      try {
        if (job.profileId) {
          profileStatus = await probeProfileStatus(
            job.harness,
            job.profileId,
            verificationController,
            remaining,
          );
        } else {
          readiness = await probeNativeSession(job.harness, verificationController, remaining);
        }
      } catch (err) {
        const latest = store.status(jobId);
        if (!ACTIVE_SETUP_STATES.has(latest.state) || latest.phase === "cancelling") return;
        lastDetail = err instanceof Error ? err.message : String(err);
        if (verificationController.signal.aborted) {
          if (["draining", "stopped"].includes(supervisor.health().state)) return;
          break;
        }
        log(jobId, `fresh native-session probe failed transiently: ${lastDetail}`);
        await waitWithAbort(
          Math.min(verifyPollMs, Math.max(0, deadline - now().getTime())),
          verificationController,
          sleep,
        );
        continue;
      }
      const latest = store.status(jobId);
      if (!ACTIVE_SETUP_STATES.has(latest.state) || latest.phase === "cancelling") return;
      if (job.profileId) {
        const verified =
          profileStatus?.availability === "available" && profileStatus.verification === "passed";
        lastDetail = profileStatus?.detail;
        log(
          jobId,
          `profile ${latest.harness}/${job.profileId}: ${profileStatus?.availability ?? "unknown"}; verification ${profileStatus?.verification ?? "not_run"}`,
        );
        if (verified && now().getTime() <= deadline) {
          // Same contract as `claudexor profiles login`: the doctor probe IS
          // the verification truth for a scoped profile. The capability smoke
          // attests the DEFAULT route only, so it is honestly skipped here.
          finish(
            jobId,
            "succeeded",
            "completed",
            `${latest.harness} profile "${job.profileId}" login verified by its doctor probe. The default-route capability smoke does not apply to scoped profiles and was skipped.`,
            loginEvidence,
          );
          return;
        }
      } else {
        const verified =
          readiness?.source === "native_session" &&
          readiness.availability === "available" &&
          readiness.verification === "passed";
        lastDetail = readiness?.detail;
        log(
          jobId,
          `native_session ${latest.harness}: ${readiness?.availability ?? "unknown"}; verification ${readiness?.verification ?? "not_run"}`,
        );
        if (verified && now().getTime() <= deadline) {
          await runCapabilitySmoke(jobId, verificationController, loginEvidence);
          return;
        }
      }
      await waitWithAbort(
        Math.min(verifyPollMs, Math.max(0, deadline - now().getTime())),
        verificationController,
        sleep,
      );
    }
    const latest = store.status(jobId);
    if (!ACTIVE_SETUP_STATES.has(latest.state) || latest.phase === "cancelling") return;
    finish(
      jobId,
      "failed",
      "auth_not_ready",
      `${latest.harness} ${
        job.profileId ? `profile "${job.profileId}"` : "native session"
      } was not ready before the verification deadline${lastDetail ? `: ${lastDetail}` : "."}`,
      loginEvidence,
    );
  }

  function manifestFor(jobId: string): SetupLoginManifest | null {
    try {
      return readLoginManifest(store.paths(jobId).manifest);
    } catch {
      return null;
    }
  }

  function matchingState(jobId: string): SetupLoginRunnerState | null {
    const manifest = manifestFor(jobId);
    const state = readRunnerState(store.paths(jobId).runnerState);
    return manifest && state && state.jobId === jobId && state.executionId === manifest.executionId
      ? state
      : null;
  }

  function matchingResult(jobId: string): SetupLoginRunnerResult | null {
    const manifest = manifestFor(jobId);
    const result = readRunnerResult(store.paths(jobId).runnerResult);
    return manifest &&
      result &&
      result.jobId === jobId &&
      result.executionId === manifest.executionId &&
      result.commandDigest === manifest.commandDigest &&
      result.manifestDigest === manifest.manifestDigest
      ? result
      : null;
  }

  function persistPermit(job: ControlSetupJob, manifest: SetupLoginManifest): void {
    const issuedAt = job.execution?.permitIssuedAt;
    if (!issuedAt)
      throw new Error("cannot issue a setup-login permit before its durable journal transition");
    atomicPrivateJson(manifest.permitPath, {
      version: SETUP_LOGIN_PROTOCOL_VERSION,
      jobId: job.jobId,
      executionId: manifest.executionId,
      issuedAt,
      commandDigest: manifest.commandDigest,
      manifestDigest: manifest.manifestDigest,
    } satisfies SetupLoginPermit);
  }
  async function observeAndPermit(jobId: string, state: SetupLoginRunnerState): Promise<void> {
    let job = store.status(jobId);
    const manifest = manifestFor(jobId);
    if (!manifest) {
      finish(
        jobId,
        "failed",
        "termination_unconfirmed",
        `${job.harness} login manifest became unavailable after worker observation.`,
      );
      return;
    }
    const handle = parseProcessGroupHandle(state.processGroup);
    if (
      !job.authorization ||
      job.authorization.executionId !== state.executionId ||
      job.authorization.commandDigest !== state.commandDigest ||
      job.authorization.manifestDigest !== state.manifestDigest ||
      manifest.commandDigest !== job.authorization.commandDigest ||
      manifest.manifestDigest !== job.authorization.manifestDigest ||
      JSON.stringify(manifest.executable) !== JSON.stringify(job.authorization.executable) ||
      JSON.stringify(manifest.args) !== JSON.stringify(job.authorization.args) ||
      !verifyExecutableEvidence(job.authorization.executable)
    ) {
      finish(
        jobId,
        "failed",
        "termination_unconfirmed",
        `${job.harness} login command authorization changed before execution permit.`,
      );
      return;
    }
    if (!job.execution?.permitIssuedAt && processGroups.compareLeader(handle) !== "same") {
      finish(
        jobId,
        "failed",
        "termination_unconfirmed",
        `${job.harness} login worker identity changed before execution was permitted.`,
      );
      return;
    }
    if (!job.execution) {
      job = update(jobId, {
        execution: {
          executionId: state.executionId,
          commandDigest: state.commandDigest,
          manifestDigest: state.manifestDigest,
          processGroup: state.processGroup,
          observedAt: state.observedAt,
        },
        message: `Observed ${job.harness} login worker; recording execution permit.`,
      });
    } else if (!stateMatchesDurableExecution(job, state)) {
      finish(
        jobId,
        "failed",
        "termination_unconfirmed",
        `${job.harness} login worker contradicts durable process-group evidence.`,
      );
      return;
    }
    if (!job.execution?.permitIssuedAt) {
      job = update(jobId, {
        execution: { ...job.execution!, permitIssuedAt: iso() },
        message: `Durably authorized ${job.harness} native login execution.`,
      });
    }
    persistPermit(job, manifest);
    if (job.phase === "launching") {
      update(jobId, {
        phase: "awaiting_user",
        message: `Complete ${job.harness} native login in Terminal.`,
      });
    }
  }

  async function consumeLoginResult(jobId: string, result: SetupLoginRunnerResult): Promise<void> {
    let job = store.status(jobId);
    if (!ACTIVE_SETUP_STATES.has(job.state) || job.phase === "cancelling") return;
    if (result.permitIssuedAt !== null) {
      const state = matchingState(jobId);
      if (
        !job.execution?.permitIssuedAt ||
        job.execution.permitIssuedAt !== result.permitIssuedAt ||
        !state ||
        state.stage !== "running" ||
        !stateMatchesDurableExecution(job, state) ||
        Date.parse(result.finishedAt) < Date.parse(result.permitIssuedAt)
      ) {
        finish(
          jobId,
          "failed",
          "termination_unconfirmed",
          `${job.harness} login result is not bound to the durable execution permit.`,
        );
        return;
      }
    } else if (job.execution?.permitIssuedAt || result.commandStarted) {
      finish(
        jobId,
        "failed",
        "termination_unconfirmed",
        `${job.harness} login result contradicts the durable execution permit.`,
      );
      return;
    }
    job = persistNativeCommandOutcome(jobId, result);
    if (!result.commandStarted) {
      finish(
        jobId,
        "failed",
        "launch_failed",
        result.errorCode === "permit_timeout"
          ? `${job.harness} login worker timed out before a durable execution permit was issued.`
          : `${job.harness} login command could not be spawned after authorization.`,
      );
      return;
    }
    if (result.exitCode === 0 && result.signal === null) {
      await runNativeVerification(jobId, {
        exitCode: job.nativeCommand!.exitCode,
        signal: job.nativeCommand!.signal,
      });
      return;
    }
    finish(jobId, "failed", "command_failed", `${job.harness} login command failed.`, {
      exitCode: result.exitCode,
      signal: result.signal,
    });
  }

  function serializeTermination(
    jobId: string,
    task: () => Promise<ControlSetupJob>,
  ): Promise<ControlSetupJob> {
    const existing = terminations.get(jobId);
    if (existing) return existing;
    const operation = supervisor.track(`terminate:${jobId}`, task, { safety: true });
    terminations.set(jobId, operation);
    const cleanup = () => {
      if (terminations.get(jobId) === operation) terminations.delete(jobId);
    };
    operation.then(cleanup, cleanup);
    return operation;
  }

  function terminateLogin(
    jobId: string,
    reason: "cancelled_by_user" | "cancelled_on_restart" | "timed_out",
  ): Promise<ControlSetupJob> {
    return serializeTermination(jobId, () => terminateLoginOnce(jobId, reason));
  }

  async function terminateLoginOnce(
    jobId: string,
    reason: "cancelled_by_user" | "cancelled_on_restart" | "timed_out",
  ): Promise<ControlSetupJob> {
    const job = store.status(jobId);
    if (TERMINAL_SETUP_STATES.has(job.state)) return job;
    const result = matchingResult(jobId);
    if (result) persistNativeCommandOutcome(jobId, result);
    else
      update(jobId, { phase: "cancelling", message: `Stopping ${job.harness} login (${reason}).` });
    verificationControllers.get(jobId)?.abort(new Error(`native login ${reason}`));
    if (result) {
      const stateName = reason === "timed_out" ? "timed_out" : "cancelled";
      return finish(jobId, stateName, reason, `${job.harness} login ${reason}.`, {
        exitCode: result.exitCode,
        signal: result.signal,
      });
    }
    const group = processGroupFromJob(job);
    if (!group) {
      const stateName = reason === "timed_out" ? "timed_out" : "cancelled";
      return finish(
        jobId,
        stateName,
        reason,
        `${job.harness} login ${reason} before execution authorization.`,
      );
    }
    const alreadyEmpty = processGroups.probeEmpty(group);
    if (alreadyEmpty.status !== "empty") {
      const term = processGroups.signal(group, "SIGTERM");
      if (term.status === "unknown") {
        return finish(
          jobId,
          "failed",
          "termination_unconfirmed",
          `${job.harness} login TERM was refused: ${term.reason}.`,
        );
      }
      if (!(await waitForGroupEmpty(group, terminationGraceMs))) {
        const kill = processGroups.signal(group, "SIGKILL");
        if (kill.status === "unknown") {
          return finish(
            jobId,
            "failed",
            "termination_unconfirmed",
            `${job.harness} login KILL was refused: ${kill.reason}.`,
          );
        }
      }
      if (!(await waitForGroupEmpty(group, terminationGraceMs))) {
        return finish(
          jobId,
          "failed",
          "termination_unconfirmed",
          `${job.harness} login process group remained nonempty after SIGKILL.`,
        );
      }
    }
    const stateName = reason === "timed_out" ? "timed_out" : "cancelled";
    return finish(jobId, stateName, reason, `${job.harness} login ${reason}.`);
  }

  async function waitForGroupEmpty(handle: ProcessGroupHandle, maxMs: number): Promise<boolean> {
    let remaining = maxMs;
    for (;;) {
      const probe = processGroups.probeEmpty(handle);
      if (probe.status === "empty") return true;
      if (probe.status === "unknown") return false;
      if (remaining <= 0) return false;
      const step = Math.min(100, remaining);
      await sleep(step);
      remaining -= step;
    }
  }

  function markAwaitingUser(jobId: string): void {
    const current = store.status(jobId);
    if (current.phase === "launching") {
      update(jobId, {
        phase: "awaiting_user",
        message: `Complete ${current.harness} native login in Terminal.`,
      });
    }
  }

  async function monitorLogin(jobId: string): Promise<void> {
    if (processing.has(jobId)) return;
    const job = store.status(jobId);
    if (!ACTIVE_SETUP_STATES.has(job.state) || job.phase === "cancelling") return;
    const result = matchingResult(jobId);
    if (result) {
      markAwaitingUser(jobId);
      await consumeLoginResult(jobId, result);
      return;
    }
    const state = matchingState(jobId);
    if (state) {
      await observeAndPermit(jobId, state);
    } else if (
      !state &&
      job.phase === "launching" &&
      job.startedAt &&
      now().getTime() - Date.parse(job.startedAt) >= launcherTimeoutMs
    ) {
      finish(
        jobId,
        "failed",
        "launch_failed",
        `${job.harness} login worker did not provide an identity handshake within ${launcherTimeoutMs / 1000}s; vendor execution was never permitted.`,
      );
      return;
    }
    const current = store.status(jobId);
    if (current.deadlineAt && now().getTime() >= Date.parse(current.deadlineAt))
      await terminateLogin(jobId, "timed_out");
  }

  async function tick(): Promise<void> {
    await Promise.all(store.list({ active: true }).map((job) => monitorLogin(job.jobId)));
  }

  function settleDurableCapability(
    job: ControlSetupJob,
    boundary: "restart" | "shutdown",
  ): boolean {
    const lifecycle = job.authCapability;
    const evidence = job.nativeCommand
      ? { exitCode: job.nativeCommand.exitCode, signal: job.nativeCommand.signal }
      : {};
    if (lifecycle?.state === "completed") {
      finishCapabilityReceipt(job.jobId, lifecycle.receipt, evidence);
      try {
        authCapabilityVerifier.cleanup(lifecycle.attemptId);
      } catch {
        /* receipt remains authoritative */
      }
      return true;
    }
    if (lifecycle?.state !== "running" && lifecycle?.state !== "interrupted_unknown") return false;
    if (lifecycle.state === "running") {
      update(job.jobId, {
        authCapability: { ...lifecycle, state: "interrupted_unknown", interruptedAt: iso() },
        message: `${job.harness} capability smoke ended during daemon ${boundary} without a verifiable receipt.`,
      });
    }
    finish(
      job.jobId,
      "interrupted_unknown",
      "interrupted_unknown",
      `${job.harness} capability smoke outcome is unknown after daemon ${boundary}; explicit retry is required.`,
      evidence,
    );
    logAfterMutation(
      job.jobId,
      `retained auth smoke scratch for ${lifecycle.attemptId} because execution termination is unproven`,
    );
    return true;
  }

  async function reconcileRestart(): Promise<void> {
    for (const job of store.list({ active: true })) {
      if (settleDurableCapability(job, "restart")) continue;
      const result = matchingResult(job.jobId);
      if (result) {
        markAwaitingUser(job.jobId);
        await consumeLoginResult(job.jobId, result);
        continue;
      }
      const state = matchingState(job.jobId);
      if (state) {
        // Adoption of a still-live login runner (logins SURVIVE ordinary
        // daemon restarts — v3.0.3 S5): adopt only on positive liveness AND
        // re-proven leader identity; a proven-dead runner with no terminal
        // receipt is the unrecoverable cancelled_on_restart case, and
        // identity uncertainty stays fail-closed as termination_unconfirmed.
        const handle = parseProcessGroupHandle(state.processGroup);
        const probe = processGroups.probeEmpty(handle);
        if (probe.status === "empty") {
          finish(
            job.jobId,
            "cancelled",
            "cancelled_on_restart",
            `${job.harness} login runner did not survive the daemon restart window and left no terminal receipt.`,
          );
          continue;
        }
        if (probe.status !== "nonempty" || processGroups.compareLeader(handle) !== "same") {
          finish(
            job.jobId,
            "failed",
            "termination_unconfirmed",
            `${job.harness} login worker identity could not be re-proven after daemon restart.`,
          );
          continue;
        }
        await observeAndPermit(job.jobId, state);
        continue;
      }
      const group = processGroupFromJob(job);
      if (!group) {
        finish(
          job.jobId,
          "cancelled",
          "cancelled_on_restart",
          `${job.harness} login stopped before execution authorization and cannot continue across the daemon restart.`,
        );
        continue;
      }
      const empty = processGroups.probeEmpty(group);
      if (empty.status === "empty") {
        finish(
          job.jobId,
          "cancelled",
          "cancelled_on_restart",
          `${job.harness} login process ended without a terminal receipt during daemon restart.`,
        );
      } else {
        finish(
          job.jobId,
          "failed",
          "termination_unconfirmed",
          `${job.harness} login has durable process evidence but its worker sidecar is unavailable after restart.`,
        );
      }
    }
  }

  function startObservableLogin(
    job: ControlSetupJob,
    spec: NativeLoginSpec,
    profileConfigDir?: string,
  ): ControlSetupJob {
    if (platform !== "darwin") {
      return finish(
        job.jobId,
        "failed",
        "launch_failed",
        `Terminal-handoff login is macOS-only. Run it yourself, then recheck Harness Doctor: ${spec.displayCommand}`,
        {},
        spec.displayCommand,
      );
    }
    try {
      const paths = store.paths(job.jobId);
      const executionId = randomUUID();
      const executable = captureExecutableEvidence(spec.binary);
      const authorizedCommandDigest = commandDigest(executable, spec.args);
      const manifest = sealLoginManifest({
        version: SETUP_LOGIN_PROTOCOL_VERSION,
        jobId: job.jobId,
        executionId,
        harness: job.harness as "codex" | "claude" | "cursor",
        jobDir: paths.dir,
        binary: executable.realpath,
        args: [...spec.args],
        cwd: paths.dir,
        // Present ONLY on profile jobs: absent keeps pre-upgrade manifests'
        // sealed digests valid (the field is optional, never defaulted).
        ...(profileConfigDir ? { profileConfigDir } : {}),
        statePath: paths.runnerState,
        resultPath: paths.runnerResult,
        permitPath: paths.runnerPermit,
        permitDeadlineAt: new Date(now().getTime() + launcherTimeoutMs).toISOString(),
        executable,
        commandDigest: authorizedCommandDigest,
      });
      atomicPrivateJson(paths.manifest, manifest);
      const script = `#!/usr/bin/env bash\nset -uo pipefail\n${NativeLogin.nativeLoginTerminalExports(job.harness)}set +e\n${shellQuote(nodePath)} ${shellQuote(runnerPath)} ${shellQuote(paths.manifest)}\nstatus=$?\nset -e\nprintf '\\nClaudexor setup command finished (exit %s). Press Return to close this window. ' "$status"\nIFS= read -r _\nexit "$status"\n`;
      writeFileSync(paths.command, script, { mode: 0o700, flag: "wx" });
      chmodSync(paths.command, 0o700);
      const waiting = update(job.jobId, {
        state: "waiting_for_input",
        phase: "launching",
        deadlineAt: new Date(now().getTime() + loginTimeoutMs).toISOString(),
        startedAt: iso(),
        command: spec.displayCommand,
        authorization: {
          executionId,
          executable,
          args: [...spec.args],
          commandDigest: authorizedCommandDigest,
          manifestDigest: manifest.manifestDigest,
        },
        message: `Opening allowlisted ${job.harness} native login in Terminal.`,
      });
      log(job.jobId, `Terminal script: ${paths.command}`);
      const opener = openTerminal(paths.command);
      const failLaunch = (detail: string) => {
        if (!["idle", "healthy"].includes(supervisor.health().state)) return;
        const current = store.status(job.jobId);
        if (current.phase !== "launching") return;
        finish(
          job.jobId,
          "failed",
          "launch_failed",
          `Could not open Terminal for ${job.harness} login: ${detail}.`,
          {},
          spec.displayCommand,
        );
      };
      opener.once("error", (err) => failLaunch(err.message));
      opener.once("exit", (code, signal) => {
        if (code !== 0) failLaunch(signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`);
      });
      opener.unref();
      return waiting;
    } catch (err) {
      return finish(
        job.jobId,
        "failed",
        "launch_failed",
        `Could not prepare or open Terminal for ${job.harness} login: ${err instanceof Error ? err.message : String(err)}.`,
        {},
        spec.displayCommand,
      );
    }
  }

  supervisor = new SetupSupervisor({
    pollMs: opts.monitorPollMs ?? 250,
    recoveryRequired: () => store.recoveryState().status === "recovery_required",
    reconcile: reconcileRestart,
    tick,
    abortInFlight: (reason) => {
      for (const controller of verificationControllers.values()) controller.abort(reason);
    },
  });
  let shutdownPromise: Promise<void> | null = null;
  function beginDrain(): void {
    supervisor.beginDrain();
  }
  function shutdown(): Promise<void> {
    shutdownPromise ??= (async () => {
      beginDrain();
      let firstError: unknown;
      const rememberError = (error: unknown) => {
        firstError ??= error;
        supervisor.reportFailure(error, "setup-shutdown");
      };
      // Interactive native logins are NOT terminated on ordinary shutdown
      // (v3.0.3 S5): the detached Terminal runner keeps waiting for the user,
      // and the successor daemon adopts it in reconcileRestart (result-first,
      // then identity-proven live adoption). Explicit cancel remains the only
      // path that signals a login runner.
      await supervisor.shutdown();
      try {
        if (store.recoveryState().status === "ready") {
          for (const job of store.list({ active: true })) {
            settleDurableCapability(job, "shutdown");
          }
        }
      } catch (error) {
        rememberError(error);
      }
      if (firstError !== undefined) throw firstError;
    })();
    return shutdownPromise;
  }
  return {
    start: () => supervisor.start(),
    beginDrain,
    shutdown,
    create(input: unknown, idempotency?: { key: string; client: string }): ControlSetupJob {
      const request = ControlSetupJobCreateRequest.parse(input);
      const { harness, action } = request;
      const profileBinding = resolveProfileBinding(harness, request.profileId);
      const binding = idempotency ? { ...idempotency, request } : undefined;
      const prior = binding ? store.resolveCreate(binding) : null;
      if (prior) return prior;
      supervisor.assertCreateAllowed();
      const jobs = store.list({ harness });
      const active = jobs.findLast((job) => ACTIVE_SETUP_STATES.has(job.state));
      if (active) {
        // Same target store → idempotent reuse. A DIFFERENT target (default vs
        // profile, or two profiles) must refuse loudly: returning the other job
        // would hand the caller a login into the wrong store.
        if ((active.profileId ?? null) === (profileBinding?.profileId ?? null)) {
          return binding ? store.bindCreate(active.jobId, binding) : active;
        }
        throw Object.assign(
          new Error(
            `another ${harness} login job is active (${active.jobId}, ${
              active.profileId ? `profile "${active.profileId}"` : "default store"
            }); finish or cancel it before starting a ${
              profileBinding ? `profile "${profileBinding.profileId}"` : "default-store"
            } login`,
          ),
          { status: 409 },
        );
      }
      const replacementFence = jobs.findLast(
        (job) =>
          job.outcome?.reason === "termination_unconfirmed" && !job.terminationReconciliation,
      );
      if (replacementFence) {
        return binding ? store.bindCreate(replacementFence.jobId, binding) : replacementFence;
      }
      const profile = SETUP_PROFILES[harness];
      const jobId = `setup-${now().getTime().toString(36)}-${randomUUID().slice(0, 8)}`;
      const authCapability = {
        ...authCapabilityVerifier.prepare({
          attemptId: `auth-${randomUUID()}`,
          harness,
          requested: "subscription",
          requiredRoute: "vendor_native",
          requiredSource: "native_session",
        }).binding,
        state: "disclosed" as const,
      };
      const base = store.create(
        {
          jobId,
          harness,
          action,
          state: "queued",
          phase: "preparing",
          command: null,
          guideUrl: profile.guideUrl,
          message: profileBinding
            ? `${profile.note} This login targets the scoped Claudexor profile "${profileBinding.profileId}" (INV-135); the default vendor store is never touched.`
            : `${profile.note} The required same-harness smoke may consume quota; incremental billing is unknown.`,
          createdAt: iso(),
          startedAt: null,
          finishedAt: null,
          authCapability,
          profileId: profileBinding?.profileId ?? null,
        },
        binding,
      );
      log(
        jobId,
        `created ${harness} ${action}${profileBinding ? ` for profile "${profileBinding.profileId}"` : ""}`,
      );
      const spec = NativeLogin.nativeLoginSpec(harness);
      if (!spec)
        return finish(
          jobId,
          "not_supported",
          "not_supported",
          `${harness} native login is unavailable; install the vendor CLI first.`,
        );
      return startObservableLogin(base, spec, profileBinding?.configDir);
    },
    list(filter?: ControlSetupJobListFilter): ControlSetupJob[] {
      return store.list(filter);
    },
    status(input: unknown): ControlSetupJob {
      const p = (input ?? {}) as Record<string, unknown>;
      return store.status(typeof p.jobId === "string" ? p.jobId : "");
    },
    snapshot(input: unknown) {
      const p = (input ?? {}) as Record<string, unknown>;
      return store.snapshot(typeof p.jobId === "string" ? p.jobId : "");
    },
    events(input: unknown) {
      const p = (input ?? {}) as Record<string, unknown>;
      const jobId = typeof p.jobId === "string" ? p.jobId : "";
      const afterCursor = typeof p.afterCursor === "string" ? p.afterCursor : null;
      return store.events(jobId, afterCursor);
    },
    async cancel(input: unknown): Promise<ControlSetupJob> {
      const p = (input ?? {}) as Record<string, unknown>;
      const jobId = typeof p.jobId === "string" ? p.jobId : "";
      const job = store.status(jobId);
      if (TERMINAL_SETUP_STATES.has(job.state)) return job;
      return terminateLogin(jobId, "cancelled_by_user");
    },
    reconcile(input: unknown): ControlSetupJob {
      supervisor.assertCreateAllowed();
      const p = (input ?? {}) as Record<string, unknown>;
      const jobId = typeof p.jobId === "string" ? p.jobId : "";
      const job = store.status(jobId);
      if (job.terminationReconciliation) return job;
      if (job.outcome?.reason !== "termination_unconfirmed") {
        throw Object.assign(new Error("setup job has no unconfirmed termination to reconcile"), {
          code: "setup_reconciliation_not_applicable",
          status: 409,
        });
      }
      const group = processGroupFromJob(job);
      if (!group || processGroups.probeEmpty(group).status !== "empty") {
        throw Object.assign(new Error("setup process group is not proven empty"), {
          code: "setup_termination_unconfirmed",
          status: 409,
          requiredActions: ["retry_setup_reconciliation"],
        });
      }
      return update(jobId, {
        terminationReconciliation: { status: "empty", observedAt: iso() },
        message: `${job.harness} login process group is confirmed empty; replacement is allowed.`,
      });
    },
    extend(input: unknown): ControlSetupJob {
      supervisor.assertCreateAllowed();
      const p = (input ?? {}) as Record<string, unknown>;
      const jobId = typeof p.jobId === "string" ? p.jobId : "";
      const job = store.status(jobId);
      if (
        !ACTIVE_SETUP_STATES.has(job.state) ||
        !["launching", "awaiting_user"].includes(job.phase ?? "") ||
        !job.deadlineAt
      ) {
        throw Object.assign(new Error("setup job cannot be extended"), { status: 409 });
      }
      return update(jobId, {
        deadlineAt: new Date(Date.parse(job.deadlineAt) + LOGIN_EXTENSION_MS).toISOString(),
        message: `${job.harness} login deadline extended by 15 minutes.`,
      });
    },
    _store: store,
    _supervisorHealth: () => supervisor.health(),
  };
}
