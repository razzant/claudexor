/**
 * The run-owned launch point (`run-spawn.ts`): what a launch inherits from its
 * env and from a bounded run scope, and the source rule that nothing else in
 * the engine launches a process directly, except the listed, explained cases.
 */
import { EventEmitter } from "node:events";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RunScopeSpentError,
  observeRunOwnedLaunches,
  registerScopeFence,
  sharedLaunch,
  spawnRunOwned,
  unregisterScopeFence,
  withinRunScope,
} from "./run-spawn.js";
import { mintRunScopeMarker, withoutRunScopeMarkers } from "./process-scope.js";
import { liveChildProcesses, unregisterChildProcess } from "./process-registry.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * Files that may launch through `node:child_process` directly, each with why it
 * is not a process a run starts on its behalf. Everything else uses
 * `spawnRunOwned` (or `spawnProcess` / `runCaptureRaw`, which use it).
 */
const EXCEPTIONS: Record<string, string> = {
  "packages/core/src/run-spawn.ts": "the run-owned launch point itself",
  "packages/core/src/process-identity.ts":
    "host measurement: reads a process's identity (ps), acts on no run",
  "packages/core/src/process-identity-win32.ts": "host measurement on Windows: identity reads",
  "packages/core/src/process-table.ts": "host measurement: the process table read (ps)",
  "packages/core/src/process-scope-readers.ts":
    "host measurement: the marker census readers (ps on macOS)",
  "packages/core/src/process-tree.ts":
    "terminates a run's tree (taskkill on Windows): acts on run processes, is none of them",
  "packages/core/src/selected-program.ts":
    "synchronous, bounded program identity probe (--version) that ends before its caller returns",
  "packages/workspace/src/envelope-recovery.ts":
    "host measurement: an envelope owner's liveness (ps -o lstart)",
  "packages/util/src/index.ts": "engine build identity (git rev-parse), read outside any run",
  "packages/daemon/src/run-deadline-warden.ts": "the warden must stay outside every run's boundary",
  "packages/daemon/src/run-deadline-cgroup.ts":
    "the daemon's startup boundary probe, before any run",
  "packages/delivery/src/publication-scanner-provision.ts":
    "explicit operator provisioning (`claudexor scanner`); delivery never calls it",
  "packages/harness-agy/src/keychain.ts":
    "synchronous, bounded macOS keychain setup (security); macOS declares no run-deadline/1",
  "packages/cli/src/setup-login-runner.ts": "interactive vendor login of the setup service",
  "packages/cli/src/setup-login-pty.ts": "interactive vendor login of the setup service",
  "packages/cli/src/setup-attach-command.ts": "operator attach to a setup job",
  "packages/cli/src/setup-jobs.ts": "setup service jobs, not runs",
  "packages/cli/src/claude-oauth-credential.ts":
    "reads a profile's vendor credential (security on macOS) for the engine",
  "packages/cli/src/plugin-mcp.ts": "starts the plugin MCP bridge for an external host",
  "packages/cli/src/credential-commands.ts": "operator credential command",
  "packages/cli/src/codex-quota-source.ts": "the daemon's quota poller, one app-server per home",
  "packages/cli/src/harness-install-runtime.ts": "operator harness installation",
  "packages/cli/src/daemon-launch.ts": "starts the daemon itself",
  "packages/cli/src/claude-statusline.ts": "the vendor statusline hook and its spool refresher",
};

const LAUNCHERS = new Set([
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
]);

/** Value imports of a launcher from child_process in `text` (type imports excluded). */
function directLaunches(text: string): string[] {
  const found: string[] = [];
  const named = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["'](?:node:)?child_process["']/g;
  for (let m = named.exec(text); m; m = named.exec(text)) {
    if (m[1]) continue;
    for (const part of m[2]!.split(",")) {
      const item = part.trim();
      if (!item || item.startsWith("type ")) continue;
      const name = item.split(/\s+as\s+/)[0]!.trim();
      if (LAUNCHERS.has(name)) found.push(name);
    }
  }
  if (/import\s+\*\s+as\s+\w+\s+from\s*["'](?:node:)?child_process["']/.test(text))
    found.push("* (namespace)");
  if (/import\s+\w+\s+from\s*["'](?:node:)?child_process["']/.test(text)) found.push("default");
  if (/(?:require|import)\(\s*["'](?:node:)?child_process["']\s*\)/.test(text))
    found.push("dynamic");
  return found;
}

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "node_modules" || name === "dist" || name.startsWith("test-support")) continue;
      sources(path, out);
    } else if (
      // Every TypeScript and JavaScript module kind the packages compile or load.
      /\.(?:[cm]?ts|[cm]?js)$/.test(name) &&
      !/\.d\.[cm]?ts$/.test(name) &&
      !/\.(test|integration\.test|story|test-support)\.[cm]?[tj]s$/.test(name)
    )
      out.push(path);
  }
  return out;
}

describe("run-owned launches", () => {
  it("nothing outside the explained exceptions launches through node:child_process directly", () => {
    const packages = join(REPO, "packages");
    const offenders: string[] = [];
    const launching = new Set<string>();
    for (const pkg of readdirSync(packages)) {
      // The canary package is the end-to-end test driver, not the engine.
      if (pkg === "canary") continue;
      const src = join(packages, pkg, "src");
      try {
        statSync(src);
      } catch {
        continue;
      }
      for (const file of sources(src)) {
        const found = directLaunches(readFileSync(file, "utf8"));
        if (found.length === 0) continue;
        const key = relative(REPO, file).split("\\").join("/");
        launching.add(key);
        if (!EXCEPTIONS[key]) offenders.push(`${key}: ${found.join(", ")}`);
      }
    }
    expect(offenders).toEqual([]);
    // The list stays honest: every exception still launches directly.
    expect(Object.keys(EXCEPTIONS).filter((key) => !launching.has(key))).toEqual([]);
  });

  it("detects value imports, namespaces and dynamic loads, not type imports", () => {
    expect(
      directLaunches('import { spawn, type ChildProcess } from "node:child_process";'),
    ).toEqual(["spawn"]);
    expect(directLaunches('import type { ChildProcess } from "node:child_process";')).toEqual([]);
    expect(directLaunches('import * as cp from "child_process";')).toEqual(["* (namespace)"]);
    expect(directLaunches('const cp = await import("node:child_process");')).toEqual(["dynamic"]);
  });
});

describe("spawnRunOwned", () => {
  const fakeSpawn = () => {
    const calls: Array<{ binary: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const spawnFn = (
      binary: string,
      args: readonly string[],
      options: { env?: NodeJS.ProcessEnv },
    ) => {
      calls.push({ binary, args, env: options.env ?? {} });
      return Object.assign(new EventEmitter(), { pid: undefined }) as never;
    };
    return { calls, spawnFn };
  };

  it("an unscoped launch is a plain spawn; a bounded run scope plants its marker", () => {
    const { calls, spawnFn } = fakeSpawn();
    const marker = mintRunScopeMarker();
    expect(spawnRunOwned("git", ["--version"], { env: { A: "1" } }, { spawnFn }).marker).toBe(
      undefined,
    );
    const scoped = withinRunScope(marker, () =>
      spawnRunOwned("git", ["status"], { env: { A: "1" } }, { spawnFn }),
    );
    expect(scoped.marker).toBe(marker);
    expect(calls[0]!.env).toEqual({ A: "1" });
    expect(calls[1]!.env).toEqual({ A: "1", [marker]: "1" });
    // Any marker the env already carries (an enclosing host's) is kept beside it.
    const enclosing = mintRunScopeMarker();
    const both = withinRunScope(marker, () =>
      spawnRunOwned("git", [], { env: { [enclosing]: "1" } }, { spawnFn }),
    );
    expect(calls[2]!.env).toEqual({ [enclosing]: "1", [marker]: "1" });
    expect(both.marker).toBe(marker);
  });

  it("a spent scope launches nothing; an active scope and other scopes launch as usual", () => {
    const { calls, spawnFn } = fakeSpawn();
    const marker = mintRunScopeMarker();
    const other = mintRunScopeMarker();
    let spent = false;
    registerScopeFence(marker, () => spent);
    try {
      withinRunScope(marker, () => spawnRunOwned("git", ["status"], { env: {} }, { spawnFn }));
      spent = true;
      expect(() =>
        withinRunScope(marker, () => spawnRunOwned("gate", [], { env: {} }, { spawnFn })),
      ).toThrow(RunScopeSpentError);
      // Through the env too: a harness spec carrying the marker is refused alike.
      expect(() => spawnRunOwned("gate", [], { env: { [marker]: "1" } }, { spawnFn })).toThrow(
        expect.objectContaining({ code: "run_scope_spent" }),
      );
      withinRunScope(other, () => spawnRunOwned("git", [], { env: {} }, { spawnFn }));
      expect(calls.map((call) => call.binary)).toEqual(["git", "git"]);
    } finally {
      unregisterScopeFence(marker);
    }
  });

  it("a shared launch carries no run marker, inside a run's scope included; every launch is observable", () => {
    const { calls, spawnFn } = fakeSpawn();
    const marker = mintRunScopeMarker();
    const seen: Array<{ marker: string | undefined; shared: string | undefined }> = [];
    const stop = observeRunOwnedLaunches(({ marker, shared }) => seen.push({ marker, shared }));
    try {
      withinRunScope(marker, () => {
        spawnRunOwned("git", [], { env: { [marker]: "1" } }, { spawnFn });
        sharedLaunch("status-cache", () =>
          spawnRunOwned("probe", [], { env: { [marker]: "1", A: "1" } }, { spawnFn }),
        );
      });
    } finally {
      stop();
    }
    expect(calls[1]!.env).toEqual({ A: "1" });
    expect(seen).toEqual([
      { marker, shared: undefined },
      { marker: undefined, shared: "status-cache" },
    ]);
  });

  it("registers the child under its run's marker when asked", () => {
    const marker = mintRunScopeMarker();
    const launched = spawnRunOwned(
      process.execPath,
      ["-e", "setTimeout(() => {}, 2000)"],
      // Its own group, as every background launch: the registry records group leaders.
      // (Without any marker this test process itself inherited from an enclosing run.)
      {
        env: { ...withoutRunScopeMarkers(process.env), [marker]: "1" },
        stdio: "ignore",
        detached: true,
      },
      { register: "probe" },
    );
    try {
      expect(launched.registration).toMatchObject({ cmd: "probe", scopeMarker: marker });
      expect(liveChildProcesses().some((entry) => entry.pid === launched.child.pid)).toBe(true);
    } finally {
      launched.child.kill("SIGKILL");
      unregisterChildProcess(launched.registration);
    }
  });
});
