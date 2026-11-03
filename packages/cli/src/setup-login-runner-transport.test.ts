import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessGroupService, type ProcessIdentityReader } from "@claudexor/core";
import { runSetupLoginWorker } from "./setup-login-runner.js";
import { CONPTY_HELPER_PROTOCOL, type TerminalTransportResolution } from "./setup-login-pty.js";
import { watchLoginInput } from "./setup-login-io.js";
import {
  SETUP_LOGIN_PROTOCOL_VERSION,
  atomicPrivateJson,
  captureExecutableEvidence,
  commandDigest,
  readRunnerDeviceCode,
  readRunnerResult,
  readLoginManifest,
  sealLoginManifest,
} from "./setup-login-protocol.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "setup-conpty-runner-"));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

describe("ConPTY one-shot input write completion", () => {
  it("issues one completed record write at a time without queued _writev batching", async () => {
    const { stdin, batches, callbacks, stop, onDelivered, inputPath } = prepareInputWatch();
    try {
      expect(onDelivered).toHaveBeenCalledExactlyOnceWith("A");
      expect(JSON.parse(readFileSync(inputPath, "utf8"))).toMatchObject({ consumed: true });
      expect(readFileSync(inputPath, "utf8")).not.toContain('"value"');
      while (callbacks.length > 0) {
        callbacks.shift()!();
        await new Promise<void>((done) => setImmediate(done));
      }
      expect(batches).toEqual([
        ["\u001b[231;0;65;1;0;1_"],
        ["\u001b[231;0;65;0;0;1_"],
        ["\u001b[13;28;13;1;0;1_"],
        ["\u001b[13;28;13;0;0;1_"],
      ]);
      vi.advanceTimersByTime(900);
      expect(batches).toHaveLength(4);
      expect(onDelivered).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      stdin.destroy();
    }
  });

  it.each(["error", "cancel"] as const)(
    "stops unsent records after %s without replaying input",
    async (reason) => {
      const { stdin, batches, callbacks, stop, onDelivered, inputPath } = prepareInputWatch();
      try {
        if (reason === "cancel") stop();
        callbacks.shift()!(reason === "error" ? new Error("fixture write failed") : undefined);
        await new Promise<void>((done) => setImmediate(done));
        vi.advanceTimersByTime(900);
        expect(batches).toHaveLength(1);
        expect(callbacks).toHaveLength(0);
        expect(onDelivered).toHaveBeenCalledTimes(1);
        expect(JSON.parse(readFileSync(inputPath, "utf8"))).toMatchObject({ consumed: true });
        expect(readFileSync(inputPath, "utf8")).not.toContain('"value"');
      } finally {
        stop();
        stdin.destroy();
      }
    },
  );

  it("preserves the ordinary non-Windows single LF write", () => {
    const { stdin, batches, callbacks, stop } = prepareInputWatch(false);
    try {
      expect(batches).toEqual([["A\n"]]);
      callbacks.shift()!();
      vi.advanceTimersByTime(900);
      expect(batches).toEqual([["A\n"]]);
    } finally {
      stop();
      stdin.destroy();
    }
  });
});

function prepareInputWatch(windowsConpty = true) {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const prepared = prepareManifest();
  atomicPrivateJson(prepared.inputPath, {
    version: SETUP_LOGIN_PROTOCOL_VERSION,
    jobId: prepared.jobId,
    executionId: prepared.executionId,
    value: "A",
    submittedAt: new Date().toISOString(),
  });
  const batches: string[][] = [];
  const callbacks: Array<(error?: Error | null) => void> = [];
  const onDelivered = vi.fn();
  // A real Writable owns buffering/_writev. Only physical completion is held,
  // as it can be for a Windows pipe; no cork or fake batching is introduced.
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      expect(onDelivered).toHaveBeenCalledExactlyOnceWith("A");
      batches.push([chunk.toString("utf8")]);
      callbacks.push(callback);
    },
    writev(chunks, callback) {
      batches.push(chunks.map(({ chunk }) => chunk.toString("utf8")));
      callbacks.push(callback);
    },
  });
  const stop = watchLoginInput(
    readLoginManifest(prepared.manifestPath),
    { stdin } as ChildProcess,
    () => new Date(),
    {
      windowsConpty,
      onDelivered,
    },
  );
  vi.advanceTimersByTime(300);
  return { stdin, batches, callbacks, stop, onDelivered, inputPath: prepared.inputPath };
}

describe("setup-login runner ConPTY integration", () => {
  it.each([
    [
      "unavailable",
      {
        status: "unavailable",
        backend: "windows_conpty",
        errorCode: "terminal_transport_unavailable",
        detail: "terminal transport helper is unavailable on this host",
      },
    ],
    [
      "unsupported",
      {
        status: "unsupported",
        backend: "windows_conpty",
        errorCode: "terminal_transport_unsupported",
        detail: "terminal transport is unsupported on this host",
      },
    ],
    [
      "probe_failed",
      {
        status: "probe_failed",
        backend: "windows_conpty",
        errorCode: "terminal_transport_probe_failed",
        detail: "terminal transport capability probe failed",
      },
    ],
  ] as const)(
    "persists the typed %s resolver outcome before vendor start",
    async (_name, resolution) => {
      const prepared = prepareManifest();
      expect(await runWorker(prepared.manifestPath, async () => resolution)).toBe(1);
      expect(readRunnerResult(prepared.resultPath)).toMatchObject({
        commandStarted: false,
        errorCode: resolution.errorCode,
        exitCode: null,
        signal: null,
        outputTail: resolution.detail,
      });
    },
  );

  it("holds the captured worker through a cancellation signal during the async probe", async () => {
    const prepared = prepareManifest();
    const termListeners = process.listenerCount("SIGTERM");
    const intListeners = process.listenerCount("SIGINT");
    let announceProbe!: () => void;
    const probeStarted = new Promise<void>((resolveStarted) => {
      announceProbe = resolveStarted;
    });
    let finishProbe!: (resolution: TerminalTransportResolution) => void;
    const probe = new Promise<TerminalTransportResolution>((resolveProbe) => {
      finishProbe = resolveProbe;
    });

    const worker = runWorker(prepared.manifestPath, async () => {
      announceProbe();
      return await probe;
    });
    await probeStarted;
    expect(process.listenerCount("SIGTERM")).toBe(termListeners + 1);
    expect(process.listenerCount("SIGINT")).toBe(intListeners + 1);
    const signalWasHeld = process.emit("SIGTERM");
    finishProbe({
      status: "probe_failed",
      backend: "windows_conpty",
      errorCode: "terminal_transport_probe_failed",
      detail: "terminal transport capability probe failed",
    });

    expect(signalWasHeld).toBe(true);
    expect(await worker).toBe(1);
    expect(process.listenerCount("SIGTERM")).toBe(termListeners);
    expect(process.listenerCount("SIGINT")).toBe(intListeners);
    expect(readRunnerResult(prepared.resultPath)).toMatchObject({
      commandStarted: false,
      errorCode: "terminal_transport_probe_failed",
    });
  });

  it.each([
    [
      "child create",
      `${CONPTY_HELPER_PROTOCOL}\terror\t6\t2\n`,
      1,
      { commandStarted: false, errorCode: "spawn_failed" },
    ],
    [
      "post-start pump",
      `${CONPTY_HELPER_PROTOCOL}\tstarted\t4321\n` + `${CONPTY_HELPER_PROTOCOL}\terror\t8\t109\n`,
      4,
      { commandStarted: true, errorCode: "terminal_transport_failed" },
    ],
    [
      "malformed secret control",
      "raw-control-secret-123\n",
      4,
      { commandStarted: false, errorCode: "terminal_transport_failed" },
    ],
  ] as const)(
    "classifies %s without retaining helper control stderr",
    async (_name, control, exit, expected) => {
      const prepared = prepareManifest();
      expect(await runWorker(prepared.manifestPath, async () => fakeConpty(control, exit))).toBe(1);
      expect(readRunnerResult(prepared.resultPath)).toMatchObject(expected);
      const durable = readFileSync(prepared.resultPath, "utf8");
      expect(durable).not.toContain(CONPTY_HELPER_PROTOCOL);
      expect(durable).not.toContain("\terror\t");
      expect(durable).not.toContain("raw-control-secret-123");
    },
  );

  it("preserves an arbitrary vendor exit after the validated started frame", async () => {
    const prepared = prepareManifest();
    expect(
      await runWorker(prepared.manifestPath, async () =>
        fakeConpty(`${CONPTY_HELPER_PROTOCOL}\tstarted\t4321\n`, 42),
      ),
    ).toBe(1);
    expect(readRunnerResult(prepared.resultPath)).toMatchObject({
      commandStarted: true,
      exitCode: 42,
      signal: null,
    });
    expect(readRunnerResult(prepared.resultPath)).not.toHaveProperty("errorCode");
  });

  it("re-resolves a helper that disappears between probe and spawn", async () => {
    const prepared = prepareManifest();
    let calls = 0;
    const resolveTransport = async (): Promise<TerminalTransportResolution> => {
      calls += 1;
      if (calls === 1) return fakeConpty(`${CONPTY_HELPER_PROTOCOL}\tstarted\t1\n`, 0);
      return {
        status: "unavailable",
        backend: "windows_conpty",
        errorCode: "terminal_transport_unavailable",
        detail: "terminal transport helper is unavailable on this host",
      };
    };
    expect(
      await runWorker(prepared.manifestPath, resolveTransport, {
        spawnProcess: (() => {
          throw Object.assign(new Error("helper disappeared at spawn"), { code: "ENOENT" });
        }) as typeof spawn,
      }),
    ).toBe(1);
    expect(calls).toBe(2);
    expect(readRunnerResult(prepared.resultPath)).toMatchObject({
      commandStarted: false,
      errorCode: "terminal_transport_unavailable",
    });
  });

  it("keeps URL/input on transient streams and redacts the echoed code from failure evidence", async () => {
    const prepared = prepareManifest();
    const worker = runWorker(prepared.manifestPath, async () => fakeInteractiveConpty());
    const deadline = Date.now() + 8_000;
    for (;;) {
      const disclosure = readRunnerDeviceCode(prepared.deviceCodePath);
      if (disclosure?.verificationUrl.includes("state=conpty-secret")) break;
      if (Date.now() >= deadline) throw new Error("ConPTY URL disclosure timed out");
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    atomicPrivateJson(prepared.inputPath, {
      version: SETUP_LOGIN_PROTOCOL_VERSION,
      jobId: prepared.jobId,
      executionId: prepared.executionId,
      value: "one-shot-conpty-code-77",
      submittedAt: new Date().toISOString(),
    });
    expect(await worker).toBe(1);
    const result = readRunnerResult(prepared.resultPath);
    expect(result).toMatchObject({ commandStarted: true, exitCode: 7, signal: null });
    expect(result).not.toHaveProperty("errorCode");
    expect(result?.outputTail).toContain("?[redacted]");
    const durable = readFileSync(prepared.resultPath, "utf8");
    expect(durable).not.toContain("one-shot-conpty-code-77");
    expect(durable).not.toContain("state=conpty-secret");
    expect(durable).not.toContain("started");
  });
});

function prepareManifest(): {
  manifestPath: string;
  resultPath: string;
  deviceCodePath: string;
  inputPath: string;
  jobId: string;
  executionId: string;
} {
  const jobDir = join(root, "job");
  const profileDir = join(root, "profile");
  mkdirSync(jobDir, { recursive: true });
  mkdirSync(profileDir, { recursive: true });
  const executable = captureExecutableEvidence(process.execPath);
  const args = ["-e", "process.exit(0)"];
  const jobId = "setup-conpty";
  const executionId = "execution-conpty-1";
  const manifestPath = join(jobDir, "runner-manifest.json");
  const resultPath = join(jobDir, "runner-result.json");
  const deviceCodePath = join(jobDir, "runner-devicecode.json");
  const inputPath = join(jobDir, "runner-input.json");
  const manifest = sealLoginManifest({
    version: SETUP_LOGIN_PROTOCOL_VERSION,
    jobId,
    executionId,
    harness: "agy",
    jobDir,
    binary: process.execPath,
    args,
    cwd: jobDir,
    loginMode: "url_disclosure_with_input",
    ptyStdin: true,
    profileConfigDir: profileDir,
    deviceCodePath,
    inputPath,
    statePath: join(jobDir, "runner-state.json"),
    resultPath,
    permitPath: join(jobDir, "runner-permit.json"),
    permitDeadlineAt: new Date(Date.now() + 5_000).toISOString(),
    executable,
    commandDigest: commandDigest(executable, args),
  });
  atomicPrivateJson(manifestPath, manifest);
  atomicPrivateJson(manifest.permitPath, {
    version: SETUP_LOGIN_PROTOCOL_VERSION,
    jobId,
    executionId,
    issuedAt: new Date().toISOString(),
    commandDigest: manifest.commandDigest,
    manifestDigest: manifest.manifestDigest,
  });
  return { manifestPath, resultPath, deviceCodePath, inputPath, jobId, executionId };
}

async function runWorker(
  manifestPath: string,
  resolvePtyCommand: () => Promise<TerminalTransportResolution>,
  options: { spawnProcess?: typeof spawn } = {},
): Promise<number> {
  const previous = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = root;
  try {
    return await runSetupLoginWorker(manifestPath, {
      ...options,
      resolvePtyCommand,
      processGroupService: fakeProcessGroups(),
      selfPid: 4242,
      prepareAgyProfileKeychain: () => undefined,
    });
  } finally {
    if (previous === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = previous;
  }
}

function fakeProcessGroups(pid = 4242): ProcessGroupService {
  const leader = {
    status: "known" as const,
    pid,
    platform: "darwin" as const,
    source: "proc_pidinfo" as const,
    startToken: "darwin:1710000000:000001",
    processGroupId: pid,
  };
  const identity: ProcessIdentityReader = {
    read: (requested) =>
      requested === pid ? leader : { status: "missing", pid: requested, platform: "darwin" },
    self: () => leader,
  };
  return new ProcessGroupService({
    platform: "darwin",
    identity,
    probeProcessGroup: () => undefined,
    signalProcessGroup: () => undefined,
  });
}

function fakeConpty(control: string, exitCode: number): TerminalTransportResolution {
  const source = `process.stderr.write(${JSON.stringify(control)}); process.exit(${exitCode});`;
  return readyNodeCommand(source);
}

function fakeInteractiveConpty(): TerminalTransportResolution {
  const source = [
    `process.stderr.write(${JSON.stringify(`${CONPTY_HELPER_PROTOCOL}\tstarted\t4321\n`)});`,
    `process.stdout.write("Sign in at https://accounts.google.com/o/oauth2/");`,
    `setTimeout(() => process.stdout.write("auth?state=conpty-secret\\r\\n"), 20);`,
    `let input = "";`,
    `process.stdin.setEncoding("utf8");`,
    `process.stdin.on("data", chunk => {`,
    `  input += chunk;`,
    `  const enter = input.indexOf("\\u001b[13;28;13;1;0;1_");`,
    `  if (enter < 0) return;`,
    `  const code = [...input.slice(0, enter).matchAll(/\\u001b\\[231;0;([0-9]+);1;0;1_/g)]`,
    `    .map(match => String.fromCharCode(Number(match[1])))`,
    `    .join("");`,
    `  process.stdout.write("\\u001b[31mCODE:" + code + "\\u001b[0m\\r\\n");`,
    `  setTimeout(() => process.exit(7), 10);`,
    `});`,
    `setTimeout(() => process.exit(3), 5000);`,
  ].join("\n");
  return readyNodeCommand(source);
}

function readyNodeCommand(source: string): TerminalTransportResolution {
  return {
    status: "ready",
    backend: "windows_conpty",
    command: { binary: process.execPath, args: ["-e", source] },
    helperControlStderr: true,
  };
}
