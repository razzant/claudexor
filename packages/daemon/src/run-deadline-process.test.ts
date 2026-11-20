/**
 * run-deadline/1 invariant 4 with real processes: contract trials 3, 4 and 8,
 * and 9 at the warden. A real DaemonServer runs in its own process
 * (`test-support/run-deadline-daemon-child.ts`, without the startup crash GC)
 * or the registry runs here with its timers unable to act; either way only the
 * detached warden can end the run's processes, so passing proves enforcement,
 * never cleanup at the next daemon start.
 *
 * Safety: every signal this file sends goes to a pid it spawned itself (the
 * child daemon) or that its own spawn recorded (a harness and its grandchild).
 * The wardens end only processes carrying a random per-run marker.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { mintRunScopeMarker } from "@claudexor/core";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DaemonClient } from "./client.js";
import { RunDeadlines, type RunDeadlineClock } from "./run-deadlines.js";
import { RUN_DEADLINE_STOP_GRACE_SEC } from "./run-deadline-warden.js";

const GRACE_MS = RUN_DEADLINE_STOP_GRACE_SEC * 1_000;
const CHILD = fileURLToPath(
  new URL("./test-support/run-deadline-daemon-child.ts", import.meta.url),
);
const HARNESS = `
const { spawn } = require("node:child_process");
const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { detached: true, stdio: "ignore" });
g.unref();
process.stdout.write(JSON.stringify({ child: process.pid, grandchild: g.pid }) + "\\n");
setInterval(() => {}, 1e6);
`;

const dirs: string[] = [];
const ownedPids = new Set<number>();
const daemons: ChildProcess[] = [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

afterEach(() => {
  // Only what this file started: its child daemons and the trees they recorded.
  for (const daemon of daemons.splice(0)) if (daemon.exitCode === null) daemon.kill("SIGKILL");
  for (const pid of ownedPids) if (alive(pid)) process.kill(pid, "SIGKILL");
  ownedPids.clear();
  // Removing a state file releases its warden (it exits on its next poll).
  for (const dir of dirs) rmSync(join(dir, "deadlines"), { recursive: true, force: true });
});
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "d-rdp-")));
  dirs.push(dir);
  return dir;
}

async function until(check: () => boolean, deadlineMs: number, label: string): Promise<number> {
  for (;;) {
    if (check()) return Date.now();
    if (Date.now() > deadlineMs) throw new Error(`timed out: ${label}`);
    await sleep(50);
  }
}

async function startDaemon(dir: string): Promise<ChildProcess> {
  rmSync(join(dir, "ready"), { force: true });
  const daemon = spawn(process.execPath, ["--import", "tsx", CHILD, dir], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    stdio: "ignore",
  });
  daemons.push(daemon);
  await until(() => existsSync(join(dir, "ready")), Date.now() + 20_000, "daemon ready");
  return daemon;
}

async function killDaemon(daemon: ChildProcess): Promise<void> {
  const exited = new Promise((resolve) => daemon.once("exit", resolve));
  daemon.kill("SIGKILL");
  await exited;
}

async function recordedTree(dir: string, count = 1) {
  const path = join(dir, "pids.jsonl");
  await until(
    () => existsSync(path) && readFileSync(path, "utf8").trim().split("\n").length >= count,
    Date.now() + 20_000,
    "run launched",
  );
  const rows = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { jobId: string; child: number; grandchild: number });
  for (const row of rows) {
    ownedPids.add(row.child);
    ownedPids.add(row.grandchild);
  }
  return rows;
}

/** A harness carrying `marker` that starts a grandchild in its own session. */
async function launchTree(marker: string) {
  const harness = spawn(process.execPath, ["-e", HARNESS], {
    env: { ...process.env, [marker]: "1" },
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  harness.unref();
  const line = await new Promise<string>((resolve) =>
    createInterface({ input: harness.stdout! }).once("line", resolve),
  );
  const pids = JSON.parse(line) as { child: number; grandchild: number };
  ownedPids.add(pids.child);
  ownedPids.add(pids.grandchild);
  return pids;
}

const treeAlive = (tree: { child: number; grandchild: number }) =>
  alive(tree.child) || alive(tree.grandchild);
const treeWholeAlive = (tree: { child: number; grandchild: number }) =>
  alive(tree.child) && alive(tree.grandchild);

describe("run-deadline/1 warden: no run process outlives deadline + stopGraceSec", () => {
  it("trial 3: SIGKILL of the daemon while running; the setsid grandchild ends too, daemon still down", async () => {
    const dir = tempDir();
    const daemon = await startDaemon(dir);
    const client = new DaemonClient(join(dir, "d.sock"), "token");
    const at = inMs(4_000);
    await client.enqueue(
      { label: "t3", deadline: { at } },
      { idempotencyKey: "t3", clientId: "t" },
    );
    const [tree] = await recordedTree(dir);
    await killDaemon(daemon);
    expect(treeWholeAlive(tree!)).toBe(true); // the daemon's death ended nothing
    await sleep(Math.max(0, Date.parse(at) - Date.now() - 300));
    expect(treeWholeAlive(tree!)).toBe(true); // nothing ends early
    const gone = await until(
      () => !treeAlive(tree!),
      Date.parse(at) + GRACE_MS + 5_000,
      "tree ended",
    );
    expect(gone).toBeLessThanOrEqual(Date.parse(at) + GRACE_MS);
    expect(daemon.exitCode ?? daemon.signalCode).toBe("SIGKILL");
  }, 60_000);

  it("trial 4: restart while running; the new daemon reads the run interrupted and expired", async () => {
    const dir = tempDir();
    const first = await startDaemon(dir);
    const at = inMs(4_000);
    const accepted = await new DaemonClient(join(dir, "d.sock"), "token").enqueue(
      { label: "t4", deadline: { at } },
      { idempotencyKey: "t4", clientId: "t" },
    );
    const [tree] = await recordedTree(dir);
    await killDaemon(first);
    await startDaemon(dir); // no startup crash GC in this daemon
    const client = new DaemonClient(join(dir, "d.sock"), "token");
    expect(treeWholeAlive(tree!)).toBe(true);
    const gone = await until(
      () => !treeAlive(tree!),
      Date.parse(at) + GRACE_MS + 5_000,
      "tree ended",
    );
    expect(gone).toBeLessThanOrEqual(Date.parse(at) + GRACE_MS);
    expect(gone).toBeGreaterThanOrEqual(Date.parse(at));
    expect(await client.status(accepted.id)).toMatchObject({ state: "interrupted" });
    expect(await client.runDeadline(accepted.id, { action: "read" })).toMatchObject({
      at,
      revision: 0,
      state: "expired",
    });
  }, 60_000);

  it("trial 8: a Delegate child's processes end by the parent's deadline with the daemon unable to act", async () => {
    const dir = tempDir();
    const deadlines = new RunDeadlines({ dir: join(dir, "deadlines"), onExpire: () => {} });
    const parentAt = inMs(3_000);
    deadlines.admit("parent", { deadline: { at: parentAt } }, null);
    deadlines.admit("child", { deadline: { at: inMs(120_000) } }, "parent");
    const marker = mintRunScopeMarker();
    await deadlines.attachScope("child", marker);
    const tree = await launchTree(marker);
    deadlines.dispose(); // the "daemon" is gone: no timer of it can act any more
    await sleep(Math.max(0, Date.parse(parentAt) - Date.now() - 300));
    expect(treeWholeAlive(tree)).toBe(true);
    const gone = await until(
      () => !treeAlive(tree),
      Date.parse(parentAt) + GRACE_MS + 5_000,
      "child tree ended",
    );
    expect(gone).toBeLessThanOrEqual(Date.parse(parentAt) + GRACE_MS);
  }, 60_000);

  it("trial 8: extending the parent past the child's creation-time deadline keeps the child running", async () => {
    const dir = tempDir();
    const deadlines = new RunDeadlines({ dir: join(dir, "deadlines"), onExpire: () => {} });
    const firstAt = inMs(2_000);
    deadlines.admit("parent", { deadline: { at: firstAt } }, null);
    deadlines.admit("child", {}, "parent");
    const marker = mintRunScopeMarker();
    await deadlines.attachScope("child", marker);
    const tree = await launchTree(marker);
    const extended = deadlines.set(
      "parent",
      { at: inMs(18_000), expectedRevision: 0 },
      { live: true, delegated: false },
    );
    expect(deadlines.snapshot("child")?.at).toBe(extended.at);
    deadlines.dispose();
    // Past the old deadline AND the warden's whole old grace window: still running.
    await sleep(Date.parse(firstAt) + 12_000 - Date.now());
    expect(treeWholeAlive(tree)).toBe(true);
    const gone = await until(
      () => !treeAlive(tree),
      Date.parse(extended.at) + GRACE_MS + 5_000,
      "child tree ended",
    );
    expect(gone).toBeGreaterThanOrEqual(Date.parse(extended.at));
    expect(gone).toBeLessThanOrEqual(Date.parse(extended.at) + GRACE_MS);
  }, 60_000);

  it("trial 9: a backwards wall-clock step at the server does not postpone the warden", async () => {
    const dir = tempDir();
    let stepped = false;
    const clock: RunDeadlineClock = {
      wallNow: () => (stepped ? Date.now() - 3_600_000 : Date.now()),
      monoNow: () => process.hrtime.bigint(),
    };
    const deadlines = new RunDeadlines({
      dir: join(dir, "deadlines"),
      clock,
      onExpire: () => {},
    });
    const at = inMs(2_500);
    deadlines.admit("run", { deadline: { at } }, null);
    const marker = mintRunScopeMarker();
    await deadlines.attachScope("run", marker);
    const tree = await launchTree(marker);
    stepped = true;
    expect(Date.parse(deadlines.snapshot("run")!.serverNow)).toBeLessThan(Date.now() - 3_000_000);
    deadlines.dispose();
    const gone = await until(
      () => !treeAlive(tree),
      Date.parse(at) + GRACE_MS + 5_000,
      "tree ended",
    );
    expect(gone).toBeLessThanOrEqual(Date.parse(at) + GRACE_MS);
  }, 60_000);
});
