import { describe, expect, it } from "vitest";
import { compareCandidates } from "@claudexor/arbitration";
import type { HarnessEvent, TaskContract } from "@claudexor/schema";
import { unrecoveredToolErrorFailure, webEvidenceFailure } from "./attemptFinalize.js";
import {
  attemptTelemetryRecord,
  createAttemptTelemetry,
  observeAttemptTelemetry,
  setAttemptOutcome,
  telemetrySummary,
  toolWarnings,
  unrecoveredToolErrors,
  webUnsatisfied,
} from "./attemptTelemetry.js";
import { toCandidateEvidence, type CandidateRun } from "./candidateEvidence.js";
import { beginNativeRetry } from "./native-retry-telemetry.js";

/**
 * #450 + INV-043: a command result that does not establish an observed end
 * (moved to a background shell, timed out, or an unrecognized state) never
 * proves that the command finished, so it can never recover an earlier
 * failure of the same command. Results without ids use the legacy
 * tool + kind + target key, which is where such a result used to launder the
 * failure.
 */
const ts = "2026-10-29T00:00:00.000Z";

function shellResult(status: "ok" | "error", commandOutcome?: unknown): HarnessEvent {
  return {
    type: "tool_result",
    session_id: "s",
    ts,
    tool: {
      name: "shell",
      kind: "command",
      target: "pnpm test",
      status,
      ...(status === "error" ? { error_summary: "1 failing" } : {}),
      ...(commandOutcome === undefined ? {} : { command_outcome: commandOutcome }),
    },
  } as HarnessEvent;
}

function outcomeAfterDeliverable(events: HarnessEvent[]) {
  const t = createAttemptTelemetry("auto", false);
  for (const event of events) observeAttemptTelemetry(t, event);
  setAttemptOutcome(t, {
    deliverablePresent: true,
    gatesPassed: null,
    harnessErrored: false,
    webRequiredUnsatisfied: false,
  });
  return t;
}

describe("command outcome and tool-error recovery (#450, INV-043)", () => {
  it.each([
    [
      "a background handoff",
      { state: "backgrounded", background_reason: "timeout", timeout_ms: 30000, shell_id: "3" },
    ],
    ["an elapsed timeout", { state: "timed_out", timeout_ms: 30000 }],
    ["an unrecognized outcome", { state: "unknown" }],
    ["a state from a newer engine", { state: "suspended" }],
  ])("%s of the same command leaves the earlier failure unrecovered", (_label, outcome) => {
    const t = outcomeAfterDeliverable([shellResult("error"), shellResult("ok", outcome)]);
    expect(unrecoveredToolErrors(t)).toHaveLength(1);
    // The delivered answer is kept: warnings, never a discarded deliverable.
    expect(t.outcome?.status).toBe("success_with_warnings");
  });

  it("an observed exit of the same command still recovers, as do legacy results", () => {
    const exited = outcomeAfterDeliverable([
      shellResult("error"),
      shellResult("ok", { state: "exited" }),
    ]);
    expect(unrecoveredToolErrors(exited)).toHaveLength(0);
    expect(exited.outcome?.status).toBe("success");

    const legacy = outcomeAfterDeliverable([shellResult("error"), shellResult("ok")]);
    expect(unrecoveredToolErrors(legacy)).toHaveLength(0);
  });

  it("an unconfirmed command by itself is not a tool error and keeps the deliverable", () => {
    const t = outcomeAfterDeliverable([
      shellResult("ok", { state: "backgrounded", background_reason: "requested", pid: 4343 }),
    ]);
    expect(t.toolErrors).toHaveLength(0);
    expect(t.outcome?.status).toBe("success");
  });
});

/**
 * #546: a later `command_outcome_refined` status (the vendor reported the end
 * of a background command, without an exit code) is a fact about that command,
 * never a tool result. The attempt keeps the vendor's word beside its tool
 * errors and feeds it to no recovery, warning, terminal or ranking policy: a
 * deliberately stopped dev server may simply have finished correctly, and a
 * reported success proves no exit. So these tests read the consumers that decide
 * an attempt, with an intentional `aborted` beside a real failed result.
 */
describe("a reported background completion and telemetry (#546)", () => {
  const handoff = {
    state: "backgrounded",
    background_reason: "timeout",
    timeout_ms: 30000,
    shell_id: "3",
  };
  const refined = (completionStatus: string, useId = "c2", kind = "command"): HarnessEvent =>
    ({
      type: "status",
      session_id: "s",
      ts,
      text: "ignored by telemetry",
      tool: {
        name: "shell",
        kind,
        use_id: useId,
        target: "pnpm test",
        command_outcome: {
          ...handoff,
          state: "completion_reported",
          completion_status: completionStatus,
        },
      },
      payload: { code: "command_outcome_refined" },
    }) as HarnessEvent;
  const reportOf = (completionStatus: string, useId = "c2") => ({
    tool: "shell",
    target: "pnpm test",
    tool_use_id: useId,
    command_outcome: {
      ...handoff,
      state: "completion_reported",
      completion_status: completionStatus,
    },
  });
  /** The same events observed without any outcome: what a lane's finalizer reads. */
  const observed = (events: HarnessEvent[]) => {
    const t = createAttemptTelemetry("auto", false);
    for (const event of events) observeAttemptTelemetry(t, event);
    return t;
  };
  const stopped = [shellResult("ok", handoff), refined("aborted")];
  const failedResult = [shellResult("error")];

  it.each(["success", "error", "aborted"])(
    "keeps a reported %s as a command fact: no tool error, no warning, no exit code",
    (completionStatus) => {
      const t = outcomeAfterDeliverable([shellResult("ok", handoff), refined(completionStatus)]);
      expect(t.toolErrors).toEqual([]);
      expect(toolWarnings(t)).toEqual([]);
      expect(t.outcome?.status).toBe("success");
      expect(t.outcome?.toolWarningsCount).toBe(0);
      const record = attemptTelemetryRecord("a01", "cursor", t);
      expect(record.reported_command_outcomes).toEqual({
        total: 1,
        recent: [reportOf(completionStatus)],
      });
      // Unknown exit stays unknown, whichever word the vendor used.
      expect(JSON.stringify(record.reported_command_outcomes)).not.toContain("exit");
    },
  );

  it("adds no field to an attempt without a report", () => {
    const t = outcomeAfterDeliverable([shellResult("ok", handoff)]);
    expect(attemptTelemetryRecord("a01", "cursor", t).reported_command_outcomes).toBeUndefined();
  });

  it("a reported success recovers no earlier real failure of the same command", () => {
    const t = outcomeAfterDeliverable([
      shellResult("error"),
      shellResult("ok", handoff),
      refined("success"),
    ]);
    expect(unrecoveredToolErrors(t).map((e) => e.summary)).toEqual(["1 failing"]);
    expect(t.statuslessResults).toBe(0);
    // The real failure decides, exactly as without the report.
    expect(t.outcome?.status).toBe("success_with_warnings");
    expect(t.outcome?.toolWarningsCount).toBe(1);
    expect(unrecoveredToolErrorFailure(unrecoveredToolErrors(t), false)).toBe(
      "shell failed without recovery: 1 failing",
    );
  });

  it("the finalizer never escalates an intentional stop; a real failed result still does", () => {
    // Both read-only lanes ask this of a deliverable-less attempt.
    for (const completionStatus of ["success", "error", "aborted"]) {
      const t = observed([shellResult("ok", handoff), refined(completionStatus)]);
      expect(unrecoveredToolErrorFailure(unrecoveredToolErrors(t), false)).toBeNull();
    }
    expect(unrecoveredToolErrorFailure(unrecoveredToolErrors(observed(failedResult)), false)).toBe(
      "shell failed without recovery: 1 failing",
    );
  });

  it("a report moves no candidate on the ranking; a real failed result still does", () => {
    const candidate = (attemptId: string, events: HarnessEvent[]) =>
      toCandidateEvidence(
        {
          attemptId,
          label: attemptId,
          diff: "+change\n",
          gates: [],
          cost: 0,
          errored: false,
          telemetry: outcomeAfterDeliverable(events),
        } as unknown as CandidateRun,
        {} as TaskContract,
        [],
        false,
      );
    const quiet = candidate("quiet", [shellResult("ok", handoff)]);
    const intentional = candidate("intentional", stopped);
    const failed = candidate("failed", failedResult);
    expect(intentional.toolWarningsCount).toBe(0);
    expect(compareCandidates(intentional, quiet)).toBe(0);
    for (const word of ["success", "error"])
      expect(
        compareCandidates(candidate(word, [shellResult("ok", handoff), refined(word)]), quiet),
      ).toBe(0);
    // Control: the axis itself still reads real tool errors.
    expect(failed.toolWarningsCount).toBe(1);
    expect(compareCandidates(intentional, failed)).toBeLessThan(0);
  });

  it("the summary keeps its error and warning counts clean of a report", () => {
    const summary = telemetrySummary(outcomeAfterDeliverable(stopped));
    expect(summary).toMatchObject({
      tool_errors_total: 0,
      unrecovered_tool_errors: 0,
      tool_errors: [],
      tool_warnings_count: 0,
      outcome: { status: "success", toolWarningsCount: 0, harnessErrored: false },
    });
    expect(summary).not.toHaveProperty("tool_warnings");
    expect(JSON.stringify(summary)).not.toContain("Completion reported");
    // Control: a real failed result reaches the same summary.
    expect(telemetrySummary(outcomeAfterDeliverable(failedResult))).toMatchObject({
      tool_warnings_count: 1,
      tool_warnings: [{ tool: "shell", summary: "1 failing" }],
    });
  });

  it("a report leaves required web exactly as it was", () => {
    for (const report of [refined("success"), refined("success", "c2", "web")]) {
      const t = createAttemptTelemetry("live", true);
      observeAttemptTelemetry(t, shellResult("ok", handoff));
      observeAttemptTelemetry(t, report);
      expect(t.web.attempted).toBe(false);
      expect(t.web.satisfied).toBe(false);
      expect(webUnsatisfied(t)).toBe(true);
      expect(webEvidenceFailure(t.web)).toContain("web evidence unsatisfied");
      setAttemptOutcome(t, {
        deliverablePresent: true,
        gatesPassed: null,
        harnessErrored: false,
        webRequiredUnsatisfied: webUnsatisfied(t),
      });
      expect(t.outcome?.status).toBe("blocked");
    }
    const denied = refined("error", "c2", "web");
    const t = observed([denied]);
    expect(t.web.failed).toBe(false);
    expect(t.toolErrors).toEqual([]);
  });

  it("a later exit of the same command under another call id leaves the report in place", () => {
    const rerun = {
      ...shellResult("ok", { state: "exited" }),
      tool: { ...shellResult("ok", { state: "exited" }).tool!, use_id: "c3" },
    } as HarnessEvent;
    const t = outcomeAfterDeliverable([shellResult("ok", handoff), refined("error"), rerun]);
    expect(attemptTelemetryRecord("a01", "cursor", t).reported_command_outcomes).toEqual({
      total: 1,
      recent: [reportOf("error")],
    });
    expect(t.toolErrors).toEqual([]);
  });

  it("a report outlives a native retry of the attempt, as tool errors do", () => {
    const t = observed(stopped);
    beginNativeRetry(t);
    setAttemptOutcome(t, {
      deliverablePresent: true,
      gatesPassed: null,
      harnessErrored: false,
      webRequiredUnsatisfied: false,
    });
    expect(attemptTelemetryRecord("a01", "cursor", t).reported_command_outcomes?.total).toBe(1);
  });

  it("keeps the true count and the latest reports when an attempt reports more than it keeps", () => {
    const events = Array.from({ length: 25 }, (_, index) => refined("success", `c${index}`));
    const reports = attemptTelemetryRecord(
      "a01",
      "cursor",
      outcomeAfterDeliverable(events),
    ).reported_command_outcomes;
    expect(reports?.total).toBe(25);
    expect(reports?.recent.map((report) => report.tool_use_id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `c${index + 5}`),
    );
  });

  it("a row that claims an exit or an unreadable report records nothing", () => {
    const exited = refined("error");
    exited.tool!.command_outcome = { state: "exited" };
    const future = refined("paused");
    const t = outcomeAfterDeliverable([shellResult("ok", handoff), exited, future]);
    expect(t.toolErrors).toHaveLength(0);
    expect(attemptTelemetryRecord("a01", "cursor", t).reported_command_outcomes).toBeUndefined();
    expect(t.outcome?.status).toBe("success");
  });
});
