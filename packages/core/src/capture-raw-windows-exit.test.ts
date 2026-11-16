// #694 V17: on Windows a capture's tree kill is `taskkill` by the direct
// child's numeric pid. Once that child's exit has been observed, the pid may
// name another process, so a later Stop, its escalation or a timeout sends no
// taskkill; descendants still holding our pipes are left to the bounded drain
// and the stop is disclosed unconfirmed. While the child has not exited, the
// stop still takes the taskkill path.
//
// No process exists here: `spawn` returns a scripted ChildProcess, the process
// registry is a no-op, and the taskkill is an injected spy (the Windows kill
// strategy injected on any host).
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const PID = 424242;
class ScriptedChild extends EventEmitter {
  readonly pid = PID;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly kills: string[] = [];
  private exited: [number | null, NodeJS.Signals | null] | null = null;
  private openStreams = 2;
  constructor() {
    super();
    for (const stream of [this.stdout, this.stderr])
      stream.once("close", () => {
        this.openStreams -= 1;
        this.closeIfDone();
      });
  }
  kill(signal: string): boolean {
    // A pinned ChildProcess whose exit was observed signals nothing (Node: no handle).
    this.kills.push(signal);
    return false;
  }
  /** The direct child exits; a descendant may still hold the pipes open. */
  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exited = [code, signal];
    this.emit("exit", code, signal);
    this.closeIfDone();
  }
  /** Every holder of the pipes let go. */
  endPipes(): void {
    this.stdout.end();
    this.stderr.end();
    this.stdout.resume();
    this.stderr.resume();
  }
  private closeIfDone(): void {
    if (this.exited && this.openStreams === 0) this.emit("close", ...this.exited);
  }
}

let child: ScriptedChild;
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: () => child,
}));
vi.mock("./process-registry.js", async (original) => ({
  ...(await original<typeof import("./process-registry.js")>()),
  registerChildProcess: () => null,
  retireChildProcess: () => undefined,
  unregisterChildProcess: () => undefined,
}));
const { runCaptureRaw } = await import("./capture-raw.js");

function capture(extra: Parameters<typeof runCaptureRaw>[2] = {}) {
  child = new ScriptedChild();
  const taskkill = vi.fn((pid: number) => ({ status: "killed" as const, pid }));
  const controller = new AbortController();
  const running = runCaptureRaw(process.execPath, ["scripted"], {
    killTreeStrategy: "windows_taskkill",
    windowsKillTree: taskkill,
    abortSignal: controller.signal,
    exitDrainMs: 50,
    probeGroupAlive: () => false,
    ...extra,
  });
  return { running, taskkill, controller, child };
}
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Windows taskkill after an observed direct exit (#694 V17)", () => {
  it("a Stop after the direct child exited, and its escalation, send no taskkill; the stop is unconfirmed", async () => {
    const { running, taskkill, controller, child } = capture({ cancelKillDelayMs: 20 });
    child.exit(0);
    controller.abort("stop");
    const result = await running;
    expect(taskkill).not.toHaveBeenCalled();
    expect(child.kills).toEqual(["SIGINT", "SIGKILL"]);
    expect(result.termination).toMatchObject({
      status: "unconfirmed",
      reason: "output_held",
      directExited: true,
    });
  });

  it("the escalation after a taskkill'd child exited sends no second taskkill", async () => {
    const { running, taskkill, controller, child } = capture({ cancelKillDelayMs: 30 });
    controller.abort("stop");
    expect(taskkill.mock.calls).toEqual([[PID]]);
    child.exit(1);
    const result = await running;
    expect(taskkill).toHaveBeenCalledTimes(1);
    expect(result.termination).toMatchObject({ status: "unconfirmed", directExited: true });
  });

  it("a timeout after the direct child exited sends no taskkill", async () => {
    const { running, taskkill, child } = capture({ timeoutMs: 20, cancelKillDelayMs: -1 });
    child.exit(0);
    const result = await running;
    expect(taskkill).not.toHaveBeenCalled();
    expect(result.termination).toMatchObject({ status: "unconfirmed", directExited: true });
  });

  it("control: a Stop while the direct child runs takes the taskkill path, and nothing else", async () => {
    const { running, taskkill, controller, child } = capture({ cancelKillDelayMs: -1 });
    controller.abort("stop");
    expect(taskkill.mock.calls).toEqual([[PID]]);
    expect(child.kills).toEqual([]);
    await tick(5);
    child.exit(1);
    child.endPipes();
    const result = await running;
    expect(taskkill).toHaveBeenCalledTimes(1);
    expect(result.termination?.status).toBe("confirmed");
  });
});
