/**
 * Codex cost estimation. Codex `exec --json` reports token usage but NOT a
 * dollar cost, so the budget ledger would otherwise see $0 for every codex run.
 * We derive an ESTIMATE from token counts and per-model list prices. The result
 * is flagged `estimated: true` so the budget layer records it as an "observed"
 * (not "exact") signal — honest about its provenance.
 *
 * Prices are approximate USD per 1M tokens and can drift; override per model via
 * env: CLAUDEX_CODEX_PRICE_INPUT / _OUTPUT / _CACHED (USD per 1M tokens).
 */
export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
}

interface Price {
  input: number;
  output: number;
  cached: number;
}

// Approximate public list prices (USD / 1M tokens). Matched by substring so
// versioned model ids (gpt-5.1-codex, gpt-5-codex, ...) resolve to a family.
const TABLE: { match: RegExp; price: Price }[] = [
  { match: /gpt-5[.\d]*-codex|gpt-5[.\d]*-pro/i, price: { input: 1.25, output: 10, cached: 0.125 } },
  { match: /gpt-5|o3|o4/i, price: { input: 1.25, output: 10, cached: 0.125 } },
  { match: /gpt-4o-mini|mini/i, price: { input: 0.15, output: 0.6, cached: 0.075 } },
  { match: /gpt-4o|gpt-4\.1/i, price: { input: 2.5, output: 10, cached: 1.25 } },
];

const DEFAULT_PRICE: Price = { input: 1.25, output: 10, cached: 0.125 };

function envNum(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

export function priceForModel(model: string | null | undefined): Price {
  const base = TABLE.find((e) => model && e.match.test(model))?.price ?? DEFAULT_PRICE;
  return {
    input: envNum("CLAUDEX_CODEX_PRICE_INPUT") ?? base.input,
    output: envNum("CLAUDEX_CODEX_PRICE_OUTPUT") ?? base.output,
    cached: envNum("CLAUDEX_CODEX_PRICE_CACHED") ?? base.cached,
  };
}

/**
 * Estimate USD cost from token usage. Returns undefined when no usable token
 * counts are present (so we never fabricate a zero/spurious cost).
 */
export function estimateCodexCostUsd(model: string | null | undefined, usage: TokenUsage): number | undefined {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cached = usage.cached_input_tokens ?? 0;
  if (input === 0 && output === 0 && cached === 0) return undefined;
  const p = priceForModel(model);
  // Cached tokens are billed at the cached rate; treat input_tokens as the
  // non-cached prompt portion (codex already separates cached_input_tokens).
  const usd = (input / 1e6) * p.input + (output / 1e6) * p.output + (cached / 1e6) * p.cached;
  return Number.isFinite(usd) ? usd : undefined;
}
