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
 * One engine-parsed plan question (mirror of schema PlanQuestion — the ACP
 * package stays schema-light, so the shape is declared locally rather than
 * imported to avoid a dependency edge for one projection helper).
 */
export interface AcpPlanQuestion {
  id: string;
  kind: "single" | "multi" | "text";
  prompt: string;
  options?: Array<{ id: string; label: string }>;
  allow_text?: boolean;
}

/**
 * Render a plan turn's OPEN questions as ACP turn text (D14 design; SDK 1.2.1
 * has no multi-select/free-text typed input). Numbered, options inline, each
 * marked which accept multiple picks or free text. The user answers in an
 * ordinary follow-up plan turn — no ACP-side parsing into typed answers, no
 * separate answer channel. Returns "" when there are no questions to render.
 */
export function renderPlanQuestions(questions: readonly AcpPlanQuestion[]): string {
  if (questions.length === 0) return "";
  const lines: string[] = [
    `This plan has ${questions.length} open question${questions.length === 1 ? "" : "s"}. ` +
      `Answer ${questions.length === 1 ? "it" : "them"} in your next message and I'll revise the plan:`,
    "",
  ];
  questions.forEach((q, index) => {
    const tag =
      q.kind === "multi"
        ? " (choose one or more)"
        : q.kind === "text" || (q.options ?? []).length === 0
          ? " (free text)"
          : " (choose one)";
    lines.push(`${index + 1}. ${q.prompt}${tag}`);
    (q.options ?? []).forEach((option, optionIndex) => {
      lines.push(`   ${String.fromCharCode(97 + optionIndex)}) ${option.label}`);
    });
  });
  return lines.join("\n");
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
