import { commandOutcomeRefinement, ToolRef, type RunEvent } from "@claudexor/schema";
import { newAssistantSource, observeAssistantText } from "./assistant-text-blocks.js";
import { isFinalMessage } from "./final-messages.js";
import { writeOutputArtifact } from "./write-output-artifact.js";

export const EARLIER_ASSISTANT_OUTPUT_PATH = "final/earlier-assistant-output.md";

/** A matched background completion anchors the start, not the end, of the
 * earlier speech. Only the winning physical stream can continue it, through
 * intervening tools and later notifications up to its single typed final. */
export function earlierAssistantOutput(
  events: readonly RunEvent[],
  attempt: string,
): string | null {
  const rows = events.filter(
    ({ type, payload }) =>
      type === "harness.event" &&
      payload["harness_id"] === "cursor" &&
      payload["attempt_id"] === attempt,
  );
  const start = rows.findLastIndex(({ payload }) => payload["type"] === "started");
  const session = rows[start]?.payload["session_id"];
  if (typeof session !== "string" || !session) return null;
  const physical = rows.slice(start).filter(({ payload }) => payload["session_id"] === session);
  const finals = physical.filter(isFinalMessage);
  const complete = physical.findLast(({ payload }) => payload["type"] === "completed");
  const finalSeq = finals[0]?.seq;
  const finalSource = (finals[0]?.payload["payload"] as Record<string, unknown> | undefined)?.[
    "final_source"
  ];
  if (
    finals.length !== 1 ||
    !finalSeq ||
    !complete?.seq ||
    complete.seq <= finalSeq ||
    (finalSource !== "assistant_message" && finalSource !== "result") ||
    physical.some(({ payload }) => payload["type"] === "error" || payload["after_stop"] === true)
  )
    return null;

  const source = newAssistantSource(attempt, "cursor", session);
  const notices: Array<{ after: number; seq: number }> = [];
  const pending = new Map<string, { seq: number; shell: string }>();
  for (const { seq, payload } of physical) {
    if (!seq || seq > finalSeq) break;
    const type = payload["type"];
    if (type === "tool_call" || type === "tool_result" || type === "thinking") {
      if (type === "tool_result") {
        const tool = ToolRef.safeParse(payload["tool"]).data;
        const outcome = tool?.command_outcome;
        if (tool?.use_id && outcome?.state === "backgrounded" && outcome.shell_id)
          pending.set(tool.use_id, { seq, shell: outcome.shell_id });
      }
      observeAssistantText(source, payload, seq);
    } else if (type === "message") {
      const detail = payload["payload"] as Record<string, unknown> | undefined;
      observeAssistantText(
        source,
        detail?.["delivery"] === "async" ? { type: "status" } : payload,
        seq,
      );
    } else {
      const refinement = commandOutcomeRefinement(payload);
      if (refinement) {
        const handoff = pending.get(refinement.useId);
        if (handoff && handoff.shell === refinement.outcome.shell_id) {
          pending.delete(refinement.useId);
          notices.push({ after: handoff.seq, seq });
        }
      }
    }
    // A background notice (or other non-speech telemetry) can arrive between
    // fragments of a word. It doesn't start another assistant message.
  }
  if (!source.answer || notices.length === 0) return null;
  const represented = new Set([source.answer, ...(source.answer.forms ?? [])]);
  const speech = source.blocks.filter((block) => !represented.has(block) && !block.final);
  // Windows may overlap and need not close in the order the commands started.
  let index = 0;
  const first = speech.findIndex((block) => {
    while (notices[index] && notices[index]!.seq <= block.first) index += 1;
    return (
      block.text.trim().length > 0 && notices.slice(index).some(({ after }) => block.first > after)
    );
  });
  if (first === -1) return null;
  const kept = speech.slice(first);
  return `## Earlier assistant text (not the accepted final)\n\nSource: \`events.jsonl\`, attempt \`${attempt}\`, session \`${session}\`.\n\n${kept.map((block) => `### Events ${block.first}–${block.last}\n\n${block.text}`).join("\n\n")}\n`;
}

export function writeEarlierAssistantOutput(
  runDir: string,
  events: readonly RunEvent[],
  attempt: string,
): boolean {
  const text = earlierAssistantOutput(events, attempt);
  if (text === null) return false;
  writeOutputArtifact(runDir, EARLIER_ASSISTANT_OUTPUT_PATH, text);
  return true;
}
