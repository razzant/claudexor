import { ReadableStream } from "node:stream/web";
import { describe, expect, it } from "vitest";
import { ModelCallRequest, ModelCallResult, type ModelRoute } from "@claudexor/schema";
import {
  buildResponsesRequest,
  CODEX_CONTINUATION_FORMAT,
  providerProblem,
  readResponsesStream,
} from "./responses.js";

const route: ModelRoute = {
  source: "codex",
  credentialProfileId: "work",
  accountFingerprint: "account-one",
  model: "model-one",
};
const request = (changes: Record<string, unknown> = {}) =>
  ModelCallRequest.parse({
    source: "codex",
    model: "model-one",
    account: { mode: "pin", profileId: "work" },
    messages: [
      { role: "system", content: "Own SYSTEM\nBIBLE\u0000\u2028" },
      { role: "user", content: "Привет 🐍" },
    ],
    ...changes,
  });
const nativeItems = [
  {
    type: "reasoning",
    id: "rs_native",
    encrypted_content: "OPAQUE+/==",
    summary: [{ type: "summary_text", text: "думать" }],
    extra: { kept: true },
  },
  {
    type: "message",
    id: "msg_native",
    role: "assistant",
    phase: "commentary",
    content: [{ type: "output_text", text: "готово 🐍" }],
  },
  {
    type: "function_call",
    id: "fc_native",
    call_id: "call_original",
    name: "inspect",
    arguments: '{ "path": "a" }',
    encrypted_function_args: ["opaque-args"],
  },
];
const frame = (value: unknown, newline = "\n") =>
  `data: ${JSON.stringify(value)}${newline}${newline}`;
function stream(value: string, chunkSize = 5): Response {
  const bytes = new TextEncoder().encode(value);
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
        offset += chunkSize;
      },
    }),
  );
}

describe("Codex model request translation", () => {
  it("maps large caller system text to native developer input without flattening blocks", () => {
    const blocks = ["SYSTEM\n\u0000🐍\u2028", "reference ".repeat(120_000), "\nEND"];
    const body = buildResponsesRequest(
      request({
        messages: [
          { role: "system", content: blocks.map((text) => ({ type: "text", text })) },
          { role: "developer", content: "Later guidance" },
          { role: "user", content: "Question" },
        ],
      }),
      route,
    );
    expect(body.instructions).toBe("");
    expect(body.input).toEqual([
      {
        type: "message",
        role: "developer",
        content: blocks.map((text) => ({ type: "input_text", text })),
      },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "Later guidance" }],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Question" }] },
    ]);
  });
  it("uses own instructions and preserves developer/system order and literal content", () => {
    const value = request({
      messages: [
        { role: "system", content: "SYSTEM\n\u0000raw" },
        { role: "developer", content: "higher guidance" },
        { role: "user", content: "user" },
        { role: "system", content: "late system" },
      ],
    });
    const body = buildResponsesRequest(value, route);
    expect(body.instructions).toBe("");
    expect(body.input).toEqual([
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "SYSTEM\n\u0000raw" }],
      },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "higher guidance" }],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "user" }] },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "late system" }],
      },
    ]);
    expect(body).toMatchObject({
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
    });
  });
  it.each(["auto", "none", "required", { type: "function", function: { name: "inspect" } }])(
    "preserves tool choice %j and schemas",
    (toolChoice) => {
      const parameters = { type: "object", properties: { any: {}, number: { type: "number" } } };
      const body = buildResponsesRequest(
        request({
          toolChoice,
          tools: [{ type: "function", function: { name: "inspect", parameters } }],
          options: {
            parallelToolCalls: false,
            reasoningEffort: "ultra",
            serviceTier: "priority",
            cacheKey: "conversation-one",
          },
        }),
        route,
      );
      expect(body.tools).toEqual([
        { type: "function", name: "inspect", parameters, strict: false },
      ]);
      expect(body.tool_choice).toEqual(
        typeof toolChoice === "string" ? toolChoice : { type: "function", name: "inspect" },
      );
      expect(body).toMatchObject({
        parallel_tool_calls: false,
        reasoning: { effort: "ultra" },
        service_tier: "priority",
        prompt_cache_key: "conversation-one",
      });
    },
  );
  it("keeps image URL/detail and tool-result call IDs", () => {
    const callerToolText = ["sk", "test-example-is-content"].join("-") + "\n";
    const body = buildResponsesRequest(
      request({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "a" },
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,AA==", detail: "original" },
              },
            ],
          },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: "read", arguments: "{  }" } },
              { id: "c2", type: "function", function: { name: "look", arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "c1", content: callerToolText },
          {
            role: "tool",
            tool_call_id: "c2",
            content: [
              {
                type: "image_url",
                image_url: { url: "https://example.test/image", detail: "high" },
              },
            ],
          },
        ],
      }),
      route,
    );
    expect(body.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "a" },
          { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "original" },
        ],
      },
      { type: "function_call", call_id: "c1", name: "read", arguments: "{  }" },
      { type: "function_call", call_id: "c2", name: "look", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: callerToolText },
      {
        type: "function_call_output",
        call_id: "c2",
        output: [{ type: "input_image", image_url: "https://example.test/image", detail: "high" }],
      },
    ]);
  });
  it("replays a complete native assistant turn instead of duplicating reconstructed tools", () => {
    const body = buildResponsesRequest(
      request({
        messages: [
          {
            role: "assistant",
            content: "not duplicated",
            tool_calls: [
              {
                id: "not_duplicated",
                type: "function",
                function: { name: "inspect", arguments: "{}" },
              },
            ],
            nativeContinuation: { format: CODEX_CONTINUATION_FORMAT, route, payload: nativeItems },
          },
          { role: "tool", tool_call_id: "call_original", content: "result" },
        ],
      }),
      route,
    );
    expect(body.input).toEqual([
      ...nativeItems,
      { type: "function_call_output", call_id: "call_original", output: "result" },
    ]);
  });
  it.each([
    { ...route, accountFingerprint: "different" },
    { ...route, accountFingerprint: null },
    { ...route, model: "different" },
    { ...route, credentialProfileId: "different" },
    { ...route, source: "other" },
  ])("refuses continuation across binding %j", (other) => {
    expect(() =>
      buildResponsesRequest(
        request({
          messages: [
            {
              role: "assistant",
              content: null,
              nativeContinuation: {
                format: CODEX_CONTINUATION_FORMAT,
                route: other,
                payload: nativeItems,
              },
            },
          ],
        }),
        route,
      ),
    ).toThrow("exact account");
  });
  it.each([{ maxOutputTokens: 1 }, { temperature: 0 }])(
    "refuses unsupported options %j",
    (options) => {
      expect(() => buildResponsesRequest(request({ options }), route)).toThrow("does not support");
    },
  );
  it("refuses malformed images and tool outputs instead of dropping content", () => {
    expect(() =>
      buildResponsesRequest(
        request({ messages: [{ role: "tool", content: "missing ID" }] }),
        route,
      ),
    ).toThrow("tool_call_id");
    expect(() =>
      buildResponsesRequest(
        request({ messages: [{ role: "user", content: [{ type: "audio", bytes: "AA==" }] }] }),
        route,
      ),
    ).toThrow("not supported");
  });
});

describe("Codex native SSE outcomes", () => {
  it("collects done items absent from terminal output, with single-byte UTF-8 and CRLF splits", async () => {
    const raw =
      nativeItems
        .map((item, output_index) =>
          frame({ type: "response.output_item.done", output_index, item }, "\r\n"),
        )
        .join("") +
      frame(
        {
          type: "response.completed",
          response: {
            model: "served-model",
            output: [],
            reasoning: { effort: "high" },
            service_tier: "standard",
            usage: {
              input_tokens: 100,
              output_tokens: 12,
              input_tokens_details: { cached_tokens: 90 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        },
        "\r\n",
      );
    const result = await readResponsesStream(stream(raw, 1), route);
    expect(ModelCallResult.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      outcome: "completed",
      route: { model: "served-model" },
      message: {
        content: "готово 🐍",
        tool_calls: [{ id: "call_original", function: { arguments: '{ "path": "a" }' } }],
        nativeContinuation: { payload: nativeItems },
      },
      usage: {
        input_tokens: 100,
        output_tokens: 12,
        cached_input_tokens: 90,
        reasoning_tokens: 0,
        cache_write_tokens: null,
      },
      appliedOptions: { reasoningEffort: "high", serviceTier: "standard" },
      cost: { knowledge: "unknown", cashUsd: null, valuationUsd: null },
    });
  });
  it("uses terminal items without requiring prior done events and preserves absent telemetry", async () => {
    const result = await readResponsesStream(
      stream(frame({ type: "response.completed", response: { output: nativeItems } })),
      route,
    );
    expect(result.route.model).toBeNull();
    expect(Object.values(result.usage)).toEqual([null, null, null, null, null]);
    expect(result.appliedOptions).toEqual({});
    expect(result.message?.nativeContinuation?.payload).toEqual(nativeItems);
  });
  it.each(["response.incomplete", "response.failed"])(
    "distinguishes %s from success",
    async (type) => {
      const result = await readResponsesStream(
        stream(
          frame({
            type,
            response: {
              model: "model-one",
              output: [],
              incomplete_details: { reason: "max_output_tokens" },
              error: { code: "server_error" },
              usage: { input_tokens: 8 },
            },
          }),
        ),
        route,
      );
      expect(result.outcome).toBe(type === "response.incomplete" ? "incomplete" : "failed");
      expect(result.usage.input_tokens).toBe(8);
      expect(result.problem?.code).toBe(
        type === "response.incomplete" ? "provider_incomplete" : "provider_failed",
      );
    },
  );
  it.each([
    frame({ type: "response.output_item.done", output_index: 0, item: nativeItems[2] }),
    'data: {"type": "response.completed"',
    "data: [DONE]\n\n",
    "data: invalid json\n\n",
  ])("never treats EOF or malformed streams as final", async (raw) => {
    const result = await readResponsesStream(stream(raw), route);
    expect(result.outcome).toBe("unknown");
    expect(result.message).toBeNull();
    expect(result.problem?.code).toBe("transport_unknown");
  });
  it("supports multiline SSE data and ignores comments", async () => {
    const result = await readResponsesStream(
      stream(
        ': keepalive\ndata: {"type":"response.completed",\ndata: "response":{"model":"model-one","output":[]}}\n\n',
      ),
      route,
    );
    expect(result.outcome).toBe("completed");
  });
  it("does not expose half-built or nameless tool calls", async () => {
    const result = await readResponsesStream(
      stream(
        frame({
          type: "response.completed",
          response: {
            model: "model-one",
            output: [{ type: "function_call", name: "read", arguments: "{" }],
          },
        }),
      ),
      route,
    );
    expect(result.outcome).toBe("unknown");
    expect(result.message).toBeNull();
  });
  it("rejects a contradictory terminal status and malformed UTF-8", async () => {
    const contradictory = await readResponsesStream(
      stream(frame({ type: "response.completed", response: { status: "failed", output: [] } })),
      route,
    );
    const invalidUtf8 = await readResponsesStream(
      new Response(new Uint8Array([0xc3, 0x28])),
      route,
    );
    expect(contradictory.outcome).toBe("unknown");
    expect(invalidUtf8.outcome).toBe("unknown");
  });
  it("preserves typed quota reported inside a terminal failed stream", async () => {
    const result = await readResponsesStream(
      stream(
        frame({
          type: "response.failed",
          response: { error: { code: "usage_limit_reached", resets_at: 1900000000 } },
        }),
      ),
      route,
    );
    expect(result).toMatchObject({
      outcome: "failed",
      problem: {
        code: "subscription_window_exhausted",
        context: { resetsAt: new Date(1900000000000).toISOString() },
      },
    });
    expect(result.problem?.context).not.toHaveProperty("httpStatus");
  });
  it("classifies typed quota separately from generic 429 and 403", () => {
    expect(
      providerProblem(
        429,
        { error: { code: "usage_limit_reached", resets_at: 1900000000 } },
        new Headers({ "retry-after": "12", "x-request-id": "req1" }),
      ),
    ).toMatchObject({
      code: "subscription_window_exhausted",
      context: {
        resetsAt: new Date(1900000000000).toISOString(),
        retryAfterMs: 12000,
        requestId: "req1",
      },
    });
    expect(providerProblem(429, { error: { type: "rate_limit_error" } }).code).toBe("rate_limited");
    expect(providerProblem(403, {}).code).toBe("provider_refused");
    expect(providerProblem(401, {}).code).toBe("auth_required");
  });
});
