import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient, ensureToken, logPath } from "@claudexor/daemon";
import { CLAUDEXOR_VERSION } from "@claudexor/util";
import { parseArgs } from "./args.js";
import { CliError } from "./cli-error.js";
import * as daemonLaunch from "./daemon-launch.js";
import * as daemonRun from "./daemon-run.js";
import { rareHistoryPath } from "./daemon-rare-history.js";
import * as diagnostics from "./startup-diagnostics.js";
import { daemonCommand } from "./ops-commands.js";
import { projectCommand } from "./project-command.js";

/** Capture the single JSON object printed on stdout across an async command. */
async function captureJson(fn: () => Promise<number>): Promise<{
  code: number;
  env: Record<string, unknown>;
}> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
    chunks.push(String(s));
    return true;
  });
  let code = -1;
  try {
    code = await fn();
  } finally {
    spy.mockRestore();
  }
  expect(chunks).toHaveLength(1);
  return { code, env: JSON.parse(chunks[0] as string) as Record<string, unknown> };
}

describe("ops-commands: ad-hoc failure envelopes route through the ONE projector (Ф2)", () => {
  let configDir: string;
  let prevConfigDir: string | undefined;
  let prevDaemonEntry: string | undefined;

  beforeEach(() => {
    // Hermetic: an empty config dir means no daemon token on disk.
    configDir = realpathSync(mkdtempSync(join(tmpdir(), "clawdexor-ops-")));
    prevConfigDir = process.env["CLAUDEXOR_CONFIG_DIR"];
    prevDaemonEntry = process.env["CLAUDEXOR_DAEMON_ENTRY"];
    process.env["CLAUDEXOR_CONFIG_DIR"] = configDir;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env["CLAUDEXOR_CONFIG_DIR"];
    else process.env["CLAUDEXOR_CONFIG_DIR"] = prevConfigDir;
    if (prevDaemonEntry === undefined) delete process.env["CLAUDEXOR_DAEMON_ENTRY"];
    else process.env["CLAUDEXOR_DAEMON_ENTRY"] = prevDaemonEntry;
    rmSync(configDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  }, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

  it("`daemon status` with no token yields the canonical {ok,exitCode,message,error} envelope", async () => {
    const { code, env } = await captureJson(() =>
      daemonCommand(parseArgs(["daemon", "status"]), true),
    );
    expect(code).toBe(1);
    // Previously this was a message-less {ok:false,error} straggler; the projector
    // now guarantees the full canonical shape.
    expect(env["ok"]).toBe(false);
    expect(env["exitCode"]).toBe(1);
    expect(env["message"]).toContain("daemon not initialized");
    // Legacy alias preserved for existing consumers.
    expect(env["error"]).toBe(env["message"]);
  });

  it("`daemon bogus` (unknown subcommand) is a usage failure, exit 2, via the projector", async () => {
    // Seed a token so the switch reaches the usage default rather than the
    // no-token branch (a constructed DaemonClient makes no network call here).
    ensureToken();
    const { code, env } = await captureJson(() =>
      daemonCommand(parseArgs(["daemon", "bogus"]), true),
    );
    expect(code).toBe(2);
    expect(env["ok"]).toBe(false);
    expect(env["exitCode"]).toBe(2);
    expect(String(env["message"])).toContain("usage: claudexor daemon");
    expect(env["error"]).toBe(env["message"]);
  });

  it("`daemon logs` projects typed omission instead of bytes from an oversized legacy log", async () => {
    mkdirSync(join(configDir, "daemon"), { recursive: true, mode: 0o700 });
    writeFileSync(logPath(), "x".repeat(256 * 1024 + 1), { mode: 0o600 });

    const { code, env } = await captureJson(() =>
      daemonCommand(parseArgs(["daemon", "logs"]), true),
    );

    expect(code).toBe(0);
    expect(env).toEqual({
      ok: true,
      log_tail:
        "[daemon diagnostic tail omitted (claudexord.log): oversize_omitted; 262145 bytes exceeds the 262144-byte safe read limit]\n",
    });
  });

  it("`daemon logs` adds the rare history after the log tail when one exists", async () => {
    mkdirSync(join(configDir, "daemon"), { recursive: true, mode: 0o700 });
    writeFileSync(logPath(), "[t] quota.observation {}\n", { mode: 0o600 });
    writeFileSync(`${rareHistoryPath()}.1`, "older stall\n", { mode: 0o600 });
    writeFileSync(rareHistoryPath(), "shutdown requested (SIGTERM)\n", { mode: 0o600 });

    const { env } = await captureJson(() => daemonCommand(parseArgs(["daemon", "logs"]), true));

    expect(env).toEqual({
      ok: true,
      log_tail: "[t] quota.observation {}\n",
      rare_tail: "older stall\nshutdown requested (SIGTERM)\n",
    });
  });

  it("shows a retained rare line and names the missing primary log in text and JSON", async () => {
    mkdirSync(join(configDir, "daemon"), { recursive: true, mode: 0o700 });
    writeFileSync(`${rareHistoryPath()}.1`, "older stall\n", { mode: 0o600 });
    const args = parseArgs(["daemon", "logs"]);
    const { code, env } = await captureJson(() => daemonCommand(args, true));
    expect(code).toBe(0);
    expect(env).toMatchObject({
      ok: true,
      log_tail: expect.stringContaining("no daemon log at"),
      rare_tail: "older stall\n",
    });
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(await daemonCommand(args, false)).toBe(0);
    expect(stdout).toHaveBeenCalledWith(
      expect.stringMatching(/no daemon log at[\s\S]*older stall/),
    );
  });

  it.each(["", ".1"])("names the refused generation '%s' beside both tails", async (suffix) => {
    mkdirSync(join(configDir, "daemon"), { recursive: true, mode: 0o700 });
    writeFileSync(logPath(), "main event\n", { mode: 0o600 });
    const rare = rareHistoryPath();
    writeFileSync(rare, "recent event\n", { mode: 0o600 });
    writeFileSync(`${rare}.1`, "earlier event\n", { mode: 0o600 });
    const read = diagnostics.readDaemonDiagnosticTail;
    vi.spyOn(diagnostics, "readDaemonDiagnosticTail").mockImplementation((options) => {
      if (options?.path === rare + suffix) throw new Error("fixture read refused");
      return read(options);
    });
    const args = parseArgs(["daemon", "logs"]);
    const { code, env } = await captureJson(() => daemonCommand(args, true));
    expect(code).toBe(0);
    expect(env.log_tail).toBe("main event\n");
    const good = suffix ? "recent event" : "earlier event";
    const problem = `(claudexord.rare.log${suffix}): fixture read refused`;
    expect(env.rare_tail).toContain(good);
    expect(env.rare_tail).toContain(problem);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(await daemonCommand(args, false)).toBe(0);
    for (const part of ["main event", good, problem])
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining(part));
  });

  it.each(["absent", "empty", "oversized"])(
    "keeps the logs failure with %s rare history",
    async (kind) => {
      mkdirSync(join(configDir, "daemon"), { recursive: true, mode: 0o700 });
      if (kind !== "absent") {
        const contents = kind === "empty" ? "" : "x".repeat(256 * 1024 + 1);
        writeFileSync(rareHistoryPath(), contents, { mode: 0o600 });
      }
      const args = parseArgs(["daemon", "logs"]);
      const { code, env } = await captureJson(() => daemonCommand(args, true));
      expect(code).toBe(1);
      expect(env).toMatchObject({
        ok: false,
        message: expect.stringContaining("no daemon log at"),
      });
      if (kind === "oversized") {
        expect(env.message).toContain("(claudexord.rare.log): oversize_omitted");
      }
    },
  );

  it("sends the CLI's own bounded identity fields on ordinary Stop", async () => {
    ensureToken();
    const rpc = vi.spyOn(DaemonClient.prototype, "call").mockResolvedValue({ ok: true });
    vi.spyOn(daemonRun, "stopDaemonForOperator").mockImplementation(async (_path, deps) => {
      await deps.shutdown();
      return { outcome: "exited", detail: "test daemon exited" };
    });
    const { code } = await captureJson(() => daemonCommand(parseArgs(["daemon", "stop"]), true));
    expect(code).toBe(0);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("claudexor.shutdown", {
      sender: {
        name: "claudexor-cli",
        version: CLAUDEXOR_VERSION,
        pid: process.pid,
        ppid: process.ppid,
      },
    });
  });

  it("`daemon start` uses the shared detached adapter with explicit-start provenance", async () => {
    const markReady = vi.fn();
    const launchSpy = vi.spyOn(daemonLaunch, "launchDetachedDaemon").mockReturnValue({
      pid: 12345,
      failure: () => null,
      markReady,
      waitForFailure: async () => ({
        kind: "preclaim_exit",
        exitCode: 0,
        signal: null,
        stderr: { kind: "empty" },
      }),
      callerError: () => new CliError("operational", "unused"),
    });
    vi.spyOn(daemonRun, "waitForDaemonReady").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://127.0.0.1:1", token: "token" },
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });

    const { code, env } = await captureJson(() =>
      daemonCommand(parseArgs(["daemon", "start"]), true),
    );

    expect(code).toBe(0);
    expect(env).toMatchObject({ pid: 12345, ready: true });
    expect(launchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        launchSource: daemonLaunch.CLI_DAEMON_LAUNCH_SOURCES.explicitStart,
      }),
    );
    expect(markReady).toHaveBeenCalledTimes(1);
  });

  it("`daemon start` reports a recovery-only daemon honestly (exit 0, servingMode field) (C7c)", async () => {
    const markReady = vi.fn();
    vi.spyOn(daemonLaunch, "launchDetachedDaemon").mockReturnValue({
      pid: 12346,
      failure: () => null,
      markReady,
      waitForFailure: async () => ({
        kind: "preclaim_exit",
        exitCode: 0,
        signal: null,
        stderr: { kind: "empty" },
      }),
      callerError: () => new CliError("operational", "unused"),
    });
    vi.spyOn(daemonRun, "waitForDaemonReady").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://127.0.0.1:1", token: "token" },
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "recovery_only" },
    });

    const { code, env } = await captureJson(() =>
      daemonCommand(parseArgs(["daemon", "start"]), true),
    );

    expect(code).toBe(0);
    expect(env).toMatchObject({ pid: 12346, ready: true, servingMode: "recovery_only" });
  });

  it.each([
    {
      label: "explicit daemon start",
      run: () => daemonCommand(parseArgs(["daemon", "start"]), true),
      source: daemonLaunch.CLI_DAEMON_LAUNCH_SOURCES.explicitStart,
    },
    {
      label: "ensureDaemon project command",
      run: () => projectCommand(parseArgs(["project", "list"]), true),
      source: daemonLaunch.CLI_DAEMON_LAUNCH_SOURCES.ensureDaemon,
    },
  ])(
    "projects real pre-claim stderr through the $label failure envelope",
    async ({ run, source }) => {
      const entry = join(configDir, `missing-import-${source}.mjs`);
      writeFileSync(entry, 'await import("./projector-missing-module.mjs");\n');
      process.env["CLAUDEXOR_DAEMON_ENTRY"] = entry;

      const { code, env } = await captureJson(run);

      expect(code).toBe(1);
      expect(env).toMatchObject({
        ok: false,
        code: "daemon_start_failed",
        context: {
          launchSource: source,
          failure: {
            kind: "preclaim_exit",
            stderr: { kind: "retained" },
          },
        },
      });
      expect(String(env["message"])).toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/);
      expect(JSON.stringify(env)).toContain("projector-missing-module.mjs");
      expect(existsSync(join(configDir, "daemon", "claudexord.log"))).toBe(false);
    },
  );
});
