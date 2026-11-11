import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { killWindowsProcessTree } from "@claudexor/core";
import { SetupLoginRunnerState, SetupNativeCommandErrorCode } from "@claudexor/schema";
import { describe, expect, it, vi } from "vitest";
import {
  describeRemaining,
  inAppSidecarFacts,
  preferCapturedSidecars,
  probeProcess,
  readInAppSidecars,
  remainingProcesses,
  settleInAppOutcome,
  type InAppSidecarFacts,
  type RecordedProcess,
} from "../../../scripts/lib/win32-agy-acceptance-diagnostics.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..", "..");
const fixture = resolve(
  repoRoot,
  "packages",
  "core",
  "dist",
  "native-test",
  "claudexor-conpty-test-child.exe",
);
const worker = resolve(repoRoot, "scripts", "win32-agy-print-acceptance-worker.mjs");
const sidecarVocabulary = {
  errorCodes: SetupNativeCommandErrorCode.options,
  stages: SetupLoginRunnerState.shape.stage.options,
};

interface FakeEvidence {
  mode: "print" | "hang" | "interactive";
  command: "model" | "quota";
  pid: number;
  consoleCodePage: number;
  windowPresent: boolean;
  coninAvailable: boolean;
  stdinEof: boolean;
  homeMatchesUserProfile: boolean;
  autoUpdateDisabled: boolean;
  providerKeysAbsent: boolean;
}

interface InAppDiagnostics {
  runnerPid: number;
  workerPid?: number;
  helperPid?: number;
  vendorPid?: number;
  runnerExit?: { code: number | null; signal: NodeJS.Signals | null };
  runnerClosed?: boolean;
  stdoutBytes?: number;
  stderrBytes?: number;
  codeEchoObserved?: boolean;
  sidecars?: InAppSidecarFacts;
}

interface AcceptanceSummary {
  ok: boolean;
  stage?: string;
  workerPid: number;
  observedProcesses: RecordedProcess[];
  error?: string;
  inAppDiagnostics?: InAppDiagnostics;
  paths: {
    config: string;
    evidenceB: string;
    browserSentinel: string;
  };
  control: { status: number; evidence: FakeEvidence[] };
  model: { kind: string; modelId: string | null };
  quota: {
    snapshots: Array<{
      subject: { subject_id: string };
      constraints: Array<{
        id: string;
        used_ratio: number | null;
        window_seconds: number | null;
        applies_to_unspecified_model?: boolean;
      }>;
    }>;
    absences: unknown[];
  };
  timeout: {
    result: { kind: string; reason?: string };
    pids: { vendor: number; descendant: number };
  };
  browserSentinelBeforeClientPty: boolean;
  browserSentinelAfterClientPty: boolean;
  login: {
    exit: number;
    signal: NodeJS.Signals | null;
    runnerPid: number;
    receipt: {
      commandStarted: boolean;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      errorCode?: string;
    } | null;
  };
  inAppLogin: {
    exit: number;
    signal: NodeJS.Signals | null;
    runnerPid: number;
    workerPid: number;
    helperPid: number;
    vendorPid: number;
    helperPath: string;
    receipt: {
      commandStarted: boolean;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      errorCode?: string;
      outputTail?: string;
    } | null;
    disclosureFlow: string;
  };
  evidence: FakeEvidence[];
}

describe.skipIf(process.platform !== "win32")("Win32 agy acceptance", () => {
  it("covers console-free print, client_pty, and daemon-hosted ConPTY", async () => {
    expect(existsSync(fixture), `missing native fixture: ${fixture}`).toBe(true);
    expect(existsSync(worker), `missing acceptance worker: ${worker}`).toBe(true);
    const root = mkdtempSync(join(tmpdir(), "claudexor-win32-agy-"));
    const resultPath = join(root, "acceptance-result.json");
    const child = spawn(
      fixture,
      [
        "--console-host",
        process.execPath,
        worker,
        "--repo-root",
        repoRoot,
        "--fixture",
        fixture,
        "--root",
        root,
        "--result",
        resultPath,
      ],
      {
        cwd: repoRoot,
        windowsHide: true,
        shell: false,
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (!child.pid) throw new Error("console host PID was not assigned");
    const hostPid = child.pid;
    let summary: AcceptanceSummary | null = null;
    let runFailure: { error: unknown } | undefined;
    try {
      let completed: CollectedChild;
      try {
        completed = await withTimeout(collect(child), 75_000, "agy acceptance console host");
      } catch (error) {
        summary = readSummary(resultPath);
        const message = error instanceof Error ? error.message : String(error);
        // Capture typed facts before finally kills the tree and deletes its
        // sidecars. Never include the pasted input, OAuth URL, or raw output.
        throw new Error(`${message}; ${failureFacts(root, summary)}`);
      }
      summary = readSummary(resultPath);
      // A worker that failed on its own carries the same typed facts.
      const failure =
        completed.code === 0 && completed.signal === null && summary?.ok === true
          ? undefined
          : `${summary?.error ?? completed.stderr}; ${failureFacts(root, summary)}`;
      expect(completed.code, failure).toBe(0);
      expect(completed.signal, failure).toBeNull();
      expect(summary?.ok, failure).toBe(true);
      if (!summary?.ok) throw new Error(summary?.error ?? "acceptance worker failed");

      expect(parseConsoleState(completed.stdout, "HOST_BEFORE")).toEqual({
        consoleCodePage: 0,
        windowPresent: false,
        windowVisible: false,
        coninAvailable: false,
      });
      const hostAfter = parseConsoleState(completed.stdout, "HOST_AFTER");
      expect(hostAfter.consoleCodePage).toBeGreaterThan(0);
      expect(hostAfter.coninAvailable).toBe(true);

      expect(summary.paths.config).toBe(join(root, "config.yaml"));
      expect(existsSync(summary.paths.config)).toBe(true);
      expect(summary.model).toEqual({
        kind: "authenticated",
        modelId: "gemini-3.7-flash-high",
      });
      expect(summary.quota.absences).toEqual([]);
      expect(summary.quota.snapshots).toHaveLength(1);
      expect(summary.quota.snapshots[0]?.subject.subject_id).toBe("agy-win-a");
      expect(summary.quota.snapshots[0]?.constraints).toEqual([
        expect.objectContaining({
          id: "gemini-weekly",
          used_ratio: 0.75,
          window_seconds: 7 * 24 * 60 * 60,
          applies_to_unspecified_model: true,
        }),
      ]);

      const printEvidence = summary.evidence.filter(
        (row) => row.mode === "print" || row.mode === "hang",
      );
      expect(printEvidence.filter((row) => row.mode === "print")).toHaveLength(3);
      expect(printEvidence.filter((row) => row.mode === "hang")).toHaveLength(1);
      expect(printEvidence.filter((row) => row.command === "quota")).toHaveLength(1);
      for (const row of printEvidence) {
        expect(row).toMatchObject({
          consoleCodePage: 0,
          windowPresent: false,
          coninAvailable: false,
          stdinEof: true,
          homeMatchesUserProfile: true,
          autoUpdateDisabled: true,
          providerKeysAbsent: true,
        });
      }
      const clientPty = summary.evidence.filter((row) => row.mode === "interactive");
      expect(clientPty).toHaveLength(1);
      expect(clientPty[0]).toMatchObject({
        command: "model",
        coninAvailable: true,
        homeMatchesUserProfile: true,
        autoUpdateDisabled: true,
        providerKeysAbsent: true,
      });
      expect(clientPty[0]!.consoleCodePage).toBeGreaterThan(0);

      expect(summary.control.status).toBe(0);
      expect(summary.control.evidence).toHaveLength(1);
      expect(summary.control.evidence[0]).toMatchObject({
        mode: "interactive",
        coninAvailable: true,
        homeMatchesUserProfile: true,
        autoUpdateDisabled: true,
        providerKeysAbsent: true,
      });
      expect(summary.control.evidence[0]!.consoleCodePage).toBeGreaterThan(0);
      expect(existsSync(summary.paths.evidenceB)).toBe(false);
      expect(summary.browserSentinelBeforeClientPty).toBe(false);
      expect(summary.browserSentinelAfterClientPty).toBe(true);
      expect(existsSync(summary.paths.browserSentinel)).toBe(true);

      expect(summary.timeout.result).toMatchObject({
        kind: "failed",
        reason: "termination_unconfirmed",
      });
      expect(summary.login.exit).toBe(0);
      expect(summary.login.signal).toBeNull();
      expect(summary.login.runnerPid).toBeGreaterThan(0);
      expect(summary.login.receipt).toMatchObject({
        commandStarted: true,
        exitCode: 0,
        signal: null,
      });
      expect(summary.login.receipt).not.toHaveProperty("errorCode");
      expect(summary.inAppLogin.helperPath).toBe(
        resolve(repoRoot, "packages", "core", "dist", "native", "claudexor-conpty-helper.exe"),
      );
      expect(summary.inAppLogin).toMatchObject({
        exit: 0,
        signal: null,
        disclosureFlow: "oauth_url_input",
      });
      expect(summary.inAppLogin.receipt).toMatchObject({
        commandStarted: true,
        exitCode: 0,
        signal: null,
      });
      expect(summary.inAppLogin.receipt).not.toHaveProperty("errorCode");
      expect(summary.inAppLogin.receipt).not.toHaveProperty("outputTail");
      const inAppPids = [
        summary.inAppLogin.runnerPid,
        summary.inAppLogin.workerPid,
        summary.inAppLogin.helperPid,
        summary.inAppLogin.vendorPid,
      ];
      expect(inAppPids.every((pid) => pid > 0)).toBe(true);
      expect(new Set(inAppPids).size).toBe(inAppPids.length);
      for (const row of [...summary.evidence, ...summary.control.evidence]) {
        expect(row.pid).toBeGreaterThan(0);
      }

      await expectProcessesGone(recordedProcesses(hostPid, summary), 5_000);
    } catch (error) {
      runFailure = { error };
      throw error;
    } finally {
      // The run's own failure carries its stage, exit and receipt facts; a
      // cleanup failure is appended to it, never put in its place.
      await cleanUpAfter(runFailure, async () => {
        const processes = recordedProcesses(hostPid, summary);
        for (const pid of new Set(processes.map((entry) => entry.pid))) {
          if (pid > 0 && probeProcess(pid).state !== "gone") killWindowsProcessTree(pid);
        }
        await confirmCleanup(processes, root, 5_000);
      });
    }
  }, 90_000);
});

// Portable controls of the failure path above: a real child exits, the worker's
// own outcome check reads real sidecars through the real receipt decoder, and
// the summary goes through the same reader and message as the acceptance.
describe("Win32 agy acceptance failure facts", () => {
  const privateOutput =
    "CODE: one-shot-win32-code-77 https://accounts.google.com/o/oauth2/auth?state=claudexor-conpty-fixture";

  it("pass a clean in-app outcome through the worker's check", async () => {
    await withInAppJob(async (_root, paths, protocol) => {
      protocol.atomicPrivateJson(paths.receipt, runnerReceipt({}));
      const runner = exitingChild(0);
      const diagnostics: InAppDiagnostics = { runnerPid: runner.pid };
      let persisted = 0;
      const outcome = await settleInAppOutcome({
        finished: runner.finished,
        diagnostics,
        paths,
        decodeReceipt: protocol.readRunnerResult,
        vocabulary: sidecarVocabulary,
        persist: () => (persisted += 1),
      });
      expect(outcome.exit).toMatchObject({ code: 0, signal: null });
      expect(outcome.receipt).toMatchObject({ commandStarted: true, exitCode: 0, signal: null });
      expect(persisted).toBe(1);
    });
  });

  it("keep an exit-1 runner's receipt facts after the worker removes its input", async () => {
    await withInAppJob(async (root, paths, protocol) => {
      protocol.atomicPrivateJson(
        paths.receipt,
        runnerReceipt({
          exitCode: 1,
          errorCode: "terminal_transport_failed",
          outputTail: privateOutput,
        }),
      );
      protocol.atomicPrivateJson(paths.input, { ...loginJob, consumed: true, submittedAt });
      writeFileSync(paths.state, JSON.stringify({ ...loginJob, stage: "running" }));
      const runner = exitingChild(1);
      const diagnostics: InAppDiagnostics = { runnerPid: runner.pid };
      const persisted: string[] = [];
      await expect(
        settleInAppOutcome({
          finished: runner.finished,
          diagnostics,
          paths,
          decodeReceipt: protocol.readRunnerResult,
          vocabulary: sidecarVocabulary,
          persist: () => persisted.push(JSON.stringify(diagnostics)),
        }),
      ).rejects.toThrow("in-app runner exited 1");
      // The facts were kept and persisted before the exit check failed.
      expect(persisted.map((text) => JSON.parse(text))).toEqual([diagnostics]);
      rmSync(paths.input);

      const message = failureMessage(root, diagnostics);
      expect(message).not.toContain("one-shot-win32-code-77");
      expect(message).not.toContain("accounts.google.com");
      const inApp = inAppFacts(message);
      expect(inApp.runnerExit).toEqual({ code: 1, signal: null });
      expect(inApp.sidecars).toEqual({
        input: {
          source: "worker",
          exists: true,
          readable: true,
          consumed: true,
          valueRetained: false,
        },
        state: { source: "worker", exists: true, readable: true, stage: "running" },
        receipt: {
          source: "worker",
          exists: true,
          readable: true,
          commandStarted: true,
          exitCode: 1,
          signal: null,
          errorCode: "terminal_transport_failed",
          decoded: true,
        },
      });
      expect(inApp.processes[0]).toMatchObject({ role: "runnerPid", pid: runner.pid });
    });
  });

  it("keep the exit facts when the receipt is malformed", async () => {
    await withInAppJob(async (root, paths, protocol) => {
      writeFileSync(paths.receipt, '{"commandStarted":true,"exitCode":');
      const runner = exitingChild(1);
      const diagnostics: InAppDiagnostics = { runnerPid: runner.pid };
      await expect(
        settleInAppOutcome({
          finished: runner.finished,
          diagnostics,
          paths,
          decodeReceipt: protocol.readRunnerResult,
          vocabulary: sidecarVocabulary,
          persist: () => undefined,
        }),
      ).rejects.toThrow("in-app runner exited 1");

      const inApp = inAppFacts(failureMessage(root, diagnostics));
      expect(inApp.runnerExit).toEqual({ code: 1, signal: null });
      expect(inApp.sidecars.receipt).toEqual({
        source: "worker",
        exists: true,
        readable: false,
        commandStarted: null,
        exitCode: null,
        signal: null,
        errorCode: null,
        decoded: false,
      });
    });
  });

  it("keep the exit facts when the receipt decoder throws", async () => {
    await withInAppJob(async (root, paths, protocol) => {
      protocol.atomicPrivateJson(paths.receipt, runnerReceipt({ exitCode: 1 }));
      const runner = exitingChild(1);
      const diagnostics: InAppDiagnostics = { runnerPid: runner.pid };
      await expect(
        settleInAppOutcome({
          finished: runner.finished,
          diagnostics,
          paths,
          decodeReceipt: () => {
            throw new Error("receipt decoder failed");
          },
          vocabulary: sidecarVocabulary,
          persist: () => undefined,
        }),
      ).rejects.toThrow("receipt decoder failed");

      const inApp = inAppFacts(failureMessage(root, diagnostics));
      expect(inApp.runnerExit).toEqual({ code: 1, signal: null });
      expect(inApp.sidecars.receipt).toMatchObject({ source: "worker", exitCode: 1 });
      expect(inApp.sidecars.receipt).not.toHaveProperty("decoded");
    });
  });

  it("read sidecars late only when the worker captured none", async () => {
    await withInAppJob(async (root, paths) => {
      writeFileSync(paths.state, JSON.stringify({ ...loginJob, stage: "awaiting_permit" }));
      const inApp = inAppFacts(failureMessage(root, { runnerPid: 0 }));
      expect(inApp.sidecars).toEqual({
        input: {
          source: "test",
          exists: false,
          readable: false,
          consumed: false,
          valueRetained: false,
        },
        state: { source: "test", exists: true, readable: true, stage: "awaiting_permit" },
        receipt: {
          source: "test",
          exists: false,
          readable: false,
          commandStarted: null,
          exitCode: null,
          signal: null,
          errorCode: null,
        },
      });
    });
  });

  it("append a cleanup failure to the run's failure instead of replacing it", async () => {
    const runFailure = new Error(
      'in-app runner exited 1; stage=in_app_runner_exited; inApp={"runnerExit":{"code":1,"signal":null}}',
    );
    const survivors = [{ pid: 4242, role: "console host" }];
    const survived = "processes survived cleanup: 4242 unknown EPERM (console host)";
    // EPERM leaves every probe undecided, so no recorded process is proven gone;
    // the spy answers the probes, so no real process receives anything.
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });
    const roots = [0, 1].map(() => mkdtempSync(join(tmpdir(), "claudexor-win32-agy-cleanup-")));
    try {
      const combined = await cleanUpAfter({ error: runFailure }, () =>
        confirmCleanup(survivors, roots[0]!, 50),
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(combined).toBeInstanceOf(AggregateError);
      expect((combined as AggregateError).message).toBe(
        `${runFailure.message}; cleanup also failed: ${survived}`,
      );
      expect((combined as AggregateError).errors[0]).toBe(runFailure);
      expect((combined as AggregateError).cause).toBe(runFailure);
      expect(existsSync(roots[0]!)).toBe(false);

      // Without a run failure the cleanup failure is reported on its own.
      await expect(
        cleanUpAfter(undefined, () => confirmCleanup(survivors, roots[1]!, 50)),
      ).rejects.toThrow(survived);
      expect(existsSync(roots[1]!)).toBe(false);
      expect(kill.mock.calls.every(([pid, signal]) => pid === 4242 && signal === 0)).toBe(true);
    } finally {
      kill.mockRestore();
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  });
});

interface ProtocolModule {
  atomicPrivateJson(path: string, value: unknown): void;
  readRunnerResult(path: string): unknown;
}

const loginJob = { version: 2, jobId: "setup-win32-agy-in-app", executionId: "win32-agy-in-app-1" };
const submittedAt = "2026-10-28T02:09:20.000Z";

function runnerReceipt(outcome: Record<string, unknown>): Record<string, unknown> {
  return {
    ...loginJob,
    commandDigest: "a".repeat(64),
    manifestDigest: "b".repeat(64),
    permitIssuedAt: submittedAt,
    commandStarted: true,
    exitCode: 0,
    signal: null,
    finishedAt: submittedAt,
    ...outcome,
  };
}

async function withInAppJob(
  run: (
    root: string,
    paths: ReturnType<typeof inAppSidecarPaths>,
    protocol: ProtocolModule,
  ) => Promise<void>,
): Promise<void> {
  const protocol = (await import(
    pathToFileURL(join(repoRoot, "packages", "cli", "dist", "setup-login-protocol.js")).href
  )) as ProtocolModule;
  const root = mkdtempSync(join(tmpdir(), "claudexor-win32-agy-facts-"));
  try {
    mkdirSync(join(root, "in-app-job"));
    await run(root, inAppSidecarPaths(root), protocol);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function exitingChild(code: number): { pid: number; finished: Promise<CollectedChild> } {
  const child = spawn(process.execPath, ["-e", `process.exit(${code})`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.pid) throw new Error("control child PID was not assigned");
  return { pid: child.pid, finished: collect(child) };
}

/** Run a cleanup after work that may have failed. Its failure is thrown alone
 * only when the work passed; otherwise it is appended to the work's failure,
 * which stays first and stays the cause. */
async function cleanUpAfter(
  workFailure: { error: unknown } | undefined,
  cleanUp: () => Promise<void>,
): Promise<void> {
  try {
    await cleanUp();
  } catch (cleanupError) {
    if (workFailure === undefined) throw cleanupError;
    throw new AggregateError(
      [workFailure.error, cleanupError],
      `${errorMessage(workFailure.error)}; cleanup also failed: ${errorMessage(cleanupError)}`,
      { cause: workFailure.error },
    );
  }
}

/** Wait for the recorded processes to go, then remove the run's root; a failed
 * removal is appended to a survivor failure the same way. */
async function confirmCleanup(
  processes: readonly RecordedProcess[],
  root: string,
  timeoutMs: number,
): Promise<void> {
  let survivors: { error: unknown } | undefined;
  try {
    await expectProcessesGone(processes, timeoutMs);
  } catch (error) {
    survivors = { error };
    throw error;
  } finally {
    await cleanUpAfter(survivors, async () => rmSync(root, { recursive: true, force: true }));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The message the acceptance reports for a worker that failed with these
 * diagnostics, after its summary round-trips through the result file. */
function failureMessage(root: string, inAppDiagnostics: InAppDiagnostics): string {
  const resultPath = join(root, "acceptance-result.json");
  writeFileSync(
    resultPath,
    `${JSON.stringify({ ok: false, stage: "in_app_runner_exited", workerPid: process.pid, observedProcesses: [], error: "in-app runner exited 1", inAppDiagnostics }, null, 2)}\n`,
  );
  return failureFacts(root, readSummary(resultPath));
}

function inAppFacts(message: string) {
  return JSON.parse(message.slice(message.indexOf("inApp=") + "inApp=".length)) as {
    runnerExit?: { code: number | null; signal: string | null };
    sidecars: Record<keyof InAppSidecarFacts, Record<string, unknown>>;
    processes: Array<Record<string, unknown>>;
  };
}

interface CollectedChild {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function readSummary(resultPath: string): AcceptanceSummary | null {
  return existsSync(resultPath)
    ? (JSON.parse(readFileSync(resultPath, "utf8")) as AcceptanceSummary)
    : null;
}

/** Typed facts of a failed or timed-out run. Never the pasted input, the OAuth
 * URL or raw output. */
function failureFacts(root: string, summary: AcceptanceSummary | null): string {
  return `stage=${summary?.stage ?? "not_started"}; inApp=${JSON.stringify(inAppFailureDiagnostics(root, summary))}`;
}

function inAppFailureDiagnostics(root: string, summary: AcceptanceSummary | null) {
  const diagnostics = summary?.inAppDiagnostics;
  const late = inAppSidecarFacts(readInAppSidecars(inAppSidecarPaths(root)), sidecarVocabulary);
  return {
    ...diagnostics,
    sidecars: preferCapturedSidecars(diagnostics?.sidecars, late),
    processes: (["runnerPid", "workerPid", "helperPid", "vendorPid"] as const).map((role) => {
      const pid = diagnostics?.[role];
      return { role, pid: pid || null, ...(pid ? probeProcess(pid) : { state: null }) };
    }),
  };
}

function inAppSidecarPaths(root: string) {
  const jobDir = join(root, "in-app-job");
  return {
    input: join(jobDir, "runner-input.json"),
    state: join(jobDir, "runner-state.json"),
    receipt: join(jobDir, "runner-result.json"),
  };
}

/** Every process the run recorded, with the role it was recorded in. */
function recordedProcesses(hostPid: number, summary: AcceptanceSummary | null): RecordedProcess[] {
  const processes: RecordedProcess[] = [{ pid: hostPid, role: "console host" }];
  if (!summary) return processes;
  processes.push(
    { pid: summary.workerPid, role: "acceptance worker" },
    ...(summary.observedProcesses ?? []),
  );
  if (summary.timeout) {
    processes.push(
      { pid: summary.timeout.pids.vendor, role: "timeout vendor" },
      { pid: summary.timeout.pids.descendant, role: "timeout descendant" },
    );
  }
  if (summary.login) processes.push({ pid: summary.login.runnerPid, role: "client_pty runner" });
  if (summary.inAppLogin) {
    processes.push(
      { pid: summary.inAppLogin.runnerPid, role: "in-app runner" },
      { pid: summary.inAppLogin.workerPid, role: "in-app worker" },
      { pid: summary.inAppLogin.helperPid, role: "ConPTY helper" },
      { pid: summary.inAppLogin.vendorPid, role: "in-app vendor" },
    );
  }
  for (const row of summary.evidence ?? []) {
    processes.push({ pid: row.pid, role: `fake agy ${row.mode} ${row.command}` });
  }
  for (const row of summary.control?.evidence ?? []) {
    processes.push({ pid: row.pid, role: `console control ${row.mode} ${row.command}` });
  }
  return processes;
}

async function collect(child: ChildProcess): Promise<CollectedChild> {
  if (!child.stdout || !child.stderr) throw new Error("console host pipes were not created");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  return await new Promise<CollectedChild>((resolveChild, rejectChild) => {
    child.once("error", rejectChild);
    child.once("close", (code, signal) => resolveChild({ code, signal, stdout, stderr }));
  });
}

function parseConsoleState(
  output: string,
  label: string,
): {
  consoleCodePage: number;
  windowPresent: boolean;
  windowVisible: boolean;
  coninAvailable: boolean;
} {
  const match = new RegExp(`${label}\\|([0-9]+)\\|([01])\\|([01])\\|([01])\\|END`).exec(output);
  if (!match) throw new Error(`invalid ${label} console state`);
  return {
    consoleCodePage: Number(match[1]),
    windowPresent: match[2] === "1",
    windowVisible: match[3] === "1",
    coninAvailable: match[4] === "1",
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function expectProcessesGone(
  processes: readonly RecordedProcess[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = remainingProcesses(processes, probeProcess);
    if (remaining.length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(`processes survived cleanup: ${describeRemaining(remaining)}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}
