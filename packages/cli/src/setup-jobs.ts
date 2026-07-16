import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  SetupNativeCommandReceipt,
  type ControlSetupJob,
  type ControlSetupJobListFilter,
} from "@claudexor/schema";
import { noProjectRepoRoot } from "@claudexor/util";
import * as NativeLogin from "./native-login.js";
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
type SetupProfile = {
  guideUrl: string;
  note: string;
};

const SETUP_PROFILES: Record<ControlHarnessSetupHarness, SetupProfile> = {
  codex: {
    guideUrl: "https://developers.openai.com/codex/auth/",
    note: "Codex native login updates the official vendor-owned CLI session. Exact subscription setup never falls back to a managed API key.",
  },
  claude: {
    guideUrl: "https://code.claude.com/docs/en/authentication",
    note: "Claude Code native login updates the official vendor-owned CLI session. Exact subscription setup never falls back to a managed API key.",
  },
  cursor: {
    guideUrl: "https://docs.cursor.com/en/cli/reference/authentication",
    note: "Cursor native CLI login is reused when available.",
  },
};

export interface SetupJobManagerOptions {
  rootDir?: string;
  store?: SetupJobStore;
  probeAuthSource?: (
    harness: string,
    source: "native_session",
    opts: { fresh: true; authPreference: "subscription"; abortSignal: AbortSignal },
  ) => Promise<AuthSourceReadiness | null>;
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
export function resolveSetupLoginRunnerPath(
  moduleUrl: string = import.meta.url,
  pathExists: (path: string) => boolean = existsSync,
): string {
  const directory = dirname(fileURLToPath(moduleUrl));
  const bundled = resolve(directory, "setup-login-runner.cjs");
  return pathExists(bundled) ? bundled : resolve(directory, "setup-login-runner.js");
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

  function waitWithAbort(ms: number, controller: AbortController): Promise<void> {
    if (controller.signal.aborted) return Promise.reject(controller.signal.reason);
    return new Promise((resolveWait, rejectWait) => {
      let settled = false;
      const settle = (task: () => void) => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener("abort", onAbort);
        task();
      };
      const onAbort = () =>
        settle(() =>
          rejectWait(
            controller.signal.reason instanceof Error
              ? controller.signal.reason
              : new Error("setup operation aborted"),
          ),
        );
      controller.signal.addEventListener("abort", onAbort, { once: true });
      sleep(ms).then(
        () => settle(resolveWait),
        (error) => settle(() => rejectWait(error)),
      );
    });
  }

  function withAbortAndTimeout<T>(
    operation: () => Promise<T>,
    controller: AbortController,
    timeoutMs: number,
    label: string,
  ): Promise<T> {
    if (controller.signal.aborted) return Promise.reject(controller.signal.reason);
    return new Promise((resolveOperation, rejectOperation) => {
      let settled = false;
      const settle = (task: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", onAbort);
        task();
      };
      const onAbort = () =>
        settle(() =>
          rejectOperation(
            controller.signal.reason instanceof Error
              ? controller.signal.reason
              : new Error(`${label} aborted`),
          ),
        );
      const timer = setTimeout(() => {
        const error = Object.assign(new Error(`${label} timed out after ${timeoutMs / 1000}s`), {
          code: "setup_timeout",
        });
        controller.abort(error);
      }, timeoutMs);
      timer.unref();
      controller.signal.addEventListener("abort", onAbort, { once: true });
      operation().then(
        (value) => settle(() => resolveOperation(value)),
        (error) => settle(() => rejectOperation(error)),
      );
    });
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
      message: `Verifying the exact ${job.harness} native subscription source.`,
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
      let readiness: AuthSourceReadiness | null;
      try {
        readiness = await probeNativeSession(job.harness, verificationController, remaining);
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
        );
        continue;
      }
      const latest = store.status(jobId);
      if (!ACTIVE_SETUP_STATES.has(latest.state) || latest.phase === "cancelling") return;
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
      await waitWithAbort(
        Math.min(verifyPollMs, Math.max(0, deadline - now().getTime())),
        verificationController,
      );
    }
    const latest = store.status(jobId);
    if (!ACTIVE_SETUP_STATES.has(latest.state) || latest.phase === "cancelling") return;
    finish(
      jobId,
      "failed",
      "auth_not_ready",
      `${latest.harness} native session was not ready before the verification deadline${lastDetail ? `: ${lastDetail}` : "."}`,
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

  function processGroupFromJob(job: ControlSetupJob): ProcessGroupHandle | null {
    if (!job.execution) return null;
    try {
      return parseProcessGroupHandle(job.execution.processGroup);
    } catch {
      return null;
    }
  }

  function stateMatchesDurableExecution(
    job: ControlSetupJob,
    state: SetupLoginRunnerState,
  ): boolean {
    return (
      job.execution?.executionId === state.executionId &&
      job.execution.commandDigest === state.commandDigest &&
      job.execution.manifestDigest === state.manifestDigest &&
      job.execution.observedAt === state.observedAt &&
      JSON.stringify(job.execution.processGroup) === JSON.stringify(state.processGroup)
    );
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
        await observeAndPermit(job.jobId, state);
        continue;
      }
      const group = processGroupFromJob(job);
      if (!group) {
        finish(
          job.jobId,
          "failed",
          "interrupted",
          `${job.harness} login stopped before execution authorization during daemon restart.`,
        );
        continue;
      }
      const empty = processGroups.probeEmpty(group);
      if (empty.status === "empty") {
        finish(
          job.jobId,
          "failed",
          "interrupted",
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

  function startObservableLogin(job: ControlSetupJob, spec: NativeLoginSpec): ControlSetupJob {
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
      let unconfirmed: ControlSetupJob | undefined;
      const rememberError = (error: unknown) => {
        firstError ??= error;
        supervisor.reportFailure(error, "setup-shutdown");
      };
      try {
        const active = store.recoveryState().status === "ready" ? store.list({ active: true }) : [];
        const waitingLogins = active.filter(
          (job) =>
            job.authCapability?.state !== "running" &&
            job.authCapability?.state !== "completed" &&
            job.authCapability?.state !== "interrupted_unknown",
        );
        const stopped = await Promise.allSettled(
          waitingLogins.map((job) => terminateLogin(job.jobId, "cancelled_on_restart")),
        );
        for (const result of stopped) {
          if (result.status === "rejected") rememberError(result.reason);
          else if (result.value.outcome?.reason === "termination_unconfirmed") {
            unconfirmed ??= result.value;
          }
        }
      } catch (error) {
        rememberError(error);
      }
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
      if (unconfirmed) {
        throw Object.assign(
          new Error(`setup shutdown could not prove termination for ${unconfirmed.jobId}`),
          { code: "setup_shutdown_unconfirmed", status: 503 },
        );
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
      const binding = idempotency ? { ...idempotency, request } : undefined;
      const prior = binding ? store.resolveCreate(binding) : null;
      if (prior) return prior;
      supervisor.assertCreateAllowed();
      const jobs = store.list({ harness });
      const existing = jobs.findLast((job) => ACTIVE_SETUP_STATES.has(job.state));
      if (existing) return binding ? store.bindCreate(existing.jobId, binding) : existing;
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
          message: `${profile.note} The required same-harness smoke may consume quota; incremental billing is unknown.`,
          createdAt: iso(),
          startedAt: null,
          finishedAt: null,
          authCapability,
        },
        binding,
      );
      log(jobId, `created ${harness} ${action}`);
      const spec = NativeLogin.nativeLoginSpec(harness);
      if (!spec)
        return finish(
          jobId,
          "not_supported",
          "not_supported",
          `${harness} native login is unavailable; install the vendor CLI first.`,
        );
      return startObservableLogin(base, spec);
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
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
