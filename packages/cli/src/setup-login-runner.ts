#!/usr/bin/env node
import { spawn, type SpawnOptions } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProcessGroupService,
  defaultProcessGroupService,
  type ProcessGroupCapture,
} from "@claudexor/core";
import { nativeLoginEnv } from "./native-login.js";
import {
  SETUP_LOGIN_PROTOCOL_VERSION,
  atomicPrivateJson,
  readLoginManifest,
  readRunnerPermit,
  verifyExecutableEvidence,
  type SetupLoginManifest,
  type SetupLoginRunnerResult,
  type SetupLoginRunnerState,
} from "./setup-login-protocol.js";

const PERMIT_POLL_MS = 50;

export interface SetupLoginRunnerOptions {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  spawnProcess?: typeof spawn;
  processGroupService?: ProcessGroupService;
  selfPid?: number;
  runnerPath?: string;
}

/**
 * Terminal-visible bootstrap. It creates a detached worker process group and
 * waits for that worker, but the worker cannot start the vendor command until
 * claudexord has durably recorded its exact group handle and issued a permit.
 */
export async function runSetupLogin(
  manifestPath: string,
  options: SetupLoginRunnerOptions = {},
): Promise<number> {
  const manifest = validateManifest(manifestPath);
  const spawnProcess = options.spawnProcess ?? spawn;
  const runnerPath = options.runnerPath ?? fileURLToPath(import.meta.url);
  const worker = spawnProcess(process.execPath, [runnerPath, "--worker", resolve(manifestPath)], {
    cwd: manifest.cwd,
    env: runnerBootstrapEnv(),
    detached: true,
    stdio: "inherit",
  });
  const result = await waitForExit(worker);
  return result.code === 0 && result.signal === null ? 0 : 1;
}

/** Worker entrypoint. Exported so the permit ordering can be fault-injected. */
export async function runSetupLoginWorker(
  manifestPath: string,
  options: SetupLoginRunnerOptions = {},
): Promise<number> {
  const manifest = validateManifest(manifestPath);
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
  const spawnProcess = options.spawnProcess ?? spawn;
  const processGroups = options.processGroupService ?? defaultProcessGroupService;
  const captured = processGroups.captureLeader(options.selfPid ?? process.pid);
  if (captured.status !== "known") {
    throw new Error(describeCaptureFailure(captured));
  }

  const observedAt = now().toISOString();
  const awaitingPermit: SetupLoginRunnerState = {
    version: SETUP_LOGIN_PROTOCOL_VERSION,
    jobId: manifest.jobId,
    executionId: manifest.executionId,
    processGroup: captured.handle,
    stage: "awaiting_permit",
    observedAt,
    commandDigest: manifest.commandDigest,
    manifestDigest: manifest.manifestDigest,
  };
  atomicPrivateJson(manifest.statePath, awaitingPermit);

  const permit = await waitForPermit(manifest, now, sleep);
  if (!permit) {
    persistResult(manifest, {
      permitIssuedAt: null,
      commandStarted: false,
      errorCode: "permit_timeout",
      exitCode: null,
      signal: null,
      finishedAt: now().toISOString(),
    });
    return 1;
  }

  if (!verifyExecutableEvidence(manifest.executable)) {
    persistResult(manifest, {
      permitIssuedAt: permit.issuedAt,
      commandStarted: false,
      errorCode: "spawn_failed",
      exitCode: null,
      signal: null,
      finishedAt: now().toISOString(),
    });
    return 1;
  }

  atomicPrivateJson(manifest.statePath, { ...awaitingPermit, stage: "running" });
  // Keep the group leader alive through TERM so the daemon can still prove
  // identity and escalate a stubborn descendant with KILL after the grace
  // period. The vendor child receives the same group signal directly.
  const holdLeaderForEscalation = () => undefined;
  process.on("SIGTERM", holdLeaderForEscalation);
  process.on("SIGINT", holdLeaderForEscalation);
  let child;
  try {
    const spawnOptions: SpawnOptions = {
      cwd: manifest.cwd,
      env: nativeLoginEnv(manifest.harness),
      detached: false,
      stdio: "inherit",
    };
    child = spawnProcess(manifest.binary, manifest.args, spawnOptions);
  } catch {
    persistResult(manifest, {
      permitIssuedAt: permit.issuedAt,
      commandStarted: false,
      errorCode: "spawn_failed",
      exitCode: null,
      signal: null,
      finishedAt: now().toISOString(),
    });
    process.off("SIGTERM", holdLeaderForEscalation);
    process.off("SIGINT", holdLeaderForEscalation);
    return 1;
  }

  let result: { code: number | null; signal: NodeJS.Signals | null };
  try {
    result = await waitForExit(child);
  } catch {
    persistResult(manifest, {
      permitIssuedAt: permit.issuedAt,
      commandStarted: false,
      errorCode: "spawn_failed",
      exitCode: null,
      signal: null,
      finishedAt: now().toISOString(),
    });
    process.off("SIGTERM", holdLeaderForEscalation);
    process.off("SIGINT", holdLeaderForEscalation);
    return 1;
  }
  process.off("SIGTERM", holdLeaderForEscalation);
  process.off("SIGINT", holdLeaderForEscalation);
  persistResult(manifest, {
    permitIssuedAt: permit.issuedAt,
    commandStarted: true,
    exitCode: result.code,
    signal: result.signal,
    finishedAt: now().toISOString(),
  });
  return result.code === 0 && result.signal === null ? 0 : 1;
}

function validateManifest(manifestPath: string): SetupLoginManifest {
  const manifest = readLoginManifest(manifestPath);
  const base = resolve(dirname(manifestPath));
  for (const output of [manifest.statePath, manifest.resultPath, manifest.permitPath]) {
    const absolute = resolve(output);
    if (!absolute.startsWith(base + sep))
      throw new Error("setup-login sidecar escapes its job directory");
  }
  return manifest;
}

async function waitForPermit(
  manifest: SetupLoginManifest,
  now: () => Date,
  sleep: (ms: number) => Promise<void>,
) {
  const deadline = Date.parse(manifest.permitDeadlineAt);
  while (now().getTime() <= deadline) {
    const permit = readRunnerPermit(manifest.permitPath);
    if (
      permit &&
      permit.jobId === manifest.jobId &&
      permit.executionId === manifest.executionId &&
      permit.commandDigest === manifest.commandDigest &&
      permit.manifestDigest === manifest.manifestDigest
    )
      return permit;
    await sleep(Math.min(PERMIT_POLL_MS, Math.max(1, deadline - now().getTime())));
  }
  return null;
}

function persistResult(
  manifest: SetupLoginManifest,
  result: Omit<
    SetupLoginRunnerResult,
    "version" | "jobId" | "executionId" | "commandDigest" | "manifestDigest"
  >,
): void {
  atomicPrivateJson(manifest.resultPath, {
    version: SETUP_LOGIN_PROTOCOL_VERSION,
    jobId: manifest.jobId,
    executionId: manifest.executionId,
    commandDigest: manifest.commandDigest,
    manifestDigest: manifest.manifestDigest,
    ...result,
  } satisfies SetupLoginRunnerResult);
}

function waitForExit(
  child: ReturnType<typeof spawn>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

function describeCaptureFailure(
  captured: Exclude<ProcessGroupCapture, { status: "known" }>,
): string {
  return captured.status === "missing"
    ? "setup-login worker disappeared before its process group could be captured"
    : `setup-login worker process-group identity is unprovable: ${captured.reason}`;
}

/** The bootstrap itself never needs model/provider credentials. */
function runnerBootstrapEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME"] as const) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

function isDirectEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(resolve(process.argv[1])) ===
      realpathSync(resolve(fileURLToPath(import.meta.url)))
    );
  } catch {
    return false;
  }
}

if (isDirectEntrypoint()) {
  const workerMode = process.argv[2] === "--worker";
  const manifestPath = process.argv[workerMode ? 3 : 2];
  if (!manifestPath) {
    process.stderr.write("usage: setup-login-runner [--worker] <manifest.json>\n");
    process.exitCode = 2;
  } else {
    (workerMode ? runSetupLoginWorker(manifestPath) : runSetupLogin(manifestPath)).then(
      (code) => {
        process.exitCode = code;
      },
      (error) => {
        process.stderr.write(
          `setup-login-runner: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      },
    );
  }
}
