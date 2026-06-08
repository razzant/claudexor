import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | null | undefined>;
  input?: string;
  timeoutMs?: number;
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
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (value === undefined || value === null) delete env[key];
    else env[key] = value;
  }
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (opts.input !== undefined) {
    child.stdin.write(opts.input);
  }
  child.stdin.end();

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
    spawnError = err;
    finished = true;
    if (wake) {
      wake();
      wake = null;
    }
  });
  child.on("close", (code, signal) => {
    push({ type: "exit", code, signal });
    finished = true;
    if (wake) {
      wake();
      wake = null;
    }
  });

  let timer: NodeJS.Timeout | undefined;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, opts.timeoutMs);
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

/** True if a command is runnable (resolves a --version or --help without ENOENT). */
export async function commandAvailable(cmd: string, versionArgs: string[] = ["--version"]): Promise<boolean> {
  try {
    await runCapture(cmd, versionArgs, { timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
}
