import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { streamRunEvents, type StreamEventsCtx } from "./run-events-stream.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Minimal ServerResponse capturing every SSE write; no backpressure. */
function fakeResponse() {
  const chunks: string[] = [];
  let ended = false;
  const res = {
    writeHead() {},
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    end() {
      ended = true;
    },
    on() {},
    off() {},
    once() {},
    get ended() {
      return ended;
    },
    get body() {
      return chunks.join("");
    },
  };
  return res;
}

describe("streamRunEvents terminal-tail race (QA-018)", () => {
  it("delivers the canonical terminal appended DURING the status await before ending", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "claudexor-sse-race-"));
    dirs.push(runDir);
    const eventsPath = join(runDir, "events.jsonl");
    // Initial durable snapshot: a non-terminal prefix only.
    writeFileSync(
      eventsPath,
      `${JSON.stringify({ type: "run.started", seq: 1 })}\n` +
        `${JSON.stringify({ type: "output.ready", seq: 2 })}\n`,
    );

    const rec = { id: "run-x", runId: "run-x", runDir, state: "running" } as any;
    const busSubs: Array<(e: { run_id?: string }) => void> = [];
    let statusCalls = 0;
    const res = fakeResponse();

    const ctx: StreamEventsCtx = {
      findRun: async () => rec,
      json() {},
      opts: {
        daemon: {
          status: async () => {
            statusCalls += 1;
            if (statusCalls === 1) {
              // The race: the producer appends its canonical terminal AND a bus
              // wakeup fires while this status probe is still in flight. The
              // wakeup lands during `draining`, so it must be latched, not lost.
              appendFileSync(
                eventsPath,
                `${JSON.stringify({ type: "budget.cash", seq: 3 })}\n` +
                  `${JSON.stringify({ type: "run.completed", seq: 4, lifecycle: "succeeded" })}\n`,
              );
              for (const sub of busSubs) sub({ run_id: "run-x" });
            }
            return { ...rec, state: "succeeded" };
          },
        },
        bus: {
          subscribe: (fn) => {
            busSubs.push(fn);
            return () => {};
          },
        },
        pollMs: 5,
        heartbeatMs: 100_000,
      },
      sseClients: new Set(),
    };

    await streamRunEvents(ctx, "run-x", 0, { on() {} } as any, res as any);

    const body = res.body;
    // The canonical terminal event was delivered, exactly once, before `end`.
    const completed = body.match(/event: run\.completed/g) ?? [];
    expect(completed).toHaveLength(1);
    expect(body.includes("event: budget.cash")).toBe(true);
    expect(body.trimEnd().endsWith("event: end\ndata: {}")).toBe(true);
    expect(res.ended).toBe(true);
    // Seq ids arrive in order with no gaps.
    const seqs = [...body.matchAll(/id: (\d+)/g)].map((m) => Number(m[1]));
    expect(seqs).toEqual([1, 2, 3, 4]);
  });
});
