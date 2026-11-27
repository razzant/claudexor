import { commandOutcomeRefinement, type RunEvent } from "@claudexor/schema";
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
  let after = rows[start]?.seq ?? 0;
  for (const { seq, payload } of physical) {
    if (!seq || seq > finalSeq) break;
    const type = payload["type"];
    if (type === "tool_call" || type === "tool_result") {
      after = seq;
      observeAssistantText(source, payload, seq);
    } else if (commandOutcomeRefinement(payload)) {
      notices.push({ after, seq });
    } else if (type === "message") {
      const detail = payload["payload"] as Record<string, unknown> | undefined;
      observeAssistantText(
        source,
        detail?.["delivery"] === "async" ? { type: "status" } : payload,
        seq,
      );
    }
    // A background notice (or other non-speech telemetry) can arrive between
    // fragments of a word. It doesn't start another assistant message.
  }
  if (!source.answer || notices.length === 0) return null;
  const represented = new Set([source.answer, ...(source.answer.forms ?? [])]);
  const speech = source.blocks.filter((block) => !represented.has(block) && !block.final);
  let candidate = 0;
  const first = speech.findIndex((block) => {
    while (notices[candidate] && notices[candidate]!.seq <= block.first) candidate += 1;
    const notice = notices[candidate];
    return notice && block.first > notice.after && block.text.trim().length > 0;
  });
  if (first === -1) return null;
  const kept = speech.slice(first);
  return `## Earlier assistant text (not the accepted final)\n\nSource: \`events.jsonl\`, attempt \`${attempt}\`, session \`${session}\`.\n\n${kept.map((block) => `### Events ${block.first}–${block.last}\n\n${block.text}`).join("\n\n")}\n`;
}

export function writeEarlierAssistantOutput(
  runDir: string,
  events: readonly RunEvent[],
  attempt: string,
): void {
  const text = earlierAssistantOutput(events, attempt);
  if (text !== null) writeOutputArtifact(runDir, EARLIER_ASSISTANT_OUTPUT_PATH, text);
}
