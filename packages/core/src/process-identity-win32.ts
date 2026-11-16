import { execFile, spawnSync } from "node:child_process";
import type { ProcessHelperExecution } from "./process-identity.js";

/**
 * Windows birth-time reader. Windows exposes no `/proc`, so the kernel's own
 * `GetProcessTimes` creation time is read through the absolute System32
 * PowerShell (same pinned-path discipline as the `taskkill` owner) and printed
 * as a locale-independent FILETIME. Blocking — warm it is sub-second, but a
 * cold PowerShell on a loaded host takes many seconds — so it is opt-in per
 * lane rather than a default for every spawn.
 */
export function executeWin32ProcessTimes(pid: number): ProcessHelperExecution {
  const { file, args, options } = win32ProcessTimesInvocation(pid);
  const result = spawnSync(file, args, { ...options, encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code,
  };
}

/**
 * The same reader without blocking the event loop (`execFile`): for an owner that
 * runs on the daemon's main thread and reads one pid on an operator's request
 * (#694). Same program, script, bound and scrubbed environment.
 */
export function executeWin32ProcessTimesAsync(pid: number): Promise<ProcessHelperExecution> {
  const { file, args, options } = win32ProcessTimesInvocation(pid);
  return new Promise((resolve) => {
    execFile(file, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      const failure = error as (NodeJS.ErrnoException & { code?: unknown }) | null;
      const status =
        failure && typeof failure.code === "number" ? failure.code : failure ? null : 0;
      resolve({
        status,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        ...(failure && typeof failure.code === "string" ? { errorCode: failure.code } : {}),
      });
    });
  });
}

function win32ProcessTimesInvocation(pid: number): {
  file: string;
  args: string[];
  options: {
    timeout: number;
    maxBuffer: number;
    windowsHide: boolean;
    env: Record<string, string>;
  };
} {
  const systemRoot = process.env["SystemRoot"] || "C:\\Windows";
  const script =
    "try { $p = [System.Diagnostics.Process]::GetProcessById(" +
    String(pid) +
    "); " +
    "[Console]::Out.Write('claudexor-process-identity-win32-v1' + [char]9 + $p.Id + [char]9 + " +
    "$p.StartTime.ToFileTimeUtc()); exit 0 } " +
    "catch [System.ArgumentException] { exit 3 } " +
    "catch [System.ComponentModel.Win32Exception] { exit 4 } " +
    "catch { exit 5 }";
  return {
    file: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    args: ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", script],
    options: {
      // PowerShell COLD-STARTS well past five seconds on a loaded host — the
      // GitHub Windows runners exceed it routinely under a parallel test run,
      // and a user's machine under load is the same shape. An identity read
      // that times out reports `unknown`, which every caller treats as
      // fail-closed, so a short cap silently degrades Windows runs rather
      // than protecting anything; the bound exists only to keep a wedged
      // PowerShell from hanging a lane.
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      env: { SystemRoot: systemRoot, PATH: `${systemRoot}\\System32` },
    },
  };
}
