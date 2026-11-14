import { performance } from "node:perf_hooks";
import { recordChildLaunch } from "@claudexor/util";
import { spawn } from "node:child_process";
import { registerChildProcess, unregisterChildProcess } from "./process-registry.js";
import { readProcessLines, type ProcessStreamLimits } from "./process-lines.js";
import { composeSpawnEnv } from "./env-scope.js";
import { postExitDrain } from "./process-drain.js";
import { runScopeMarkerOf } from "./process-scope.js";
import {
  backgroundSpawnShape,
  prepareHarnessCommand,
  type WindowsConsolePolicy,
} from "./runtime-env.js";
import {
  reapProcessTree,
  type KillTreeStrategy,
  type WindowsKillTreeResult,
  type ProcessTreeTerminationOutcome,
  type ReapProcessTreeOptions,
} from "./process-tree.js";
import {
  defaultProcessGroupService,
  type ProcessGroupHandle,
  type ProcessGroupService,
} from "./process-group.js";

export interface SpawnOptions {
  /** JSON-RPC/NDJSON stdout uses LF delimiters; Unicode separators are payload. */
  stdoutFraming?: "lf";
  /** Bounded protocol frames/queue and independently drained stderr. */
  streamLimits?: ProcessStreamLimits;
  cwd?: string;
  env?: Record<string, string | null | undefined>;
  /** Windows console of the child (`runtime-env.ts`); default `hidden`. Ignored on POSIX. */
  windowsConsole?: WindowsConsolePolicy;
  /**
   * Base env composition for the child: `mirror_native` (default) inherits the
   * parent env; `clean` starts from a minimal allowlist (agent env isolation).
   * `env` patches + scrub are applied on top either way.
   */
  inheritEnv?: "mirror_native" | "clean";
  input?: string;
  timeoutMs?: number;
  /** Signal sent when the consumer closes the stream before process exit. */
  cancelSignal?: NodeJS.Signals;
  /** Test seams: prove the win32 kill-fallback without a Windows host (the
   * fsyncDirectoryHandle precedent). Production always uses the defaults. */
  killTreeStrategy?: KillTreeStrategy;
  windowsKillTree?: (pid: number) => WindowsKillTreeResult;
  /** Hard-kill delay after cancelSignal when the child ignores cooperative stop. */
  cancelKillDelayMs?: number;
  /**
   * Overall bound (ms) on the whole-tree death proof after a cancel. Past it the
   * generator returns and `onTerminationUnconfirmed` fires rather than hanging.
   * Defaults to `cancelKillDelayMs + 4000`.
   */
  cancelDeadlineMs?: number;
  /**
   * Bounded post-exit output drain (ms, `process-drain.ts`): once no output has
   * arrived for this long AFTER the direct child exited (a descendant kept the
   * pipe open), the parent-side streams are force-closed so capture completes
   * (exit event `drain: "truncated"`). 0 disables (wait for a real `close`). Default 2000.
   */
  exitDrainMs?: number;
  /**
   * Absolute bound (ms) on the post-exit drain that ongoing descendant writes
   * cannot renew. Default `max(10 * exitDrainMs, 30000)`.
   */
  exitDrainMaxMs?: number;
  /**
   * Fail-closed disclosure (QA-027) for a consumer that broke the stream EARLY
   * (it is no longer iterating, so the typed `termination_unconfirmed` event
   * cannot be delivered): called once when a proven-alive descendant group
   * survives the bounded TERM->KILL escalation. An actively-iterating consumer
   * receives the typed `termination_unconfirmed` ProcEvent instead — the primary,
   * non-optional disclosure channel.
   */
  onTerminationUnconfirmed?: (info: {
    rootPid: number;
    survivors: number[];
    unresolved: Array<{ pgid: number; reason: string }>;
  }) => void;
  /**
   * Injection seam for the whole-tree death proof (deterministic tests of the
   * termination_unconfirmed disclosure). Defaults to the real `reapProcessTree`.
   * Production callers never set this.
   */
  reap?: (opts: ReapProcessTreeOptions) => Promise<ProcessTreeTerminationOutcome>;
  /**
   * Injection seam for the identity-proven process-group service used by the
   * direct-group cancel belt (deterministic tests of unknown-capture / stale-
   * identity refusal). Defaults to the shared `defaultProcessGroupService`.
   * Production callers never set this.
   */
  processGroups?: ProcessGroupService;
  /** Runtime abort signal for active daemon/orchestrator cancellation. */
  abortSignal?: AbortSignal;
  /**
   * Keep stdin open after writing `input` (bidirectional protocols such as
   * Claude's stream-json control channel). The caller receives a writer via
   * `onSpawn` and OWNS closing it; the child usually exits on stdin EOF.
   */
  keepStdinOpen?: boolean;
  /** Called once after spawn with a live stdin handle (see keepStdinOpen). */
  onSpawn?: (io: ChildStdin) => void;
  /** Native child exit observed before stdio close/drain; does not complete capture. */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

/** What became of one frame given to `ChildStdin.send`. `written` means the OS
 * pipe accepted every byte; it does not prove that the process read them. */
export type ChildStdinSend =
  | { outcome: "written" }
  | { outcome: "not_written"; reason: "exited" | "ended" | "failed"; error?: string };

/** Minimal live stdin handle for bidirectional CLI protocols. */
export interface ChildStdin {
  /** Write one line/frame; errors are swallowed (exit carries the outcome). */
  write(data: string): void;
  /**
   * Write one frame and report what became of it, for a caller that must know
   * whether a response could reach the process (`spawnProcess` provides it).
   * Nothing is written once the direct child has exited (`exited`: a
   * descendant may still hold the pipes, so `closed` can settle much later) or
   * stdin was ended (`ended`); a failed write reports its error (`failed`).
   * Never throws or rejects.
   */
  send?(data: string): Promise<ChildStdinSend>;
  /** Close stdin (EOF) — the cooperative way to end a streaming session. */
  end(): void;
  /** Settles once the child process closes or fails to spawn. Session handlers
   * race blocking protocol work against this instead of orphaning a wait after
   * the native process can no longer answer. */
  closed: Promise<void>;
}

export type ProcEvent =
  | { type: "launch_advisory"; detail: string }
  | { type: "stdout"; line: string; wire?: string }
  | { type: "stderr"; line: string }
  /**
   * `drain: "truncated"`: the direct child exited but a descendant kept its
   * stdout/stderr open, and the bounded post-exit drain force-closed them so the
   * run reaches its terminal barrier. The output captured up to then is complete.
   */
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null; drain?: "truncated" }
  /**
   * QA-027 fail-closed death-proof disclosure: the process was cancelled and the
   * whole-tree reap could NOT confirm death — a descendant group is proven-alive
   * (`survivors`) or its leader identity was unreadable (`unresolved`). Emitted
   * once, AFTER the terminal `exit`, so an actively-iterating consumer terminalizes
   * over a typed unconfirmed-death fact instead of a silent clean cancel.
   */
  | {
      type: "termination_unconfirmed";
      rootPid: number;
      survivors: number[];
      unresolved: Array<{ pgid: number; reason: string }>;
    };

/**
 * Spawn a process and stream stdout/stderr lines as they arrive, ending with an
 * `exit` event. Throws (rejects the iterator) if the binary cannot be spawned
 * (e.g. ENOENT) so callers can detect an unavailable harness.
 */
export async function* spawnProcess(
  cmd: string,
  args: string[],
  opts: SpawnOptions = {},
): AsyncGenerator<ProcEvent> {
  const launchStarted = performance.now();
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
    // Fully piped background children; interactive login/attach own their terminal policy.
    // POSIX: the child leads its own process group so a cancel/timeout signals the
    // WHOLE tree (harnesses start shell tools and MCP servers that would otherwise
    // leak, keep writing to the worktree, or hang the run). Windows: an invisible
    // console the child's console programs inherit; the tree kill is taskkill /T.
    ...backgroundSpawnShape(process.platform, opts.windowsConsole),
  });
  const registration =
    typeof child.pid === "number"
      ? registerChildProcess(child.pid, cmd, runScopeMarkerOf(env))
      : undefined;
  // Bounded post-exit output drain (#449 item 2): see `process-drain.ts`.
  // The reader is told to stop (never to discard) before the pipes are ended.
  const drain = postExitDrain(child, {
    exitDrainMs: opts.exitDrainMs ?? 2_000,
    exitDrainMaxMs: opts.exitDrainMaxMs ?? Math.max(10 * (opts.exitDrainMs ?? 2_000), 30_000),
    readerBlocked: () => capacity !== undefined,
    stopReader: () => lines.stop(),
  });
  child.once("exit", (code, signal) => {
    opts.onExit?.(code, signal);
    drain.arm();
  });

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  child.once("error", () => resolveClosed());
  child.once("close", () => resolveClosed());

  // Seed the DIRECT group identity NOW, while the child is provably alive and is
  // its own group leader (POSIX detached => pgid == pid). If the direct child later
  // exits before the cancel-time tree snapshot but a grandchild survives in the
  // SAME pgid, that pgid is no longer reachable by ppid BFS (its chain to the
  // root is gone) and would never be enumerated — so reapProcessTree could
  // falsely report `confirmed` (round-2 #3). A seeded handle keeps the direct
  // group tracked (and raw-probeable) until it is proven empty.
  const groupService = opts.processGroups ?? defaultProcessGroupService;
  let directGroupHandle: ProcessGroupHandle | undefined;
  if (process.platform !== "win32" && typeof child.pid === "number") {
    // The registration already read this child's identity through the default
    // service: one identity-helper run per child. An injected service reads its own.
    const capture =
      registration && groupService === defaultProcessGroupService
        ? registration
        : groupService.captureLeader(child.pid);
    if (capture.status === "known") directGroupHandle = capture.handle;
  }

  recordChildLaunch(performance.now() - launchStarted);

  // Identity-proven-only direct-group belt (round-4 #1). A raw
  // `process.kill(-child.pid, signal)` — including the delayed SIGKILL fallback —
  // could signal an UNRELATED group if the child exited and its PID/PGID was
  // reused before the escalation fires. So we signal ONLY through the captured,
  // identity-verified handle: `ProcessGroupService.signal` re-checks the recorded
  // leader identity and refuses (never signalling) when the group is gone,
  // recycled, or unreadable. When capture never succeeded (no proven handle) we
  // do not signal at all — the whole-tree reap remains the fail-closed disclosure
  // channel (it reports `unconfirmed` for a group it cannot identity-prove).
  // On win32 there is never a proven handle (no POSIX identity source); the
  // whole tree kill lives in the reap `requestCancel` always kicks first
  // (taskkill /T /F inside reapProcessTree's windows leg).
  const killTree = (signal: NodeJS.Signals): void => {
    if (!directGroupHandle) return;
    groupService.signal(directGroupHandle, signal);
  };

  // A child can exit before/while stdin is written (e.g. a failing `git apply`).
  // Without a handler the resulting EPIPE becomes an unhandled 'error' event and
  // can crash the host process; the exit event already carries the real outcome.
  child.stdin.on("error", () => {});
  if (opts.input !== undefined) {
    child.stdin.write(opts.input);
  }
  if (opts.keepStdinOpen) {
    opts.onSpawn?.({
      write: (data: string) => {
        try {
          child.stdin.write(data);
        } catch {
          /* child already gone; exit event carries the outcome */
        }
      },
      send: (data: string) => {
        if (child.exitCode !== null || child.signalCode !== null)
          return Promise.resolve({ outcome: "not_written", reason: "exited" });
        if (child.stdin.writableEnded || child.stdin.destroyed)
          return Promise.resolve({ outcome: "not_written", reason: "ended" });
        return new Promise<ChildStdinSend>((resolve) => {
          const failed = (error: unknown): void =>
            resolve({
              outcome: "not_written",
              reason: "failed",
              error: error instanceof Error ? error.message : String(error),
            });
          try {
            child.stdin.write(data, (error) =>
              error ? failed(error) : resolve({ outcome: "written" }),
            );
          } catch (error) {
            failed(error);
          }
        });
      },
      end: () => {
        try {
          child.stdin.end();
        } catch {
          /* already closed */
        }
      },
      closed,
    });
  } else {
    child.stdin.end();
  }

  const queue: ProcEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let spawnError: Error | null = null;
  let capacity: (() => void) | undefined;

  const push = (e: ProcEvent): void => {
    queue.push(e);
    if (wake) {
      wake();
      wake = null;
    }
  };

  const lines = readProcessLines(
    child,
    push,
    async () => {
      if (opts.streamLimits && queue.length >= opts.streamLimits.queuedFrames) {
        await new Promise<void>((resolve) => {
          capacity = resolve;
        });
      }
    },
    (error) => {
      spawnError = error;
      requestCancel();
    },
    opts.streamLimits,
    opts.stdoutFraming,
  );

  child.on("error", (err) => {
    if (typeof child.pid === "number") unregisterChildProcess(child.pid);
    drain.clear();
    spawnError = err;
    finished = true;
    if (wake) {
      wake();
      wake = null;
    }
  });
  child.on("close", async (code, signal) => {
    if (typeof child.pid === "number") unregisterChildProcess(child.pid);
    drain.clear();
    await lines.drained;
    push({
      type: "exit",
      code,
      signal,
      ...(drain.truncated ? { drain: "truncated" as const } : {}),
    });
    finished = true;
    if (wake) {
      wake();
      wake = null;
    }
  });

  let timer: NodeJS.Timeout | undefined;

  let killTimer: NodeJS.Timeout | undefined;
  // The whole-tree death proof (QA-027). A vendor tool can setsid into a NEW
  // process group and reparent to pid 1; group-killing only the direct child
  // leaks it. On the FIRST cancel we snapshot the tree while its ppid chain is
  // still intact, then reap every owned group (TERM -> bounded KILL) with the
  // identity-proven ProcessGroupService and probe to death. The generator's
  // finally awaits this so an AWAITING consumer only observes completion once
  // the tree is dead (or bounded-unconfirmed).
  let cancelReap: Promise<ProcessTreeTerminationOutcome> | null = null;
  const requestCancel = (coopSignal?: NodeJS.Signals, graceOverrideMs?: number): void => {
    const coop = coopSignal ?? opts.cancelSignal ?? "SIGINT";
    const killDelay = graceOverrideMs ?? opts.cancelKillDelayMs ?? 1_000;
    // Kick the identity-proven whole-tree reap FIRST: reapProcessTree captures
    // the process tree AND cooperatively signals every owned group
    // synchronously (before its first await). Snapshotting before the direct
    // group is torn down is what catches an ESCAPED descendant group while its
    // ppid chain is still intact — the QA-027 orphan.
    if (!cancelReap && typeof child.pid === "number") {
      cancelReap = (opts.reap ?? reapProcessTree)({
        rootPid: child.pid,
        cooperativeSignal: coop,
        graceMs: killDelay,
        deadlineMs: opts.cancelDeadlineMs ?? killDelay + 4_000,
        // Seed the direct group so a surviving same-pgid grandchild is proven
        // dead even if the direct child's ppid chain is already gone, and bind
        // the reap to the root's original identity so a mid-deadline PID reuse
        // cannot enroll an unrelated replacement tree (round-4 #2).
        ...(directGroupHandle
          ? { seedHandles: [directGroupHandle], rootIdentity: directGroupHandle.leader }
          : {}),
      });
    }
    // Direct-group belt: an identity-verified cooperative nudge + SIGKILL
    // escalation to the immediate child group (no proven handle = no signal;
    // the whole-tree reap stays the fail-closed disclosure channel).
    killTree(coop);
    if (killDelay >= 0 && !killTimer) {
      // NOT unref'd: the escalation must actually fire (a prior unref let an
      // ignoring child outlive the parent).
      killTimer = setTimeout(() => {
        if (!finished) killTree("SIGKILL");
      }, killDelay);
    }
  };
  // A wall-clock timeout is a hard stop: reap the whole tree immediately
  // (SIGKILL, no grace) and still prove it dead.
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => requestCancel("SIGKILL", 0), opts.timeoutMs);
  }
  const onAbort = (): void => requestCancel();
  const abortSignal = opts.abortSignal;
  if (abortSignal) {
    if (abortSignal.aborted) requestCancel();
    else abortSignal.addEventListener("abort", onAbort, { once: true });
  }

  // Memoized whole-tree death proof: `cancelReap` is assigned inside the
  // requestCancel closure, so narrow it through an explicitly-typed read (CFA
  // otherwise collapses it to null). Awaited exactly once — from the normal
  // completion path (so the typed event can be yielded to an active consumer) or
  // the early-break finally (consumer gone → the optional callback fallback).
  let reapSettled = false;
  let reapOutcome: ProcessTreeTerminationOutcome | null = null;
  let disclosedUnconfirmed = false;
  const settleReap = async (): Promise<ProcessTreeTerminationOutcome | null> => {
    if (reapSettled) return reapOutcome;
    reapSettled = true;
    const pendingReap = cancelReap as Promise<ProcessTreeTerminationOutcome> | null;
    if (pendingReap) {
      try {
        reapOutcome = await pendingReap;
      } catch {
        /* the reap is best-effort death proof; never throw out of cleanup */
      }
    }
    return reapOutcome;
  };

  try {
    if (invocation.resolution.advisory)
      yield { type: "launch_advisory", detail: invocation.resolution.advisory };
    for (;;) {
      if (queue.length > 0) {
        const event = queue.shift() as ProcEvent;
        capacity?.();
        capacity = undefined;
        yield event;
        continue;
      }
      if (spawnError) throw spawnError;
      if (finished) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    // Death proof (QA-027): the process closed, but an ESCAPED descendant group
    // may survive. Await the whole-tree reap and DISCLOSE an unconfirmed survival
    // as a typed event on the active stream (not merely the optional callback),
    // so a consumer that terminalizes on our completion cannot silently do so over
    // a proven-alive survivor or an unreadable-identity group.
    if (killTimer) clearTimeout(killTimer);
    const outcome = await settleReap();
    if (outcome?.state === "unconfirmed" && typeof child.pid === "number") {
      disclosedUnconfirmed = true;
      yield {
        type: "termination_unconfirmed",
        rootPid: child.pid,
        survivors: outcome.survivors,
        unresolved: outcome.unresolved,
      };
    }
  } finally {
    lines.close();
    capacity?.();
    if (timer) clearTimeout(timer);
    drain.clear();
    abortSignal?.removeEventListener("abort", onAbort);
    if (!finished) {
      // Consumer broke early (no abort/timeout): cancel and reap the tree.
      requestCancel();
    }
    if (finished && killTimer) clearTimeout(killTimer);
    // Early-break path: the consumer is no longer iterating, so the typed
    // termination_unconfirmed event above could not be delivered — fall back to
    // the optional disclosure callback (only when it was not already yielded).
    const outcome = await settleReap();
    if (
      !disclosedUnconfirmed &&
      outcome?.state === "unconfirmed" &&
      typeof child.pid === "number"
    ) {
      opts.onTerminationUnconfirmed?.({
        rootPid: child.pid,
        survivors: outcome.survivors,
        unresolved: outcome.unresolved,
      });
    }
  }
}

export interface CaptureResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** The exit event's forced post-exit drain (`runCapture` only): later output was not read. */
  drain?: "truncated";
}

export { labelStreams } from "./process-output.js";

/** Run a process to completion, capturing stdout/stderr. Throws on spawn error. */
export async function runCapture(
  cmd: string,
  args: string[],
  opts: SpawnOptions = {},
): Promise<CaptureResult> {
  let stdout = "";
  let stderr = "";
  let exit: Pick<CaptureResult, "code" | "signal" | "drain"> = { code: null, signal: null };
  for await (const ev of spawnProcess(cmd, args, opts)) {
    if (ev.type === "stdout") stdout += ev.line + "\n";
    else if (ev.type === "stderr") stderr += ev.line + "\n";
    else if (ev.type === "exit") exit = ev;
    // termination_unconfirmed is a disclosure-only event; runCapture callers do
    // not carry cancellation death-proof state (they run to completion).
  }
  const { code, signal, drain } = exit;
  return { code, signal, stdout, stderr, ...(drain ? { drain } : {}) };
}

export { runCaptureRaw, type CaptureProjection } from "./capture-raw.js";
export {
  CaptureOutputExceeded,
  CAPTURE_BUFFER_BUDGET_BYTES,
  assertCaptureComplete,
} from "./capture-buffer.js";

export { armOrphanExit } from "./process-lifeline.js";
