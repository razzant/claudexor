/**
 * Pure presentation owners for one run result on the MCP surface: the text
 * trailer an MCP host renders and its structured machine mirror. Kept out of
 * index.ts so the tool wiring stays within the readability ratchet.
 */
import { taskGroupReceiptMetadata } from "@claudexor/schema";

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
    for (const [key, value] of Object.entries(taskGroupReceiptMetadata(r)))
      trailer.push(`${key}: ${value}`);
    if (typeof r["runId"] === "string" && r["runId"]) trailer.push(`runId: ${r["runId"]}`);
    // A queued launch has no run yet: its job id is the recovery handle.
    if (typeof r["jobId"] === "string" && r["jobId"] && r["jobId"] !== r["runId"])
      trailer.push(`jobId: ${r["jobId"]}`);
    if (typeof r["runDir"] === "string" && r["runDir"]) trailer.push(`artifacts: ${r["runDir"]}`);
    if (typeof r["status"] === "string" && r["status"]) trailer.push(`status: ${r["status"]}`);
    const objectResult = r["objectResult"] as Record<string, unknown> | null | undefined;
    if (objectResult?.["patchView"] === "unavailable")
      trailer.push(
        `result: kept exactly as Git objects (${String(objectResult["digest"])}); no patch view (${String(objectResult["reason"])}, ${String(objectResult["changedFiles"] ?? "?")} changed files) — it can still be applied and reverted`,
      );
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
    ...taskGroupReceiptMetadata(r),
    ...(Array.isArray(r["attemptExecution"]) ? { attemptExecution: r["attemptExecution"] } : {}),
    summary,
    runId: typeof r["runId"] === "string" && r["runId"] ? r["runId"] : null,
    jobId: typeof r["jobId"] === "string" && r["jobId"] ? r["jobId"] : null,
    runDir: typeof r["runDir"] === "string" && r["runDir"] ? r["runDir"] : null,
    // `status` carries the run LIFECYCLE (D8); the axes ride alongside as facts.
    status: typeof r["status"] === "string" && r["status"] ? r["status"] : null,
    runFacts:
      r["runFacts"] && typeof r["runFacts"] === "object" && !Array.isArray(r["runFacts"])
        ? r["runFacts"]
        : null,
    outcomeFacts:
      r["outcomeFacts"] && typeof r["outcomeFacts"] === "object" ? r["outcomeFacts"] : null,
    failure: r["failure"] && typeof r["failure"] === "object" ? r["failure"] : null,
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
    objectResult:
      r["objectResult"] && typeof r["objectResult"] === "object" ? r["objectResult"] : null,
  };
}
