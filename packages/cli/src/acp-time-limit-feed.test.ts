import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpTimeLimitFeed } from "./acp-time-limit-feed.js";

const addr = { baseUrl: "http://localhost:1", token: "fixture" };
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ACP live time-limit feed", () => {
  it("discloses incomplete terminal replay when the drain bound expires", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream())));
    const events: unknown[] = [];
    const feed = new AcpTimeLimitFeed(addr, (event) => events.push(event));
    feed.start("run-slow");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const closing = feed.close(true);
    await vi.advanceTimersByTimeAsync(2_001);
    await closing;
    expect(events).toEqual([
      {
        type: "surface.warning",
        payload: { message: expect.stringContaining("updates unavailable") },
      },
    ]);
  });

  it("replays timer events, skips an unreadable row and starts only one stream", async () => {
    const event = {
      type: "control.applied",
      payload: { control: { kind: "time_limit", action: "reached" }, timeLimit: { mode: "soft" } },
    };
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          `: connected\n\nevent: harness.event\ndata: not-json\n\nevent: control.applied\ndata: ${JSON.stringify(event)}\n\nevent: end\ndata: {}\n\n`,
        ),
      );
    vi.stubGlobal("fetch", fetch);
    const emit = vi.fn(),
      feed = new AcpTimeLimitFeed(addr, emit);
    feed.start("run-1");
    feed.start("run-1");
    await feed.close(true);
    expect(emit).toHaveBeenCalledExactlyOnceWith(event);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // X1: `acp serve` has no other source of tool activity. The rows are the ones
  // the real Cursor parser and journal projection store for the #546 fixture.
  it("forwards the run's tool activity in order beside timer events, and nothing else", async () => {
    const stored = (
      JSON.parse(
        readFileSync(
          new URL(
            "../../../apps/macos/ClaudexorApp/Tests/ClaudexorAppTests/Fixtures/cursor-background-completion-transcript.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ) as { rows: Array<{ seq: number; payload: Record<string, any> }> }
    ).rows;
    const timer = {
      type: "control.applied",
      payload: { control: { kind: "time_limit", action: "reached" }, timeLimit: { mode: "soft" } },
    };
    const frames = stored.map(
      (row) => `id: ${row.seq}\nevent: harness.event\ndata: ${JSON.stringify(row)}\n\n`,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            `: connected\n\n${frames.join("")}event: harness.event\ndata: not-json\n\nevent: control.applied\ndata: ${JSON.stringify(timer)}\n\nevent: end\ndata: {}\n\n`,
          ),
        ),
    );
    const emit = vi.fn(),
      feed = new AcpTimeLimitFeed(addr, emit);
    feed.start("run-1");
    await feed.close(true);
    const forwarded = emit.mock.calls.map(([event]) => event);
    expect(forwarded.map((event) => event.seq ?? event.type)).toEqual([
      3,
      4,
      5,
      6,
      8,
      9,
      timer.type,
    ]);
    expect(forwarded.slice(0, -1)).toEqual(
      stored.filter((row) => [3, 4, 5, 6, 8, 9].includes(row.seq)),
    );
    expect(forwarded.at(-1)).toEqual(timer);
  });

  it("releases a quiet stream on owner teardown without a warning", async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream)));
    const emit = vi.fn(),
      feed = new AcpTimeLimitFeed(addr, emit);
    feed.start("run-1");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await feed.close(false);
    expect(cancelled).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });

  it.each([
    new Response("unavailable", { status: 503 }),
    new Response("event: control.applied\ndata: not-json\n\n"),
    new Response("event: control.applied\ndata: " + "x".repeat(32_001) + "\n\n"),
    new Response(""),
  ])("discloses a failed event stream without stopping the worker", async (response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const emit = vi.fn(),
      feed = new AcpTimeLimitFeed(addr, emit);
    feed.start("run-1");
    await feed.close(true);
    expect(emit).toHaveBeenCalledExactlyOnceWith({
      type: "surface.warning",
      payload: { message: expect.stringContaining("updates unavailable") },
    });
  });
});
