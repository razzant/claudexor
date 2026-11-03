import { EventEmitter } from "node:events";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readEventReplayBatch } from "./event-replay-batch.js";
import { streamRunEvents, type StreamEventsCtx } from "./run-events-stream.js";

const dirs: string[] = [];
const streams: EventEmitter[] = [];
afterEach(() => {
  for (const stream of streams.splice(0)) stream.emit("close");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

class Response extends EventEmitter {
  body = "";
  headersSent = false;
  ended = false;
  writableEnded = false;
  accept = (_chunk: string) => true;
  writeHead() {
    this.headersSent = true;
  }
  write(chunk: string) {
    this.body += chunk;
    return this.accept(chunk);
  }
  end() {
    this.ended = true;
    this.writableEnded = true;
    this.emit("close");
  }
}
function fixture(text: string) {
  const runDir = mkdtempSync(join(tmpdir(), "claudexor-sse-bulk-"));
  dirs.push(runDir);
  const path = join(runDir, "events.jsonl");
  writeFileSync(path, text);
  const res = new Response();
  streams.push(res);
  const req = new EventEmitter();
  const record = { id: "run-x", runId: "run-x", runDir, state: "running" };
  const listeners = new Set<(event: { run_id?: string }) => void>();
  const wake = () => {
    for (const listener of listeners) listener({ run_id: "run-x" });
  };
  const ctx: StreamEventsCtx = {
    findRun: async () => record,
    json() {},
    readBatch: async (input) => readEventReplayBatch(input),
    opts: {
      daemon: { status: async () => record },
      bus: {
        subscribe(fn) {
          listeners.add(fn);
          return () => {
            listeners.delete(fn);
          };
        },
      },
      pollMs: 100_000,
      heartbeatMs: 100_000,
    },
    sseClients: new Set(),
  };
  return { path, req, res, ctx, wake, record };
}

describe("event stream finite bulk handoff", () => {
  it("latches an append and terminal while a finite worker result is in flight", async () => {
    const f = fixture('{"type":"run.started","seq":1}\n');
    let reads = 0;
    f.ctx.readBatch = async (input) => {
      const result = readEventReplayBatch(input);
      if (++reads === 2) {
        appendFileSync(f.path, '{"type":"run.completed","seq":2}\n');
        f.wake(); // The result describes earlier bytes; the bus must not be lost.
        await Promise.resolve();
      }
      return result;
    };
    await streamRunEvents(f.ctx, "run-x", 0, f.req as any, f.res as any);
    expect([...f.res.body.matchAll(/id: (\d+)/g)].map((match) => Number(match[1]))).toEqual([1, 2]);
    expect(f.res.ended).toBe(true);
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  it("does not read another batch or interleave frames while socket backpressure holds", async () => {
    const f = fixture('{"type":"run.started","seq":1}\n{"type":"run.completed","seq":2}\n');
    let reads = 0;
    f.ctx.readBatch = async (input) => {
      reads += 1;
      return readEventReplayBatch(input);
    };
    let signalFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      signalFirst = resolve;
    });
    f.res.accept = (chunk) => {
      if (chunk.startsWith("id: 1\n")) {
        signalFirst();
        return false;
      }
      return true;
    };
    const running = streamRunEvents(f.ctx, "run-x", 0, f.req as any, f.res as any);
    await firstWrite;
    f.wake();
    f.wake();
    expect(reads).toBe(1);
    expect(f.res.body).not.toContain("id: 2\n");
    f.res.emit("drain");
    await running;
    expect(f.res.body.match(/id: 1\n/g)).toHaveLength(1);
    expect(f.res.body.match(/id: 2\n/g)).toHaveLength(1);
    expect(f.res.ended).toBe(true);
  });

  it("honors a replayed terminal even when the client's cursor already acknowledges it", async () => {
    const f = fixture('{"type":"run.started","seq":1}\n{"type":"run.completed","seq":2}\n');
    await streamRunEvents(f.ctx, "run-x", 2, f.req as any, f.res as any);
    expect(f.res.body).not.toContain("id:");
    expect(f.res.body).toContain("event: end\n");
    expect(f.res.ended).toBe(true);
  });

  it("keeps the terminal collection obligation until publication clears it", async () => {
    const f = fixture('{"type":"run.started","seq":1}\n{"type":"run.completed","seq":2}\n');
    let pending = true;
    f.ctx.opts.terminalFilesPending = () => pending;
    await streamRunEvents(f.ctx, "run-x", 0, f.req as any, f.res as any);
    expect(f.res.body).toContain("event: run.completed\n");
    expect(f.res.ended).toBe(false);
    const ended = new Promise<void>((resolve) => f.res.once("close", resolve));
    pending = false;
    f.wake();
    await ended;
    expect(f.res.ended).toBe(true);
    expect(f.res.body.match(/event: run.completed/g)).toHaveLength(1);
  });

  it("propagates the first worker failure before sending successful HTTP headers", async () => {
    const f = fixture('{"type":"run.started","seq":1}\n');
    const failure = Object.assign(new Error("bulk unavailable"), {
      code: "bulk_executor_failed",
      status: 503,
    });
    f.ctx.readBatch = async () => {
      throw failure;
    };
    await expect(streamRunEvents(f.ctx, "run-x", 0, f.req as any, f.res as any)).rejects.toBe(
      failure,
    );
    expect(f.res.headersSent).toBe(false);
  });

  it("reports a later worker failure as a typed SSE error and closes without a false end", async () => {
    const f = fixture('{"type":"run.started","seq":1}\n');
    let reads = 0;
    f.ctx.readBatch = async (input) => {
      if (++reads > 1)
        throw Object.assign(new Error("worker gone"), { code: "bulk_executor_failed" });
      return readEventReplayBatch(input);
    };
    await streamRunEvents(f.ctx, "run-x", 0, f.req as any, f.res as any);
    expect(f.res.body).toContain("event: error\n");
    expect(f.res.body).toContain('"code":"bulk_executor_failed"');
    expect(f.res.body).not.toContain("event: end\n");
    expect(f.res.ended).toBe(true);
  });

  it("aborts the outstanding worker request when the client closes", async () => {
    const f = fixture('{"type":"run.started","seq":1}\n');
    let entered!: () => void;
    const queued = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let aborted = false;
    f.ctx.readBatch = async (_input, signal) => {
      entered();
      return new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        ),
      );
    };
    const running = streamRunEvents(f.ctx, "run-x", 0, f.req as any, f.res as any);
    await queued;
    f.res.emit("close");
    await expect(running).rejects.toThrow("aborted");
    expect(aborted).toBe(true);
    expect(f.res.headersSent).toBe(false);
  });

  it("keeps queued replay alive when only the completed request body closes", async () => {
    const f = fixture('{"type":"run.completed","seq":1}\n');
    Object.assign(f.req, { complete: true, destroyed: true, socket: { destroyed: false } });
    let entered!: () => void;
    const queued = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signal: AbortSignal | undefined;
    f.ctx.readBatch = async (input, receivedSignal) => {
      signal = receivedSignal;
      entered();
      await barrier;
      return readEventReplayBatch(input);
    };
    const running = streamRunEvents(f.ctx, "run-x", 0, f.req as any, f.res as any);
    await queued;
    f.req.emit("close");
    expect(signal?.aborted).toBe(false);
    release();
    await running;
    expect(f.res.body).toContain("event: run.completed\n");
    expect(f.res.ended).toBe(true);
  });

  it("does not write after Stop ends the response before its close event", async () => {
    const f = fixture('{"type":"run.started","seq":1}\n');
    let entered!: () => void;
    const queued = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let fail!: (error: Error) => void;
    let reads = 0;
    f.ctx.readBatch = async (input) => {
      if (++reads === 1) return readEventReplayBatch(input);
      entered();
      return new Promise((_resolve, reject) => {
        fail = reject;
      });
    };
    const running = streamRunEvents(f.ctx, "run-x", 0, f.req as any, f.res as any);
    await queued;
    f.res.writableEnded = true;
    f.res.ended = true;
    f.res.accept = () => {
      throw new Error("write after end");
    };
    fail(Object.assign(new Error("stopping"), { code: "daemon_stopping" }));
    await running;
    expect(f.res.body).not.toContain("event: error\n");
    expect(f.ctx.sseClients.size).toBe(0);
  });
});
