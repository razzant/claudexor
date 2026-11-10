import { createInterface } from "node:readline/promises";
import {
  InteractionQuestion as InteractionQuestionSchema,
  type InteractionAnswerSet,
  type InteractionDelivery,
  type InteractionQuestion,
} from "@claudexor/schema";
import { parseChoiceIndexes } from "./choice-input.js";
import type { ControlApiAddress, controlApiFetch } from "./live.js";
import { truncate } from "./live-format.js";

const print = (line: string): void => {
  process.stdout.write(line + "\n");
};

/** What happens to an unanswered question, in the words its delivery allows:
 * a blocking question declines benignly; an async one sends nothing while the
 * agent keeps working. */
function unanswered(delivery: InteractionDelivery): string {
  return delivery === "async"
    ? "nothing is sent and the agent keeps working"
    : "the run continues with assumptions";
}

/** Prompt questions on the controlling TTY. A non-TTY or expired deadline
 * answers nothing: a blocking question then declines benignly so the engine
 * continues with explicit assumptions; an async one simply stays unanswered. */
export async function promptQuestionsOnTty(
  interactionId: string,
  questions: InteractionQuestion[],
  timeoutAt?: string,
  signal?: AbortSignal,
  delivery: InteractionDelivery = "blocking",
): Promise<InteractionAnswerSet | null> {
  if (!process.stdin.isTTY) {
    print(`(question received, but stdin is not a TTY — ${unanswered(delivery)})`);
    return null;
  }
  return collectInteractionAnswers(interactionId, questions, {
    timeoutAt,
    signal,
    delivery,
    reader: createInterface({ input: process.stdin, output: process.stdout }),
  });
}

export interface InteractionQuestionReader {
  question(prompt: string, options?: { signal?: AbortSignal }): Promise<string>;
  close(): void;
}

export interface InteractionPromptOptions {
  timeoutAt?: string;
  signal?: AbortSignal;
  /** Absent = blocking, the historical meaning. */
  delivery?: InteractionDelivery;
  reader: InteractionQuestionReader;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Node coerces a timeout above 2^31-1 ms to 1 ms. Build a cancellable
 * deadline signal from bounded timer chunks so a large finite interaction
 * policy does not close the CLI prompt immediately. */
function finiteDeadlineSignal(delayMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const deadline = Date.now() + delayMs;
  let timer: NodeJS.Timeout | undefined;
  let cancelled = false;
  const arm = () => {
    if (cancelled) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      controller.abort();
      return;
    }
    timer = setTimeout(arm, Math.min(remaining, MAX_TIMER_DELAY_MS));
    timer.unref?.();
  };
  arm();
  return {
    signal: controller.signal,
    cancel: () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** Testable core of the TTY prompt. The caller supplies the reader and a run-
 * lifetime signal, so a disabled deadline can still close on cancel/terminal. */
export async function collectInteractionAnswers(
  interactionId: string,
  questions: InteractionQuestion[],
  options: InteractionPromptOptions,
): Promise<InteractionAnswerSet | null> {
  const { reader, timeoutAt, signal: runSignal } = options;
  const delivery = options.delivery ?? "blocking";
  const deadlineMs = timeoutAt ? Date.parse(timeoutAt) - Date.now() : null;
  if (deadlineMs !== null && (!Number.isFinite(deadlineMs) || deadlineMs <= 0)) {
    // An already-expired deadline must decline immediately — prompting with
    // no signal would hang the TTY forever on a question the engine already
    // timed out (e.g. a historical event replayed by `follow`).
    print(`(question already timed out — ${unanswered(delivery)})`);
    reader.close();
    return null;
  }
  const deadline = deadlineMs === null ? undefined : finiteDeadlineSignal(deadlineMs);
  const signals = [runSignal, deadline?.signal].filter(
    (value): value is AbortSignal => value !== undefined,
  );
  const signal =
    signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  try {
    if (signal?.aborted) return null;
    if (delivery === "async") {
      print("");
      print("(the agent keeps working; this question does not pause it — answer now or leave it)");
    }
    const answers: InteractionAnswerSet["answers"] = [];
    for (const q of questions) {
      print("");
      print(`? ${q.header ? `[${q.header}] ` : ""}${q.question}`);
      q.options.forEach((option, index) =>
        print(
          `   ${index + 1}) ${option.label}${option.description ? ` — ${option.description}` : ""}`,
        ),
      );
      const hint =
        q.options.length > 0
          ? q.multi_select
            ? "numbers separated by commas, or free text"
            : "a number, or free text"
          : "free text";
      // One terminal line. Blank input answers nothing and the choice grammar
      // reads the trimmed text; prose goes out exactly as typed.
      const typed = signal
        ? await reader.question(`   answer (${hint}): `, { signal })
        : await reader.question(`   answer (${hint}): `);
      const trimmed = typed.trim();
      if (!trimmed) continue;
      const picks = parseChoiceIndexes(trimmed, q.options.length, q.multi_select);
      if (picks) {
        answers.push({
          question_id: q.id,
          selected_labels: picks.map((index) => q.options[index]?.label ?? "").filter(Boolean),
          free_text: null,
        });
      } else {
        answers.push({ question_id: q.id, selected_labels: [], free_text: typed });
      }
    }
    return answers.length > 0 ? { interaction_id: interactionId, answers } : null;
  } catch {
    const reason =
      runSignal?.aborted && runSignal.reason && typeof runSignal.reason === "object"
        ? (runSignal.reason as { kind?: unknown }).kind
        : undefined;
    print(
      reason === "interaction_resolved"
        ? "(question resolved — answer prompt closed)"
        : reason === "yield_to_blocking"
          ? "(a blocking question arrived — this prompt is set aside and asked again after it)"
          : runSignal?.aborted
            ? "(run ended — answer prompt closed)"
            : `(answer window closed — ${unanswered(delivery)})`,
    );
    return null;
  } finally {
    deadline?.cancel();
    reader.close();
  }
}

/** An async question's record (absent delivery is a historical blocking one). */
export function asyncDelivery(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)["delivery"] === "async"
  );
}

/** `claudexor follow`'s answer step for one announced question: prompt only while
 * the daemon still lists it, then post the typed answer. */
export async function answerInteractionFromTty(
  fetchControlApi: typeof controlApiFetch,
  addr: ControlApiAddress,
  runId: string,
  ev: Record<string, unknown>,
  signal: AbortSignal,
): Promise<void> {
  const p = (ev["payload"] ?? {}) as Record<string, unknown>;
  const interactionId = typeof p["interaction_id"] === "string" ? p["interaction_id"] : null;
  if (!interactionId) return;
  if (signal.aborted) return;
  const questions = Array.isArray(p["questions"])
    ? p["questions"]
        .map((q) => InteractionQuestionSchema.safeParse(q))
        .filter((r): r is { success: true; data: InteractionQuestion } => r.success)
        .map((r) => r.data)
    : [];
  if (questions.length === 0) return;
  // Replay safety: the events stream replays from seq 1, so historical
  // interaction.requested events arrive for questions long answered or timed
  // out. Only prompt when the daemon still reports this interaction pending
  // (the registry is populated before the event reaches any subscriber, so a
  // LIVE question is always visible here). On a detail fetch failure, fall
  // through — the expired-deadline guard in promptQuestionsOnTty still holds.
  try {
    const detailRes = await fetchControlApi(addr, `/runs/${encodeURIComponent(runId)}`, {
      signal,
    });
    if (detailRes.ok) {
      const detail = (await detailRes.json()) as {
        summary?: { state?: string };
        pendingInteractions?: { interactionId?: string }[];
      };
      const state = detail.summary?.state ?? "";
      const active = state === "running" || state === "queued";
      const stillPending = (detail.pendingInteractions ?? []).some(
        (pi) => pi.interactionId === interactionId,
      );
      if (!active || !stillPending) return;
    }
  } catch {
    if (signal.aborted) return;
    /* fall through to the deadline guard */
  }
  const answers = await promptQuestionsOnTty(
    interactionId,
    questions,
    typeof p["timeout_at"] === "string" ? p["timeout_at"] : undefined,
    signal,
    asyncDelivery(p) ? "async" : "blocking",
  );
  if (!answers || signal.aborted) return;
  const body = {
    answers: answers.answers.map((a) => ({
      questionId: a.question_id,
      selectedLabels: a.selected_labels,
      freeText: a.free_text,
    })),
  };
  const res = await fetchControlApi(
    addr,
    `/runs/${encodeURIComponent(runId)}/interactions/${encodeURIComponent(interactionId)}/answer`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    print(`(answer not delivered: ${res.status}${detail ? ` ${truncate(detail, 120)}` : ""})`);
  }
}
