import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { afterEachClosed } from "./test-support/after-each-closed.js";

/**
 * C8 (sol SCOPE-06 + grok G-DIAG-01): claudexord owns the private
 * post-authority diagnostic file. A started daemon must write structured
 * records with full launch provenance (launch source, runtime version, build
 * sha, entry path, pid, data root) into the canonical claudexord.log —
 * that is what `claudexor daemon logs` and incident forensics read.
 */

const daemonEntry = resolve(import.meta.dirname, "../dist/claudexord.js");
const cleanups: Array<() => void | Promise<void>> = [];
const removals: Array<() => void> = [];

// Dispose in REVERSE registration order so a spawned daemon is killed and
// REAPED before its root is removed: a SIGTERMed daemon still writes during
// shutdown, and a recursive rm racing those writes fails ENOTEMPTY on Linux.
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0).reverse();
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});

function freshRoot(): string {
  const root = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "cx-prov-")));
  removals.push(() =>
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  );
  return join(root, "config");
}

function spawnDaemon(config: string, extraEnv: Record<string, string> = {}): ChildProcess {
  const child = spawn(process.execPath, [daemonEntry], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      HOME: process.env.HOME ?? "/tmp",
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      CLAUDEXOR_CONFIG_DIR: config,
      ...extraEnv,
    },
  });
  cleanups.push(async () => {
    if (child.exitCode !== null) return;
    child.kill("SIGKILL");
    await waitFor(
      () => (child.exitCode === null && child.signalCode === null ? null : true),
      "the daemon to be reaped",
    );
  });
  return child;
}

async function waitFor<T>(probe: () => T | null, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function diagnosticRecords(config: string): Array<Record<string, unknown>> {
  const path = join(config, "daemon", "claudexord.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        return value && typeof value === "object" ? [value] : [];
      } catch {
        return []; // human logLine rows interleave with the structured records
      }
    });
}

describe("daemon startup diagnostics ownership (C8)", () => {
  it("a started daemon writes private diagnostic records with full launch provenance", async () => {
    const config = freshRoot();
    const daemon = spawnDaemon(config, {
      CLAUDEXOR_DAEMON_LAUNCH_SOURCE: "cli_ensure_daemon",
    });
    await waitFor(
      () =>
        daemon.exitCode === null && existsSync(join(config, "daemon", "control-api.json"))
          ? true
          : null,
      "the daemon to come up",
    );
    const records = await waitFor(() => {
      const found = diagnosticRecords(config);
      return found.length > 0 ? found : null;
    }, "structured diagnostic records in claudexord.log");
    const provenance = records.find((record) => record.launchSource === "cli_ensure_daemon");
    expect(provenance, "no record carries the launch source").toBeDefined();
    expect(provenance).toMatchObject({
      launchSource: "cli_ensure_daemon",
      pid: daemon.pid,
      stage: expect.stringMatching(/^[a-z0-9][a-z0-9._-]*$/) as unknown,
    });
    expect(typeof provenance?.runtimeVersion).toBe("string");
    expect(typeof provenance?.buildSha).toBe("string");
    expect(typeof provenance?.entryPath).toBe("string");
    expect(typeof provenance?.dataRoot).toBe("string");
    daemon.kill("SIGTERM");
  }, 40_000);

  it("an unset launch source records as 'unknown' instead of failing startup", async () => {
    const config = freshRoot();
    const daemon = spawnDaemon(config);
    await waitFor(
      () =>
        daemon.exitCode === null && existsSync(join(config, "daemon", "control-api.json"))
          ? true
          : null,
      "the daemon to come up",
    );
    const records = await waitFor(() => {
      const found = diagnosticRecords(config);
      return found.length > 0 ? found : null;
    }, "structured diagnostic records in claudexord.log");
    expect(records.some((record) => record.launchSource === "unknown")).toBe(true);
    daemon.kill("SIGTERM");
  }, 40_000);
});
