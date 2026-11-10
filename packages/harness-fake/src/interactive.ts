import type { HarnessEvent, HarnessRunSpec, InteractionRequest } from "@claudexor/schema";
import { interactionChannelFromSpec } from "@claudexor/core";
import { nowIso } from "@claudexor/util";
import { FAKE_TURN_ID, type FakeLiveInput } from "./live-input.js";

/**
 * Deterministic question bodies of `fake-interactive`, never derived from the
 * prompt. The first body is full Unicode and larger than a supervisor's 32 KiB
 * pending-question page, yet its request event still fits one 64 KiB event page.
 */
export const FAKE_INTERACTIVE_FIRST_QUESTION = "Проверка 🙂 确认 ✅ — ".repeat(1_100);
export const FAKE_INTERACTIVE_FIRST_OPTIONS = ["Продолжить 🚀", "Stop"] as const;
/** Pause between the consumed message and the second question, so a supervisor
 * already waiting sees that question arrive during its wait. */
export const FAKE_INTERACTIVE_SECOND_QUESTION_DELAY_MS = 1_500;

function questionRequest(sessionId: string, step: 1 | 2): InteractionRequest {
  return step === 1
    ? {
        interaction_id: `fake-q1-${sessionId}`,
        source_tool: "AskUserQuestion",
        delivery: "blocking",
        questions: [
          {
            id: "q1",
            header: "Fixture ✔",
            question: FAKE_INTERACTIVE_FIRST_QUESTION,
            options: [
              {
                label: FAKE_INTERACTIVE_FIRST_OPTIONS[0],
                description: "Continue the fixture run.",
              },
              { label: FAKE_INTERACTIVE_FIRST_OPTIONS[1], description: null },
            ],
            multi_select: false,
          },
        ],
      }
    : {
        interaction_id: `fake-q2-${sessionId}`,
        source_tool: "AskUserQuestion",
        delivery: "blocking",
        questions: [
          {
            id: "q2",
            header: null,
            question: "Finish the fixture run?",
            options: [{ label: "Finish", description: null }],
            multi_select: false,
          },
        ],
      };
}

/**
 * Supervision fixture: asks a question at once, then parks for ONE live
 * message whose receipt is only `accepted` (consumption is reported later as a
 * `live_input_delivered` status keyed by the message id), then asks a second
 * question and finishes. Answer and message contents are never echoed.
 */
export async function* runFakeInteractive(
  spec: HarnessRunSpec,
  observedModel: string,
  live: FakeLiveInput,
): AsyncIterable<HarnessEvent> {
  const s = spec.session_id;
  const ev = (type: HarnessEvent["type"], extra: Partial<HarnessEvent> = {}): HarnessEvent => ({
    type,
    session_id: s,
    ts: nowIso(),
    ...extra,
  });
  const abort = spec.extra?.["abortSignal"] as AbortSignal | undefined;
  const channel = interactionChannelFromSpec(spec);
  if (!channel) {
    yield ev("error", { error: "fake-interactive requires an interaction channel" });
    yield ev("completed", { observed_model: observedModel });
    return;
  }
  yield ev("thinking", { text: "asking the first fixture question (fake)" });
  await channel.request(questionRequest(s, 1), abort);
  if (abort?.aborted) {
    yield ev("completed", { aborted: true, observed_model: observedModel });
    return;
  }
  yield ev("message", { text: "First fixture question resolved." });
  // Register the waiter before the parking event reaches the journal.
  const parked = live.park(s, abort);
  yield ev("thinking", { text: "waiting for a live message (fake)" });
  const messageId = await parked;
  if (messageId === null) {
    yield ev("completed", { aborted: true, observed_model: observedModel });
    return;
  }
  yield ev("status", {
    text: `live message ${messageId} consumed by turn ${FAKE_TURN_ID}`,
    payload: { code: "live_input_delivered", message_id: messageId, native_turn_id: FAKE_TURN_ID },
  });
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, FAKE_INTERACTIVE_SECOND_QUESTION_DELAY_MS);
    abort?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });
  if (abort?.aborted) {
    yield ev("completed", { aborted: true, observed_model: observedModel });
    return;
  }
  await channel.request(questionRequest(s, 2), abort);
  if (abort?.aborted) {
    yield ev("completed", { aborted: true, observed_model: observedModel });
    return;
  }
  yield ev("message", { text: "Interactive fixture finished." });
  yield ev("usage", { usage: { input_tokens: 100, output_tokens: 50, cost_usd: 0.01 } });
  yield ev("completed", { observed_model: observedModel });
}
