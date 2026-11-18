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
  it("preserves every instruction role, message order and literal content", () => {
    const value = request({
      messages: [
        { role: "system", content: "SYSTEM\n\u0000raw" },
        { role: "developer", content: "higher guidance" },
        { role: "user", content: "user" },
        { role: "system", content: "late system" },
      ],
    });
    const original = structuredClone(value);
    const body = buildResponsesRequest(value, route);
    expect(value).toEqual(original);
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
  it("keeps a full multipart system context as separate unchanged text parts", () => {
    // Production-shaped regression input, not a provider limit or model policy.
    const parts = [
      "Governance\r\n" + "a".repeat(886_352),
      "Identity 🐍\u0000" + "b".repeat(34_393),
      "History\u2028" + "c".repeat(524_690),
    ];
    const value = request({
      messages: [
        { role: "system", content: parts.map((text) => ({ type: "text", text })) },
        { role: "system", content: "Further caller instructions" },
        { role: "user", content: "Привет" },
      ],
    });
    const original = structuredClone(value);
    const body = buildResponsesRequest(value, route);
    expect(value).toEqual(original);
    expect(body.instructions).toBe("");
    expect(body.input).toEqual([
      {
        type: "message",
        role: "developer",
        content: parts.map((text) => ({ type: "input_text", text })),
      },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "Further caller instructions" }],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Привет" }] },
    ]);
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
          { role: "system", content: "system priority" },
          { role: "developer", content: "developer guidance" },
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
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "system priority" }],
      },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "developer guidance" }],
      },
      ...nativeItems,
      { type: "function_call_output", call_id: "call_original", output: "result" },
    ]);
  });
  const canonicalTurn = {
    role: "assistant",
    content: "готово 🐍",
    tool_calls: [
      { id: "call_original", type: "function", function: { name: "inspect", arguments: "{}" } },
    ],
  };
  it.each([
    { ...route, accountFingerprint: "different" },
    { ...route, accountFingerprint: null },
    { ...route, credentialProfileId: "different" },
    { ...route, source: "other" },
    { ...route, accountFingerprint: "different", model: "different" },
  ])("refuses continuation across account binding %j", (other) => {
    expect(() =>
      buildResponsesRequest(
        request({
          messages: [
            {
              ...canonicalTurn,
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
  it.each(["different", null])(
    "projects a turn served by model %j structurally instead of replaying it",
    (model) => {
      const body = buildResponsesRequest(
        request({
          messages: [
            { role: "user", content: "user" },
            {
              ...canonicalTurn,
              nativeContinuation: {
                format: CODEX_CONTINUATION_FORMAT,
                route: { ...route, model },
                payload: nativeItems,
              },
            },
            { role: "tool", tool_call_id: "call_original", content: "result" },
          ],
        }),
        route,
      );
      expect(body.input).toEqual([
        { type: "message", role: "user", content: [{ type: "input_text", text: "user" }] },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "готово 🐍" }],
        },
        { type: "function_call", call_id: "call_original", name: "inspect", arguments: "{}" },
        { type: "function_call_output", call_id: "call_original", output: "result" },
      ]);
    },
  );
  it.each([{ content: null }, { content: "" }, { content: [] }, { content: null, tool_calls: [] }])(
    "refuses a continuation-only turn served by another model %j",
    (turn) => {
      expect(() =>
        buildResponsesRequest(
          request({
            messages: [
              {
                role: "assistant",
                ...turn,
                nativeContinuation: {
                  format: CODEX_CONTINUATION_FORMAT,
                  route: { ...route, model: "different" },
                  payload: nativeItems,
                },
              },
            ],
          }),
          route,
        ),
      ).toThrow("exact account");
    },
  );
  it.each([
    { name: "role", message: { role: "user", content: "user" }, native: {} },
    { name: "format", message: canonicalTurn, native: { format: "other.v1" } },
    { name: "payload", message: canonicalTurn, native: { payload: { items: nativeItems } } },
    { name: "item type", message: canonicalTurn, native: { payload: [{ id: "untyped" }] } },
  ])(
    "refuses a malformed continuation $name even when only the model differs",
    ({ message, native }) => {
      expect(() =>
        buildResponsesRequest(
          request({
            messages: [
              {
                ...message,
                nativeContinuation: {
                  format: CODEX_CONTINUATION_FORMAT,
                  route: { ...route, model: "different" },
                  payload: nativeItems,
                  ...native,
                },
              },
            ],
          }),
          route,
        ),
      ).toThrow("exact account");
    },
  );
  it("dispatches the requested model after a round this account served with another one", async () => {
    const served = await readResponsesStream(
      stream(
        frame({
          type: "response.completed",
          response: { model: "model-two", output: nativeItems },
        }),
      ),
      route,
    );
    // The stamp stays truthful: the turn is bound to the model that produced it.
    expect(served.message?.nativeContinuation?.route).toEqual({ ...route, model: "model-two" });
    const body = buildResponsesRequest(
      request({
        messages: [
          { role: "user", content: "user" },
          served.message!,
          { role: "tool", tool_call_id: "call_original", content: "result" },
        ],
      }),
      route,
    );
    expect(body.model).toBe("model-one");
    const input = body.input as Array<Record<string, unknown>>;
    expect(input.map((item) => item.type)).toEqual([
      "message",
      "message",
      "function_call",
      "function_call_output",
    ]);
    expect(input.some((item) => "id" in item || "encrypted_content" in item)).toBe(false);
    expect(input.slice(2).map((item) => item.call_id)).toEqual(["call_original", "call_original"]);
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
  it("preserves refusal parts in order through completion and assistant replay", async () => {
    const parts = [
      { type: "output_text", text: "Menu\n" },
      { type: "refusal", refusal: "" },
      { type: "refusal", refusal: "No picnic today. 🧺" },
      { type: "output_text", text: "\nFin." },
    ];
    const output = [
      { type: "message", id: "menu", role: "assistant", content: parts.slice(0, 2) },
      { type: "message", id: "note", role: "assistant", content: parts.slice(2) },
      nativeItems[2]!,
    ];
    const usage = {
      input_tokens: 9,
      output_tokens: 4,
      output_tokens_details: { reasoning_tokens: 0 },
    };
    const wire = frame({
      type: "response.completed",
      response: { model: route.model, output, usage },
    });
    const read = (typedRefusals?: boolean) =>
      readResponsesStream(stream(wire, 1), route, true, { typedRefusals });
    expect((await read()).message?.content).toBe("Menu\nNo picnic today. 🧺\nFin.");
    expect((await read(false)).message?.content).toBe("Menu\nNo picnic today. 🧺\nFin.");
    const result = await read(true);
    expect(result).toMatchObject({
      outcome: "completed",
      problem: null,
      usage: { input_tokens: 9, output_tokens: 4, reasoning_tokens: 0 },
    });
    expect(result).not.toHaveProperty("failureEvidence");
    const message = result.message!;
    expect(message.content).toEqual([
      { type: "text", text: "Menu\n" },
      { type: "refusal", refusal: "" },
      { type: "refusal", refusal: "No picnic today. 🧺" },
      { type: "text", text: "\nFin." },
    ]);
    expect(message.tool_calls).toEqual([
      {
        id: "call_original",
        type: "function",
        function: { name: "inspect", arguments: '{ "path": "a" }' },
      },
    ]);
    const history = request({ messages: [message] });
    expect(buildResponsesRequest(history, route).input).toEqual(output);
    const canonical = [
      { type: "message", role: "assistant", content: parts },
      {
        type: "function_call",
        call_id: "call_original",
        name: "inspect",
        arguments: '{ "path": "a" }',
      },
    ];
    expect(buildResponsesRequest(history, { ...route, model: "other" }).input).toEqual(canonical);
    const { nativeContinuation, ...withoutNative } = message;
    expect(nativeContinuation).toEqual({
      format: CODEX_CONTINUATION_FORMAT,
      payload: output,
      route,
    });
    const projected = buildResponsesRequest(request({ messages: [withoutNative] }), route);
    expect(projected.input).toEqual(canonical);
    expect(() =>
      buildResponsesRequest(history, { ...route, credentialProfileId: "other" }),
    ).toThrow("exact account");
  });

  it("keeps ordinary text as a string with typed refusals enabled", async () => {
    const content = [{ type: "output_text", text: "A sentence mentioning cyber_policy." }];
    const output = [{ type: "message", role: "assistant", content }];
    const result = await readResponsesStream(
      stream(frame({ type: "response.completed", response: { output } })),
      route,
      false,
      { typedRefusals: true },
    );
    expect(result.message?.content).toBe(content[0]!.text);
    expect(result.problem).toBeNull();
  });

  it.each([
    [{ code: "cyber_policy", message: "Fixture words." }, "provider_content_refused"],
    [{ code: "server_overloaded", message: "cyber_policy" }, "provider_failed"],
    [{ message: "cyber_policy" }, "provider_failed"],
  ] as const)("uses only the failed response's structured code", async (error, code) => {
    const response = { status: "failed", error };
    const result = await readResponsesStream(
      stream(frame({ type: "response.failed", response })),
      route,
      false,
      { typedRefusals: true },
    );
    expect(result).toMatchObject({ outcome: "failed", route: { model: null }, problem: { code } });
    if (!("code" in error)) expect(result.problem?.context).not.toHaveProperty("vendorCode");
    expect(result.problem?.message).not.toContain(error.message);
  });

  it.each(["user", "developer", "system", "tool"])("rejects refusal in the %s role", (role) => {
    const message = {
      role,
      content: [{ type: "refusal", refusal: "Not today." }],
      tool_call_id: "original",
    };
    expect(() => buildResponsesRequest(request({ messages: [message] }), route)).toThrow(
      "assistant content",
    );
  });

  it.each(["The fixture packed lilac napkins.", "notes/picnic.txt", "lilac_napkins"])(
    "keeps unrecognized diagnostic values only in private response bytes (%s)",
    async (value) => {
      const error = { code: value, type: "cyber_policy", param: value, message: value };
      const wire = frame({ type: "response.failed", response: { error } });
      const result = await readResponsesStream(
        new Response(wire, { headers: { "x-request-id": value } }),
        route,
        true,
        { typedRefusals: true },
      );
      const { failureEvidence, ...visible } = result;
      expect(visible.problem).toMatchObject({
        code: "provider_failed",
        context: { parameter: "[redacted]" },
      });
      expect(visible.problem?.context).not.toHaveProperty("vendorCode");
      expect(visible.problem?.context).not.toHaveProperty("requestId");
      expect(JSON.stringify(visible)).not.toContain(value);
      expect(failureEvidence?.bodyBase64).toBe(Buffer.from(wire).toString("base64"));
    },
  );

  it("preserves request error codes, known field paths, and an absent parameter", () => {
    const error = { code: "string_above_max_length" };
    for (const param of ["input", "input[12].content[3].text"]) {
      expect(providerProblem(400, { error: { ...error, param } }).context).toEqual({
        httpStatus: 400,
        vendorCode: error.code,
        parameter: param,
      });
    }
    expect(providerProblem(400, { error }).context).not.toHaveProperty("parameter");
    const unknownField = providerProblem(400, { error: { ...error, param: "input[12].picnic" } });
    expect(unknownField.context.parameter).toBe("[redacted]");
    const lengthError = providerProblem(400, { error: { code: "context_length_exceeded" } });
    expect(lengthError.context.vendorCode).toBe("context_length_exceeded");
  });

  it.each(["tool_choice.type", "input[3].output[1].image_url", "input[4].summary[0].text"])(
    "names the field %s that the builder writes or replays",
    (param) => {
      const problem = providerProblem(400, { error: { code: "invalid_value", param } });
      expect(problem.context.parameter).toBe(param);
    },
  );

  it("names the vendor's own rejection of a replayed reasoning item", () => {
    const error = { code: "invalid_encrypted_content", param: "input[4].encrypted_content" };
    expect(providerProblem(400, { error }).context).toEqual({
      httpStatus: 400,
      vendorCode: error.code,
      parameter: error.param,
    });
  });

  it("maps only the HTTP backend's own usage code; the CLI's spelling stays generic", () => {
    expect(providerProblem(429, { error: { type: "usage_limit_reached" } })).toMatchObject({
      code: "subscription_window_exhausted",
      context: { vendorCode: "usage_limit_reached" },
    });
    const cliSpelling = providerProblem(429, { error: { code: "usage_limit_exceeded" } });
    expect(cliSpelling).toMatchObject({ code: "rate_limited", retryable: true });
    expect(cliSpelling.context).not.toHaveProperty("vendorCode");
  });

  it("keeps incomplete and missing terminals distinct when they carry an error code", async () => {
    const response = {
      error: { code: "cyber_policy" },
      output: [],
      incomplete_details: { reason: "max_output_tokens" },
    };
    const read = (type: string) =>
      readResponsesStream(stream(frame({ type, response })), route, false, { typedRefusals: true });
    expect(await read("response.incomplete")).toMatchObject({
      outcome: "incomplete",
      problem: { code: "provider_incomplete" },
    });
    expect(await read("response.in_progress")).toMatchObject({
      outcome: "unknown",
      problem: { code: "transport_unknown" },
    });
  });

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
    expect(result.outcome).toBe("completed");
    expect(result.message).toBeNull();
    expect(result.problem?.code).toBe("response_rejected");
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
    const requestId = "req_00000000000000000000000000000002";
    expect(
      providerProblem(
        429,
        { error: { code: "usage_limit_reached", resets_at: 1900000000 } },
        new Headers({ "retry-after": "12", "x-request-id": requestId }),
      ),
    ).toMatchObject({
      code: "subscription_window_exhausted",
      context: {
        resetsAt: new Date(1900000000000).toISOString(),
        retryAfterMs: 12000,
        requestId,
      },
    });
    expect(providerProblem(429, { error: { type: "rate_limit_error" } }).code).toBe("rate_limited");
    expect(providerProblem(403, {}).code).toBe("provider_refused");
    expect(providerProblem(401, {}).code).toBe("auth_required");
  });
});
