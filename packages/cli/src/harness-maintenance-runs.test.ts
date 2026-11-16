import { RunEventBus } from "@claudexor/daemon";
import type { RunEvent } from "@claudexor/schema";
import { describe, expect, it } from "vitest";
import { trackHarnessRuns } from "./harness-maintenance-runs.js";

const event = (type: string, attempt: string): RunEvent =>
  ({
    v: 1,
    run_id: "run-1",
    task_id: "task-1",
    seq: 0,
    ts: new Date().toISOString(),
    type,
    payload: { harness_id: "codex", attempt_id: attempt },
  }) as unknown as RunEvent;

describe("active harness runs", () => {
  it("counts only attempts that entered execution; a stopped preparation's lone completion changes nothing (#694)", () => {
    const bus = new RunEventBus();
    const runs = trackHarnessRuns(bus);
    bus.publish(event("harness.started", "a01"));
    expect(runs.count("codex")).toBe(1);
    // An attempt stopped while its envelope was prepared completes without a start.
    bus.publish(event("harness.completed", "a02"));
    expect(runs.count("codex")).toBe(1);
    bus.publish(event("harness.completed", "a01"));
    expect(runs.count("codex")).toBe(0);
    runs.close();
  });
});
