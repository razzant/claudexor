/**
 * Bounded tool result text, collapsed to one line. It is the tool output the
 * model saw and the only copy Claudexor keeps, so it is never masked (INV-146). With `lines`, an
 * MCP result keeps its line breaks, which structure the server's text (the
 * Browser MCP's `### ` blocks, code fences and page fields); within a line,
 * whitespace still collapses and blank lines are dropped.
 */
export function summarizeToolResultContent(content: unknown, lines = false): string {
  const summarize = (text: string): string =>
    (lines
      ? text
          .split(/\r\n?|\n/)
          .map((line) => line.replace(/\s+/g, " ").trimEnd())
          .filter(Boolean)
          .join("\n")
      : text.trim().replace(/\s+/g, " ")
    ).slice(0, 1000);
  if (typeof content === "string") return summarize(content);
  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        if (typeof item === "string") return item;
        if (!item || typeof item !== "object" || Array.isArray(item)) return "";
        const rec = item as Record<string, unknown>;
        return typeof rec["text"] === "string"
          ? rec["text"]
          : typeof rec["content"] === "string"
            ? rec["content"]
            : "";
      })
      .filter(Boolean);
    return summarize(parts.join(lines ? "\n" : " "));
  }
  if (content && typeof content === "object") {
    return JSON.stringify(content).slice(0, 1000);
  }
  return "";
}
