// #694: what a stop WE asked for becomes. Every process here is this test's own
// child or grandchild; survivors are ended by their exact PID after their start
// time was re-read (a recycled PID never matches), never by a group or a name.
import { afterEach, describe, expect, it } from "vitest";
import { runCaptureRaw, type CaptureTermination } from "./proc.js";
import { ProcessGroupService } from "./process-group.js";
import type { ProcessIdentityReader } from "./process-identity.js";
import { endIdentified, startOf, type Identity } from "./test-support/process-fixtures.js";

const posix = process.platform !== "win32";

const own: Identity[] = [];
const remember = (pid: number): void => {
  const start = startOf(pid);
  if (start === null) throw new Error(`the start time of own process ${pid} could not be read`);
  if (start !== "gone") own.push({ pid, start });
};
/** End this test's own processes by measured identity (`endIdentified`). */
const endOwn = (): Promise<void> => endIdentified(own);
afterEach(endOwn);

const until = async (what: string, ok: () => boolean, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** Identity reads that always answer "unknown" (an unreadable kernel read). */
const unknown = (pid: number) =>
  ({ status: "unknown", pid, platform: process.platform, reason: "helper_failed" }) as never;
const unknownIdentity: ProcessIdentityReader = { read: unknown, self: () => unknown(process.pid) };

/** A direct child that prints the PID of a grandchild in ITS group which ignores
 * INT/TERM; `holdPipes` keeps the grandchild on our stdout/stderr. */
const parentWithSurvivor = (holdPipes: boolean): string[] => [
  "-e",
  `
  const { spawn } = require('node:child_process');
  const g = spawn(process.execPath, ['-e', "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send('ready',()=>process.disconnect())"],
    { stdio: ${holdPipes ? "['ignore','inherit','inherit','ipc']" : "['ignore','ignore','ignore','ipc']"} });
  // Reported only once its handlers are installed: a stop cannot race them.
  g.once('message', () => { g.disconnect(); process.stdout.write('grandchild ' + g.pid + '\\n'); });
  setInterval(()=>{},1000);
  `,
];

const grandchildOf = (stdout: string): number => Number(/grandchild (\d+)/.exec(stdout)?.[1]);

describe.runIf(posix)("runCaptureRaw stop outcome (#694)", () => {
  it("an ordinary run carries no stop outcome and keeps its exact bytes", async () => {
    const r = await runCaptureRaw(process.execPath, ["-e", "process.stdout.write('a\\r\\nb')"]);
    expect(r.stdout).toBe("a\r\nb");
    expect(r.termination).toBeUndefined();
    expect(r.drain).toBeUndefined();
  });

  it("a stopped child whose group is empty is confirmed", async () => {
    const controller = new AbortController();
    const running = runCaptureRaw(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      abortSignal: controller.signal,
      cancelKillDelayMs: 0,
      cancelSignal: "SIGKILL",
    });
    setTimeout(() => controller.abort("stop"), 100);
    const r = await running;
    expect(r.termination).toEqual({ status: "confirmed", proof: "group_empty" });
  });

  it("identity unknown at spawn: a grandchild holding our pipes ends the wait as unconfirmed after the bounded drain", async () => {
    const controller = new AbortController();
    let stdout = "";
    const running = runCaptureRaw(process.execPath, parentWithSurvivor(true), {
      abortSignal: controller.signal,
      processGroups: new ProcessGroupService({ identity: unknownIdentity }),
      exitDrainMs: 200,
      exitDrainMaxMs: 2_000,
      onOutput: () => {},
      stdoutProjection: {
        write: (chunk) => {
          stdout += chunk.toString();
        },
        end: () => stdout,
      },
    });
    await until("the grandchild to report", () => /grandchild \d+/.test(stdout));
    remember(grandchildOf(stdout));
    const started = Date.now();
    controller.abort("stop");
    const r = await running;
    expect(Date.now() - started).toBeLessThan(8_000);
    const t = r.termination as Extract<CaptureTermination, { status: "unconfirmed" }>;
    expect(t.status).toBe("unconfirmed");
    expect(t.reason).toBe("output_held");
    expect(t.directExited).toBe(true);
    expect(typeof t.directExitObservedAt).toBe("number");
    expect(r.drain).toBe("truncated");
    // A cut capture is never a success, whatever the exit status was.
    expect(r.code).toBeNull();
    await t.directExit;
  });

  it("identity unknown at signal: the direct child is reached through its ChildProcess, never a group signal", async () => {
    const groupSignals: Array<[number, NodeJS.Signals]> = [];
    let reads = 0;
    const identity: ProcessIdentityReader = {
      read: (pid: number) => {
        reads += 1;
        // The capture read succeeds (pid is its own group leader); every later read is unreadable.
        if (reads === 1) {
          return {
            status: "known",
            pid,
            platform: process.platform,
            source: "test",
            startToken: "t",
            processGroupId: pid,
          } as never;
        }
        return unknown(pid);
      },
      self: () => unknown(process.pid),
    };
    const controller = new AbortController();
    const running = runCaptureRaw(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      abortSignal: controller.signal,
      processGroups: new ProcessGroupService({
        identity,
        signalProcessGroup: (pgid, signal) => groupSignals.push([pgid, signal]),
      }),
    });
    setTimeout(() => controller.abort("stop"), 100);
    const r = await running;
    expect(groupSignals).toEqual([]);
    expect(r.signal).toBe("SIGINT");
    expect(r.termination).toEqual({ status: "confirmed", proof: "group_empty" });
  });

  it("a leader that exits before the escalation gets no group SIGKILL; its surviving group member is disclosed", async () => {
    const groupSignals: Array<[number, NodeJS.Signals]> = [];
    const service = new ProcessGroupService({
      signalProcessGroup: (pgid, signal) => {
        groupSignals.push([pgid, signal]);
        process.kill(pgid, signal);
      },
    });
    const controller = new AbortController();
    let stdout = "";
    const running = runCaptureRaw(process.execPath, parentWithSurvivor(true), {
      abortSignal: controller.signal,
      processGroups: service,
      cancelKillDelayMs: 500,
      exitDrainMs: 200,
      exitDrainMaxMs: 3_000,
      stdoutProjection: {
        write: (chunk) => {
          stdout += chunk.toString();
        },
        end: () => stdout,
      },
    });
    await until("the grandchild to report", () => /grandchild \d+/.test(stdout));
    remember(grandchildOf(stdout));
    controller.abort("stop");
    const r = await running;
    // SIGINT reached the whole group (the leader died of it); the 500 ms SIGKILL
    // found the leader missing and was refused.
    expect(groupSignals.map(([, s]) => s)).toEqual(["SIGINT"]);
    expect(r.termination).toMatchObject({ status: "unconfirmed", directExited: true });
  });

  it("a member that closed our pipes but stays in the group keeps the stop unconfirmed", async () => {
    const controller = new AbortController();
    let stdout = "";
    const running = runCaptureRaw(process.execPath, parentWithSurvivor(false), {
      abortSignal: controller.signal,
      stdoutProjection: {
        write: (chunk) => {
          stdout += chunk.toString();
        },
        end: () => stdout,
      },
    });
    await until("the grandchild to report", () => /grandchild \d+/.test(stdout));
    const grandchild = grandchildOf(stdout);
    remember(grandchild);
    controller.abort("stop");
    const r = await running;
    expect(r.termination).toMatchObject({
      status: "unconfirmed",
      reason: "group_alive",
      directExited: true,
    });
    expect(r.drain).toBeUndefined();
  });

  it("a direct child that never exits ends the wait at the bound; its later exit is still observed", async () => {
    // The group signal is swallowed, so nothing reaches the child: it stands for
    // one that cannot exit (for example blocked in the kernel).
    const service = new ProcessGroupService({ signalProcessGroup: () => {} });
    const controller = new AbortController();
    const running = runCaptureRaw(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      abortSignal: controller.signal,
      processGroups: service,
      cancelKillDelayMs: 0,
      cancelDeadlineMs: 300,
      onExit: () => {},
    });
    controller.abort("stop");
    const r = await running;
    const t = r.termination as Extract<CaptureTermination, { status: "unconfirmed" }>;
    expect(t).toMatchObject({
      status: "unconfirmed",
      reason: "direct_child_alive",
      directExited: false,
    });
    expect(t.rootPid).toBeGreaterThan(0);
    remember(t.rootPid!);
    let exited = false;
    void t.directExit.then(() => {
      exited = true;
    });
    await new Promise((r2) => setTimeout(r2, 100));
    expect(exited).toBe(false);
    await endOwn();
    await t.directExit;
    expect(exited).toBe(true);
  });

  it("a timeout is a stop we asked for: its outcome is recorded", async () => {
    const r = await runCaptureRaw(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeoutMs: 100,
    });
    expect(r.signal).toBe("SIGKILL");
    expect(r.termination).toEqual({ status: "confirmed", proof: "group_empty" });
  });

  it("a child that exited 0 while a descendant kept our pipes: the time bound ends the wait and the cut capture is not a success", async () => {
    let stdout = "";
    const r = await runCaptureRaw(
      process.execPath,
      [
        "-e",
        `const g=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','inherit','inherit']});process.stdout.write('grandchild '+g.pid+'\\n');g.unref();`,
      ],
      {
        timeoutMs: 500,
        exitDrainMs: 100,
        exitDrainMaxMs: 1_000,
        stdoutProjection: {
          write: (chunk) => {
            stdout += chunk.toString();
          },
          end: () => stdout,
        },
      },
    );
    remember(grandchildOf(stdout));
    expect(r.code).toBeNull();
    expect(r.drain).toBe("truncated");
    expect(r.termination).toMatchObject({
      status: "unconfirmed",
      reason: "output_held",
      directExited: true,
    });
  });
});
