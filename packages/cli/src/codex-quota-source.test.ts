import { describe, expect, it } from "vitest";
import { parseCodexRateLimitsResponse } from "./codex-quota-source.js";

describe("Codex app-server quota source", () => {
  it("keeps every bucket/window and vendor metadata without an aggregate", () => {
    const [snapshot] = parseCodexRateLimitsResponse(
      {
        rateLimits: { planType: "plus", limitId: "codex" },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            limitName: "Codex",
            primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1782368577 },
            secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1782387153 },
          },
          review: {
            limitId: "review",
            limitName: "Review",
            primary: { usedPercent: 10, windowDurationMins: 60, resetsAt: 1782360000 },
          },
        },
      },
      new Date("2026-07-15T12:00:00.000Z"),
    );
    expect(snapshot?.subject.plan_label).toBe("plus");
    expect(snapshot?.constraints.map((item) => [item.id, item.used_ratio])).toEqual([
      ["codex:primary", 0.2],
      ["codex:secondary", 0.4],
      ["review:primary", 0.1],
    ]);
  });
});
