import { describe, expect, it } from "vitest";
import { timelineEvents } from "./run-timeline.js";

// QA-070: an unsupported per-harness knob (INV-105) is disclosed on
// harness.started as `ignored_settings`, but the timeline projection dropped it
// — the macOS/Control timeline could only render a benign "harness · started"
// row, hiding that a requested cost/safety bound had no effect. The projection
// must carry the list AND make the row visibly warning-shaped.
describe("timelineEvents projects harness.started ignored_settings (QA-070)", () => {
  it("carries ignoredSettings and lifts severity to warning", () => {
    const rows = timelineEvents({}, [
      {
        type: "harness.started",
        payload: {
          harness_id: "codex",
          attempt_id: "a01",
          external_context_policy: "live",
          ignored_settings: ["max_turns=5 (manifest capabilities.max_turns=false for codex)"],
        },
      },
    ]);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.ignoredSettings).toEqual([
      "max_turns=5 (manifest capabilities.max_turns=false for codex)",
    ]);
    // Not indistinguishable from an ordinary start (acceptance #3).
    expect(row.severity).toBe("warning");
  });

  it("leaves an ordinary harness.started quiet (empty list, info severity)", () => {
    const rows = timelineEvents({}, [
      {
        type: "harness.started",
        payload: { harness_id: "codex", attempt_id: "a01", external_context_policy: "auto" },
      },
    ]);
    expect(rows[0]!.ignoredSettings).toEqual([]);
    expect(rows[0]!.severity).toBe("info");
  });
});
