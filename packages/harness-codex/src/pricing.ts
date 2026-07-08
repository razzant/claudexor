/**
 * Codex cost estimation. Codex `exec --json` reports token usage but NOT a
 * dollar cost, so the budget ledger would otherwise see $0 for every codex run.
 * We derive an ESTIMATE from token counts and per-model list prices. The result
 * is flagged `estimated: true` so the budget layer records it as an "observed"
 * (not "exact") signal — honest about its provenance.
 *
 * Prices are approximate USD per 1M tokens and can drift; override per model via
 * env: CLAUDEXOR_CODEX_PRICE_INPUT / _OUTPUT / _CACHED (USD per 1M tokens).
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
// ORDER MATTERS: mini/nano rows come FIRST — a `gpt-5.x-mini` must resolve to
// the mini price, not fall into the broad gpt-5 row above it (that ordering
// bug over-estimated mini turns ~8x in the budget ledger).
const TABLE: { match: RegExp; price: Price }[] = [
  { match: /mini|nano/i, price: { input: 0.15, output: 0.6, cached: 0.075 } },
  { match: /gpt-5[.\d]*-codex|gpt-5[.\d]*-pro/i, price: { input: 1.25, output: 10, cached: 0.125 } },
  { match: /gpt-5|o3|o4/i, price: { input: 1.25, output: 10, cached: 0.125 } },
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
    input: envNum("CLAUDEXOR_CODEX_PRICE_INPUT") ?? base.input,
    output: envNum("CLAUDEXOR_CODEX_PRICE_OUTPUT") ?? base.output,
    cached: envNum("CLAUDEXOR_CODEX_PRICE_CACHED") ?? base.cached,
  };
}

/**
 * Estimate USD cost from token usage. Returns undefined when no usable token
 * counts are present (so we never fabricate a zero/spurious cost).
 */
export function estimateCodexCostUsd(model: string | null | undefined, usage: TokenUsage): number | undefined {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  // Codex usage reports cached_input_tokens as a SUBSET of input_tokens (the
  // total prompt), matching OpenAI usage semantics. Clamp defensively.
  const cached = Math.min(usage.cached_input_tokens ?? 0, input);
  if (input === 0 && output === 0 && cached === 0) return undefined;
  const p = priceForModel(model);
  // Bill the non-cached prompt portion at the input rate and the cached subset
  // at the (cheaper) cached rate. Previously the cached tokens were billed
  // twice (once inside input_tokens at the full input rate, once at the cached
  // rate), over-reporting codex spend by up to ~4x on cache-heavy turns.
  const nonCached = Math.max(0, input - cached);
  const usd = (nonCached / 1e6) * p.input + (output / 1e6) * p.output + (cached / 1e6) * p.cached;
  return Number.isFinite(usd) ? usd : undefined;
}
