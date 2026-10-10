/**
 * Shared harness for canary golden stories.
 *
 * Every story runs the BUILT CLI (the public surface a user touches) inside a
 * hermetic sandbox: temp HOME, temp CLAUDEXOR_CONFIG_DIR, file-backed secret
 * store, and a disposable git repo. No network, no keys, no real harnesses —
 * only the deterministic `fake-*` adapters, which are explicit-id-only by
 * product rule.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const CLI = join(repoRoot, "packages", "cli", "dist", "cli.js");
const DAEMON = join(repoRoot, "packages", "cli", "dist", "claudexord.js");

// Read the built engine's strict authority in the fixture environment. In
// particular, Windows pipe/lease addresses depend on its config root. This is
// a read-only Node process, not a daemon or another lifecycle controller.
const LEASE_PROBE = `
  const { canonicalDefaultSocketPath } = await import(${JSON.stringify(new URL("../../daemon/dist/token.js", import.meta.url).href)});
  const { inspectDaemonWriterLease } = await import(${JSON.stringify(new URL("../../daemon/dist/writer-lease.js", import.meta.url).href)});
  const lease = inspectDaemonWriterLease(canonicalDefaultSocketPath());
  const observation = lease.status === "owned"
    ? { status: lease.status, path: lease.path, pid: lease.owner.pid,
        capability: lease.capability.status, reason: lease.capability.reason }
    : lease;
  process.stdout.write(JSON.stringify(observation));
`;

interface LeaseObservation {
  status: "absent" | "owned" | "unknown";
  path: string;
  pid?: number;
  capability?: "capable" | "proven_stale" | "unknown";
  reason?: string;
}

function failureDetail(error: unknown): { message: string; code?: string } {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return {
    message: error instanceof Error ? error.message : String(error),
    ...(code ? { code } : {}),
  };
}

export function inspectSandboxLease(env: NodeJS.ProcessEnv, cwd: string): LeaseObservation {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", LEASE_PROBE], {
    env,
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(
      `writer-lease inspection failed: ${JSON.stringify({
        status: result.status,
        signal: result.signal,
        stderr: result.stderr,
        ...(result.error ? { error: failureDetail(result.error) } : {}),
      })}`,
    );
  }
  const lease = JSON.parse(result.stdout) as LeaseObservation;
  if (
    !lease ||
    typeof lease.path !== "string" ||
    !["absent", "owned", "unknown"].includes(lease.status)
  ) {
    throw new Error("writer-lease inspection returned an invalid observation");
  }
  return lease;
}

function inactiveLease(lease: LeaseObservation): boolean {
  return (
    lease.status === "absent" || (lease.status === "owned" && lease.capability === "proven_stale")
  );
}

export interface Sandbox {
  home: string;
  configDir: string;
  repo: string;
  env: NodeJS.ProcessEnv;
  dispose: () => void;
}

export function makeSandbox(): Sandbox {
  // NOTE: the sandbox config dir feeds the daemon's AF_UNIX socket path, and
  // macOS caps socket paths at 104 bytes ($TMPDIR alone is ~49). The current
  // layout sits near that cap — do NOT lengthen this prefix or nest the
  // config dir deeper, or canaries will fail with an obscure bind error on
  // macOS runners only.
  const base = mkdtempSync(join(realpathSync.native(tmpdir()), "cx-"));
  const home = base;
  const configDir = join(base, "config");
  const repo = join(base, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# canary fixture\n");
  writeFileSync(join(repo, "math.js"), "export function add(a, b) {\n  return a - b; // bug\n}\n");
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git(["init", "-q"]);
  git(["-c", "user.email=canary@claudexor.local", "-c", "user.name=Canary", "add", "-A"]);
  git([
    "-c",
    "user.email=canary@claudexor.local",
    "-c",
    "user.name=Canary",
    "commit",
    "-qm",
    "init",
  ]);
  // Hermetic vendor discovery: version-only stubs keep settings/model-truth
  // canaries independent of installed CLIs. Codex, Claude and AGY return their
  // advisory hints; OpenCode has no inventory and keeps strict refusal. No
  // story needs a real vendor process, credential or model-list protocol.
  const codexStub = versionOnlyStub(base, "codex-stub", "codex-cli 0.0.0-stub");
  const claudeStub = versionOnlyStub(base, "claude-stub", "0.0.0-stub (Claude Code)");
  const agyStub = versionOnlyStub(base, "agy-stub", "agy 0.0.0-stub");
  const opencodeStub = versionOnlyStub(base, "opencode-stub", "opencode 0.0.0-stub");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CLAUDEXOR_CONFIG_DIR: configDir,
    CLAUDEXOR_DAEMON_ENTRY: DAEMON,
    CLAUDEXOR_DISABLE_STORED_SECRETS: "1",
    CLAUDEXOR_CODEX_BIN: codexStub,
    CLAUDEXOR_CLAUDE_BIN: claudeStub,
    CLAUDEXOR_AGY_BIN: agyStub,
    CLAUDEXOR_OPENCODE_BIN: opencodeStub,
    // Keep daemon state inside the sandbox too (config dir owns it).
  };
  delete env.CLAUDEXOR_DAEMON_SOCK;
  let disposed = false;
  return {
    home,
    configDir,
    repo,
    env,
    dispose: () => {
      if (disposed) return;
      const receipt: Record<string, unknown> = { base, configDir, daemonEntry: DAEMON };
      try {
        const before = inspectSandboxLease(env, repo);
        receipt.before = before;
        // Physical absence or a proven-stale owner handles never-started and
        // already-stopped fixtures without inferring death from a missing token.
        if (!inactiveLease(before)) {
          const result = spawnSync(process.execPath, [CLI, "daemon", "stop", "--json"], {
            env,
            cwd: repo,
            encoding: "utf8",
            // Covers the engine's own ~20s confirmation budget with slack.
            timeout: 30_000,
          });
          receipt.stop = {
            status: result.status,
            signal: result.signal,
            stdout: result.stdout,
            stderr: result.stderr,
            ...(result.error ? { error: failureDetail(result.error) } : {}),
          };
          if (result.error || result.signal || result.status !== 0) {
            throw new Error("daemon stop did not complete successfully");
          }
          // Operator stop proves the pinned owner's exit, not the absence of
          // a successor. The existing lease owner decides whether this root
          // can be removed; CLI prose is never that proof.
          const after = inspectSandboxLease(env, repo);
          receipt.after = after;
          if (!inactiveLease(after))
            throw new Error("writer-lease activity remains live or unknown");
        }
        rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        disposed = true;
      } catch (error) {
        receipt.failure = failureDetail(error);
        const receiptPath = join(base, "canary-cleanup.json");
        try {
          writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
        } catch (writeError) {
          receipt.receiptWriteFailure = failureDetail(writeError);
        }
        throw new Error(`Canary cleanup incomplete at ${base}: ${JSON.stringify(receipt)}`, {
          cause: error,
        });
      }
    },
  };
}

/** A vendor CLI stub that answers ONLY `--version`; every other argv exits 1. */
function versionOnlyStub(base: string, name: string, version: string): string {
  const stub = join(base, name);
  writeFileSync(
    stub,
    `#!/bin/sh\ncase "$1" in\n  --version) echo "${version}" ;;\n  *) exit 1 ;;\nesac\n`,
  );
  chmodSync(stub, 0o755);
  return stub;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json: () => unknown;
}

export function cli(
  sb: Sandbox,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): CliResult {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? sb.repo,
    env: { ...sb.env, ...opts.env },
    encoding: "utf8",
    timeout: 110_000,
  });
  const stdout = r.stdout ?? "";
  return {
    code: r.status ?? -1,
    stdout,
    stderr: r.stderr ?? "",
    json: () => {
      const start = stdout.indexOf("{");
      if (start < 0) throw new Error(`no JSON object in stdout:\n${stdout}\n${r.stderr}`);
      return JSON.parse(stdout.slice(start));
    },
  };
}

export function readRunFile(runDir: string, rel: string): string {
  return readFileSync(join(runDir, rel), "utf8");
}

export function readRunYaml<T = unknown>(runDir: string, rel: string): T {
  return parseYaml(readRunFile(runDir, rel)) as T;
}

export function runFileExists(runDir: string, rel: string): boolean {
  return existsSync(join(runDir, rel));
}

export function readEvents(runDir: string): Array<Record<string, unknown>> {
  return readFileSync(join(runDir, "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
