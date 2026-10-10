import { describe, expect, it } from "vitest";
import { daemonLoopLine } from "./daemon-status-report.js";

const facts = {
  windowMs: 10_004.25,
  windowEndedAt: "2026-10-10T10:00:00.000Z",
  delay: { resolutionMs: 10, samples: 912, p50Ms: 10.42, p99Ms: 41.9, maxMs: 812.03 },
  utilization: 0.4123,
  gc: { count: 7, totalMs: 23.5, maxMs: 9.25 },
};

describe("daemon status event-loop line", () => {
  it("states the last window's delay, busy share and GC pauses", () => {
    expect(daemonLoopLine({ ok: true, loop: facts })).toBe(
      "event loop, last 10.0 s: delay p50 10.4 ms, p99 41.9 ms, max 812.0 ms" +
        " (912 samples at 10 ms resolution); busy 41.2%; gc 7 pause(s), 23.5 ms total, max 9.3 ms",
    );
    expect(daemonLoopLine({ loop: { ...facts, delay: null, utilization: null } })).toContain(
      "no delay samples; busy unmeasured;",
    );
  });

  it("keeps absent, pending and malformed facts distinct", () => {
    expect(daemonLoopLine({ ok: true })).toBe("event loop: not reported by this daemon");
    expect(daemonLoopLine({ ok: true, loop: null })).toBe("event loop: no completed window yet");
    expect(daemonLoopLine({ loop: { ...facts, utilization: 2 } })).toBe(
      "event loop: unreadable facts",
    );
  });
});

describe("daemon status SQL facts", () => {
  it("prints exact migration work and unknown unopened metrics", async () => {
    const { daemonStoreLine } = await import("./daemon-status-report.js");
    const store = {
      flusher: null,
      flush_lag_ms: null,
      last_barrier_at: null,
      interval_ms: null,
      wal_bytes: null,
      busy_waits: null,
      obligations_open: null,
      integrity: null,
      migration: null,
    };
    expect(daemonStoreLine({ store })).toContain(
      "integrity not open; flusher not open; flush lag unknown; WAL unknown; obligations unknown",
    );
    expect(
      daemonStoreLine({
        store: {
          ...store,
          migration: {
            phase: "importing",
            completedPartitions: 2,
            totalPartitions: 10,
            currentPartition: "global",
            processedBytes: 1234,
            totalBytes: 5000,
          },
        },
      }),
    ).toBe("engine store: importing, 2/10 partitions, 1234/5000 bytes (global)");
    expect(daemonStoreLine({})).toBe("engine store: not reported by this daemon");
    expect(daemonStoreLine({ store: { integrity: "imagined" } })).toBe(
      "engine store: unreadable facts",
    );
  });
});
