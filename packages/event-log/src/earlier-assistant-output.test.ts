import { describe, expect, it } from "vitest";
import { COMMAND_OUTCOME_REFINED, type RunEvent } from "@claudexor/schema";
import { earlierAssistantOutput } from "./earlier-assistant-output.js";

const start = { type: "started" };
const tool = { type: "tool_call", text: "Only in tool output" };
const handoff = (id = "shell") => ({
  type: "tool_result",
  tool: {
    name: "Shell",
    kind: "command",
    use_id: id,
    command_outcome: { state: "backgrounded", shell_id: id },
  },
});
const complete = { type: "completed" };
const notice = {
  type: "status",
  text: "Only in notice",
  tool: {
    name: "Shell",
    kind: "command",
    use_id: "shell",
    command_outcome: {
      state: "completion_reported",
      completion_status: "success",
      shell_id: "shell",
    },
  },
  payload: { code: COMMAND_OUTCOME_REFINED },
};
const whole = (text: string) => ({ type: "message", text });
const delta = (text: string) => ({ ...whole(text), payload: { delta: true } });
const buffered = (text: string) => ({ ...whole(text), payload: { buffered: true } });
const final = (text: string) => ({
  ...whole(text),
  final: true,
  payload: { final_source: "assistant_message" },
});
const report = "Swatch note\n\nOne minor case difference.";
const footer = '\n```json\n{"work_report":{"state":"completed","required_inputs":[]}}\n```';
const amendment = "The color was azure.";

function project(...frames: Record<string, unknown>[]) {
  const events: RunEvent[] = frames.map((payload, i) => ({
    seq: i + 1,
    ts: "2026-11-27T00:00:00.000Z",
    run_id: "run-fixture",
    task_id: "task-fixture",
    type: "harness.event",
    payload: { harness_id: "cursor", attempt_id: "a02", session_id: "s2", ...payload },
  }));
  return earlierAssistantOutput(events, "a02");
}

function bodies(output: string | null): string[] {
  return (
    output
      ?.split(/(?:^|\n\n)### Events \d+–\d+\n\n/)
      .slice(1)
      .map((body) => body.trimEnd()) ?? []
  );
}

describe("Cursor earlier assistant output (#756)", () => {
  it("only selects the named winner when both Cursor attempts could publish an earlier report", () => {
    const events = ["a01", "a02"].flatMap((attempt, slot) =>
      [
        start,
        handoff(),
        whole(`Report ${attempt}`),
        tool,
        notice,
        whole(`Correction ${attempt}`),
        final(`Final ${attempt}`),
        complete,
      ].map((payload, index): RunEvent => ({
        seq: 1 + slot * 8 + index,
        ts: "2026-11-27T00:00:00.000Z",
        run_id: "fixture",
        task_id: "fixture",
        type: "harness.event",
        payload: {
          harness_id: "cursor",
          attempt_id: attempt,
          session_id: `session-${attempt}`,
          ...payload,
        },
      })),
    );
    expect(bodies(earlierAssistantOutput(events, "a01"))).toEqual(["Report a01", "Correction a01"]);
    expect(bodies(earlierAssistantOutput(events, "a02"))).toEqual(["Report a02", "Correction a02"]);
  });

  it("A: retains the pre-notice blocks and only collapses the exact buffered form", () => {
    const output = project(
      start,
      whole("Preamble"),
      handoff(),
      delta(report),
      delta(footer),
      notice,
      buffered(report + footer),
      tool,
      final(amendment),
      complete,
    );
    expect(bodies(output)).toEqual([report + footer]);
    expect(output).toContain("not the accepted final");
    expect(output).toContain("attempt `a02`, session `s2`");
  });

  it("B: retains genuinely new post-notice text despite an exact cumulative buffer", () => {
    const tail = "\nA new observation from the check.";
    expect(
      bodies(
        project(
          start,
          handoff(),
          delta(report),
          notice,
          notice,
          delta(tail),
          buffered(report + tail),
          tool,
          delta(amendment),
          whole(amendment),
          final(amendment),
          complete,
        ),
      ),
    ).toEqual([report + tail]);
  });

  it("C: shows a single complete answer even if its fragments crossed a notice", () => {
    const p = "The first sentence. ";
    const q = "The last sentence.";
    for (const aggregate of [whole(p + q), buffered(p + q)]) {
      expect(
        project(start, handoff(), delta(p), notice, delta(q), aggregate, final(p + q), complete),
      ).toBeNull();
    }
  });

  it("D: retains ordinary speech, with no assumption that earlier text is a report", () => {
    expect(
      bodies(project(start, handoff(), whole("I will wait."), notice, final(amendment), complete)),
    ).toEqual(["I will wait."]);
  });

  it("preserves independently spoken equal text, and excludes async/reasoning/tool and preamble text", () => {
    expect(
      bodies(
        project(
          start,
          whole("Preamble"),
          handoff(),
          whole(report),
          notice,
          { ...whole("Async response"), payload: { delivery: "async" } },
          { type: "thinking", text: "Only in reasoning" },
          whole(report),
          tool,
          final(amendment),
          complete,
        ),
      ),
    ).toEqual([report, report]);
  });

  it("preserves equal native snapshots of different calls and folds a same-call echo", () => {
    const snapshot = (model_call_id: string) => ({
      ...whole(report),
      payload: { buffered: true, model_call_id },
    });
    expect(
      bodies(
        project(
          start,
          handoff(),
          snapshot("call-1"),
          tool,
          snapshot("call-2"),
          tool,
          snapshot("call-2"),
          notice,
          final(amendment),
          complete,
        ),
      ),
    ).toEqual([report, report]);
  });

  it("anchors to the matching handoff despite intervening unrelated tools", () => {
    expect(
      bodies(
        project(
          start,
          whole("Preamble"),
          handoff(),
          whole(report),
          tool,
          notice,
          final(amendment),
          complete,
        ),
      ),
    ).toEqual([report]);
    const wrongShell = {
      ...notice,
      tool: {
        ...notice.tool,
        command_outcome: { ...notice.tool.command_outcome, shell_id: "other" },
      },
    };
    expect(
      project(start, handoff(), whole(report), tool, wrongShell, final(amendment), complete),
    ).toBeNull();
    expect(
      project(start, tool, whole(report), tool, notice, final(amendment), complete),
    ).toBeNull();
  });

  it("uses the matching interval instead of discarding a report between notices", () => {
    const secondNotice = {
      ...notice,
      tool: {
        ...notice.tool,
        use_id: "shell-2",
        command_outcome: { ...notice.tool.command_outcome, shell_id: "shell-2" },
      },
    };
    expect(
      bodies(
        project(
          start,
          whole("Preamble"),
          handoff(),
          notice,
          handoff("shell-2"),
          whole(report),
          secondNotice,
          tool,
          whole("Corrected text"),
          tool,
          final(amendment),
          complete,
        ),
      ),
    ).toEqual([report, "Corrected text"]);
  });

  it("does not insert an event heading into a word fragmented by a refinement", () => {
    const out = project(
      start,
      handoff(),
      delta("GRE"),
      notice,
      delta("EN"),
      buffered("GREEN"),
      tool,
      final(amendment),
      complete,
    );
    expect(bodies(out)).toEqual(["GREEN"]);
    expect(out).toContain("### Events 3–6\n\nGREEN");
  });

  it("does not cross into another harness, attempt or native session", () => {
    for (const other of [{ session_id: "s1" }, { attempt_id: "a01" }, { harness_id: "codex" }]) {
      expect(
        project(
          start,
          handoff(),
          delta(report),
          { ...notice, ...other },
          final(amendment),
          complete,
        ),
      ).toBeNull();
      expect(
        bodies(
          project(
            start,
            handoff(),
            { ...delta("Foreign"), ...other },
            delta(report),
            notice,
            final(amendment),
            complete,
          ),
        ),
      ).toEqual([report]);
    }
    expect(
      project(
        start,
        handoff(),
        delta(report),
        notice,
        { ...start, session_id: "s3" },
        { ...final(amendment), session_id: "s3" },
        { ...complete, session_id: "s3" },
      ),
    ).toBeNull();
  });

  it("omits unconfirmed notices, unsuccessful streams, ambiguous and non-native finals", () => {
    const initiated = [start, handoff(), delta(report), notice];
    const unmatched = {
      ...notice,
      tool: { ...notice.tool, command_outcome: { state: "unknown" } },
    };
    expect(
      project(start, handoff(), delta(report), unmatched, final(amendment), complete),
    ).toBeNull();
    expect(project(...initiated, final(amendment))).toBeNull();
    expect(project(...initiated, { ...final(amendment), after_stop: true }, complete)).toBeNull();
    expect(project(...initiated, final(report), final(amendment), complete)).toBeNull();
    expect(project(...initiated, final(amendment), { type: "error" }, complete)).toBeNull();
    expect(project(...initiated, { ...final(amendment), payload: {} }, complete)).toBeNull();
  });

  it("preserves earlier speech before a native result fallback", () => {
    expect(
      bodies(
        project(
          start,
          handoff(),
          delta(report),
          notice,
          tool,
          { ...final(amendment), payload: { final_source: "result" } },
          complete,
        ),
      ),
    ).toEqual([report]);
  });
});
