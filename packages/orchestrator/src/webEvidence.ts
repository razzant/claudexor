import {
  BrowserStartupRecord,
  type AttemptTelemetryRecord,
  type ExternalContextPolicy,
  type HarnessEvent,
  type TaskContract,
  type ToolRef,
} from "@claudexor/schema";

/** One attempt's web evidence, folded from typed tool results only. */
export interface WebEvidenceState {
  required: boolean;
  mode: ExternalContextPolicy;
  effectiveMode: ExternalContextPolicy;
  attempted: boolean;
  satisfied: boolean;
  failed: boolean;
  /** Typed retrieval strength; never downgrades verified. */
  verification: "verified" | "dispatched" | "none";
  /** #118: what the verified results returned; a page outranks search results. */
  verifiedContent: "page" | "search_results" | null;
  tool: string | null;
  target: string | null;
  errorSummary: string | null;
}

export function newWebEvidence(
  required: boolean,
  mode: ExternalContextPolicy,
  effectiveMode: ExternalContextPolicy,
): WebEvidenceState {
  return {
    required,
    mode,
    effectiveMode,
    attempted: false,
    satisfied: false,
    failed: false,
    verification: "none",
    verifiedContent: null,
    tool: null,
    target: null,
    errorSummary: null,
  };
}

/**
 * QA-042/#118: raise the retrieval strength from one successful call, never
 * downgrading a verified result. A typed retrieval is verified, and a page
 * outranks search results. Any other web-kind success is dispatch strength (an
 * absent stamp never claims verification). A Browser call counts only through
 * its own stamp: one that read no web page (closing, clicking, about:blank)
 * completed, so it satisfies the call, but it retrieved nothing.
 */
export function bumpWebRetrieval(
  web: WebEvidenceState,
  tool: Pick<ToolRef, "web_retrieval" | "web_content">,
  browser: boolean,
): void {
  if (tool.web_retrieval === "verified") {
    web.verification = "verified";
    if (tool.web_content && web.verifiedContent !== "page") web.verifiedContent = tool.web_content;
  } else if ((!browser || tool.web_retrieval) && web.verification === "none") {
    web.verification = "dispatched";
  }
}

export function webStatus(web: WebEvidenceState): AttemptTelemetryRecord["web"]["status"] {
  if (web.satisfied) return "satisfied";
  if (web.failed) return "failed";
  if (web.attempted) return "attempted";
  return web.required ? "unverified" : "none";
}

/** The attempt record's web evidence; every engine version observed tool calls only. */
export function webEvidenceRecord(web: WebEvidenceState): AttemptTelemetryRecord["web"] {
  return {
    required: web.required,
    policy: web.mode,
    effective_mode: web.effectiveMode,
    attempted: web.attempted,
    satisfied: web.satisfied,
    status: webStatus(web),
    verification: web.verification,
    verified_content: web.verifiedContent,
    tool: web.tool,
    target: web.target,
    error_summary: web.errorSummary,
    observation: { evidence: "tool_calls", network: "not_measured" },
  };
}

/**
 * #215: the selected Browser's one startup receipt per native try, recorded as
 * its adapter reported it (Codex's `codex_browser_startup` status). Evidence
 * only: the Browser was neither called nor used to retrieve anything.
 */
export function observeBrowserStartup(
  browser: { requested: boolean; startup: BrowserStartupRecord | null },
  ev: HarnessEvent,
): void {
  const payload = ev.payload;
  if (!browser.requested || ev.type !== "status" || payload?.["code"] !== "codex_browser_startup")
    return;
  const receipt = BrowserStartupRecord.safeParse({
    status: payload["status"],
    waited_ms: payload["waited_ms"],
    error: payload["error"] ?? null,
  });
  if (receipt.success) browser.startup = receipt.data;
}

export function aggregateRunWebEvidence(
  records: AttemptTelemetryRecord[],
  contract: TaskContract,
): AttemptTelemetryRecord["web"] {
  const satisfied = records.find((r) => r.web.satisfied);
  if (satisfied) return satisfied.web;
  const severityRank = { none: 0, attempted: 1, unverified: 2, failed: 3, satisfied: 4 } as const;
  const worst = [...records].sort(
    (a, b) => (severityRank[b.web.status] ?? 0) - (severityRank[a.web.status] ?? 0),
  )[0];
  return (
    worst?.web ?? {
      required: contract.external_context.web_required,
      policy: contract.external_context.policy,
      effective_mode: contract.external_context.effective_mode,
      attempted: false,
      satisfied: false,
      status: contract.external_context.web_required ? ("unverified" as const) : ("none" as const),
      verification: "none" as const,
      verified_content: null,
      tool: null,
      target: null,
      error_summary: null,
      observation: { evidence: "tool_calls", network: "not_measured" },
    }
  );
}
