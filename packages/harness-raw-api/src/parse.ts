/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ChatResult {
  text: string;
  model: string | null;
  usage: { input_tokens?: number; output_tokens?: number };
}

export interface ParsedModel {
  id: string;
  label: string | null;
  context_window: number | null;
}

/**
 * Parse an OpenAI-compatible `GET /v1/models` response: `{ data: [{ id, ... }] }`.
 * Only `id` is guaranteed by the OpenAI shape; `context_window`/`label` are
 * populated opportunistically (some compatible providers, e.g. OpenRouter,
 * carry richer fields). Entries without a usable string `id` are dropped.
 */
export function parseModelsList(json: any): ParsedModel[] {
  const data = Array.isArray(json?.data) ? json.data : [];
  const out: ParsedModel[] = [];
  for (const entry of data) {
    const id = typeof entry?.id === "string" ? entry.id : null;
    if (!id) continue;
    const label = typeof entry?.name === "string" ? entry.name : null;
    const ctxRaw = entry?.context_length ?? entry?.context_window;
    const context_window = typeof ctxRaw === "number" && Number.isInteger(ctxRaw) && ctxRaw > 0 ? ctxRaw : null;
    out.push({ id, label, context_window });
  }
  return out;
}

/** Parse an OpenAI-compatible /chat/completions response. */
export function parseChatCompletion(json: any): ChatResult {
  const choice = json?.choices?.[0];
  const text = String(choice?.message?.content ?? "");
  const usage = json?.usage ?? {};
  return {
    text,
    model: typeof json?.model === "string" ? json.model : null,
    usage: {
      input_tokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
      output_tokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined,
    },
  };
}
