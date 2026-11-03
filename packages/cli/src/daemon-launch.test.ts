import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLI_DAEMON_LAUNCH_SOURCES,
  DAEMON_LAUNCH_SOURCE_ENV,
  capturePreAuthorityStderr,
  daemonLaunchEnvironment,
  launchDetachedDaemon,
} from "./daemon-launch.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "claudexor-daemon-launch-"));
  roots.push(value);
  return value;
}

async function waitForFile(path: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await delay(20);
  }
}

async function waitForFileContent(
  path: string,
  expected: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) || readFileSync(path, "utf8") !== expected) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path} = ${expected}`);
    await delay(20);
  }
}

function killIfRunning(pid: number | null): void {
  if (pid === null) return;
  try {
    process.kill(pid);
  } catch {
    // The exact test child already exited.
  }
}

describe("bounded caller-side daemon launch adapter", () => {
  it("adds exact launch provenance without mutating or dropping the caller environment", () => {
    const base = { HOME: "/tmp/home", KEEP_ME: "yes" };
    const env = daemonLaunchEnvironment(base, CLI_DAEMON_LAUNCH_SOURCES.ensureDaemon);
    expect(env).toMatchObject({
      HOME: "/tmp/home",
      KEEP_ME: "yes",
      [DAEMON_LAUNCH_SOURCE_ENV]: "cli_ensure_daemon",
    });
    expect(base).toEqual({ HOME: "/tmp/home", KEEP_ME: "yes" });
  });

  it("sheds an inherited run scope marker but keeps an installation marker and every other key (both directions)", () => {
    const run = `CLAUDEXOR_RUN_SCOPE_${"a".repeat(32)}`;
    const install = `OURO_INSTALL_SCOPE_${"b".repeat(32)}`;
    const base = { HOME: "/tmp/home", [run]: "1", [install]: "1", KEEP_ME: "yes" };
    const env = daemonLaunchEnvironment(base, CLI_DAEMON_LAUNCH_SOURCES.ensureDaemon);
    expect(run in env).toBe(false);
    expect(env[install]).toBe("1");
    expect(env["KEEP_ME"]).toBe("yes");
    expect(env["HOME"]).toBe("/tmp/home");
    expect(base[run]).toBe("1"); // the caller env is not mutated
  });

  it("retains stderr after the parent-side data handler observes it", async () => {
    const stream = new PassThrough();
    const capture = capturePreAuthorityStderr(stream);
    const observed = new Promise<void>((resolve) => stream.once("data", () => resolve()));

    stream.write("parent-observed stderr\n");
    await observed;

    expect(capture.evidence()).toMatchObject({
      kind: "retained",
      message: expect.stringContaining("parent-observed stderr"),
    });
    capture.destroyAndDiscard();
  });

  it("makes a real missing-module import failure visible without forging the daemon-owned log", async () => {
    const dataRoot = root();
    const entry = join(dataRoot, "exit-before-claim.mjs");
    const sourceReceipt = join(dataRoot, "launch-source.txt");
    writeFileSync(
      entry,
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(sourceReceipt)}, process.env.CLAUDEXOR_DAEMON_LAUNCH_SOURCE || "missing");`,
        'await import("./missing-preclaim-module.mjs");',
      ].join("\n"),
    );

    const launch = launchDetachedDaemon({
      entryPath: entry,
      launchSource: CLI_DAEMON_LAUNCH_SOURCES.explicitStart,
      env: { ...process.env, CLAUDEXOR_CONFIG_DIR: dataRoot },
    });
    const failure = await launch.waitForFailure();

    expect(failure).toMatchObject({
      kind: "preclaim_exit",
      exitCode: 1,
      stderr: {
        kind: "retained",
        message: expect.stringMatching(/ERR_MODULE_NOT_FOUND|Cannot find module/),
      },
    });
    expect(JSON.stringify(failure)).toContain("missing-preclaim-module.mjs");
    expect(readFileSync(sourceReceipt, "utf8")).toBe("cli_explicit_start");
    expect(() => readFileSync(join(dataRoot, "daemon", "claudexord.log"), "utf8")).toThrow();
    const error = launch.callerError("startup_wait", 15_000);
    expect(error.code).toBe("daemon_start_failed");
    expect(error.requiredActions?.join(" ")).toContain("daemon logs");
    expect(error.requiredActions?.join(" ")).toMatch(/fixed runtime|eligible/i);
    expect(JSON.stringify(error.context)).toContain("preclaim_exit");
    expect(error.message).toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/);
  });

  it("redacts a secret crossing the 2k projection boundary before bounding stderr", async () => {
    const dataRoot = root();
    const entry = join(dataRoot, "secret-stderr.cjs");
    const token = `sk-${"a".repeat(40)}`;
    const raw = `${"p".repeat(1_984)} ${token} TAIL`;
    writeFileSync(entry, `process.stderr.write(${JSON.stringify(raw)}); process.exitCode = 9;\n`);

    const launch = launchDetachedDaemon({
      entryPath: entry,
      launchSource: CLI_DAEMON_LAUNCH_SOURCES.ensureDaemon,
      env: { ...process.env, CLAUDEXOR_CONFIG_DIR: dataRoot },
    });
    const failure = await launch.waitForFailure();
    expect(failure).toMatchObject({
      kind: "preclaim_exit",
      stderr: { kind: "retained", message: expect.stringContaining("[redacted]") },
    });
    const projected = JSON.stringify(failure);
    expect(projected).not.toContain(token);
    expect(projected).not.toContain(token.slice(0, 15));
    const error = launch.callerError("socket_wait", 30_000);
    expect(error.message).not.toContain(token);
    expect(JSON.stringify(error.context)).not.toContain(token);
  });

  it("discards every raw stderr byte on overflow and exposes only the typed marker", async () => {
    const dataRoot = root();
    const entry = join(dataRoot, "oversize-stderr.cjs");
    const rawBytes = 64 * 1_024 + 1;
    writeFileSync(
      entry,
      `process.stderr.write("RAW-BEGIN|" + "x".repeat(${rawBytes}) + "|RAW-END"); process.exitCode = 11;\n`,
    );

    const launch = launchDetachedDaemon({
      entryPath: entry,
      launchSource: CLI_DAEMON_LAUNCH_SOURCES.ensureDaemon,
      env: { ...process.env, CLAUDEXOR_CONFIG_DIR: dataRoot },
    });
    const failure = await launch.waitForFailure();
    expect(failure).toMatchObject({
      kind: "preclaim_exit",
      stderr: { kind: "oversize_discarded" },
    });
    const error = launch.callerError("socket_wait", 30_000);
    const projected = JSON.stringify({ failure, message: error.message, context: error.context });
    expect(projected).toContain("oversize_discarded");
    expect(projected).not.toContain("RAW-BEGIN");
    expect(projected).not.toContain("RAW-END");
  });

  it("markReady closes the transient stderr pipe and ignores the later child close", async () => {
    const dataRoot = root();
    const entry = join(dataRoot, "ready-stderr.cjs");
    const started = join(dataRoot, "started.txt");
    const pipeClosed = join(dataRoot, "pipe-closed.txt");
    writeFileSync(
      entry,
      [
        'const fs = require("node:fs");',
        `process.stderr.on("error", (error) => { fs.writeFileSync(${JSON.stringify(pipeClosed)}, error.code || "error"); process.exit(0); });`,
        `fs.writeFileSync(${JSON.stringify(started)}, "started");`,
        'setInterval(() => process.stderr.write("pre-authority stderr\\n"), 10);',
        "setTimeout(() => process.exit(2), 5000);",
      ].join("\n"),
    );
    const launch = launchDetachedDaemon({
      entryPath: entry,
      launchSource: CLI_DAEMON_LAUNCH_SOURCES.explicitStart,
      env: { ...process.env, CLAUDEXOR_CONFIG_DIR: dataRoot },
    });
    try {
      await waitForFile(started);
      launch.markReady();
      await waitForFileContent(pipeClosed, "EPIPE");
      expect(readFileSync(pipeClosed, "utf8")).toBe("EPIPE");
      await delay(30);
      expect(launch.failure()).toBeNull();
    } finally {
      killIfRunning(launch.pid);
    }
  });

  it("a terminal caller timeout types its stderr evidence and closes the pipe", async () => {
    const dataRoot = root();
    const entry = join(dataRoot, "timeout-stderr.cjs");
    const started = join(dataRoot, "started.txt");
    const pipeClosed = join(dataRoot, "pipe-closed.txt");
    writeFileSync(
      entry,
      [
        'const fs = require("node:fs");',
        `process.stderr.on("error", (error) => { fs.writeFileSync(${JSON.stringify(pipeClosed)}, error.code || "error"); process.exit(0); });`,
        `fs.writeFileSync(${JSON.stringify(started)}, "started");`,
        'setInterval(() => process.stderr.write("waiting for readiness\\n"), 10);',
        "setTimeout(() => process.exit(2), 5000);",
      ].join("\n"),
    );
    const launch = launchDetachedDaemon({
      entryPath: entry,
      launchSource: CLI_DAEMON_LAUNCH_SOURCES.ensureDaemon,
      env: { ...process.env, CLAUDEXOR_CONFIG_DIR: dataRoot },
    });
    try {
      await waitForFile(started);
      const error = launch.callerError("socket_wait", 1);
      expect(launch.failure()).toMatchObject({
        kind: "startup_timeout",
      });
      expect(JSON.stringify(error.context)).toContain("startup_timeout");
      await waitForFileContent(pipeClosed, "EPIPE");
      expect(readFileSync(pipeClosed, "utf8")).toBe("EPIPE");
    } finally {
      killIfRunning(launch.pid);
    }
  });

  it("bounds and types a spawn refusal before any daemon authority exists", async () => {
    const dataRoot = root();
    const entry = join(dataRoot, "entry.cjs");
    writeFileSync(entry, "setInterval(() => {}, 1000);\n");
    const launch = launchDetachedDaemon({
      entryPath: entry,
      launchSource: CLI_DAEMON_LAUNCH_SOURCES.ensureDaemon,
      env: { ...process.env, CLAUDEXOR_CONFIG_DIR: dataRoot },
      nodePath: join(dataRoot, `missing-node-${"x".repeat(5000)}`),
    });
    const failure = await launch.waitForFailure();
    expect(failure?.kind).toBe("spawn_error");
    const error = launch.callerError("spawn", 30_000);
    expect(error.code).toBe("daemon_start_failed");
    expect(error.message.length).toBeLessThanOrEqual(2_000);
    expect(JSON.stringify(error.context).length).toBeLessThan(8_192);
  });

  it("refuses a missing entry as an actionable typed pre-spawn error", () => {
    const dataRoot = root();
    expect(() =>
      launchDetachedDaemon({
        entryPath: join(dataRoot, "missing-claudexord.js"),
        launchSource: CLI_DAEMON_LAUNCH_SOURCES.ensureDaemon,
        env: { ...process.env, CLAUDEXOR_CONFIG_DIR: dataRoot },
      }),
    ).toThrow(
      expect.objectContaining({
        code: "daemon_entry_missing",
        retryable: false,
      }),
    );
  });
});
