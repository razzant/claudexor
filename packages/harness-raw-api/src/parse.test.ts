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

  it("handles empty/malformed responses gracefully", () => {
    expect(parseChatCompletion({}).text).toBe("");
    expect(parseChatCompletion({ choices: [] }).model).toBeNull();
  });
});

describe("parseModelsList", () => {
  it("parses the OpenAI GET /v1/models shape", () => {
    const models = parseModelsList({
      object: "list",
      data: [
        { id: "gpt-4o-mini", object: "model", created: 1, owned_by: "openai" },
        { id: "gpt-4o", object: "model", created: 2, owned_by: "openai" },
      ],
    });
    expect(models.map((m) => m.id)).toEqual(["gpt-4o-mini", "gpt-4o"]);
    // The bare OpenAI list carries no label/context_window -> honest nulls.
    expect(models[0]).toEqual({ id: "gpt-4o-mini", label: null, context_window: null });
  });

  it("populates label/context_window when a compatible provider supplies them", () => {
    const models = parseModelsList({
      data: [{ id: "openai/gpt-4o", name: "GPT-4o", context_length: 128000 }],
    });
    expect(models[0]).toEqual({ id: "openai/gpt-4o", label: "GPT-4o", context_window: 128000 });
  });

  it("drops entries without a string id and tolerates a missing/empty data array", () => {
    expect(
      parseModelsList({ data: [{ object: "model" }, { id: 42 }, { id: "ok" }] }).map((m) => m.id),
    ).toEqual(["ok"]);
    expect(parseModelsList({})).toEqual([]);
    expect(parseModelsList(null)).toEqual([]);
  });
});
