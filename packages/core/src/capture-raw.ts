import { spawn } from "node:child_process";
import { registerChildProcess, unregisterChildProcess } from "./process-registry.js";
import { composeSpawnEnv } from "./env-scope.js";
import { backgroundSpawnShape, prepareHarnessCommand } from "./runtime-env.js";
import { runScopeMarkerOf } from "./process-scope.js";
import { killWindowsProcessTree, resolveKillTreeStrategy } from "./process-tree.js";
import { defaultProcessGroupService, type ProcessGroupHandle } from "./process-group.js";
import type { CaptureResult, SpawnOptions } from "./proc.js";
import { CaptureBuffers } from "./capture-buffer.js";

/** A caller-owned bounded projection, used only for non-exact previews. */
export interface CaptureProjection {
  write(chunk: Buffer): void;
  end(): string;
}
interface RawCaptureOptions extends SpawnOptions {
  stdoutProjection?: CaptureProjection;
  /** Called for every chunk of output, buffered or projected: the child is working. */
  onOutput?: () => void;
}

/**
 * BYTE-FAITHFUL capture: `runCapture` rides readline, which splits
 * on lone `\r` too and rejoins with `\n` — destroying CR bytes in CRLF file
 * content and fabricating trailing newlines. Diff-carrying git output MUST
 * come through here, or `final/patch.diff` is corrupted at the source and
 * fails `git apply` downstream. Raw buffers, no line splitting, no
 * fabrication; the same spawn machinery (process group, abort, timeout).
 */
export async function runCaptureRaw(
  cmd: string,
  args: string[],
  opts: RawCaptureOptions = {},
): Promise<CaptureResult> {
  const invocation = prepareHarnessCommand(
    cmd,
    args,
    composeSpawnEnv(opts.inheritEnv, opts.env),
    process.platform,
    opts.cwd,
  );
  const env = invocation.env;
  const child = spawn(invocation.binary, invocation.args, {
    cwd: opts.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    ...backgroundSpawnShape(process.platform, opts.windowsConsole),
  });
  if (typeof child.pid === "number") registerChildProcess(child.pid, cmd, runScopeMarkerOf(env));
  child.once("exit", (code, signal) => opts.onExit?.(code, signal));
  let captureChildClosed = false;
  child.once("close", () => {
    captureChildClosed = true;
  });
  child.once("error", () => {
    captureChildClosed = true;
  });
  // Identity-proven-only group signalling for capture children too (round-4 #1
  // residue): a raw `process.kill(-pid)` after the short-lived capture child
  // exited could hit an unrelated recycled group. Group signals go only through
  // the identity-verified handle captured at spawn; without a proven handle we
  // fall back to `child.kill` — the ChildProcess OBJECT is pinned to this exact
  // process by Node, so a direct-child signal can never target a recycled PID.
  // On win32 no handle ever captures; the viable tree kill is taskkill, gated
  // on the child not yet having closed (Node holds the process handle until
  // then, so the PID cannot have been recycled).
  const captureGroupService = opts.processGroups ?? defaultProcessGroupService;
  let captureGroupHandle: ProcessGroupHandle | undefined;
  if (process.platform !== "win32" && typeof child.pid === "number") {
    const capture = captureGroupService.captureLeader(child.pid);
    if (capture.status === "known") captureGroupHandle = capture.handle;
  }
  const killTree = (signal: NodeJS.Signals): void => {
    if (captureGroupHandle) {
      captureGroupService.signal(captureGroupHandle, signal);
      return;
    }
    if (
      (opts.killTreeStrategy ?? resolveKillTreeStrategy()) === "windows_taskkill" &&
      typeof child.pid === "number" &&
      !captureChildClosed
    ) {
      // A FAILED taskkill (typed result) must not strand the capture awaiting
      // `close` forever (wave finding): fall through to the pinned
      // ChildProcess kill so the direct child still dies and close fires.
      const killed = (opts.windowsKillTree ?? killWindowsProcessTree)(child.pid);
      if (killed.status !== "failed") return;
    }
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  };
  child.stdin.on("error", () => {});
  if (opts.input !== undefined) child.stdin.write(opts.input);
  child.stdin.end();

  const buffers = new CaptureBuffers();
  let captureError: unknown;
  let captureFailed = false;
  const failCapture = (error: unknown): void => {
    if (captureFailed) return;
    captureFailed = true;
    captureError = error;
    buffers.clear();
    child.stdout.destroy();
    child.stderr.destroy();
    child.stdin.destroy();
    killTree("SIGKILL");
  };
  const collect = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    if (captureFailed) return;
    opts.onOutput?.();
    try {
      if (stream === "stdout" && opts.stdoutProjection) opts.stdoutProjection.write(chunk);
      else buffers.append(stream, chunk);
    } catch (error) {
      failCapture(error);
    }
  };
  child.stdout.on("error", failCapture);
  child.stderr.on("error", failCapture);
  child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));

  let killTimer: NodeJS.Timeout | undefined;
  const requestCancel = (): void => {
    killTree(opts.cancelSignal ?? "SIGINT");
    const killDelay = opts.cancelKillDelayMs ?? 1_000;
    if (killDelay >= 0 && !killTimer) {
      killTimer = setTimeout(() => killTree("SIGKILL"), killDelay);
      killTimer.unref?.();
    }
  };
  let timer: NodeJS.Timeout | undefined;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => killTree("SIGKILL"), opts.timeoutMs);
  }
  const abortSignal = opts.abortSignal;
  if (abortSignal) {
    if (abortSignal.aborted) requestCancel();
    else abortSignal.addEventListener("abort", requestCancel, { once: true });
  }
  try {
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(
      (resolve, reject) => {
        child.on("error", (err) => {
          if (typeof child.pid === "number") unregisterChildProcess(child.pid);
          reject(err);
        });
        child.on("close", (c, s) => {
          if (typeof child.pid === "number") unregisterChildProcess(child.pid);
          resolve([c, s]);
        });
      },
    );
    if (captureFailed) throw captureError;
    return {
      code,
      signal,
      stdout: opts.stdoutProjection?.end() ?? buffers.text("stdout"),
      stderr: buffers.text("stderr"),
    };
  } finally {
    buffers.clear();
    if (timer) clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    abortSignal?.removeEventListener("abort", requestCancel);
  }
}
