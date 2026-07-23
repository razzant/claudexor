import { spawn } from "node:child_process";
import { registerChildProcess, unregisterChildProcess } from "./process-registry.js";
import { createInterface } from "node:readline";
import { composeBaseEnv } from "./env-scope.js";
import {
  reapProcessTree,
  type ProcessTreeTerminationOutcome,
  type ReapProcessTreeOptions,
} from "./process-tree.js";
import { defaultProcessGroupService, type ProcessGroupHandle } from "./process-group.js";

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | null | undefined>;
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
  /** Hard-kill delay after cancelSignal when the child ignores cooperative stop. */
  cancelKillDelayMs?: number;
  /**
   * Overall bound (ms) on the whole-tree death proof after a cancel. Past it the
   * generator returns and `onTerminationUnconfirmed` fires rather than hanging.
   * Defaults to `cancelKillDelayMs + 4000`.
   */
  cancelDeadlineMs?: number;
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
}

/** Minimal live stdin handle for bidirectional CLI protocols. */
export interface ChildStdin {
  /** Write one line/frame; errors are swallowed (exit carries the outcome). */
  write(data: string): void;
  /** Close stdin (EOF) — the cooperative way to end a streaming session. */
  end(): void;
}

export type ProcEvent =
  | { type: "stdout"; line: string }
  | { type: "stderr"; line: string }
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null }
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
  const env: NodeJS.ProcessEnv = composeBaseEnv(opts.inheritEnv ?? "mirror_native");
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (value === undefined || value === null) delete env[key];
    else env[key] = value;
  }
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    // Put the child in its own process group so we can signal the WHOLE tree.
    // Harnesses spawn grandchildren (shell tools, MCP servers); without this a
    // cancel/timeout signals only the direct child and grandchildren leak,
    // keep writing to the worktree, or hang the run forever.
    detached: true,
  });
  if (typeof child.pid === "number") registerChildProcess(child.pid, cmd);

  // Seed the DIRECT group identity NOW, while the child is provably alive and is
  // its own group leader (detached => pgid == pid). If the direct child later
  // exits before the cancel-time tree snapshot but a grandchild survives in the
  // SAME pgid, that pgid is no longer reachable by ppid BFS (its chain to the
  // root is gone) and would never be enumerated — so reapProcessTree could
  // falsely report `confirmed` (round-2 #3). A seeded handle keeps the direct
  // group tracked (and raw-probeable) until it is proven empty.
  let directGroupHandle: ProcessGroupHandle | undefined;
  if (typeof child.pid === "number") {
    const capture = defaultProcessGroupService.captureLeader(child.pid);
    if (capture.status === "known") directGroupHandle = capture.handle;
  }

  // Signal the child's process GROUP (negative pid) so grandchildren die too;
  // fall back to the direct child if the group is already gone.
  const killTree = (signal: NodeJS.Signals): void => {
    try {
      if (typeof child.pid === "number") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
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
      end: () => {
        try {
          child.stdin.end();
        } catch {
          /* already closed */
        }
      },
    });
  } else {
    child.stdin.end();
  }

  const queue: ProcEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let spawnError: Error | null = null;

  const push = (e: ProcEvent): void => {
    queue.push(e);
    if (wake) {
      wake();
      wake = null;
    }
  };

  const rlOut = createInterface({ input: child.stdout });
  const rlErr = createInterface({ input: child.stderr });
  rlOut.on("line", (line) => push({ type: "stdout", line }));
  rlErr.on("line", (line) => push({ type: "stderr", line }));

  child.on("error", (err) => {
    if (typeof child.pid === "number") unregisterChildProcess(child.pid);
    spawnError = err;
    finished = true;
    if (wake) {
      wake();
      wake = null;
    }
  });
  child.on("close", (code, signal) => {
    if (typeof child.pid === "number") unregisterChildProcess(child.pid);
    push({ type: "exit", code, signal });
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
        // dead even if the direct child's ppid chain is already gone.
        ...(directGroupHandle ? { seedHandles: [directGroupHandle] } : {}),
      });
    }
    // Direct-group belt: a raw cooperative nudge + SIGKILL escalation to the
    // immediate child group, covering the case where identity capture raced.
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
    for (;;) {
      if (queue.length > 0) {
        yield queue.shift() as ProcEvent;
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
    if (timer) clearTimeout(timer);
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
    rlOut.close();
    rlErr.close();
  }
}

export interface CaptureResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Label which stream said what in a compact one-line detail (truncated probe
 * errors must stay attributable to stderr vs stdout). Null when both are empty.
 *
 * `transform` (e.g. a secret redactor) runs on each FULL stream BEFORE
 * truncation — truncating first could split a token and leave a partial
 * secret the redactor no longer recognizes. Each present stream then gets an
 * equal code-point budget (never splitting a surrogate pair), so one noisy
 * stream cannot evict the other from the detail.
 */
export function labelStreams(
  stderr: string,
  stdout: string,
  opts: { maxLen?: number; transform?: (s: string) => string } = {},
): string | null {
  const maxLen = opts.maxLen ?? 300;
  const transform = opts.transform ?? ((s: string): string => s);
  const streams: Array<[string, string]> = [
    ["stderr", stderr],
    ["stdout", stdout],
  ].filter((entry): entry is [string, string] => entry[1].trim() !== "");
  if (streams.length === 0) return null;
  const budget = Math.max(1, Math.floor(maxLen / streams.length));
  const parts = streams.map(([label, raw]) => {
    const clean = [...transform(raw.trim())].slice(0, budget).join("");
    return `${label}: ${clean}`;
  });
  return parts.join(" | ");
}

/** Run a process to completion, capturing stdout/stderr. Throws on spawn error. */
export async function runCapture(
  cmd: string,
  args: string[],
  opts: SpawnOptions = {},
): Promise<CaptureResult> {
  let stdout = "";
  let stderr = "";
  let code: number | null = null;
  let signal: NodeJS.Signals | null = null;
  for await (const ev of spawnProcess(cmd, args, opts)) {
    if (ev.type === "stdout") stdout += ev.line + "\n";
    else if (ev.type === "stderr") stderr += ev.line + "\n";
    else if (ev.type === "exit") {
      code = ev.code;
      signal = ev.signal;
    }
    // termination_unconfirmed is a disclosure-only event; runCapture callers do
    // not carry cancellation death-proof state (they run to completion).
  }
  return { code, signal, stdout, stderr };
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
  opts: SpawnOptions = {},
): Promise<CaptureResult> {
  const env: NodeJS.ProcessEnv = composeBaseEnv(opts.inheritEnv ?? "mirror_native");
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (value === undefined || value === null) delete env[key];
    else env[key] = value;
  }
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  if (typeof child.pid === "number") registerChildProcess(child.pid, cmd);
  const killTree = (signal: NodeJS.Signals): void => {
    try {
      if (typeof child.pid === "number") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  };
  child.stdin.on("error", () => {});
  if (opts.input !== undefined) child.stdin.write(opts.input);
  child.stdin.end();

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
  child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));

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
    return {
      code,
      signal,
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    abortSignal?.removeEventListener("abort", requestCancel);
  }
}

export interface OrphanExitOptions {
  /** Poll cadence for the parent-death check (default 5s, unref'd). */
  intervalMs?: number;
  getppid?: () => number;
  exit?: (code: number) => void;
  /** Disclosed once, right before exiting (e.g. a stderr note). */
  onOrphaned?: () => void;
}

/**
 * Orphaned-bridge watchdog (W3.5): a stdio bridge (mcp/acp serve) whose HOST
 * died without the pipe closing — grandchildren holding inherited fds, a
 * SIGKILLed host — reparents to pid 1 and would otherwise idle forever with
 * nobody on the other end. Polling ppid catches exactly that class; the
 * interval is unref'd so the watchdog never keeps a clean bridge alive.
 */
export function armOrphanExit(options: OrphanExitOptions = {}): { stop: () => void } {
  const getppid = options.getppid ?? (() => process.ppid);
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const timer = setInterval(() => {
    if (getppid() !== 1) return;
    try {
      options.onOrphaned?.();
    } catch {
      /* the disclosure must not block the exit */
    }
    exit(0);
  }, options.intervalMs ?? 5_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
