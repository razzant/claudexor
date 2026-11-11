#!/usr/bin/env node
import { interpretedCommand, killOwnedProcessTree, type HarnessInterpreter } from "@claudexor/core";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { processGroupServiceWithWindowsSupport } from "@claudexor/core";
import { isAgyProfileKeychainUnsafe, prepareAgyProfileKeychain } from "@claudexor/harness-agy";
import {
  startCodexDeviceLogin,
  type CodexAppServerConnection,
  type JsonRpcFrame,
} from "./codex-device-login.js";
import { terminateAppServerChild } from "./setup-login-child-lifecycle.js";
export { terminateAppServerChild } from "./setup-login-child-lifecycle.js";
import { nativeLoginEnv } from "./native-login.js";
import {
  createConptyControlParser,
  resolvePtyWrappedCommand,
  type TerminalTransportResolution,
} from "./setup-login-pty.js";
import { createOAuthUrlDetector } from "./setup-login-url.js";
export { createOAuthUrlDetector, extractOAuthUrl } from "./setup-login-url.js";
import { boundedTail, createTailBuffer, watchLoginInput } from "./setup-login-io.js";
import { waitForSetupLoginPermit } from "./setup-login-permit.js";
import {
  persistRunnerCommandFailure as persistCommandFailure,
  persistRunnerFailure as persistFailure,
  persistRunnerResult as persistResult,
  runnerBootstrapEnv,
  waitForRunnerExit as waitForExit,
} from "./setup-login-runner-support.js";
import {
  SETUP_LOGIN_PROTOCOL_VERSION,
  atomicPrivateJson,
  readLoginManifest,
  verifyExecutableEvidence,
  type SetupLoginManifest,
  type SetupLoginPermit,
  type SetupLoginRunnerState,
} from "./setup-login-protocol.js";

export interface SetupLoginRunnerOptions {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  spawnProcess?: typeof spawn;
  processGroupService?: ReturnType<typeof processGroupServiceWithWindowsSupport>;
  selfPid?: number;
  runnerPath?: string;
  resolvePtyCommand?: typeof resolvePtyWrappedCommand;
  prepareAgyProfileKeychain?: (home: string) => void;
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
  const manifest = readLoginManifest(manifestPath);
  const spawnProcess = options.spawnProcess ?? spawn;
  const runnerPath = options.runnerPath ?? fileURLToPath(import.meta.url);
  const worker = spawnProcess(process.execPath, [runnerPath, "--worker", resolve(manifestPath)], {
    cwd: manifest.cwd,
    env: runnerBootstrapEnv(),
    // libuv maps detached:true to DETACHED_PROCESS on Windows, so this
    // durable custody leader starts without an attached console. Keep the
    // window suppression explicit for the direct executable launch too.
    windowsHide: true,
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
  const manifest = readLoginManifest(manifestPath);
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
  const spawnProcess = options.spawnProcess ?? spawn;
  const resolvePtyCommand = options.resolvePtyCommand ?? resolvePtyWrappedCommand;
  const processGroups = options.processGroupService ?? processGroupServiceWithWindowsSupport();
  const captured = processGroups.captureLeader(options.selfPid ?? process.pid);
  if (captured.status !== "known") {
    throw new Error(
      captured.status === "missing"
        ? "setup-login worker disappeared before its process group could be captured"
        : `setup-login worker process-group identity is unprovable: ${captured.reason}`,
    );
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

  const permit = await waitForSetupLoginPermit(manifest, now, sleep, observedAt);
  if (!permit) {
    persistFailure(manifest, now, null, "permit_timeout");
    return 1;
  }

  if (!verifyExecutableEvidence(manifest.executable)) {
    persistFailure(manifest, now, permit.issuedAt, "spawn_failed");
    return 1;
  }

  if (manifest.harness === "agy" && manifest.profileConfigDir) {
    try {
      (options.prepareAgyProfileKeychain ?? ((home: string) => prepareAgyProfileKeychain(home)))(
        manifest.profileConfigDir,
      );
    } catch (error) {
      if (isAgyProfileKeychainUnsafe(error)) {
        persistFailure(
          manifest,
          now,
          permit.issuedAt,
          "spawn_failed",
          error instanceof Error ? error.message : String(error),
        );
        return 1;
      }
      // A custom operational seam may model a recoverable security-tool
      // miss; path and identity failures remain unsafe above.
    }
  }

  atomicPrivateJson(manifest.statePath, { ...awaitingPermit, stage: "running" });

  // D-17 primary flow: host the codex app-server and drive typed device-code
  // auth (no Terminal). The app-server child shares this detached worker's
  // process group, so every restart/permit/termination evidence semantic is
  // unchanged from the Terminal path.
  if (manifest.loginMode === "device_code") {
    return runDeviceCodeLogin(manifest, permit, { now, spawnProcess });
  }

  // `--device-auth` exists only since codex 0.46.0, so a codex login probes `login --help`
  // first and an old CLI yields a typed unsupported outcome; Grok's login passes the same
  // flag and is not probed. Fails OPEN — a broken probe falls through to the real spawn.
  if (manifest.harness === "codex" && manifest.args.includes("--device-auth")) {
    const probe = await probeLoginHelp(
      manifest.binary,
      spawnProcess,
      nativeLoginEnv(manifest.harness, process.env, manifest.profileConfigDir),
      manifest.interpreter,
    );
    if (probe.completed && !probe.output.includes("--device-auth")) {
      persistFailure(
        manifest,
        now,
        permit.issuedAt,
        "device_auth_unsupported",
        boundedTail(probe.output),
      );
      return 1;
    }
  }

  // Keep the group leader alive through TERM so the daemon can prove identity
  // and escalate stubborn descendants with KILL; the vendor child receives
  // the same group signal directly.
  const holdLeaderForEscalation = () => undefined;
  // Daemon-hosted no-Terminal modes (owner directive 2026-08-04): the runner is detached, so
  // nothing may inherit a TTY, and the console-less worker hides its child's console window.
  // with_input additionally pipes stdin so the daemon-delivered one-shot input reaches the CLI.
  const urlDisclosure =
    manifest.loginMode === "url_disclosure" || manifest.loginMode === "url_disclosure_with_input";
  const withInput = manifest.loginMode === "url_disclosure_with_input";
  // Tee the login output: a bounded ANSI-stripped tail rides the result for
  // failure classification, and (with deviceCodePath) the vendor's OAuth URL
  // is captured into the sidecar (codex tail-tee tradeoff).
  const teeOutput =
    manifest.harness === "codex" || manifest.deviceCodePath !== undefined || urlDisclosure;
  const tail = createTailBuffer();
  const urlDetector = createOAuthUrlDetector();
  const discloseOAuthUrl = (chunk: Buffer): void => {
    if (!manifest.deviceCodePath) return;
    const url = urlDetector.push(chunk);
    if (!url) return;
    try {
      // Same transient-sidecar discipline as the device-code flow: the URL
      // rides ONLY this read-time projection file, never the durable receipt.
      // The with-input flow discloses as oauth_url_input so the card knows to
      // render the one-shot paste field alongside the link.
      atomicPrivateJson(manifest.deviceCodePath, {
        version: SETUP_LOGIN_PROTOCOL_VERSION,
        jobId: manifest.jobId,
        executionId: manifest.executionId,
        flow: withInput ? "oauth_url_input" : "oauth_url",
        verificationUrl: url,
        userCode: "",
        disclosedAt: now().toISOString(),
      });
    } catch {
      // The disclosure is best-effort context; it must never kill the login.
    }
  };
  // A vendor that reads its code only from a terminal is wrapped here; the
  // wrapper is transport, so the evidence verified above still covers the
  // VENDOR binary and its sealed argv (setup-login-pty.ts).
  // Install the custody hold before the resolver can spawn its bounded probe.
  // A daemon cancellation during that await must leave this captured leader
  // alive for the existing PID-rooted tree escalation.
  process.on("SIGTERM", holdLeaderForEscalation);
  process.on("SIGINT", holdLeaderForEscalation);
  let stopInputWatch: (() => void) | undefined;
  try {
    const invocation = interpretedCommand(
      manifest.binary,
      manifest.args,
      nativeLoginEnv(manifest.harness, process.env, manifest.profileConfigDir),
      manifest.interpreter,
    );
    let terminal: Extract<TerminalTransportResolution, { status: "ready" }> | null = null;
    if (manifest.ptyStdin) {
      let resolution: TerminalTransportResolution;
      try {
        resolution = await resolvePtyCommand(invocation.binary, invocation.args);
      } catch {
        persistFailure(
          manifest,
          now,
          permit.issuedAt,
          "terminal_transport_probe_failed",
          "terminal transport capability probe failed",
        );
        return 1;
      }
      if (resolution.status !== "ready") {
        persistFailure(manifest, now, permit.issuedAt, resolution.errorCode, resolution.detail);
        return 1;
      }
      terminal = resolution;
    }
    const command = terminal?.command ?? invocation;

    // A spawn throw and a wait rejection write the SAME receipt, so they share
    // one catch. The outer finally releases both input and signal handlers on
    // resolver, spawn, wait, and result-classification exits.
    let result: { code: number | null; signal: NodeJS.Signals | null };
    const helperControl = terminal?.helperControlStderr ? createConptyControlParser() : null;
    try {
      const spawnOptions: SpawnOptions = {
        cwd: manifest.cwd,
        // A sealed profileConfigDir (INV-135) scopes the vendor login to the
        // binding's exact environment/state root. Credential custody remains
        // platform-defined; absent = the harness default route as before.
        env: invocation.env,
        ...(terminal?.backend === "windows_conpty" || urlDisclosure ? { windowsHide: true } : {}),
        detached: false,
        stdio: urlDisclosure
          ? [withInput ? "pipe" : "ignore", "pipe", "pipe"]
          : terminal?.helperControlStderr
            ? [withInput ? "pipe" : "inherit", "inherit", "pipe"]
            : teeOutput
              ? ["inherit", "pipe", "pipe"]
              : "inherit",
      };
      const child = spawnProcess(command.binary, command.args, spawnOptions);
      if (teeOutput) {
        const tee = (sink: NodeJS.WriteStream) => (chunk: Buffer) => {
          sink.write(chunk);
          tail.push(chunk);
          discloseOAuthUrl(chunk);
        };
        child.stdout?.on("data", tee(process.stdout));
        if (!helperControl) child.stderr?.on("data", tee(process.stderr));
      }
      if (helperControl) child.stderr?.on("data", (chunk: Buffer) => helperControl.push(chunk));
      if (withInput && manifest.inputPath) {
        // A tty echoes what we write, so the code would otherwise ride the tail.
        stopInputWatch = watchLoginInput(manifest, child, now, {
          onDelivered: (value) => tail.forget(value),
          windowsConpty: terminal?.backend === "windows_conpty",
        });
      }
      result = await waitForExit(child);
    } catch {
      if (!terminal) {
        persistFailure(manifest, now, permit.issuedAt, "spawn_failed");
        return 1;
      }
      const control = helperControl?.finish();
      if (control?.started) {
        persistCommandFailure(manifest, now, permit.issuedAt, "terminal_transport_failed", true);
        return 1;
      }
      let refreshed: TerminalTransportResolution | null = null;
      try {
        refreshed = await resolvePtyCommand(invocation.binary, invocation.args);
      } catch {
        // A resolver must normally return a typed result. If its own I/O fails,
        // the already-probed transport still has the narrow post-probe code.
      }
      if (refreshed && refreshed.status !== "ready") {
        persistFailure(manifest, now, permit.issuedAt, refreshed.errorCode, refreshed.detail);
      } else {
        persistCommandFailure(manifest, now, permit.issuedAt, "terminal_transport_failed", false);
      }
      return 1;
    }
    if (helperControl) {
      const control = helperControl.finish();
      if (!control.malformed && !control.started && control.error?.phase === 6) {
        persistFailure(manifest, now, permit.issuedAt, "spawn_failed");
        return 1;
      }
      if (control.malformed || control.error !== null || !control.started) {
        persistCommandFailure(
          manifest,
          now,
          permit.issuedAt,
          "terminal_transport_failed",
          control.started,
        );
        return 1;
      }
    }
    const capturedTail = tail.text();
    persistResult(manifest, {
      permitIssuedAt: permit.issuedAt,
      commandStarted: true,
      exitCode: result.code,
      signal: result.signal,
      finishedAt: now().toISOString(),
      ...(capturedTail && (result.code !== 0 || result.signal !== null)
        ? { outputTail: capturedTail }
        : {}),
    });
    return result.code === 0 && result.signal === null ? 0 : 1;
  } finally {
    stopInputWatch?.();
    process.off("SIGTERM", holdLeaderForEscalation);
    process.off("SIGINT", holdLeaderForEscalation);
  }
}

/**
 * D-17 device-code login: host `codex app-server --stdio`, drive the typed
 * device-code handshake, and write the transient disclosure sidecar (the
 * one-time code lives ONLY there and is never persisted to the result receipt).
 * Completion → exit 0 (the daemon then runs the unchanged native verification);
 * a capability probe miss → `device_auth_unsupported` (the daemon demotes to
 * the typed Terminal fallback, no stdout regex).
 */
async function runDeviceCodeLogin(
  manifest: SetupLoginManifest,
  permit: SetupLoginPermit,
  deps: { now: () => Date; spawnProcess: typeof spawn },
): Promise<number> {
  const { now, spawnProcess } = deps;
  if (!manifest.deviceCodePath || !manifest.appServerFlow) {
    persistFailure(manifest, now, permit.issuedAt, "spawn_failed");
    return 1;
  }
  let child: ChildProcess;
  try {
    const invocation = interpretedCommand(
      manifest.binary,
      manifest.args,
      nativeLoginEnv(manifest.harness, process.env, manifest.profileConfigDir),
      manifest.interpreter,
    );
    child = spawnProcess(invocation.binary, invocation.args, {
      cwd: manifest.cwd,
      env: invocation.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true, // no Terminal: the detached worker has no console to share
    });
  } catch {
    persistFailure(manifest, now, permit.issuedAt, "spawn_failed");
    return 1;
  }
  child.stderr?.resume();
  const connection = appServerConnection(child);
  const abort = new AbortController();
  const onSignal = () => abort.abort();
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    const start = await startCodexDeviceLogin(connection, {
      flow: manifest.appServerFlow,
      signal: abort.signal,
    });
    if (start.kind === "not_supported") {
      await terminateAppServerChild(child, connection);
      // Typed capability-probe miss: reuse the existing not_supported outcome
      // so the daemon offers the legacy Terminal fallback (no stdout regex).
      persistFailure(manifest, now, permit.issuedAt, "device_auth_unsupported");
      return 1;
    }
    // Transient disclosure sidecar. The userCode rides ONLY this file (read-time
    // snapshot projection); it never enters the result receipt or the journal.
    atomicPrivateJson(manifest.deviceCodePath, {
      version: SETUP_LOGIN_PROTOCOL_VERSION,
      jobId: manifest.jobId,
      executionId: manifest.executionId,
      flow: manifest.appServerFlow,
      verificationUrl: start.disclosure.verificationUrl,
      userCode: start.disclosure.userCode,
      disclosedAt: now().toISOString(),
    });
    const outcome = await start.awaitCompletion();
    await terminateAppServerChild(child, connection);
    const exitCode = outcome.kind === "completed" ? 0 : 1;
    persistResult(manifest, {
      permitIssuedAt: permit.issuedAt,
      commandStarted: true,
      exitCode,
      signal: null,
      finishedAt: now().toISOString(),
      ...(outcome.kind === "failed" ? { outputTail: boundedTail(outcome.detail) } : {}),
    });
    return exitCode;
  } catch (error) {
    await terminateAppServerChild(child, connection);
    persistResult(manifest, {
      permitIssuedAt: permit.issuedAt,
      commandStarted: true,
      exitCode: 1,
      signal: null,
      finishedAt: now().toISOString(),
      outputTail: boundedTail(error instanceof Error ? error.message : String(error)),
    });
    return 1;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

/** Adapt a `codex app-server --stdio` child to the device-login transport seam
 * (line-delimited JSON-RPC over the child's stdio). */
function appServerConnection(child: ChildProcess): CodexAppServerConnection {
  const lines = createInterface({ input: child.stdout! });
  let frameHandler: ((frame: JsonRpcFrame) => void) | null = null;
  const closeHandlers: Array<(error?: Error) => void> = [];
  lines.on("line", (line) => {
    let frame: JsonRpcFrame;
    try {
      frame = JSON.parse(line) as JsonRpcFrame;
    } catch {
      return; // Vendor diagnostics are not protocol authority.
    }
    frameHandler?.(frame);
  });
  const closeWith = (error: Error) => {
    for (const handler of closeHandlers) handler(error);
  };
  child.once("exit", (code, signal) =>
    closeWith(new Error(`codex app-server exited: code=${String(code)} signal=${String(signal)}`)),
  );
  child.once("error", (error) => closeWith(error));
  child.stdin?.on("error", () => undefined);
  return {
    send(frame) {
      child.stdin?.write(`${JSON.stringify(frame)}\n`);
    },
    onFrame(handler) {
      frameHandler = handler;
    },
    onClose(handler) {
      closeHandlers.push(handler);
    },
    close() {
      try {
        child.stdin?.end();
      } catch {
        /* best-effort */
      }
    },
  };
}

/** Run `<binary> login --help` captured, bounded to 10s. Fails OPEN: only a
 * COMPLETED probe whose help text lacks the flag reports unsupported. */
function probeLoginHelp(
  binary: string,
  spawnProcess: typeof spawn,
  probeEnv: NodeJS.ProcessEnv,
  interpreter?: HarnessInterpreter,
): Promise<{ completed: boolean; output: string }> {
  return new Promise((resolveProbe) => {
    const PROBE_OUTPUT_CAP = 65_536;
    const chunks: Buffer[] = [];
    let retainedBytes = 0;
    let settled = false;
    const settle = (completed: boolean) => {
      if (settled) return;
      settled = true;
      resolveProbe({ completed, output: Buffer.concat(chunks).toString("utf8") });
    };
    let probe: ReturnType<typeof spawn>;
    try {
      const invocation = interpretedCommand(binary, ["login", "--help"], probeEnv, interpreter);
      probe = spawnProcess(invocation.binary, invocation.args, {
        // The real vendor spawn's scrubbed allowlist env, never the Terminal's.
        env: invocation.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true, // captured help, unlike the sign-in: no console window
      });
    } catch {
      settle(false);
      return;
    }
    // Byte-accurate retention (UTF-16 string length under-counts multibyte
    // output); decode ONCE at settle so split UTF-8 never corrupts.
    const retain = (chunk: Buffer) => {
      if (retainedBytes >= PROBE_OUTPUT_CAP) return;
      const slice = chunk.subarray(0, PROBE_OUTPUT_CAP - retainedBytes);
      chunks.push(Buffer.from(slice));
      retainedBytes += slice.length;
    };
    probe.stdout?.on("data", retain);
    probe.stderr?.on("data", retain);
    probe.on("error", () => settle(false));
    // `close` (streams drained) + exit code 0: an errored-but-chatty probe
    // (old CLI printing \"unrecognized subcommand\") must fail OPEN to the
    // real spawn, and `exit` could race the final help-output chunks.
    probe.on("close", (code) => settle(code === 0 && retainedBytes > 0));
    const timer = setTimeout(() => {
      try {
        killOwnedProcessTree(probe, "SIGKILL");
      } catch {
        // best-effort
      }
      settle(false);
    }, 10_000);
    timer.unref?.();
  });
}

function isDirectEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    const self = realpathSync(resolve(fileURLToPath(import.meta.url)));
    return realpathSync(resolve(process.argv[1])) === self;
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
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(`setup-login-runner: ${detail}\n`);
        process.exitCode = 1;
      },
    );
  }
}
