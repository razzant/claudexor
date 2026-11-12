import { mkdirSync, mkdtempSync, promises, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultHighWaterMark } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withPoolWriteSlot } from "./libuv-pool.js";
import { orderedAppender } from "./ordered-append.js";

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
  const global = globalThis as Record<symbol, unknown>;
  if (savedPool === undefined) delete global[APPLIED_POOL];
  else global[APPLIED_POOL] = savedPool;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "claudexor-ordered-append-"));
  roots.push(root);
  return root;
}

interface HeldWrite {
  path: string;
  data: string;
  release(): void;
  fail(error: unknown): void;
}

type HandleWrite = (
  buffer: Uint8Array,
  offset: number,
  length: number,
  position: number | null,
) => Promise<{ bytesWritten: number; buffer: Uint8Array }>;

/**
 * Spy `fs.promises.open`, the appender's first call of a batch write, and let
 * `patch` replace the write or close of each handle opened under this test's
 * folders.
 */
function patchHandles(
  patch: (
    path: string,
    write: HandleWrite,
    close: () => Promise<void>,
  ) => { write?: HandleWrite; close?: () => Promise<void> },
) {
  return vi.spyOn(promises, "open").mockImplementation((async (
    ...args: Parameters<typeof promises.open>
  ) => {
    const handle = await realOpen(...args);
    const path = String(args[0]);
    if (!roots.some((root) => path.startsWith(root))) return handle;
    const patched = patch(
      path,
      handle.write.bind(handle) as unknown as HandleWrite,
      handle.close.bind(handle),
    );
    if (patched.write) handle.write = patched.write as unknown as typeof handle.write;
    if (patched.close) handle.close = patched.close;
    return handle;
  }) as typeof promises.open);
}

/**
 * Run `body` with the first write of every batch held until the test releases
 * or fails it; a released write then lands for real. Afterwards every write
 * still held is released and its file drained (which consumes no held
 * failure), so no test leaves a pool slot occupied.
 */
async function holding(body: (calls: HeldWrite[]) => Promise<void>): Promise<void> {
  const calls: HeldWrite[] = [];
  const spy = patchHandles((path, write) => {
    let first = true;
    return {
      write: async (buffer, offset, length, position) => {
        if (!first) return write(buffer, offset, length, position);
        first = false;
        let release!: () => void;
        let fail!: (error: unknown) => void;
        const gate = new Promise<void>((resolve, reject) => {
          release = resolve;
          fail = reject;
        });
        const data = Buffer.from(buffer.subarray(offset, offset + length)).toString("utf8");
        calls.push({ path, data, release, fail });
        await gate;
        return write(buffer, offset, length, position);
      },
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
  return patchHandles((_path, write) => ({
    write: async (buffer, offset, length, position) => {
      if (budget <= 0) throw error;
      const take = Math.min(length, budget);
      budget -= take;
      return write(buffer, offset, take, position);
    },
  }));
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

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("ordered appender", () => {
  it("writes an idle file at once and carries the appends made meanwhile in one later write", async () => {
    const path = join(freshRoot(), "events.jsonl");
    const landed: string[] = [];
    await holding(async (calls) => {
      orderedAppender.append(path, "1\n", { landed: () => landed.push("1") });
      await until("the first write starts", () => calls.length === 1);
      expect(calls[0]!.data).toBe("1\n");
      orderedAppender.append(path, "2\n", { landed: () => landed.push("2") });
      orderedAppender.append(path, "3\n", { landed: () => landed.push("3") });
      await quiet();
      // At most one write per file is in flight.
      expect(calls).toHaveLength(1);
      expect(landed).toEqual([]);
      calls[0]!.release();
      await until("the second write starts", () => calls.length === 2);
      expect(landed).toEqual(["1"]);
      expect(calls[1]!.data).toBe("2\n3\n");
      calls[1]!.release();
      await orderedAppender.settled(path);
    });
    expect(landed).toEqual(["1", "2", "3"]);
    expect(readFileSync(path, "utf8")).toBe("1\n2\n3\n");
  });

  it("reports full past the runtime's high-water mark and drains when the queue empties", async () => {
    const path = join(freshRoot(), "events.jsonl");
    const mark = getDefaultHighWaterMark(false);
    await expect(orderedAppender.drained(path)).resolves.toBeUndefined();
    await holding(async (calls) => {
      expect(orderedAppender.append(path, "x".repeat(mark))).toBe(false);
      expect(orderedAppender.full(path)).toBe(false);
      expect(orderedAppender.append(path, "y")).toBe(true);
      expect(orderedAppender.full(path)).toBe(true);
      let drained = false;
      const draining = orderedAppender.drained(path).then(() => {
        drained = true;
      });
      await until("the write starts", () => calls.length === 1);
      await quiet();
      expect(drained).toBe(false);
      calls[0]!.release();
      await draining;
      expect(orderedAppender.full(path)).toBe(false);
    });
    expect(readFileSync(path, "utf8")).toHaveLength(mark + 1);
  });

  it("rejects the caller awaiting a failed landing alone, then appends again", async () => {
    const path = join(freshRoot(), "events.jsonl");
    const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    await holding(async (calls) => {
      const waiter = deferred();
      orderedAppender.append(path, "a\n", { waiter });
      await until("the write starts", () => calls.length === 1);
      calls[0]!.fail(failure);
      await expect(waiter.promise).rejects.toBe(failure);
    });
    // Nothing was held for the next append or barrier.
    expect(orderedAppender.append(path, "b\n")).toBe(false);
    await expect(orderedAppender.settled(path)).resolves.toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe("b\n");
    expect(unhandled).toEqual([]);
  });

  it("fails the appends queued behind a failed write, holds the failure once, and keeps appending", async () => {
    const path = join(freshRoot(), "events.jsonl");
    const failure = new Error("EIO");
    const lost: string[] = [];
    await holding(async (calls) => {
      orderedAppender.append(path, "a\n", { lost: () => lost.push("a") });
      await until("the write starts", () => calls.length === 1);
      orderedAppender.append(path, "b\n", { lost: () => lost.push("b") });
      calls[0]!.fail(failure);
      await orderedAppender.drained(path);
      expect(lost).toEqual(["a", "b"]);
      // `b` was not written after the failed write.
      expect(calls).toHaveLength(1);
    });
    expect(() => orderedAppender.append(path, "c\n")).toThrow(failure);
    expect(orderedAppender.append(path, "d\n")).toBe(false);
    await expect(orderedAppender.settled(path)).resolves.toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe("d\n");
    expect(unhandled).toEqual([]);
  });

  it("gives a failure to the barrier in flight, and a held one to the next barrier, once", async () => {
    const root = freshRoot();
    const inFlight = join(root, "in-flight.jsonl");
    const held = join(root, "held.jsonl");
    const failure = new Error("EIO");
    await holding(async (calls) => {
      orderedAppender.append(inFlight, "a\n");
      const barrier = orderedAppender.settled(inFlight);
      orderedAppender.append(held, "a\n");
      await until("both writes start", () => calls.length === 2);
      for (const call of calls) call.fail(failure);
      await expect(barrier).rejects.toBe(failure);
      await orderedAppender.drained(held);
    });
    // The barrier consumed the first; the second file held its own.
    await expect(orderedAppender.settled(inFlight)).resolves.toBeUndefined();
    await expect(orderedAppender.settled(held)).rejects.toBe(failure);
    await expect(orderedAppender.settled(held)).resolves.toBeUndefined();
    expect(unhandled).toEqual([]);
  });

  it("treats a throw from landed as that landing's failure and lands the rest of the batch", async () => {
    const path = join(freshRoot(), "events.jsonl");
    const refused = new Error("journal refused");
    const order: string[] = [];
    const waiter = deferred();
    await holding(async (calls) => {
      orderedAppender.append(path, "0\n");
      await until("the first write starts", () => calls.length === 1);
      orderedAppender.append(path, "a\n", {
        landed: () => {
          throw refused;
        },
        waiter,
      });
      orderedAppender.append(path, "b\n", {
        landed: () => {
          order.push("b");
          throw refused;
        },
      });
      orderedAppender.append(path, "c\n", { landed: () => order.push("c") });
      calls[0]!.release();
      await until("the batch write starts", () => calls.length === 2);
      calls[1]!.release();
      await expect(waiter.promise).rejects.toBe(refused);
      await orderedAppender.drained(path);
    });
    expect(order).toEqual(["b", "c"]);
    expect(readFileSync(path, "utf8")).toBe("0\na\nb\nc\n");
    // `b`'s failure had nobody waiting: the next barrier consumes it, once.
    await expect(orderedAppender.settled(path)).rejects.toBe(refused);
    await expect(orderedAppender.settled(path)).resolves.toBeUndefined();
    expect(unhandled).toEqual([]);
  });

  it("settles under a directory only the files below it", async () => {
    const root = freshRoot();
    const runDir = join(root, "run-a");
    const events = join(runDir, "events.jsonl");
    const journal = join(runDir, "attempts", "a1.jsonl");
    const sibling = join(root, "run-a-sibling", "events.jsonl");
    for (const path of [events, journal, sibling]) mkdirSync(join(path, ".."), { recursive: true });
    await holding(async (calls) => {
      for (const path of [events, journal, sibling]) orderedAppender.append(path, "x\n");
      await until("three writes start", () => calls.length === 3);
      const done = { run: false, sibling: false, all: false };
      void orderedAppender.settledUnder(runDir).then(() => (done.run = true));
      void orderedAppender
        .settledUnder(join(root, "run-a-sibling"))
        .then(() => (done.sibling = true));
      void orderedAppender.settledAll().then(() => (done.all = true));
      for (const call of calls) if (call.path !== sibling) call.release();
      await until("the run directory settles", () => done.run);
      await quiet();
      expect(done).toEqual({ run: true, sibling: false, all: false });
      calls.find((call) => call.path === sibling)!.release();
      await until("everything settles", () => done.sibling && done.all);
    });
    for (const path of [events, journal, sibling]) expect(readFileSync(path, "utf8")).toBe("x\n");
  });

  it("lands the appends a failing write put on disk whole, and fails the rest", async () => {
    const path = join(freshRoot(), "events.jsonl");
    const full = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    const landed: string[] = [];
    const lost: string[] = [];
    const whole = deferred();
    const cut = deferred();
    const spy = failAfter(Buffer.byteLength("a\n"), full);
    try {
      for (const [line, waiter] of [
        ["a", whole],
        ["b", cut],
        ["c", undefined],
      ] as const)
        orderedAppender.append(path, `${line}\n`, {
          landed: () => landed.push(line),
          lost: () => lost.push(line),
          ...(waiter ? { waiter } : {}),
        });
      await expect(whole.promise).resolves.toBeUndefined();
      await expect(cut.promise).rejects.toBe(full);
      await orderedAppender.drained(path);
    } finally {
      spy.mockRestore();
    }
    expect(landed).toEqual(["a"]);
    expect(lost).toEqual(["b", "c"]);
    expect(readFileSync(path, "utf8")).toBe("a\n");
    // `c` had nobody waiting: the next append hears the failure, once.
    expect(() => orderedAppender.append(path, "d\n")).toThrow(full);
    orderedAppender.append(path, "e\n");
    await orderedAppender.settled(path);
    expect(readFileSync(path, "utf8")).toBe("a\ne\n");
    expect(unhandled).toEqual([]);
  });

  it("fails an append a failing write tore, as one it never began", async () => {
    const path = join(freshRoot(), "events.jsonl");
    const full = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    const landed: string[] = [];
    const torn = deferred();
    const spy = failAfter(1, full);
    try {
      orderedAppender.append(path, "a\n", { landed: () => landed.push("a"), waiter: torn });
      await expect(torn.promise).rejects.toBe(full);
      await orderedAppender.drained(path);
    } finally {
      spy.mockRestore();
    }
    expect(landed).toEqual([]);
    // The torn start stays in the file; the next append follows it.
    expect(readFileSync(path, "utf8")).toBe("a");
    orderedAppender.append(path, "b\n");
    await orderedAppender.settled(path);
    expect(readFileSync(path, "utf8")).toBe("ab\n");
    expect(unhandled).toEqual([]);
  });

  it("lands every append when only the close fails, and holds that failure once", async () => {
    const path = join(freshRoot(), "events.jsonl");
    const closing = new Error("close failed");
    const landed: string[] = [];
    const waiter = deferred();
    const spy = patchHandles((_path, _write, close) => ({
      close: async () => {
        await close();
        throw closing;
      },
    }));
    try {
      orderedAppender.append(path, "a\n", { landed: () => landed.push("a"), waiter });
      orderedAppender.append(path, "b\n", { landed: () => landed.push("b") });
      await expect(waiter.promise).resolves.toBeUndefined();
      await orderedAppender.drained(path);
    } finally {
      spy.mockRestore();
    }
    expect(landed).toEqual(["a", "b"]);
    expect(readFileSync(path, "utf8")).toBe("a\nb\n");
    await expect(orderedAppender.settled(path)).rejects.toBe(closing);
    await expect(orderedAppender.settled(path)).resolves.toBeUndefined();
    expect(unhandled).toEqual([]);
  });

  it("holds a pool slot only around a batch's own file calls, so slots never nest", async () => {
    const global = globalThis as Record<symbol, unknown>;
    global[APPLIED_POOL] = 3; // one write slot
    const path = join(freshRoot(), "missing", "deeper", "events.jsonl");
    // The parent is missing: the open fails, the directory is made and the batch
    // written again, each under its own slot. Nested slots would deadlock the only one.
    orderedAppender.append(path, "a\n");
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      orderedAppender.settled(path),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("an append nested its pool slots")), 2_000);
      }),
    ]).finally(() => clearTimeout(timer));
    expect(readFileSync(path, "utf8")).toBe("a\n");
    await holding(async (calls) => {
      orderedAppender.append(path, "b\n");
      await until("the write starts", () => calls.length === 1);
      let entered = false;
      const other = withPoolWriteSlot(undefined, async () => {
        entered = true;
      });
      await quiet();
      // The held write has the only slot; an upload write waits for it.
      expect(entered).toBe(false);
      calls[0]!.release();
      await other;
      expect(entered).toBe(true);
      await orderedAppender.settled(path);
    });
    expect(readFileSync(path, "utf8")).toBe("a\nb\n");
  });
});
