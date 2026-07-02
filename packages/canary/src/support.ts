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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const CLI = join(repoRoot, "packages", "cli", "dist", "cli.js");

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
  const base = mkdtempSync(join(tmpdir(), "claudexor-canary-"));
  const home = join(base, "home");
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
  git(["-c", "user.email=canary@claudexor.local", "-c", "user.name=Canary", "commit", "-qm", "init"]);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CLAUDEXOR_CONFIG_DIR: configDir,
    CLAUDEXOR_SECRETS_BACKEND: "file",
    CLAUDEXOR_DISABLE_STORED_SECRETS: "1",
    // Keep daemon state inside the sandbox too (config dir owns it).
  };
  return {
    home,
    configDir,
    repo,
    env,
    dispose: () => {
      // Stop a sandbox daemon if one was auto-started by an acting command.
      try {
        spawnSync(process.execPath, [CLI, "daemon", "stop"], { env, cwd: repo, timeout: 15_000 });
      } catch {
        /* best effort */
      }
      // The daemon flushes jobs.json asynchronously during shutdown; retry the
      // removal briefly instead of failing the story on ENOTEMPTY. A leftover
      // temp dir on the final attempt is acceptable OS-tmp residue, never a
      // test failure.
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          rmSync(base, { recursive: true, force: true });
          return;
        } catch {
          const until = Date.now() + 200;
          while (Date.now() < until) {
            /* sync backoff — vitest hooks may not await here */
          }
        }
      }
      try {
        rmSync(base, { recursive: true, force: true });
      } catch {
        /* leave residue in OS tmp */
      }
    },
  };
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json: () => unknown;
}

export function cli(sb: Sandbox, args: string[], opts: { cwd?: string } = {}): CliResult {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? sb.repo,
    env: sb.env,
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

export function runFileExists(runDir: string, rel: string): boolean {
  return existsSync(join(runDir, rel));
}

export function readEvents(runDir: string): Array<Record<string, unknown>> {
  return readFileSync(join(runDir, "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
