import { describe, expect, it } from "vitest";
import { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { claudeArgsForSpec } from "./index.js";
import { createClaudeParser, parseClaudeEvent } from "./parse.js";

describe("parseClaudeEvent", () => {
  it("maps system init to a started event with observed model", () => {
    const out = parseClaudeEvent(
      { type: "system", subtype: "init", model: "claude-opus", tools: ["Read"] },
      "s1",
    );
    expect(out).toHaveLength(1);
    expect(out?.[0]?.type).toBe("started");
    expect(out?.[0]?.observed_model).toBe("claude-opus");
    expect(() => HarnessEvent.parse(out?.[0])).not.toThrow();
  });

  it("returns null for unrecognized shapes so the run loop can count drops", () => {
    expect(parseClaudeEvent({ type: "totally_new_event" }, "s1")).toBeNull();
    expect(parseClaudeEvent({ type: "system", subtype: "compact" }, "s1")).toEqual([]);
  });

  it("splits an assistant message into text + typed edit/tool events", () => {
    const out = parseClaudeEvent(
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Editing file." },
            { type: "tool_use", id: "tu_e", name: "Edit", input: { file_path: "src/a.ts" } },
            { type: "tool_use", id: "tu_b", name: "Bash", input: { command: "ls" } },
            { type: "tool_use", id: "tu_w", name: "WebSearch", input: { query: "claudexor" } },
          ],
        },
      },
      "s1",
    ) as HarnessEvent[];
    const types = out.map((e) => e.type);
    expect(types).toEqual(["message", "file_change", "tool_call", "tool_call"]);
    const fc = out.find((e) => e.type === "file_change");
    expect(fc?.payload?.["path"]).toBe("src/a.ts");
    expect(fc?.tool?.kind).toBe("file");
    const bash = out.find((e) => e.tool?.name === "Bash");
    expect(bash?.tool?.kind).toBe("command");
    const web = out.find((e) => e.tool?.name === "WebSearch");
    expect(web?.tool?.kind).toBe("web");
    expect(web?.tool?.target).toContain("claudexor");
    for (const e of out) expect(() => HarnessEvent.parse(e)).not.toThrow();
  });

  it("maps result to usage (with cached tokens) and final text (+ error on non-success subtype)", () => {
    const ok = parseClaudeEvent(
      {
        type: "result",
        subtype: "success",
        result: "[]",
        total_cost_usd: 0.25,
        usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 10 },
      },
      "s1",
    ) as HarnessEvent[];
    expect(ok.map((e) => e.type)).toEqual(["usage", "message"]);
    expect(ok[0]?.usage?.cost_usd).toBe(0.25);
    expect(ok[0]?.usage?.cached_input_tokens).toBe(100);
    expect(ok[1]?.text).toBe("[]");

    // error_max_turns is a BENIGN turn-control outcome (the run hit --max-turns
    // with partial work preserved), NOT a run failure -> a timeline thinking
    // event, never an error (mirrors ExitPlanMode/AskUserQuestion handling).
    const maxTurns = parseClaudeEvent({ type: "result", subtype: "error_max_turns", num_turns: 12 }, "s1") as HarnessEvent[];
    expect(maxTurns.map((e) => e.type)).toEqual(["usage", "thinking"]);
    expect(maxTurns[1]?.text).toContain("max-turns");
    expect(maxTurns[1]?.payload?.["max_turns_reached"]).toBe(true);

    // Other non-success subtypes remain real errors.
    const realError = parseClaudeEvent({ type: "result", subtype: "error_during_execution" }, "s1") as HarnessEvent[];
    expect(realError.map((e) => e.type)).toEqual(["usage", "error"]);
  });

  it("emits typed tool_result with redacted detail resolved to the originating tool", () => {
    const parse = createClaudeParser();
    parse(
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_1", name: "Write", input: { file_path: "/tmp/hello.txt" } }] },
      },
      "s1",
    );
    const out = parse(
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "created /tmp/hello.txt" }] },
          ],
        },
      },
      "s1",
    ) as HarnessEvent[];
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe("tool_result");
    expect(out[0]?.tool?.status).toBe("ok");
    expect(out[0]?.tool?.use_id).toBe("toolu_1");
    expect(out[0]?.tool?.name).toBe("Write");
    expect(out[0]?.tool?.kind).toBe("file");
    expect(out[0]?.tool?.content_summary).toContain("/tmp/hello.txt");
    expect(() => HarnessEvent.parse(out[0])).not.toThrow();
  });

  it("maps Claude policy-denied tool results to denied diagnostics", () => {
    const parse = createClaudeParser({ deniedTools: ["WebSearch"] });
    parse(
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_web", name: "WebSearch", input: { query: "x" } }] },
      },
      "s1",
    );
    const out = parse(
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu_web", is_error: true, content: [{ type: "text", text: "WebSearch denied by policy" }] },
          ],
        },
      },
      "s1",
    ) as HarnessEvent[];
    expect(out[0]?.type).toBe("tool_result");
    expect(out[0]?.text).toContain("tool_result: denied");
    expect(out[0]?.tool?.status).toBe("denied");
    expect(out[0]?.tool?.kind).toBe("web");
    expect(out[0]?.tool?.error_summary).toBeUndefined();
    expect(out[0]?.tool?.content_summary).toContain("WebSearch denied by policy");
    expect(() => HarnessEvent.parse(out[0])).not.toThrow();
  });

  it("keeps Claude sibling-cancelled prose as a normal error without structured signal", () => {
    const parse = createClaudeParser();
    parse(
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_grep", name: "Grep", input: { pattern: "x" } }] },
      },
      "s1",
    );
    const out = parse(
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu_grep", is_error: true, content: [{ type: "text", text: "Cancelled: parallel tool call Bash(...) errored" }] },
          ],
        },
      },
      "s1",
    ) as HarnessEvent[];
    expect(out[0]?.type).toBe("tool_result");
    expect(out[0]?.tool?.status).toBe("error");
    expect(out[0]?.tool?.kind).toBe("search");
    expect(() => HarnessEvent.parse(out[0])).not.toThrow();
  });

  it("does not classify arbitrary error prose as denied without the typed deny set", () => {
    const parse = createClaudeParser();
    parse(
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_web", name: "WebSearch", input: { query: "x" } }] },
      },
      "s1",
    );
    const out = parse(
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu_web", is_error: true, content: [{ type: "text", text: "WebSearch denied by policy" }] },
          ],
        },
      },
      "s1",
    ) as HarnessEvent[];
    expect(out[0]?.tool?.status).toBe("error");
  });

  it("forwards model/effort/max-turns hints, clamping effort onto claude's ladder", () => {
    const spec = HarnessRunSpec.parse({
      session_id: "ses-test",
      intent: "review",
      prompt: "review",
      cwd: "/tmp",
      access: "readonly",
      model_hint: "opus",
      // claude --effort does NOT accept max/xhigh -> the shared normalizer clamps
      // it onto the supported ceiling (high) so no invalid level is ever passed.
      effort_hint: "max",
      max_turns: 12,
    });
    expect(claudeArgsForSpec(spec)).toEqual([
      "-p",
      "review",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "opus",
      "--effort",
      "high",
      "--max-turns",
      "12",
      "--allowedTools",
      "Read,Glob,Grep,LS,WebSearch,WebFetch",
      "--disallowedTools",
      "Write,Edit,MultiEdit,NotebookEdit",
    ]);
  });

  it("maps web policy off to comma-form disallowed tools and merges user deny lists", () => {
    const spec = HarnessRunSpec.parse({
      session_id: "ses-test",
      intent: "implement",
      prompt: "do it",
      cwd: "/tmp",
      access: "workspace_write",
      external_context_policy: "off",
      tool_permission_policy: { web: "off", allow: [], deny: ["Bash(rm:*)"] },
    });
    const args = claudeArgsForSpec(spec);
    const denyIdx = args.indexOf("--disallowedTools");
    expect(denyIdx).toBeGreaterThan(-1);
    const denyValue = args[denyIdx + 1] ?? "";
    expect(denyValue).toContain("WebSearch");
    expect(denyValue).toContain("WebFetch");
    expect(denyValue).toContain("Bash(rm:*)");
    expect(args).not.toContain("--allowedTools");
  });

  it("translates a headless ExitPlanMode error result to a benign thinking event", () => {
    const parse = createClaudeParser();
    parse(
      { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_p", name: "ExitPlanMode", input: { plan: "The plan." } }] } },
      "s1",
    );
    const out = parse(
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_p", is_error: true, content: "needs approval" }] } },
      "s1",
    ) as HarnessEvent[];
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe("thinking");
    expect(out[0]?.text).toContain("plan mode ended");
  });

  it("translates a declined AskUserQuestion error result to a benign thinking event (never a blocking tool error)", () => {
    const parse = createClaudeParser();
    parse(
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_q", name: "AskUserQuestion", input: { questions: [{ question: "Which stack?" }] } }] },
      },
      "s1",
    );
    const out = parse(
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_q", is_error: true, content: "Answer questions?" }] } },
      "s1",
    ) as HarnessEvent[];
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe("thinking");
    expect(out[0]?.text).toContain("clarifying questions declined");
    expect(out[0]?.text).toContain("Answer questions?");
    expect(() => HarnessEvent.parse(out[0])).not.toThrow();
  });

  it("builds interactive args with stream-json input, stdio permission prompts, and the prompt on stdin", () => {
    const spec = HarnessRunSpec.parse({
      session_id: "ses-test",
      intent: "plan",
      prompt: "make a plan",
      cwd: "/tmp",
      access: "readonly",
    });
    const args = claudeArgsForSpec(spec, true);
    expect(args).toContain("--input-format");
    expect(args).toContain("stream-json");
    // Live-verified switch: without it the CLI auto-denies AskUserQuestion
    // instead of raising a control_request (fixtures/protocol/control-handshake.jsonl).
    const promptToolIdx = args.indexOf("--permission-prompt-tool");
    expect(promptToolIdx).toBeGreaterThan(-1);
    expect(args[promptToolIdx + 1]).toBe("stdio");
    // The prompt must NOT travel as an argv prompt in interactive mode.
    expect(args).not.toContain("make a plan");
    // One-shot mode keeps the prompt arg and no control-channel flags.
    const oneShot = claudeArgsForSpec(spec);
    expect(oneShot).toContain("make a plan");
    expect(oneShot).not.toContain("--input-format");
    expect(oneShot).not.toContain("--permission-prompt-tool");
  });

  it("recognizes control-protocol plumbing frames without counting them as dropped", () => {
    expect(parseClaudeEvent({ type: "control_response", response: { subtype: "success", request_id: "req_claudexor_init" } }, "s1")).toEqual([]);
    expect(parseClaudeEvent({ type: "control_cancel_request" }, "s1")).toEqual([]);
  });
});
