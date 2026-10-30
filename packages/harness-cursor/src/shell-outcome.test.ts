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
 * #450: a Cursor shell call that is still running (moved to a background
 * shell) or whose timeout elapsed must not become an ordinary finished
 * command. The fixture is SYNTHETIC (see manifest.yaml); the one recorded
 * shell frame in this package is the Ask permission denial replayed below.
 */
const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
const manifest = parseYaml(readFileSync(join(FIXTURES, "manifest.yaml"), "utf8")) as {
  fixtures: Record<string, { source?: string; expectations?: FixtureStreamExpectations }>;
};

type Frame = Record<string, any>;

function replay(name: string): { frames: Frame[]; events: HarnessEvent[] } {
  const frames = readFileSync(join(FIXTURES, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Frame);
  const parse = createCursorParser();
  return { frames, events: frames.flatMap((frame) => parse(frame, "ses-fixture") ?? []) };
}

function nativeResult(frames: Frame[], callId: string): unknown {
  const frame = frames.find(
    (f) => f.type === "tool_call" && f.subtype === "completed" && f.call_id === callId,
  );
  return frame?.tool_call?.shellToolCall?.result;
}

function shellCall(result: unknown, callId = "u1", command = "run it"): HarnessEvent {
  const parse = createCursorParser();
  parse(
    {
      type: "tool_call",
      subtype: "started",
      call_id: callId,
      tool_call: { shellToolCall: { args: { command } } },
    },
    "s1",
  );
  const frame = {
    type: "tool_call",
    subtype: "completed",
    call_id: callId,
    tool_call: { shellToolCall: result === undefined ? {} : { result } },
  };
  const out = parse(frame, "s1") ?? [];
  expect(out).toHaveLength(1);
  return out[0]!;
}

describe("Cursor shell command outcomes (#450, synthetic fixture)", () => {
  const name = "shell/command-outcomes.jsonl";
  const { frames, events } = replay(name);
  const result = (callId: string): HarnessEvent => {
    const found = events.find((e) => e.type === "tool_result" && e.tool?.use_id === callId);
    expect(found, `tool_result for ${callId}`).toBeDefined();
    return found!;
  };

  it("is labelled synthetic and keeps the stream conformant", () => {
    expect(manifest.fixtures[name]?.source).toBe("synthetic");
    const stats = validateTypedStream(events);
    expect(stats.statuslessToolResults).toBe(0);
    expect(streamExpectationViolations(events, manifest.fixtures[name]!.expectations!)).toEqual([]);
  });

  it("records an observed exit with its exit code and keeps the display text unchanged", () => {
    const ok = result("c-exit0");
    expect(ok.tool).toMatchObject({ status: "ok", exit_code: 0 });
    expect(ok.tool?.command_outcome).toEqual({ state: "exited" });
    expect(ok.text).toBe("tool_result");
    expect(ok.payload?.["native_result"]).toBeUndefined();

    const failed = result("c-exit1");
    expect(failed.tool).toMatchObject({ status: "error", exit_code: 1 });
    expect(failed.tool?.command_outcome).toEqual({ state: "exited" });
    expect(failed.text?.startsWith("tool_result: error")).toBe(true);
  });

  it("never turns a timeout-driven background handoff into a finished command", () => {
    const handoff = result("c-bg-timeout");
    // The tool call itself returned normally; the command did not finish.
    expect(handoff.tool?.status).toBe("ok");
    // exitCode 0 in the frame is a protobuf default, not an observed exit.
    expect(handoff.tool?.exit_code).toBeUndefined();
    expect(handoff.tool?.command_outcome).toEqual({
      state: "backgrounded",
      background_reason: "timeout",
      timeout_ms: 30000,
      shell_id: "3",
      pid: 4242,
    });
    expect(handoff.text).toBe(
      "tool_result: Moved to background after 30s · still running · shell 3 · pid 4242",
    );
    // The complete native result rides the durable tool payload exactly.
    expect(handoff.payload?.["native_result"]).toEqual(nativeResult(frames, "c-bg-timeout"));
  });

  it("records a requested background run without inventing a timeout", () => {
    const handoff = result("c-bg-request");
    expect(handoff.tool?.status).toBe("ok");
    expect(handoff.tool?.exit_code).toBeUndefined();
    expect(handoff.tool?.command_outcome).toEqual({
      state: "backgrounded",
      background_reason: "requested",
      shell_id: "4",
      pid: 4343,
    });
    expect(handoff.text).toBe("tool_result: Running in background · shell 4 · pid 4343");
    expect(handoff.payload?.["native_result"]).toEqual(nativeResult(frames, "c-bg-request"));
  });

  it("keeps an elapsed timeout distinct from both exit and failure", () => {
    const timedOut = result("c-timeout");
    expect(timedOut.tool?.status).toBe("ok");
    expect(timedOut.tool?.command_outcome).toEqual({ state: "timed_out", timeout_ms: 30000 });
    expect(timedOut.text).toBe("tool_result: Timed out after 30s · exit status unknown");
    expect(timedOut.payload?.["native_result"]).toEqual(nativeResult(frames, "c-timeout"));

    // An abort after the timeout stays an error, records the timeout, and
    // never reports the -1 sentinel as an exit code.
    const aborted = result("c-abort");
    expect(aborted.tool?.status).toBe("error");
    expect(aborted.tool?.exit_code).toBeUndefined();
    expect(aborted.tool?.command_outcome).toEqual({ state: "timed_out" });
    expect(aborted.payload?.["native_result"]).toEqual(nativeResult(frames, "c-abort"));
  });

  it("maps a spawn error to an error result instead of ok", () => {
    const spawn = result("c-spawn");
    expect(spawn.tool?.status).toBe("error");
    expect(spawn.tool?.command_outcome).toBeUndefined();
    expect(spawn.tool?.error_summary).toContain("spawnError");
  });

  it("round-trips every typed result through the HarnessEvent schema", () => {
    for (const event of events.filter((e) => e.type === "tool_result")) {
      expect(HarnessEvent.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
    }
  });
});

describe("Cursor shell command outcome edge shapes (#450)", () => {
  it("keeps the background handle typed when a long echo pushes it out of the excerpt", () => {
    const stdout = "x".repeat(5000);
    const event = shellCall({
      success: {
        command: `printf '${"y".repeat(600)}'`,
        workingDirectory: "/repo",
        exitCode: 0,
        signal: "",
        stdout,
        stderr: "",
        executionTime: 0,
        shellId: 9,
        pid: 99,
        msToWait: 30000,
        backgroundReason: "SHELL_BACKGROUND_REASON_TIMEOUT",
      },
    });
    expect(event.tool?.content_summary?.length).toBeLessThanOrEqual(300);
    expect(event.tool?.content_summary).not.toContain("shellId");
    expect(event.tool?.command_outcome).toMatchObject({ shell_id: "9", pid: 99 });
    const native = event.payload?.["native_result"] as { success: { stdout: string } };
    expect(native.success.stdout).toBe(stdout);
  });

  it("keeps credential-shaped values in the preserved native result exactly (INV-146)", () => {
    const token = "ghp_" + "A".repeat(36);
    const event = shellCall({
      success: {
        command: "env",
        stdout: `GITHUB_TOKEN=${token}\n`,
        exitCode: 0,
        shellId: 2,
        backgroundReason: "SHELL_BACKGROUND_REASON_USER_REQUEST",
      },
    });
    const evidence = JSON.stringify(event.payload?.["native_result"]);
    expect(evidence).toContain(`GITHUB_TOKEN=${token}`);
    expect(evidence).not.toContain("[redacted]");
  });

  it("reports an unrecognized or missing shell result as unknown, never as a finished command", () => {
    const future = shellCall({ cancelled: { command: "run it" } });
    expect(future.tool?.status).toBe("ok");
    expect(future.tool?.command_outcome).toEqual({ state: "unknown" });
    expect(future.text).toBe("tool_result: Command outcome not reported");
    expect(future.payload?.["native_result"]).toEqual({ cancelled: { command: "run it" } });

    const missing = shellCall(undefined);
    expect(missing.tool?.command_outcome).toEqual({ state: "unknown" });
    expect(missing.payload?.["native_result"]).toBeNull();
  });

  it("treats a result-level background marker as a handoff even without a shell id", () => {
    const event = shellCall({
      success: { command: "run it", exitCode: 0, signal: "", stdout: "", stderr: "" },
      isBackground: true,
      pid: 77,
    });
    expect(event.tool?.exit_code).toBeUndefined();
    expect(event.tool?.command_outcome).toEqual({ state: "backgrounded", pid: 77 });
    expect(event.text).toBe("tool_result: Running in background · pid 77");
  });

  it("describes a zero-wait timeout handoff as a background start", () => {
    const event = shellCall({
      success: {
        command: "pnpm dev",
        exitCode: 0,
        shellId: 5,
        msToWait: 0,
        backgroundReason: "SHELL_BACKGROUND_REASON_TIMEOUT",
      },
    });
    expect(event.tool?.command_outcome).toEqual({
      state: "backgrounded",
      background_reason: "timeout",
      timeout_ms: 0,
      shell_id: "5",
    });
    expect(event.text).toBe("tool_result: Running in background · shell 5");
  });

  it("adds no command facts to denied, legacy-failed or non-shell results", () => {
    // The only RECORDED Cursor shell frame (cursor-agent 2026.08.11-e8db854).
    const { events } = replay("plan/plan-ask-permission-denied-recorded.jsonl");
    const denied = events.find((e) => e.type === "tool_result" && e.tool?.kind === "command");
    expect(denied?.tool?.status).toBe("denied");
    expect(denied?.tool?.command_outcome).toBeUndefined();
    expect(denied?.payload).toBeUndefined();

    const parse = createCursorParser();
    const legacy = parse(
      {
        type: "tool_call",
        subtype: "failed",
        call_id: "legacy",
        tool_call: {
          shellToolCall: { args: { command: "pnpm test" }, result: { error: "exit 1" } },
        },
      },
      "s1",
    );
    expect(legacy?.[0]?.tool?.status).toBe("error");
    expect(legacy?.[0]?.tool?.command_outcome).toBeUndefined();

    const write = parse(
      {
        type: "tool_call",
        subtype: "completed",
        call_id: "w1",
        tool_call: { writeToolCall: { args: { path: "a.ts" }, result: { linesCreated: 1 } } },
      },
      "s1",
    );
    expect(write?.[0]?.tool?.command_outcome).toBeUndefined();
    expect(write?.[0]?.payload).toBeUndefined();
  });
});
