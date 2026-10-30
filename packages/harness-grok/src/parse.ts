import type { HarnessEvent, ToolRef } from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";

type ObjectValue = Record<string, any>;
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
const string = (value: unknown): string => (typeof value === "string" ? value : "");

/** Only vendor failure channels call this classifier; assistant prose never does.
 * It types quota and rate limits only. Grok documents no authentication error
 * code and refreshes and retries a 401 itself, and a proxy or backend can
 * print the same words, so no text or code becomes an authentication verdict:
 * such a failure stays untyped and never marks the account unusable. Login
 * readiness belongs to the pre-run `grok models` probe. */
export function grokFailure(value: unknown, sessionId: string): HarnessEvent {
  const data = object(value);
  const message = string(value) || string(data.message) || string(data.error) || "Grok CLI failed";
  const event: HarnessEvent = {
    type: "error",
    session_id: sessionId,
    ts: nowIso(),
    error: redactSecrets(message).slice(0, 2000),
  };
  const code = string(data.code) || string(data.type);
  if (
    data.status === 429 ||
    data.status_code === 429 ||
    /^(?:rate_limit_exceeded|quota_exceeded|usage_limit_exceeded|resource_exhausted)$/.test(code) ||
    /\brate[ _-]?limit(?:ed| exceeded)?\b|\btoo many requests\b|\bquota[ _-]?(?:exceeded|exhausted)\b|\busage limit\b|\b(?:HTTP|status|code)\s*429\b/i.test(
      message,
    )
  ) {
    const seconds = data.retry_after ?? data.retry_after_seconds;
    const delay =
      typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
        ? Math.ceil(seconds * 1000)
        : null;
    const resets =
      typeof data.resets_at === "string" && Number.isFinite(Date.parse(data.resets_at))
        ? new Date(data.resets_at).toISOString()
        : null;
    event.rate_limit = { resets_at: resets, retry_delay_ms: delay, applies_to_models: null };
    event.status = { kind: "api_retry", error_category: "rate_limit" };
  }
  return event;
}

const tokens = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

/** One aggregate usage record from a result frame. The bundled 1.0.70 guide
 * (`14-headless-mode.md`) defines three disjoint input buckets, `input_tokens`
 * (uncached), cache reads and cache creation, so their sum is the complete
 * input total; recorded 1.0.67 results agree (9856 cached beside 6086 input).
 * Grok emits a bucket it cannot account for as 0, so an all-zero record is
 * unknown, not free, and is not reported as usage. */
function resultUsage(raw: unknown): NonNullable<HarnessEvent["usage"]> | null {
  const source = object(raw);
  const buckets = [
    source.input_tokens,
    source.output_tokens,
    source.cache_read_input_tokens,
    source.cache_creation_input_tokens,
  ].filter((value): value is number => typeof value === "number");
  if (buckets.length > 0 && buckets.every((value) => value === 0)) return null;
  const usage: NonNullable<HarnessEvent["usage"]> = {};
  for (const [native, normalized] of [
    ["input_tokens", "input_tokens"],
    ["output_tokens", "output_tokens"],
    ["cache_read_input_tokens", "cached_input_tokens"],
  ] as const) {
    const n = source[native];
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) usage[normalized] = n;
  }
  const input = tokens(source.input_tokens);
  const read = tokens(source.cache_read_input_tokens);
  const write = tokens(source.cache_creation_input_tokens);
  if (read !== null || write !== null)
    usage.input_token_usage = {
      total_tokens: input !== null && read !== null && write !== null ? input + read + write : null,
      cache_read_tokens: read,
      cache_write_tokens: write,
    };
  // OAuth cost is vendor accounting, not a charge to the user's API key.
  // Tokens remain useful without manufacturing a subscription price.
  return Object.keys(usage).length ? usage : null;
}

/** Messages JSON is Claude-shaped, but usage/finality belong to Grok's result,
 * never to intermediate assistant messages or tool-result text. A top-level
 * error frame fails the turn; a result that still follows contributes only its
 * aggregate usage, so spend is counted once and no answer is manufactured. */
export function createGrokParser() {
  const tools = new Map<string, ToolRef>();
  let failed = false;
  let resulted = false;
  const parseEvent = (raw: unknown, sessionId: string): HarnessEvent[] | null => {
    const obj = object(raw);
    const base = { session_id: sessionId, ts: nowIso() };
    if (obj.type === "system") {
      if (obj.subtype !== "init") return [];
      return [
        {
          ...base,
          type: "started",
          observed_model: string(obj.model) || undefined,
          payload: { native_session_id: string(obj.session_id) },
        },
      ];
    }
    if (obj.type === "assistant") {
      const events: HarnessEvent[] = [];
      for (const block of Array.isArray(obj.message?.content) ? obj.message.content : []) {
        if (block.type === "text" && typeof block.text === "string")
          events.push({ ...base, type: "message", text: block.text });
        if (block.type === "tool_use" || block.type === "server_tool_use") {
          const name = string(block.name) || "tool";
          const input = object(block.input);
          const target =
            string(input.file_path) ||
            string(input.path) ||
            string(input.relative_workspace_path) ||
            string(input.command);
          const tool: ToolRef = {
            name,
            kind:
              name === "grep"
                ? "search"
                : /terminal|command/.test(name)
                  ? "command"
                  : /web_/.test(name)
                    ? "web"
                    : ["read_file", "list_dir", "search_replace", "write"].includes(name)
                      ? "file"
                      : "other",
            use_id: string(block.id) || undefined,
            // The agent's own tool input (INV-146): bounded, never masked.
            target: target ? target.slice(0, 500) : undefined,
          };
          if (tool.use_id) tools.set(tool.use_id, tool);
          events.push({ ...base, type: "tool_call", text: name, tool });
        }
      }
      return events;
    }
    if (obj.type === "user") {
      const events: HarnessEvent[] = [];
      for (const block of Array.isArray(obj.message?.content) ? obj.message.content : []) {
        if (block.type !== "tool_result") continue;
        const id = string(block.tool_use_id);
        const tool = tools.get(id) ?? { name: "tool", kind: "other" as const, use_id: id };
        if (typeof block.is_error !== "boolean") {
          events.push({
            ...base,
            type: "status",
            text: `${tool.name}: result carried no success or failure status`,
            tool,
          });
          continue;
        }
        // The tool output the model saw, bounded and unmasked (INV-146).
        const detail = string(block.content).slice(0, 1000);
        events.push({
          ...base,
          type: "tool_result",
          text: "tool_result",
          tool: {
            ...tool,
            status: block.is_error === true ? "error" : "ok",
            ...(block.is_error === true
              ? { error_summary: detail || "tool failed" }
              : { content_summary: detail || undefined }),
          },
        });
        if (block.is_error !== true && ["search_replace", "write"].includes(tool.name))
          events.push({
            ...base,
            type: "file_change",
            tool,
            payload: { path: tool.target, tool: tool.name },
          });
        tools.delete(id);
      }
      return events;
    }
    if (obj.type === "error") {
      failed = true;
      return [
        grokFailure(
          {
            ...obj,
            ...object(obj.error),
            message: string(obj.error) || string(object(obj.error).message) || string(obj.message),
          },
          sessionId,
        ),
      ];
    }
    if (obj.type === "result" || (obj.type === undefined && typeof obj.response === "string")) {
      if (resulted) return [];
      resulted = true;
      const events: HarnessEvent[] = [];
      // After a vendor error frame the turn has already failed: keep the
      // spend, never a late answer or a second failure.
      if (!failed && (obj.is_error === true || (obj.subtype && obj.subtype !== "success"))) {
        const detail = Array.isArray(obj.errors)
          ? obj.errors.filter((v: unknown) => typeof v === "string").join("; ")
          : "";
        events.push(
          grokFailure(
            {
              ...obj,
              ...object(obj.error),
              message:
                detail ||
                string(obj.error) ||
                string(obj.result) ||
                `Grok terminal status ${obj.subtype}`,
            },
            sessionId,
          ),
        );
      } else if (!failed) {
        const text =
          obj.structured_output != null
            ? JSON.stringify(obj.structured_output)
            : string(obj.result) || string(obj.response);
        events.push(
          text.trim()
            ? { ...base, type: "message", text, final: true, payload: { final_source: "result" } }
            : grokFailure("Grok returned an empty final response", sessionId),
        );
      }
      const usage = resultUsage(obj.usage);
      if (usage) events.push({ ...base, type: "usage", usage });
      return events;
    }
    if (obj.type === "stream_event") return [];
    return null;
  };
  return { parseEvent, hasTerminal: () => failed || resulted };
}
