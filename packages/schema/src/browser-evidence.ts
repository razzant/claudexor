import { z } from "zod/v3";

/**
 * #215: the one startup receipt of the Browser a run explicitly selected, as the
 * adapter reported it when it allowed the first model request. Codex keeps its
 * own 90 s startup limit for the server (`startup_timeout_sec`); the adapter
 * holds `turn/start` at most 5 s longer, a grace for the status to arrive, so a
 * failure Codex reports at its limit (observed at about 90.06 s) keeps Codex's own
 * reason. `status` is Codex's own startup state, or `not_observed` when Codex sent
 * none: `ready` is Codex's report that the server started, not proof that a page
 * was or could be read; `starting` means it was still starting when the hold
 * ended, so the first request may not have offered Browser tools. It is evidence
 * only: Browser stays optional, and an armed Browser without this record was only
 * prepared.
 */
export const BrowserStartupRecord = z
  .object({
    status: z
      .enum(["ready", "failed", "cancelled", "starting", "not_observed"])
      .describe(
        "Startup state when the first model request was allowed: ready (Codex reported the server started), failed, cancelled, starting (still starting when the hold ended: Codex's 90 s limit plus a 5 s grace for its status), or not_observed (no startup status at all).",
      ),
    waited_ms: z
      .number()
      .int()
      .nonnegative()
      .describe("How long the adapter held the first model request for this outcome."),
    error: z
      .string()
      .nullable()
      .default(null)
      .describe("The vendor's own reason for a failed or cancelled startup, masked."),
  })
  .describe("The selected Browser's startup outcome before the first model request (#215).");
export type BrowserStartupRecord = z.infer<typeof BrowserStartupRecord>;

/**
 * QA-040: runtime browser-MCP evidence for one attempt. `requested` is set when
 * the engine armed the Playwright browser injection for this lane (the injected
 * server name is known — a fixed `browser` namespace). `attempted`/`satisfied`/
 * `failed` flip from the run's tool events matched to that injected server, so a
 * successful browser navigation is recognized as trusted live-web activity even
 * though the adapter normalizes browser calls as `kind:"mcp"` (codex/claude both
 * do). `unused` discloses an armed-but-never-called browser (a generic
 * web_search satisfied instead) WITHOUT failing the run — disclosure only.
 */
export const BrowserEvidenceRecord = z
  .object({
    requested: z
      .boolean()
      .default(false)
      .describe("The engine armed (injected) the browser MCP for this attempt."),
    server_name: z
      .string()
      .nullable()
      .default(null)
      .describe("The injected browser MCP server name; null when not armed."),
    attempted: z
      .boolean()
      .default(false)
      .describe("At least one browser MCP tool call (matched to the injected server) occurred."),
    satisfied: z
      .boolean()
      .default(false)
      .describe("At least one browser MCP tool call succeeded (trusted live-web activity)."),
    failed: z
      .boolean()
      .default(false)
      .describe("A browser MCP tool call failed and was not superseded by a success."),
    unused: z
      .boolean()
      .default(false)
      .describe(
        "The browser was armed but never called while generic web evidence satisfied the run (disclosure only; not a failure).",
      ),
    startup: BrowserStartupRecord.optional().describe(
      "The selected Browser's startup outcome as the adapter reported it before the first model request (#215); absent when the route reported none.",
    ),
  })
  .describe("Runtime browser-MCP evidence for one attempt (QA-040).");
export type BrowserEvidenceRecord = z.infer<typeof BrowserEvidenceRecord>;
