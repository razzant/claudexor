/**
 * run-deadline/1 invariant 4 with real processes: contract trials 3, 4 and 8,
 * and 9 at the warden. A real DaemonServer runs in its own process
 * (`test-support/run-deadline-daemon-child.ts`, without the startup crash GC)
 * or the registry runs here with its timers unable to act; either way only the
 * detached warden can end the run's processes, so passing proves enforcement,
 * never cleanup at the next daemon start.
 *
 * Linux with `CLAUDEXOR_TEST_SYSTEMD_DELEGATE=1`: the child daemon runs as a
 * transient systemd user service with `Delegate=yes` (and `KillMode=process`,
 * so systemd itself ends nothing when the daemon is killed); the daemon then
 * proves the cgroup boundary and the trials also start a grandchild with an
 * empty environment, which only `cgroup.kill` can reach.
 *
 * Safety: every signal this file sends goes to a pid it started itself or that
 * its own launch recorded, and only after re-measuring that pid's identity
 * against the one read when it was recorded (as `terminate.ts` does). The
 * wardens end only processes inside the run's boundary (a random per-run marker,
 * the run's own cgroup).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareProcessIdentity,
  defaultProcessIdentityService,
  isKnownProcessIdentity,
  mintRunScopeMarker,
  spawnProcess,
  type KnownProcessIdentity,
} from "@claudexor/core";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { RunDeadlines, systemDeadlineClock, type RunDeadlineClock } from "./run-deadlines.js";
import { RUN_DEADLINE_STOP_GRACE_SEC } from "./run-deadline-warden.js";

const GRACE_MS = RUN_DEADLINE_STOP_GRACE_SEC * 1_000;
/** Deadlines are set at least this far ahead of the moment the warden is attached. */
const WINDOW_MS = 10_000;
const DELEGATED = process.env.CLAUDEXOR_TEST_SYSTEMD_DELEGATE === "1";
const CHILD = fileURLToPath(
  new URL("./test-support/run-deadline-daemon-child.ts", import.meta.url),
);
const HERE = fileURLToPath(new URL(".", import.meta.url));
const HARNESS = `
const { spawn } = require("node:child_process");
const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { detached: true, stdio: "ignore" });
g.unref();
process.stdout.write(JSON.stringify({ child: process.pid, grandchild: g.pid, clean: null }) + "\\n");
setInterval(() => {}, 1e6);
`;

interface Tree {
  child: number;
  grandchild: number;
  clean: number | null;
}

const dirs: string[] = [];
/** Every pid this file may signal, with the identity measured when it was recorded. */
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

/** SIGKILL a recorded pid only while it is still the process that was recorded. */
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
  // Recorded trees first, while their wardens still hold the files…
  for (const pid of owned.keys()) killOwned(pid);
  owned.clear();
  for (const unit of units.splice(0))
    spawnSync("systemctl", ["--user", "stop", unit], { stdio: "ignore" });
  // …then release the wardens (each exits on its next poll once its file is gone).
  // A warden may still be writing its outcome while the directory goes: retry.
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
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "d-rdp-")));
  dirs.push(dir);
  diagnosticDir = dir;
  return dir;
}

let diagnosticDir: string | null = null;

async function until(check: () => boolean, deadlineMs: number, label: string): Promise<number> {
  for (;;) {
    if (check()) return Date.now();
    if (Date.now() > deadlineMs) {
      const log = diagnosticDir ? join(diagnosticDir, "daemon.log") : null;
      const tail = log && existsSync(log) ? readFileSync(log, "utf8").slice(-2_000) : "";
      throw new Error(`timed out: ${label}${tail ? `\n--- daemon log ---\n${tail}` : ""}`);
    }
    await sleep(50);
  }
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Start the child daemon (as a delegated transient service when asked) and return its pid. */
async function startDaemon(
  dir: string,
  mode: "run" | "read",
  env: Record<string, string>,
): Promise<{ pid: number; boundary: string; process?: ChildProcess }> {
  rmSync(join(dir, "ready"), { force: true });
  const argv = [process.execPath, "--import", "tsx", CHILD, dir, mode];
  let child: ChildProcess | undefined;
  if (DELEGATED) {
    const unit = `cx-rdl-${process.pid}-${Date.now()}`;
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
  await until(() => readJson(join(dir, "ready")) !== null, Date.now() + 30_000, "daemon ready");
  const ready = readJson<{ pid: number; boundary: string }>(join(dir, "ready"))!;
  own(ready.pid);
  return { ...ready, ...(child ? { process: child } : {}) };
}

async function killDaemon(pid: number): Promise<void> {
  killOwned(pid);
  await until(() => !alive(pid), Date.now() + 10_000, "daemon gone");
}

/** The recorded trees: only complete (newline-terminated) rows; pids owned before use. */
async function recordedTrees(dir: string, count = 1): Promise<Tree[]> {
  const path = join(dir, "pids.jsonl");
  const rows = (): Tree[] => {
    if (!existsSync(path)) return [];
    const text = readFileSync(path, "utf8");
    const complete = text.slice(0, text.lastIndexOf("\n") + 1);
    const trees: Tree[] = [];
    for (const line of complete.split("\n").filter(Boolean)) {
      for (const pid of line.match(/\d+/g) ?? []) own(Number(pid));
      trees.push(JSON.parse(line) as Tree);
    }
    return trees;
  };
  await until(() => rows().length >= count, Date.now() + 30_000, "run launched");
  return rows();
}

/** A harness carrying `marker` (through core's spawn) that starts a setsid grandchild. */
async function launchTree(marker: string): Promise<Tree> {
  const events = spawnProcess(process.execPath, ["-e", HARNESS], { env: { [marker]: "1" } });
  const first = await new Promise<string>((resolve, reject) => {
    void (async () => {
      for await (const event of events) if (event.type === "stdout") resolve(event.line);
    })().catch(reject);
  });
  for (const pid of first.match(/\d+/g) ?? []) own(Number(pid));
  return JSON.parse(first) as Tree;
}

const members = (tree: Tree) => [tree.child, tree.grandchild, ...(tree.clean ? [tree.clean] : [])];
const anyAlive = (tree: Tree) => members(tree).some(alive);
const allAlive = (tree: Tree) => members(tree).every(alive);

describe.skipIf(process.platform === "win32")(
  "run-deadline/1 warden: no run process outlives deadline + stopGraceSec",
  () => {
    it("trial 3: SIGKILL of the daemon while running; the setsid grandchild ends too, daemon still down", async () => {
      const dir = tempDir();
      const at = inMs(WINDOW_MS + 4_000);
      const daemon = await startDaemon(dir, "run", {
        CX_JOB: JSON.stringify({ key: "t3", label: "t3", deadlineAt: at }),
        CX_CLEAN: DELEGATED ? "1" : "0",
      });
      if (DELEGATED) expect(daemon.boundary).toBe("cgroup");
      const [tree] = await recordedTrees(dir);
      if (DELEGATED) expect(tree!.clean).not.toBeNull();
      await killDaemon(daemon.pid);
      expect(allAlive(tree!)).toBe(true); // the daemon's death ended nothing
      await sleep(Math.max(0, Date.parse(at) - Date.now() - 500));
      expect(allAlive(tree!)).toBe(true); // nothing ends early
      const gone = await until(
        () => !anyAlive(tree!),
        Date.parse(at) + GRACE_MS + 5_000,
        "tree ended",
      );
      expect(gone).toBeLessThanOrEqual(Date.parse(at) + GRACE_MS);
      expect(alive(daemon.pid)).toBe(false);
    }, 90_000);

    it("trial 4: restart while running; the new daemon reads the run interrupted and expired", async () => {
      const dir = tempDir();
      const at = inMs(WINDOW_MS + 4_000);
      const first = await startDaemon(dir, "run", {
        CX_JOB: JSON.stringify({ key: "t4", label: "t4", deadlineAt: at }),
        CX_CLEAN: DELEGATED ? "1" : "0",
      });
      const [tree] = await recordedTrees(dir);
      const jobId = readFileSync(join(dir, "job"), "utf8");
      await killDaemon(first.pid);
      expect(allAlive(tree!)).toBe(true);
      const gone = await until(
        () => !anyAlive(tree!),
        Date.parse(at) + GRACE_MS + 5_000,
        "tree ended",
      );
      expect(gone).toBeLessThanOrEqual(Date.parse(at) + GRACE_MS);
      expect(gone).toBeGreaterThanOrEqual(Date.parse(at));
      // The next generation (no startup crash GC) reads the outcome.
      await startDaemon(dir, "read", { CX_JOB_ID: jobId });
      await until(() => existsSync(join(dir, "read.json")), Date.now() + 30_000, "read");
      const read = readJson<{ status: { state: string }; deadline: Record<string, unknown> }>(
        join(dir, "read.json"),
      )!;
      expect(read.status.state).toBe("interrupted");
      expect(read.deadline).toMatchObject({ at, revision: 0, state: "expired" });
    }, 90_000);

    it("trial 8: a Delegate child's processes end by the parent's deadline with the daemon unable to act", async () => {
      const dir = tempDir();
      const deadlines = new RunDeadlines({ dir: join(dir, "deadlines"), onExpire: () => {} });
      const parent = deadlines.toPoint(inMs(WINDOW_MS + 2_000));
      deadlines.admit("parent", parent, null);
      deadlines.admit("child", deadlines.toPoint(inMs(120_000)), "parent");
      const marker = mintRunScopeMarker();
      await deadlines.attachScope("child", marker);
      const tree = await launchTree(marker);
      deadlines.dispose(); // the "daemon" is gone: no timer of it can act any more
      await sleep(Math.max(0, Date.parse(parent.at) - Date.now() - 500));
      expect(allAlive(tree)).toBe(true);
      const gone = await until(
        () => !anyAlive(tree),
        Date.parse(parent.at) + GRACE_MS + 5_000,
        "child tree ended",
      );
      expect(gone).toBeLessThanOrEqual(Date.parse(parent.at) + GRACE_MS);
    }, 90_000);

    it("trial 8: extending the parent past the child's creation-time deadline keeps the child running", async () => {
      const dir = tempDir();
      const deadlines = new RunDeadlines({ dir: join(dir, "deadlines"), onExpire: () => {} });
      const first = deadlines.toPoint(inMs(WINDOW_MS));
      deadlines.admit("parent", first, null);
      await deadlines.attachScope("parent", mintRunScopeMarker());
      deadlines.admit("child", null, "parent");
      const marker = mintRunScopeMarker();
      await deadlines.attachScope("child", marker);
      const tree = await launchTree(marker);
      const extended = await deadlines.set(
        "parent",
        { at: inMs(WINDOW_MS + GRACE_MS + 12_000), expectedRevision: 0 },
        { live: true, delegated: false },
      );
      expect(deadlines.snapshot("child")?.at).toBe(extended.at);
      deadlines.dispose();
      // Past the old deadline AND the warden's whole old grace window: still running.
      await sleep(Date.parse(first.at) + GRACE_MS + 1_000 - Date.now());
      expect(allAlive(tree)).toBe(true);
      const gone = await until(
        () => !anyAlive(tree),
        Date.parse(extended.at) + GRACE_MS + 5_000,
        "child tree ended",
      );
      expect(gone).toBeGreaterThanOrEqual(Date.parse(extended.at));
      expect(gone).toBeLessThanOrEqual(Date.parse(extended.at) + GRACE_MS);
    }, 120_000);

    it("trial 9: a backwards wall-clock step at the server does not postpone the warden", async () => {
      const dir = tempDir();
      let stepped = false;
      const system = systemDeadlineClock();
      const clock: RunDeadlineClock = {
        ...system,
        wallNow: () => (stepped ? Date.now() - 3_600_000 : Date.now()),
      };
      const deadlines = new RunDeadlines({
        dir: join(dir, "deadlines"),
        clock,
        onExpire: () => {},
      });
      const point = deadlines.toPoint(inMs(WINDOW_MS));
      deadlines.admit("run", point, null);
      const marker = mintRunScopeMarker();
      await deadlines.attachScope("run", marker);
      const tree = await launchTree(marker);
      stepped = true;
      expect(Date.parse(deadlines.snapshot("run")!.serverNow)).toBeLessThan(Date.now() - 3_000_000);
      deadlines.dispose();
      const gone = await until(
        () => !anyAlive(tree),
        Date.parse(point.at) + GRACE_MS + 5_000,
        "tree ended",
      );
      expect(gone).toBeLessThanOrEqual(Date.parse(point.at) + GRACE_MS);
    }, 90_000);
  },
);
