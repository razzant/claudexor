import { spawn } from "node:child_process";
import { registerChildProcess, unregisterChildProcess } from "./process-registry.js";
import { createInterface } from "node:readline";
import { composeBaseEnv } from "./env-scope.js";

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
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null };

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
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => killTree("SIGKILL"), opts.timeoutMs);
  }

  let killTimer: NodeJS.Timeout | undefined;
  const requestCancel = (): void => {
    if (finished) return;
    killTree(opts.cancelSignal ?? "SIGINT");
    const killDelay = opts.cancelKillDelayMs ?? 1_000;
    if (killDelay >= 0 && !killTimer) {
      // Escalate to SIGKILL of the whole group if the cooperative signal is
      // ignored. NOT unref'd: the escalation must actually fire (a prior
      // unref let an ignoring child outlive the parent). It is cleared on a
      // clean finish below.
      killTimer = setTimeout(() => {
        if (!finished) killTree("SIGKILL");
      }, killDelay);
    }
  };
  const abortSignal = opts.abortSignal;
  if (abortSignal) {
    if (abortSignal.aborted) requestCancel();
    else abortSignal.addEventListener("abort", requestCancel, { once: true });
  }

  try {
    for (;;) {
      if (queue.length > 0) {
        yield queue.shift() as ProcEvent;
        continue;
      }
      if (spawnError) throw spawnError;
      if (finished) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    if (timer) clearTimeout(timer);
    abortSignal?.removeEventListener("abort", requestCancel);
    if (!finished) {
      requestCancel();
    }
    if (finished && killTimer) clearTimeout(killTimer);
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
    else {
      code = ev.code;
      signal = ev.signal;
    }
  }
  return { code, signal, stdout, stderr };
}

/**
 * BYTE-FAITHFUL capture (T3.2#1): `runCapture` rides readline, which splits
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
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
      child.on("error", (err) => {
        if (typeof child.pid === "number") unregisterChildProcess(child.pid);
        reject(err);
      });
      child.on("close", (c, s) => {
        if (typeof child.pid === "number") unregisterChildProcess(child.pid);
        resolve([c, s]);
      });
    });
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

