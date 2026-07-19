import { describe, expect, it } from "vitest";
import { renderPlanQuestions, type AcpPlanQuestion } from "./prompt.js";

describe("renderPlanQuestions (ACP plan-question turn text, D14)", () => {
  it("returns empty string for no questions", () => {
    expect(renderPlanQuestions([])).toBe("");
  });

  it("numbers questions, inlines options, and marks kind (single/multi/text)", () => {
    const questions: AcpPlanQuestion[] = [
      {
        id: "db",
        kind: "single",
        prompt: "Which database?",
        options: [
          { id: "pg", label: "Postgres" },
          { id: "sqlite", label: "SQLite" },
        ],
      },
      {
        id: "features",
        kind: "multi",
        prompt: "Which features?",
        options: [
          { id: "auth", label: "Auth" },
          { id: "billing", label: "Billing" },
        ],
      },
      { id: "notes", kind: "text", prompt: "Constraints?", allow_text: true },
    ];
    const text = renderPlanQuestions(questions);
    expect(text).toContain("3 open questions");
    expect(text).toContain("1. Which database? (choose one)");
    expect(text).toContain("   a) Postgres");
    expect(text).toContain("   b) SQLite");
    expect(text).toContain("2. Which features? (choose one or more)");
    expect(text).toContain("3. Constraints? (free text)");
  });

  it("uses singular grammar for exactly one question", () => {
    const text = renderPlanQuestions([{ id: "q", kind: "text", prompt: "Why?" }]);
    expect(text).toContain("1 open question.");
    expect(text).toContain("Answer it");
  });
});
