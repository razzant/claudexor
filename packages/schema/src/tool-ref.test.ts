import { describe, expect, it } from "vitest";
import { HarnessEvent } from "./harness.js";
import {
  COMMAND_OUTCOME_REFINED,
  commandOutcomeLabel,
  commandOutcomeRefinement,
  commandOutcomeUnconfirmed,
  ReportedCommandOutcomes,
  ToolRef,
} from "./tool-ref.js";
// The frozen pre-#450 ToolRef (store legacy oracle): a genuine OLD reader.
import { ToolRef as LegacyToolRef } from "../../daemon/src/store/test-support/fixtures/legacy/schema/tool-ref.js";

const handoff = {
  name: "shell",
  kind: "command" as const,
  use_id: "c1",
  target: "find /repo -name '*.log'",
  status: "ok" as const,
  command_outcome: {
    state: "backgrounded" as const,
    background_reason: "timeout" as const,
    timeout_ms: 30000,
    shell_id: "3",
    pid: 4242,
  },
};

describe("ToolRef command outcome (#450)", () => {
  it("round-trips through ToolRef and HarnessEvent", () => {
    expect(ToolRef.parse(JSON.parse(JSON.stringify(handoff)))).toEqual(handoff);
    const event = { type: "tool_result", session_id: "s", ts: "t", tool: handoff };
    expect(HarnessEvent.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });

  it("keeps legacy results unchanged and lets the old reader skip the new facts", () => {
    const legacy = { name: "shell", kind: "command", status: "ok", exit_code: 0 };
    expect(ToolRef.parse(legacy)).toEqual(legacy);
    expect(ToolRef.parse(legacy)).not.toHaveProperty("command_outcome");
    const old = LegacyToolRef.parse(handoff);
    expect(old).not.toHaveProperty("command_outcome");
    expect(old.status).toBe("ok");
  });

  it("refuses malformed facts at the schema boundary", () => {
    for (const command_outcome of [
      { state: "suspended" },
      { state: "backgrounded", pid: 0 },
      { state: "backgrounded", shell_id: "" },
      { state: "timed_out", timeout_ms: -1 },
      { state: "exited", signal: "" },
    ])
      expect(ToolRef.safeParse({ ...handoff, command_outcome }).success).toBe(false);
  });

  it("treats only an observed exit or absent facts as confirmed", () => {
    expect(commandOutcomeUnconfirmed(undefined)).toBe(false);
    expect(commandOutcomeUnconfirmed(null)).toBe(false);
    expect(commandOutcomeUnconfirmed({ state: "exited", signal: "SIGTERM" })).toBe(false);
    for (const value of [
      { state: "backgrounded" },
      { state: "timed_out" },
      { state: "unknown" },
      { state: "suspended" },
      {},
      "exited",
      [],
    ])
      expect(commandOutcomeUnconfirmed(value)).toBe(true);
  });

  it("describes each unconfirmed outcome with one English label", () => {
    expect(commandOutcomeLabel(undefined)).toBeNull();
    expect(commandOutcomeLabel({ state: "exited" })).toBeNull();
    // #546: a handoff never claims the command is still running; it only says
    // what was seen: the handoff, and no completion yet.
    expect(commandOutcomeLabel(handoff.command_outcome)).toBe(
      "Handed off to background after its 30s timeout; completion not observed · shell 3 · pid 4242",
    );
    expect(commandOutcomeLabel({ state: "backgrounded", background_reason: "timeout" })).toBe(
      "Handed off to background after its timeout; completion not observed",
    );
    expect(
      commandOutcomeLabel({ state: "backgrounded", background_reason: "timeout", timeout_ms: 0 }),
    ).toBe("Handed off to background; completion not observed");
    expect(
      commandOutcomeLabel({ state: "backgrounded", background_reason: "requested", pid: 7 }),
    ).toBe("Handed off to background; completion not observed · pid 7");
    expect(commandOutcomeLabel({ state: "timed_out", timeout_ms: 90000 })).toBe(
      "Timed out after 1m 30s · exit status unknown",
    );
    expect(commandOutcomeLabel({ state: "timed_out" })).toBe("Timed out · exit status unknown");
    expect(commandOutcomeLabel({ state: "unknown" })).toBe("Command outcome not reported");
    expect(commandOutcomeLabel({ state: "suspended" })).toBe("Command outcome not reported");
  });
});

describe("Command outcome refinement (#546)", () => {
  const completion = {
    ...handoff.command_outcome,
    state: "completion_reported" as const,
    completion_status: "success",
  };
  const refinement = {
    type: "status",
    session_id: "s",
    ts: "t",
    text: "x",
    tool: { name: "shell", kind: "command" as const, use_id: "c1", command_outcome: completion },
    payload: { code: "command_outcome_refined" },
  };

  it("keeps the handoff history beside a reported completion and stays unconfirmed", () => {
    expect(ToolRef.parse({ ...handoff, command_outcome: completion }).command_outcome).toEqual(
      completion,
    );
    expect(HarnessEvent.parse(JSON.parse(JSON.stringify(refinement)))).toEqual(refinement);
    // An end without an exit code is never a confirmed success.
    expect(commandOutcomeUnconfirmed(completion)).toBe(true);
    // Only the words a protocol source defines are reports; unknown stays unknown.
    for (const completion_status of ["success", "error", "aborted"])
      expect(
        ToolRef.safeParse({ ...handoff, command_outcome: { ...completion, completion_status } })
          .success,
      ).toBe(true);
    for (const completion_status of ["", "paused", "SUCCESS", 0])
      expect(
        ToolRef.safeParse({ ...handoff, command_outcome: { ...completion, completion_status } })
          .success,
      ).toBe(false);
    expect(commandOutcomeLabel({ ...completion, completion_status: "paused" })).toBe(
      "Command outcome not reported",
    );
  });

  it("says a completion was reported, keeps the exit code unknown and the handoff history", () => {
    expect(commandOutcomeLabel(completion)).toBe(
      "Completion reported; exit code unknown · handed off to background after its 30s timeout · shell 3 · pid 4242",
    );
    expect(
      commandOutcomeLabel({
        state: "completion_reported",
        background_reason: "requested",
        shell_id: "4",
        completion_status: "aborted",
      }),
    ).toBe("Completion reported (aborted); exit code unknown · handed off to background · shell 4");
    expect(commandOutcomeLabel({ state: "completion_reported" })).toBe(
      "Completion reported; exit code unknown · handed off to background",
    );
  });

  it("recognizes only a typed refinement of a named call", () => {
    expect(commandOutcomeRefinement(refinement)).toEqual({ useId: "c1", outcome: completion });
    // A stored row (harness.event payload) carries the same fields.
    expect(commandOutcomeRefinement(JSON.parse(JSON.stringify(refinement)))).toEqual({
      useId: "c1",
      outcome: completion,
    });
    for (const other of [
      { ...refinement, type: "tool_result" },
      { ...refinement, payload: { code: "live_input_delivered" } },
      { ...refinement, payload: undefined },
      { ...refinement, tool: { ...refinement.tool, use_id: undefined } },
      { ...refinement, tool: { ...refinement.tool, command_outcome: { state: "suspended" } } },
      { ...refinement, tool: { ...refinement.tool, command_outcome: undefined } },
      { ...refinement, tool: { ...refinement.tool, command_outcome: handoff.command_outcome } },
      {
        ...refinement,
        tool: {
          ...refinement.tool,
          command_outcome: { ...completion, completion_status: undefined },
        },
      },
      {
        ...refinement,
        tool: {
          ...refinement.tool,
          command_outcome: { ...completion, completion_status: "paused" },
        },
      },
      null,
      "status",
    ])
      expect(commandOutcomeRefinement(other)).toBeNull();
    expect(COMMAND_OUTCOME_REFINED).toBe("command_outcome_refined");
  });

  it("keeps a report in telemetry with its exact call, no exit code and a closed word", () => {
    const row = { tool: "shell", tool_use_id: "c1", command_outcome: completion };
    expect(ReportedCommandOutcomes.parse({ total: 3, recent: [row] })).toEqual({
      total: 3,
      recent: [{ ...row, target: null }],
    });
    expect(
      ReportedCommandOutcomes.parse({
        total: 1,
        recent: [{ ...row, command_outcome: { ...completion, exit_code: 0 } }],
      }).recent[0]?.command_outcome,
    ).not.toHaveProperty("exit_code");
    for (const invalid of [
      { total: -1, recent: [] },
      { total: 1, recent: [{ ...row, tool_use_id: "" }] },
      {
        total: 1,
        recent: [{ ...row, command_outcome: { ...completion, completion_status: "paused" } }],
      },
    ])
      expect(ReportedCommandOutcomes.safeParse(invalid).success).toBe(false);
  });

  it("never lets a status row prove an exit, though the wire can carry that shape", () => {
    const greening = {
      ...refinement,
      tool: { ...refinement.tool, exit_code: 0, command_outcome: { state: "exited" as const } },
    };
    // Reachable: the event schema cannot refuse it, so every reader must.
    expect(HarnessEvent.safeParse(greening).success).toBe(true);
    expect(commandOutcomeRefinement(greening)).toBeNull();
  });
});
