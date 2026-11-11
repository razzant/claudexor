import { z } from "zod/v3";
import { ExternalContextPolicy } from "./primitives.js";

export const WebEvidenceStatus = z
  .enum(["none", "attempted", "satisfied", "failed", "unverified"])
  .describe("Observed web activity: none, attempted, satisfied, failed, or unverified.");
export type WebEvidenceStatus = z.infer<typeof WebEvidenceStatus>;

/**
 * What web evidence covers (#118). Every engine version has observed the same
 * two things, so the default is also true of records written before it: the
 * harness's typed web tool calls and calls to the engine Browser MCP. Process
 * network traffic is not measured: the vendor API connection always exists, and
 * an allowed shell command or another tool can reach the network without a web
 * tool call. `attempted: false` is therefore never a statement about network use.
 */
export const WebObservation = z
  .object({
    evidence: z
      .literal("tool_calls")
      .describe("Web evidence comes from typed web tool calls and engine Browser MCP calls."),
    network: z
      .literal("not_measured")
      .describe(
        "Process network traffic is not measured: vendor API traffic, shell commands and other tools can use the network without appearing here.",
      ),
  })
  .describe("Scope of the web evidence: observed tool calls only, never a network measurement.");
export type WebObservation = z.infer<typeof WebObservation>;

export const WebEvidenceRecord = z
  .object({
    required: z.boolean().default(false).describe("Explicit stored web requirement."),
    policy: ExternalContextPolicy.default("auto").describe("Requested web policy for the run."),
    effective_mode: ExternalContextPolicy.default("auto").describe(
      "Policy given to the harness route, after disclosed upgrades (e.g. cached to live); not proof that a native session ran.",
    ),
    attempted: z
      .boolean()
      .default(false)
      .describe(
        "Whether a web tool call or engine Browser call was observed; not a network measurement (see observation).",
      ),
    satisfied: z
      .boolean()
      .default(false)
      .describe(
        "Completed without a typed failure; verification records retrieval-proof strength.",
      ),
    status: WebEvidenceStatus.default("none"),
    /**
     * QA-042: retrieval STRENGTH of satisfied/attempted web activity, orthogonal
     * to `status`. `verified` = at least one result was a typed successful
     * retrieval, and `verified_content` says whether it was a page or search
     * results; `dispatched` = a web call completed without one (codex
     * `web_search`/`open_page`, a Browser page read that got an HTTP error);
     * `none` = no search or page retrieval was observed. #118: a Browser call
     * that read no web page (closing, clicking, tabs, about:blank) still makes
     * `satisfied` true, as the required-web gate always counted it, but leaves
     * the strength at `none`. A surface renders "Web verified" only for a
     * verified page and "Web searched" for verified search results.
     */
    verification: z
      .enum(["verified", "dispatched", "none"])
      .default("none")
      .describe(
        "Retrieval-proof strength of observed web activity: verified (a typed successful retrieval; verified_content says of what), dispatched (a web call completed without a typed retrieval result), or none (no search or page retrieval observed, though a Browser action may have completed).",
      ),
    verified_content: z
      .enum(["page", "search_results"])
      .nullable()
      .default(null)
      .describe(
        "What the verified retrieval returned: page (a fetched or loaded page; it outranks search results) or search_results (a web search's results, not a fetched page); null when nothing was verified or the record predates this field.",
      ),
    tool: z
      .string()
      .nullable()
      .default(null)
      .describe("Web tool that produced the evidence, when any."),
    target: z
      .string()
      .nullable()
      .default(null)
      .describe("Target (query/url) of the web activity as issued, when any."),
    error_summary: z
      .string()
      .nullable()
      .default(null)
      .describe("Redacted error detail when web activity failed."),
    observation: WebObservation.default({ evidence: "tool_calls", network: "not_measured" }),
  })
  .describe(
    "Typed web-evidence record computed by the orchestrator; surfaces project it and never re-derive evidence from raw events.",
  );
export type WebEvidenceRecord = z.infer<typeof WebEvidenceRecord>;
