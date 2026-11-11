import { describe, expect, it } from "vitest";
import { DaemonTimingFacts } from "./daemon-status.js";

const latency = { count: 1, p50Ms: 1, p99Ms: 1, maxMs: 1 };
const timing = { windowMs: null, windowEndedAt: null, routes: [], worstSync: [] };

describe("daemon timing contract", () => {
  it("accepts every bulk worker kind", () => {
    const facts = {
      ...timing,
      bulk: ["cursor", "detail", "summary", "event-replay", "artifact"].map((kind) => ({
        kind,
        queue: latency,
        projection: latency,
      })),
    };
    expect(DaemonTimingFacts.parse(facts)).toEqual(facts);
  });

  it("rejects the unshipped attention bulk kind", () => {
    expect(
      DaemonTimingFacts.safeParse({
        ...timing,
        bulk: [{ kind: "attention", queue: latency, projection: latency }],
      }).success,
    ).toBe(false);
  });

  it("accepts control.run_* synchronous labels from older engines", () => {
    const facts = {
      ...timing,
      worstSync: ["control.run_detail", "control.run_summary"].map((operation) => ({
        operation,
        durationMs: 1,
        at: "2026-10-28T00:00:00.000Z",
      })),
    };
    expect(DaemonTimingFacts.parse(facts)).toEqual(facts);
  });
});
