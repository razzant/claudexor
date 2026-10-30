import type { ToolRef } from "@claudexor/schema";

type Json = any;

/** Whitespace-collapsed native tool text, bounded like other adapters'
 * summaries. It is the tool output the model saw and the only copy Claudexor
 * keeps, so it is never masked (INV-146). */
export function summarizeCodexOutput(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  return value.trim().replace(/\s+/g, " ").slice(0, 1000);
}

/**
 * An MCP result keeps its line breaks, which structure the server's text (the
 * Browser MCP's `### ` blocks, code fences and page fields). Within a line,
 * whitespace collapses as in other summaries; blank lines are dropped.
 */
function summarizeMcpText(text: string): string {
  return text
    .split(/\r\n?|\n/)
    .map((line) => line.replace(/\s+/g, " ").trimEnd())
    .filter(Boolean)
    .join("\n")
    .slice(0, 1000);
}

/**
 * Typed outcome of a completed Codex MCP item (app-server `mcpToolCall`, exec
 * `mcp_tool_call`). Codex 0.162.1 reports `completed` only when the server
 * returned a result without `isError`; `failed` covers both an `isError`
 * result (kept in `result`, no `error`) and a call that returned nothing
 * (`error.message`, no `result`). Any other status is unknown and stays
 * statusless: neither success nor failure. The result text is the server's own
 * output (for the Browser MCP: page URL, title and snapshot), kept as bounded,
 * exact evidence with its line breaks instead of being dropped; the error
 * summary stays on one line.
 */
export function mcpToolOutcome(
  item: Json,
): Pick<ToolRef, "status" | "error_summary" | "content_summary"> {
  const text = mcpResultText(item.result);
  const content = summarizeMcpText(text) || undefined;
  if (item.status === "completed") return { status: "ok", content_summary: content };
  if (item.status !== "failed") return { content_summary: content };
  const error = summarizeCodexOutput(
    typeof item.error === "string" ? item.error : item.error?.message,
  );
  return {
    status: "error",
    error_summary: error || summarizeCodexOutput(text) || "mcp tool call failed",
    content_summary: content,
  };
}

/** Text blocks of an MCP `CallToolResult`; image and other binary blocks are
 * not evidence text. Structured content is used only when no text came back. */
function mcpResultText(result: Json): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const text = Array.isArray(result.content)
    ? result.content
        .filter((block: Json) => block?.type === "text" && typeof block.text === "string")
        .map((block: Json) => block.text)
        .join("\n")
    : "";
  if (text.trim()) return text;
  const structured = result.structuredContent ?? result.structured_content;
  return structured == null ? "" : JSON.stringify(structured);
}
