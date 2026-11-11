import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ControlGcReceipt } from "@claudexor/schema";
import type { RetentionRunner } from "./retention-service.js";
import { scheduleStartupRetention } from "./retention-schedule.js";
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)
const receipt = {
  freed_bytes: 0,
  deleted_runs: [],
  deleted_reviews: [],
  errors: [],
} as unknown as ControlGcReceipt;
function options() {
  const root = mkdtempSync(join(tmpdir(), "cx-retention-timer-"));
  roots.push(root);
  return {
    logPath: join(root, "log"),
    shuttingDown: () => false,
    delayMs: 10,
    intervalMs: 1000,
    continuationDelayMs: 1,
  };
}
it("promptly drains capped passes, revisits age eligibility periodically, and cancels its timer", async () => {
  vi.useFakeTimers();
  let calls = 0;
  const run: RetentionRunner = async () => {
    calls++;
    return receipt;
  };
  run.hasMore = () => calls < 3;
  const stop = scheduleStartupRetention(run, options());
  await vi.advanceTimersByTimeAsync(12);
  expect(calls).toBe(3);
  await vi.advanceTimersByTimeAsync(999);
  expect(calls).toBe(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(calls).toBe(4);
  await stop();
  await vi.advanceTimersByTimeAsync(5000);
  expect(calls).toBe(4);
});
it("does not overlap passes and drains an in-flight pass before closing", async () => {
  vi.useFakeTimers();
  let resolve!: (value: ControlGcReceipt) => void;
  const run = vi.fn(
    () =>
      new Promise<ControlGcReceipt>((done) => {
        resolve = done;
      }),
  );
  const stop = scheduleStartupRetention(run, options());
  await vi.advanceTimersByTimeAsync(10000);
  expect(run).toHaveBeenCalledTimes(1);
  let drained = false;
  const stopping = stop().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  resolve(receipt);
  await stopping;
  expect(drained).toBe(true);
  await vi.advanceTimersByTimeAsync(10000);
  expect(run).toHaveBeenCalledTimes(1);
});
it("retries failures on the interval and starts no work after shutdown", async () => {
  vi.useFakeTimers();
  const opts = options();
  let closing = false;
  opts.shuttingDown = () => closing;
  const run = vi.fn(async () => {
    throw new Error("unreadable refs");
  });
  const stop = scheduleStartupRetention(run, opts);
  await vi.advanceTimersByTimeAsync(1010);
  expect(run).toHaveBeenCalledTimes(2);
  closing = true;
  await vi.advanceTimersByTimeAsync(10000);
  expect(run).toHaveBeenCalledTimes(2);
  await stop();
});

it("asks about the completed receipt when deciding continuation", async () => {
  vi.useFakeTimers();
  const run: RetentionRunner = async () => receipt;
  const more = vi.fn((completed) => completed === receipt);
  run.hasMore = more;
  const stop = scheduleStartupRetention(run, options());
  await vi.advanceTimersByTimeAsync(10);
  expect(more).toHaveBeenCalledWith(receipt);
  await stop();
});
