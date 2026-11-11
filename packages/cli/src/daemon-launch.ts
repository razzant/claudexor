/** Caller-visible daemon launch evidence before root authority exists. */
import { spawn, type ChildProcess } from "node:child_process";
import { lstatSync } from "node:fs";
import type { Readable } from "node:stream";
import { logPath } from "@claudexor/daemon";
import { withoutRunScopeMarkers } from "@claudexor/core";
import {
  daemonHeapLaunch,
  safeProblemContext,
  safeProblemMessage,
  safeProblemRequiredActions,
} from "@claudexor/util";
import { CliError } from "./cli-error.js";

export const DAEMON_LAUNCH_SOURCE_ENV = "CLAUDEXOR_DAEMON_LAUNCH_SOURCE";

export const CLI_DAEMON_LAUNCH_SOURCES = {
  ensureDaemon: "cli_ensure_daemon",
  explicitStart: "cli_explicit_start",
} as const;

export type CliDaemonLaunchSource =
  (typeof CLI_DAEMON_LAUNCH_SOURCES)[keyof typeof CLI_DAEMON_LAUNCH_SOURCES];

const DAEMON_LAUNCH_STDERR_RAW_LIMIT_BYTES = 64 * 1_024;

export type DaemonLaunchStderrEvidence =
  | {
      kind: "empty";
    }
  | {
      kind: "retained";
      byteLength: number;
      message: string;
    }
  | {
      kind: "oversize_discarded";
      observedBytes: number;
      limitBytes: number;
    };

export type DaemonLaunchFailure =
  | {
      kind: "spawn_error";
      message: string;
      code?: string;
    }
  | {
      kind: "preclaim_exit";
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      stderr: DaemonLaunchStderrEvidence;
    }
  | {
      kind: "startup_timeout";
      timeoutMs: number;
      stderr: DaemonLaunchStderrEvidence;
    };

export interface DetachedDaemonLaunch {
  readonly pid: number | null;
  failure(): DaemonLaunchFailure | null;
  waitForFailure(): Promise<DaemonLaunchFailure>;
  markReady(): void;
  callerError(stage: string, timeoutMs: number): CliError;
}

export interface LaunchDetachedDaemonOptions {
  entryPath: string;
  launchSource: CliDaemonLaunchSource;
  env?: NodeJS.ProcessEnv;
  nodePath?: string;
}

export function daemonLaunchEnvironment(
  source: NodeJS.ProcessEnv,
  launchSource: CliDaemonLaunchSource,
): NodeJS.ProcessEnv {
  // Inheritance is not a lifetime transfer: a daemon is a longer-lived
  // custodian, so a run marker inherited from a harness child that
  // autostarts it is shed here (an enclosing host's installation marker is kept).
  return { ...withoutRunScopeMarkers(source), [DAEMON_LAUNCH_SOURCE_ENV]: launchSource };
}

function missingEntryError(entryPath: string, reason: unknown): CliError {
  return new CliError(
    "operational",
    `cannot start the daemon: the selected entry is unavailable (${safeProblemMessage(reason)})`,
    {
      code: "daemon_entry_missing",
      retryable: false,
      requiredActions: [
        "Reinstall Claudexor or rebuild the matching runtime before retrying.",
        "Use an eligible fixed runtime; do not fall back to an older daemon for this data root.",
      ],
      context: safeProblemContext({ entryPath }),
    },
  );
}

function proveEntry(entryPath: string): void {
  try {
    const stat = lstatSync(entryPath);
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw missingEntryError(entryPath, "entry is not a file");
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw missingEntryError(entryPath, error);
  }
}

function canonicalLogRemedy(): string {
  try {
    return `Run \`claudexor daemon logs\` for the canonical post-authority log at ${logPath()}; a pre-authority failure may have no log record.`;
  } catch {
    return "Run `claudexor daemon logs` for the canonical post-authority log; a pre-authority failure may have no log record.";
  }
}

export interface PreAuthorityStderrCapture {
  evidence(): DaemonLaunchStderrEvidence;
  destroyAndDiscard(): void;
}

export function capturePreAuthorityStderr(stream: Readable | null): PreAuthorityStderrCapture {
  let chunks: Buffer[] = [];
  let retainedBytes = 0;
  let observedBytes = 0;
  let oversize = false;
  let discarded = false;

  const onData = (chunk: Buffer | string): void => {
    if (discarded) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    observedBytes += bytes.length;
    if (oversize) return;
    if (observedBytes > DAEMON_LAUNCH_STDERR_RAW_LIMIT_BYTES) {
      oversize = true;
      chunks = [];
      retainedBytes = 0;
      return;
    }
    chunks.push(Buffer.from(bytes));
    retainedBytes += bytes.length;
  };
  stream?.on("data", onData);

  return {
    evidence: () => {
      if (oversize) {
        return {
          kind: "oversize_discarded",
          observedBytes,
          limitBytes: DAEMON_LAUNCH_STDERR_RAW_LIMIT_BYTES,
        };
      }
      if (retainedBytes === 0) return { kind: "empty" };
      const raw = Buffer.concat(chunks, retainedBytes).toString("utf8");
      return {
        kind: "retained",
        byteLength: retainedBytes,
        message: safeProblemMessage(raw),
      };
    },
    destroyAndDiscard: () => {
      if (discarded) return;
      discarded = true;
      chunks = [];
      retainedBytes = 0;
      stream?.off("data", onData);
      stream?.destroy();
    },
  };
}

function stderrMessage(evidence: DaemonLaunchStderrEvidence): string {
  switch (evidence.kind) {
    case "empty":
      return "; pre-authority stderr: empty";
    case "retained":
      return `; pre-authority stderr (retained): ${evidence.message}`;
    case "oversize_discarded":
      return `; pre-authority stderr: oversize_discarded after ${evidence.observedBytes} bytes (limit ${evidence.limitBytes})`;
  }
}

function failureMessage(failure: DaemonLaunchFailure): string {
  switch (failure.kind) {
    case "spawn_error":
      return `daemon launch failed before root authority: ${failure.message}`;
    case "preclaim_exit":
      return `daemon exited before it became ready (exit ${failure.exitCode ?? "null"}${failure.signal ? `, signal ${failure.signal}` : ""})${stderrMessage(failure.stderr)}`;
    case "startup_timeout":
      return `daemon did not become ready within ${Math.round(failure.timeoutMs / 1_000)}s${stderrMessage(failure.stderr)}`;
  }
}

/**
 * Spawn without an inherited canonical-log descriptor. Import, spawn and
 * pre-claim exits remain bounded caller evidence; the daemon may start its own
 * permanent diagnostic writer only after a separate root-authority decision.
 */
export function launchDetachedDaemon(options: LaunchDetachedDaemonOptions): DetachedDaemonLaunch {
  proveEntry(options.entryPath);
  let failure: DaemonLaunchFailure | null = null;
  let ready = false;
  let stderrCapture: PreAuthorityStderrCapture | undefined;
  let resolveFailure: ((value: DaemonLaunchFailure) => void) | undefined;
  const failurePromise = new Promise<DaemonLaunchFailure>((resolve) => {
    resolveFailure = resolve;
  });
  const settleFailure = (value: DaemonLaunchFailure): void => {
    if (failure || ready) return;
    failure = value;
    resolveFailure?.(value);
  };
  const discardStderr = (): void => {
    stderrCapture?.destroyAndDiscard();
    stderrCapture = undefined;
  };
  let child: ChildProcess | undefined;
  try {
    const env = daemonLaunchEnvironment(options.env ?? process.env, options.launchSource);
    child = spawn(
      options.nodePath ?? process.execPath,
      [...daemonHeapLaunch(env).nodeArgs, options.entryPath],
      {
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
        env,
      },
    );
    stderrCapture = capturePreAuthorityStderr(child.stderr);
    child.once("error", (error) => {
      const code =
        typeof (error as NodeJS.ErrnoException).code === "string"
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      settleFailure({ kind: "spawn_error", message: safeProblemMessage(error), code });
      discardStderr();
    });
    child.once("close", (exitCode, signal) => {
      const stderr = stderrCapture?.evidence() ?? { kind: "empty" };
      discardStderr();
      settleFailure({ kind: "preclaim_exit", exitCode, signal, stderr });
    });
    child.unref();
  } catch (error) {
    const code =
      typeof (error as NodeJS.ErrnoException).code === "string"
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    settleFailure({ kind: "spawn_error", message: safeProblemMessage(error), code });
  }

  const callerError = (stage: string, timeoutMs: number): CliError => {
    let observed = failure;
    if (!observed) {
      const timeoutFailure: DaemonLaunchFailure = {
        kind: "startup_timeout",
        timeoutMs,
        stderr: stderrCapture?.evidence() ?? { kind: "empty" },
      };
      settleFailure(timeoutFailure);
      discardStderr();
      observed = failure ?? timeoutFailure;
    }
    return new CliError("operational", safeProblemMessage(failureMessage(observed)), {
      code: "daemon_start_failed",
      retryable: true,
      requiredActions: safeProblemRequiredActions([
        canonicalLogRemedy(),
        "Verify that this CLI uses an eligible fixed runtime, then retry; stop an older root claimant explicitly if it still owns the root.",
      ]),
      context: safeProblemContext({
        stage,
        timeoutMs,
        entryPath: options.entryPath,
        launchSource: options.launchSource,
        failure: observed,
      }),
    });
  };

  return {
    pid: child?.pid ?? null,
    failure: () => failure,
    waitForFailure: () => (failure ? Promise.resolve(failure) : failurePromise),
    markReady: () => {
      ready = true;
      discardStderr();
    },
    callerError,
  };
}
