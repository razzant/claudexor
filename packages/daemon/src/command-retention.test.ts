/** Historical replay/file contract against the sealed legacy reference.
 * SQL serving behavior is covered by store/retention.test.ts. */
import { describe, expect, it } from "vitest";
import type { JobRecord } from "./server.js";
import {
  MAX_RETAINED_COMMAND_PARAMS_BYTES,
  prunableCommandIds,
} from "./store/test-support/fixtures/legacy/daemon/command-retention.js";

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
  it("retains model receipts and excludes them from the cap without exempting delivery", () => {
    const model = rec({
      id: "model",
      params: {
        kind: "model",
        request: {
          resourceId: "res-model",
          sha256: `sha256:${"a".repeat(64)}`,
          sizeBytes: 1,
        },
      },
    });
    const delivery = rec({ id: "delivery-old" });
    const agent = rec({ id: "agent-new", createdAt: "2026-07-02T00:00:00.000Z" });
    const now = Date.parse("2026-07-10T00:00:00.000Z");
    expect(prunableCommandIds([model, agent], 1, 0, now)).toEqual([]);
    expect(prunableCommandIds([model, delivery, agent], 1, 0, now)).toEqual(["delivery-old"]);
  });
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

describe("prunableCommandIds retained params byte budget (journal sprint D3)", () => {
  const now = Date.parse("2026-07-10T00:00:00.000Z");
  const sized = (id: string, day: number, chars: number, over: Partial<JobRecord> = {}) =>
    rec({
      id,
      createdAt: `2026-07-0${day}T00:00:00.000Z`,
      finishedAt: `2026-07-0${day}T00:00:00.000Z`,
      params: { prompt: "x".repeat(chars) },
      ...over,
    });

  it("prunes the oldest terminal product commands past the budget regardless of age", () => {
    // Each record serializes to 60 + 13 chars; three exceed a 160-char budget.
    const records = [sized("old", 1, 60), sized("mid", 2, 60), sized("new", 3, 60)];
    // Age/cap rule alone keeps everything (huge cap, huge retention)...
    expect(prunableCommandIds(records, 500, 365 * 24 * HOUR, now)).toEqual([]);
    // ...but the byte budget forgets oldest-first until the rest fits.
    expect(prunableCommandIds(records, 500, 365 * 24 * HOUR, now, 160)).toEqual(["old"]);
    expect(prunableCommandIds(records, 500, 365 * 24 * HOUR, now, 80)).toEqual(["old", "mid"]);
  });

  it("never byte-prunes a needs-decision run and never counts model receipts", () => {
    const blocked = sized("blocked", 1, 60, {
      result: { lifecycle: "succeeded", facts: { review: "blocked", checks: "passed" } },
    });
    const model = sized("model", 1, 4000, {
      params: {
        kind: "model",
        request: { resourceId: "r", sha256: `sha256:${"a".repeat(64)}`, sizeBytes: 1 },
      },
    });
    const live = sized("live", 1, 4000, { state: "running", finishedAt: undefined });
    const records = [blocked, model, live, sized("mid", 2, 60), sized("new", 3, 60)];
    // The exempt run's params are outside the budget: mid + new (146 chars)
    // fit 160, so nothing is pruned; a tighter budget still forgets oldest-first.
    expect(prunableCommandIds(records, 500, 365 * 24 * HOUR, now, 160)).toEqual([]);
    expect(prunableCommandIds(records, 500, 365 * 24 * HOUR, now, 100)).toEqual(["mid"]);
  });

  it("leaves exempt params outside the budget: exempt bytes alone over budget prune nothing", () => {
    const blocked = (id: string, day: number) =>
      sized(id, day, 600, {
        result: { lifecycle: "succeeded", facts: { review: "blocked", checks: "passed" } },
      });
    // Two needs-decision runs (613 B each) exceed a 1000 B budget on their own;
    // the one reachable command, finished a minute ago, must survive — the
    // loop could never reach `bytes <= budget` by pruning it.
    const fresh = sized("fresh", 9, 60);
    expect(
      prunableCommandIds(
        [blocked("b1", 1), blocked("b2", 2), fresh],
        500,
        365 * 24 * HOUR,
        now,
        1000,
      ),
    ).toEqual([]);
    // Control: reachable records over the budget still go oldest-first.
    const records = [
      blocked("b1", 1),
      sized("old", 2, 600),
      blocked("b2", 3),
      sized("new", 4, 600),
    ];
    expect(prunableCommandIds(records, 500, 365 * 24 * HOUR, now, 1000)).toEqual(["old"]);
  });

  it("keeps delivery commands outside the budget: never byte-pruned, never counted, product order unchanged", () => {
    // A delivery command persists the full params of the run it applied.
    const delivery = sized("delivery-apply", 1, 4000);
    const products = [sized("old", 2, 60), sized("mid", 3, 60), sized("new", 4, 60)];
    // Its 4 KB neither counts against the products' budget (all three fit 1000)...
    expect(prunableCommandIds([delivery, ...products], 500, 365 * 24 * HOUR, now, 1000)).toEqual(
      [],
    );
    // ...nor gets pruned when the products are over budget: same order as without it.
    expect(prunableCommandIds([delivery, ...products], 500, 365 * 24 * HOUR, now, 160)).toEqual([
      "old",
    ]);
    expect(prunableCommandIds(products, 500, 365 * 24 * HOUR, now, 160)).toEqual(["old"]);
    // Its own age/cap retention is untouched (cap 1, everything expired).
    expect(prunableCommandIds([delivery, ...products], 1, 0, now)).toEqual([
      "delivery-apply",
      "old",
      "mid",
    ]);
  });

  it("combines with the age/cap rule and reports each id once", () => {
    const records = [sized("old", 1, 60), sized("mid", 2, 60), sized("new", 3, 60)];
    expect(prunableCommandIds(records, 1, HOUR, now, 80)).toEqual(["old", "mid"]);
  });

  it("counts UTF-8 bytes, not UTF-16 units, against the budget", () => {
    // "€" is one UTF-16 unit but three UTF-8 bytes: 40 of them serialize to
    // 53 units yet 133 bytes; three such commands are 399 bytes against 300.
    const euro = (id: string, day: number) =>
      sized(id, day, 0, { params: { prompt: "€".repeat(40) } });
    const records = [euro("old", 1), euro("mid", 2), euro("new", 3)];
    expect(prunableCommandIds(records, 500, 365 * 24 * HOUR, now, 300)).toEqual(["old"]);
  });

  it("serializes each command's params once across prune passes", () => {
    let serialized = 0;
    const params = {
      toJSON() {
        serialized += 1;
        return { prompt: "x".repeat(60) };
      },
    };
    const record = sized("once", 1, 0, { params });
    prunableCommandIds([record], 500, 365 * 24 * HOUR, now, 1_000_000);
    prunableCommandIds([record], 500, 365 * 24 * HOUR, now, 1_000_000);
    expect(serialized).toBe(1);
  });

  it("holds three 100 MiB params under the real 256 MiB budget by forgetting the oldest", () => {
    const chunk = 100 * 1024 * 1024;
    const records = [sized("old", 1, chunk), sized("mid", 2, chunk), sized("new", 3, chunk)];
    expect(MAX_RETAINED_COMMAND_PARAMS_BYTES).toBe(256 * 1024 * 1024);
    expect(prunableCommandIds(records, 500, 365 * 24 * HOUR, now)).toEqual(["old"]);
  });
});
