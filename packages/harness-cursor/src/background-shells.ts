import {
  COMMAND_OUTCOME_REFINED,
  commandOutcomeLabel,
  type HarnessEvent,
  ToolCommandCompletionStatus,
  type ToolCommandOutcome,
  type ToolRef,
} from "@claudexor/schema";

/** A shell call whose result handed its command to a background shell. */
interface Handoff {
  tool: Pick<ToolRef, "name" | "kind" | "use_id" | "target">;
  outcome: ToolCommandOutcome;
  /** cursor-agent's chat id on the result frame, when it carried one. */
  nativeSession: string | null;
}

/**
 * #546: cursor-agent reports the end of a command it handed to a background
 * shell in a later `system/task_notification` frame,
 * `{task_id, status, title, [detail], session_id, timestamp_ms}`. Its
 * `task_id` is the result's `shellId` (the frame names no tool call). Its
 * `status` is the vendor's own word, and only `success`, `error` and `aborted`
 * are defined for a shell (2026.08.11); a free-text `detail` may mention
 * `exit_code=N`, but it is not typed proof and is never parsed. The shape
 * follows the sanitized excerpt of one native run in the issue and that build's
 * stream-json writer; no raw frame is recorded, so it stays a hypothesis until
 * a sanitized recording exists.
 *
 * Each pending handoff is kept by shell id after its result. A notification
 * for it becomes one `command_outcome_refined` status for the SAME call: the
 * handoff facts plus `completion_reported` and the vendor status, never an
 * exit code, a call status or a second result. A frame that names no pending
 * handoff of the same native session (an unknown or progress id, a duplicate,
 * a shell id two pending handoffs share) or carries no defined status maps to
 * nothing, consumes nothing and stays counted by the run loop as an
 * unrecognized frame.
 */
export class CursorBackgroundShells {
  /** Pending handoffs by shell id; null marks an id two handoffs share. */
  private readonly pending = new Map<string, Handoff | null>();

  /** Remember a result that handed its command to a background shell. */
  observe(tool: ToolRef, nativeSession: unknown): void {
    const outcome = tool.command_outcome;
    if (outcome?.state !== "backgrounded" || !outcome.shell_id || !tool.use_id) return;
    const { name, kind, use_id, target } = tool;
    const handoff: Handoff = {
      tool: { name, kind, use_id, ...(target === undefined ? {} : { target }) },
      outcome,
      nativeSession: typeof nativeSession === "string" ? nativeSession : null,
    };
    this.pending.set(outcome.shell_id, this.pending.has(outcome.shell_id) ? null : handoff);
  }

  /** The refinement a `system/task_notification` frame proves, or null (unrecognized). */
  completion(frame: Record<string, unknown>, sessionId: string, ts: string): HarnessEvent[] | null {
    const shell = frame["task_id"];
    const status = ToolCommandCompletionStatus.safeParse(frame["status"]);
    if (typeof shell !== "string" || !status.success) return null;
    const handoff = this.pending.get(shell);
    const native = frame["session_id"];
    if (!handoff) return null;
    if (handoff.nativeSession && typeof native === "string" && native !== handoff.nativeSession)
      return null;
    this.pending.delete(shell);
    const command_outcome: ToolCommandOutcome = {
      ...handoff.outcome,
      state: "completion_reported",
      completion_status: status.data,
    };
    return [
      {
        type: "status",
        session_id: sessionId,
        ts,
        text: commandOutcomeLabel(command_outcome) ?? "Command outcome not reported",
        tool: { ...handoff.tool, command_outcome },
        payload: {
          code: COMMAND_OUTCOME_REFINED,
          // The complete native frame is the evidence, kept exactly.
          native_notification: JSON.parse(JSON.stringify(frame)) as unknown,
        },
      },
    ];
  }
}
