import { describe, expect, it } from "vitest";
import { parseChatCompletion, parseModelsList } from "./parse.js";

describe("parseChatCompletion", () => {
  it("extracts text, model, and usage from an OpenAI-compatible response", () => {
    const r = parseChatCompletion({
      model: "gpt-4o-mini",
      choices: [{ message: { role: "assistant", content: "Here is the plan." } }],
      usage: { prompt_tokens: 12, completion_tokens: 34 },
    });
    expect(r.text).toBe("Here is the plan.");
    expect(r.model).toBe("gpt-4o-mini");
    expect(r.usage.input_tokens).toBe(12);
    expect(r.usage.output_tokens).toBe(34);
  });

  it.each([
    ["a positive fractional receipt", 0.000_123, 0.000_123],
    ["an exact zero receipt", 0, 0],
  ])("preserves %s as a neutral provider cost", (_label, cost, expected) => {
    const r = parseChatCompletion({
      model: "openrouter/model",
      choices: [{ message: { content: "done" } }],
      usage: { prompt_tokens: 2, completion_tokens: 3, cost },
    });

    expect(r).toMatchObject({
      text: "done",
      model: "openrouter/model",
      usage: { input_tokens: 2, output_tokens: 3, provider_cost: expected },
    });
  });

  it.each([undefined, "0.12", -1, Number.NaN, Number.POSITIVE_INFINITY, null])(
    "does not preserve an invalid provider cost (%s)",
    (cost) => {
      const r = parseChatCompletion({
        choices: [{ message: { content: "done" } }],
        usage: { prompt_tokens: 2, completion_tokens: 3, cost },
      });

      expect(r.usage).toEqual({ input_tokens: 2, output_tokens: 3 });
    },
  );

  it("handles empty/malformed responses gracefully", () => {
    expect(parseChatCompletion({}).text).toBe("");
    expect(parseChatCompletion({ choices: [] }).model).toBeNull();
  });

  it("retains allowlisted terminal provider-error facts and string diagnostics", () => {
    const result = parseChatCompletion({
      model: "openrouter/model",
      choices: [
        {
          message: { role: "assistant", content: "partial output" },
          finish_reason: "error",
          error: {
            code: 502,
            message: "Provider disconnected",
            metadata: {
              error_type: "provider_unavailable",
              provider_code: "upstream_502",
              flagged_input: "must not survive",
            },
            unknown: "must not survive either",
          },
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    });

    expect(result.finish_reason).toBe("error");
    expect(result.diagnostic_text).toBe("partial output");
    expect(result.provider_error).toEqual({
      code: 502,
      message: "Provider disconnected",
      error_type: "provider_unavailable",
      provider_code: "upstream_502",
    });
    expect(JSON.stringify(result.provider_error)).not.toContain("flagged_input");
    expect(JSON.stringify(result.provider_error)).not.toContain("unknown");
  });

  it("keeps either terminal signal independently and rejects malformed choice errors", () => {
    expect(
      parseChatCompletion({
        choices: [{ message: { content: "partial" }, finish_reason: "error" }],
      }),
    ).toMatchObject({ finish_reason: "error", provider_error: null });

    expect(
      parseChatCompletion({
        choices: [
          {
            message: { content: "partial" },
            error: {
              code: 429,
              message: "limited",
              metadata: { error_type: "rate_limit_exceeded" },
            },
          },
        ],
      }),
    ).toMatchObject({
      finish_reason: null,
      provider_error: {
        code: 429,
        message: "limited",
        error_type: "rate_limit_exceeded",
        provider_code: null,
      },
    });

    for (const error of [
      null,
      "failed",
      [],
      { code: "502", message: "failed" },
      { code: 502 },
      { code: 502, message: 42 },
    ]) {
      expect(parseChatCompletion({ choices: [{ error }] }).provider_error).toBeNull();
    }

    expect(
      parseChatCompletion({
        choices: [
          {
            error: {
              code: 502,
              message: "failed",
              metadata: { error_type: 42, provider_code: { raw: true } },
            },
          },
        ],
      }).provider_error,
    ).toMatchObject({ error_type: null, provider_code: null });
  });

  it("retains stop/length as ordinary finish reasons and never stringifies rich content for diagnostics", () => {
    expect(
      parseChatCompletion({
        choices: [
          { message: { content: [{ type: "text", text: "rich" }] }, finish_reason: "length" },
        ],
      }),
    ).toMatchObject({ finish_reason: "length", diagnostic_text: null });
    expect(
      parseChatCompletion({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] }),
    ).toMatchObject({ finish_reason: "stop", diagnostic_text: "done" });
    expect(
      parseChatCompletion({ choices: [{ message: { content: "" }, finish_reason: "error" }] }),
    ).toMatchObject({ finish_reason: "error", diagnostic_text: "" });
    expect(
      parseChatCompletion({ choices: [{ message: { content: "done" }, finish_reason: 42 }] }),
    ).toMatchObject({ finish_reason: null, diagnostic_text: "done" });
  });

  it.each([
    ["-Number.MAX_VALUE", -Number.MAX_VALUE],
    ["-1", -1],
    ["-0", -0],
    ["0", 0],
    ["Number.MIN_VALUE", Number.MIN_VALUE],
    ["0.5", 0.5],
    ["Number.MAX_VALUE", Number.MAX_VALUE],
  ] as const)("accepts finite provider error code %s with an empty message", (_label, code) => {
    const providerError = parseChatCompletion({
      choices: [{ error: { code, message: "" } }],
    }).provider_error;

    expect(providerError?.code).toBe(code);
    expect(providerError).toMatchObject({
      message: "",
      error_type: null,
      provider_code: null,
    });
  });

  it.each([
    ["Number.NEGATIVE_INFINITY", Number.NEGATIVE_INFINITY],
    ["Number.NaN", Number.NaN],
    ["Number.POSITIVE_INFINITY", Number.POSITIVE_INFINITY],
  ] as const)("rejects non-finite provider error code %s", (_label, code) => {
    expect(
      parseChatCompletion({ choices: [{ error: { code, message: "" } }] }).provider_error,
    ).toBeNull();
  });
});

describe("parseModelsList", () => {
  const unknown = { input_modalities: null, max_output_tokens: null };

  it("parses the OpenAI GET /v1/models shape", () => {
    const parsed = parseModelsList({
      object: "list",
      data: [
        { id: "gpt-4o-mini", object: "model", created: 1, owned_by: "openai" },
        { id: "gpt-4o", object: "model", created: 2, owned_by: "openai" },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.models.map((m) => m.id)).toEqual(["gpt-4o-mini", "gpt-4o"]);
    // The bare OpenAI list carries no label/window/modalities -> honest unknowns.
    expect(parsed.models[0]).toEqual({
      id: "gpt-4o-mini",
      label: null,
      context_window: null,
      ...unknown,
    });
  });

  it("copies OpenRouter metadata verbatim when the provider supplies it (#146)", () => {
    expect(
      parseModelsList({
        data: [
          {
            id: "openai/gpt-4o",
            name: "GPT-4o",
            context_length: 128000,
            architecture: { input_modalities: ["text", "image", "file"] },
            top_provider: { context_length: 64000, max_completion_tokens: 16384 },
          },
        ],
      }),
    ).toEqual({
      ok: true,
      models: [
        {
          id: "openai/gpt-4o",
          label: "GPT-4o",
          context_window: 128000,
          input_modalities: ["text", "image", "file"],
          max_output_tokens: 16384,
        },
      ],
    });
  });

  it.each([
    ["missing", {}],
    ["empty", { input_modalities: [] }],
    ["not an array", { input_modalities: "text" }],
    ["a blank entry", { input_modalities: ["text", " "] }],
    ["a non-string entry", { input_modalities: ["text", 3] }],
  ])("keeps %s modalities unknown, never 'none'", (_label, architecture) => {
    const parsed = parseModelsList({
      data: [{ id: "m", architecture, top_provider: { max_completion_tokens: 0 } }],
    });
    expect(parsed).toEqual({
      ok: true,
      models: [{ id: "m", label: null, context_window: null, ...unknown }],
    });
  });

  it("keeps a successful EMPTY list a success", () => {
    expect(parseModelsList({ data: [] })).toEqual({ ok: true, models: [] });
  });

  it("refuses to shrink a partially invalid answer into a smaller catalog (#393)", () => {
    expect(parseModelsList({ data: [{ object: "model" }, { id: "ok" }] })).toEqual({
      ok: false,
      cause: "malformed",
      detail: "row 0 has no string id",
    });
    expect(parseModelsList({ data: [{ id: "ok" }, { id: 42 }] })).toMatchObject({
      ok: false,
      cause: "malformed",
      detail: "row 1 has no string id",
    });
    expect(parseModelsList({ data: [{ id: "ok" }, null] })).toMatchObject({ cause: "malformed" });
    expect(parseModelsList({})).toMatchObject({ ok: false, cause: "malformed" });
    expect(parseModelsList(null)).toMatchObject({ ok: false, cause: "malformed" });
  });

  it("treats one page of a longer list as incomplete, not as the catalog", () => {
    expect(
      parseModelsList({ data: [{ id: "a" }], links: { next: "/api/v1/models?offset=1" } }),
    ).toMatchObject({ ok: false, cause: "incomplete" });
    expect(parseModelsList({ data: [{ id: "a" }], total_count: 2 })).toMatchObject({
      ok: false,
      cause: "incomplete",
      detail: "the answer is one page of a longer list (1 rows of 2)",
    });
    expect(
      parseModelsList({ data: [{ id: "a" }], total_count: 1, links: { next: null } }),
    ).toMatchObject({ ok: true });
  });

  it("accepts total_count only as exact completeness evidence", () => {
    // OpenRouter answers the FULL list when offset and limit are omitted, with
    // `total_count` equal to the rows it carries; an empty catalog says 0.
    expect(parseModelsList({ data: [], total_count: 0, links: { next: null } })).toEqual({
      ok: true,
      models: [],
    });
    expect(parseModelsList({ data: [{ id: "a" }, { id: "b" }], total_count: 1 })).toEqual({
      ok: false,
      cause: "malformed",
      detail: "the answer declares 1 rows but carries 2",
    });
    for (const total_count of ["1", -1, 1.5, null])
      expect(parseModelsList({ data: [{ id: "a" }], total_count }), String(total_count)).toEqual({
        ok: false,
        cause: "malformed",
        detail: "total_count is not a non-negative integer",
      });
    // A generic OpenAI-compatible list carries no count at all: complete as listed.
    expect(parseModelsList({ object: "list", data: [{ id: "a" }] })).toMatchObject({ ok: true });
  });
});
