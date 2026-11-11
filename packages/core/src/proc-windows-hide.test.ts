import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// A pass-through spy over the REAL spawn: the recorded options prove the window
// policy on every platform, while each child still runs for real, so the
// Windows CI leg consumes the hidden-console spawn instead of a fake.
const spawnSpy = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  spawnSpy.mockImplementation(actual.spawn);
  return { ...actual, spawn: spawnSpy };
});

import { runCapture, runCaptureRaw, spawnProcess, type SpawnOptions } from "./proc.js";
import { backgroundSpawnShape } from "./runtime-env.js";

const PIPED = { stdio: ["pipe", "pipe", "pipe"] };

describe("background spawn shape", () => {
  it("detaches on POSIX and gives Windows an invisible console unless a consumer asks for none", () => {
    for (const platform of ["linux", "darwin"] as const) {
      expect(backgroundSpawnShape(platform)).toEqual({ detached: true, windowsHide: true });
      expect(backgroundSpawnShape(platform, "none")).toEqual({ detached: true, windowsHide: true });
    }
    expect(backgroundSpawnShape("win32")).toEqual({ detached: false, windowsHide: true });
    expect(backgroundSpawnShape("win32", "hidden")).toEqual({ detached: false, windowsHide: true });
    expect(backgroundSpawnShape("win32", "none")).toEqual({ detached: true, windowsHide: true });
  });

  it("starts streamed children with piped stdio in that shape", async () => {
    const stdout: string[] = [];
    let exitCode: number | null | undefined;
    for await (const ev of spawnProcess(process.execPath, ["-e", "console.log('probe-ok')"])) {
      if (ev.type === "stdout") stdout.push(ev.line);
      if (ev.type === "exit") exitCode = ev.code;
    }

    expect(stdout).toEqual(["probe-ok"]);
    expect(exitCode).toBe(0);
    expect(spawnSpy).toHaveBeenCalledOnce();
    expect(spawnSpy.mock.calls[0]?.[2]).toMatchObject({ ...backgroundSpawnShape(), ...PIPED });
  });

  it("starts raw capture children with piped stdio in that shape", async () => {
    const result = await runCaptureRaw(process.execPath, [
      "-e",
      "process.stdout.write('a\\r\\nb')",
    ]);

    expect(result).toMatchObject({ code: 0, signal: null, stdout: "a\r\nb" });
    expect(spawnSpy).toHaveBeenCalledOnce();
    expect(spawnSpy.mock.calls[0]?.[2]).toMatchObject({ ...backgroundSpawnShape(), ...PIPED });
  });

  it("passes a consumer's console policy to both spawners", async () => {
    const none: SpawnOptions = { windowsConsole: "none" };
    expect((await runCapture(process.execPath, ["-e", "0"], none)).code).toBe(0);
    expect((await runCaptureRaw(process.execPath, ["-e", "0"], none)).code).toBe(0);
    const shape = { ...backgroundSpawnShape(process.platform, "none"), ...PIPED };
    expect(spawnSpy.mock.calls.map((call) => call[2])).toEqual([
      expect.objectContaining(shape),
      expect.objectContaining(shape),
    ]);
  });
});

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = resolve(packageRoot, "dist", "native-test", "claudexor-conpty-test-child.exe");
// An npm wrapper's shape: its native child gets no options of its own (Codex's wrapper).
const INHERITING_WRAPPER =
  'const r = require("node:child_process").spawnSync(process.argv[1], ["--console-state"], ' +
  '{ stdio: "inherit" }); process.exit(r.status ?? 1);';

interface ConsoleState {
  consoleCodePage: number;
  windowPresent: boolean;
  windowVisible: boolean;
  coninAvailable: boolean;
}

// The console-less shape the engine used before (and agy still selects) is the
// control: a console program its child starts gets a console window of its
// own, so the probes below can see the defect they rule out. A Windows Terminal
// default host shows that window as a pseudo-console window, hence the control
// asserts a window exists rather than its visibility.
describe.skipIf(process.platform !== "win32")("Windows console of background children", () => {
  it("gives the direct child an invisible console it can read input from", async () => {
    requireFixture();
    for (const capture of [runCapture, runCaptureRaw]) {
      const state = consoleState((await capture(fixture, ["--console-state"])).stdout);
      expect(state).toEqual({
        consoleCodePage: expect.any(Number),
        windowPresent: false,
        windowVisible: false,
        // An openable CONIN$ is why agy keeps the console-less shape.
        coninAvailable: true,
      });
      expect(state.consoleCodePage).toBeGreaterThan(0);
    }
  });

  it.each([
    [
      "a native program",
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/c", fixture, "--console-state"],
    ],
    ["a Node wrapper's inheriting child", process.execPath, ["-e", INHERITING_WRAPPER, fixture]],
  ])("lets %s inherit that console instead of opening a window", async (_label, bin, args) => {
    requireFixture();
    const inherited = consoleState((await runCapture(bin, args)).stdout);
    expect(inherited, JSON.stringify(inherited)).toMatchObject({
      windowPresent: false,
      windowVisible: false,
    });
    expect(inherited.consoleCodePage).toBeGreaterThan(0);
  });

  it("gives that grandchild a console window of its own in the console-less shape", async () => {
    requireFixture();
    // The control runs through the Node wrapper, which hands its pipes to the grandchild
    // explicitly, so the report still reaches the capture from inside a new console.
    const wrapper = ["-e", INHERITING_WRAPPER, fixture];
    const control = consoleState(
      (await runCapture(process.execPath, wrapper, { windowsConsole: "none" })).stdout,
    );
    expect(control.windowPresent, JSON.stringify(control)).toBe(true);
    expect(control.consoleCodePage).toBeGreaterThan(0);
  });

  it("still stops the whole tree on abort and leaves an unrelated process alone", async () => {
    requireFixture();
    const bystander = startFixture(["--wait"]);
    try {
      const abort = new AbortController();
      let pids: [number, number] | undefined;
      for await (const ev of spawnProcess(fixture, ["--spawn-descendant"], {
        abortSignal: abort.signal,
      })) {
        if (ev.type === "stdout" && ev.line.startsWith("PIDS|")) {
          pids = parsePids(ev.line);
          abort.abort();
        }
      }
      expect(pids).toBeDefined();
      for (const pid of pids!) expect(await goneWithin(pid, 10_000), `pid ${pid}`).toBe(true);
      expect(alive(bystander.pid!)).toBe(true);
    } finally {
      stopTree(bystander.pid);
    }
  });

  it.each([
    ["hidden", true],
    ["none", false],
  ] as const)(
    "a %s-console child of a daemon that dies abruptly ends with it: %s",
    async (windowsConsole, ends) => {
      requireFixture();
      const daemon = startDaemon(backgroundSpawnShape("win32", windowsConsole));
      let pids: [number, number] | undefined;
      try {
        pids = parsePids(await firstLine(daemon, "PIDS|"));
        daemon.kill("SIGKILL");
        // libuv's kill-on-close Job holds the direct child only (its descendants
        // never join it), so only the direct child's fate is the claim here.
        expect(await goneWithin(pids[0], 5_000)).toBe(ends);
      } finally {
        if (pids) for (const pid of pids) stopTree(pid);
        stopTree(daemon.pid);
      }
    },
  );
});

function requireFixture(): void {
  expect(existsSync(fixture), `missing fixture: ${fixture}`).toBe(true);
}

function consoleState(output: string): ConsoleState {
  const match = /CONSOLE\|([0-9]+)\|([01])\|([01])\|([01])\|END/.exec(output);
  if (!match) throw new Error(`no console state in ${JSON.stringify(output)}`);
  return {
    consoleCodePage: Number(match[1]),
    windowPresent: match[2] === "1",
    windowVisible: match[3] === "1",
    coninAvailable: match[4] === "1",
  };
}

function parsePids(line: string): [number, number] {
  const match = /PIDS\|([0-9]+)\|([0-9]+)\|END/.exec(line);
  if (!match) throw new Error(`no pids in ${JSON.stringify(line)}`);
  return [Number(match[1]), Number(match[2])];
}

function startFixture(args: string[]): ChildProcessWithoutNullStreams {
  return spawn(fixture, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
}

// A stand-in daemon: one Node process starting the fixture in the given shape.
function startDaemon(shape: { detached: boolean; windowsHide: true }) {
  const source = [
    `const { spawn } = require("node:child_process");`,
    `const child = spawn(process.argv[1], ["--spawn-descendant"], { ...JSON.parse(process.argv[2]), stdio: ["pipe", "pipe", "pipe"] });`,
    `child.stdout.pipe(process.stdout);`,
    `setInterval(() => {}, 1000);`,
  ].join("\n");
  return spawn(process.execPath, ["-e", source, fixture, JSON.stringify(shape)], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function firstLine(child: ChildProcessWithoutNullStreams, prefix: string): Promise<string> {
  return await new Promise<string>((resolveLine, rejectLine) => {
    let buffered = "";
    const timer = setTimeout(() => rejectLine(new Error(`no ${prefix} line`)), 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const line = buffered.split(/\r?\n/).find((candidate) => candidate.startsWith(prefix));
      if (line) {
        clearTimeout(timer);
        resolveLine(line);
      }
    });
    child.once("error", rejectLine);
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function goneWithin(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return true;
}

function stopTree(pid: number | undefined): void {
  if (pid === undefined || !alive(pid)) return;
  spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
}
