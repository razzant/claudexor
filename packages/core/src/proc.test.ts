import { ModelPreparationTiming } from "@claudexor/util";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  armOrphanExit,
  labelStreams,
  runCaptureRaw,
  spawnProcess,
  type ChildStdin,
  type SpawnOptions,
} from "./proc.js";
import { ProcessGroupService } from "./process-group.js";
import type { ProcessIdentity, ProcessIdentityReader } from "./process-identity.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "claudexor-proc-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

describe("spawnProcess", () => {
  it("exposes child closure to bidirectional session handlers", async () => {
    let closed: Promise<void> | undefined;
    for await (const _ev of spawnProcess(process.execPath, ["-e", "process.exit(0)"], {
      keepStdinOpen: true,
      onSpawn: (io) => {
        closed = io.closed;
      },
    })) {
      // Consume the terminal event so the process lifecycle is complete.
    }

    expect(closed).toBeDefined();
    await expect(closed).resolves.toBeUndefined();
  });

  it("reaches exit when a leftover inherits the stdout pipe (bounded post-exit drain)", async () => {
    // The parent writes a line, spawns a child that INHERITS stdout and lives
    // on, then exits. Without the drain, `close` never fires (the child holds
    // the pipe) and the generator hangs; the bounded drain force-closes our
    // side so the exit event arrives, marked truncated.
    const script = [
      "const {spawn}=require('node:child_process')",
      "console.log('parent-line')",
      // Child keeps stdout (fd 1) open and never writes, so no output resets
      // the drain clock; it outlives the parent.
      "const c=spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:['ignore',1,'ignore']})",
      "setTimeout(()=>process.exit(0),50)",
    ].join(";");

    const events: string[] = [];
    let exitDrain: string | undefined;
    const started = Date.now();
    let childPid = 0;
    for await (const ev of spawnProcess(process.execPath, ["-e", script], {
      exitDrainMs: 500,
      onExit: () => {},
    })) {
      if (ev.type === "stdout") events.push(ev.line);
      if (ev.type === "exit") exitDrain = ev.drain;
    }
    expect(events).toContain("parent-line");
    expect(exitDrain).toBe("truncated");
    // It ended via the bounded drain, not by hanging to a timeout.
    expect(Date.now() - started).toBeLessThan(4000);
    // The inheriting child is still ours to reap at the barrier, not killed here.
    void childPid;
  }, 15_000);

  it("delivers every frame to a slow (backpressured) bounded consumer after exit, untruncated", async () => {
    // 24 valid ~1 KB frames, then exit. The consumer accepts one frame at a
    // time and pauses 700 ms after the first; the reader is blocked on
    // capacity, which must never count as idle, and raw bytes already in the
    // pipe are progress. Every frame arrives; the exit is not truncated.
    const script = [
      "for (let i = 0; i < 24; i++) console.log(JSON.stringify({ i, pad: 'x'.repeat(1000) }))",
      "process.exit(0)",
    ].join(";");
    const frames: number[] = [];
    let exitDrain: string | undefined = "unset";
    let paused = false;
    for await (const ev of spawnProcess(process.execPath, ["-e", script], {
      exitDrainMs: 150,
      streamLimits: { stdoutFrameBytes: 65_536, queuedFrames: 1, stderrBytes: 4096 },
    })) {
      if (ev.type === "stdout") {
        frames.push((JSON.parse(ev.line) as { i: number }).i);
        if (!paused) {
          paused = true;
          await new Promise((resolve) => setTimeout(resolve, 700));
        }
      }
      if (ev.type === "exit") exitDrain = ev.drain;
    }
    expect(frames).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(exitDrain).toBeUndefined();
  }, 15_000);

  it("bounds the drain absolutely when a leftover keeps writing to the inherited pipe", async () => {
    // The descendant writes every 25 ms for 10 s; the quiet window never
    // elapses, so only the absolute post-exit bound can end the drain.
    const script = [
      "const {spawn}=require('node:child_process')",
      "console.log('parent-line')",
      "spawn(process.execPath,['-e','setInterval(()=>console.log(\"tick\"),25);setTimeout(()=>{},10000)'],{stdio:['ignore',1,'ignore']})",
      "setTimeout(()=>process.exit(0),100)",
    ].join(";");
    const started = Date.now();
    let ticks = 0;
    let exitDrain: string | undefined;
    let threw: unknown = null;
    try {
      for await (const ev of spawnProcess(process.execPath, ["-e", script], {
        exitDrainMs: 200,
        exitDrainMaxMs: 1_000,
      })) {
        if (ev.type === "stdout" && ev.line === "tick") ticks += 1;
        if (ev.type === "exit") exitDrain = ev.drain;
      }
    } catch (error) {
      threw = error;
    }
    expect(threw).toBeNull();
    expect(ticks).toBeGreaterThan(0);
    expect(exitDrain).toBe("truncated");
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 15_000);

  it("a forced closure on the bounded (ACP) reader path is never a read failure or an unconfirmed death", async () => {
    const script = [
      "const {spawn}=require('node:child_process')",
      "console.log(JSON.stringify({hello:1}))",
      "spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:['ignore',1,'ignore']})",
      "setTimeout(()=>process.exit(0),50)",
    ].join(";");
    const lines: string[] = [];
    let exitDrain: string | undefined;
    let unconfirmed = false;
    let threw: unknown = null;
    const started = Date.now();
    try {
      for await (const ev of spawnProcess(process.execPath, ["-e", script], {
        exitDrainMs: 300,
        streamLimits: { stdoutFrameBytes: 65_536, queuedFrames: 8, stderrBytes: 4096 },
        onTerminationUnconfirmed: () => {
          unconfirmed = true;
        },
      })) {
        if (ev.type === "stdout") lines.push(ev.line);
        if (ev.type === "exit") exitDrain = ev.drain;
        if (ev.type === "termination_unconfirmed") unconfirmed = true;
      }
    } catch (error) {
      threw = error;
    }
    expect(threw).toBeNull();
    expect(unconfirmed).toBe(false);
    expect(lines).toEqual([JSON.stringify({ hello: 1 })]);
    expect(exitDrain).toBe("truncated");
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 15_000);

  it("forced closure delivers every frame already read: paused bounded consumer + held pipe + absolute cap (24/24)", async () => {
    // 24 frames in one batch, a silent descendant holding stdout, a consumer
    // that pauses 700 ms after the first frame, and a drain that is forced by
    // the ABSOLUTE cap (300 ms) long before the consumer resumes: every frame
    // already read from the pipe must still arrive; the exit says truncated.
    const script = [
      "const {spawn}=require('node:child_process')",
      "let out='';for (let i = 0; i < 24; i++) out += JSON.stringify({ i, pad: 'x'.repeat(1000) }) + '\\n'",
      "process.stdout.write(out)",
      "spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:['ignore',1,'ignore']})",
      "setTimeout(()=>process.exit(0),50)",
    ].join(";");
    const frames: number[] = [];
    let exitDrain: string | undefined = "unset";
    let paused = false;
    let threw: unknown = null;
    try {
      for await (const ev of spawnProcess(process.execPath, ["-e", script], {
        exitDrainMs: 100,
        exitDrainMaxMs: 300,
        streamLimits: { stdoutFrameBytes: 65_536, queuedFrames: 1, stderrBytes: 4096 },
      })) {
        if (ev.type === "stdout") {
          frames.push((JSON.parse(ev.line) as { i: number }).i);
          if (!paused) {
            paused = true;
            await new Promise((resolve) => setTimeout(resolve, 700));
          }
        }
        if (ev.type === "exit") exitDrain = ev.drain;
      }
    } catch (error) {
      threw = error;
    }
    expect(threw).toBeNull();
    expect(frames).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(exitDrain).toBe("truncated");
  }, 20_000);

  it.each([
    { cap: 300, when: "fires mid-stall" },
    { cap: 30_000, when: "never fires (control)" },
  ])(
    "forced closure keeps every frame already acquired beyond one native read chunk: 96 frames, both pipes held, cap $when (96/96)",
    async ({ cap }) => {
      // Astra's R2 fixture: 96 ~1 KB frames in ONE batch (~98 KB: several
      // native pipe reads), queue bound 1, the root exits after 100 ms while
      // a silent descendant holds BOTH pipes, the consumer pauses 700 ms
      // after the first frame. With the 300 ms absolute cap firing during the
      // stall, every complete frame already read from the OS — in the parser's
      // chunk and in the Readable's buffer — must still arrive; the 30 s
      // control (the consumer resumes first) is the same 96/96.
      const script = [
        "const {spawn}=require('node:child_process')",
        "let out='';for (let i = 0; i < 96; i++) out += JSON.stringify({ i, pad: 'x'.repeat(1000) }) + '\\n'",
        "process.stdout.write(out)",
        "process.stderr.write('diagnostic kept\\n')",
        "spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:['ignore',1,2]})",
        "setTimeout(()=>process.exit(0),100)",
      ].join(";");
      const frames: number[] = [];
      const stderr: string[] = [];
      let exitDrain: string | undefined = "unset";
      let paused = false;
      let threw: unknown = null;
      try {
        for await (const ev of spawnProcess(process.execPath, ["-e", script], {
          exitDrainMs: 100,
          exitDrainMaxMs: cap,
          streamLimits: { stdoutFrameBytes: 65_536, queuedFrames: 1, stderrBytes: 4096 },
        })) {
          if (ev.type === "stdout") {
            frames.push((JSON.parse(ev.line) as { i: number }).i);
            if (!paused) {
              paused = true;
              await new Promise((resolve) => setTimeout(resolve, 700));
            }
          }
          if (ev.type === "stderr") stderr.push(ev.line);
          if (ev.type === "exit") exitDrain = ev.drain;
        }
      } catch (error) {
        threw = error;
      }
      expect(threw).toBeNull();
      expect(frames).toEqual(Array.from({ length: 96 }, (_, i) => i));
      expect(stderr.join("\n")).toContain("diagnostic kept");
      expect(exitDrain).toBe("truncated");
    },
    20_000,
  );

  it("forced closure delivers frames that arrived as separate pipe chunks: paused consumer, cap mid-stall (24/24)", async () => {
    // Same shape, but the 24 frames are written one per 10 ms so they arrive
    // as many pipe chunks. While the bounded consumer is paused the reader
    // sits on ONE chunk; the rest are read from the OS into the Readable's
    // buffer and must survive the forced closure (they are handed to the
    // parser before the stream is ended, never destroyed with it).
    const script = [
      "const {spawn}=require('node:child_process')",
      "let i=0",
      "const t=setInterval(()=>{process.stdout.write(JSON.stringify({ i, pad: 'x'.repeat(1000) })+'\\n');if(++i===24){clearInterval(t);spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:['ignore',1,'ignore']});setTimeout(()=>process.exit(0),50)}},10)",
    ].join(";");
    const frames: number[] = [];
    let exitDrain: string | undefined = "unset";
    let paused = false;
    let threw: unknown = null;
    try {
      for await (const ev of spawnProcess(process.execPath, ["-e", script], {
        exitDrainMs: 100,
        exitDrainMaxMs: 300,
        streamLimits: { stdoutFrameBytes: 65_536, queuedFrames: 1, stderrBytes: 4096 },
      })) {
        if (ev.type === "stdout") {
          frames.push((JSON.parse(ev.line) as { i: number }).i);
          if (!paused) {
            paused = true;
            await new Promise((resolve) => setTimeout(resolve, 1_500));
          }
        }
        if (ev.type === "exit") exitDrain = ev.drain;
      }
    } catch (error) {
      threw = error;
    }
    expect(threw).toBeNull();
    expect(frames).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(exitDrain).toBe("truncated");
  }, 20_000);

  it("forced closure keeps a diagnostic already written to stderr while a descendant holds stderr", async () => {
    const script = [
      "const {spawn}=require('node:child_process')",
      "process.stderr.write('diag: something went wrong\\n')",
      "spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:['ignore','ignore',2]})",
      "setTimeout(()=>process.exit(3),50)",
    ].join(";");
    const stderr: string[] = [];
    let exitDrain: string | undefined;
    let code: number | null = null;
    for await (const ev of spawnProcess(process.execPath, ["-e", script], {
      exitDrainMs: 200,
      streamLimits: { stdoutFrameBytes: 65_536, queuedFrames: 8, stderrBytes: 4096 },
    })) {
      if (ev.type === "stderr") stderr.push(ev.line);
      if (ev.type === "exit") {
        exitDrain = ev.drain;
        code = ev.code;
      }
    }
    expect(stderr.join("\n")).toContain("diag: something went wrong");
    expect(exitDrain).toBe("truncated");
    expect(code).toBe(3);
  }, 15_000);

  it("does not truncate a clean exit whose pipe closes normally", async () => {
    let exitDrain: string | undefined = "unset";
    for await (const ev of spawnProcess(process.execPath, ["-e", "console.log('hi')"], {
      exitDrainMs: 500,
    })) {
      if (ev.type === "exit") exitDrain = ev.drain;
    }
    expect(exitDrain).toBeUndefined();
  });

  it("kills the child when the consumer closes the stream early", async () => {
    const dir = tempDir();
    const marker = join(dir, "survived.txt");
    const script = [
      "console.log('ready')",
      "process.on('SIGINT', () => {})",
      `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 1500)`,
      "setTimeout(() => {}, 5000)",
    ].join(";");

    for await (const ev of spawnProcess(process.execPath, ["-e", script], {
      cancelKillDelayMs: 100,
    })) {
      if (ev.type === "stdout" && ev.line === "ready") break;
    }

    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe("");
  });

  it("kills a silent child when the abort signal fires", async () => {
    const dir = tempDir();
    const marker = join(dir, "survived.txt");
    const script = [
      "console.log('ready')",
      "process.on('SIGINT', () => {})",
      `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 1500)`,
      "setTimeout(() => {}, 5000)",
    ].join(";");
    const ac = new AbortController();
    let sawReady = false;
    const done = (async () => {
      for await (const ev of spawnProcess(process.execPath, ["-e", script], {
        abortSignal: ac.signal,
        cancelKillDelayMs: 100,
      })) {
        if (ev.type === "stdout" && ev.line === "ready") {
          sawReady = true;
          ac.abort();
        }
      }
    })();

    await done;
    expect(sawReady).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe("");
  });

  // QA-027: a vendor tool that setsid'd into its OWN process group and then
  // reparents to pid 1 (its CLI exits on the cooperative signal) must still be
  // dead before the generator returns. A group-kill of the direct child alone
  // leaked exactly this — a `/bin/sleep 60` orphan lived ~40s past terminal.
  it("reaps an ESCAPED descendant process group before the generator returns", async () => {
    const dir = tempDir();
    const marker = join(dir, "escaped.txt");
    // Parent (the direct child) spawns a DETACHED grandchild in a new pgid, then
    // exits promptly on SIGINT — orphaning the grandchild. The grandchild
    // ignores SIGINT and would write the marker at 1500ms if it survives.
    const grandchild = [
      "process.on('SIGINT', () => {})",
      `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 1500)`,
      "setTimeout(() => {}, 5000)",
    ].join(";");
    const parent = [
      "const { spawn } = require('node:child_process')",
      `const gc = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { detached: true, stdio: 'ignore' })`,
      "gc.unref()",
      "console.log('ready ' + gc.pid)",
      "process.on('SIGINT', () => process.exit(0))",
      "setTimeout(() => {}, 5000)",
    ].join(";");

    const ac = new AbortController();
    let escapedPgid = 0;
    for await (const ev of spawnProcess(process.execPath, ["-e", parent], {
      abortSignal: ac.signal,
      cancelKillDelayMs: 150,
    })) {
      if (ev.type === "stdout" && ev.line.startsWith("ready ")) {
        escapedPgid = Number(ev.line.slice("ready ".length));
        // Let the grandchild fully establish its own process group.
        await new Promise((resolve) => setTimeout(resolve, 150));
        ac.abort();
      }
    }

    // The for-await completed => the generator returned. Death proof gates that
    // return, so the escaped group must already be gone: NO post-hoc sleep.
    expect(escapedPgid).toBeGreaterThan(0);
    let groupAlive = true;
    try {
      process.kill(-escapedPgid, 0);
    } catch (err) {
      groupAlive = (err as NodeJS.ErrnoException).code !== "ESRCH";
    }
    expect(groupAlive).toBe(false);

    // And the orphan never got to run its side effect.
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe("");
  });
});

// QA-027 fail-closed disclosure: when the whole-tree death proof cannot confirm
// death, spawnProcess must DISCLOSE it as a typed `termination_unconfirmed` event
// on the active stream (not only the optional callback). The reap is injected so
// the unconfirmed outcome is deterministic.
describe("spawnProcess stdin send: what became of a frame", () => {
  /** Spawn a session child; resolves its live stdin handle, stdout lines and exit. */
  function session(script: string, opts: SpawnOptions = {}) {
    const lines: string[] = [];
    let markExited!: () => void;
    const exited = new Promise<void>((resolve) => (markExited = resolve));
    let markSpawned!: (io: ChildStdin) => void;
    const spawned = new Promise<ChildStdin>((resolve) => (markSpawned = resolve));
    const done = (async () => {
      for await (const ev of spawnProcess(process.execPath, ["-e", script], {
        ...opts,
        keepStdinOpen: true,
        onSpawn: markSpawned,
        onExit: () => markExited(),
      }))
        if (ev.type === "stdout") lines.push(ev.line);
    })();
    const line = async (text: string): Promise<void> => {
      while (!lines.includes(text)) await new Promise((resolve) => setTimeout(resolve, 5));
    };
    return { spawned, exited, done, lines, line };
  }

  it("reports a frame the live child's pipe accepted as written, and nothing after stdin was ended", async () => {
    const child = session(
      "require('node:readline').createInterface({input:process.stdin}).on('line',(l)=>console.log('echo:'+l))",
    );
    const io = await child.spawned;
    await expect(io.send!("ping\n")).resolves.toEqual({ outcome: "written" });
    await child.line("echo:ping");
    io.end();
    await expect(io.send!("late\n")).resolves.toEqual({ outcome: "not_written", reason: "ended" });
    await child.done;
    expect(child.lines).toEqual(["echo:ping"]);
  });

  it("writes nothing once the direct child exited, though a descendant still holds every pipe and `closed` has not settled", async () => {
    // The descendant inherits stdin, stdout and stderr: a plain write would
    // land in a pipe that only it holds and nobody reads.
    const child = session(
      "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},1500)'],{stdio:'inherit'});process.exit(0)",
    );
    const io = await child.spawned;
    await child.exited;
    let closed = false;
    void io.closed.then(() => (closed = true));
    expect(() => io.write("lost\n")).not.toThrow();
    await expect(io.send!("lost\n")).resolves.toEqual({ outcome: "not_written", reason: "exited" });
    expect(closed).toBe(false);
    await child.done;
    expect(closed).toBe(true);
  }, 15_000);

  // POSIX pipe semantics: a reader-less pipe refuses the write with EPIPE.
  it.skipIf(process.platform === "win32")(
    "reports the error of a write the child's closed stdin refused",
    async () => {
      const abort = new AbortController();
      const child = session(
        // Never wraps fd 0 in process.stdin, so the OS read end really closes.
        "require('node:fs').closeSync(0);console.log('stdin-closed');setTimeout(()=>{},10000)",
        { abortSignal: abort.signal },
      );
      const io = await child.spawned;
      await child.line("stdin-closed");
      const sent = await io.send!("refused\n");
      abort.abort();
      await child.done;
      expect(sent).toEqual({
        outcome: "not_written",
        reason: "failed",
        error: expect.stringContaining("EPIPE"),
      });
    },
    15_000,
  );
});

describe("spawnProcess termination_unconfirmed disclosure", () => {
  const quickChild = [
    "console.log('ready')",
    "process.on('SIGINT', () => process.exit(0))",
    "setTimeout(() => {}, 5000)",
  ].join(";");

  it("yields a typed termination_unconfirmed event for a surviving group (after the exit event)", async () => {
    const ac = new AbortController();
    const events: Array<{ type: string; survivors?: number[]; unresolved?: unknown[] }> = [];
    for await (const ev of spawnProcess(process.execPath, ["-e", quickChild], {
      abortSignal: ac.signal,
      cancelKillDelayMs: 50,
      reap: async () => ({ state: "unconfirmed", survivors: [424242], unresolved: [] }),
    })) {
      events.push(ev);
      if (ev.type === "stdout" && ev.line === "ready") ac.abort();
    }
    const disc = events.find((e) => e.type === "termination_unconfirmed");
    expect(disc, "termination_unconfirmed disclosed").toBeTruthy();
    expect(disc?.survivors).toEqual([424242]);
    // It rides AFTER the terminal exit event.
    const exitIdx = events.findIndex((e) => e.type === "exit");
    const discIdx = events.findIndex((e) => e.type === "termination_unconfirmed");
    expect(exitIdx).toBeGreaterThanOrEqual(0);
    expect(discIdx).toBeGreaterThan(exitIdx);
  });

  it("discloses an unreadable-identity group (unresolved) as termination_unconfirmed", async () => {
    const ac = new AbortController();
    const events: Array<{
      type: string;
      survivors?: number[];
      unresolved?: Array<{ pgid: number }>;
    }> = [];
    for await (const ev of spawnProcess(process.execPath, ["-e", quickChild], {
      abortSignal: ac.signal,
      cancelKillDelayMs: 50,
      reap: async () => ({
        state: "unconfirmed",
        survivors: [],
        unresolved: [{ pgid: 999, reason: "leader identity unreadable" }],
      }),
    })) {
      events.push(ev);
      if (ev.type === "stdout" && ev.line === "ready") ac.abort();
    }
    const disc = events.find((e) => e.type === "termination_unconfirmed");
    expect(disc, "termination_unconfirmed disclosed").toBeTruthy();
    expect(disc?.unresolved?.[0]?.pgid).toBe(999);
  });

  it("seeds the direct child's process group identity into the whole-tree reap (round-2 #3)", async () => {
    // The direct child can exit before the cancel-time tree snapshot while a
    // same-pgid grandchild survives; the seeded direct handle keeps that group
    // reapable even though its ppid chain to the root is already gone.
    const ac = new AbortController();
    let seeded: { rootPid?: number; seedHandles?: Array<{ pgid: number }> } | null = null;
    for await (const ev of spawnProcess(process.execPath, ["-e", quickChild], {
      abortSignal: ac.signal,
      cancelKillDelayMs: 50,
      reap: async (opts) => {
        seeded = opts;
        return { state: "confirmed", pgids: [] };
      },
    })) {
      if (ev.type === "stdout" && ev.line === "ready") ac.abort();
    }
    expect(seeded).toBeTruthy();
    expect(seeded!.seedHandles).toHaveLength(1);
    // detached => the direct child is its own group leader (pgid == pid == rootPid).
    expect(seeded!.seedHandles?.[0]?.pgid).toBe(seeded!.rootPid);
  });

  it("does NOT disclose termination_unconfirmed when the reap confirms death", async () => {
    const ac = new AbortController();
    const events: Array<{ type: string }> = [];
    for await (const ev of spawnProcess(process.execPath, ["-e", quickChild], {
      abortSignal: ac.signal,
      cancelKillDelayMs: 50,
      reap: async () => ({ state: "confirmed", pgids: [] }),
    })) {
      events.push(ev);
      if (ev.type === "stdout" && ev.line === "ready") ac.abort();
    }
    expect(events.some((e) => e.type === "termination_unconfirmed")).toBe(false);
  });
});

// Round-4 #1: the direct-group cancel belt must signal ONLY through the captured,
// identity-verified process-group handle — never a raw negative-PID kill that a
// reused PID/PGID could redirect to an unrelated group. When identity cannot be
// proven (capture unknown, or the leader identity changed before escalation) the
// belt sends NOTHING; the whole-tree reap remains the fail-closed disclosure.
describe("spawnProcess identity-proven cancel belt", () => {
  // Child self-exits regardless of signals, so the run terminates cleanly even
  // when the belt (correctly) refuses to signal — isolating the assertion to
  // "was a raw group signal ever emitted?".
  const selfExitChild = ["console.log('ready')", "setTimeout(() => process.exit(0), 300)"].join(
    ";",
  );

  function spyGroupService(identity: ProcessIdentityReader): {
    groups: ProcessGroupService;
    signalled: Array<{ negativePgid: number; signal: string }>;
  } {
    const signalled: Array<{ negativePgid: number; signal: string }> = [];
    const groups = new ProcessGroupService({
      platform: "linux",
      identity,
      probeProcessGroup: () => {},
      signalProcessGroup: (negativePgid, signal) => signalled.push({ negativePgid, signal }),
    });
    return { groups, signalled };
  }

  it("sends NO group signal when the leader identity cannot be captured (unknown)", async () => {
    // Identity is unreadable for every pid -> captureLeader returns `unknown` ->
    // no directGroupHandle -> the belt has nothing it may safely signal.
    const identity: ProcessIdentityReader = {
      read: (pid) => ({ status: "unknown", pid, platform: "linux", reason: "io_error" }),
      self: () => ({ status: "missing", pid: 1, platform: "linux" }),
    };
    const { groups, signalled } = spyGroupService(identity);
    const ac = new AbortController();
    for await (const ev of spawnProcess(process.execPath, ["-e", selfExitChild], {
      abortSignal: ac.signal,
      cancelKillDelayMs: 20,
      processGroups: groups,
      reap: async () => ({ state: "confirmed", pgids: [] }),
    })) {
      if (ev.type === "stdout" && ev.line === "ready") ac.abort();
    }
    expect(signalled).toEqual([]);
  });

  it("refuses to signal when the leader identity CHANGED before escalation (PID reuse)", async () => {
    // First observation is the real leader (captured at spawn); every later read
    // is a different process that reused the pid -> compareLeader='different' ->
    // ProcessGroupService.signal returns `stale_leader` WITHOUT signalling.
    let reads = 0;
    const identity: ProcessIdentityReader = {
      read: (pid): ProcessIdentity => {
        reads += 1;
        return {
          status: "known",
          pid,
          platform: "linux",
          source: "procfs_stat",
          startToken: reads <= 1 ? "linux:leader" : "linux:reused",
          processGroupId: pid,
        };
      },
      self: () => ({ status: "missing", pid: 1, platform: "linux" }),
    };
    const { groups, signalled } = spyGroupService(identity);
    const ac = new AbortController();
    for await (const ev of spawnProcess(process.execPath, ["-e", selfExitChild], {
      abortSignal: ac.signal,
      cancelKillDelayMs: 20,
      processGroups: groups,
      reap: async () => ({ state: "confirmed", pgids: [] }),
    })) {
      if (ev.type === "stdout" && ev.line === "ready") ac.abort();
    }
    // The capture at spawn succeeded, but neither the cooperative nudge nor the
    // delayed SIGKILL fallback signalled the (now-recycled) group.
    expect(signalled).toEqual([]);
    expect(reads).toBeGreaterThan(1); // proves the belt DID attempt (and was refused)
  });

  it("runCaptureRaw signals its group only through the identity-verified handle", async () => {
    // Round-4 #1 residue: capture children must never get a raw kill(-pid)
    // either. With a spy service the timeout SIGKILL must ride the handle;
    // with an unknown identity no group signal may be emitted at all.
    const identity: ProcessIdentityReader = {
      read: (pid): ProcessIdentity => ({
        status: "known",
        pid,
        platform: "linux",
        source: "procfs_stat",
        startToken: "linux:capture-leader",
        processGroupId: pid,
      }),
      self: () => ({ status: "missing", pid: 1, platform: "linux" }),
    };
    const { groups, signalled } = spyGroupService(identity);
    // The spy service records but does not really signal, so the child ends by
    // its own 800ms timer; the assertion is purely "which channel was used".
    const result = await runCaptureRaw(process.execPath, ["-e", "setTimeout(() => {}, 800)"], {
      timeoutMs: 50,
      processGroups: groups,
    });
    expect(result.code).toBe(0);
    expect(signalled.length).toBeGreaterThan(0);
    expect(signalled.every((s) => s.signal === "SIGKILL")).toBe(true);

    const unknownIdentity: ProcessIdentityReader = {
      read: (pid) => ({ status: "unknown", pid, platform: "linux", reason: "io_error" }),
      self: () => ({ status: "missing", pid: 1, platform: "linux" }),
    };
    const unknownSpy = spyGroupService(unknownIdentity);
    const second = await runCaptureRaw(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
      timeoutMs: 50,
      processGroups: unknownSpy.groups,
    });
    // No proven handle -> no group signal; the direct child.kill fallback (an
    // object-pinned signal that cannot hit a recycled PID) still ends the child.
    expect(second.signal).toBe("SIGKILL");
    expect(unknownSpy.signalled).toEqual([]);
  });
});

describe("labelStreams", () => {
  it("returns null when both streams are blank", () => {
    expect(labelStreams("", "  \n")).toBeNull();
  });

  it("labels which stream said what", () => {
    expect(labelStreams("boom", "")).toBe("stderr: boom");
    expect(labelStreams("", "hello")).toBe("stdout: hello");
    expect(labelStreams("boom", "hello")).toBe("stderr: boom | stdout: hello");
  });

  it("runs the transform (redactor) on the FULL stream BEFORE truncation", () => {
    // The secret sits beyond the truncation budget: redact-after-truncate
    // would slice the token into an unrecognizable, partially visible prefix.
    // (Assembled at runtime so the diff itself never carries a key-shaped literal.)
    const secret = ["sk", "live", "0123456789abcdef".repeat(2)].join("-");
    const noisy = "x".repeat(280) + " token=" + secret;
    const out = labelStreams(noisy, "", {
      maxLen: 100,
      transform: (s) => s.replaceAll(secret, "[redacted]"),
    });
    expect(out).not.toContain(["sk", "live"].join("-"));
    expect([...(out ?? "")].length).toBeLessThanOrEqual(100 + "stderr: ".length);
  });

  it("gives each present stream its own budget so one cannot evict the other", () => {
    const out = labelStreams("e".repeat(500), "o".repeat(500), { maxLen: 100 });
    expect(out).toContain("stderr: ");
    expect(out).toContain("| stdout: ");
    expect(out).toContain("ooo");
  });

  it("never splits a surrogate pair at the truncation boundary", () => {
    const out = labelStreams("🙂".repeat(400), "", { maxLen: 301 });
    expect(out).not.toMatch(/[\uD800-\uDBFF]$/);
  });
});

describe("armOrphanExit", () => {
  it("exits when the bridge reparents to pid 1 (dead host) and discloses once", async () => {
    const exits: number[] = [];
    let disclosed = 0;
    let ppid = 777;
    const watchdog = armOrphanExit({
      intervalMs: 5,
      getppid: () => ppid,
      exit: (code) => exits.push(code),
      onOrphaned: () => {
        disclosed += 1;
      },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(exits).toEqual([]); // live host: never exits
    ppid = 1;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(exits.length).toBeGreaterThan(0);
    expect(exits[0]).toBe(0);
    expect(disclosed).toBeGreaterThan(0);
    watchdog.stop();
  });

  it("stop() cancels the watchdog", async () => {
    const exits: number[] = [];
    const watchdog = armOrphanExit({
      intervalMs: 5,
      getppid: () => 1,
      exit: (code) => exits.push(code),
    });
    watchdog.stop();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(exits).toEqual([]);
  });
});

describe("windows kill fallback (wave FIX_FIRST: failed taskkill must not strand the capture)", () => {
  // Windows has no capturable POSIX group: suppress group capture so the
  // strategy branch is reached, exactly the win32 shape.
  const noGroupIdentity: ProcessIdentityReader = {
    read: (pid) => ({ status: "unknown", pid, platform: "linux", reason: "io_error" }),
    self: () => ({ status: "missing", pid: 1, platform: "linux" }),
  };
  const noGroupService = () =>
    new ProcessGroupService({
      platform: "linux",
      identity: noGroupIdentity,
      probeProcessGroup: () => {},
      signalProcessGroup: () => {},
    });

  it("falls through to the pinned child kill when the tree kill reports failure", async () => {
    const attempts: number[] = [];
    const result = await runCaptureRaw(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      timeoutMs: 80,
      processGroups: noGroupService(),
      killTreeStrategy: "windows_taskkill",
      windowsKillTree: (pid) => {
        attempts.push(pid);
        return { status: "failed", pid, detail: "injected taskkill failure" };
      },
    });
    // The injected failure was consulted, the fallback child.kill fired, and
    // the capture RESOLVED instead of awaiting close forever.
    expect(attempts.length).toBeGreaterThan(0);
    expect(result.signal).toBe("SIGKILL");
  });

  it("still skips the fallback when the tree kill succeeds", async () => {
    let calls = 0;
    const result = await runCaptureRaw(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
      timeoutMs: 60,
      processGroups: noGroupService(),
      killTreeStrategy: "windows_taskkill",
      windowsKillTree: (pid) => {
        calls += 1;
        // Simulate a successful taskkill by killing the real child ourselves.
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
        return { status: "killed", pid };
      },
    });
    expect(calls).toBeGreaterThan(0);
    expect(result.signal).toBe("SIGKILL");
  });
});

it("counts child launch preparation including leader capture, without counting an idle interval", async () => {
  const idle = new ModelPreparationTiming();
  expect(idle.finish().process.childLaunches).toBe(0);
  const timing = new ModelPreparationTiming();
  await timing.run(async () => {
    for await (const _event of spawnProcess(process.execPath, ["-e", "process.exit(0)"])) {
      /* drain owned child */
    }
  });
  const measured = timing.finish();
  expect(measured.process.childLaunches).toBe(1);
  expect(measured.process.childLaunchMs).toBeGreaterThan(0);
  expect(measured.process.childLaunchMs).toBeLessThanOrEqual(measured.totalMs);
});
