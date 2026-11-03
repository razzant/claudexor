import { z } from "zod/v3";

/**
 * Coarse tool classification used for typed governance (no tool-name string
 * matching outside adapters). Adapters map native tool names to a kind.
 */
export const ToolKind = z
  .enum(["web", "file", "command", "mcp", "search", "other"])
  .describe(
    "Coarse tool classification used for typed governance; adapters map native tool names to a kind.",
  );
export type ToolKind = z.infer<typeof ToolKind>;

/**
 * #546: the vendor's own report that a background command ended, as far as a
 * protocol source defines it. It is neither an exit code nor the success of the
 * command's work, and a word outside this list is no report at all.
 */
export const ToolCommandCompletionStatus = z
  .enum(["success", "error", "aborted"])
  .describe(
    "The vendor's word for how a background command ended (Cursor 2026.08.11 shell completions); never an exit code or proof that the command's work succeeded.",
  );
export type ToolCommandCompletionStatus = z.infer<typeof ToolCommandCompletionStatus>;

/**
 * #450: what a command-kind tool result established about the PROCESS it
 * ran, separate from `status` (the tool call's own outcome). A background
 * handoff or an elapsed timeout returns an ordinary tool result while the
 * command's end is unobserved, so neither counts as a finished command.
 * #546: a later `command_outcome_refined` status can replace these facts for
 * the same call (`completion_reported`), keeping the handoff facts beside it.
 * Absent on adapters and legacy events that do not report it.
 */
export const ToolCommandOutcome = z
  .object({
    state: z
      .enum(["exited", "timed_out", "backgrounded", "completion_reported", "unknown"])
      .describe(
        "exited: the tool observed the command end; timed_out: the tool's timeout elapsed before an observed end (the process may still run or may have been signalled); backgrounded: the command was handed to a background shell and was still running when the result returned; completion_reported: after such a handoff, a later vendor notification reported that the command ended, without an exit code; unknown: the native result established none of these.",
      ),
    signal: z
      .string()
      .min(1)
      .optional()
      .describe("Vendor-reported signal name of an exited command."),
    timeout_ms: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "The elapsed tool timeout behind timed_out or a timeout-driven background handoff.",
      ),
    background_reason: z
      .enum(["timeout", "requested"])
      .optional()
      .describe("Why a backgrounded command left the foreground: its timeout or a request."),
    shell_id: z
      .string()
      .min(1)
      .optional()
      .describe("Vendor handle of the background shell that kept the command."),
    pid: z.number().int().positive().optional().describe("Vendor-reported process id."),
    completion_status: ToolCommandCompletionStatus.optional().describe(
      "What the vendor reported about a completion_reported command; never an exit code.",
    ),
  })
  .describe("Typed facts about the process a command-kind tool ran, separate from status.");
export type ToolCommandOutcome = z.infer<typeof ToolCommandOutcome>;

/**
 * #546: `payload.code` of the `status` event that refines the command outcome
 * of an earlier tool call (today: Cursor reports the end of a command it had
 * handed to a background shell). Its `tool` names that call by `use_id` and
 * carries the refined `command_outcome`, which replaces the call's handoff
 * facts and keeps them beside the new state. It is only ever
 * `completion_reported` with a defined status: it can never prove an exit,
 * restates or changes no call `status`, carries no exit code, and is never a
 * second result. A reader that does not know the code sees an ordinary status
 * event.
 */
export const COMMAND_OUTCOME_REFINED = "command_outcome_refined";

/** The call and refined command facts of a `command_outcome_refined` status
 * event or of its stored `harness.event` payload; null for anything else,
 * including a row that claims an exit or an undefined report. */
export function commandOutcomeRefinement(
  event: unknown,
): { useId: string; outcome: ToolCommandOutcome } | null {
  const row = (event !== null && typeof event === "object" ? event : {}) as {
    type?: unknown;
    tool?: { use_id?: unknown; command_outcome?: unknown } | null;
    payload?: { code?: unknown } | null;
  };
  if (row.type !== "status" || row.payload?.code !== COMMAND_OUTCOME_REFINED) return null;
  const useId = row.tool?.use_id;
  const outcome = ToolCommandOutcome.safeParse(row.tool?.command_outcome);
  return typeof useId === "string" &&
    useId &&
    outcome.success &&
    outcome.data.state === "completion_reported" &&
    outcome.data.completion_status
    ? { useId, outcome: outcome.data }
    : null;
}

/**
 * #546: what an attempt keeps of the vendor's reports about commands it had
 * handed to a background shell: the exact call and its refined facts. These are
 * command facts, never tool errors, so no recovery, warning, terminal or ranking
 * policy reads them: a deliberately stopped dev server reports `aborted` and may
 * simply have finished correctly. `recent` is bounded by the writer and `total`
 * keeps the true count.
 */
export const ReportedCommandOutcomes = z
  .object({
    total: z.number().int().nonnegative().describe("True count of reports in this attempt."),
    recent: z
      .array(
        z.object({
          tool: z.string().describe("Native tool name of the reported call."),
          target: z
            .string()
            .nullable()
            .default(null)
            .describe("Target of the call as issued, when known."),
          tool_use_id: z.string().min(1).describe("The exact call the report refined."),
          command_outcome: ToolCommandOutcome.describe(
            "The call's refined facts: the vendor's word and the handoff, never an exit code.",
          ),
        }),
      )
      .describe("The most recent reports, bounded by the writer."),
  })
  .describe("Vendor reports about handed-off commands, kept apart from tool errors.");
export type ReportedCommandOutcomes = z.infer<typeof ReportedCommandOutcomes>;

/**
 * Typed tool reference attached to `tool_call` / `tool_result` events.
 * `status` is REQUIRED on `tool_result` events (adapter conformance enforces it);
 * a missing status on a result is treated as a dropped/diagnostic event, never as ok.
 */
export const ToolRef = z
  .object({
    name: z.string().describe("Native tool name as the harness reports it."),
    kind: ToolKind.default("other"),
    use_id: z.string().optional().describe("Correlates a tool_result with its tool_call."),
    /** Bounded human-readable target (query/url/path/command), as issued. */
    target: z
      .string()
      .optional()
      .describe("Bounded human-readable target (query/url/path/command), as the agent issued it."),
    status: z
      .enum(["ok", "error", "cancelled", "denied"])
      .optional()
      .describe(
        "Outcome of the tool use; required on tool_result events (a missing status is never treated as ok).",
      ),
    /**
     * Native lifecycle frame of a `file_change` from adapters whose vendor
     * reports an edit's start and completion separately (Codex items, AGY
     * DONE steps). Absent = the adapter did not type it. `completed` is the
     * lifecycle, never success: the outcome stays in `status`.
     */
    phase: z
      .enum(["started", "completed"])
      .optional()
      .describe(
        "Native lifecycle frame of a file_change (started or completed); absent when the adapter does not type it. Completion is not success: the outcome stays in status.",
      ),
    /** Error detail for status=error results: the tool's own output, unmasked. */
    error_summary: z
      .string()
      .optional()
      .describe(
        "Error detail for status=error results: the tool's own output, unmasked, within the adapter's bound and whitespace normalization.",
      ),
    /** Content detail for results (success or failure), unmasked. */
    content_summary: z
      .string()
      .optional()
      .describe(
        "Content detail for results (success or failure), unmasked, within the adapter's bound and whitespace normalization.",
      ),
    exit_code: z
      .number()
      .int()
      .optional()
      .describe("Process exit code for command tools, when known."),
    command_outcome: ToolCommandOutcome.optional().describe(
      "Command process facts (#450), separate from status; absent means not reported.",
    ),
    /**
     * QA-042: adapter-stamped RETRIEVAL outcome for a web/browser tool result,
     * distinct from `status` (the tool-call LIFECYCLE). `verified` = the vendor
     * exposed a typed successful retrieval, and `web_content` says what it
     * returned; `dispatched` = the call completed but the vendor exposes NO typed
     * fetch outcome (codex `web_search`/`open_page` — a completed item can hide a
     * 502; a Browser page read that got an HTTP error), so the evidence is
     * dispatch-only, not proof of content; `failed` = a typed retrieval failure.
     * Absent on non-web tools, on a Browser call that read no web page (#118),
     * and on adapters that do not stamp it. The engine reads THIS (never prose)
     * to separate "web reached" from "web verified".
     */
    web_retrieval: z
      .enum(["verified", "dispatched", "failed"])
      .optional()
      .describe(
        "Adapter-stamped web/browser retrieval outcome (verified/dispatched/failed), distinct from the tool-call status lifecycle.",
      ),
    /**
     * #118: what a `verified` retrieval returned. `page` = a fetched or loaded
     * page (claude WebFetch; a Browser navigation or snapshot of an http(s) page
     * with no HTTP error); `search_results` = the results of a web search
     * (claude WebSearch), which is not a fetched page. Absent otherwise.
     */
    web_content: z
      .enum(["page", "search_results"])
      .optional()
      .describe(
        "What a verified web retrieval returned: page (a fetched or loaded page) or search_results (a web search's results, not a fetched page).",
      ),
  })
  .describe("Typed tool reference attached to tool_call/tool_result events.");
export type ToolRef = z.infer<typeof ToolRef>;

/**
 * True when a result carries command facts that do not establish an observed
 * exit: handed to a background shell, timed out, a completion reported
 * without an exit code, or any other state. Such a result never proves the
 * command finished successfully, so it is never a success or a recovery.
 * Absent facts (other adapters, legacy events) keep their existing meaning;
 * an unrecognized value counts as unconfirmed.
 */
export function commandOutcomeUnconfirmed(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return (value as { state?: unknown }).state !== "exited";
}

function durationLabel(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * The one English description of an unconfirmed command outcome (INV-134,
 * INV-141), used by adapter text, ACP and the continuation packet; the macOS
 * note mirrors it word for word. A handoff says only what was seen: the
 * command went to a background shell and its completion was not observed,
 * never that it is still running. A reported completion leads with the
 * report, keeps the exit code unknown and keeps the handoff as history. Null
 * when nothing needs disclosure: no facts, or an observed exit.
 */
export function commandOutcomeLabel(value: unknown): string | null {
  if (!commandOutcomeUnconfirmed(value)) return null;
  const parsed = ToolCommandOutcome.safeParse(value);
  if (!parsed.success || parsed.data.state === "unknown") return "Command outcome not reported";
  const { state, timeout_ms: ms, background_reason: reason, shell_id, pid } = parsed.data;
  const handle = [shell_id && `shell ${shell_id}`, pid && `pid ${pid}`].filter(Boolean);
  if (state === "timed_out") {
    const lead = ms === undefined ? "Timed out" : `Timed out after ${durationLabel(ms)}`;
    return [lead, "exit status unknown", ...handle].join(" · ");
  }
  const after =
    reason === "timeout" && ms !== 0
      ? ms === undefined
        ? " after its timeout"
        : ` after its ${durationLabel(ms)} timeout`
      : "";
  if (state === "backgrounded")
    return [`Handed off to background${after}; completion not observed`, ...handle].join(" · ");
  const vendor = parsed.data.completion_status;
  const reported = vendor && vendor !== "success" ? ` (${vendor})` : "";
  return [
    `Completion reported${reported}; exit code unknown`,
    `handed off to background${after}`,
    ...handle,
  ].join(" · ");
}
