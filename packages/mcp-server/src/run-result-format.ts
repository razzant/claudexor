/**
 * Pure presentation owners for one run result on the MCP surface: the text
 * trailer an MCP host renders and its structured machine mirror. Kept out of
 * index.ts so the tool wiring stays within the readability ratchet.
 */

/**
 * Render a run result for an MCP host: the human-readable summary FIRST, then
 * the artifact handles (runId/artifacts/status) so the host can inspect,
 * apply, follow, or unblock the run through the CLI — the old surface dropped
 * the runId and left hosts with no handle at all.
 */
export function formatRunResult(result: unknown): string {
  if (typeof result === "string") return result.trim();
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    let summary = "";
    for (const key of ["summary", "answer", "text"]) {
      const v = r[key];
      if (typeof v === "string" && v.trim()) {
        summary = v.trim();
        break;
      }
    }
    const trailer: string[] = [];
    if (typeof r["runId"] === "string" && r["runId"]) trailer.push(`runId: ${r["runId"]}`);
    if (typeof r["runDir"] === "string" && r["runDir"]) trailer.push(`artifacts: ${r["runDir"]}`);
    if (typeof r["status"] === "string" && r["status"]) trailer.push(`status: ${r["status"]}`);
    if (!summary && trailer.length === 0) return JSON.stringify(result);
    return trailer.length > 0 ? `${summary ? `${summary}\n\n` : ""}${trailer.join("\n")}` : summary;
  }
  return result === undefined || result === null ? "" : String(result);
}

/**
 * Structured mirror of a run result (McpRunToolResult shape): the SAME facts
 * the text trailer carries, machine-readable — summary, recovery handles, and
 * the derived apply-gate verdict when the runner surfaced one.
 */
export function structuredRunResult(result: unknown): Record<string, unknown> {
  const r = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  let summary = typeof result === "string" ? result.trim() : "";
  for (const key of ["summary", "answer", "text"]) {
    const v = r[key];
    if (!summary && typeof v === "string" && v.trim()) summary = v.trim();
  }
  return {
    summary,
    runId: typeof r["runId"] === "string" && r["runId"] ? r["runId"] : null,
    runDir: typeof r["runDir"] === "string" && r["runDir"] ? r["runDir"] : null,
    // `status` carries the run LIFECYCLE (D8); the axes ride alongside as facts.
    status: typeof r["status"] === "string" && r["status"] ? r["status"] : null,
    outcomeFacts:
      r["outcomeFacts"] && typeof r["outcomeFacts"] === "object" ? r["outcomeFacts"] : null,
    applyEligibility:
      r["applyEligibility"] && typeof r["applyEligibility"] === "object"
        ? r["applyEligibility"]
        : null,
    outcomeBanner: typeof r["outcomeBanner"] === "string" ? r["outcomeBanner"] : null,
    planReadiness:
      r["planReadiness"] && typeof r["planReadiness"] === "object" ? r["planReadiness"] : null,
    // Typed disclosure that the post-terminal detail read degraded (the run
    // finished; its detail projections above are absent for this reason).
    detailProblem:
      r["detailProblem"] && typeof r["detailProblem"] === "object" ? r["detailProblem"] : null,
    council: r["council"] && typeof r["council"] === "object" ? r["council"] : null,
    parentRunId: typeof r["parentRunId"] === "string" ? r["parentRunId"] : null,
    delegatedFromRunId:
      typeof r["delegatedFromRunId"] === "string" ? r["delegatedFromRunId"] : null,
    delegation: r["delegation"] && typeof r["delegation"] === "object" ? r["delegation"] : null,
  };
}
