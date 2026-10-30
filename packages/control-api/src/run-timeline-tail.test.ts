import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlTimelineEvent } from "@claudexor/schema";
import { timelineEvents, type RunEventsIntegrity } from "./run-timeline.js";

const complete: RunEventsIntegrity = {
  absent: false,
  unreadable: false,
  malformedLines: 0,
  nonObjectLines: 0,
};

/** Deliberately expensive reference: project EVERY row before bounding. A
 * one-event call cannot truncate; the established row projector stays shared. */
function projectAllThenTail(
  events: Record<string, unknown>[],
  integrity: RunEventsIntegrity,
): ControlTimelineEvent[] {
  const all = events.flatMap((event) => timelineEvents({}, [event]));
  const rows = all.slice(-500);
  if (all.length > 500) {
    rows.unshift(
      ControlTimelineEvent.parse({
        type: "timeline.truncated",
        title: `${all.length - 500} earlier event(s) omitted from this projection`,
        detail: "Full history remains in events.jsonl.",
        severity: "info",
        rawRef: "events.jsonl",
      }),
    );
  }
  return [...timelineEvents({}, [], integrity), ...rows];
}

function mixedEvents(count: number, bufferedEvery: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    type: index % 23 === 0 ? "message.accepted" : "harness.event",
    ts: `t-${index}`,
    payload: {
      type: index % 2 ? "thinking" : "message",
      text: `row ${index}\n  literal spacing; sk-ant-${"x".repeat(40)}\n`,
      harness_id: "fixture",
      attempt_id: `a${index % 3}`,
      message_id: `m${index}`,
      outcome: "accepted",
      payload: {
        buffered: bufferedEvery > 0 && index % bufferedEvery === 0,
        delta: index % 3 === 0,
      },
      tool: index % 5 === 0 ? { name: "tool", status: "error", error_summary: "failed" } : null,
      ignored_settings: index % 19 === 0 ? ["unsupported setting"] : [],
    },
  }));
}

afterEach(() => vi.restoreAllMocks());

describe("tail-first eligible timeline projection", () => {
  const cases = [0, 1, 499, 500, 501, 750, 1200].flatMap((count) =>
    [0, 1, 2, 17].flatMap((bufferedEvery) =>
      [false, true].map((incomplete) => ({ count, bufferedEvery, incomplete })),
    ),
  );

  it.each(cases)(
    "matches project-all at count=$count bufferedEvery=$bufferedEvery incomplete=$incomplete",
    ({ count, bufferedEvery, incomplete }) => {
      const events = mixedEvents(count, bufferedEvery);
      const integrity = incomplete
        ? { ...complete, malformedLines: 2, nonObjectLines: 1 }
        : complete;
      expect(timelineEvents({}, events, integrity)).toEqual(projectAllThenTail(events, integrity));
    },
  );

  it("rejects raw slice(-500) as a substitute for selecting 500 eligible rows", () => {
    const events = Array.from({ length: 650 }, (_, index) => ({
      type: "harness.event",
      payload: { text: `row ${index}`, payload: { buffered: index >= 150 && index < 180 } },
    }));
    const correct = timelineEvents({}, events);
    expect(correct).toHaveLength(501);
    expect(correct[0]?.title).toBe("120 earlier event(s) omitted from this projection");
    expect(correct[1]?.title).toBe("row 120");
    expect(correct.at(-1)?.title).toBe("row 649");
    const rawSlice = timelineEvents({}, events.slice(-500));
    expect(rawSlice).toHaveLength(470);
    expect(rawSlice).not.toEqual(correct.slice(1));
  });

  it("validates only the selected rows and explicit markers", () => {
    const parse = vi.spyOn(ControlTimelineEvent, "parse");
    const rows = timelineEvents({}, mixedEvents(6000, 17), {
      ...complete,
      malformedLines: 2,
      nonObjectLines: 1,
    });
    expect(rows).toHaveLength(502);
    expect(parse).toHaveBeenCalledTimes(502);
    expect(rows[0]).toMatchObject({
      type: "timeline.evidence_incomplete",
      title: "3 malformed run event line(s) omitted from this projection",
      severity: "warning",
      textKind: null,
      textDelta: false,
    });
    expect(rows[1]?.type).toBe("timeline.truncated");
    // Selected rows are projected exactly (INV-146).
    expect(rows.slice(2).some((row) => row.detail?.includes(`sk-ant-${"x".repeat(40)}`))).toBe(
      true,
    );
  });

  it("does not disclose intentional truncation when every row is buffered", () => {
    const events = Array.from({ length: 600 }, () => ({
      type: "harness.event",
      payload: { payload: { buffered: true } },
    }));
    expect(timelineEvents({}, events, complete)).toEqual([]);
    expect(timelineEvents({}, [], { ...complete, unreadable: true })).toMatchObject([
      { type: "timeline.evidence_unavailable", severity: "error" },
    ]);
  });
});
