import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  streamExpectationViolations,
  validateTypedStream,
  type FixtureStreamExpectations,
} from "@claudexor/core";
import { HarnessEvent } from "@claudexor/schema";
import { parse as parseYaml } from "yaml";
import { createCursorParser } from "./parse.js";

/**
 * #546: cursor-agent reports the end of a command it handed to a background
 * shell in a later `system/task_notification` frame whose `task_id` is the
 * result's `shellId`. The adapter folds that frame into the SAME command as a
 * `status` event (`payload.code: command_outcome_refined`) and keeps the exit
 * code unknown. The fixture is NATIVE-SHAPED, not a raw recording (see
 * manifest.yaml): the frame shape stays a hypothesis until a recording exists.
 */
const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
const NAME = "shell/background-completion.jsonl";
const manifest = parseYaml(readFileSync(join(FIXTURES, "manifest.yaml"), "utf8")) as {
  fixtures: Record<string, { source?: string; expectations?: FixtureStreamExpectations }>;
};

type Frame = Record<string, any>;
const frames: Frame[] = readFileSync(join(FIXTURES, NAME), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Frame);

const isNotification = (f: Frame): boolean =>
  f.type === "system" && f.subtype === "task_notification";
const notificationFor = (task: string): Frame => {
  const frame = frames.find((f) => isNotification(f) && f.task_id === task);
  expect(frame, `notification ${task}`).toBeDefined();
  return structuredClone(frame!);
};
const resultFrame = frames.find((f) => f.type === "result")!;
const handoffFrames = frames.filter(
  (f) => f.type === "tool_call" && !isNotification(f) && f !== resultFrame,
);

/** Replay frames through ONE stateful parser; `null` marks a frame the run loop counts as dropped. */
function replay(input: Frame[]): { events: HarnessEvent[]; dropped: Frame[] } {
  const parse = createCursorParser();
  const events: HarnessEvent[] = [];
  const dropped: Frame[] = [];
  for (const frame of input) {
    const out = parse(frame, "ses-fixture");
    if (out === null) dropped.push(frame);
    else events.push(...out);
  }
  return { events, dropped };
}

const refinements = (events: HarnessEvent[]): HarnessEvent[] =>
  events.filter((e) => e.type === "status" && e.payload?.["code"] === "command_outcome_refined");

const FOREGROUND = {
  state: "backgrounded",
  background_reason: "timeout",
  timeout_ms: 30000,
  shell_id: "148478",
  pid: 148480,
};
const BACKGROUND = {
  state: "backgrounded",
  background_reason: "requested",
  shell_id: "148490",
  pid: 148492,
};

describe("Cursor background completion notifications (#546, native-shaped fixture)", () => {
  const { events, dropped } = replay(frames);

  it("is labelled synthetic, keeps the stream conformant and drops no frame", () => {
    expect(manifest.fixtures[NAME]?.source).toBe("synthetic");
    const stats = validateTypedStream(events);
    expect(stats.statuslessToolResults).toBe(0);
    expect(streamExpectationViolations(events, manifest.fixtures[NAME]!.expectations!)).toEqual([]);
    // Before #546 both notifications were dropped_unrecognized_events.
    expect(dropped).toEqual([]);
  });

  it("says a handoff was handed off and its completion not observed, never still running", () => {
    const results = events.filter((e) => e.type === "tool_result");
    expect(results.map((e) => [e.tool?.use_id, e.tool?.status, e.tool?.command_outcome])).toEqual([
      ["call-foreground-sleep", "ok", FOREGROUND],
      ["call-background-sleep", "ok", BACKGROUND],
    ]);
    expect(results.map((e) => e.text)).toEqual([
      "tool_result: Handed off to background after its 30s timeout; completion not observed · shell 148478 · pid 148480",
      "tool_result: Handed off to background; completion not observed · shell 148490 · pid 148492",
    ]);
    for (const e of results) expect(e.tool?.exit_code).toBeUndefined();
  });

  it("refines the same command by shell id, in notification order, keeping the exit code unknown", () => {
    const refined = refinements(events);
    expect(refined).toHaveLength(2);
    // The shorter background command reported first: correlation is by id, not position.
    expect(refined.map((e) => e.tool)).toEqual([
      {
        name: "shell",
        kind: "command",
        use_id: "call-background-sleep",
        target: "sleep 5",
        command_outcome: {
          ...BACKGROUND,
          state: "completion_reported",
          completion_status: "success",
        },
      },
      {
        name: "shell",
        kind: "command",
        use_id: "call-foreground-sleep",
        target: "sleep 45",
        command_outcome: {
          ...FOREGROUND,
          state: "completion_reported",
          completion_status: "success",
        },
      },
    ]);
    expect(refined.map((e) => e.text)).toEqual([
      "Completion reported; exit code unknown · handed off to background · shell 148490 · pid 148492",
      "Completion reported; exit code unknown · handed off to background after its 30s timeout · shell 148478 · pid 148480",
    ]);
    // Never a second result, never a call status, never an invented exit code.
    for (const e of refined) {
      expect(e.tool?.status).toBeUndefined();
      expect(e.tool?.exit_code).toBeUndefined();
    }
    // The complete native frame is the evidence, kept exactly.
    expect(refined.map((e) => e.payload?.["native_notification"])).toEqual([
      notificationFor("148490"),
      notificationFor("148478"),
    ]);
  });

  it("round-trips every event through the HarnessEvent schema", () => {
    for (const event of events) {
      expect(HarnessEvent.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
    }
  });
});

describe("Cursor background completion edge frames (#546)", () => {
  const prefix = frames.filter((f) => !isNotification(f) && f !== resultFrame);

  it("ignores an unknown task id and a progress notification without touching a handoff", () => {
    const unknown = { ...notificationFor("148478"), task_id: "999999" };
    const progress = {
      ...notificationFor("148478"),
      task_id: "148478:task_progress:1",
      detail: "Shell output matched /ready/.",
    };
    const { events, dropped } = replay([...prefix, unknown, progress, notificationFor("148478")]);
    expect(dropped).toEqual([unknown, progress]);
    expect(refinements(events).map((e) => e.tool?.use_id)).toEqual(["call-foreground-sleep"]);
  });

  it("refines a command once: a duplicate notification adds nothing", () => {
    const { events, dropped } = replay([
      ...prefix,
      notificationFor("148478"),
      notificationFor("148478"),
    ]);
    expect(refinements(events)).toHaveLength(1);
    expect(dropped).toEqual([notificationFor("148478")]);
  });

  it("refines only its own command when it arrives after the final result", () => {
    const { events } = replay([...prefix, resultFrame, notificationFor("148490")]);
    const refined = refinements(events);
    expect(refined.map((e) => e.tool?.use_id)).toEqual(["call-background-sleep"]);
    const finalAt = events.findIndex((e) => e.type === "message" && e.final === true);
    expect(events.indexOf(refined[0]!)).toBeGreaterThan(finalAt);
  });

  it("never touches a neighbouring open shell call of the same name", () => {
    const neighbour = structuredClone(handoffFrames[0]!);
    neighbour.call_id = "call-open-neighbour";
    neighbour.tool_call.toolCallId = "call-open-neighbour";
    neighbour.tool_call.shellToolCall.args.toolCallId = "call-open-neighbour";
    neighbour.tool_call.shellToolCall.args.command = "pnpm test";
    const neighbourResult = structuredClone(handoffFrames[1]!);
    neighbourResult.call_id = "call-open-neighbour";
    neighbourResult.tool_call.toolCallId = "call-open-neighbour";
    neighbourResult.tool_call.shellToolCall.result = {
      success: { command: "pnpm test", exitCode: 0, signal: "", stdout: "ok\n", stderr: "" },
    };
    const { events } = replay([...prefix, neighbour, notificationFor("148490"), neighbourResult]);
    expect(refinements(events).map((e) => e.tool?.use_id)).toEqual(["call-background-sleep"]);
    // The neighbour's own later result still pairs with its call.
    const own = events.filter((e) => e.tool?.use_id === "call-open-neighbour");
    expect(own.map((e) => [e.type, e.tool?.target, e.tool?.command_outcome?.state])).toEqual([
      ["tool_call", "pnpm test", undefined],
      ["tool_result", "pnpm test", "exited"],
    ]);
  });

  it("requires the native session of the handoff and keeps the handoff pending", () => {
    const foreign = { ...notificationFor("148478"), session_id: "ses-another-chat" };
    const { events, dropped } = replay([...prefix, foreign]);
    expect(refinements(events)).toEqual([]);
    expect(dropped).toEqual([foreign]);
    // The refused frame consumed nothing: its own session's report still lands.
    const later = replay([...prefix, foreign, notificationFor("148478")]);
    expect(later.dropped).toEqual([foreign]);
    expect(refinements(later.events).map((e) => e.tool?.use_id)).toEqual(["call-foreground-sleep"]);
  });

  it("refuses a shell id two pending handoffs share", () => {
    const again = structuredClone(handoffFrames.slice(2, 4));
    for (const frame of again) {
      frame.call_id = "call-reused-shell";
      frame.tool_call.toolCallId = "call-reused-shell";
    }
    again[1]!.tool_call.shellToolCall.result.success.shellId = 148478;
    const { events, dropped } = replay([...prefix, ...again, notificationFor("148478")]);
    expect(refinements(events)).toEqual([]);
    expect(dropped).toEqual([notificationFor("148478")]);
    // Neither command is guessed at: both stay the handoffs their results said.
    expect(
      events
        .filter((e) => e.type === "tool_result" && e.tool?.command_outcome?.shell_id === "148478")
        .map((e) => [e.tool?.use_id, e.tool?.command_outcome?.state]),
    ).toEqual([
      ["call-foreground-sleep", "backgrounded"],
      ["call-reused-shell", "backgrounded"],
    ]);
  });

  it.each(["error", "aborted"] as const)(
    "keeps a source-supported %s report as the vendor's, parsing no exit code from prose",
    (status) => {
      const failed = { ...notificationFor("148490"), status, detail: "exit_code=1" };
      const { events } = replay([...prefix, failed]);
      const [refined] = refinements(events);
      expect(refined?.tool?.command_outcome).toEqual({
        ...BACKGROUND,
        state: "completion_reported",
        completion_status: status,
      });
      // The prose stays evidence; the typed exit code stays unknown.
      expect(refined?.tool?.exit_code).toBeUndefined();
      expect(refined?.text).toBe(
        `Completion reported (${status}); exit code unknown · handed off to background · shell 148490 · pid 148492`,
      );
      expect(refined?.payload?.["native_notification"]).toEqual(failed);
    },
  );

  it.each([
    ["a future word", "paused"],
    ["an empty word", ""],
    ["a number", 0],
  ])("leaves a report with %s unknown and its handoff pending", (_label, status) => {
    const future = { ...notificationFor("148478"), status };
    const { events, dropped } = replay([...prefix, future]);
    expect(refinements(events)).toEqual([]);
    expect(dropped).toEqual([future]);
    // Nothing was consumed: a report the protocol defines still refines it.
    const later = replay([...prefix, future, notificationFor("148478")]);
    expect(refinements(later.events).map((e) => e.tool?.use_id)).toEqual(["call-foreground-sleep"]);
  });

  it("treats a notification without a status as unrecognized", () => {
    const { status: _status, ...statusless } = notificationFor("148478");
    const { events, dropped } = replay([...prefix, statusless, notificationFor("148478")]);
    expect(dropped).toEqual([statusless]);
    expect(refinements(events)).toHaveLength(1);
  });
});

/**
 * Negative and unreadable reports through one parser. Weaker provenance than
 * the fixture above (see manifest.yaml): no native run showed these frames.
 */
describe("Cursor negative completion reports (#546, synthetic fixture)", () => {
  const NAME_FAILURES = "shell/background-completion-failures.jsonl";
  const input: Frame[] = readFileSync(join(FIXTURES, NAME_FAILURES), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Frame);
  const { events, dropped } = replay(input);

  it("keeps the stream conformant and counts only what it could not read", () => {
    expect(manifest.fixtures[NAME_FAILURES]?.source).toBe("synthetic");
    expect(validateTypedStream(events).statuslessToolResults).toBe(0);
    expect(
      streamExpectationViolations(events, manifest.fixtures[NAME_FAILURES]!.expectations!),
    ).toEqual([]);
    expect(dropped.map((f) => [f.task_id, f.status])).toEqual([
      ["148500:task_progress:1", "success"],
      ["148500", "error"],
      ["148520", "paused"],
    ]);
  });

  it("refines the reported commands and leaves the unreadable one a handoff", () => {
    expect(
      refinements(events).map((e) => [
        e.tool?.use_id,
        e.tool?.command_outcome?.completion_status,
        e.tool?.status,
        e.tool?.exit_code,
        e.text,
      ]),
    ).toEqual([
      [
        "call-failing-tests",
        "error",
        undefined,
        undefined,
        "Completion reported (error); exit code unknown · handed off to background after its 30s timeout · shell 148500 · pid 148502",
      ],
      [
        "call-dev-server",
        "aborted",
        undefined,
        undefined,
        "Completion reported (aborted); exit code unknown · handed off to background · shell 148510 · pid 148512",
      ],
    ]);
    expect(events.filter((e) => e.tool?.use_id === "call-long-wait").map((e) => e.type)).toEqual([
      "tool_call",
      "tool_result",
    ]);
  });

  it("round-trips every event through the HarnessEvent schema", () => {
    for (const event of events) {
      expect(HarnessEvent.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
    }
  });
});
