import { describe, expect, it } from "vitest";
import { parseChatCompletion } from "./parse.js";

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
