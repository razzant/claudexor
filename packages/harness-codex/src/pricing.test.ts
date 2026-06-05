import { afterEach, describe, expect, it } from "vitest";
import { estimateCodexCostUsd, priceForModel } from "./pricing.js";

const ENV_KEYS = ["CLAUDEX_CODEX_PRICE_INPUT", "CLAUDEX_CODEX_PRICE_OUTPUT", "CLAUDEX_CODEX_PRICE_CACHED"] as const;

describe("codex pricing", () => {
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("estimates cost from token usage for a gpt-5-codex model", () => {
    const usd = estimateCodexCostUsd("gpt-5-codex", { input_tokens: 1_000_000, output_tokens: 1_000_000 });
    // 1M input * $1.25/M + 1M output * $10/M = 11.25
    expect(usd).toBeCloseTo(11.25, 5);
  });

  it("returns undefined when there are no token counts (never fabricate cost)", () => {
    expect(estimateCodexCostUsd("gpt-5-codex", {})).toBeUndefined();
    expect(estimateCodexCostUsd("gpt-5-codex", { input_tokens: 0, output_tokens: 0 })).toBeUndefined();
  });

  it("honors env price overrides", () => {
    process.env.CLAUDEX_CODEX_PRICE_INPUT = "2";
    process.env.CLAUDEX_CODEX_PRICE_OUTPUT = "20";
    const usd = estimateCodexCostUsd("gpt-5-codex", { input_tokens: 1_000_000, output_tokens: 1_000_000 });
    expect(usd).toBeCloseTo(22, 5);
  });

  it("falls back to a default price for unknown models", () => {
    const p = priceForModel("some-unknown-model");
    expect(p.input).toBeGreaterThan(0);
    expect(p.output).toBeGreaterThan(0);
  });
});
