/** Startup diagnostics and quota polling shared by the SQL composition. */
import { dirname } from "node:path";
import { daemonDir, logPath, QUOTA_POLL_INTERVAL_MS } from "@claudexor/daemon";
import { measureSync } from "@claudexor/util";
import { DAEMON_LAUNCH_SOURCE_ENV } from "./daemon-launch.js";
import { isRareDiagnosticStage, rareHistoryPath } from "./daemon-rare-history.js";
import { logLine } from "./log-line.js";
import type { QuotaDiagnosticSink } from "./quota-refresh-diagnostics.js";
import {
  openDaemonStartupDiagnosticsAfterAuthority,
  safeDaemonLaunchSource,
  type DaemonStartupDiagnosticRecord as DiagnosticRecord,
  type DaemonStartupDiagnostics,
} from "./startup-diagnostics.js";

export interface StartupDiagnosticsHandle {
  diagnostics: DaemonStartupDiagnostics | null;
  /** Lifecycle port: a structured record in the daemon log; a rare stage
   * (`loop_stall`, `shutdown*`) is also kept in the bounded rare history. */
  port: Pick<DaemonStartupDiagnostics, "record">;
  recordStage(stage: string, message: string): void;
  recordFailure(message: string, error: unknown): void;
  /** One plain daemon log line (the historical `[time] message` form, written
   * once); a rare stage is also recorded in the rare history. */
  log(stage: string, message: string): void;
  logQuotaObservation: QuotaDiagnosticSink;
  logForcedExit(reason: string): void;
  close(reserveExit?: boolean): void;
}

/** C8: open the private post-authority diagnostics with full launch
 * provenance (runtime identity, entry path, pid, data root, and the
 * CLAUDEXOR_DAEMON_LAUNCH_SOURCE value coerced to a safe label). Every
 * in-process append to the canonical log then goes through that one bounded
 * writer; the rare history is a second writer of the same kind. */
export function openStartupDiagnostics(
  identity: { version: string; sha: string; entry: string },
  options: { path?: string } = {},
): StartupDiagnosticsHandle {
  const path = options.path ?? logPath();
  const context = {
    runtimeVersion: identity.version,
    buildSha: identity.sha,
    entryPath: identity.entry,
    pid: process.pid,
    dataRoot: options.path ? dirname(path) : daemonDir(),
    launchSource: safeDaemonLaunchSource(process.env[DAEMON_LAUNCH_SOURCE_ENV]),
  };
  const open = (target: string): DaemonStartupDiagnostics | Error => {
    try {
      return openDaemonStartupDiagnosticsAfterAuthority(context, { path: target });
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  };
  const main = open(path);
  const rare = open(rareHistoryPath(path));
  const diagnostics = main instanceof Error ? null : main;
  const history = rare instanceof Error ? null : rare;
  let closed = false;
  let writeLateExit: ((reason: string) => void) | undefined;
  const write = (writer: DaemonStartupDiagnostics | null, value: DiagnosticRecord): boolean => {
    try {
      return writer?.record(value) ?? false;
    } catch {
      return false; // diagnostics never control lifecycle
    }
  };
  write(diagnostics, {
    stage: "root_authority_won",
    message: "root authority acquired; startup diagnostics online",
  });
  // A refused target is never reopened by a plain append: each refusal is
  // recorded by the other writer when that one is open.
  if (main instanceof Error) write(history, unavailable("daemon log", main));
  if (rare instanceof Error) write(diagnostics, unavailable("rare daemon history", rare));
  const port = {
    record: (value: DiagnosticRecord): boolean => {
      if (!isRareDiagnosticStage(value.stage)) return write(diagnostics, value);
      const event = { ...value, at: value.at ?? new Date() };
      const kept = write(diagnostics, event);
      write(history, event);
      return kept;
    },
  };
  return {
    diagnostics,
    port,
    recordStage: (stage, message) => void port.record({ stage, message }),
    recordFailure: (message, error) =>
      void write(diagnostics, { stage: "startup_failure", message, error }),
    log: (stage, message) => {
      if (closed) return;
      logLine(path, message);
      if (isRareDiagnosticStage(stage)) write(history, { stage, message });
    },
    logQuotaObservation: (record) => {
      if (!closed && diagnostics)
        measureSync("daemon.log_line", () => diagnostics.appendQuotaObservation(record));
    },
    logForcedExit: (reason) => {
      if (closed) writeLateExit?.(reason);
      else {
        history?.appendLine(reason);
        diagnostics?.appendLine(reason);
      }
    },
    close: (reserveExit = false) => {
      if (closed) return;
      closed = true;
      writeLateExit = history?.close(reserveExit);
      const mainExit = diagnostics?.close(reserveExit && !writeLateExit);
      writeLateExit ??= mainExit;
    },
  };
}

function unavailable(target: string, error: Error): DiagnosticRecord {
  return {
    stage: "diagnostics_unavailable",
    message: `${target} writer refused its target`,
    error,
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
