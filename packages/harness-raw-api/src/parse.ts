/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ChatResult {
  text: string;
  model: string | null;
  usage: { input_tokens?: number; output_tokens?: number };
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
