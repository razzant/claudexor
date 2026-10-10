import { afterEach, describe, expect, it, vi } from "vitest";
import { QUOTA_POLL_INTERVAL_MS } from "@claudexor/daemon";
import { createDaemonQuotaPoller } from "./daemon-admission-runtime.js";
afterEach(() => vi.useRealTimers());
describe("daemon quota poll cadence", () => {
  it("uses the shared interval, starts immediately, and owns only one timer", async () => {
    vi.useFakeTimers();
    try {
      const poll = vi.fn();
      const poller = createDaemonQuotaPoller(poll);

      poller.arm();
      poller.arm();
      expect(poll).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(QUOTA_POLL_INTERVAL_MS);
      expect(poll).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(1);

      poller.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
