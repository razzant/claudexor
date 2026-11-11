import { describe, expect, it } from "vitest";
import { timelineEvents } from "./run-timeline.js";

/**
 * #450: a command that was moved to a background shell, timed out, or ended
 * in an unrecognized state is not a finished success. Its timeline row is a
 * warning; the typed fact decides, never the row text. Errors stay errors and
 * legacy rows without command facts keep their existing severity.
 */
function toolResult(tool: Record<string, unknown>, text = "tool_result") {
  return {
    type: "harness.event",
    payload: {
      harness_id: "cursor",
      attempt_id: "a01",
      type: "tool_result",
      title: text,
      text,
      tool: { name: "shell", kind: "command", target: "find /repo -name '*.log'", ...tool },
    },
  };
}

describe("timelineEvents projects command outcomes (#450)", () => {
  it("marks a background handoff, an elapsed timeout and an unknown outcome as warnings", () => {
    const rows = timelineEvents({}, [
      toolResult({
        status: "ok",
        command_outcome: { state: "backgrounded", background_reason: "timeout", shell_id: "3" },
      }),
      toolResult({ status: "ok", command_outcome: { state: "timed_out", timeout_ms: 30000 } }),
      toolResult({ status: "ok", command_outcome: { state: "unknown" } }),
      toolResult({ status: "ok", command_outcome: { state: "suspended" } }),
    ]);
    expect(rows.map((row) => row.severity)).toEqual(["warning", "warning", "warning", "warning"]);
    expect(rows.every((row) => row.toolName === "shell")).toBe(true);
  });

  it("keeps observed exits, errors and legacy rows on their existing severity", () => {
    const rows = timelineEvents({}, [
      toolResult({ status: "ok", exit_code: 0, command_outcome: { state: "exited" } }),
      toolResult({ status: "ok" }),
      toolResult(
        { status: "error", error_summary: "1 failing", command_outcome: { state: "timed_out" } },
        "tool_result: error: 1 failing",
      ),
    ]);
    expect(rows.map((row) => row.severity)).toEqual(["info", "info", "error"]);
  });
});

/**
 * #546: the later `command_outcome_refined` status names the same command and
 * its reported completion. The timeline needs no special case: the typed
 * `tool` facts make it a warning row for the command (an end without an exit
 * code is not a confirmed success) whose title is the engine's label.
 */
describe("timelineEvents projects a refined command outcome (#546)", () => {
  it("shows the reported completion as a warning row of the same command", () => {
    const label =
      "Completion reported; exit code unknown · handed off to background after its 30s timeout · shell 3";
    const [row] = timelineEvents({}, [
      {
        type: "harness.event",
        payload: {
          harness_id: "cursor",
          attempt_id: "a01",
          type: "status",
          title: label,
          text: label,
          tool: {
            name: "shell",
            kind: "command",
            use_id: "c1",
            target: "sleep 45",
            command_outcome: {
              state: "completion_reported",
              background_reason: "timeout",
              timeout_ms: 30000,
              shell_id: "3",
              completion_status: "success",
            },
          },
          payload: { code: "command_outcome_refined" },
        },
      },
    ]);
    expect(row).toMatchObject({
      type: "harness.event",
      severity: "warning",
      toolName: "shell",
      target: "sleep 45",
      title: label,
      harnessId: "cursor",
      attemptId: "a01",
    });
    expect(row?.outcome).toBeNull();
  });

  it("keeps a reported error a warning about the command, never a failed tool call", () => {
    const label =
      "Completion reported (error); exit code unknown · handed off to background · shell 3";
    const [row] = timelineEvents({}, [
      {
        type: "harness.event",
        payload: {
          harness_id: "cursor",
          attempt_id: "a01",
          type: "status",
          title: label,
          text: label,
          tool: {
            name: "shell",
            kind: "command",
            use_id: "c1",
            target: "pnpm test",
            command_outcome: {
              state: "completion_reported",
              background_reason: "requested",
              shell_id: "3",
              completion_status: "error",
            },
          },
          payload: { code: "command_outcome_refined" },
        },
      },
    ]);
    expect(row).toMatchObject({ severity: "warning", title: label, toolName: "shell" });
    expect(row?.errorSummary).toBeNull();
  });
});
