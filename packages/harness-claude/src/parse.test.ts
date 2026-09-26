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

  it("fails closed when a required injected MCP server is missing from init", () => {
    const parse = createClaudeParser({ requiredMcpServers: ["claudexor"] });
    const out = parse(
      { type: "system", subtype: "init", model: "claude-opus", mcp_servers: [] },
      "s-required",
    );
    expect(out?.[0]?.payload?.["mcp_servers"]).toEqual([{ name: "claudexor", status: "failed" }]);
    expect(out?.[1]).toMatchObject({
      type: "error",
      payload: { code: "required_mcp_startup_failed" },
    });
  });

  it.each(["connected", "ready", "ok"])(
    "preserves %s required MCP startup evidence from Claude init",
    (status) => {
      const parse = createClaudeParser({ requiredMcpServers: ["claudexor"] });
      const out = parse(
        {
          type: "system",
          subtype: "init",
          mcp_servers: [{ name: "claudexor", status }],
        },
        "s-required",
      );
      expect(out?.[0]?.payload?.["mcp_servers"]).toEqual([{ name: "claudexor", status }]);
      expect(out).toHaveLength(1);
    },
  );

  it.each(["pending", "connecting", "starting"])(
    "does not turn an asynchronous required MCP %s status into a false startup failure",
    (status) => {
      const parse = createClaudeParser({ requiredMcpServers: ["claudexor"] });
      const out = parse(
        {
          type: "system",
          subtype: "init",
          mcp_servers: [{ name: "claudexor", status }],
        },
        "s-required",
      );
      expect(out).toHaveLength(1);
      expect(out?.[0]?.payload?.["mcp_servers"]).toEqual([{ name: "claudexor", status }]);
      expect(out?.some((event) => event.type === "error")).toBe(false);
    },
  );

  it.each(["failed", "error", "disconnected", "disabled"])(
    "stops on a required MCP server with terminal or unknown status %s",
    (status) => {
      const parse = createClaudeParser({ requiredMcpServers: ["claudexor"] });
      const out = parse(
        {
          type: "system",
          subtype: "init",
          mcp_servers: [{ name: "claudexor", status }],
        },
        "s-required",
      );
      expect(out?.[0]?.payload?.["mcp_servers"]).toEqual([{ name: "claudexor", status: "failed" }]);
      expect(out?.filter((event) => event.type === "error")).toHaveLength(1);
      expect(out?.[1]?.payload?.["code"]).toBe("required_mcp_startup_failed");
    },
  );

  it("fails closed on a required MCP server with a malformed status", () => {
    const parse = createClaudeParser({ requiredMcpServers: ["claudexor"] });
    const out = parse(
      {
        type: "system",
        subtype: "init",
        mcp_servers: [{ name: "claudexor", status: 42 }],
      },
      "s-required",
    );
    expect(out?.[0]?.payload?.["mcp_servers"]).toEqual([{ name: "claudexor", status: "failed" }]);
    expect(out?.[1]?.payload?.["code"]).toBe("required_mcp_startup_failed");
  });

  it("keeps pending provisional but still fails a later explicit status", () => {
    const parse = createClaudeParser({ requiredMcpServers: ["claudexor"] });
    const pending = parse(
      {
        type: "system",
        subtype: "init",
        mcp_servers: [{ name: "claudexor", status: "pending" }],
      },
      "s-required",
    );
    const failed = parse(
      {
        type: "system",
        subtype: "init",
        mcp_servers: [{ name: "claudexor", status: "error" }],
      },
      "s-required",
    );
    expect(pending).toHaveLength(1);
    expect(failed?.[1]?.payload?.["code"]).toBe("required_mcp_startup_failed");
  });

  it("does not synthesize a fatal for an optional failed MCP server", () => {
    const parse = createClaudeParser();
    const out = parse(
      {
        type: "system",
        subtype: "init",
        mcp_servers: [{ name: "optional_docs", status: "failed" }],
      },
      "s-optional",
    );
    expect(out).toHaveLength(1);
    expect(out?.[0]?.payload?.["mcp_servers"]).toEqual([
      { name: "optional_docs", status: "failed" },
    ]);
  });

  it("returns null for unrecognized shapes so the run loop can count drops", () => {
    expect(parseClaudeEvent({ type: "totally_new_event" }, "s1")).toBeNull();
    expect(parseClaudeEvent({ type: "system", subtype: "compact" }, "s1")).toEqual([]);
  });

  it("maps api_retry to a TYPED status event (never a thinking block) with rate_limit/transient signals", () => {
    const out = parseClaudeEvent(
      {
        type: "system",
        subtype: "api_retry",
        error: "overloaded",
        attempt: 2,
        max_retries: 10,
        retry_delay_ms: 2500,
      },
      "s1",
    )?.[0];
    // A native retry is transient STATUS for the activity feed — mapping it
    // to `thinking` used to plant "api_retry: 529…" junk in the chat's
    // reasoning disclosure (F2.5 W-C2).
    expect(out?.type).toBe("status");
    expect(out?.status?.kind).toBe("api_retry");
    expect(out?.status?.attempt).toBe(2);
    expect(out?.status?.max_retries).toBe(10);
    expect(out?.status?.retry_delay_ms).toBe(2500);
    // error_category is the DOCUMENTED enum, never free-form prose (sol #7).
    expect(out?.status?.error_category).toBe("overloaded");
    expect(out?.rate_limit?.retry_delay_ms).toBe(2500);
    expect(out?.transient?.kind).toBe("service_unavailable");
    expect(out?.transient?.retry_delay_ms).toBe(2500);
    expect(() => HarnessEvent.parse(out)).not.toThrow();
  });

  it("normalizes fractional retry delays upward and rejects malformed retry counters", () => {
    const out = parseClaudeEvent(
      {
        type: "system",
        subtype: "api_retry",
        error: "overloaded",
        attempt: 1.5,
        max_retries: Number.POSITIVE_INFINITY,
        retry_delay_ms: 572.5484158884485,
      },
      "s-fractional-retry",
    )?.[0];
    expect(out?.status).toMatchObject({ kind: "api_retry", retry_delay_ms: 573 });
    expect(out?.status?.attempt).toBeUndefined();
    expect(out?.status?.max_retries).toBeUndefined();
    expect(out?.rate_limit?.retry_delay_ms).toBe(573);
    expect(out?.transient?.retry_delay_ms).toBe(573);
    expect(() => HarnessEvent.parse(out)).not.toThrow();
  });

  it("collapses an unrecognized api_retry error to the 'unknown' category (sol #7)", () => {
    const out = parseClaudeEvent(
      { type: "system", subtype: "api_retry", error: "SOME-NEW-VENDOR-STRING sk-secret" },
      "s1",
    )?.[0];
    expect(out?.status?.error_category).toBe("unknown");
    // The prose is redacted AND bounded, never the raw field.
    expect(out?.text?.length ?? 0).toBeLessThanOrEqual(520);
  });

  it("a FAILED result is never a typed final — its prose rides a status event, not a message (sol #1 + A3)", () => {
    const failed = parseClaudeEvent(
      { type: "result", subtype: "error_during_execution", result: "partial output" },
      "s1",
    ) as HarnessEvent[];
    // A3 deliverable hygiene: no message at all — the answer assembly must
    // never adopt a failed result's prose as answer material.
    expect(failed.some((e) => e.type === "message")).toBe(false);
    const status = failed.find((e) => e.payload?.["non_success_result"] === true);
    expect(status?.type).toBe("status");
    expect(status?.text).toBe("partial output");
    expect(failed.some((e) => e.type === "error")).toBe(true);
  });

  it("suppresses a COMPLETE subagent assistant frame's text and thinking (sol #8)", () => {
    const out = parseClaudeEvent(
      {
        type: "assistant",
        parent_tool_use_id: "tu_sub",
        message: {
          content: [
            { type: "text", text: "subagent narration" },
            { type: "thinking", thinking: "subagent reasoning" },
            { type: "tool_use", id: "tu_e", name: "Edit", input: { file_path: "src/a.ts" } },
          ],
        },
      },
      "s1",
    ) as HarnessEvent[];
    // Its text/thinking never enter narration; its file edit is still real.
    expect(out.some((e) => e.type === "message")).toBe(false);
    expect(out.some((e) => e.type === "thinking")).toBe(false);
    expect(out.some((e) => e.type === "file_change")).toBe(true);
  });

  it("maps stream_event text deltas to delta messages and skips other frames (W-C4)", () => {
    const delta = parseClaudeEvent(
      {
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "chu" } },
      },
      "s1",
    );
    expect(delta?.[0]?.type).toBe("message");
    expect(delta?.[0]?.text).toBe("chu");
    expect(delta?.[0]?.payload?.["delta"]).toBe(true);
    expect(() => HarnessEvent.parse(delta?.[0])).not.toThrow();

    // Subagent frames and non-text frames are recognized plumbing, never text.
    expect(
      parseClaudeEvent(
        {
          type: "stream_event",
          parent_tool_use_id: "tu_1",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "sub" } },
        },
        "s1",
      ),
    ).toEqual([]);
    expect(
      parseClaudeEvent({ type: "stream_event", event: { type: "message_start" } }, "s1"),
    ).toEqual([]);
    expect(
      parseClaudeEvent(
        {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "x" } },
        },
        "s1",
      ),
    ).toEqual([]);
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
    expect(ok[0]?.usage?.input_token_usage).toEqual({
      total_tokens: 110,
      cache_read_tokens: 90,
      cache_write_tokens: 10,
    });
    expect(ok[1]?.text).toBe("[]");
    // The terminal result is claude's TYPED final answer (F2.5 W-C1).
    expect(ok[1]?.final).toBe(true);

    // error_max_turns is a BENIGN turn-control outcome (the run hit --max-turns
    // with partial work preserved), NOT a run failure -> a timeline thinking
    // event, never an error (mirrors ExitPlanMode/AskUserQuestion handling).
    const maxTurns = parseClaudeEvent(
      { type: "result", subtype: "error_max_turns", num_turns: 12 },
      "s1",
    ) as HarnessEvent[];
    expect(maxTurns.map((e) => e.type)).toEqual(["usage", "thinking"]);
    expect(maxTurns[1]?.text).toContain("max-turns");
    expect(maxTurns[1]?.payload?.["max_turns_reached"]).toBe(true);

    // Other non-success subtypes remain real errors.
    const realError = parseClaudeEvent(
      { type: "result", subtype: "error_during_execution" },
      "s1",
    ) as HarnessEvent[];
    expect(realError.map((e) => e.type)).toEqual(["usage", "error"]);
  });

  it("surfaces structured_output as the final message and treats retry exhaustion as benign (W8)", () => {
    // --json-schema runs: the typed structured_output value IS the answer —
    // pure JSON for the engine's single validator, never the prose result.
    const structured = parseClaudeEvent(
      {
        type: "result",
        subtype: "success",
        result: "Here is your answer in prose.",
        structured_output: { verdict: "ok", score: 7 },
      },
      "s1",
    ) as HarnessEvent[];
    expect(structured.map((e) => e.type)).toEqual(["usage", "message"]);
    expect(JSON.parse(structured[1]?.text ?? "")).toEqual({ verdict: "ok", score: 7 });
    expect(structured[1]?.payload?.["structured_output"]).toBe(true);
    expect(structured[1]?.final).toBe(true);

    // Exhausted structured-output retries = a CONFORMANCE failure (the engine
    // receipt reports it), never a run failure.
    const exhausted = parseClaudeEvent(
      { type: "result", subtype: "error_max_structured_output_retries" },
      "s1",
    ) as HarnessEvent[];
    expect(exhausted.map((e) => e.type)).toEqual(["usage", "thinking"]);
    expect(exhausted[1]?.payload?.["structured_output_retries_exhausted"]).toBe(true);
  });

  it("emits typed tool_result with redacted detail resolved to the originating tool", () => {
    const parse = createClaudeParser();
    parse(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Write",
              input: { file_path: "/tmp/hello.txt" },
            },
          ],
        },
      },
      "s1",
    );
    const out = parse(
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: "created /tmp/hello.txt" }],
            },
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

  it("stamps a successful WebFetch result as a verified retrieval (QA-042)", () => {
    const parse = createClaudeParser();
    parse(
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "toolu_wf", name: "WebFetch", input: { url: "https://x" } },
          ],
        },
      },
      "s1",
    );
    const out = parse(
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_wf",
              content: [{ type: "text", text: "Page content here" }],
            },
          ],
        },
      },
      "s1",
    ) as HarnessEvent[];
    expect(out[0]?.tool?.kind).toBe("web");
    expect(out[0]?.tool?.status).toBe("ok");
    // Claude exposes typed content -> a VERIFIED retrieval (unlike codex dispatch).
    expect(out[0]?.tool?.web_retrieval).toBe("verified");
    expect(() => HarnessEvent.parse(out[0])).not.toThrow();
  });

  it("maps Claude policy-denied tool results to denied diagnostics", () => {
    const parse = createClaudeParser({ deniedTools: ["WebSearch"] });
    parse(
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "toolu_web", name: "WebSearch", input: { query: "x" } },
          ],
        },
      },
      "s1",
    );
    const out = parse(
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_web",
              is_error: true,
              content: [{ type: "text", text: "WebSearch denied by policy" }],
            },
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

  it("preserves an MCP belt isError result as exact error evidence", () => {
    const parse = createClaudeParser();
    parse(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_belt",
              name: "mcp__claudexor__claudexor_run",
              input: { prompt: "x" },
            },
          ],
        },
      },
      "s1",
    );
    const out = parse(
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_belt",
              is_error: true,
              content: [{ type: "text", text: "delegated sub-run child-failed ended failed" }],
            },
          ],
        },
      },
      "s1",
    ) as HarnessEvent[];
    expect(out[0]?.tool).toMatchObject({
      name: "mcp__claudexor__claudexor_run",
      kind: "mcp",
      status: "error",
    });
    expect(out[0]?.tool?.error_summary).toContain("child-failed");
  });

  it("keeps Claude sibling-cancelled prose as a normal error without structured signal", () => {
    const parse = createClaudeParser();
    parse(
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "toolu_grep", name: "Grep", input: { pattern: "x" } }],
        },
      },
      "s1",
    );
    const out = parse(
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_grep",
              is_error: true,
              content: [{ type: "text", text: "Cancelled: parallel tool call Bash(...) errored" }],
            },
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
        message: {
          content: [
            { type: "tool_use", id: "toolu_web", name: "WebSearch", input: { query: "x" } },
          ],
        },
      },
      "s1",
    );
    const out = parse(
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_web",
              is_error: true,
              content: [{ type: "text", text: "WebSearch denied by policy" }],
            },
          ],
        },
      },
      "s1",
    ) as HarnessEvent[];
    expect(out[0]?.tool?.status).toBe("error");
  });

  it("forwards model/effort/max-turns hints on claude's declared ladder", () => {
    const spec = HarnessRunSpec.parse({
      session_id: "ses-test",
      intent: "review",
      prompt: "review",
      cwd: "/tmp",
      access: "readonly",
      model_hint: "opus",
      // claude --effort accepts the full low..max ladder (verified v2.1.165),
      // so `max` passes through unclamped.
      effort_hint: "max",
      max_turns: 12,
    });
    expect(claudeArgsForSpec(spec)).toEqual([
      "-p",
      "review",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "plan",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-chrome",
      "--model",
      "opus",
      "--effort",
      "max",
      "--max-turns",
      "12",
      "--tools",
      "Read,Glob,Grep,WebSearch,WebFetch,AskUserQuestion",
      "--allowedTools",
      "Read,Glob,Grep,WebSearch,WebFetch",
      "--disallowedTools",
      "Bash,Write,Edit,MultiEdit,NotebookEdit,Agent,Skill",
    ]);
  });

  it("never lets a request widen the readonly built-in tool surface", () => {
    const spec = HarnessRunSpec.parse({
      session_id: "ses-readonly-widen",
      intent: "review",
      prompt: "review",
      cwd: "/tmp",
      access: "readonly",
      external_context_policy: "off",
      tool_permission_policy: {
        web: "off",
        allow: ["Bash", "Write", "Agent", "Read"],
        deny: ["Glob"],
      },
    });
    const args = claudeArgsForSpec(spec);
    const tools = args[args.indexOf("--tools") + 1];
    const allowed = args[args.indexOf("--allowedTools") + 1];
    const denied = args[args.indexOf("--disallowedTools") + 1];
    expect(tools).toBe("Read,Grep,AskUserQuestion");
    expect(allowed).toBe("Read,Grep");
    expect(denied).toContain("Bash");
    expect(denied).toContain("Write");
    expect(denied).toContain("Agent");
    expect(denied).toContain("Glob");
  });

  it("asks for the stdin replay echo on the interactive argv only (the live-input receipt), never on a one-shot run", () => {
    const spec = HarnessRunSpec.parse({
      session_id: "ses-replay-flag",
      intent: "implement",
      prompt: "do it",
      cwd: "/tmp",
      access: "full",
    });
    const interactive = claudeArgsForSpec(spec, true);
    expect(interactive).toContain("--replay-user-messages");
    expect(interactive).toContain("--input-format");
    // One-shot runs pipe no stdin frames, so there is nothing to echo.
    const oneShot = claudeArgsForSpec(spec, false);
    expect(oneShot).not.toContain("--replay-user-messages");
    expect(oneShot).toContain("do it");
  });

  it("keeps the readonly AskUserQuestion channel open without pre-approving it", () => {
    const spec = HarnessRunSpec.parse({
      session_id: "ses-readonly-ask",
      intent: "review",
      prompt: "review",
      cwd: "/tmp",
      access: "readonly",
    });
    const args = claudeArgsForSpec(spec, true);
    const tools = (args[args.indexOf("--tools") + 1] ?? "").split(",");
    const allowed = (args[args.indexOf("--allowedTools") + 1] ?? "").split(",");
    const denied = (args[args.indexOf("--disallowedTools") + 1] ?? "").split(",");
    // In --tools so the readonly interactive run can raise questions at all…
    expect(tools).toContain("AskUserQuestion");
    // …but NOT in --allowedTools: pre-approval would suppress the
    // control_request the interaction bridge listens for.
    expect(allowed).not.toContain("AskUserQuestion");
    // The mutation surface stays denied.
    for (const tool of ["Bash", "Write", "Edit"]) expect(denied).toContain(tool);
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
    // workspace_write pre-approves bare Bash (the capability-loss fix); the
    // caller's narrower deny PATTERN rides beside it and wins by precedence.
    const allowValue = args[args.indexOf("--allowedTools") + 1] ?? "";
    expect(allowValue).toContain("Bash");
  });

  it("workspace_write pre-approves Bash; readonly and an explicit deny do not", () => {
    // Live-verified (claude 2.1.221): under acceptEdits the interaction
    // bridge denies every non-edit-shaped command (python3/pytest/curl) and
    // neither dontAsk nor auto helps — only the allowlist restores the
    // declared workspace_write capability. Claude has no FS/network sandbox,
    // so this is BROADER than codex's seatbelt: disclosed as the typed
    // write_mechanism="tool_policy" capability, never a name branch.
    const base = {
      session_id: "ses-test",
      intent: "implement" as const,
      prompt: "x",
      cwd: "/tmp",
      external_context_policy: "live" as const,
      tool_permission_policy: { web: "live" as const, allow: [], deny: [] },
    };
    const write = claudeArgsForSpec(HarnessRunSpec.parse({ ...base, access: "workspace_write" }));
    const writeAllow = (write[write.indexOf("--allowedTools") + 1] ?? "").split(",");
    expect(writeAllow).toContain("Bash");

    const readonly = claudeArgsForSpec(HarnessRunSpec.parse({ ...base, access: "readonly" }));
    const roAllow = (readonly[readonly.indexOf("--allowedTools") + 1] ?? "").split(",");
    expect(roAllow).not.toContain("Bash");
    const roDeny = (readonly[readonly.indexOf("--disallowedTools") + 1] ?? "").split(",");
    expect(roDeny).toContain("Bash");

    const denied = claudeArgsForSpec(
      HarnessRunSpec.parse({
        ...base,
        access: "workspace_write",
        tool_permission_policy: { web: "live" as const, allow: [], deny: ["Bash"] },
      }),
    );
    const deniedAllow = (denied[denied.indexOf("--allowedTools") + 1] ?? "").split(",");
    expect(deniedAllow).not.toContain("Bash");
  });

  it("Bash pre-approval never widens inherit_native or a caller-scoped shell", () => {
    const base = {
      session_id: "ses-test",
      intent: "implement" as const,
      prompt: "x",
      cwd: "/tmp",
      external_context_policy: "live" as const,
    };
    // inherit_native defers to the user's own claude settings — injecting
    // --allowedTools Bash would silently override them.
    const native = claudeArgsForSpec(
      HarnessRunSpec.parse({
        ...base,
        access: "inherit_native",
        tool_permission_policy: { web: "live" as const, allow: [], deny: [] },
      }),
    );
    const nativeAllow = native.indexOf("--allowedTools");
    expect(nativeAllow === -1 || !native[nativeAllow + 1]?.split(",").includes("Bash")).toBe(true);

    // A caller who SCOPED the shell with a Bash(...) allow pattern made an
    // explicit narrowing; bare Bash must not ride beside it.
    const scoped = claudeArgsForSpec(
      HarnessRunSpec.parse({
        ...base,
        access: "workspace_write",
        tool_permission_policy: { web: "live" as const, allow: ["Bash(git *)"], deny: [] },
      }),
    );
    const scopedAllow = (scoped[scoped.indexOf("--allowedTools") + 1] ?? "").split(",");
    expect(scopedAllow).toContain("Bash(git *)");
    expect(scopedAllow).not.toContain("Bash");
  });

  it("a caller deny of AskUserQuestion keeps it out of readonly --tools", () => {
    const spec = HarnessRunSpec.parse({
      session_id: "ses-test",
      intent: "explain",
      prompt: "x",
      cwd: "/tmp",
      access: "readonly",
      external_context_policy: "live",
      tool_permission_policy: { web: "live", allow: [], deny: ["AskUserQuestion"] },
    });
    const args = claudeArgsForSpec(spec, true);
    const tools = (args[args.indexOf("--tools") + 1] ?? "").split(",");
    expect(tools).not.toContain("AskUserQuestion");
  });

  it("translates a headless ExitPlanMode error result to a benign thinking event", () => {
    const parse = createClaudeParser();
    parse(
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "toolu_p", name: "ExitPlanMode", input: { plan: "The plan." } },
          ],
        },
      },
      "s1",
    );
    const out = parse(
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_p",
              is_error: true,
              content: "needs approval",
            },
          ],
        },
      },
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
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_q",
              name: "AskUserQuestion",
              input: { questions: [{ question: "Which stack?" }] },
            },
          ],
        },
      },
      "s1",
    );
    const out = parse(
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_q",
              is_error: true,
              content: "Answer questions?",
            },
          ],
        },
      },
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
    expect(
      parseClaudeEvent(
        {
          type: "control_response",
          response: { subtype: "success", request_id: "req_claudexor_init" },
        },
        "s1",
      ),
    ).toEqual([]);
    expect(parseClaudeEvent({ type: "control_cancel_request" }, "s1")).toEqual([]);
  });
});

describe("plan progress", () => {
  it("accumulates TaskCreate/TaskUpdate into a whole-list plan_progress (current claude surface)", () => {
    const sid = "s-task-" + Math.random();
    const call = (name: string, input: Record<string, unknown>) =>
      parseClaudeEvent(
        { type: "assistant", message: { content: [{ type: "tool_use", id: "t", name, input }] } },
        sid,
      )?.find((e) => e.type === "tool_call");
    const c1 = call("TaskCreate", {
      subject: "step one",
      description: "d",
      activeForm: "doing one",
    });
    expect(c1?.plan_progress?.items).toEqual([
      { id: "claude-1", title: "step one", status: "pending" },
    ]);
    call("TaskCreate", { subject: "step two" });
    const upd = call("TaskUpdate", { taskId: "1", status: "in_progress" });
    expect(upd?.plan_progress?.items).toEqual([
      { id: "claude-1", title: "step one", status: "in_progress" },
      { id: "claude-2", title: "step two", status: "pending" },
    ]);
    const done = call("TaskUpdate", { taskId: "1", status: "completed" });
    expect(done?.plan_progress?.items?.[0]?.status).toBe("completed");
    // RESUMED-SESSION honesty: an unknown task id CREATES the entry with the
    // CLI's own numbering (the accumulator started fresh mid-conversation).
    const resumed = call("TaskUpdate", { taskId: "99", status: "completed" });
    expect(resumed?.plan_progress?.items?.find((i) => i.id === "claude-99")?.status).toBe(
      "completed",
    );
    // A status-less update is still a no-op (nothing to record).
    const noop = call("TaskUpdate", { taskId: "1" });
    expect(noop?.plan_progress).toBeUndefined();
    const duplicate = call("TaskUpdate", { taskId: "1", status: "completed" });
    expect(duplicate?.plan_progress).toBeUndefined();
  });

  it("maps TodoWrite todos to the TYPED plan_progress field on the tool_call event", () => {
    const sid = `s-todo-${Math.random()}`;
    const raw = {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "write tests", status: "completed", activeForm: "writing tests" },
                { content: "fix bug", status: "in_progress", activeForm: "fixing bug" },
                { content: "ship", status: "pending", activeForm: "shipping" },
              ],
            },
          },
        ],
      },
    };
    const out = parseClaudeEvent(raw, sid);
    const ev = out?.find((e) => e.type === "tool_call");
    expect(ev?.plan_progress?.items).toEqual([
      { id: "claude-0", title: "write tests", status: "completed" },
      { id: "claude-1", title: "fix bug", status: "in_progress" },
      { id: "claude-2", title: "ship", status: "pending" },
    ]);
    const replay = parseClaudeEvent(raw, sid)?.find((e) => e.type === "tool_call");
    expect(replay?.plan_progress).toBeUndefined();
  });
});

describe("structured output flag", () => {
  it("claudeArgsForSpec adds inline --json-schema only when output_schema is set", async () => {
    const { claudeArgsForSpec } = await import("./index.js");
    const { HarnessRunSpec } = await import("@claudexor/schema");
    const spec = HarnessRunSpec.parse({
      session_id: "s1",
      intent: "explain",
      prompt: "plan",
      cwd: "/tmp",
      access: "readonly",
      output_schema: { type: "object", properties: { tool_calls: { type: "array" } } },
    });
    const args = claudeArgsForSpec(spec);
    const i = args.indexOf("--json-schema");
    expect(i).toBeGreaterThan(-1);
    expect(JSON.parse(args[i + 1]!)).toMatchObject({ type: "object" });
    const bare = claudeArgsForSpec(
      HarnessRunSpec.parse({
        session_id: "s2",
        intent: "explain",
        prompt: "q",
        cwd: "/tmp",
        access: "readonly",
      }),
    );
    expect(bare).not.toContain("--json-schema");
  });
});

describe("claude normalized input measurement", () => {
  function normalized(usage: Record<string, unknown>) {
    return parseClaudeEvent({ type: "result", usage }, "counters")?.find(
      (event) => event.type === "usage",
    )?.usage?.input_token_usage;
  }
  it("keeps reads and writes separate, including measured zero", () => {
    expect(
      normalized({
        input_tokens: 100,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 10,
      }),
    ).toEqual({
      total_tokens: 190,
      cache_read_tokens: 80,
      cache_write_tokens: 10,
    });
    expect(
      normalized({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ).toEqual({
      total_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
  });
  it.each([0, 1, 2])("preserves each independently missing component %s", (missing) => {
    const fields = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
    const native: Record<string, unknown> = Object.fromEntries(
      fields.map((field, index) => [field, [100, 80, 10][index]]),
    );
    delete native[fields[missing]!];
    expect(normalized(native)).toEqual({
      total_tokens: null,
      cache_read_tokens: missing === 1 ? null : 80,
      cache_write_tokens: missing === 2 ? null : 10,
    });
  });
  it.each([undefined, null, -1, 0.5, "10", Infinity, NaN])(
    "preserves unknown write rather than treating %j as zero",
    (value) => {
      expect(
        normalized({
          input_tokens: 100,
          cache_read_input_tokens: 80,
          cache_creation_input_tokens: value,
        }),
      ).toEqual({
        total_tokens: null,
        cache_read_tokens: 80,
        cache_write_tokens: null,
      });
    },
  );
});

/**
 * Native queue fold (live-input.ts): a live message that arrives during the
 * final text runs as the NEXT native turn of the same process, so one run can
 * carry two `system/init` and two `result` frames with a CUMULATIVE
 * total_cost_usd. Recorded on 2.1.283 (fixtures/stream-json/).
 */
describe("claude parser: multi-turn session folding", () => {
  const init = {
    type: "system",
    subtype: "init",
    model: "claude-sonnet-5",
    session_id: "native-1",
  };
  const resultWithCost = (total: number) => ({
    type: "result",
    subtype: "success",
    total_cost_usd: total,
    usage: { input_tokens: 10, output_tokens: 5 },
    result: "ok",
  });

  it("emits ONE started across two inits; an init after a result is a typed native_turn_started status", () => {
    const parse = createClaudeParser();
    const first = parse(init, "s1") as HarnessEvent[];
    expect(first.map((e) => e.type)).toEqual(["started"]);
    // The recorded boundary: result#1 closes the first native turn, then the
    // same process re-inits for the queued message (an init with NO result
    // before it is still a fresh start — see the required-MCP re-init pins).
    parse(resultWithCost(0.1), "s1");
    const second = parse(init, "s1") as HarnessEvent[];
    expect(second).toEqual([
      expect.objectContaining({
        type: "status",
        payload: { code: "native_turn_started", turn: 2 },
      }),
    ]);
    expect(second.some((e) => e.type === "started")).toBe(false);
    for (const ev of [...first, ...second]) expect(() => HarnessEvent.parse(ev)).not.toThrow();
  });

  it("emits the first result's cost in full and every later result's cost as the delta of the cumulative total", () => {
    const parse = createClaudeParser();
    const first = parse(resultWithCost(0.0963518), "s1") as HarnessEvent[];
    expect(first.find((e) => e.type === "usage")?.usage?.cost_usd).toBe(0.0963518);
    const second = parse(resultWithCost(0.114749), "s1") as HarnessEvent[];
    expect(second.find((e) => e.type === "usage")?.usage?.cost_usd).toBeCloseTo(0.0183972, 10);
    expect(second.some((e) => e.type === "status")).toBe(false);
    // Tokens stay per turn (never differenced).
    expect(second.find((e) => e.type === "usage")?.usage?.input_tokens).toBe(10);
    // A fresh parser (another run) starts from the full value again: the
    // cumulative memory is per parser, never shared across runs.
    const other = createClaudeParser()(resultWithCost(0.5), "s2") as HarnessEvent[];
    expect(other.find((e) => e.type === "usage")?.usage?.cost_usd).toBe(0.5);
    // A result without total_cost_usd leaves the cost unknown and the memory untouched.
    const unknown = parse({ type: "result", subtype: "success", result: "ok" }, "s1");
    expect(unknown?.find((e) => e.type === "usage")?.usage?.cost_usd).toBeUndefined();
    const third = parse(resultWithCost(0.2), "s1") as HarnessEvent[];
    expect(third.find((e) => e.type === "usage")?.usage?.cost_usd).toBeCloseTo(0.085251, 10);
  });

  it("clamps a negative delta to 0 and discloses it as a status event", () => {
    const parse = createClaudeParser();
    parse(resultWithCost(0.2), "s1");
    const out = parse(resultWithCost(0.15), "s1") as HarnessEvent[];
    expect(out.find((e) => e.type === "usage")?.usage?.cost_usd).toBe(0);
    expect(out).toContainEqual(
      expect.objectContaining({
        type: "status",
        payload: { code: "usage_cost_delta_negative", total_cost_usd: 0.15, previous: 0.2 },
      }),
    );
  });

  it("treats the --replay-user-messages echo and command_lifecycle frames as recognized plumbing (no events, never dropped)", () => {
    const parse = createClaudeParser();
    expect(
      parse(
        {
          type: "user",
          isReplay: true,
          uuid: "u-1",
          message: { role: "user", content: [{ type: "text", text: "Also say MANGO." }] },
        },
        "s1",
      ),
    ).toEqual([]);
    expect(
      parse({ type: "command_lifecycle", command_uuid: "u-1", state: "queued" }, "s1"),
    ).toEqual([]);
    // A non-replay user frame with a tool_result still parses as before.
    parse(
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "toolu_r", name: "Bash", input: { command: "echo" } }],
        },
      },
      "s1",
    );
    const out = parse(
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_r", content: "ok" }] },
      },
      "s1",
    ) as HarnessEvent[];
    expect(out.map((e) => e.type)).toEqual(["tool_result"]);
  });
});
