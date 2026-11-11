import { ControlTimelineEvent, FallbackReason } from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import { describe, expect, it, vi } from "vitest";
import { timelineEvents, type RunEventsIntegrity } from "./run-timeline.js";

// Pass-through spy: redaction is the projection's dominant per-row cost, so
// the bounded-work test counts calls without changing any result.
vi.mock("@claudexor/util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@claudexor/util")>();
  return { ...actual, redactSecrets: vi.fn(actual.redactSecrets) };
});

const MAX = 500;
const SECRET = `sk-ant-${"a".repeat(40)}`;
const CLEAN: RunEventsIntegrity = {
  absent: false,
  unreadable: false,
  malformedLines: 0,
  nonObjectLines: 0,
};
const INTEGRITY: Array<RunEventsIntegrity | undefined> = [
  undefined,
  CLEAN,
  { ...CLEAN, malformedLines: 2, nonObjectLines: 1 },
  { ...CLEAN, unreadable: true },
];

const text = (i: number) => `row ${i}: ранний 🌿 é 漢字\n`;

function displayedRow(i: number, body = text(i)): Record<string, unknown> {
  return {
    ts: "2026-10-27T00:00:00.000Z",
    type: "harness.event",
    payload: {
      harness_id: "cursor",
      attempt_id: "a01",
      type: i % 2 ? "message" : "thinking",
      text: body,
      payload: { delta: i % 3 === 0 },
    },
  };
}

/** Cursor's per-call flush: retained evidence that is never a timeline row. */
function bufferedRow(i: number): Record<string, unknown> {
  return {
    type: "harness.event",
    payload: {
      harness_id: "cursor",
      attempt_id: "a01",
      type: "message",
      text: `buffered ${i}`,
      payload: { buffered: true, model_call_id: `call-${i}` },
    },
  };
}

/** `displayed` timeline rows with buffered rows before, between and after them;
 * the newest displayed row carries a secret. */
function history(displayed: number): Record<string, unknown>[] {
  const events = [bufferedRow(-1)];
  for (let i = 0; i < displayed; i++) {
    events.push(displayedRow(i, i === displayed - 1 ? `newest ${SECRET} ✓` : text(i)));
    if (i % 3 === 2) events.push(bufferedRow(i));
  }
  events.push(bufferedRow(displayed));
  return events;
}

/** The pre-window algorithm through the unchanged single-row projection:
 * project EVERY event first, then keep the newest 500 rows. */
function projectThenBound(
  events: Record<string, unknown>[],
  integrity?: RunEventsIntegrity,
): ControlTimelineEvent[] {
  const rows = events.flatMap((ev) => timelineEvents({}, [ev]));
  const kept = rows.slice(-MAX);
  if (rows.length > MAX) {
    kept.unshift(
      ControlTimelineEvent.parse({
        type: "timeline.truncated",
        title: `${rows.length - MAX} earlier event(s) omitted from this projection`,
        detail: "Full history remains in events.jsonl.",
        severity: "info",
        rawRef: "events.jsonl",
      }),
    );
  }
  return [...timelineEvents({}, [], integrity), ...kept];
}

describe("timelineEvents selects its display window before projecting", () => {
  it.each([0, 499, 500, 501])("matches project-then-bound with %i displayed rows", (n) => {
    const events = history(n);
    for (const integrity of INTEGRITY) {
      const rows = timelineEvents({}, events, integrity);
      expect(JSON.stringify(rows)).toBe(JSON.stringify(projectThenBound(events, integrity)));
      expect(rows.filter((row) => !row.type.startsWith("timeline."))).toHaveLength(
        Math.min(n, MAX),
      );
      expect(rows.some((row) => row.type === "timeline.truncated")).toBe(n > MAX);
    }
  });

  it("counts only displayed rows as omitted and keeps severity and exact text", () => {
    const events = history(620);
    events.push(
      {
        type: "route.fallback.auth_switched",
        payload: { reason: "readiness_preferred", text: "preferred route" },
      },
      { type: "route.fallback.started", payload: { reason: "rate_limited", text: `to ${SECRET}` } },
      { type: "run.failed", payload: { error: "boom" } },
      {
        type: "harness.event",
        payload: {
          harness_id: "codex",
          tool: { name: "shell", status: "error", error_summary: "1" },
        },
      },
      {
        type: "harness.started",
        payload: { harness_id: "codex", ignored_settings: ["max_turns"] },
      },
      {
        type: "project.git.initialized",
        payload: { partial: true, failed_stage: "init", repo_root: "/tmp/p" },
      },
    );
    const corrupt = { ...CLEAN, malformedLines: 1 };
    const rows = timelineEvents({}, events, corrupt);

    expect(JSON.stringify(rows)).toBe(JSON.stringify(projectThenBound(events, corrupt)));
    expect(rows.slice(0, 2).map((row) => [row.type, row.title])).toEqual([
      [
        "timeline.evidence_incomplete",
        "1 malformed run event line(s) omitted from this projection",
      ],
      ["timeline.truncated", "126 earlier event(s) omitted from this projection"],
    ]);
    expect(rows).toHaveLength(MAX + 2);
    expect(rows[2]).toMatchObject({ detail: text(126), textKind: "thinking", textDelta: true });
    expect(rows.slice(-6).map((row) => row.severity)).toEqual([
      "info",
      "warning",
      "error",
      "error",
      "warning",
      "warning",
    ]);
    // The displayed rows carry the journaled text exactly (INV-146).
    expect(rows.at(-7)?.detail).toBe(`newest ${SECRET} ✓`);
    expect(rows.at(-5)?.title).toBe(`to ${SECRET}`);
  });

  // Corrupted-log behavior: a row whose projection throws (String() of an
  // object without a callable toString; the engine writes strings here) still
  // fails the timeline inside the window but is only counted when omitted.
  // Selection converts every event's type, so a malformed type rejects anywhere.
  it("fails on an unprojectable row inside the window and counts it outside", () => {
    const unprintable = () => JSON.parse('{"toString":1}') as unknown;
    const brokenGit = () => ({
      type: "project.git.initialized",
      payload: { partial: true, failed_stage: unprintable(), repo_root: "/tmp/p" },
    });
    const displayed = history(MAX);

    expect(() => timelineEvents({}, [...displayed, brokenGit()], CLEAN)).toThrow(TypeError);
    const rows = timelineEvents({}, [brokenGit(), ...displayed], CLEAN);
    expect(rows[0]?.title).toBe("1 earlier event(s) omitted from this projection");
    expect(JSON.stringify(rows)).toBe(
      JSON.stringify(timelineEvents({}, [{ type: "run.created" }, ...displayed], CLEAN)),
    );

    const brokenType = { type: unprintable(), payload: {} };
    expect(() => timelineEvents({}, [brokenType, ...displayed], CLEAN)).toThrow(TypeError);
    expect(() => timelineEvents({}, [...displayed, brokenType], CLEAN)).toThrow(TypeError);
  });

  it("validates, classifies and redacts the displayed window only", () => {
    const work = (displayed: number) => {
      const events = history(displayed);
      const validate = vi.spyOn(ControlTimelineEvent, "parse");
      const classify = vi.spyOn(FallbackReason, "safeParse");
      vi.mocked(redactSecrets).mockClear();
      try {
        return {
          rows: timelineEvents({}, events, CLEAN).length,
          validations: validate.mock.calls.length,
          classifications: classify.mock.calls.length,
          redactions: vi.mocked(redactSecrets).mock.calls.length,
        };
      } finally {
        validate.mockRestore();
        classify.mockRestore();
      }
    };
    const short = work(MAX + 1);
    const long = work(10_000);

    // One validation per returned row: 500 projected rows + the truncation marker.
    expect(long.rows).toBe(MAX + 1);
    expect(long.validations).toBe(long.rows);
    // An omitted row costs no redaction or classification at all.
    expect(long).toEqual(short);
  });

  it("leaves the caller's whole event snapshot for the other projections", () => {
    const events = history(700);
    const before = [...events];
    const json = JSON.stringify(events);

    timelineEvents({}, events, CLEAN);

    expect(events).toHaveLength(before.length);
    events.forEach((ev, i) => expect(ev).toBe(before[i]));
    expect(JSON.stringify(events)).toBe(json);
  });
});
