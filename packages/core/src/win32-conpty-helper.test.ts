import {
  spawn,
  spawnSync,
  type ChildProcessByStdio,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { killWindowsProcessTree } from "./process-tree.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helper = resolve(packageRoot, "dist", "native", "claudexor-conpty-helper.exe");
const fixture = resolve(packageRoot, "dist", "native-test", "claudexor-conpty-test-child.exe");
const protocol = "claudexor-conpty-helper-v1";

describe.skipIf(process.platform !== "win32")("Win32 ConPTY helper integration", () => {
  it("probes a real HPCON and reports the frozen x64 protocol", () => {
    requireFixtures();
    const result = spawnSync(helper, ["--probe"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 4_096,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe(`${protocol}\tx64\n`);
    expect(result.stderr).toBe("");
  });

  it("round-trips the one native quote owner's spaces, quotes, slashes, empties, and Unicode", async () => {
    requireFixtures();
    const values = [
      "",
      "plain",
      "space value",
      'quote"value',
      "trailing\\",
      'slashes\\\\before"quote',
      "Привет-世界-🙂",
    ];
    const result = await runHelper(["--argv", ...values]);
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toMatch(new RegExp(`^${protocol}\\tstarted\\t[1-9][0-9]*\\r?\\n$`));
    // Real console output expands tabs and wraps long hex fields at the viewport.
    const frames = stripTerminalEscapes(result.stdout).replace(/[\r\n]/g, "");
    const decoded = [...frames.matchAll(/ARG\|(\d+)\|(\d+)\|([0-9A-F]*)\|END/g)].map(
      (fields, index) => {
        expect(Number(fields[1])).toBe(index);
        expect(fields[3]!.length).toBe(Number(fields[2]) * 4);
        return decodeUtf16Hex(fields[3]!);
      },
    );
    expect(decoded).toEqual([fixture, "--argv", ...values]);
  });

  it("preserves the vendor exit code", async () => {
    requireFixtures();
    const rejected = await runHelper(["--exit", "42"]);
    expect(rejected.code).toBe(42);
    expect(rejected.stderr).toMatch(new RegExp(`^${protocol}\\tstarted\\t[1-9][0-9]*\\r?\\n$`));
  });

  it("proves the console control before enforcing no-console and invisible-ConPTY states", async () => {
    requireFixtures();
    const control = await runDetachedFixture(["--console-control"]);
    expect(control.code).toBe(0);
    expect(control.stderr).toBe("");
    const controlState = parseConsoleState(control.stdout, "CONTROL");
    expect(controlState.consoleCodePage).toBeGreaterThan(0);
    expect(controlState.coninAvailable).toBe(true);

    const noConsole = await runDetachedFixture(["--console-state"]);
    expect(noConsole.code).toBe(0);
    expect(parseConsoleState(noConsole.stdout, "CONSOLE")).toEqual({
      consoleCodePage: 0,
      windowPresent: false,
      windowVisible: false,
      coninAvailable: false,
    });

    const conpty = await runHelper(["--console-state"]);
    expect(conpty.code).toBe(0);
    const conptyState = parseConsoleState(conpty.stdout, "CONSOLE");
    expect(conptyState.consoleCodePage).toBeGreaterThan(0);
    expect(conptyState.windowVisible).toBe(false);
    expect(conptyState.coninAvailable).toBe(true);
  });

  it("drains synchronous output through immediate child exit", async () => {
    requireFixtures();
    const slow = await runHelper(["--slow-drain"]);
    expect(slow.code).toBe(0);
    expect(Buffer.byteLength(slow.stdout, "utf8")).toBeGreaterThan(64 * 1024);
  });

  it("measures Win32 records versus UTF-8 CR (diagnostic, not acceptance)", async () => {
    requireFixtures();
    const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    const conhost = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\\conhost.exe')).VersionInfo.FileVersion",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 5_000 },
    );
    console.log(
      "CONPTY_INPUT_PROVENANCE",
      JSON.stringify({
        source: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
        node: process.versions.node,
        uv: process.versions.uv,
        os: release(),
        image: process.env.ImageVersion ?? null,
        conhost: conhost.stdout?.trim() ?? null,
        conhostStatus: conhost.status,
        helperSha256: sha256(helper),
        fixtureSha256: sha256(fixture),
        order: "ABBA".repeat(4),
        readyMs: 5_000,
        readMs: 5_000,
        cleanupMs: 5_000,
      }),
    );
    const payload = "one-shot-win32-code-77";
    // Frozen A bytes match setup-login-io.ts; this does not change its encoder.
    const record = (vk: number, sc: number, uc: number, down: number) =>
      `\u001b[${vk};${sc};${uc};${down};0;1_`;
    const records = [...payload].flatMap((c) => [
      record(231, 0, c.charCodeAt(0), 1),
      record(231, 0, c.charCodeAt(0), 0),
    ]);
    records.push(record(13, 28, 13, 1), record(13, 28, 13, 0));
    const measurements: Array<{ ready: boolean; cleanup: boolean }> = [];
    // Eight pairs, counterbalanced and serial; a bad arm remains an outcome.
    for (const [index, arm] of [..."ABBA".repeat(4)].entries()) {
      const root = mkdtempSync(join(tmpdir(), "conpty-input-probe-"));
      const child = spawn(helper, ["--", fixture, "--input-probe"], {
        windowsHide: true,
        shell: false,
        detached: false,
        stdio: ["pipe", "pipe", "pipe"],
        cwd: root,
      });
      let raw = "",
        control = "",
        stopped = false,
        vendorPid = 0;
      let completedWrites = 0,
        attemptedWrites = 0,
        completedBytes = 0;
      let writeError: string | null = null,
        processError: string | null = null;
      let readyFields: number[] | null = null;
      let resolveReady!: (ready: boolean) => void;
      const ready = new Promise<boolean>((done) => {
        resolveReady = done;
      });
      const finished = collect(child).catch((error: NodeJS.ErrnoException) => {
        processError = error.code ?? "process_error";
        return null;
      });
      child.stdout.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
        const match = /INPUT_READY\|(\d+)\|(\d+)\|([01])\|(\d+)\|(\d+)\|(\d+)\|END/.exec(
          stripTerminalEscapes(raw),
        );
        if (match) {
          readyFields = match.slice(1).map(Number);
          resolveReady(true);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        control += chunk.toString("ascii");
        vendorPid = Number(
          new RegExp(`${protocol}\\tstarted\\t([1-9][0-9]*)\\r?\\n`).exec(control)?.[1] ?? 0,
        );
      });
      child.once("close", () => resolveReady(false));
      child.once("error", () => resolveReady(false));
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        writeError ??= error.code ?? "write_error";
      });
      const chunks = arm === "A" ? records : [`${payload}\r`];
      const send = (offset = 0): void => {
        if (stopped || offset >= chunks.length || child.stdin.destroyed) return;
        attemptedWrites++;
        child.stdin.write(chunks[offset]!, (error?: Error | null) => {
          if (error) {
            writeError ??= (error as NodeJS.ErrnoException).code ?? "write_error";
            return;
          }
          completedWrites++;
          completedBytes += Buffer.byteLength(chunks[offset]!);
          send(offset + 1);
        });
      };
      let phase = "ready",
        timedOut = false,
        readySeen = false,
        cleaned = false;
      let result: CollectedChild | null = null;
      try {
        readySeen = await withTimeout(ready, 5_000, "input diagnostic ready");
        if (readySeen) {
          phase = "read";
          try {
            send();
          } catch (error) {
            writeError ??= (error as NodeJS.ErrnoException).code ?? "write_error";
          }
        }
        result = await withTimeout(finished, 5_000, "input diagnostic read");
        phase = "closed";
      } catch {
        timedOut = true;
      } finally {
        stopped = true;
        const beforeCleanup = { completedWrites, attemptedWrites, completedBytes, writeError };
        const returned = /INPUT_RETURNED\|([01])\|(\d+)\|([01])\|([01])\|END/.exec(
          stripTerminalEscapes(raw),
        );
        const pids = [child.pid ?? 0, vendorPid].filter((pid) => pid > 0);
        const aliveBeforeCleanup = pids.map((pid) => ({ pid, alive: pidAlive(pid) }));
        try {
          cleanupPids(pids);
          await withTimeout(
            Promise.all([expectPidsGone(pids), finished]),
            5_000,
            "input diagnostic cleanup",
          );
          cleaned = true;
        } finally {
          console.log(
            "CONPTY_INPUT_MEASUREMENT",
            JSON.stringify({
              index,
              arm,
              phase,
              timedOut,
              ready: readyFields,
              returned: returned?.slice(1).map(Number) ?? null,
              win32ModeRequested: raw.includes("\u001b[?9001h"),
              plannedWrites: chunks.length,
              plannedBytes: chunks.reduce((n, s) => n + Buffer.byteLength(s), 0),
              ...beforeCleanup,
              processError,
              exit: result?.code ?? null,
              signal: result?.signal ?? null,
              aliveBeforeCleanup,
              cleanup: cleaned,
            }),
          );
          rmSync(root, { recursive: true, force: true });
        }
      }
      measurements.push({ ready: readySeen, cleanup: cleaned });
    }
    // Instrument health only. Native read success/failure is data, never a
    // substitute for the unchanged mandatory production-shaped acceptance.
    console.log("CONPTY_INPUT_MEASUREMENT_COMPLETE", "16 cases; product acceptance NOT_EVALUATED");
    expect(conhost.status).toBe(0);
    expect(measurements).toHaveLength(16);
    expect(measurements.every((m) => m.ready && m.cleanup)).toBe(true);
  }, 300_000);

  it("types a child pre-start failure without claiming vendor start", async () => {
    requireFixtures();
    const missing = resolve(dirname(fixture), "missing-conpty-vendor.exe");
    const beforeStart = spawn(helper, ["--", missing], {
      windowsHide: true,
      shell: false,
      detached: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    beforeStart.stdin.end();
    const preStart = await withTimeout(collect(beforeStart), 10_000, "pre-start helper failure");
    expect(preStart.code).toBe(1);
    expect(preStart.stdout).toBe("");
    expect(preStart.stderr).toMatch(new RegExp(`^${protocol}\\terror\\t6\\t[0-9]+\\r?\\n$`));
  });

  it.each(["cancel", "timeout"] as const)(
    "the existing absolute taskkill %s path leaves no worker/helper/vendor/descendant",
    async () => {
      requireFixtures();
      const worker = spawnWorkerTree();
      const observedPids = observeWorkerTreePids(worker);
      const finished = collect(worker);
      if (!worker.pid) throw new Error("worker PID was not assigned");
      const workerPid = worker.pid;
      let helperPid = 0;
      let vendorPid = 0;
      let descendantPid = 0;

      try {
        ({ helperPid, vendorPid, descendantPid } = await observedPids);
        const treePids = [workerPid, helperPid, vendorPid, descendantPid];
        expect(treePids.every(pidAlive)).toBe(true);
        const termination = killWindowsProcessTree(workerPid);
        expect(termination.pid).toBe(workerPid);
        // taskkill can return a non-zero aggregate result when one enumerated
        // member exits during /T. Root liveness owns not_found; the exact
        // four-process postcondition below remains the whole-tree authority.
        expect(termination.status).not.toBe("not_found");
        await withTimeout(finished, 10_000, "worker tree taskkill");
        await expectPidsGone(treePids);
      } finally {
        cleanupPids([workerPid, helperPid, vendorPid, descendantPid]);
      }
    },
  );
});

function requireFixtures(): void {
  expect(existsSync(helper), `missing helper: ${helper}`).toBe(true);
  expect(existsSync(fixture), `missing fixture: ${fixture}`).toBe(true);
}

function spawnHelper(args: string[]): ChildProcessWithoutNullStreams {
  return spawn(helper, ["--", fixture, ...args], {
    windowsHide: true,
    shell: false,
    detached: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function spawnWorkerTree(): ChildProcessWithoutNullStreams {
  const source = [
    `const { spawn } = require("node:child_process");`,
    `const child = spawn(${JSON.stringify(helper)}, ["--", ${JSON.stringify(fixture)}, "--spawn-descendant"], {`,
    `  windowsHide: true, shell: false, detached: false, stdio: ["pipe", "pipe", "pipe"]`,
    `});`,
    `process.stdout.write("WORKER\\t" + process.pid + "\\t" + child.pid + "\\n");`,
    `child.stdout.pipe(process.stdout);`,
    `child.stderr.pipe(process.stderr);`,
    `child.once("error", () => process.exit(91));`,
    `child.once("exit", (code) => process.exit(code === 0 ? 0 : 92));`,
  ].join("\n");
  return spawn(process.execPath, ["-e", source], {
    windowsHide: true,
    shell: false,
    detached: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function runDetachedFixture(args: string[]): Promise<CollectedChild> {
  const child = spawn(fixture, args, {
    windowsHide: true,
    shell: false,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return await withTimeout(collect(child), 5_000, "detached fixture");
}

async function runHelper(args: string[]): Promise<CollectedChild> {
  const child = spawnHelper(args);
  // Keep ConPTY input open until the helper exits. Closing it early sends a
  // CTRL+C-style termination to attached clients on current Windows builds.
  return await collect(child);
}

interface CollectedChild {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

async function collect(
  child: ChildProcessByStdio<Writable | null, Readable, Readable>,
): Promise<CollectedChild> {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("ascii");
  });
  return await new Promise<CollectedChild>((resolveChild, rejectChild) => {
    child.once("error", rejectChild);
    child.once("close", (code, signal) => resolveChild({ code, signal, stdout, stderr }));
  });
}

function decodeUtf16Hex(hex: string): string {
  let value = "";
  for (let offset = 0; offset < hex.length; offset += 4) {
    value += String.fromCharCode(Number.parseInt(hex.slice(offset, offset + 4), 16));
  }
  return value;
}

function parseConsoleState(
  output: string,
  label: string,
): {
  consoleCodePage: number;
  windowPresent: boolean;
  windowVisible: boolean;
  coninAvailable: boolean;
} {
  const match = new RegExp(`^${label}\\|([0-9]+)\\|([01])\\|([01])\\|([01])\\|END$`).exec(
    stripTerminalEscapes(output).trim(),
  );
  if (!match) throw new Error(`invalid ${label} console state`);
  return {
    consoleCodePage: Number(match[1]),
    windowPresent: match[2] === "1",
    windowVisible: match[3] === "1",
    coninAvailable: match[4] === "1",
  };
}

// ConPTY can bracket child output with terminal-mode escape sequences. They
// are transport noise, not part of the fixture's argv or console-state wire.
function stripTerminalEscapes(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(
    /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?)/g,
    "",
  );
}

async function observeWorkerTreePids(child: ChildProcessWithoutNullStreams): Promise<{
  helperPid: number;
  vendorPid: number;
  descendantPid: number;
}> {
  let stdout = "";
  return await new Promise((resolvePids, rejectPids) => {
    const timer = setTimeout(() => rejectPids(new Error("worker tree PID lines timed out")), 8_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const worker = /WORKER\t([1-9][0-9]*)\t([1-9][0-9]*)/.exec(stdout);
      const vendor = /PIDS\|([1-9][0-9]*)\|([1-9][0-9]*)\|END/.exec(stdout);
      if (!worker || !vendor) return;
      clearTimeout(timer);
      resolvePids({
        helperPid: Number(worker[2]),
        vendorPid: Number(vendor[1]),
        descendantPid: Number(vendor[2]),
      });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPids(error);
    });
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function expectPidsGone(pids: number[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (pids.some(pidAlive)) {
    if (Date.now() >= deadline) throw new Error(`processes survived taskkill: ${pids.join(",")}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function cleanupPids(pids: number[]): void {
  for (const pid of pids) {
    if (pid > 0 && pidAlive(pid)) killWindowsProcessTree(pid);
  }
}
