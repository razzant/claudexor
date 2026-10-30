import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { validateTypedStream } from "@claudexor/core";
import { createGrokParser, grokFailure } from "./parse.js";

describe("Grok finality and vendor failures", () => {
  it("maps a terminal quota fixture without losing spend or creating an answer", () => {
    const parser = createGrokParser();
    const events = readFileSync(new URL("../fixtures/errors/quota.jsonl", import.meta.url), "utf8")
      .trim()
      .split("\n")
      .flatMap((line) => parser.parseEvent(JSON.parse(line), "s") ?? []);
    const stats = validateTypedStream(events);
    expect(stats.errors).toBe(1);
    expect(stats.usageEvents).toBe(1);
    expect(events.find((event) => event.rate_limit)?.rate_limit?.retry_delay_ms).toBe(60_000);
    expect(events.some((event) => event.final)).toBe(false);
  });
  it("counts aggregate usage once and keeps assistant narration non-final", () => {
    const p = createGrokParser();
    const message = p.parseEvent(
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "draft" }], usage: { input_tokens: 99 } },
      },
      "s",
    )!;
    expect(message[0]?.final).toBeUndefined();
    const result = {
      type: "result",
      subtype: "success",
      result: "answer",
      usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5 },
    };
    const events = p.parseEvent(result, "s")!;
    expect(events).toMatchObject([
      { type: "message", text: "answer", final: true },
      { type: "usage", usage: { input_tokens: 3, output_tokens: 4, cached_input_tokens: 5 } },
    ]);
    expect(p.parseEvent(result, "s")).toEqual([]);
    validateTypedStream([...message, ...events]);
  });

  it("uses structured output rather than mixed narration", () => {
    const events = createGrokParser().parseEvent(
      { type: "result", subtype: "success", structured_output: { ok: true }, result: "mixed" },
      "s",
    );
    expect(events?.[0]).toMatchObject({ final: true, text: '{"ok":true}' });
  });

  it.each(["rate_limit_exceeded", "quota_exceeded", "usage_limit_exceeded", "resource_exhausted"])(
    "types %s with reset and retry evidence",
    (code) => {
      const event = grokFailure(
        { code, message: "rejected", retry_after: 2, resets_at: "2026-10-26T01:00:00Z" },
        "s",
      );
      expect(event.rate_limit).toEqual({
        retry_delay_ms: 2000,
        resets_at: "2026-10-26T01:00:00.000Z",
        applies_to_models: null,
      });
      validateTypedStream([event]);
    },
  );

  // Grok documents no authentication error code, and its guide says the CLI
  // itself refreshes and retries on a 401; neither text nor a code merely
  // containing "auth" is a verdict about the account.
  it.each([
    "HTTP 401 Unauthorized",
    "407 Proxy Authentication Required",
    "error: unauthenticated",
    { code: "auth_proxy_unavailable", message: "upstream failed" },
    { code: "unauthorized", message: "rejected" },
    { type: "login_required", message: "sign in again" },
  ])("keeps %j an untyped failure, never an authentication verdict", (failure) => {
    const event = grokFailure(failure, "s");
    expect(event.status).toBeUndefined();
    expect(event.rate_limit).toBeUndefined();
    expect(event.error).not.toBe("");
    validateTypedStream([event]);
  });

  it("types stderr-only quota refusals but never quota words in model prose", () => {
    expect(grokFailure("HTTP 429: Too many requests", "s").rate_limit).toBeTruthy();
    const p = createGrokParser();
    expect(
      p.parseEvent(
        { type: "result", subtype: "success", result: "quota exceeded is an error message" },
        "s",
      )?.[0]?.rate_limit,
    ).toBeUndefined();
  });

  it("does not report a failed or empty result as a final answer", () => {
    for (const result of [
      {
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        errors: ["Maximum turns reached"],
      },
      { type: "result", subtype: "success", result: "" },
    ]) {
      const events = createGrokParser().parseEvent(result, "s")!;
      expect(events.some((event) => event.type === "error")).toBe(true);
      expect(events.some((event) => event.final)).toBe(false);
    }
  });

  it("does not fabricate a file change from a failed write", () => {
    const p = createGrokParser();
    p.parseEvent(
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "call", name: "write", input: { file_path: "/workspace/a" } },
          ],
        },
      },
      "s",
    );
    const events = p.parseEvent(
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "call", is_error: true, content: "denied" },
          ],
        },
      },
      "s",
    )!;
    expect(events).toHaveLength(1);
    expect(events[0]?.tool).toMatchObject({ status: "error", target: "/workspace/a" });
    validateTypedStream(events);
  });

  it("does not infer successful writes from a statusless tool result", () => {
    const p = createGrokParser();
    p.parseEvent(
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "call", name: "write", input: { file_path: "/workspace/a" } },
          ],
        },
      },
      "s",
    );
    const events = p.parseEvent(
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "call", content: "done" }] },
      },
      "s",
    )!;
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("status");
    validateTypedStream(events);
  });

  it("keeps a later result's usage after a vendor error frame without inventing an answer", () => {
    const p = createGrokParser();
    const failure = p.parseEvent(
      { type: "error", error: { code: "quota_exceeded", message: "limit reached" } },
      "s",
    )!;
    const late = {
      type: "result",
      subtype: "success",
      result: "late narration",
      usage: { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 1 },
    };
    const events = [...failure, ...p.parseEvent(late, "s")!];
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
    expect(events.filter((event) => event.type === "usage")).toMatchObject([
      { usage: { input_tokens: 7, output_tokens: 2, cached_input_tokens: 1 } },
    ]);
    expect(events.some((event) => event.final)).toBe(false);
    expect(p.parseEvent(late, "s")).toEqual([]);
    expect(p.hasTerminal()).toBe(true);
    validateTypedStream(events);
  });

  it("reports disjoint input buckets with their complete total", () => {
    const parser = createGrokParser();
    const usage = readFileSync(new URL("../fixtures/write.jsonl", import.meta.url), "utf8")
      .trim()
      .split("\n")
      .flatMap((line) => parser.parseEvent(JSON.parse(line), "s") ?? [])
      .find((event) => event.type === "usage")?.usage;
    // Recorded 1.0.67: 9856 cache-read tokens beside 6086 uncached input tokens.
    expect(usage).toMatchObject({ input_tokens: 6086, cached_input_tokens: 9856 });
    expect(usage?.input_token_usage).toEqual({
      total_tokens: 6086 + 9856,
      cache_read_tokens: 9856,
      cache_write_tokens: 0,
    });
    const written = createGrokParser()
      .parseEvent(
        {
          type: "result",
          subtype: "success",
          result: "ok",
          usage: {
            input_tokens: 10,
            output_tokens: 1,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 3,
          },
        },
        "s",
      )
      ?.find((event) => event.type === "usage")?.usage;
    // Bundled 1.0.70 guide: the three input buckets are disjoint.
    expect(written?.input_token_usage).toEqual({
      total_tokens: 18,
      cache_read_tokens: 5,
      cache_write_tokens: 3,
    });
  });

  it("reports an all-zero usage record as unknown, not as free work", () => {
    const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
    const events = createGrokParser().parseEvent(
      {
        type: "result",
        subtype: "success",
        result: "answer",
        usage: { ...zero, cache_creation_input_tokens: 0 },
      },
      "s",
    )!;
    expect(events.map((event) => event.type)).toEqual(["message"]);
    // A partly measured record is still reported.
    expect(
      createGrokParser()
        .parseEvent(
          { type: "result", subtype: "success", result: "a", usage: { ...zero, output_tokens: 4 } },
          "s",
        )
        ?.find((event) => event.type === "usage")?.usage,
    ).toMatchObject({ input_tokens: 0, output_tokens: 4 });
  });

  it("handles unknown/malformed events without throwing", () => {
    for (const raw of [null, [], { type: "future" }, { type: {} }])
      expect(createGrokParser().parseEvent(raw, "s")).toBeNull();
    expect(
      createGrokParser().parseEvent({ type: "assistant", message: { content: {} } }, "s"),
    ).toEqual([]);
  });
});

describe("tool targets are the agent's own actions, kept exact (INV-146)", () => {
  it("keeps a credential-shaped file path in the tool target", () => {
    const token = ["ghp", "q7Lm2Xv9Rk4Tz8Nw3Bp6Hs1Jd5Gf0Yc2Ae9U"].join("_");
    const out = createGrokParser().parseEvent(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "g1",
              name: "write",
              input: { file_path: `/workspace/${token}.txt` },
            },
          ],
        },
      },
      "s",
    );
    expect(out?.find((e) => e.type === "tool_call")?.tool?.target).toBe(`/workspace/${token}.txt`);
  });
});
