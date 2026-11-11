export interface ChatResult {
  text: string;
  diagnostic_text: string | null;
  finish_reason: string | null;
  provider_error: ParsedProviderError | null;
  model: string | null;
  usage: { input_tokens?: number; output_tokens?: number; provider_cost?: number };
}

export interface ParsedProviderError {
  code: number;
  message: string;
  error_type: string | null;
  provider_code: string | null;
}

export interface ParsedModel {
  id: string;
  label: string | null;
  context_window: number | null;
  input_modalities: string[] | null;
  max_output_tokens: number | null;
}

/** A complete catalog, or why the answer is not one. */
export type ParsedModelsList =
  | { ok: true; models: ParsedModel[] }
  | { ok: false; cause: "malformed" | "incomplete"; detail: string };

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Parse an OpenAI-compatible `GET /v1/models` response: `{ data: [{ id, ... }] }`.
 * The answer is a complete catalog or a typed failure: a missing list, a row
 * without a string id, or a page that declares more rows than it carries never
 * becomes a smaller catalog (INV-104). OpenRouter answers the full list when
 * neither `offset` nor `limit` is sent, with `total_count` and `links.next`;
 * a present `total_count` must equal the rows carried, and a `links.next` page
 * means the answer is incomplete. A generic list without a count is complete
 * as listed. Only `id` is guaranteed by the OpenAI shape; richer OpenRouter
 * metadata (`name`, `context_length`, `architecture.input_modalities`,
 * `top_provider.max_completion_tokens`) is copied when well-formed and is
 * otherwise unknown (null), never "none".
 */
export function parseModelsList(json: any): ParsedModelsList {
  const data: unknown[] | null = Array.isArray(json?.data) ? json.data : null;
  if (!data) return { ok: false, cause: "malformed", detail: "the answer has no data array" };
  const declared = json?.total_count;
  if (declared !== undefined && !(Number.isInteger(declared) && declared >= 0))
    return { ok: false, cause: "malformed", detail: "total_count is not a non-negative integer" };
  const count: number | null = declared === undefined ? null : declared;
  const nextPage = typeof json?.links?.next === "string" && json.links.next.length > 0;
  if (nextPage || (count !== null && count > data.length))
    return {
      ok: false,
      cause: "incomplete",
      detail: `the answer is one page of a longer list (${data.length} rows of ${count ?? "more"})`,
    };
  if (count !== null && count < data.length)
    return {
      ok: false,
      cause: "malformed",
      detail: `the answer declares ${count} rows but carries ${data.length}`,
    };
  const out: ParsedModel[] = [];
  for (const [index, entry] of data.entries()) {
    const row = entry as Record<string, any> | null;
    const id = typeof row?.id === "string" && row.id.trim() ? row.id : null;
    if (!id) return { ok: false, cause: "malformed", detail: `row ${index} has no string id` };
    const modalities = row?.architecture?.input_modalities;
    out.push({
      id,
      label: typeof row?.name === "string" ? row.name : null,
      context_window: positiveInteger(row?.context_length ?? row?.context_window),
      input_modalities:
        Array.isArray(modalities) &&
        modalities.length > 0 &&
        modalities.every((item) => typeof item === "string" && item.trim().length > 0)
          ? [...modalities]
          : null,
      max_output_tokens: positiveInteger(row?.top_provider?.max_completion_tokens),
    });
  }
  return { ok: true, models: out };
}

/** Parse an OpenAI-compatible /chat/completions response. */
export function parseChatCompletion(json: any): ChatResult {
  const choice = json?.choices?.[0];
  const content = choice?.message?.content;
  const text = String(content ?? "");
  const usage = json?.usage ?? {};
  const providerCost =
    typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0
      ? usage.cost
      : undefined;
  return {
    text,
    diagnostic_text: typeof content === "string" ? content : null,
    finish_reason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
    provider_error: parseProviderError(choice?.error),
    model: typeof json?.model === "string" ? json.model : null,
    usage: {
      input_tokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
      output_tokens:
        typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined,
      ...(providerCost === undefined ? {} : { provider_cost: providerCost }),
    },
  };
}

function parseProviderError(value: unknown): ParsedProviderError | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const error = value as Record<string, unknown>;
  if (typeof error["code"] !== "number" || !Number.isFinite(error["code"])) return null;
  if (typeof error["message"] !== "string") return null;

  const metadata =
    error["metadata"] && typeof error["metadata"] === "object" && !Array.isArray(error["metadata"])
      ? (error["metadata"] as Record<string, unknown>)
      : null;
  return {
    code: error["code"],
    message: error["message"],
    error_type: typeof metadata?.["error_type"] === "string" ? metadata["error_type"] : null,
    provider_code:
      typeof metadata?.["provider_code"] === "string" ? metadata["provider_code"] : null,
  };
}
