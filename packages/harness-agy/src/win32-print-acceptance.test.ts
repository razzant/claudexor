import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { killWindowsProcessTree } from "@claudexor/core";
import { describe, expect, it } from "vitest";

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

interface AcceptanceSummary {
  ok: boolean;
  stage?: string;
  workerPid: number;
  observedPids: number[];
  error?: string;
  inAppDiagnostics?: {
    runnerPid: number;
    workerPid?: number;
    helperPid?: number;
    vendorPid?: number;
    runnerExit?: { code: number | null; signal: NodeJS.Signals | null };
    runnerClosed?: boolean;
    stdoutBytes?: number;
    stderrBytes?: number;
    codeEchoObserved?: boolean;
  };
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
    try {
      let completed: CollectedChild;
      try {
        completed = await withTimeout(collect(child), 75_000, "agy acceptance console host");
      } catch (error) {
        if (existsSync(resultPath)) {
          summary = JSON.parse(readFileSync(resultPath, "utf8")) as AcceptanceSummary;
        }
        const message = error instanceof Error ? error.message : String(error);
        // Capture typed facts before finally kills the tree and deletes its
        // sidecars. Never include the pasted input, OAuth URL, or raw output.
        throw new Error(
          `${message}; stage=${summary?.stage ?? "not_started"}; inApp=${JSON.stringify(inAppTimeoutDiagnostics(root, summary))}`,
        );
      }
      if (existsSync(resultPath)) {
        summary = JSON.parse(readFileSync(resultPath, "utf8")) as AcceptanceSummary;
      }
      expect(completed.code, summary?.error ?? completed.stderr).toBe(0);
      expect(completed.signal).toBeNull();
      expect(summary?.ok, summary?.error).toBe(true);
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

      const observedPids = [
        hostPid,
        summary.workerPid,
        summary.timeout.pids.vendor,
        summary.timeout.pids.descendant,
        summary.login.runnerPid,
        ...inAppPids,
        ...summary.observedPids,
        ...summary.evidence.map((row) => row.pid),
        ...summary.control.evidence.map((row) => row.pid),
      ];
      await expectPidsGone(observedPids, 5_000);
    } finally {
      const exactPids = new Set<number>([hostPid]);
      if (summary) {
        exactPids.add(summary.workerPid);
        for (const pid of summary.observedPids ?? []) exactPids.add(pid);
        exactPids.add(summary.timeout?.pids.vendor ?? 0);
        exactPids.add(summary.timeout?.pids.descendant ?? 0);
        for (const row of summary.evidence ?? []) exactPids.add(row.pid);
        for (const row of summary.control?.evidence ?? []) exactPids.add(row.pid);
        exactPids.add(summary.inAppLogin?.runnerPid ?? 0);
        exactPids.add(summary.inAppLogin?.workerPid ?? 0);
        exactPids.add(summary.inAppLogin?.helperPid ?? 0);
        exactPids.add(summary.inAppLogin?.vendorPid ?? 0);
      }
      for (const pid of exactPids) {
        if (pid > 0 && pidAlive(pid)) killWindowsProcessTree(pid);
      }
      try {
        await expectPidsGone([...exactPids], 5_000);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 90_000);
});

interface CollectedChild {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function inAppTimeoutDiagnostics(root: string, summary: AcceptanceSummary | null) {
  const diagnostics = summary?.inAppDiagnostics;
  const [input, state, receipt] = [
    "runner-input.json",
    "runner-state.json",
    "runner-result.json",
  ].map((name) => {
    const path = join(root, "in-app-job", name);
    try {
      return { exists: true, value: JSON.parse(readFileSync(path, "utf8")) };
    } catch {
      return { exists: existsSync(path), value: null };
    }
  });
  return {
    ...diagnostics,
    processes: (["runnerPid", "workerPid", "helperPid", "vendorPid"] as const).map((role) => {
      const pid = diagnostics?.[role];
      return { role, pid: pid ?? null, alive: pid ? pidAlive(pid) : null };
    }),
    input: {
      exists: input!.exists,
      readable: input!.value !== null,
      consumed: input!.value?.consumed === true,
    },
    state: { exists: state!.exists, stage: state!.value?.stage ?? null },
    receipt: {
      exists: receipt!.exists,
      readable: receipt!.value !== null,
      commandStarted: receipt!.value?.commandStarted ?? null,
      exitCode: receipt!.value?.exitCode ?? null,
      signal: receipt!.value?.signal ?? null,
      errorCode: receipt!.value?.errorCode ?? null,
    },
  };
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

async function expectPidsGone(pids: number[], timeoutMs: number): Promise<void> {
  const unique = [...new Set(pids.filter((pid) => pid > 0))];
  const deadline = Date.now() + timeoutMs;
  while (unique.some(pidAlive)) {
    if (Date.now() >= deadline) throw new Error(`processes survived cleanup: ${unique.join(",")}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
