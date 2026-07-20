import { describe, expect, it } from "vitest";
import type { JobRecord } from "./server.js";
import { prunableCommandIds } from "./command-retention.js";

function rec(over: Partial<JobRecord> & { id: string }): JobRecord {
  return {
    state: "succeeded",
    params: {},
    createdAt: "2026-07-01T00:00:00.000Z",
    finishedAt: "2026-07-01T00:00:00.000Z",
    ...over,
  } as JobRecord;
}

const HOUR = 3_600_000;

describe("prunableCommandIds retention (A6)", () => {
  it("prunes expired clean successes beyond the cap, oldest first", () => {
    const now = Date.parse("2026-07-10T00:00:00.000Z");
    const records = [
      rec({
        id: "old-1",
        createdAt: "2026-07-01T00:00:00.000Z",
        finishedAt: "2026-07-01T00:00:00.000Z",
      }),
      rec({
        id: "old-2",
        createdAt: "2026-07-02T00:00:00.000Z",
        finishedAt: "2026-07-02T00:00:00.000Z",
      }),
      rec({
        id: "new-1",
        createdAt: "2026-07-09T23:59:00.000Z",
        finishedAt: "2026-07-09T23:59:00.000Z",
      }),
    ];
    // cap 1, retention 1h: two of three are old enough; keep the newest 1.
    expect(prunableCommandIds(records, 1, HOUR, now)).toEqual(["old-1", "old-2"]);
  });

  it("NEVER prunes a needs-decision run (succeeded + review blocked), keeping operator parity with old 'blocked'", () => {
    const now = Date.parse("2026-07-10T00:00:00.000Z");
    const blocked = rec({
      id: "needs-decision",
      createdAt: "2026-07-01T00:00:00.000Z",
      finishedAt: "2026-07-01T00:00:00.000Z",
      result: { lifecycle: "succeeded", facts: { review: "blocked", checks: "passed" } },
    });
    const cleanOld = rec({
      id: "clean-old",
      createdAt: "2026-07-01T12:00:00.000Z",
      finishedAt: "2026-07-01T12:00:00.000Z",
      result: { lifecycle: "succeeded", facts: { review: "approved", checks: "passed" } },
    });
    const cleanNew = rec({
      id: "clean-new",
      createdAt: "2026-07-09T23:59:00.000Z",
      finishedAt: "2026-07-09T23:59:00.000Z",
    });
    const prunable = prunableCommandIds([blocked, cleanOld, cleanNew], 1, HOUR, now);
    expect(prunable).toContain("clean-old");
    expect(prunable).not.toContain("needs-decision");
  });

  it("also exempts a checks-failed needs-decision run", () => {
    const now = Date.parse("2026-07-10T00:00:00.000Z");
    const checksFailed = rec({
      id: "checks-failed",
      createdAt: "2026-07-01T00:00:00.000Z",
      finishedAt: "2026-07-01T00:00:00.000Z",
      result: { lifecycle: "succeeded", facts: { review: "approved", checks: "failed" } },
    });
    const cleanOld = rec({
      id: "clean-old",
      createdAt: "2026-07-01T06:00:00.000Z",
      finishedAt: "2026-07-01T06:00:00.000Z",
    });
    const cleanOld2 = rec({
      id: "clean-old-2",
      createdAt: "2026-07-02T06:00:00.000Z",
      finishedAt: "2026-07-02T06:00:00.000Z",
    });
    const prunable = prunableCommandIds([checksFailed, cleanOld, cleanOld2], 1, HOUR, now);
    expect(prunable).not.toContain("checks-failed");
  });
});
