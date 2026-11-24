/**
 * run-deadline/1 invariant 4 on two production paths (Linux): the real Claude
 * adapter running a vendor CLI (a fake `claude` on PATH whose grandchild leaves
 * in its own session, with an emptied environment), and an in-place delivery
 * whose final verification gate blocks (its children through the run's launch
 * scope and, where proven, the cgroup shim). The daemon is SIGKILLed while the
 * work runs; only the detached warden can end the tree, which must be gone by
 * `deadline.at + stopGraceSec`. The emptied-environment grandchild is outside
 * the `marker` boundary by contract, so it is asserted only on `cgroup`.
 *
 * Linux with `CLAUDEXOR_TEST_SYSTEMD_DELEGATE=1` runs the daemon as a transient
 * systemd user service with `Delegate=yes` (the cgroup boundary). Every signal
 * goes to a pid this file started or recorded, after re-measuring its identity.
 */
import { spawn, spawnSync, execFileSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareProcessIdentity,
  defaultProcessIdentityService,
  isKnownProcessIdentity,
  type KnownProcessIdentity,
} from "@claudexor/core";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const GRACE_MS = 15_000;
const WINDOW_MS = 12_000;
const DELEGATED = process.env.CLAUDEXOR_TEST_SYSTEMD_DELEGATE === "1";
const CHILD = fileURLToPath(
  new URL("./test-support/run-deadline-cli-daemon-child.ts", import.meta.url),
);
const HERE = fileURLToPath(new URL(".", import.meta.url));

const FAKE_CLAUDE = `#!/bin/sh
case "$*" in
  *--version*) echo "2.1.300 (Claude Code)"; exit 0 ;;
  *--help*) printf 'Usage: claude [options]\\n  --effort <level>  (choices: "low", "medium", "high")\\n'; exit 0 ;;
  *auth*) echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'; exit 0 ;;
esac
setsid env -i /bin/sh -c 'exec sleep 1000' </dev/null >/dev/null 2>&1 &
echo "{\\"child\\":$$,\\"grandchild\\":$!}" >> "$CX_TREE"
exec sleep 1000
`;

const dirs: string[] = [];
const owned = new Map<number, KnownProcessIdentity | null>();
const units: string[] = [];

function own(pid: number): void {
  if (owned.has(pid)) return;
  const identity = defaultProcessIdentityService.read(pid);
  owned.set(pid, isKnownProcessIdentity(identity) ? identity : null);
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
function killOwned(pid: number): void {
  const recorded = owned.get(pid);
  if (!recorded) return;
  if (compareProcessIdentity(recorded, defaultProcessIdentityService.read(pid)) !== "same") return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}
afterEach(() => {
  for (const pid of owned.keys()) killOwned(pid);
  owned.clear();
  for (const unit of units.splice(0))
    spawnSync("systemctl", ["--user", "stop", unit], { stdio: "ignore" });
  for (const dir of dirs)
    rmSync(join(dir, "deadlines"), {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
});
afterAll(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}, 0);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, deadlineMs: number, label: string, dir: string) {
  for (;;) {
    if (check()) return Date.now();
    if (Date.now() > deadlineMs) {
      const log = join(dir, "daemon.log");
      throw new Error(
        `timed out: ${label}\n${existsSync(log) ? readFileSync(log, "utf8").slice(-2_000) : ""}`,
      );
    }
    await sleep(50);
  }
}
const readJson = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
};

async function startDaemon(dir: string, mode: string, env: Record<string, string>) {
  const argv = [process.execPath, "--import", "tsx", CHILD, dir, mode];
  let child: ChildProcess | undefined;
  if (DELEGATED) {
    const unit = `cx-rdl-cli-${process.pid}-${Date.now()}`;
    units.push(unit);
    const setenv = Object.entries({ ...env, PATH: process.env.PATH ?? "" }).map(
      ([key, value]) => `--setenv=${key}=${value}`,
    );
    const started = spawnSync("systemd-run", [
      "--user",
      `--unit=${unit}`,
      "--collect",
      "-p",
      "Delegate=yes",
      "-p",
      "KillMode=process",
      "-p",
      `StandardOutput=append:${join(dir, "daemon.log")}`,
      "-p",
      `StandardError=append:${join(dir, "daemon.log")}`,
      `--working-directory=${HERE}`,
      ...setenv,
      ...argv,
    ]);
    if (started.status !== 0) throw new Error(`systemd-run failed: ${started.stderr}`);
  } else {
    const log = openSync(join(dir, "daemon.log"), "a");
    child = spawn(argv[0]!, argv.slice(1), {
      cwd: HERE,
      stdio: ["ignore", log, log],
      env: { ...process.env, ...env },
    });
    closeSync(log);
  }
  await until(
    () => readJson(join(dir, "ready")) !== null,
    Date.now() + 30_000,
    "daemon ready",
    dir,
  );
  const ready = readJson<{ pid: number; boundary: string }>(join(dir, "ready"))!;
  own(ready.pid);
  return { ...ready, child };
}

async function tree(dir: string): Promise<{ child: number; grandchild: number }> {
  const path = join(dir, "tree.jsonl");
  await until(
    () => existsSync(path) && readFileSync(path, "utf8").includes("\n"),
    Date.now() + 30_000,
    "the run's process tree",
    dir,
  );
  const row = JSON.parse(readFileSync(path, "utf8").split("\n")[0]!) as {
    child: number;
    grandchild: number;
  };
  own(row.child);
  own(row.grandchild);
  return row;
}

function repo(dir: string): string {
  const root = join(dir, "repo");
  mkdirSync(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "file.txt"), "before\n");
  git("add", ".");
  git("-c", "user.name=F", "-c", "user.email=f@example.invalid", "commit", "-qm", "base");
  writeFileSync(join(root, "file.txt"), "after\n");
  writeFileSync(join(dir, "change.patch"), git("diff"));
  git("checkout", "--", "file.txt");
  return root;
}

describe.runIf(process.platform === "linux")(
  "run-deadline/1 on production paths: nothing outlives deadline + stopGraceSec with the daemon dead",
  () => {
    it.each(["adapter", "delivery"] as const)(
      "%s: the daemon is SIGKILLed while the run works; the tree ends by the deadline",
      async (mode) => {
        const dir = realpathSync(mkdtempSync(join(tmpdir(), "d-rdc-")));
        dirs.push(dir);
        const bin = join(dir, "bin");
        mkdirSync(bin);
        writeFileSync(join(bin, "claude"), FAKE_CLAUDE);
        chmodSync(join(bin, "claude"), 0o755);
        const deadlineAt = Date.now() + WINDOW_MS;
        const daemon = await startDaemon(dir, mode, {
          CX_JOB: JSON.stringify({
            key: `k-${mode}`,
            deadlineAt: new Date(deadlineAt).toISOString(),
          }),
          CX_FAKE_BIN: bin,
          CX_REPO: mode === "delivery" ? repo(dir) : "",
        });
        const { child, grandchild } = await tree(dir);
        expect(Date.now()).toBeLessThan(deadlineAt);
        expect(alive(child) && alive(grandchild)).toBe(true);
        killOwned(daemon.pid);
        await until(() => !alive(daemon.pid), Date.now() + 10_000, "daemon gone", dir);
        const checked = (pid: number) =>
          pid === child || mode === "delivery" || daemon.boundary === "cgroup";
        const goneAt = await until(
          () => [child, grandchild].filter(checked).every((pid) => !alive(pid)),
          deadlineAt + GRACE_MS + 5_000,
          `the tree ends (${daemon.boundary})`,
          dir,
        );
        expect(goneAt).toBeLessThanOrEqual(deadlineAt + GRACE_MS);
        expect(Date.now()).toBeGreaterThanOrEqual(deadlineAt);
      },
      90_000,
    );
  },
);
