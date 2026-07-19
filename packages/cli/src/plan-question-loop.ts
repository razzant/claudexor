/**
 * CLI plan question loop (D17/D31): when a plan turn ends `needs_answers`, an
 * interactive TTY offers to answer the ENGINE-parsed typed questions inline and
 * submits the answers as an ordinary FOLLOW-UP PLAN TURN (POST /threads/:id/
 * turns) — the same server path every surface uses, the same lane, no separate
 * answer channel. Answers ride the plan turn prompt; the planner reads them and
 * re-derives readiness. Non-TTY/--json is unchanged (readiness + guidance only).
 *
 * The composition core is pure so single/multi/text/skip paths are unit-tested
 * without a live daemon or TTY.
 */
import { createInterface } from "node:readline/promises";
import type { PlanQuestion } from "@claudexor/schema";
import { print } from "./cli-io.js";
import {
  enqueueAndAwait,
  fetchOutcomeBanner,
  fetchPlanQuestions,
  fetchPlanReadiness,
} from "./daemon-run.js";
import { followRun, type ControlApiAddress } from "./live.js";

/** One question's resolved answer text, or null to SKIP it (blank input). */
export function resolvePlanAnswer(question: PlanQuestion, raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null; // blank = skip this question
  // Free-text questions (and any option-less question) take the line verbatim.
  if (question.kind === "text" || question.options.length === 0) return trimmed;
  // single/multi: numeric picks (1-based) resolve to option labels; anything
  // that is not a clean pick list is honest free text (the planner reads prose).
  const parts = trimmed.split(",").map((part) => part.trim());
  const picks = parts
    .map((part) => Number.parseInt(part, 10))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= question.options.length);
  const allNumeric = picks.length > 0 && picks.length === parts.length;
  if (!allNumeric) return trimmed;
  const labels = picks.map((n) => question.options[n - 1]?.label ?? "").filter(Boolean);
  // single-choice keeps only the first pick; multi keeps them all.
  const chosen = question.kind === "single" ? labels.slice(0, 1) : labels;
  return chosen.length > 0 ? chosen.join(", ") : trimmed;
}

/** Build the follow-up plan-turn prompt from the answered questions. */
export function composePlanAnswerPrompt(answered: { prompt: string; answer: string }[]): string {
  const body = answered.map((a, index) => `${index + 1}. ${a.prompt}\n   → ${a.answer}`).join("\n");
  return (
    `Here are my answers to the plan's open questions:\n\n${body}\n\n` +
    `Please revise the plan with these answers and re-list any questions that remain open.`
  );
}

/** Minimal input surface so the loop is testable without a real readline. */
export interface PlanAnswerIo {
  question(prompt: string): Promise<string>;
}

/**
 * Prompt each open question and compose the follow-up plan-turn prompt. Returns
 * null when the user skips every question (nothing to submit). Pure over `io`.
 */
export async function collectPlanAnswers(
  questions: PlanQuestion[],
  io: PlanAnswerIo,
): Promise<string | null> {
  const answered: { prompt: string; answer: string }[] = [];
  for (const q of questions) {
    print("");
    const kindTag =
      q.kind === "multi" ? "  (choose one or more)" : q.kind === "text" ? "  (free text)" : "";
    print(`? ${q.prompt}${kindTag}`);
    q.options.forEach((o, idx) => print(`   ${idx + 1}) ${o.label}`));
    const hint =
      q.options.length === 0
        ? "free text, or blank to skip"
        : q.kind === "multi"
          ? "numbers separated by commas, free text, or blank to skip"
          : "a number, free text, or blank to skip";
    const raw = await io.question(`   answer (${hint}): `);
    const resolved = resolvePlanAnswer(q, raw);
    if (resolved !== null) answered.push({ prompt: q.prompt, answer: resolved });
  }
  return answered.length > 0 ? composePlanAnswerPrompt(answered) : null;
}

/**
 * TTY wrapper: prompt on the controlling terminal. Returns null on a non-TTY
 * stdin, an empty question set, or when the user skips everything — the caller
 * then keeps today's readiness guidance untouched.
 */
export async function promptPlanAnswersOnTty(questions: PlanQuestion[]): Promise<string | null> {
  if (!process.stdin.isTTY || questions.length === 0) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await collectPlanAnswers(questions, { question: (prompt) => rl.question(prompt) });
  } catch {
    // Ctrl-C / closed input: leave the plan as-is, print no answers.
    return null;
  } finally {
    rl.close();
  }
}

/** Print the server-derived plan readiness (D17) — one derivation owner. */
export function printPlanReadiness(
  readiness: { state: string; questionCount: number } | null,
): void {
  if (readiness?.state === "needs_answers") {
    print(
      `  plan needs answers: ${readiness.questionCount} open question(s) — answer in a follow-up plan turn, then implement`,
    );
  } else if (readiness?.state === "unverified") {
    print(`  plan questions unverified: the planner emitted no tagged Open Questions block`);
  } else if (readiness?.state === "ready") {
    print(`  plan ready: no open questions`);
  }
}

/**
 * Plan question loop (D17/D31): print the plan's derived readiness, then — on
 * an interactive TTY plan turn that belongs to a THREAD (a lane to continue) —
 * offer to answer the typed questions inline and submit them as a FOLLOW-UP
 * PLAN TURN through the same POST /threads/:id/turns path. Returns the latest
 * plan run id (advanced past each answered round). Non-TTY / thread-less / --json
 * turns just print readiness and return the original run id (behavior unchanged).
 */
export async function runPlanQuestionLoop(opts: {
  client: Parameters<typeof enqueueAndAwait>[0];
  addr: ControlApiAddress;
  threadId: string | undefined;
  runId: string;
  interactive: boolean;
}): Promise<string> {
  const { client, addr, threadId, interactive } = opts;
  let currentRunId = opts.runId;
  let readiness = await fetchPlanReadiness(addr, currentRunId);
  printPlanReadiness(readiness);
  if (!interactive || !threadId || !process.stdin.isTTY) return currentRunId;
  // Bounded rounds: each round submits one follow-up plan turn with the answers
  // and re-reads readiness; the user can skip out at any prompt (blank input).
  for (let round = 0; round < 5 && readiness?.state === "needs_answers"; round += 1) {
    const questions = await fetchPlanQuestions(addr, currentRunId);
    const answerPrompt = await promptPlanAnswersOnTty(questions);
    if (!answerPrompt) break; // skipped every question — leave the plan as-is
    print("");
    print("  submitting answers as a follow-up plan turn...");
    const next = await enqueueAndAwait(
      client,
      addr,
      {
        prompt: answerPrompt,
        mode: "plan",
        threadId,
        scope: { kind: "project", root: process.cwd() },
        execution: { isolation: "envelope" },
      },
      { waitForTerminal: false },
    );
    if (!next.runId) {
      print(
        `  follow-up turn did not start: ${next.status}${next.error ? ` — ${next.error}` : ""}`,
      );
      break;
    }
    await followRun(next.runId, false);
    const nextFinal = next.jobId ? await client.status(next.jobId) : null;
    const nextStatus = nextFinal?.state ?? next.status;
    print("");
    print(`run ${next.runId} [${nextStatus}]`);
    const nextBanner = await fetchOutcomeBanner(addr, next.runId);
    if (nextBanner) print(`  ${nextBanner}`);
    print(`  artifacts: ${nextFinal?.runDir ?? next.runDir}`);
    currentRunId = next.runId;
    readiness = await fetchPlanReadiness(addr, currentRunId);
    printPlanReadiness(readiness);
  }
  return currentRunId;
}
