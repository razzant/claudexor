import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  promises,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "@claudexor/schema";
import { orderedAppender } from "@claudexor/util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EventLog,
  appendRunEvent,
  appendRunEventLanded,
  lastRunEventSeq,
  liveRunEventSeq,
  readRunEvents,
} from "./index.js";

const APPLIED_POOL = Symbol.for("claudexor.libuvPoolSize");
const realOpen = promises.open;
const roots: string[] = [];
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
let savedPool: unknown;

beforeEach(() => {
  const global = globalThis as Record<symbol, unknown>;
  savedPool = global[APPLIED_POOL];
  // A pool of 8 gives six write slots: every held write in these tests has one.
  global[APPLIED_POOL] = 8;
  process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  unhandled.length = 0;
  const global = globalThis as Record<symbol, unknown>;
  if (savedPool === undefined) delete global[APPLIED_POOL];
  else global[APPLIED_POOL] = savedPool;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

/** A run directory with its events.jsonl path. */
function runDir(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "claudexor-queued-log-"));
  roots.push(dir);
  return { dir, path: join(dir, "events.jsonl") };
}

function queuedLog(
  path: string,
  hooks: {
    onPersist?: (event: RunEvent) => void;
    onPublish?: (event: RunEvent) => void;
  } = {},
): EventLog {
  return new EventLog(path, "run-1", "task-1", hooks.onPersist, undefined, hooks.onPublish, {
    queued: true,
  });
}

/** The landed file's events, as `[seq, type]`. */
function onDisk(path: string): Array<[number | undefined, string]> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as RunEvent)
    .map((event) => [event.seq, event.type]);
}

function seqTypes(read: { events: RunEvent[] }): Array<[number | undefined, string]> {
  return read.events.map((event) => [event.seq, event.type]);
}

interface HeldWrite {
  path: string;
  release(): void;
  fail(error: unknown): void;
}

type HandleWrite = (
  buffer: Uint8Array,
  offset: number,
  length: number,
  position: number | null,
) => Promise<{ bytesWritten: number; buffer: Uint8Array }>;

/** Spy `fs.promises.open`, the appender's first call of a batch write, and let
 * `write` replace the write of each handle opened under this test's folders. */
function patchWrites(write: (path: string, original: HandleWrite) => HandleWrite) {
  return vi.spyOn(promises, "open").mockImplementation((async (
    ...args: Parameters<typeof promises.open>
  ) => {
    const handle = await realOpen(...args);
    const path = String(args[0]);
    if (!roots.some((root) => path.startsWith(root))) return handle;
    const patched = write(path, handle.write.bind(handle) as unknown as HandleWrite);
    handle.write = patched as unknown as typeof handle.write;
    return handle;
  }) as typeof promises.open);
}

/**
 * Run `body` with the first write of every batch held until the test releases
 * or fails it. "before": nothing reaches the file until release. "after": the
 * bytes reach the file, but the write reports nothing until release. "torn":
 * the first half of the bytes reaches the file; at release that write reports
 * half, and the appender writes the rest. Afterwards every held write is
 * released and its file drained.
 */
async function holding(
  mode: "before" | "after" | "torn",
  body: (calls: HeldWrite[]) => Promise<void>,
): Promise<void> {
  const calls: HeldWrite[] = [];
  const spy = patchWrites((path, write) => {
    let first = true;
    return async (buffer, offset, length, position) => {
      if (!first) return write(buffer, offset, length, position);
      first = false;
      let release!: () => void;
      let fail!: (error: unknown) => void;
      const gate = new Promise<void>((resolve, reject) => {
        release = resolve;
        fail = reject;
      });
      let done: Awaited<ReturnType<HandleWrite>> | undefined;
      if (mode === "after") done = await write(buffer, offset, length, position);
      if (mode === "torn") done = await write(buffer, offset, Math.floor(length / 2), position);
      calls.push({ path, release, fail });
      await gate;
      return done ?? write(buffer, offset, length, position);
    };
  });
  try {
    await body(calls);
  } finally {
    spy.mockRestore();
    for (const call of calls) call.release();
    await Promise.all(calls.map((call) => orderedAppender.drained(call.path)));
  }
}

/** Writes under this test's folders stop after `limit` bytes: the write that
 * reaches the limit is cut short there, and the next one fails. */
function failAfter(limit: number, error: Error) {
  let budget = limit;
  return patchWrites((_path, write) => async (buffer, offset, length, position) => {
    if (budget <= 0) throw error;
    const take = Math.min(length, budget);
    budget -= take;
    return write(buffer, offset, take, position);
  });
}

async function until(label: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Let every queued callback run, to observe that something did not happen. */
async function quiet(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe("a queued EventLog", () => {
  it("returns from emit and lets the event loop turn while its write is held", async () => {
    const { dir, path } = runDir();
    const log = queuedLog(path);
    await holding("before", async (calls) => {
      expect(log.emit("run.created", {}).seq).toBe(1);
      let turned = false;
      await new Promise<void>((resolve) =>
        setImmediate(() => {
          turned = true;
          resolve();
        }),
      );
      expect(turned).toBe(true);
      await until("the write starts", () => calls.length === 1);
      expect(onDisk(path)).toEqual([]);
      calls[0]!.release();
      await orderedAppender.settled(path);
    });
    expect(onDisk(path)).toEqual([[1, "run.created"]]);
    // An inline log has written its line before emit returns.
    const inlinePath = join(dir, "inline.jsonl");
    new EventLog(inlinePath, "run-1", "task-1").emit("run.created", {});
    expect(onDisk(inlinePath)).toEqual([[1, "run.created"]]);
  });

  it("keeps order, and its seq cursors and onPublish follow landing", async () => {
    const { path } = runDir();
    const published: Array<number | undefined> = [];
    const log = queuedLog(path, { onPublish: (event) => published.push(event.seq) });
    await holding("before", async (calls) => {
      log.emit("run.created", {});
      await until("the first write starts", () => calls.length === 1);
      log.emit("harness.event", { text: "a" });
      log.emit("harness.event", { text: "b" }, false);
      log.emit("harness.event", { text: "c" });
      expect([log.lastSeq(), liveRunEventSeq(path), lastRunEventSeq(path)]).toEqual([0, 0, 0]);
      expect(published).toEqual([]);
      calls[0]!.release();
      await until("the first line lands", () => published.length === 1);
      expect([log.lastSeq(), liveRunEventSeq(path), lastRunEventSeq(path)]).toEqual([1, 1, 1]);
      await until("the second write starts", () => calls.length === 2);
      calls[1]!.release();
      await orderedAppender.settled(path);
    });
    expect(published).toEqual([1, 2, 4]);
    expect([log.lastSeq(), liveRunEventSeq(path), lastRunEventSeq(path)]).toEqual([4, 4, 4]);
    expect(onDisk(path).map(([seq]) => seq)).toEqual([1, 2, 3, 4]);
  });

  it("runs onPersist when the event's line is in the file", async () => {
    const { path } = runDir();
    const seen: boolean[] = [];
    const log = queuedLog(path, {
      onPersist: (event) => seen.push(readFileSync(path, "utf8").includes(`"seq":${event.seq},`)),
    });
    log.emit("run.created", {});
    log.emit("interaction.requested", { interaction_id: "q-1" });
    expect(seen).toEqual([]);
    await orderedAppender.settled(path);
    expect(seen).toEqual([true, true]);
  });

  it("commits the terminal only after every append under the run directory lands", async () => {
    const { dir, path } = runDir();
    const journal = join(dir, "attempts", "a1.jsonl");
    mkdirSync(join(dir, "attempts"));
    const log = queuedLog(path);
    log.emit("run.created", {});
    await orderedAppender.settled(path);
    await holding("before", async (calls) => {
      orderedAppender.append(journal, "{}\n");
      log.emit("harness.event", { text: "last" });
      await until("both writes start", () => calls.length === 2);
      const committing = log.emitTerminal("run.completed", {});
      await quiet();
      expect(log.terminalCommitted()).toBe(false);
      calls.find((call) => call.path === path)!.release();
      await quiet();
      // The attempt journal under the run directory is still in flight.
      expect(log.terminalCommitted()).toBe(false);
      calls.find((call) => call.path === journal)!.release();
      await expect(committing).resolves.toMatchObject({ seq: 3, type: "run.completed" });
    });
    expect(onDisk(path)).toEqual([
      [1, "run.created"],
      [2, "harness.event"],
      [3, "run.completed"],
    ]);
  });

  it("rolls a throwing beforeTerminal back to the drained file exactly", async () => {
    const { path } = runDir();
    const log = queuedLog(path);
    const read: Array<Array<number | undefined>> = [];
    log.setBeforeTerminal(() => {
      // The preparation reads a complete file: every line emitted before it.
      read.push(onDisk(path).map(([seq]) => seq));
      if (read.length > 1) return;
      appendFileSync(path, '{"seq":3,"partial');
      throw new Error("contradictory receipt");
    });
    await holding("before", async (calls) => {
      log.emit("run.created", {});
      log.emit("harness.event", { text: "a" });
      await until("the write starts", () => calls.length === 1);
      const first = log.emitTerminal("run.completed", {});
      await quiet();
      expect(read).toEqual([]);
      // The rollback boundary is frozen after the drain: the landed lines stay.
      calls[0]!.release();
      await expect(first).rejects.toThrow(/contradictory receipt/);
    });
    expect(read).toEqual([[1, 2]]);
    const drained = readFileSync(path, "utf8");
    expect(drained.endsWith("}\n")).toBe(true);
    expect(onDisk(path)).toEqual([
      [1, "run.created"],
      [2, "harness.event"],
    ]);
    await expect(log.emitTerminal("run.failed", {})).resolves.toMatchObject({ seq: 3 });
    expect(readFileSync(path, "utf8").startsWith(drained)).toBe(true);
  });

  it("holds the failure net's terminal again after a failed commit, then commits it once", async () => {
    const { path } = runDir();
    const log = queuedLog(path);
    let refusals = 1;
    log.setTerminalPersistence((event) => {
      if (refusals-- > 0) throw new Error("terminal store unavailable");
      appendFileSync(path, `${JSON.stringify(event)}\n`);
      return { state: "materialized" };
    });
    log.emit("run.created", {});
    log.deferTerminal();
    log.emit("run.completed", { lifecycle: "succeeded" });
    await expect(log.commitDeferredTerminal()).rejects.toThrow(/terminal store unavailable/);
    expect(log.terminalCommitted()).toBe(false);
    await holding("before", async (calls) => {
      // The failure net: its output, then a synchronous terminal while that
      // output is still in flight.
      log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
      log.emit("run.failed", { lifecycle: "failed" });
      expect(log.deferredTerminalPending()?.type).toBe("run.failed");
      expect(log.terminalCommitted()).toBe(false);
      const committing = log.commitDeferredTerminal();
      await until("the output write starts", () => calls.length === 1);
      calls[0]!.release();
      await expect(committing).resolves.toMatchObject({ seq: 3, type: "run.failed" });
    });
    expect(onDisk(path)).toEqual([
      [1, "run.created"],
      [2, "output.ready"],
      [3, "run.failed"],
    ]);
  });

  it("commits through emitTerminal while terminals are held, inline and queued", async () => {
    for (const queued of [false, true]) {
      const { path } = runDir();
      const log = queued ? queuedLog(path) : new EventLog(path, "run-1", "task-1");
      log.emit("run.created", {});
      log.deferTerminal();
      await expect(log.emitTerminal("run.failed", {})).resolves.toMatchObject({ seq: 2 });
      expect(log.terminalCommitted()).toBe(true);
      expect(log.deferredTerminalPending()).toBeNull();
      expect(onDisk(path).at(-1)).toEqual([2, "run.failed"]);
    }
  });

  it("drains before a terminal without a staging hook, which an inline log commits at once", async () => {
    const { dir, path } = runDir();
    const log = queuedLog(path);
    await holding("before", async (calls) => {
      log.emit("run.created", {});
      await until("the write starts", () => calls.length === 1);
      const committing = log.emitTerminal("run.completed", {});
      await quiet();
      expect(log.terminalCommitted()).toBe(false);
      calls[0]!.release();
      await expect(committing).resolves.toMatchObject({ seq: 2 });
    });
    expect(onDisk(path)).toEqual([
      [1, "run.created"],
      [2, "run.completed"],
    ]);
    const inline = new EventLog(join(dir, "inline.jsonl"), "run-1", "task-1");
    inline.emit("run.created", {});
    const committing = inline.emitTerminal("run.completed", {});
    expect(inline.terminalCommitted()).toBe(true);
    await committing;
  });

  it("refuses a synchronous terminal while a line is in flight, and commits one without", async () => {
    const { path } = runDir();
    const log = queuedLog(path);
    await holding("before", async (calls) => {
      log.emit("run.created", {});
      let refused: unknown;
      try {
        log.emit("run.completed", {});
      } catch (error) {
        refused = error;
      }
      expect(refused).toMatchObject({ code: "terminal_writes_in_flight" });
      expect(log.terminalCommitted()).toBe(false);
      await until("the write starts", () => calls.length === 1);
      calls[0]!.release();
      await orderedAppender.settled(path);
    });
    expect(log.emit("run.completed", {}).seq).toBe(2);
    expect(log.terminalCommitted()).toBe(true);
  });

  it("lets a synchronous reader see every stamped line once, landed or not", async () => {
    const { dir, path } = runDir();
    const log = queuedLog(path);
    log.emit("run.created", {});
    await orderedAppender.settled(path);
    await holding("torn", async (calls) => {
      log.emit("harness.event", { text: "torn" });
      await until("half the line is on disk", () => calls.length === 1);
      expect(readFileSync(path, "utf8").endsWith("\n")).toBe(false);
      log.emit("harness.event", { text: "queued" });
      for (const read of [readRunEvents(path), log.readAll()]) {
        expect(seqTypes(read)).toEqual([
          [1, "run.created"],
          [2, "harness.event"],
          [3, "harness.event"],
        ]);
        expect(read.malformed).toBe(0);
      }
    });
    await holding("after", async (calls) => {
      log.emit("harness.event", { text: "written, not reported" });
      await until("the line is on disk", () => calls.length === 1);
      expect(onDisk(path).at(-1)).toEqual([4, "harness.event"]);
      expect(seqTypes(readRunEvents(path)).map(([seq]) => seq)).toEqual([1, 2, 3, 4]);
    });
    expect(seqTypes(readRunEvents(path)).map(([seq]) => seq)).toEqual([1, 2, 3, 4]);
    // A path without a live writer is read raw: a torn tail is malformed there.
    const raw = join(dir, "raw.jsonl");
    appendFileSync(raw, `${readFileSync(path, "utf8")}{"seq":5,"ty`);
    expect(readRunEvents(raw).events).toHaveLength(4);
    expect(readRunEvents(raw).malformed).toBe(1);
  });

  it("rejects an awaited landing's onPersist failure alone and still commits a terminal", async () => {
    const { path } = runDir();
    const refused = new Error("journal refused");
    const log = queuedLog(path, {
      onPersist: (event) => {
        if (event.type === "interaction.requested" || event.type === "message.accepted")
          throw refused;
      },
    });
    log.emit("run.created", {});
    await expect(log.emitLanded("interaction.requested", { interaction_id: "q-1" })).rejects.toBe(
      refused,
    );
    await expect(
      appendRunEventLanded(path, "run-1", "task-1", "message.accepted", { message_id: "m-1" }),
    ).rejects.toBe(refused);
    // Nothing was held for the next emit: the refused lines kept their seqs,
    // as an inline onPersist refusal does.
    expect(log.emit("harness.event", { text: "after" }).seq).toBe(4);
    await expect(
      appendRunEventLanded(path, "run-1", "task-1", "message.delivered", { message_id: "m-1" }),
    ).resolves.toMatchObject({ seq: 5 });
    await expect(log.emitTerminal("run.failed", {})).resolves.toMatchObject({ seq: 6 });
    expect(unhandled).toEqual([]);
  });

  it("reports an unawaited landing failure once, to the next emit or barrier", async () => {
    const { path } = runDir();
    const refused = new Error("journal refused");
    const log = queuedLog(path, {
      onPersist: (event) => {
        if (event.type === "output.ready") throw refused;
      },
    });
    log.emit("run.created", {});
    log.emit("output.ready", { kind: "summary" });
    await orderedAppender.drained(path);
    expect(() => log.emit("harness.event", { text: "next" })).toThrow(refused);
    expect(log.emit("harness.event", { text: "again" }).seq).toBe(3);
    log.emit("output.ready", { kind: "summary" });
    await orderedAppender.drained(path);
    // The terminal's barrier consumes the second; the next terminal commits.
    await expect(log.emitTerminal("run.completed", {})).rejects.toBe(refused);
    expect(log.terminalCommitted()).toBe(false);
    await expect(log.emitTerminal("run.failed", {})).resolves.toMatchObject({ seq: 5 });
    expect(unhandled).toEqual([]);
  });

  it("awaits a line a landing emits while the terminal settles, so the terminal lands last", async () => {
    // A landing callback emits N microtask turns after a line lands: inside the
    // terminal's last barrier, at its end, or once the terminal committed.
    for (const staged of [true, false])
      for (let turns = 0; turns <= 14; turns += 1) {
        const { path } = runDir();
        let log!: EventLog;
        const late: string[] = [];
        const onPublish = (event: RunEvent): void => {
          if (event.type !== "message.accepted") return;
          let chain = Promise.resolve();
          for (let turn = 0; turn < turns; turn += 1) chain = chain.then(() => undefined);
          void chain.then(() => {
            try {
              late.push(`landed ${log.emit("message.delivered", {}).seq}`);
            } catch (error) {
              late.push((error as Error).message);
            }
          });
        };
        log = queuedLog(path, { onPublish });
        log.deferTerminal();
        if (staged) log.setTerminalStaging(async () => void log.emit("message.accepted", {}));
        log.emit("run.created", {});
        if (!staged) log.emit("message.accepted", {});
        log.emit("run.failed", { lifecycle: "failed" });
        await log.commitDeferredTerminal();
        await quiet();
        await orderedAppender.settled(path);
        const lines = onDisk(path);
        const label = `staged=${staged} turns=${turns}: ${JSON.stringify(lines)} ${late}`;
        // Direction 1: the terminal is the last line and the seqs on disk ascend.
        expect(lines.at(-1)?.[1], label).toBe("run.failed");
        const seqs = lines.map(([seq]) => seq ?? 0);
        expect(seqs, label).toEqual([...seqs].sort((a, b) => a - b));
        expect(new Set(seqs).size, label).toBe(seqs.length);
        // Direction 2: the late line landed before the terminal, or was refused
        // because the terminal had committed; it was never lost silently.
        expect(late, label).toHaveLength(1);
        if (late[0]!.startsWith("landed"))
          expect(
            lines.map(([, type]) => type),
            label,
          ).toContain("message.delivered");
        else expect(late[0], label).toBe("run terminal event is already committed");
        // A later out-of-band append continues after the terminal's seq.
        const audit = appendRunEvent(path, "run-1", "task-1", "control.applied", {});
        expect(audit.seq, label).toBe(Math.max(...seqs) + 1);
      }
  });

  it("lets an out-of-band append neither take the run's held failure nor leave its own for the run", async () => {
    const { path } = runDir();
    const lost = new Error("journal refused the run's line");
    const auditRefused = new Error("journal refused the audit");
    const log = queuedLog(path, {
      onPersist: (event) => {
        if (event.type === "harness.event" && event.payload["text"] === "lost") throw lost;
        if (event.type === "control.applied") throw auditRefused;
      },
    });
    log.emit("run.created", {});
    // An audit's own landing failure is dropped, as its catch-all drops a
    // thrown one: it is never held for the run's next emit.
    expect(appendRunEvent(path, "run-1", "task-1", "control.applied", {}).seq).toBe(2);
    await orderedAppender.drained(path);
    expect(log.emit("harness.event", { text: "after the audit" }).seq).toBe(3);
    log.emit("harness.event", { text: "lost" });
    await orderedAppender.drained(path);
    // Direction 1: a live message and an audit are not refused for the run's
    // failure, and leave it held.
    await expect(
      appendRunEventLanded(path, "run-1", "task-1", "message.accepted", {}),
    ).resolves.toMatchObject({ type: "message.accepted" });
    expect(appendRunEvent(path, "run-1", "task-1", "control.requested", {}).seq).toBe(6);
    await orderedAppender.drained(path);
    // Direction 2: the run's own producers still hear it, once.
    await expect(log.emitLanded("interaction.requested", {})).rejects.toBe(lost);
    expect(log.emit("harness.event", { text: "next" }).seq).toBe(7);
    await expect(orderedAppender.settled(path)).resolves.toBeUndefined();
    await expect(log.emitTerminal("run.completed", {})).resolves.toMatchObject({ seq: 8 });
    expect(unhandled).toEqual([]);
  });

  it("consumes no seq for a failed write, failing the lines queued behind it", async () => {
    const { path } = runDir();
    const log = queuedLog(path);
    log.emit("run.created", {});
    await orderedAppender.settled(path);
    const full = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    await holding("before", async (calls) => {
      log.emit("harness.event", { text: "a" });
      await until("the write starts", () => calls.length === 1);
      log.emit("harness.event", { text: "b" });
      calls[0]!.fail(full);
      await orderedAppender.drained(path);
      expect(calls).toHaveLength(1);
    });
    expect(log.lastSeq()).toBe(1);
    expect(() => log.emit("harness.event", { text: "c" })).toThrow(full);
    expect(log.emit("harness.event", { text: "d" }).seq).toBe(2);
    await orderedAppender.settled(path);
    expect(onDisk(path)).toEqual([
      [1, "run.created"],
      [2, "harness.event"],
    ]);
    expect(readRunEvents(path).events.at(-1)?.payload["text"]).toBe("d");
    expect(unhandled).toEqual([]);
  });

  it("keeps a line a failing write put on disk whole, and continues the seq after it", async () => {
    const { path } = runDir();
    const persisted: Array<number | undefined> = [];
    const log = queuedLog(path, { onPersist: (event) => persisted.push(event.seq) });
    log.emit("run.created", {});
    await orderedAppender.settled(path);
    const full = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    const whole = log.emit("harness.event", { text: "whole" });
    log.emit("harness.event", { text: "cut" });
    const spy = failAfter(Buffer.byteLength(`${JSON.stringify(whole)}\n`), full);
    try {
      await orderedAppender.drained(path);
    } finally {
      spy.mockRestore();
    }
    // The line on disk landed: onPersist saw it, and its seq is spent.
    expect(persisted).toEqual([1, 2]);
    expect(log.lastSeq()).toBe(2);
    expect(() => log.emit("harness.event", { text: "next" })).toThrow(full);
    expect(log.emit("harness.event", { text: "after" }).seq).toBe(3);
    await orderedAppender.settled(path);
    expect(onDisk(path)).toEqual([
      [1, "run.created"],
      [2, "harness.event"],
      [3, "harness.event"],
    ]);
    expect(unhandled).toEqual([]);
  });

  it("consumes no seq for a line a failing write tore", async () => {
    const { path } = runDir();
    const persisted: Array<number | undefined> = [];
    const log = queuedLog(path, { onPersist: (event) => persisted.push(event.seq) });
    log.emit("run.created", {});
    await orderedAppender.settled(path);
    const full = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    log.emit("harness.event", { text: "torn" });
    const spy = failAfter(5, full);
    try {
      await orderedAppender.drained(path);
    } finally {
      spy.mockRestore();
    }
    expect(persisted).toEqual([1]);
    expect(log.lastSeq()).toBe(1);
    expect(() => log.emit("harness.event", { text: "next" })).toThrow(full);
    expect(log.emit("harness.event", { text: "after" }).seq).toBe(2);
    await orderedAppender.settled(path);
    // The torn start stays a malformed line, which the next line joins, as
    // after a torn inline append.
    const read = readRunEvents(path);
    expect(read.events.map((event) => event.seq)).toEqual([1]);
    expect(read.malformed).toBe(1);
    expect(unhandled).toEqual([]);
  });

  it("stays the live writer after dispose until its queue is empty", async () => {
    const { path } = runDir();
    const log = queuedLog(path);
    await holding("before", async (calls) => {
      log.emit("run.created", {});
      log.dispose();
      expect(liveRunEventSeq(path)).toBe(0);
      // An out-of-band audit still takes the live counter, not the short file's tail.
      expect(appendRunEvent(path, "run-1", "task-1", "control.requested", {}).seq).toBe(2);
      await until("the write starts", () => calls.length === 1);
      calls[0]!.release();
      await until("the writer unregisters", () => liveRunEventSeq(path) === null);
    });
    expect(appendRunEvent(path, "run-1", "task-1", "control.applied", {}).seq).toBe(3);
    expect(onDisk(path).map(([seq]) => seq)).toEqual([1, 2, 3]);
  });
});
