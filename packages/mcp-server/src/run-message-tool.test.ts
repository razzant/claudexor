import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { describe, expect, it, vi } from "vitest";
import { ControlRunMessageRequest, ControlRunMessageResponse } from "@claudexor/schema";
import requestSchemaRaw from "@claudexor/schema/generated/ControlRunMessageRequest.schema.json" with { type: "json" };
import responseSchemaRaw from "@claudexor/schema/generated/ControlRunMessageResponse.schema.json" with { type: "json" };
import { defaultClaudexorTools, serveClaudexorMcp } from "./index.js";
import { beltClaudexorTools } from "./delegation-belt.js";
import { inlineJsonSchemaRefs } from "./inline-json-schema-refs.js";
import { runMessageTool } from "./run-message-tool.js";

const input = { runId: "r1", text: "Keep the current changes", idempotencyKey: "message-1" };

describe("MCP live run message", () => {
  it("serves receipts, typed problems, and required caller keys over the real SDK wire", async () => {
    const accepted = { accepted: true, outcome: "accepted", runId: "r1", messageId: "message-1" };
    const refused = {
      ...accepted,
      accepted: false,
      outcome: "unsupported",
      reason: "thread_bound",
    };
    const runner = vi.fn(async (p) => {
      if (p.request.text === "conflict")
        throw Object.assign(new Error("Changed body"), { code: "idempotency_conflict" });
      return p.request.text === "refuse" ? refused : accepted;
    });
    const read = new PassThrough();
    const write = new PassThrough();
    const responses = new Map<number, any>();
    const lines = createInterface({ input: write });
    lines.on("line", (line) => {
      const response = JSON.parse(line);
      responses.set(response.id, response);
    });
    const server = serveClaudexorMcp({
      tools: [runMessageTool(runner)],
      transport: { read, write },
    });
    const send = (id: number, method: string, params: unknown) =>
      read.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    try {
      send(0, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      });
      await vi.waitFor(() => expect(responses.has(0)).toBe(true));
      read.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      for (const [id, text] of [
        [1, "accept"],
        [2, "refuse"],
        [3, "conflict"],
      ] as const) {
        send(id, "tools/call", { name: "claudexor_run_message", arguments: { ...input, text } });
        await vi.waitFor(() => expect(responses.has(id)).toBe(true));
      }
      expect(responses.get(1)?.result).toMatchObject({ structuredContent: accepted });
      expect(responses.get(1)?.result.isError).not.toBe(true);
      expect(responses.get(2)?.result).toMatchObject({ structuredContent: refused });
      expect(responses.get(2)?.result.isError).not.toBe(true);
      expect(responses.get(3)?.result).toMatchObject({
        isError: true,
        structuredContent: { failure: { code: "idempotency_conflict" } },
      });
      send(4, "tools/call", {
        name: "claudexor_run_message",
        arguments: { runId: "r1", text: "missing key" },
      });
      await vi.waitFor(() => expect(responses.has(4)).toBe(true));
      expect(responses.get(4)?.result.isError).toBe(true);
      expect(runner).toHaveBeenCalledTimes(3);
    } finally {
      await server.close();
      lines.close();
    }
  });

  it("registers a mutating public tool with canonical contracts, outside the belt", () => {
    const runner = vi.fn();
    const tool = defaultClaudexorTools(runner).find((t) => t.name === "claudexor_run_message");
    expect(tool).toBeDefined();
    expect(tool?.annotations?.readOnlyHint).toBe(false);
    const request = inlineJsonSchemaRefs(requestSchemaRaw);
    expect(tool?.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["runId", "text", "idempotencyKey"],
      properties: request.properties,
    });
    expect(tool?.outputSchema).toEqual(inlineJsonSchemaRefs(responseSchemaRaw));
    const belt = beltClaudexorTools(runner, {
      parentRunId: "parent",
      repoRoot: "/project",
      depth: 0,
      maxSubRuns: 8,
      parentBudget: { kind: "unlimited" },
    });
    expect(belt.some((t) => t.name === "claudexor_run_message")).toBe(false);
  });

  it.each([
    { accepted: true, outcome: "accepted", nativeTurnId: "turn-1" },
    { accepted: true, outcome: "delivered" },
    { accepted: false, outcome: "unsupported", reason: "thread_bound" },
    { accepted: false, outcome: "rejected", reason: "multi_attempt" },
    { accepted: false, outcome: "not_active", reason: "interaction_pending" },
    { accepted: false, outcome: "delivery_unknown", reason: "response_timeout" },
  ])("preserves $outcome/$reason as the receipt, without claiming delivery", async (outcome) => {
    const receipt = ControlRunMessageResponse.parse({
      ...outcome,
      runId: "r1",
      messageId: "message-1",
    });
    const runner = vi.fn().mockResolvedValue(receipt);
    const signal = new AbortController().signal;
    const result = await runMessageTool(runner).handler(
      { ...input, expectedAttemptId: "a1" },
      { signal },
    );
    expect(runner).toHaveBeenCalledExactlyOnceWith(
      {
        mode: "__run_message",
        runId: "r1",
        idempotencyKey: "message-1",
        request: { text: input.text, expectedAttemptId: "a1" },
      },
      { signal },
    );
    expect(result).toEqual({ text: JSON.stringify(receipt), structured: receipt });
  });

  it.each([
    { idempotencyKey: undefined },
    { idempotencyKey: "" },
    { idempotencyKey: "   " },
    { idempotencyKey: "x".repeat(257) },
    { runId: "" },
    { text: "" },
    { text: "😀".repeat(32769) },
    { expectedAttemptId: "" },
    { extra: true },
  ])("rejects invalid arguments before dispatch: %j", async (delta) => {
    const runner = vi.fn();
    const result = await runMessageTool(runner).handler({ ...input, ...delta }, {});
    expect(result).toMatchObject({ isError: true });
    expect(runner).not.toHaveBeenCalled();
  });

  it("preserves exact text at the canonical UTF-16 boundary", async () => {
    const text = "😀".repeat(32768);
    expect(ControlRunMessageRequest.parse({ text }).text).toBe(text);
    const runner = vi.fn().mockResolvedValue({
      accepted: true,
      outcome: "accepted",
      runId: "r1",
      messageId: "message-1",
    });
    await runMessageTool(runner).handler({ ...input, text }, {});
    expect(runner.mock.calls[0]?.[0].request.text).toBe(text);
  });

  it("preserves a typed transport problem as a tool failure", async () => {
    const runner = vi.fn().mockRejectedValue(
      Object.assign(new Error("Different body"), {
        code: "idempotency_conflict",
        retryable: false,
        requiredActions: ["Use the original body."],
      }),
    );
    expect(await runMessageTool(runner).handler(input, {})).toMatchObject({
      isError: true,
      structured: {
        failure: {
          code: "idempotency_conflict",
          retryable: false,
          requiredActions: ["Use the original body."],
        },
      },
    });
  });
});
