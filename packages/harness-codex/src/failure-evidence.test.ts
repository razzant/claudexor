import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CredentialProfile, ModelCallRequest, ModelCallResult } from "@claudexor/schema";
import { createCodexModelAdapter } from "./model.js";
import { emptyModelResult, readResponsesStream } from "./responses.js";
import { ResponseFailureCapture } from "./failure-evidence.js";
import { requestBodyText } from "./test-support/request-body.js";

const route = {
  source: "codex",
  credentialProfileId: "fixture",
  accountFingerprint: null,
  model: "one",
};
const frame = (type: string, output: unknown = [], extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({
    type: `response.${type}`,
    response: {
      status: type,
      model: "one",
      usage: { input_tokens: 13, output_tokens: 8 },
      output,
      ...extra,
    },
  })}\n\n`;
function brokenReader(bytes: Uint8Array, error: unknown, status = 200): Response {
  let sent = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(bytes);
        } else controller.error(error);
      },
    }),
    { status, headers: { "x-request-id": "wire-request" } },
  );
}
const socketError = () =>
  Object.assign(new TypeError("private outer diagnostic"), {
    cause: Object.assign(new Error("private socket diagnostic"), { code: "UND_ERR_SOCKET" }),
  });

describe("exact failed Responses evidence", () => {
  it("records first-byte, final silence and largest inter-chunk gaps", () => {
    let now = 1000;
    const capture = new ResponseFailureCapture(false, () => now);
    capture.response(new Response(null));
    now += 20;
    capture.receive(new Uint8Array([1]));
    now += 80;
    capture.receive(new Uint8Array([2]));
    now += 120;
    const result = emptyModelResult(route);
    result.outcome = "unknown";
    result.problem = {
      code: "transport_unknown",
      message: "interrupted",
      context: {},
      retryable: false,
      fieldErrors: {},
      requiredActions: [],
      evidenceRefs: [],
    };
    capture.finish(result);
    expect(result.problem?.context).toMatchObject({
      timeToFirstChunkMs: 20,
      lastChunkAfterResponseMs: 100,
      silenceMs: 120,
      largestSilenceMs: 120,
    });
  });

  it("ignores a zero-length chunk before recording timing", () => {
    let now = 1000;
    const capture = new ResponseFailureCapture(false, () => now);
    capture.response(new Response(null));
    now += 20;
    capture.receive(new Uint8Array());
    const result = emptyModelResult(route);
    result.outcome = "unknown";
    result.problem = {
      code: "transport_unknown",
      message: "empty",
      context: {},
      retryable: false,
      fieldErrors: {},
      requiredActions: [],
      evidenceRefs: [],
    };
    capture.finish(result);
    expect(result.problem?.context).not.toHaveProperty("timeToFirstChunkMs");
    expect(result.problem?.context).not.toHaveProperty("silenceMs");
    expect(result.problem?.context).not.toHaveProperty("largestSilenceMs");
    expect(result.problem?.context).not.toHaveProperty("lastChunkAfterResponseMs");
    expect(result.problem?.context).not.toHaveProperty("lastEventAfterResponseMs");
    expect(result.problem?.context).not.toHaveProperty("eventSilenceMs");
  });

  it.each([": heartbeat\n\n", 'data: {"type":"response.output_text.delta"'])(
    "keeps event silence independent of a later non-event chunk: %s",
    async (tail) => {
      let now = 1000;
      const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
      const reader = {
        read: vi
          .fn()
          .mockImplementationOnce(async () => {
            now = 1020;
            return { done: false, value: Buffer.from('data: {"type":"response.created"}\n\n') };
          })
          .mockImplementationOnce(async () => {
            now = 1100;
            return { done: false, value: Buffer.from(tail) };
          })
          .mockImplementationOnce(async () => {
            now = 1120;
            throw Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" });
          }),
        cancel: vi.fn().mockResolvedValue(undefined),
        releaseLock: vi.fn(),
      };
      const response = new Response(null);
      Object.defineProperty(response, "body", { value: { getReader: () => reader } });
      try {
        const result = await readResponsesStream(response, route, true);
        expect(result.outcome).toBe("unknown");
        expect(result.problem).toMatchObject({
          code: "transport_unknown",
          context: {
            eventCount: 1,
            lastEventType: "response.created",
            errorCode: "ETIMEDOUT",
            timeToFirstChunkMs: 20,
            lastChunkAfterResponseMs: 100,
            silenceMs: 20,
            lastEventAfterResponseMs: 20,
            eventSilenceMs: 100,
          },
        });
        expect(result.failureEvidence?.bodyComplete).toBe(false);
        expect(reader.read).toHaveBeenCalledTimes(3);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it("retains the received prefix when the final UTF-8 decoder flush fails", async () => {
    const bytes = Buffer.from([195]);
    const result = await readResponsesStream(new Response(bytes), route, true);
    expect(result).toMatchObject({
      outcome: "unknown",
      failureEvidence: {
        stage: "decode",
        receivedBytes: 1,
        bodyComplete: true,
        errors: [{ code: "ERR_ENCODING_INVALID_ENCODED_DATA" }],
      },
    });
    expect(Buffer.from(result.failureEvidence!.bodyBase64, "base64").equals(bytes)).toBe(true);
  });

  it.each([
    ["created", 'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n'],
    ["reasoning", 'data: {"type":"response.reasoning_summary_text.delta","delta":"x"}\n\n'],
    ["mid-delta", 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n'],
  ] as const)(
    "classifies a reader break after %s as unknown with captured breakpoint",
    async (_label, raw) => {
      const result = await readResponsesStream(
        brokenReader(Buffer.from(raw), new Error("read ETIMEDOUT")),
        route,
        true,
      );
      expect(result).toMatchObject({
        outcome: "unknown",
        problem: { code: "transport_unknown", context: { stage: "read" } },
        failureEvidence: { bodyComplete: false, errors: [{ message: "read ETIMEDOUT" }] },
      });
      expect(result.problem?.context.lastEventType).toBeTruthy();
    },
  );

  it("captures the canonical message-schema rejection before it reaches the daemon", async () => {
    const result = await readResponsesStream(
      new Response(
        frame("completed", [
          {
            type: "function_call",
            call_id: "call_one",
            name: "   ",
            arguments: "{}",
          },
        ]),
      ),
      route,
      true,
    );
    expect(result).toMatchObject({
      outcome: "completed",
      message: null,
      problem: { code: "response_rejected", context: { stage: "message" } },
      failureEvidence: { errors: [{ name: "ZodError" }] },
    });
    expect(ModelCallResult.safeParse(result).success).toBe(true);
  });

  it.each([
    ["json", Buffer.from("data: {private-json-failure}\n\nreceived suffix")],
    ["decode", Buffer.from([100, 97, 116, 97, 58, 195, 40, 255])],
    ["event", Buffer.from("data: []\n\n")],
    [
      "terminal",
      Buffer.from('data: {"type":"response.completed","response":{"status":"failed"}}\n\n'),
    ],
    ["read", Buffer.from("data: [DONE]\n\n")],
  ] as const)("keeps every returned byte and the %s failure stage", async (stage, bytes) => {
    const result = await readResponsesStream(
      new Response(bytes, {
        headers: { "x-request-id": "wire-request" },
      }),
      route,
      true,
    );
    expect(result).toMatchObject({
      outcome: "unknown",
      message: null,
      problem: {
        code: "transport_unknown",
        context: { stage, receivedBytes: bytes.length, requestId: "wire-request" },
      },
      failureEvidence: { stage, receivedBytes: bytes.length, bodyComplete: stage === "read" },
    });
    expect(Buffer.from(result.failureEvidence!.bodyBase64, "base64").equals(bytes)).toBe(true);
    expect(result.failureEvidence!.errors.length).toBe(stage === "read" ? 0 : 1);
    expect(ModelCallResult.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result.problem)).not.toContain("private-json-failure");
  });

  it("retains a socket cause after received data, outside public diagnostics", async () => {
    const bytes = Buffer.from(
      'data: {"type":"response.output_text.delta","delta":"private body"}\n\n',
    );
    const error = socketError();
    const result = await readResponsesStream(brokenReader(bytes, error), route, true);
    expect(result.failureEvidence).toMatchObject({
      receivedBytes: bytes.length,
      bodyComplete: false,
      causeCycle: false,
      errors: [
        { name: "TypeError", message: error.message, stack: error.stack, code: null },
        {
          name: "Error",
          message: error.cause.message,
          stack: error.cause.stack,
          code: "UND_ERR_SOCKET",
        },
      ],
    });
    expect(result.problem?.context).toMatchObject({
      stage: "read",
      errorName: "TypeError",
      errorCode: "UND_ERR_SOCKET",
      eventCount: 1,
      lastEventType: "response.output_text.delta",
      terminalStatus: null,
    });
    expect(Buffer.from(result.failureEvidence!.bodyBase64, "base64").equals(bytes)).toBe(true);
    expect(JSON.stringify(result.problem)).not.toContain("private");
  });

  it.each([false, undefined])(
    "keeps legacy failure results strict when capture is %s",
    async (capture) => {
      const result = await readResponsesStream(
        brokenReader(Buffer.from("partial"), socketError()),
        route,
        capture,
      );
      expect(result).not.toHaveProperty("failureEvidence");
      expect(ModelCallResult.omit({ failureEvidence: true }).strict().parse(result)).toEqual(
        result,
      );
      expect(JSON.stringify(result)).not.toContain("private");
    },
  );

  it.each(["completed", "incomplete"])(
    "preserves %s terminal and usage when message conversion fails",
    async (type) => {
      const bytes = Buffer.from(
        frame(type, [{ type: "function_call", name: "tool", arguments: "{}" }]),
      );
      const result = await readResponsesStream(new Response(bytes), route, true);
      expect(result).toMatchObject({
        outcome: type,
        message: null,
        route: { model: "one" },
        usage: { input_tokens: 13, output_tokens: 8 },
        problem: { code: "response_rejected", context: { stage: "message", terminalStatus: type } },
        failureEvidence: { stage: "message", receivedBytes: bytes.length },
      });
      expect(Buffer.from(result.failureEvidence!.bodyBase64, "base64").equals(bytes)).toBe(true);
      expect(result.failureEvidence!.errors[0].message).toContain("malformed completed tool call");
    },
  );

  it("retains usable incomplete output and the provider failure body without losing their facts", async () => {
    const text = [{ type: "message", content: [{ type: "output_text", text: "partial text" }] }];
    const partial = frame("incomplete", text, {
      incomplete_details: { reason: "max_output_tokens" },
    });
    const incomplete = await readResponsesStream(new Response(partial), route, true);
    expect(incomplete).toMatchObject({
      outcome: "incomplete",
      message: { content: "partial text" },
      problem: { code: "provider_incomplete", context: { reason: "max_output_tokens" } },
    });
    expect(Buffer.from(incomplete.failureEvidence!.bodyBase64, "base64").toString()).toBe(partial);
    const failed = frame("failed", [null], {
      error: { code: "usage_limit_reached", message: "private vendor detail" },
    });
    const failure = await readResponsesStream(new Response(failed), route, true);
    expect(failure).toMatchObject({
      outcome: "failed",
      message: null,
      usage: { input_tokens: 13, output_tokens: 8 },
      problem: { code: "subscription_window_exhausted", context: { terminalStatus: "failed" } },
    });
    expect(Buffer.from(failure.failureEvidence!.bodyBase64, "base64").toString()).toBe(failed);
    expect(failure.failureEvidence!.errors).toEqual([]);
    expect(JSON.stringify(failure.problem)).not.toContain("private vendor detail");
  });

  it("does not duplicate successful wire, and records no unreceived data for an absent body", async () => {
    const result = await readResponsesStream(
      new Response(frame("completed") + "data: invalid tail\n\n"),
      route,
      true,
    );
    expect(result.outcome).toBe("completed");
    expect(result).not.toHaveProperty("failureEvidence");
    const absent = await readResponsesStream(new Response(null), route, true);
    expect(absent.failureEvidence).toMatchObject({
      bodyBase64: "",
      receivedBytes: 0,
      bodyComplete: false,
      errors: [],
    });
  });

  it.each(["primitive", "cycle", "aggregate cycle"])(
    "preserves %s exceptions without truncating strings",
    async (kind) => {
      const text = "private exception ".repeat(10_000);
      const error: unknown =
        kind === "primitive"
          ? text
          : kind === "aggregate cycle"
            ? new AggregateError([], text)
            : Object.assign(new Error(text), { cause: null as unknown });
      if (kind === "cycle") (error as { cause: unknown }).cause = error;
      if (kind === "aggregate cycle") (error as AggregateError).errors.push(error);
      const result = await readResponsesStream(brokenReader(new Uint8Array(), error), route, true);
      expect(result.failureEvidence!.errors[0].message).toBe(text);
      expect(result.failureEvidence!.causeCycle).toBe(kind !== "primitive");
      expect(JSON.stringify(result.problem)).not.toContain("private exception");
    },
  );
});

function adapterFixture(respond: () => Response | Promise<Response>) {
  const profile = CredentialProfile.parse({
    profile_id: "fixture",
    harness_id: "codex",
    display_name: "Fixture",
    credential_kind: "config_dir_login",
    isolation_locator: join(process.env.CLAUDEXOR_CONFIG_DIR!, "profiles", "fixture"),
  });
  const posts = vi.fn();
  const token = `fixture.${Buffer.from('{"exp":2100000000}').toString("base64url")}.signature`;
  const adapter = createCodexModelAdapter({
    readAuthFile: async () =>
      JSON.stringify({ tokens: { account_id: "fixture", access_token: token } }),
    refresh: async () => {
      throw new Error("fixture must never refresh auth");
    },
    fetch: async (_url, init) => {
      if (init?.method === "POST") {
        posts(init);
        expect(await requestBodyText(init)).not.toContain("captureFailureEvidence");
        return respond();
      }
      return Response.json({ models: [{ slug: "one", service_tiers: [{ id: "flex" }] }] });
    },
  });
  const context = {
    profile,
    signal: new AbortController().signal,
    onDispatch: vi.fn(async () => {}),
    captureFailureEvidence: true,
  };
  const request = ModelCallRequest.parse({
    source: "codex",
    model: "one",
    account: { mode: "pin", profileId: "fixture" },
    messages: [{ role: "user", content: "synthetic prompt" }],
  });
  return { adapter, context, request, posts };
}

describe("inference HTTP and fetch failure evidence", () => {
  it.each(["fetch", "stream", "refusal"])(
    "preserves native multi-address connection details on the %s path",
    async (path) => {
      const members = [
        Object.assign(new Error("private IPv6 connection refused"), { code: "ECONNREFUSED" }),
        Object.assign(new Error("private IPv4 connection timed out"), { code: "ETIMEDOUT" }),
      ];
      // Node's multi-address connector copies the first member's code onto its aggregate.
      const aggregate = Object.assign(new AggregateError(members, ""), { code: members[0].code });
      const error = new TypeError("private fetch failed", { cause: aggregate });
      const bytes = Buffer.from("private received prefix");
      const f = adapterFixture(() => {
        if (path === "fetch") throw error;
        return brokenReader(bytes, error, path === "refusal" ? 503 : 200);
      });
      const result = await f.adapter.invoke(f.request, f.context);
      expect(result.failureEvidence!.errors).toEqual(
        [error, aggregate, ...members].map((entry) => ({
          name: entry.name,
          message: entry.message,
          stack: entry.stack,
          code: "code" in entry ? entry.code : null,
        })),
      );
      expect(result.failureEvidence!.causeCycle).toBe(false);
      expect(Buffer.from(result.failureEvidence!.bodyBase64, "base64")).toEqual(
        path === "fetch" ? Buffer.alloc(0) : bytes,
      );
      expect(result.problem?.context).toMatchObject({ errorCode: "ECONNREFUSED" });
      expect(JSON.stringify(result.problem)).not.toContain("private");
      expect(ModelCallResult.safeParse(result).success).toBe(true);
      expect(f.posts).toHaveBeenCalledTimes(1);
      expect(f.context.onDispatch).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps exact HTTP refusal bytes and the processing no-generation proof", async () => {
    const raw =
      ' { "error": { "code": "resource_unavailable", "param": "service_tier", "message":"private refusal" } }\n';
    const f = adapterFixture(
      () => new Response(raw, { status: 429, headers: { "x-request-id": "refusal-request" } }),
    );
    f.request.options.processingPreference = "economy";
    const result = await f.adapter.invoke(f.request, f.context);
    expect(result).toMatchObject({
      outcome: "failed",
      problem: {
        code: "processing_unavailable",
        context: { generationStarted: false, httpStatus: 429, requestId: "refusal-request" },
      },
      failureEvidence: { bodyComplete: true, errors: [] },
    });
    expect(Buffer.from(result.failureEvidence!.bodyBase64, "base64").toString()).toBe(raw);
    expect(JSON.stringify(result.problem)).not.toContain("private refusal");
    expect(f.posts).toHaveBeenCalledTimes(1);
  });

  it.each(["read", "decode", "json"])(
    "retains HTTP refusal and partial body after %s failure",
    async (stage) => {
      const raw =
        stage === "decode" ? Buffer.from([195, 40]) : Buffer.from("private invalid HTTP body");
      const f = adapterFixture(() =>
        stage === "read"
          ? brokenReader(raw, socketError(), 503)
          : new Response(raw, { status: 503 }),
      );
      const result = await f.adapter.invoke(f.request, f.context);
      expect(result).toMatchObject({
        outcome: "failed",
        problem: { code: "provider_failed", context: { httpStatus: 503, stage } },
      });
      expect(Buffer.from(result.failureEvidence!.bodyBase64, "base64").equals(raw)).toBe(true);
      expect(result.failureEvidence!.bodyComplete).toBe(stage !== "read");
      expect(result.failureEvidence!.errors.length).toBeGreaterThan(0);
      expect(f.posts).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps a post-dispatch fetch exception and zero bytes without auth or retry", async () => {
    const error = socketError();
    const f = adapterFixture(() => {
      throw error;
    });
    const result = await f.adapter.invoke(f.request, f.context);
    expect(result).toMatchObject({
      outcome: "unknown",
      problem: {
        code: "transport_unknown",
        context: { stage: "fetch", errorCode: "UND_ERR_SOCKET" },
      },
      failureEvidence: {
        bodyBase64: "",
        receivedBytes: 0,
        bodyComplete: false,
        errors: [{ message: error.message }, { code: "UND_ERR_SOCKET" }],
      },
    });
    expect(f.posts).toHaveBeenCalledTimes(1);
    expect(f.context.onDispatch).toHaveBeenCalledTimes(1);
  });
});
