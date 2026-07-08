/**
 * ACP prompt/result projection helpers — pure functions, no server state.
 */

/**
 * Flatten ACP prompt content blocks into the engine prompt. The declared
 * `embeddedContext: true` capability is honored here: `resource` blocks
 * (embedded file text) are inlined as fenced context sections and
 * `resource_link` blocks surface as references — editor-supplied context is
 * never silently dropped.
 */
export function extractPromptText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt;
  const blockText = (p: any): string => {
    if (typeof p === "string") return p;
    if (!p || typeof p !== "object") return "";
    if (typeof p.text === "string" && p.type !== "resource") return p.text;
    if (p.type === "resource" && p.resource && typeof p.resource === "object") {
      const res = p.resource as Record<string, unknown>;
      if (typeof res["text"] === "string" && res["text"].trim()) {
        const uri = typeof res["uri"] === "string" ? res["uri"] : "embedded resource";
        return `Context from ${uri}:\n\`\`\`\n${res["text"]}\n\`\`\``;
      }
      // Binary blobs have no text channel into a CLI prompt — reference only.
      const uri = typeof res["uri"] === "string" ? res["uri"] : "";
      return uri ? `Context resource (binary, not inlined): ${uri}` : "";
    }
    if (p.type === "resource_link") {
      const uri = typeof p.uri === "string" ? p.uri : "";
      const name = typeof p.name === "string" && p.name ? ` (${p.name})` : "";
      return uri ? `Referenced resource: ${uri}${name}` : "";
    }
    return "";
  };
  if (Array.isArray(prompt)) {
    return prompt.map(blockText).filter(Boolean).join("\n\n");
  }
  return blockText(prompt);
}

/**
 * Reduce a run result to the human-readable text the editor should show. The
 * orchestrator returns an OrchestratorResult whose `summary` is the primary
 * output; prefer it over dumping the whole internal object. Falls back to a
 * compact JSON string only when no summary/text field is present.
 */
export function summarizeResult(result: unknown): string {
  if (typeof result === "string") return result.trim();
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    for (const key of ["summary", "answer", "text"]) {
      const v = r[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return JSON.stringify(result);
  }
  return result === undefined || result === null ? "" : String(result);
}
