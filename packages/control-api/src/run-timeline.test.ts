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

describe("timelineEvents projects partial Git initialization honestly", () => {
  it("uses an incomplete warning row with the failed stage", () => {
    const rows = timelineEvents({}, [
      {
        type: "project.git.initialized",
        payload: {
          repo_root: "/tmp/project",
          initialized: false,
          baseline_committed: false,
          partial: true,
          failed_stage: "init",
        },
      },
    ]);

    expect(rows[0]).toMatchObject({
      title: "Git repository initialization incomplete",
      detail: "Stopped during init at /tmp/project; partial Git metadata may remain.",
      severity: "warning",
    });
  });
});

describe("soft run time limit reached notification", () => {
  it("marks only the soft reached control event as warning", () => {
    const events = [
      {
        type: "control.applied",
        payload: {
          control: { kind: "time_limit", action: "reached" },
          timeLimit: { mode: "soft" },
        },
      },
      {
        type: "control.applied",
        payload: {
          control: { kind: "time_limit", action: "reached" },
          timeLimit: { mode: "hard" },
        },
      },
      {
        type: "control.applied",
        payload: { control: { kind: "time_limit", action: "extend" }, timeLimit: { mode: "soft" } },
      },
    ];
    expect(timelineEvents({}, events).map((row) => row.severity)).toEqual([
      "warning",
      "info",
      "info",
    ]);
  });
});

describe("timelineEvents classifies a workspace settlement failure (#411f)", () => {
  it("is a warning row whose cause is not mistaken for a run error", () => {
    const rows = timelineEvents({}, [
      {
        type: "workspace.settlement_failed",
        payload: {
          attempt_id: "a01",
          envelope_id: "env-1",
          root: "/kept/tree",
          stage: "dispose",
          cause: "EBUSY: resource busy",
        },
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.severity).toBe("warning");
    expect(rows[0]!.attemptId).toBe("a01");
  });
});

describe("timelineEvents projects workspace.prepared (#563)", () => {
  const row = (scope: string[], copied: Record<string, number>, missing: string[]) =>
    timelineEvents({}, [
      {
        type: "workspace.prepared",
        payload: {
          attempt_id: "a01",
          source_root: "/work/project",
          scope_paths: scope,
          copied: { files: 0, directories: 0, symlinks: 0, ...copied },
          missing_paths: missing,
        },
      },
    ])[0]!;

  it("is a warning naming the missing path and its root when a selection was not found", () => {
    const missing = row(["new.txt"], {}, ["new.txt"]);
    expect(missing).toMatchObject({
      type: "workspace.prepared",
      attemptId: "a01",
      severity: "warning",
      title: "Isolated workspace copy prepared",
    });
    expect(missing.detail).toContain('Not found there when the copy was prepared: "new.txt"');
    expect(missing.detail).toContain("/work/project");
    expect(row([], {}, []).severity).toBe("warning");
  });

  it("stays informational when every selection was copied, an empty directory included", () => {
    expect(row(["input.txt"], { files: 1 }, []).severity).toBe("info");
    expect(row(["empty"], { directories: 1 }, []).severity).toBe("info");
    expect(row(["link"], { symlinks: 1 }, []).detail).toContain("copied as links, not followed");
  });
});
