import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { retireChildProcess, unregisterChildProcess } from "./process-registry.js";
import { composeSpawnEnv } from "./env-scope.js";
import { backgroundSpawnShape, prepareHarnessCommand } from "./runtime-env.js";
import { spawnRunOwned } from "./run-spawn.js";
import {
  defaultProbeGroupAlive,
  killWindowsProcessTree,
  resolveKillTreeStrategy,
} from "./process-tree.js";
import { defaultProcessGroupService, type ProcessGroupHandle } from "./process-group.js";
import type { KnownProcessIdentity } from "./process-identity.js";
import type { CaptureResult, SpawnOptions } from "./proc.js";
import { CaptureBuffers } from "./capture-buffer.js";
import { postExitDrain } from "./process-drain.js";

/**
 * What became of a capture child after WE asked it to stop (abort, timeout,
 * watchdog or a failed capture). Absent when nobody asked: an ordinary run is
 * read to its natural close exactly as before.
 *
 * `confirmed` on POSIX needs both facts: the pipes closed by themselves (no
 * drain cut, no bound) AND the direct child's process group answered ESRCH to a
 * signal-0 probe. On win32 there is no group to probe: a natural close is
 * `not_provable`, disclosed as such.
 *
 * `unconfirmed` keeps two cases apart: the direct child already exited but a
 * descendant may survive (`directExited`), or the direct child itself never
 * exited within the bound. `directExit` settles when the direct child's exit is
 * observed, so a private resource only it writes can be removed after it.
 */
export type CaptureTermination =
  | { status: "confirmed"; proof: "group_empty" | "not_provable" }
  | {
      status: "unconfirmed";
      reason: "output_held" | "group_alive" | "group_probe_unavailable" | "direct_child_alive";
      rootPid: number | null;
      /** Process groups the survivors may sit in (the direct child's own group). */
      groups: number[];
      directExited: boolean;
      /** When the direct child's exit was observed (ms since epoch). */
      directExitObservedAt?: number;
      directExit: Promise<void>;
    };

/** The stop outcome a thrown capture failure carried, when one was recorded. */
export function captureTerminationOf(error: unknown): CaptureTermination | undefined {
  if (!error || typeof error !== "object") return undefined;
  return (error as { captureTermination?: CaptureTermination }).captureTermination;
}

/** A caller-owned bounded projection, used only for non-exact previews. */
export interface CaptureProjection {
  write(chunk: Buffer): void;
  end(): string;
}
interface RawCaptureOptions extends SpawnOptions {
  stdoutProjection?: CaptureProjection;
  /** Called for every chunk of output, buffered or projected: the child is working. */
  onOutput?: () => void;
  /** The spawned child's pid and the measured identity its capture read (undefined
   * when that read was unknown), reported once, before any output is read. */
  onCaptured?: (pid: number, identity: KnownProcessIdentity | undefined) => void;
  /** Test seam: the signal-0 group probe (`defaultProbeGroupAlive` in production). */
  probeGroupAlive?: (pgid: number) => boolean;
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
  // The run-owned launch point: a run's marker places the child in its boundary.
  const { child, registration } = spawnRunOwned<ChildProcessWithoutNullStreams>(
    invocation.binary,
    invocation.args,
    {
      cwd: opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      ...backgroundSpawnShape(process.platform, opts.windowsConsole),
    },
    { register: cmd },
  );
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
  // On win32 no handle ever captures; the viable tree kill is taskkill by the
  // numeric PID, sent only while the direct child's exit is not yet observed:
  // after it, that PID may name another process (descendants holding our pipes
  // are then left to the drain and disclosed as unconfirmed).
  const captureGroupService = opts.processGroups ?? defaultProcessGroupService;
  let captureGroupHandle: ProcessGroupHandle | undefined;
  if (process.platform !== "win32" && typeof child.pid === "number") {
    // Reuse the registration's identity read (one helper run per child), unless
    // an injected service reads its own.
    if (captureGroupService === defaultProcessGroupService)
      captureGroupHandle = registration?.processGroup;
    else {
      const capture = captureGroupService.captureLeader(child.pid);
      if (capture.status === "known") captureGroupHandle = capture.handle;
    }
  }
  if (typeof child.pid === "number") opts.onCaptured?.(child.pid, captureGroupHandle?.leader);
  let directExited = false;
  let directExitObservedAt: number | undefined;
  let resolveDirectExit: () => void = () => {};
  const directExit = new Promise<void>((resolve) => {
    resolveDirectExit = resolve;
  });
  child.once("exit", () => {
    directExited = true;
    directExitObservedAt = Date.now();
    resolveDirectExit();
  });
  child.once("error", () => resolveDirectExit());
  const killTree = (signal: NodeJS.Signals): void => {
    if (captureGroupHandle) {
      const sent = captureGroupService.signal(captureGroupHandle, signal);
      // The leader's identity could not be READ (not stale, not missing): the
      // direct child is still reached through its pinned ChildProcess while its
      // exit has not been observed. A stale or missing leader gets no signal.
      if (
        sent.status === "unknown" &&
        sent.reason === "identity_unknown" &&
        !directExited &&
        !captureChildClosed
      ) {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
      return;
    }
    if (
      (opts.killTreeStrategy ?? resolveKillTreeStrategy()) === "windows_taskkill" &&
      typeof child.pid === "number" &&
      !directExited &&
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
  // Only a stop WE asked for arms the bounded post-exit drain and the bound on
  // a direct child that never exits: ordinary output is never cut.
  let stopRequested = false;
  let boundTimer: NodeJS.Timeout | undefined;
  let directChildBound: (() => void) | undefined;
  const exitDrainMs = opts.exitDrainMs ?? 2_000;
  const drain = postExitDrain(child, {
    exitDrainMs,
    exitDrainMaxMs: opts.exitDrainMaxMs ?? Math.max(10 * exitDrainMs, 30_000),
    readerBlocked: () => false,
    stopReader: () => {},
  });
  const stopKillDelay = opts.cancelKillDelayMs ?? 1_000;
  const stop = (signal: NodeJS.Signals): void => {
    if (!stopRequested) {
      stopRequested = true;
      child.once("exit", () => drain.arm());
      if (directExited) drain.arm();
      boundTimer = setTimeout(
        () => directChildBound?.(),
        opts.cancelDeadlineMs ?? Math.max(stopKillDelay, 0) + 10_000,
      );
      boundTimer.unref?.();
    }
    killTree(signal);
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
    stop("SIGKILL");
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
    stop(opts.cancelSignal ?? "SIGINT");
    if (stopKillDelay >= 0 && !killTimer) {
      killTimer = setTimeout(() => killTree("SIGKILL"), stopKillDelay);
      killTimer.unref?.();
    }
  };
  let timer: NodeJS.Timeout | undefined;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => stop("SIGKILL"), opts.timeoutMs);
  }
  const abortSignal = opts.abortSignal;
  if (abortSignal) {
    if (abortSignal.aborted) requestCancel();
    else abortSignal.addEventListener("abort", requestCancel, { once: true });
  }
  let boundHit = false;
  try {
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(
      (resolve, reject) => {
        child.on("error", (err) => {
          unregisterChildProcess(registration);
          reject(err);
        });
        child.on("close", (c, s) => {
          // Pipes have closed. Group settlement may outlast the drain bound;
          // it must not turn this natural close into a cut capture. A drain
          // that already cut the pipes keeps its recorded truncation.
          drain.clear();
          // A natural close may prove its group empty (its basis then retires);
          // after a stop we asked for (its drain and bound included), nothing is
          // concluded from it. Either way only THIS registration is removed.
          if (registration && !stopRequested) retireChildProcess(registration);
          else unregisterChildProcess(registration);
          resolve([c, s]);
        });
        // The direct child did not exit within the bound after our stop: stop
        // observing it (our pipe ends close) and report it unconfirmed instead
        // of waiting on `close` forever. Its exit is still watched.
        directChildBound = () => {
          if (directExited || captureChildClosed) return;
          boundHit = true;
          child.stdout.destroy();
          child.stderr.destroy();
          child.stdin.destroy();
          resolve([null, null]);
        };
      },
    );
    const termination = stopRequested ? await classifyStop() : undefined;
    if (captureFailed) {
      if (termination && captureError && typeof captureError === "object") {
        Object.assign(captureError, { captureTermination: termination });
      }
      throw captureError;
    }
    return {
      // A capture cut after our stop (drain bound or a direct child that never
      // exited) is never a success, whatever the exit status said: no caller,
      // checked or not, reads cut bytes as a complete result.
      code: drain.truncated || boundHit ? null : code,
      signal,
      stdout: opts.stdoutProjection?.end() ?? buffers.text("stdout"),
      stderr: buffers.text("stderr"),
      ...(drain.truncated ? { drain: "truncated" as const } : {}),
      ...(termination ? { termination } : {}),
    };
  } finally {
    buffers.clear();
    drain.clear();
    if (timer) clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    if (boundTimer) clearTimeout(boundTimer);
    abortSignal?.removeEventListener("abort", requestCancel);
  }

  async function classifyStop(): Promise<CaptureTermination> {
    const pgid =
      captureGroupHandle?.pgid ??
      (process.platform !== "win32" && typeof child.pid === "number" ? child.pid : undefined);
    const unconfirmed = (
      reason: Extract<CaptureTermination, { status: "unconfirmed" }>["reason"],
    ): CaptureTermination => ({
      status: "unconfirmed",
      reason,
      rootPid: typeof child.pid === "number" ? child.pid : null,
      groups: pgid === undefined ? [] : [pgid],
      directExited,
      ...(directExitObservedAt !== undefined ? { directExitObservedAt } : {}),
      directExit,
    });
    if (boundHit) return unconfirmed("direct_child_alive");
    if (drain.truncated) return unconfirmed("output_held");
    if (process.platform === "win32") return { status: "confirmed", proof: "not_provable" };
    if (pgid === undefined) return unconfirmed("group_probe_unavailable");
    // Members killed with the group may answer signal 0 for a moment as zombies
    // their parent (or init) has not reaped yet: a short, bounded re-probe.
    const probe = opts.probeGroupAlive ?? defaultProbeGroupAlive;
    for (let attempt = 0; probe(pgid); attempt += 1) {
      if (attempt >= 20) return unconfirmed("group_alive");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { status: "confirmed", proof: "group_empty" };
  }
}
