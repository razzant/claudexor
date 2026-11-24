/** The held queued job of run-deadline/1: the retried durable cancel (`DeadlineHolds`). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeadlineHolds } from "./deadline-holds.js";

afterEach(() => void vi.useRealTimers());

function holds(failures: number) {
  const queue = new Set(["job"]);
  const calls: string[] = [];
  let left = failures;
  const h = new DeadlineHolds({
    cancel: (id) => {
      calls.push(`cancel ${id}`);
      if (left > 0) {
        left -= 1;
        throw Object.assign(new Error("injected"), { code: "EIO" });
      }
      queue.delete(id);
    },
    queued: (id) => queue.has(id),
    redrain: () => void calls.push("redrain"),
  });
  return { h, queue, calls, cancelled: () => void calls.push("cancelled") };
}

describe("DeadlineHolds", () => {
  it("retries a cancel that was not written with backoff, holding the job meanwhile; once it lands the hold goes and the queue moves", () => {
    vi.useFakeTimers();
    const { h, calls, cancelled } = holds(2);
    h.cancelExpired("job", {}, cancelled);
    expect(h.held.has("job"), "held: it never starts while the cancel is retried").toBe(true);
    vi.advanceTimersByTime(50);
    expect(calls).toEqual(["cancel job", "cancel job"]);
    vi.advanceTimersByTime(100);
    expect(calls).toEqual(["cancel job", "cancel job", "cancel job", "cancelled", "redrain"]);
    expect(h.held.has("job")).toBe(false);
  });

  it("stops retrying once a Stop took the job, without reporting the deadline's refusal", () => {
    vi.useFakeTimers();
    const { h, queue, calls, cancelled } = holds(5);
    h.cancelExpired("job", {}, cancelled);
    queue.delete("job"); // a Stop cancelled it meanwhile
    vi.advanceTimersByTime(10_000);
    expect(calls).toEqual(["cancel job"]);
    expect(h.held.has("job")).toBe(false);
  });

  it("retries nothing after the daemon stopped", () => {
    vi.useFakeTimers();
    const { h, calls, cancelled } = holds(5);
    h.cancelExpired("job", {}, cancelled);
    h.dispose();
    vi.advanceTimersByTime(10_000);
    expect(calls).toEqual(["cancel job"]);
  });
});
