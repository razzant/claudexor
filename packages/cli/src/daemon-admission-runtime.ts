/** Startup diagnostics and quota polling shared by the SQL composition. */
import { daemonDir, logPath, QUOTA_POLL_INTERVAL_MS } from "@claudexor/daemon";
import { redactSecrets } from "@claudexor/util";
import { DAEMON_LAUNCH_SOURCE_ENV } from "./daemon-launch.js";
import { logLine } from "./daemon-lifecycle.js";
import {
  openDaemonStartupDiagnosticsAfterAuthority,
  safeDaemonLaunchSource,
  type DaemonStartupDiagnostics,
} from "./startup-diagnostics.js";

export interface StartupDiagnosticsHandle {
  diagnostics: DaemonStartupDiagnostics | null;
  recordStage(stage: string, message: string): void;
  recordFailure(message: string, error: unknown): void;
  /** Daemon log line plus a diagnostics record under `stage` (redacted). */
  log(stage: string, message: string): void;
  close(): void;
}

/** C8: open the private post-authority diagnostics with full launch
 * provenance (runtime identity, entry path, pid, data root, and the
 * CLAUDEXOR_DAEMON_LAUNCH_SOURCE value coerced to a safe label). */
export function openStartupDiagnostics(identity: {
  version: string;
  sha: string;
  entry: string;
}): StartupDiagnosticsHandle {
  let diagnostics: DaemonStartupDiagnostics | null = null;
  try {
    diagnostics = openDaemonStartupDiagnosticsAfterAuthority({
      runtimeVersion: identity.version,
      buildSha: identity.sha,
      entryPath: identity.entry,
      pid: process.pid,
      dataRoot: daemonDir(),
      launchSource: safeDaemonLaunchSource(process.env[DAEMON_LAUNCH_SOURCE_ENV]),
    });
    diagnostics.record({
      stage: "root_authority_won",
      message: "root authority acquired; startup diagnostics online",
    });
  } catch (error) {
    logLine(
      logPath(),
      `startup diagnostics unavailable: ${redactSecrets(
        error instanceof Error ? error.message : String(error),
      )}`,
    );
  }
  const record = (value: Parameters<DaemonStartupDiagnostics["record"]>[0]): void => {
    try {
      diagnostics?.record(value);
    } catch {
      /* diagnostics never control lifecycle */
    }
  };
  return {
    diagnostics,
    recordStage: (stage, message) => record({ stage, message }),
    recordFailure: (message, error) => record({ stage: "startup_failure", message, error }),
    log: (stage, message) => {
      const redacted = redactSecrets(message);
      logLine(logPath(), redacted);
      record({ stage, message: redacted });
    },
    close: () => diagnostics?.close(),
  };
}

/** C1a/G-QUOTA-01: quota polling belongs to the NORMAL plane — polling
 * against unactivated projections is a swallowed throw, and the recovery
 * plane must stay non-mutating. Arming polls immediately, removing the
 * one-minute stale window the swallowed stage-2 poll used to leave. */
export function createDaemonQuotaPoller(poll: () => void): { arm(): void; stop(): void } {
  let timer: NodeJS.Timeout | null = null;
  return {
    arm: () => {
      if (timer) return;
      timer = setInterval(poll, QUOTA_POLL_INTERVAL_MS);
      timer.unref();
      poll();
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
