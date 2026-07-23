import { describe, expect, it } from "vitest";
import { HarnessInactivityTimeoutError, withInactivityWatchdog } from "./inactivity.js";

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A source that models the runCliHarness/spawnProcess shape: it yields one
 * normal event, then blocks (silent — trips the inactivity watchdog). When the
 * watchdog aborts the child (its onTimeout), the source's pending next()
 * resolves — mirroring spawnProcess's requestCancel — takes `cleanupDelayMs` to
 * run its whole-tree "reap", THEN yields a typed terminal fact (mirroring
 * runCliHarness's post-abort termination_unconfirmed + completed) before
 * completing. The delay lets us prove the watchdog drains past the old 2000ms
 * grace and surfaces the terminal fact rather than dropping it.
 */
function reapingSource(cleanupDelayMs: number, signal: AbortSignal): AsyncGenerator<string> {
  async function* gen(): AsyncGenerator<string> {
    yield "live-event";
    // Block until the watchdog aborts us — mirrors spawnProcess's pending
    // iterator.next() resolving when the abort triggers requestCancel/reap.
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    // The "reap" — proving whole-tree death takes real time.
    await tick(cleanupDelayMs);
    // The typed terminal fact the existing plumbing emits (survivor group),
    // then the source completes (done) exactly like runCliHarness's post-abort
    // termination_unconfirmed + completed sequence.
    yield "termination_unconfirmed";
  }
  return gen();
}

describe("withInactivityWatchdog death-proof drain (QA-027)", () => {
  it("waits past the old grace for a >2s reap and surfaces the terminal fact before throwing", async () => {
    const cleanupDelayMs = 3000; // exceeds the retired 2000ms grace
    const controller = new AbortController();
    const source = reapingSource(cleanupDelayMs, controller.signal);
    let aborted = false;
    const started = Date.now();

    const watched = withInactivityWatchdog(source, {
      timeoutMs: 50,
      onTimeout: () => {
        aborted = true;
        controller.abort();
      },
      cleanupDeadlineMs: 8000,
    });

    const seen: string[] = [];
    let thrown: unknown = null;
    try {
      for await (const ev of watched) seen.push(ev);
    } catch (err) {
      thrown = err;
    }
    const elapsed = Date.now() - started;

    // The watchdog fired and aborted the child.
    expect(aborted).toBe(true);
    // No terminal was surfaced before the reap deadline: the drain held the
    // caller in the loop until the source finished its reap (>= cleanupDelayMs).
    expect(elapsed).toBeGreaterThanOrEqual(cleanupDelayMs);
    // The typed termination_unconfirmed terminal fact reached the caller (it was
    // NOT cut off by an early iterator.return that drops the disclosure).
    expect(seen).toContain("termination_unconfirmed");
    expect(seen).toContain("live-event");
    // The timeout is still signaled to the caller after the drain completes.
    expect(thrown).toBeInstanceOf(HarnessInactivityTimeoutError);
  }, 15000);

  it("bounds the drain by the reap deadline for a source that never proves death", async () => {
    // A source whose cleanup never yields a terminal and never resolves: the
    // watchdog must not park the run forever — it gives up at cleanupDeadlineMs.
    async function* wedged(): AsyncGenerator<string> {
      try {
        yield "live-event";
        await new Promise<void>(() => {});
      } finally {
        await new Promise<void>(() => {}); // never resolves
      }
    }
    const started = Date.now();
    const watched = withInactivityWatchdog(wedged(), {
      timeoutMs: 50,
      onTimeout: () => {},
      cleanupDeadlineMs: 400,
    });
    let thrown: unknown = null;
    try {
      for await (const _ev of watched) void _ev;
    } catch (err) {
      thrown = err;
    }
    const elapsed = Date.now() - started;
    expect(thrown).toBeInstanceOf(HarnessInactivityTimeoutError);
    // Bounded: it did not hang; it returned within a small multiple of the
    // 400ms cleanup deadline (the drain deadline plus the finally return grace).
    expect(elapsed).toBeLessThan(4000);
  }, 15000);
});
