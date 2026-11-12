import {
  commandOutcomeLabel,
  commandOutcomeRefinement,
  commandOutcomeUnconfirmed,
} from "@claudexor/schema";

const textContent = (text: string) => [
  { type: "content" as const, content: { type: "text" as const, text } },
];

/**
 * The run and try a stored run event names (`run_id`, then the harness
 * payload's `attempt_id` and `session_id`), each part URI-encoded and joined;
 * "" for an event without them (a custom runner's).
 */
export function acpToolOwner(event: unknown): string {
  const row = (event ?? {}) as {
    run_id?: unknown;
    payload?: { attempt_id?: unknown; session_id?: unknown } | null;
  };
  return [row.run_id, row.payload?.attempt_id, row.payload?.session_id]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .map(encodeURIComponent)
    .join("/");
}

/**
 * The ACP call id of a native tool use (X2). ACP needs a call id unique in its
 * session, while a native id is unique only in the try that issued it: two tries
 * of a race, or two turns, may repeat it. So the id names its owner, and the
 * same call keeps it from open through close to refinement. An event without
 * an owner keeps the bare native id.
 */
export function acpToolCallId(owner: string, useId: string): string {
  return owner ? `${owner}/${encodeURIComponent(useId)}` : useId;
}

/**
 * The ACP `tool_call_update` for one normalized tool result. ACP v1 has two
 * terminal tool statuses: `completed` ("completed successfully") and `failed`.
 * A command handed to a background shell, timed out, or in an unknown state did
 * not complete successfully and no later frame is guaranteed for its call, so
 * it closes as `failed`, with the typed state as the call's text content and
 * `_meta.claudexor.commandOutcome` (#450). `in_progress` would leave the client
 * waiting for an update that may never come.
 */
export function toolResultUpdate(toolCallId: string, tool: Record<string, unknown>) {
  const outcome = tool["command_outcome"];
  const label = commandOutcomeLabel(outcome);
  return {
    sessionUpdate: "tool_call_update" as const,
    toolCallId,
    status:
      tool["status"] === "error" || commandOutcomeUnconfirmed(outcome)
        ? ("failed" as const)
        : ("completed" as const),
    ...(label
      ? { content: textContent(label), _meta: { claudexor: { commandOutcome: outcome } } }
      : {}),
  };
}

/**
 * #546: the calls of each ACP session that closed as a background handoff, so a
 * later `command_outcome_refined` status of the same try reaches exactly that
 * existing call, once, and replaces its stale "completion not observed". The
 * server forgets them when the turn that opened them ends. In the ACP schema all
 * `tool_call_update` fields but the id are optional ("only changed fields need
 * to be included") and `content` is "Replace the content collection". So the
 * update carries content and `_meta` alone: omitting `status` keeps the terminal
 * `failed`, because a report without an exit code is no `completed` success, and
 * nothing is reopened or sent as a second result.
 */
export class AcpClosedHandoffs {
  private readonly calls = new Set<string>();

  /** Remember a call `toolResultUpdate` closed as a background handoff. */
  closed(sessionId: string, toolCallId: string, tool: Record<string, unknown>): void {
    const outcome = tool["command_outcome"] as { state?: unknown } | null | undefined;
    if (outcome?.state === "backgrounded") this.calls.add(`${sessionId}\0${toolCallId}`);
  }

  /** The partial update for a report naming a handoff its own try closed in this
   * session, else null. `event` is the run event; its payload is the report. */
  refinement(sessionId: string, event: unknown) {
    const refined = commandOutcomeRefinement((event as { payload?: unknown } | null)?.payload);
    if (!refined) return null;
    const toolCallId = acpToolCallId(acpToolOwner(event), refined.useId);
    if (!this.calls.delete(`${sessionId}\0${toolCallId}`)) return null;
    return {
      sessionUpdate: "tool_call_update" as const,
      toolCallId,
      content: textContent(commandOutcomeLabel(refined.outcome) ?? ""),
      _meta: { claudexor: { commandOutcome: refined.outcome } },
    };
  }

  drop(sessionId: string): void {
    for (const key of this.calls) if (key.startsWith(`${sessionId}\0`)) this.calls.delete(key);
  }
}
