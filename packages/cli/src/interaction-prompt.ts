import { createInterface } from "node:readline/promises";
import type { InteractionAnswerSet, InteractionQuestion } from "@claudexor/schema";
import { parseChoiceIndexes } from "./choice-input.js";

const print = (line: string): void => {
  process.stdout.write(line + "\n");
};

/** Prompt questions on the controlling TTY. A non-TTY or expired deadline
 * declines benignly so the engine can continue with explicit assumptions. */
export async function promptQuestionsOnTty(
  interactionId: string,
  questions: InteractionQuestion[],
  timeoutAt?: string,
  signal?: AbortSignal,
): Promise<InteractionAnswerSet | null> {
  if (!process.stdin.isTTY) {
    print("(question received, but stdin is not a TTY — the run continues with assumptions)");
    return null;
  }
  return collectInteractionAnswers(interactionId, questions, {
    timeoutAt,
    signal,
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
  const deadlineMs = timeoutAt ? Date.parse(timeoutAt) - Date.now() : null;
  if (deadlineMs !== null && (!Number.isFinite(deadlineMs) || deadlineMs <= 0)) {
    // An already-expired deadline must decline immediately — prompting with
    // no signal would hang the TTY forever on a question the engine already
    // timed out (e.g. a historical event replayed by `follow`).
    print("(question already timed out — the run continues with assumptions)");
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
    const resolvedElsewhere =
      runSignal?.aborted &&
      runSignal.reason &&
      typeof runSignal.reason === "object" &&
      (runSignal.reason as { kind?: unknown }).kind === "interaction_resolved";
    print(
      resolvedElsewhere
        ? "(question resolved — answer prompt closed)"
        : runSignal?.aborted
          ? "(run ended — answer prompt closed)"
          : "(answer window closed — the run continues with assumptions)",
    );
    return null;
  } finally {
    deadline?.cancel();
    reader.close();
  }
}
