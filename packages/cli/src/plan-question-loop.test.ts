import { describe, expect, it, vi } from "vitest";
import { PlanQuestion } from "@claudexor/schema";
import {
  collectPlanAnswers,
  composePlanAnswerPrompt,
  resolvePlanAnswer,
  type PlanAnswerIo,
} from "./plan-question-loop.js";

const q = (
  over: Partial<PlanQuestion> & { id: string; kind: PlanQuestion["kind"] },
): PlanQuestion =>
  PlanQuestion.parse({ prompt: `Q ${over.id}`, options: [], allow_text: false, ...over });

const single = q({
  id: "db",
  kind: "single",
  prompt: "Which database?",
  options: [
    { id: "pg", label: "Postgres" },
    { id: "sqlite", label: "SQLite" },
  ],
});
const multi = q({
  id: "features",
  kind: "multi",
  prompt: "Which features?",
  options: [
    { id: "auth", label: "Auth" },
    { id: "billing", label: "Billing" },
    { id: "search", label: "Search" },
  ],
});
const text = q({ id: "notes", kind: "text", prompt: "Any constraints?", allow_text: true });

describe("resolvePlanAnswer", () => {
  it("single: a numeric pick resolves to ONE option label", () => {
    expect(resolvePlanAnswer(single, "2")).toBe("SQLite");
  });

  it("single: extra picks are ignored — only the first counts", () => {
    expect(resolvePlanAnswer(single, "1,2")).toBe("Postgres");
  });

  it("multi: comma-separated picks resolve to all labels", () => {
    expect(resolvePlanAnswer(multi, "1,3")).toBe("Auth, Search");
  });

  it("text: takes the line verbatim", () => {
    expect(resolvePlanAnswer(text, "must run offline")).toBe("must run offline");
  });

  it("choice question with prose falls back to honest free text", () => {
    expect(resolvePlanAnswer(single, "whatever is cheapest")).toBe("whatever is cheapest");
  });

  it("blank input skips the question (null)", () => {
    expect(resolvePlanAnswer(single, "")).toBeNull();
    expect(resolvePlanAnswer(single, "   ")).toBeNull();
    expect(resolvePlanAnswer(text, "")).toBeNull();
  });

  it("out-of-range numeric is treated as free text, not a crash", () => {
    expect(resolvePlanAnswer(single, "9")).toBe("9");
  });
});

describe("composePlanAnswerPrompt", () => {
  it("numbers each answered question with its resolved answer", () => {
    const prompt = composePlanAnswerPrompt([
      { prompt: "Which database?", answer: "SQLite" },
      { prompt: "Any constraints?", answer: "offline" },
    ]);
    expect(prompt).toContain("1. Which database?");
    expect(prompt).toContain("→ SQLite");
    expect(prompt).toContain("2. Any constraints?");
    expect(prompt).toContain("→ offline");
  });
});

/** A scripted IO answering each prompt in sequence. */
function scriptedIo(answers: string[]): PlanAnswerIo {
  let i = 0;
  return { question: () => Promise.resolve(answers[i++] ?? "") };
}

describe("collectPlanAnswers", () => {
  it("single + multi + text: composes a follow-up prompt with every answer", async () => {
    const prompt = await collectPlanAnswers(
      [single, multi, text],
      scriptedIo(["1", "2,3", "fast"]),
    );
    expect(prompt).not.toBeNull();
    expect(prompt).toContain("→ Postgres");
    expect(prompt).toContain("→ Billing, Search");
    expect(prompt).toContain("→ fast");
  });

  it("skipping EVERY question returns null (nothing to submit)", async () => {
    const prompt = await collectPlanAnswers([single, text], scriptedIo(["", ""]));
    expect(prompt).toBeNull();
  });

  it("partial answers: skipped questions are omitted, answered ones kept", async () => {
    const prompt = await collectPlanAnswers([single, multi, text], scriptedIo(["", "1", ""]));
    expect(prompt).not.toBeNull();
    expect(prompt).toContain("→ Auth");
    expect(prompt).not.toContain("Which database?");
    expect(prompt).not.toContain("Any constraints?");
  });

  it("prompts each question exactly once, in order", async () => {
    const question = vi.fn().mockResolvedValue("");
    await collectPlanAnswers([single, multi, text], { question });
    expect(question).toHaveBeenCalledTimes(3);
  });
});
