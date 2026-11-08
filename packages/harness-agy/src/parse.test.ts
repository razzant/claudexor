import { describe, expect, it } from "vitest";
import { parseAgyEvent } from "./parse.js";

const SID = "ses-test";

describe("parseAgyEvent", () => {
  it("maps init to one started with the native conversation id and model", () => {
    const out = parseAgyEvent(
      {
        event: "init",
        conversation_id: "abc-123",
        init: { model: "gemini-3.7-flash-low", cwd: "/w", tools: [], permission_mode: "plan" },
      },
      SID,
    );
    expect(out).toHaveLength(1);
    expect(out![0]).toMatchObject({
      type: "started",
      observed_model: "gemini-3.7-flash-low",
      payload: { native_session_id: "abc-123" },
    });
  });

  it("serializes structured_output as the typed final (Л-20), never the mixed response text", () => {
    const out = parseAgyEvent(
      {
        event: "result",
        result: {
          conversation_id: "abc",
          status: "SUCCESS",
          response: 'prose then JSON {"output":"x"}',
          structured_output: { output: "x", work_report: { state: "completed" } },
          usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 1, cache_read_tokens: 0 },
        },
      },
      SID,
    );
    const final = out!.find((e) => e.type === "message");
    expect(final).toMatchObject({ final: true, payload: { final_source: "structured_output" } });
    expect(JSON.parse((final as { text?: string }).text!)).toEqual({
      output: "x",
      work_report: { state: "completed" },
    });
    const usage = out!.find((e) => e.type === "usage");
    // thinking_tokens has no schema home and is dropped, never folded (R-9).
    expect(usage?.usage).toEqual({ input_tokens: 10, output_tokens: 2, cached_input_tokens: 0 });
  });

  it("maps a plain SUCCESS response to a result-sourced final", () => {
    const out = parseAgyEvent(
      { event: "result", result: { status: "SUCCESS", response: "OK\n" } },
      SID,
    );
    expect(out![0]).toMatchObject({
      type: "message",
      final: true,
      text: "OK\n",
      payload: { final_source: "result" },
    });
  });

  it("keeps empty SUCCESS an unknown failure without guessing permission denial", () => {
    const out = parseAgyEvent(
      { event: "result", result: { status: "SUCCESS", response: "" } },
      SID,
    );
    expect(out).toHaveLength(1);
    expect(out![0].type).toBe("error");
    expect(out![0].error).toContain("cause unknown");
    expect(out![0].permission_denial).toBeUndefined();
  });

  it("maps an ERROR result to a typed error", () => {
    const out = parseAgyEvent(
      {
        event: "result",
        result: { status: "ERROR", response: "", error: "authentication failed or timed out" },
      },
      SID,
    );
    expect(out![0]).toMatchObject({ type: "error", error: "authentication failed or timed out" });
  });

  it("types text_delta as an exact non-final fragment: whitespace-only and repeated frames kept", () => {
    const frames = ["Hel", "lo", " ", "\n", "ha", "ha", "\t\n"];
    const out = frames.flatMap((text_delta, index) =>
      parseAgyEvent(
        {
          event: "step_update",
          step_update: { step_index: index, step_type: "agent_response", text_delta },
        },
        SID,
      )!,
    );
    expect(out).toEqual(
      frames.map((text) =>
        expect.objectContaining({ type: "message", text, payload: { delta: true } }),
      ),
    );
    expect(out.some((event) => event.final)).toBe(false);
    // An empty frame carries nothing.
    expect(parseAgyEvent({ event: "step_update", step_update: { text_delta: "" } }, SID)).toEqual(
      [],
    );
  });

  it("keeps a non-SUCCESS result's response and object structured_output as exact non-final evidence", () => {
    const response = "Partial:\n\n  kept exactly  \n";
    const structured = { output: "x", work_report: { state: "completed" } };
    const out = parseAgyEvent(
      {
        event: "result",
        result: {
          status: "ERROR",
          response,
          structured_output: structured,
          error: "  vendor   words\nkept  ",
          usage: { input_tokens: 3, output_tokens: 1 },
        },
      },
      SID,
    )!;
    expect(out.map((event) => event.type)).toEqual(["message", "message", "error", "usage"]);
    expect(out[0]).toMatchObject({
      text: response,
      payload: { buffered: true, non_success_result: true },
    });
    expect(out[0]!.payload).not.toHaveProperty("structured_output");
    expect(out[1]).toMatchObject({
      text: JSON.stringify(structured),
      payload: { buffered: true, non_success_result: true, structured_output: true },
    });
    expect(out.some((event) => event.final)).toBe(false);
    // The display error stays the bounded summary; the vendor's words ride verbatim.
    expect(out[2]).toMatchObject({
      error: "vendor words kept",
      payload: {
        vendor_failure: {
          code: "ERROR",
          message: "  vendor   words\nkept  ",
          source: "agy_result",
        },
      },
    });
  });

  it("records the vendor's own status as an opaque code; no status is no code", () => {
    const vendor = (result: Record<string, unknown>) =>
      parseAgyEvent({ event: "result", result }, SID)!.find((event) => event.type === "error")!
        .payload?.["vendor_failure"];
    expect(vendor({ status: "CANCELLED" })).toEqual({
      code: "CANCELLED",
      message: null,
      source: "agy_result",
    });
    expect(vendor({ error: { code: 14, message: "unavailable" } })).toEqual({
      code: null,
      message: '{"code":14,"message":"unavailable"}',
      source: "agy_result",
    });
    expect(vendor({ status: "S".repeat(129), error: "e" })).toMatchObject({ code: null });
  });

  it("pairs ACTIVE/DONE tool steps as call/result and flags writes as file changes", () => {
    const active = parseAgyEvent(
      {
        event: "step_update",
        step_update: {
          state: "ACTIVE",
          step_type: "tool",
          tool_info: { name: "write_to_file", parameters: { TargetFile: "/w/a.txt" } },
        },
      },
      SID,
    )!;
    expect(active[0]).toMatchObject({ type: "tool_call", tool: { name: "write_to_file" } });
    const done = parseAgyEvent(
      {
        event: "step_update",
        step_update: {
          state: "DONE",
          step_type: "tool",
          tool_info: {
            name: "write_to_file",
            parameters: { TargetFile: "/w/a.txt" },
            output: "ok",
          },
        },
      },
      SID,
    )!;
    expect(done[0]).toMatchObject({ type: "tool_result", tool: { status: "ok" } });
    expect(done[1]).toMatchObject({ type: "file_change", payload: { path: "/w/a.txt" } });
    // Without a recorded step index nothing invents an invocation id.
    expect(active[0]?.tool).not.toHaveProperty("use_id");
  });

  it("keys a step's call, result and write companion by its recorded step index (#410)", () => {
    const step = (state: string, output?: string) =>
      parseAgyEvent(
        {
          event: "step_update",
          step_update: {
            step_index: 12,
            state,
            step_type: "tool",
            tool_info: {
              name: "write_to_file",
              parameters: { TargetFile: "/w/a.txt" },
              ...(output ? { output } : {}),
            },
          },
        },
        SID,
      )!;
    expect(step("ACTIVE")[0]?.tool).toMatchObject({ use_id: "step-12", target: "/w/a.txt" });
    const [result, change] = step("DONE", "ok");
    expect(result?.tool).toMatchObject({ use_id: "step-12", status: "ok" });
    // The companion is the same completed step, with its target; completion is typed.
    expect(change?.tool).toEqual({
      name: "write_to_file",
      kind: "file",
      use_id: "step-12",
      target: "/w/a.txt",
      phase: "completed",
      status: "ok",
    });
  });

  it("maps a tool_info error to a typed error tool result", () => {
    const out = parseAgyEvent(
      {
        event: "step_update",
        step_update: {
          state: "DONE",
          step_type: "tool",
          tool_info: { name: "run_command", parameters: { CommandLine: "false" }, error: "exit 1" },
        },
      },
      SID,
    )!;
    expect(out[0]).toMatchObject({
      type: "tool_result",
      tool: { status: "error", error_summary: "exit 1" },
    });
  });

  it("treats lifecycle step types as recognized no-ops and never double-counts usage", () => {
    expect(
      parseAgyEvent(
        { event: "step_update", step_update: { state: "DONE", step_type: "user_input" } },
        SID,
      ),
    ).toEqual([]);
    // Step usage is NOT emitted: the recorded fixtures prove per-step usages
    // sum exactly to the terminal aggregate, so emitting both counted every
    // token twice. The one usage event rides `result`.
    expect(
      parseAgyEvent(
        {
          event: "step_update",
          step_update: {
            state: "DONE",
            step_type: "checkpoint",
            usage: { input_tokens: 5, output_tokens: 1 },
          },
        },
        SID,
      ),
    ).toEqual([]);
    // A FUTURE step type stays a recognized no-op, never a dropped line.
    expect(
      parseAgyEvent(
        { event: "step_update", step_update: { state: "DONE", step_type: "totally_new" } },
        SID,
      ),
    ).toEqual([]);
  });

  it("never claims success for a non-DONE tool state (Ф0 review #1)", () => {
    for (const state of ["CANCELLED", "PENDING", ""]) {
      const out = parseAgyEvent(
        {
          event: "step_update",
          step_update: {
            state,
            step_type: "tool",
            tool_info: { name: "write_to_file", parameters: { TargetFile: "/w/a.txt" } },
          },
        },
        SID,
      )!;
      // No fabricated tool_result and — critically — no fabricated file_change.
      expect(out).toEqual([]);
    }
  });

  // Recorded 1.5.0 frames (#653, arm B of the 8 Nov A/B): a session deny rule
  // fails the call with state ERROR and the model continues; the ERROR frame is
  // that call's own result, an error, never success and never a file change.
  it("returns a refused tool step as its own error result, keyed by the step", () => {
    const refusal =
      'permission check failed for unsandboxed "date -u": Permission denied for unsandboxed(date -u). Matches user-configured deny rule.';
    const call = parseAgyEvent(
      {
        event: "step_update",
        step_update: {
          step_index: 2,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: { name: "run_command", parameters: { CommandLine: "date -u" } },
        },
      },
      SID,
    )!;
    const result = parseAgyEvent(
      {
        event: "step_update",
        step_update: {
          step_index: 2,
          state: "ERROR",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: {
            name: "run_command",
            parameters: { CommandLine: "date -u" },
            error: { type: "TOOL_ERROR", message: refusal },
          },
        },
      },
      SID,
    )!;
    expect(call).toEqual([expect.objectContaining({ type: "tool_call" })]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "tool_result",
      tool: {
        name: "run_command",
        kind: "command",
        use_id: "step-2",
        target: "date -u",
        status: "error",
        error_summary: expect.stringContaining(refusal.replace(/"/g, '\\"')),
      },
    });
    expect(result[0]!.tool!.use_id).toBe(call[0]!.tool!.use_id);
    const write = parseAgyEvent(
      {
        event: "step_update",
        step_update: {
          step_index: 4,
          state: "ERROR",
          step_type: "tool",
          tool_info: { name: "write_file", parameters: { TargetFile: "/w/a.txt" } },
        },
      },
      SID,
    )!;
    expect(write.map((event) => event.type)).toEqual(["tool_result"]);
    expect(write[0]!.tool).toMatchObject({
      status: "error",
      error_summary: "agy reported the tool step as ERROR",
    });
  });

  it("names the Path parameter of a read as its target", () => {
    const out = parseAgyEvent(
      {
        event: "step_update",
        step_update: {
          step_index: 4,
          state: "ACTIVE",
          step_type: "tool",
          tool_info: { name: "read_file", parameters: { Path: "/data/nonce.txt" } },
        },
      },
      SID,
    )!;
    expect(out[0]!.tool).toMatchObject({
      name: "read_file",
      kind: "file",
      target: "/data/nonce.txt",
    });
  });

  it("flags a proven writer whose name does not match the convention (#5)", () => {
    const out = parseAgyEvent(
      {
        event: "step_update",
        step_update: {
          state: "DONE",
          step_type: "tool",
          tool_info: {
            name: "generate_image",
            parameters: { TargetFile: "/w/x.png" },
            output: "ok",
          },
        },
      },
      SID,
    )!;
    expect(out.some((e) => e.type === "file_change")).toBe(true);
  });

  it("keeps a non-string vendor error detail instead of a generic message (#7)", () => {
    const out = parseAgyEvent(
      { event: "result", result: { status: "ERROR", error: { message: "boom" } } },
      SID,
    )!;
    expect((out[0] as { error?: string }).error).toContain("boom");
  });

  it("does not treat a falsy structured_output as an envelope (#7)", () => {
    for (const structured of [false, 0, ""]) {
      const out = parseAgyEvent(
        {
          event: "result",
          result: { status: "SUCCESS", response: "prose", structured_output: structured },
        },
        SID,
      )!;
      expect(out[0]).toMatchObject({ text: "prose", payload: { final_source: "result" } });
    }
  });

  it("keeps the file_change payload path exact and bounded (INV-146, #8)", () => {
    const change = (file: string) =>
      parseAgyEvent(
        {
          event: "step_update",
          step_update: {
            state: "DONE",
            step_type: "tool",
            tool_info: { name: "write_to_file", parameters: { TargetFile: file }, output: "ok" },
          },
        },
        SID,
      )!.find((e) => e.type === "file_change") as { payload?: { path?: string } };
    // Runtime-assembled: never a token-shaped literal at rest.
    const named = `/w/${["sk", "ant", "api03", "AAAABBBBCCCCDDDDEEEEFFFF"].join("-")}.txt`;
    expect(change(named).payload?.path).toBe(named);
    expect(change(`/w/${"a".repeat(600)}`).payload?.path).toHaveLength(500);
  });

  it("returns null for unknown top-level events so the run loop counts drops", () => {
    expect(parseAgyEvent({ event: "mystery" }, SID)).toBeNull();
    expect(parseAgyEvent({ nonsense: true }, SID)).toBeNull();
  });
});

describe("hostile top-level shapes never abort the run", () => {
  it("refuses to coerce a non-string discriminator instead of throwing", () => {
    // An object whose `toString` is not callable THROWS under String(), and
    // the run loop reports a mid-stream parse failure as "the harness failed
    // to start" — dropping the rest of a run that was going fine.
    const poison = JSON.parse('{"toString": 1}');
    expect(parseAgyEvent({ event: poison }, SID)).toBeNull();
    expect(
      parseAgyEvent({ event: "step_update", step_update: { step_type: poison } }, SID),
    ).toEqual([]);
    expect(
      parseAgyEvent(
        { event: "step_update", step_update: { step_type: "tool", state: poison } },
        SID,
      ),
    ).toEqual([]);
    const result = parseAgyEvent({ event: "result", result: { status: poison } }, SID)!;
    expect(result[0]).toMatchObject({ type: "error" });
  });
});

describe("tool targets are the agent's own actions, kept exact (INV-146)", () => {
  it("keeps a credential-shaped file path in the tool target", () => {
    const token = ["ghp", "q7Lm2Xv9Rk4Tz8Nw3Bp6Hs1Jd5Gf0Yc2Ae9U"].join("_");
    const out = parseAgyEvent(
      {
        event: "step_update",
        step_update: {
          step_index: 3,
          state: "ACTIVE",
          step_type: "tool",
          tool_info: { name: "write_to_file", parameters: { TargetFile: `/w/${token}.txt` } },
        },
      },
      "s1",
    );
    expect(out?.[0]?.tool?.target).toBe(`/w/${token}.txt`);
  });
});
