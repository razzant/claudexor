import type {
  ChildProcess,
  ChildProcessByStdio,
  SpawnOptions,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import { constants } from "node:os";
import { extname, isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import { getSystemErrorMap } from "node:util";
import {
  composeBaseEnv,
  defaultProcessGroupService,
  reapProcessTree,
  registerChildProcess,
  resolveHarnessBinary,
  spawnRunOwned,
  unregisterChildProcess,
  type LiveChildProcess,
  type ProcessGroupHandle,
  type ProcessTreeTerminationOutcome,
} from "@claudexor/core";
import { redactSecrets, wholeCharPrefix } from "@claudexor/util";

export const AGY_PRINT_TIMEOUT_MS = 30_000;
export const AGY_PRINT_STREAM_LIMIT_BYTES = 256 * 1024;
const AGY_PRINT_DRAIN_MS = 200;
const AGY_PRINT_CANCEL_DEADLINE_MS = 5_000;

type EnvMap = Record<string, string | null | undefined>;

export type AgyPrintFailureReason =
  "spawn_failed" | "timed_out" | "aborted" | "output_overflow" | "termination_unconfirmed";

export type AgyPrintCommandResult =
  | {
      kind: "completed";
      code: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
    }
  | {
      kind: "failed";
      reason: AgyPrintFailureReason;
      detail: string;
      stdout: string;
      stderr: string;
    };

export interface AgyPrintCommandOptions {
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  abortSignal?: AbortSignal;
  platform?: NodeJS.Platform;
  /** Bounded cancellation proof seam; production default is 5 seconds. */
  cancelDeadlineMs?: number;
  /** Bounded post-exit pipe drain seam; production default is 200 ms. */
  drainMs?: number;
  /** Deterministic binary-resolution seam; production uses the shared exact resolver. */
  resolveBinary?: (bin: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => string | null;
  /** Deterministic lifecycle seams (the spawn under the run-owned launch point). */
  spawnProcess?: (binary: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  reap?: typeof reapProcessTree;
  /** Deterministic passive-registry seam; production uses the shared registry.
   * `unregister` gets what `register` returned: exactly that registration. */
  processRegistry?: {
    register(pid: number, command: string, scopeMarker?: string): unknown;
    unregister(registration: unknown): void;
  };
}

/** Spawn policy is exported so Windows fixtures can assert no inherited console/stdio. */
export function agyPrintSpawnOptions(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): SpawnOptionsWithoutStdio {
  return {
    env,
    shell: false,
    detached: true,
    windowsHide: platform === "win32",
    // On Windows CREATE_NO_WINDOW still exposes a windowless CONIN$. A real
    // DETACHED_PROCESS prevents console inheritance; the runner immediately
    // closes piped stdin instead of exposing the NUL character device.
  };
}

function composedEnv(patch: EnvMap): NodeJS.ProcessEnv {
  const env = composeBaseEnv("mirror_native");
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function exactBinary(
  bin: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  resolver?: AgyPrintCommandOptions["resolveBinary"],
): string | null {
  const resolved = resolver
    ? resolver(bin, env, platform)
    : resolveHarnessBinary(bin, env, process.execPath, platform);
  if (!resolved || !isAbsolute(resolved)) return null;
  if (platform === "win32" && ![".exe", ".com"].includes(extname(resolved).toLowerCase())) {
    return null;
  }
  return resolved;
}

function boundedBuffer(maxBytes: number, overflow: () => void) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let overflowed = false;
  const markOverflow = (): void => {
    if (overflowed) return;
    overflowed = true;
    overflow();
  };
  return {
    get overflowed(): boolean {
      return overflowed;
    },
    push(chunk: Buffer): void {
      if (chunk.length === 0) return;
      // A prior chunk may have filled the cap exactly. The NEXT byte is still
      // overflow and must cancel; silently returning here used to let an
      // unbounded producer run forever. This also makes a zero-byte cap real.
      if (bytes >= maxBytes) {
        markOverflow();
        return;
      }
      const remaining = maxBytes - bytes;
      if (chunk.length > remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        bytes = maxBytes;
        markOverflow();
        return;
      }
      chunks.push(chunk);
      bytes += chunk.length;
    },
    text(): string {
      return Buffer.concat(chunks, bytes).toString("utf8");
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function boundedDiagnostic(text: string, limit = 300): string {
  return wholeCharPrefix(redactSecrets(text), limit);
}

const KNOWN_STATUSES = new Set(["SUCCESS", "ERROR"]);
/** Node's system error names: the only spawn error codes a detail names. */
const SYSTEM_ERRORS = new Set([
  ...Object.keys(constants.errno),
  ...[...getSystemErrorMap().values()].map(([name]) => name),
]);

/** The probe's observed structural facts. A status is named only when known;
 * a spawn error only by its system code. */
interface AgyFailureFacts {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  status?: unknown;
  error?: unknown;
}

/**
 * One public detail (#709): the cause, the observed exit, signal, status and
 * spawn error code, and at most a phrase this module recognizes. Stream bytes,
 * the JSON envelope and any other vendor words stay in the result's private
 * `stdout`/`stderr`, whatever went wrong (timeout, signal, cut or invalid
 * output, spawn).
 */
function agyFailureDetail(cause: string, facts: AgyFailureFacts = {}, known?: string | null) {
  const observed: string[] = [];
  if (Number.isInteger(facts.code)) observed.push(`exit ${facts.code}`);
  if (facts.signal) observed.push(`signal ${facts.signal}`);
  if (typeof facts.status === "string")
    observed.push(`status ${KNOWN_STATUSES.has(facts.status) ? facts.status : "unrecognized"}`);
  const errno = (facts.error as { code?: unknown } | null | undefined)?.code;
  if (typeof errno === "string" && SYSTEM_ERRORS.has(errno)) observed.push(errno);
  const head = observed.length > 0 ? `${cause} (${observed.join("; ")})` : cause;
  return boundedDiagnostic(known ? `${head}: ${known}` : head);
}

/**
 * Bounded discovery owner for `/model`, `/quota` and the plain `models` listing. The child gets pipe EOF
 * and no controlling terminal: POSIX starts a new session; Windows uses
 * DETACHED_PROCESS because CREATE_NO_WINDOW still exposes a windowless
 * CONIN$. Child exit is completion authority; descendant-held pipes receive
 * only a bounded drain.
 */
export async function runAgyPrintCommand(
  bin: string,
  command: "/model" | "/quota" | "models",
  envPatch: EnvMap,
  options: AgyPrintCommandOptions = {},
): Promise<AgyPrintCommandResult> {
  const platform = options.platform ?? process.platform;
  const env = composedEnv(envPatch);
  const resolved = exactBinary(bin, env, platform, options.resolveBinary);
  if (!resolved) {
    return {
      kind: "failed",
      reason: "spawn_failed",
      detail: `agy executable could not be resolved to an exact ${platform === "win32" ? "Windows image" : "regular executable"}`,
      stdout: "",
      stderr: "",
    };
  }
  if (options.abortSignal?.aborted) {
    return {
      kind: "failed",
      reason: "aborted",
      detail: "agy print probe was aborted",
      stdout: "",
      stderr: "",
    };
  }

  let child: ChildProcessByStdio<Writable, Readable, Readable>;
  let marker: string | undefined;
  try {
    const args = command === "models" ? ["models"] : ["-p", command, "--output-format", "json"];
    // Run-owned: the run's marker in the env places the probe (and its
    // detached group) inside the run's boundary; it is registered below.
    ({ child, marker } = spawnRunOwned<ChildProcessByStdio<Writable, Readable, Readable>>(
      resolved,
      args,
      { ...agyPrintSpawnOptions(platform, env), env, stdio: ["pipe", "pipe", "pipe"] },
      options.spawnProcess ? { spawnFn: options.spawnProcess } : {},
    ));
    // /dev/null is a character device, which agy treats as interactive input.
    // Match ordinary harness runs: pipe EOF, with early-exit EPIPE handled.
    child.stdin.on("error", () => {});
    child.stdin.end();
  } catch (error) {
    return {
      kind: "failed",
      reason: "spawn_failed",
      detail: agyFailureDetail("agy print probe could not be spawned", { error }),
      stdout: "",
      stderr: "",
    };
  }
  const pid = child.pid;
  const processRegistry = options.processRegistry ?? {
    register: registerChildProcess,
    unregister: (registration: unknown) =>
      unregisterChildProcess(registration as LiveChildProcess | null),
  };
  let registered = false;
  let registration: unknown;
  if (typeof pid === "number") {
    registration = processRegistry.register(pid, resolved, marker);
    registered = true;
  }
  const unregisterExitedChild = (): void => {
    if (!registered || typeof pid !== "number") return;
    registered = false;
    processRegistry.unregister(registration);
  };

  let group: ProcessGroupHandle | undefined;
  if (platform !== "win32" && typeof pid === "number") {
    const captured = defaultProcessGroupService.captureLeader(pid);
    if (captured.status === "known") group = captured.handle;
  }
  let requested: "timeout" | "abort" | "overflow" | null = null;
  let reap: Promise<ProcessTreeTerminationOutcome> | null = null;
  type Terminal =
    | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
    | { kind: "error"; error: Error }
    | { kind: "unconfirmed_wait" };
  // The child can exit during the pipe drain or the reaper wait, after the
  // cancellation deadline won the race. Only its exit event supplies these facts.
  let observedExit: Extract<Terminal, { kind: "exit" }> | undefined;
  let cancellationDeadlineTimer: NodeJS.Timeout | undefined;
  let resolveCancellationDeadline!: (terminal: Terminal) => void;
  const cancellationDeadline = new Promise<Terminal>((resolve) => {
    resolveCancellationDeadline = resolve;
  });
  const requestCancel = (why: NonNullable<typeof requested>): void => {
    requested ??= why;
    if (!cancellationDeadlineTimer) {
      // Relative to the FIRST cancellation trigger, not the original process
      // timeout. Abort/overflow at t=0 must settle after one cancel deadline,
      // never after timeout+deadline.
      cancellationDeadlineTimer = setTimeout(
        () => resolveCancellationDeadline({ kind: "unconfirmed_wait" }),
        options.cancelDeadlineMs ?? AGY_PRINT_CANCEL_DEADLINE_MS,
      );
    }
    if (reap || typeof pid !== "number") {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      return;
    }
    reap = (options.reap ?? reapProcessTree)({
      rootPid: pid,
      cooperativeSignal: "SIGKILL",
      graceMs: 0,
      deadlineMs: options.cancelDeadlineMs ?? AGY_PRINT_CANCEL_DEADLINE_MS,
      ...(group ? { seedHandles: [group], rootIdentity: group.leader } : {}),
      platform,
    });
    try {
      child.kill("SIGKILL");
    } catch {
      /* the tree reaper owns the bounded proof */
    }
  };

  const stdout = boundedBuffer(options.maxStdoutBytes ?? AGY_PRINT_STREAM_LIMIT_BYTES, () =>
    requestCancel("overflow"),
  );
  const stderr = boundedBuffer(options.maxStderrBytes ?? AGY_PRINT_STREAM_LIMIT_BYTES, () =>
    requestCancel("overflow"),
  );
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  let stdoutEnded = false;
  let stderrEnded = false;
  const stdoutEnd = new Promise<void>((resolve) =>
    child.stdout.once("end", () => {
      stdoutEnded = true;
      resolve();
    }),
  );
  const stderrEnd = new Promise<void>((resolve) =>
    child.stderr.once("end", () => {
      stderrEnded = true;
      resolve();
    }),
  );
  const terminal = new Promise<Terminal>((resolve) => {
    let settled = false;
    const settle = (value: Terminal) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once("error", (error) => {
      unregisterExitedChild();
      settle({ kind: "error", error });
    });
    child.once("exit", (code, signal) => {
      unregisterExitedChild();
      observedExit = { kind: "exit", code, signal };
      settle(observedExit);
    });
  });

  const timeout = setTimeout(
    () => requestCancel("timeout"),
    options.timeoutMs ?? AGY_PRINT_TIMEOUT_MS,
  );
  timeout.unref();
  const onAbort = () => requestCancel("abort");
  options.abortSignal?.addEventListener("abort", onAbort, { once: true });
  // Abort can race the synchronous spawn/setup window after the pre-spawn
  // check but before listener registration. AbortSignal does not replay that
  // event, so sample it again after the listener is armed.
  if (options.abortSignal?.aborted) requestCancel("abort");

  const outcome = await Promise.race<Terminal>([terminal, cancellationDeadline]);
  clearTimeout(timeout);
  if (cancellationDeadlineTimer) clearTimeout(cancellationDeadlineTimer);
  options.abortSignal?.removeEventListener("abort", onAbort);

  // Do not await descendant-owned EOF indefinitely. Give bytes already in the
  // pipes a small drain window, then detach the readers.
  await Promise.race([
    Promise.all([stdoutEnd, stderrEnd]).then(() => undefined),
    delay(options.drainMs ?? AGY_PRINT_DRAIN_MS),
  ]);
  if (!stdoutEnded) child.stdout.destroy();
  if (!stderrEnded) child.stderr.destroy();

  let termination: ProcessTreeTerminationOutcome | null = null;
  if (reap) {
    try {
      termination = await Promise.race([
        reap,
        delay(options.cancelDeadlineMs ?? AGY_PRINT_CANCEL_DEADLINE_MS).then(
          (): ProcessTreeTerminationOutcome => ({
            state: "unconfirmed",
            survivors: typeof pid === "number" ? [pid] : [],
            unresolved: [],
          }),
        ),
      ]);
    } catch {
      termination = {
        state: "unconfirmed",
        survivors: typeof pid === "number" ? [pid] : [],
        unresolved: [],
      };
    }
  }

  const capturedOut = stdout.text();
  const capturedErr = stderr.text();
  // Which bounded stream overflowed is structure; its bytes are not.
  const overflowed = [stdout.overflowed && "stdout", stderr.overflowed && "stderr"].filter(Boolean);
  const cancelCause = (why: NonNullable<typeof requested>): string =>
    why === "timeout"
      ? `agy did not answer ${command} within ${(options.timeoutMs ?? AGY_PRINT_TIMEOUT_MS) / 1000}s`
      : why === "abort"
        ? "agy print probe was aborted"
        : `agy print output exceeded its bounded stream limit on ${overflowed.join(" and ")}`;
  if (outcome.kind === "error") {
    return {
      kind: "failed",
      reason: "spawn_failed",
      detail: agyFailureDetail("agy print probe could not be spawned", {
        code: observedExit?.code,
        signal: observedExit?.signal,
        error: outcome.error,
      }),
      stdout: capturedOut,
      stderr: capturedErr,
    };
  }
  if (outcome.kind === "unconfirmed_wait" || termination?.state === "unconfirmed") {
    const unconfirmed = "agy print probe termination could not be confirmed";
    return {
      kind: "failed",
      reason: "termination_unconfirmed",
      detail: agyFailureDetail(
        requested ? `${cancelCause(requested)}; ${unconfirmed}` : unconfirmed,
        observedExit,
      ),
      stdout: capturedOut,
      stderr: capturedErr,
    };
  }
  if (requested) {
    const reason: AgyPrintFailureReason =
      requested === "timeout" ? "timed_out" : requested === "abort" ? "aborted" : "output_overflow";
    return {
      kind: "failed",
      reason,
      detail: agyFailureDetail(cancelCause(requested), observedExit),
      stdout: capturedOut,
      stderr: capturedErr,
    };
  }
  return {
    kind: "completed",
    code: outcome.code,
    signal: outcome.signal,
    stdout: capturedOut,
    stderr: capturedErr,
  };
}

export type AgyPrintClassification =
  | { kind: "success"; envelope: Record<string, unknown> }
  | { kind: "unauthenticated"; detail: string }
  | { kind: "probe_failed"; detail: string };

const RECOGNIZED_AUTH_REJECTIONS = [
  "authentication required",
  "not authenticated",
  "login required",
  "credential revoked",
  "credentials revoked",
  "token revoked",
  "token expired",
] as const;
// Also a failed silent-auth network check with a valid token: a recognized
// probe failure, never credential-rejection proof.
const RECOGNIZED_PROBE_FAILURES = ["authentication failed or timed out"] as const;

function vendorError(envelope: Record<string, unknown>): string | null {
  const error = envelope["error"];
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>)["message"];
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return null;
}

/** The recognized phrase the vendor error opens with, never the rest of its words. */
function recognizedPhrase(detail: string | null, phrases: readonly string[]): string | null {
  const normalized = detail?.trim().toLowerCase().replaceAll(/\s+/g, " ") ?? "";
  return (
    phrases.find(
      (prefix) =>
        normalized === prefix ||
        normalized.startsWith(`${prefix}.`) ||
        normalized.startsWith(`${prefix}:`) ||
        normalized.startsWith(`${prefix} `),
    ) ?? null
  );
}

/** Shared exit/envelope/auth classifier for doctor and quota. */
export function classifyAgyPrintResult(result: AgyPrintCommandResult): AgyPrintClassification {
  if (result.kind === "failed") {
    return { kind: "probe_failed", detail: boundedDiagnostic(result.detail) };
  }
  const failed = (
    cause: string,
    facts: AgyFailureFacts = {},
    known?: string | null,
  ): AgyPrintClassification => ({
    kind: "probe_failed",
    detail: agyFailureDetail(cause, { code: result.code, ...facts }, known),
  });
  if (result.signal !== null) return failed(`agy exited by signal ${result.signal}`);
  if (!result.stdout.trim()) return failed("agy returned empty stdout");
  let envelope: unknown;
  try {
    envelope = JSON.parse(result.stdout);
  } catch {
    return failed("agy output was not valid JSON");
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return failed("agy output was not a JSON object");
  }
  const record = envelope as Record<string, unknown>;
  const status = record["status"];
  if (status === "SUCCESS" && result.code === 0) return { kind: "success", envelope: record };
  const error = vendorError(record);
  const rejection = status === "ERROR" ? recognizedPhrase(error, RECOGNIZED_AUTH_REJECTIONS) : null;
  if (rejection) return { kind: "unauthenticated", detail: rejection };
  let cause = "agy returned an unsuccessful status";
  if (status === "SUCCESS") {
    cause = Number.isInteger(result.code)
      ? "agy reported SUCCESS but exited nonzero"
      : "agy reported SUCCESS without an exit code";
  } else if (typeof status !== "string") {
    cause =
      status === undefined ? "agy response had no status" : "agy response had a non-string status";
  }
  return failed(cause, { status }, recognizedPhrase(error, RECOGNIZED_PROBE_FAILURES));
}
