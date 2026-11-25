import { lstatSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";
import { CLAUDEXOR_VERSION } from "@claudexor/util";
import {
  type DaemonWriterLeaseStatus,
  type RuntimeReplacementIdentity,
  type RuntimeReplacementTarget,
  awaitDaemonTermination,
  defaultSocketPath,
  inspectDaemonWriterLease,
  socketAlive,
} from "@claudexor/daemon";
import { flagStr, type ParsedArgs } from "./args.js";
import { subcommandFlagScopeError } from "./command-scope.js";
import { ensureDaemon, connectDaemonIfRunning } from "./daemon-run.js";
import { CONTROL_PROTOCOL_MAJOR, handshakeControlApi } from "./live.js";
import { printJson, printUsageError } from "./cli-io.js";
import { installRemoteHost, notActivated } from "./remote-host-install.js";
import { type RemoteHostDeps, preflightRemoteHost } from "./remote-host-preflight.js";
import { sshDestinationProblem, systemSshTransport } from "./remote-host-transport.js";

/** How `remote preflight|install` reaches a host: the CLI passes the system
 * ssh and the published release; a test passes its own transport and fetch.
 * There is no default, so no caller falls back to the system ssh unasked. */
export type RemoteHostDepsFor = (destination: string) => RemoteHostDeps;

export const systemRemoteHostDeps: RemoteHostDepsFor = (destination) => ({
  transport: systemSshTransport(destination),
});

/** The command owns the operation's lifetime: SIGINT or SIGTERM to this CLI
 * cancels it, so its ssh (in its own process group) is stopped through the
 * capture's own stop and no further step starts. The listeners exist only
 * while the operation runs; a second signal finds none and ends the CLI. */
async function withCancellation<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const lifetime = new AbortController();
  const cancel = () => lifetime.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    return await work(lifetime.signal);
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
import {
  admitAndAwaitRuntimeReplacementStop,
  decideRuntimeReplacementWithoutControl,
  runtimeReplacementCapableOwner,
} from "./runtime-replacement-stop.js";

function runtimeTarget(): string {
  return `${platform()}-${arch()}`;
}

function endpointPort(baseUrl: string): number {
  const url = new URL(baseUrl);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "::1") {
    throw new Error("remote control API refused: endpoint is not loopback-bound");
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("remote control API reported an invalid port");
  }
  return port;
}

async function bootstrap(): Promise<number> {
  const { addr } = await ensureDaemon();
  const identity = await handshakeControlApi(addr, "claudexor-macos-remote");
  // C7b: publication requires NORMAL serving (absent = normal for pre-#165
  // daemons). A recovery-only remote must never be published to the app.
  if (identity.servingMode !== "normal") {
    throw Object.assign(
      new Error("remote daemon is serving recovery only; publication requires normal serving"),
      { code: "daemon_recovery_only", status: 503, retryable: true },
    );
  }
  printJson({
    ok: true,
    target: runtimeTarget(),
    version: CLAUDEXOR_VERSION,
    buildSha: process.env["CLAUDEXOR_BUILD_SHA"] ?? "unknown",
    protocolMajor: CONTROL_PROTOCOL_MAJOR,
    engineVersion: identity.engineVersion,
    engineBuildSha: identity.engineBuildSha,
    endpoint: { host: "127.0.0.1", port: endpointPort(addr.baseUrl), token: addr.token },
  });
  return 0;
}

async function probe(): Promise<number> {
  printJson({
    ok: true,
    target: runtimeTarget(),
    platform: platform(),
    arch: arch(),
    home: homedir(),
    version: CLAUDEXOR_VERSION,
    buildSha: process.env["CLAUDEXOR_BUILD_SHA"] ?? "unknown",
    protocolMajor: CONTROL_PROTOCOL_MAJOR,
  });
  return 0;
}

export function assertRemoteEngineIdentity(
  observed: { engineVersion: string | null; engineBuildSha: string | null },
  expectedVersion: string,
  expectedBuildSha: string,
): RuntimeReplacementIdentity {
  if (!/^\d+\.\d+\.\d+$/.test(expectedVersion) || !/^[0-9a-f]{40}$/.test(expectedBuildSha)) {
    throw new Error("remote daemon stop received an invalid expected identity");
  }
  if (observed.engineVersion !== expectedVersion || observed.engineBuildSha !== expectedBuildSha) {
    throw new Error(
      `remote daemon identity mismatch (expected ${expectedVersion}/${expectedBuildSha}, ` +
        `observed ${observed.engineVersion ?? "unknown"}/${observed.engineBuildSha ?? "unknown"})`,
    );
  }
  return { version: expectedVersion, buildSha: expectedBuildSha };
}

interface RemoteRuntimeStopDeps {
  connect(): ReturnType<typeof connectDaemonIfRunning>;
  socketPath(): string;
  socketReachable(path: string): Promise<boolean>;
  inspectLease(path: string): DaemonWriterLeaseStatus;
}

const productionRemoteRuntimeStopDeps: RemoteRuntimeStopDeps = {
  connect: connectDaemonIfRunning,
  socketPath: defaultSocketPath,
  socketReachable: socketAlive,
  inspectLease: inspectDaemonWriterLease,
};

function runtimeActivityUnknown(message: string): Error {
  return Object.assign(new Error(message), {
    code: "runtime_activity_unknown",
    status: 503,
    retryable: true,
  });
}

export async function stopRemoteDaemonForRuntimeReplacement(
  expectedVersion: string,
  expectedBuildSha: string,
  deps: RemoteRuntimeStopDeps = productionRemoteRuntimeStopDeps,
): Promise<number> {
  const socketPath = deps.socketPath();
  const daemon = await deps.connect();
  if (!daemon) {
    const decision = decideRuntimeReplacementWithoutControl(
      await deps.socketReachable(socketPath),
      deps.inspectLease(socketPath),
    );
    if (decision.status === "activity_unknown") {
      throw runtimeActivityUnknown(decision.detail);
    }
    printJson({ ok: true, stopped: true, alreadyStopped: true });
    return 0;
  }
  const identity = await handshakeControlApi(daemon.addr, "claudexor-macos-remote-stop");
  const expectedIdentity = assertRemoteEngineIdentity(identity, expectedVersion, expectedBuildSha);
  // Bind the target from a fresh strict inspection immediately before the
  // target-bound admission RPC. Control reachability cannot upgrade an
  // absent, stale, or unknown lease into signal authority.
  const lease = deps.inspectLease(socketPath);
  const expectedOwner = runtimeReplacementCapableOwner(lease);
  if (!expectedOwner) {
    throw runtimeActivityUnknown(
      "remote daemon is live but its writer-lease activity cannot be verified",
    );
  }
  const expectedTarget: RuntimeReplacementTarget = {
    ...expectedIdentity,
    leaseOwner: { pid: expectedOwner.pid, token: expectedOwner.token },
  };
  const termination = await admitAndAwaitRuntimeReplacementStop(
    () => daemon.client.shutdownForRuntimeReplacement(expectedTarget),
    (options) => awaitDaemonTermination(socketPath, options),
    expectedOwner,
  );
  if (termination.outcome === "still_alive") {
    throw new Error(`remote daemon did not stop: ${termination.detail}`);
  }
  printJson({ ok: true, stopped: true, ...termination });
  return 0;
}

function runtimePointerTarget(value: string): string | null {
  if (value === "-") return null;
  if (!/^versions\/[A-Za-z0-9._-]+$/.test(value) || value.includes("..")) {
    throw new Error("remote runtime pointer target is invalid");
  }
  return value;
}

function readRuntimePointer(root: string): string | null {
  const current = join(root, "current");
  try {
    if (!lstatSync(current).isSymbolicLink()) {
      throw new Error("remote runtime current pointer is not a symbolic link");
    }
    return readlinkSync(current);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function replaceRuntimePointer(root: string, name: string, target: string): void {
  const destination = join(root, name);
  const temporary = join(root, `.${name}.next-${process.pid}`);
  try {
    unlinkSync(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  symlinkSync(target, temporary);
  try {
    // fs.rename maps to rename(2), which atomically replaces the symlink itself
    // on both Darwin and Linux (unlike platform-divergent `mv` directory logic).
    renameSync(temporary, destination);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* best effort */
    }
    throw error;
  }
}

export function switchRemoteRuntimePointer(
  mode: "activate" | "rollback",
  root: string,
  expectedRaw: string,
  nextRaw: string,
): void {
  const expected = runtimePointerTarget(expectedRaw);
  const next = runtimePointerTarget(nextRaw);
  const current = readRuntimePointer(root);
  if (current !== expected) {
    throw new Error(
      `remote runtime pointer changed concurrently (expected ${expected ?? "-"}, observed ${current ?? "-"})`,
    );
  }
  if (next) {
    const target = join(root, next);
    if (!lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink()) {
      throw new Error("remote runtime pointer target is not an immutable directory");
    }
  }
  if (current === next) return;
  if (mode === "activate" && expected) {
    replaceRuntimePointer(root, "last-known-good", expected);
  }
  if (next) {
    replaceRuntimePointer(root, "current", next);
  } else {
    unlinkSync(join(root, "current"));
  }
}

/** Controller-side: the read-only check of an SSH host, or the one confirmed
 * first install of this CLI's signed runtime there (remote-host-preflight.ts,
 * remote-host-install.ts). */
async function remoteHostCommand(
  sub: "preflight" | "install",
  args: ParsedArgs,
  depsFor: RemoteHostDepsFor,
): Promise<number> {
  const destination = args._[2];
  const usage = `usage: claudexor remote ${sub} <ssh-destination>${sub === "install" ? " --digest <sha256>" : ""} --json`;
  if (args._.length !== 3 || typeof destination !== "string") return printUsageError(true, usage);
  const problem = sshDestinationProblem(destination);
  if (problem) return printUsageError(true, `${problem}; ${usage}`);
  const digest = flagStr(args, "digest");
  if (sub === "install" && (!digest || !/^[0-9a-f]{64}$/.test(digest))) {
    return printUsageError(
      true,
      `remote install needs the --digest that remote preflight showed; ${usage}`,
    );
  }
  // Building the transport (finding the ssh client) precedes any server call:
  // for an install such a failure keeps its type and says nothing activated.
  const deps = (() => {
    try {
      return depsFor(destination);
    } catch (error) {
      throw sub === "install" ? notActivated(error) : error;
    }
  })();
  type RemoteAnswer = Awaited<
    ReturnType<typeof preflightRemoteHost> | ReturnType<typeof installRemoteHost>
  >;
  const answer = await withCancellation<RemoteAnswer>((signal) =>
    sub === "preflight"
      ? preflightRemoteHost(destination, { ...deps, signal })
      : installRemoteHost(destination, digest!, { ...deps, signal }),
  );
  printJson(answer);
  return 0;
}

export async function remoteCommand(
  args: ParsedArgs,
  json: boolean,
  remoteHostDeps: RemoteHostDepsFor,
): Promise<number> {
  const sub = args._[1] ?? "probe";
  if (!json) {
    return printUsageError(false, "claudexor remote is an internal machine interface; pass --json");
  }
  const scopeError = subcommandFlagScopeError("remote", sub, Object.keys(args.flags));
  if (scopeError) return printUsageError(json, scopeError);
  if (sub === "preflight" || sub === "install") {
    return remoteHostCommand(sub, args, remoteHostDeps);
  }
  if (sub === "stop") {
    const expectedVersion = args._[2];
    const expectedBuildSha = args._[3];
    if (
      args._.length !== 4 ||
      typeof expectedVersion !== "string" ||
      typeof expectedBuildSha !== "string"
    ) {
      return printUsageError(
        json,
        "usage: claudexor remote stop <expectedVersion> <expectedBuildSha> --json",
      );
    }
    return stopRemoteDaemonForRuntimeReplacement(expectedVersion, expectedBuildSha);
  }
  if (sub === "activate" || sub === "rollback") {
    const expected = args._[2];
    const next = args._[3];
    if (args._.length !== 4 || typeof expected !== "string" || typeof next !== "string") {
      return printUsageError(
        json,
        `usage: claudexor remote ${sub} <expectedTarget|-> <nextTarget|-> --json`,
      );
    }
    switchRemoteRuntimePointer(sub, join(homedir(), ".claudexor", "remote"), expected, next);
    printJson({ ok: true, current: next === "-" ? null : next });
    return 0;
  }
  if (args._.length > 2 || (sub !== "probe" && sub !== "bootstrap")) {
    return printUsageError(
      json,
      "usage: claudexor remote probe|bootstrap|stop|activate|rollback|preflight|install --json",
    );
  }
  return sub === "bootstrap" ? bootstrap() : probe();
}
