import { describe, expect, it } from "vitest";
import { EventBus } from "./event-bus.js";
import { type ControlRunner, ControlApiServer } from "./server.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("EventBus", () => {
  it("replays from start and after a given id, then streams live", () => {
    const bus = new EventBus();
    bus.publish("r1", "run", { n: 1 });
    bus.publish("r1", "run", { n: 2 });

    const fromStart: number[] = [];
    bus.subscribe("r1", 0, (e) => fromStart.push(e.seq));
    expect(fromStart).toEqual([1, 2]);

    const afterFirst: number[] = [];
    bus.subscribe("r1", 1, (e) => afterFirst.push(e.seq));
    expect(afterFirst).toEqual([2]);

    // live delivery to both still-open subscribers
    bus.publish("r1", "run", { n: 3 });
    expect(fromStart).toEqual([1, 2, 3]);
    expect(afterFirst).toEqual([2, 3]);
  });

  it("emits a gap envelope when requested id is before the earliest buffered event", () => {
    const bus = new EventBus({ maxBufferPerRun: 2 });
    bus.publish("r1", "run", { n: 1 });
    bus.publish("r1", "run", { n: 2 });
    bus.publish("r1", "run", { n: 3 }); // evicts seq 1 (earliestSeq -> 2)

    const got: { seq: number; kind: string }[] = [];
    bus.subscribe("r1", 0, (e) => got.push({ seq: e.seq, kind: e.kind }));
    // first a gap notice, then the still-buffered events (2, 3)
    expect(got[0]?.kind).toBe("gap");
    expect(got.slice(1).map((g) => g.seq)).toEqual([2, 3]);
  });

  it("fires onComplete once (sync if already done) and clears listeners", () => {
    const bus = new EventBus();
    let live = 0;
    bus.subscribe("r1", 0, () => (live += 1));
    let completed = 0;
    bus.onComplete("r1", () => (completed += 1));

    bus.complete("r1");
    expect(completed).toBe(1);
    // listeners cleared on completion -> no further live delivery
    bus.publish("r1", "run", { n: 99 });
    expect(live).toBe(0);

    // onComplete after done fires synchronously
    let late = 0;
    bus.onComplete("r1", () => (late += 1));
    expect(late).toBe(1);
  });
});

describe("ControlApiServer", () => {
  const token = "test-token-123";

  async function withServer(runner: ControlRunner, fn: (base: string) => Promise<void>): Promise<void> {
    const server = new ControlApiServer({ token, runner });
    const { host, port } = await server.start();
    try {
      await fn(`http://${host}:${port}`);
    } finally {
      await server.stop();
    }
  }

  const okRunner: ControlRunner = async (_params, ctx) => {
    ctx.onRunStart({ runId: "run-auth", taskId: "t", runDir: "/tmp/run-auth" });
    return { ok: true };
  };

  it("rejects requests without a valid bearer token", async () => {
    await withServer(okRunner, async (base) => {
      const res = await fetch(`${base}/runs`, { method: "POST" });
      expect(res.status).toBe(401);
      const ok = await fetch(`${base}/runs`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
      expect(ok.status).toBe(200);
    });
  });

  it("fails loudly (500) when the runner never calls onRunStart — no dead runId", async () => {
    await withServer(async () => ({}), async (base) => {
      const res = await fetch(`${base}/runs`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
      expect(res.status).toBe(500);
    });
  });

  it("keeps the first runId authoritative when onRunStart is called twice", async () => {
    const runner: ControlRunner = async (_params, ctx) => {
      ctx.onRunStart({ runId: "run-first", taskId: "t", runDir: "/tmp/first" });
      ctx.onRunStart({ runId: "run-second", taskId: "t", runDir: "/tmp/second" });
      ctx.onEvent({ type: "E" });
      return {};
    };
    await withServer(runner, async (base) => {
      const start = await fetch(`${base}/runs`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
      const info = (await start.json()) as { runId: string };
      expect(info.runId).toBe("run-first");
      const sse = await fetch(`${base}/runs/run-first/events`, { headers: { authorization: `Bearer ${token}` } });
      expect(await sse.text()).toContain("event: end");
      // the second id was never registered as a run
      const r2 = await fetch(`${base}/runs/run-second/events`, { headers: { authorization: `Bearer ${token}` } });
      expect(r2.status).toBe(404);
    });
  });

  it("stop() resolves even with an open SSE stream and a runner that ignores abort", async () => {
    const server = new ControlApiServer({
      token,
      runner: async (_params, ctx) => {
        ctx.onRunStart({ runId: "run-stuck", taskId: "t", runDir: "/tmp/run-stuck" });
        await new Promise<void>(() => {}); // never resolves, ignores abort
      },
    });
    const { host, port } = await server.start();
    const base = `http://${host}:${port}`;
    const start = await fetch(`${base}/runs`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
    const info = (await start.json()) as { runId: string };
    const ac = new AbortController();
    const sse = fetch(`${base}/runs/${info.runId}/events`, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal }).catch(() => {});
    await sleep(50);
    await server.stop(); // must resolve despite the stuck runner + open SSE
    ac.abort();
    await sse;
    expect(true).toBe(true);
  }, 10000);

  it("starts a run, returns runId early, and streams events over SSE to completion", async () => {
    const runner: ControlRunner = async (_params, ctx) => {
      ctx.onRunStart({ runId: "run-sse", taskId: "task-1", runDir: "/tmp/run-sse" });
      ctx.onEvent({ type: "run.created" });
      ctx.onHarnessEvent({ type: "message", text: "hello" });
      ctx.onEvent({ type: "run.completed", payload: { status: "success" } });
      return { ok: true };
    };
    await withServer(runner, async (base) => {
      const start = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt: "x" }),
      });
      expect(start.status).toBe(200);
      const info = (await start.json()) as { runId: string };
      expect(info.runId).toBe("run-sse");

      const sse = await fetch(`${base}/runs/${info.runId}/events`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const text = await sse.text();
      expect(text).toContain("event: run");
      expect(text).toContain("event: harness");
      expect(text).toContain("hello");
      expect(text).toContain("event: end");
    });
  });

  it("replays only events after Last-Event-ID on reconnect (HTTP boundary)", async () => {
    const runner: ControlRunner = async (_params, ctx) => {
      ctx.onRunStart({ runId: "run-replay", taskId: "t", runDir: "/tmp/run-replay" });
      ctx.onEvent({ type: "EVENT_ONE" }); // seq 1
      ctx.onEvent({ type: "EVENT_TWO" }); // seq 2
      ctx.onEvent({ type: "EVENT_THREE" }); // seq 3
      return { ok: true };
    };
    await withServer(runner, async (base) => {
      const start = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      });
      const info = (await start.json()) as { runId: string };

      // Reconnect requesting everything after seq 2 -> only EVENT_THREE replays.
      const sse = await fetch(`${base}/runs/${info.runId}/events`, {
        headers: { authorization: `Bearer ${token}`, "last-event-id": "2" },
      });
      const text = await sse.text();
      expect(text).not.toContain("EVENT_ONE");
      expect(text).not.toContain("EVENT_TWO");
      expect(text).toContain("EVENT_THREE");
      expect(text).toContain("id: 3");
      expect(text).toContain("event: end");
    });
  });

  it("returns 404 streaming an unknown/evicted run", async () => {
    await withServer(async () => ({}), async (base) => {
      const res = await fetch(`${base}/runs/run-does-not-exist/events`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(404);
    });
  });

  it("cancels a running job via the abort signal", async () => {
    let aborted = false;
    const runner: ControlRunner = async (_params, ctx) => {
      ctx.onRunStart({ runId: "run-cancel", taskId: "t", runDir: "/tmp/run-cancel" });
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        });
      });
      return {};
    };
    await withServer(runner, async (base) => {
      const start = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      });
      const info = (await start.json()) as { runId: string };

      const cancel = await fetch(`${base}/runs/${info.runId}/cancel`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(cancel.status).toBe(200);

      for (let i = 0; i < 100 && !aborted; i++) await sleep(10);
      expect(aborted).toBe(true);

      let state = "";
      for (let i = 0; i < 100; i++) {
        const list = (await (await fetch(`${base}/runs`, { headers: { authorization: `Bearer ${token}` } })).json()) as {
          runs: { runId: string; state: string }[];
        };
        state = list.runs.find((r) => r.runId === info.runId)?.state ?? "";
        if (state === "cancelled") break;
        await sleep(10);
      }
      expect(state).toBe("cancelled");
    });
  });
});
