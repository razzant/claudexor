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
 * #450: what a command-kind tool result established about the PROCESS it
 * ran, separate from `status` (the tool call's own outcome). A background
 * handoff or an elapsed timeout returns an ordinary tool result while the
 * command's end is unobserved, so neither counts as a finished command.
 * Absent on adapters and legacy events that do not report it.
 */
export const ToolCommandOutcome = z
  .object({
    state: z
      .enum(["exited", "timed_out", "backgrounded", "unknown"])
      .describe(
        "exited: the tool observed the command end; timed_out: the tool's timeout elapsed before an observed end (the process may still run or may have been signalled); backgrounded: the command was handed to a background shell and was still running when the result returned; unknown: the native result established none of these.",
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
  })
  .describe("Typed facts about the process a command-kind tool ran, separate from status.");
export type ToolCommandOutcome = z.infer<typeof ToolCommandOutcome>;

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
     * exposed a typed successful retrieval (content/page present); `dispatched`
     * = the tool call completed but the vendor exposes NO typed fetch outcome
     * (codex `web_search`/`open_page` — a completed item can hide a 502), so the
     * evidence is dispatch-only, not proof of content; `failed` = a typed
     * retrieval failure. Absent on non-web tools and on adapters that do not
     * stamp it. The engine reads THIS (never prose) to separate "web reached"
     * from "web verified".
     */
    web_retrieval: z
      .enum(["verified", "dispatched", "failed"])
      .optional()
      .describe(
        "Adapter-stamped web/browser retrieval outcome (verified/dispatched/failed), distinct from the tool-call status lifecycle.",
      ),
  })
  .describe("Typed tool reference attached to tool_call/tool_result events.");
export type ToolRef = z.infer<typeof ToolRef>;

/**
 * True when a result carries command facts that do not establish an observed
 * end: still running in a background shell, timed out, or any other state.
 * Such a result never proves the command finished, so it is never a success
 * or a recovery. Absent facts (other adapters, legacy events) keep their
 * existing meaning; an unrecognized value counts as unconfirmed.
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
 * INV-141), used by adapter result text and ACP. Null when nothing needs
 * disclosure: no facts, or an observed exit.
 */
export function commandOutcomeLabel(value: unknown): string | null {
  if (!commandOutcomeUnconfirmed(value)) return null;
  const parsed = ToolCommandOutcome.safeParse(value);
  if (!parsed.success || parsed.data.state === "unknown") return "Command outcome not reported";
  const { state, timeout_ms: ms, background_reason: reason, shell_id, pid } = parsed.data;
  const handle = [shell_id && `shell ${shell_id}`, pid && `pid ${pid}`].filter(Boolean);
  const lead =
    state === "timed_out"
      ? [
          ms === undefined ? "Timed out" : `Timed out after ${durationLabel(ms)}`,
          "exit status unknown",
        ]
      : reason === "timeout" && ms !== 0
        ? [
            ms === undefined
              ? "Moved to background after its timeout"
              : `Moved to background after ${durationLabel(ms)}`,
            "still running",
          ]
        : ["Running in background"];
  return [...lead, ...handle].join(" · ");
}
