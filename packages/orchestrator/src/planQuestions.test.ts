import { describe, expect, it } from "vitest";
import { extractPlanQuestions } from "./planQuestions.js";

describe("extractPlanQuestions (QA-016 block boundary)", () => {
  it("bounds a structured block to its tagged bullets: appended todo bullets never become questions", () => {
    // The live run-01ab6a470412 shape: three real tagged owner questions, then
    // Cursor's native todos rendered as plain bullets after the authored block.
    const plan = [
      "# Plan",
      "",
      "## Open Questions",
      "",
      "- [single] How should counter state be persisted across sessions? :: Store in localStorage :: Sync in URL query params",
      "- [single] How should invalid persisted values be handled on load? :: Reset to 0 silently :: Show error toast and reset to 0",
      "- [text] Are there any specific storage key names or URL parameter names required?",
      "",
      "- Add persistence functions (loadCount, saveCount) and initialize counter state in src/counter.js",
      "- Add tests for persistence helpers and fallback logic in test/counter.test.js",
    ].join("\n");
    const { parse, questions } = extractPlanQuestions(plan);
    expect(parse).toBe("found");
    // Exactly q1-q3 — the two trailing todo bullets are dropped, not fabricated
    // into q4/q5 free-text questions.
    expect(questions).toHaveLength(3);
    expect(questions.map((q) => q.kind)).toEqual(["single", "single", "text"]);
    expect(questions.some((q) => q.prompt.startsWith("Add persistence functions"))).toBe(false);
    expect(questions.some((q) => q.prompt.startsWith("Add tests"))).toBe(false);
  });

  it("treats `(none)` as terminal: a resolved plan carrying native todos is ready (zero questions)", () => {
    const plan = [
      "## Open Questions",
      "",
      "- (none)",
      "",
      "- Add persistence functions in src/counter.js",
      "- Add tests in test/counter.test.js",
    ].join("\n");
    const { parse, questions } = extractPlanQuestions(plan);
    // A found block with zero questions => `ready`, never `needs_answers`.
    expect(parse).toBe("found");
    expect(questions).toHaveLength(0);
  });

  it("still parses a legitimate multi-question tagged block", () => {
    const plan = [
      "## Open Questions",
      "",
      "- [single] Which database? :: Postgres :: SQLite",
      "- [multi] Which features? :: Auth :: Billing :: Search",
      "- [text] Any deployment constraints?",
    ].join("\n");
    const { parse, questions } = extractPlanQuestions(plan);
    expect(parse).toBe("found");
    expect(questions).toHaveLength(3);
    expect(questions[0]).toMatchObject({ kind: "single", prompt: "Which database?" });
    expect(questions[0]?.options.map((o) => o.label)).toEqual(["Postgres", "SQLite"]);
    expect(questions[1]).toMatchObject({ kind: "multi" });
    expect(questions[1]?.options).toHaveLength(3);
    expect(questions[2]).toMatchObject({ kind: "text", allow_text: true });
    expect(questions[2]?.options).toHaveLength(0);
  });

  it("no `## Open Questions` heading stays unverified (none_found)", () => {
    const plan = ["# Plan", "", "## Steps", "", "- do the thing", "- do the other thing"].join(
      "\n",
    );
    const { parse, questions } = extractPlanQuestions(plan);
    expect(parse).toBe("none_found");
    expect(questions).toHaveLength(0);
  });

  it("preserves tolerant legacy behavior for a wholly-untagged block", () => {
    // No recognized tag anywhere in the block => tolerant mode: a `::`-triple is
    // single-choice, a plain bullet is free text. (Backward-compat, pinned.)
    const plan = [
      "## Open Questions",
      "",
      "- Which runtime? :: Node :: Bun",
      "- What is the intended output format?",
    ].join("\n");
    const { parse, questions } = extractPlanQuestions(plan);
    expect(parse).toBe("found");
    expect(questions).toHaveLength(2);
    expect(questions[0]).toMatchObject({ kind: "single", prompt: "Which runtime?" });
    expect(questions[0]?.options.map((o) => o.label)).toEqual(["Node", "Bun"]);
    expect(questions[1]).toMatchObject({ kind: "text", allow_text: true });
  });

  it("a following heading is still a hard boundary (bullets under it are excluded)", () => {
    const plan = [
      "## Open Questions",
      "",
      "- [single] Which cache backend? :: Redis :: Memcached",
      "",
      "## Native todos",
      "",
      "- wire up the cache client",
      "- add cache tests",
    ].join("\n");
    const { parse, questions } = extractPlanQuestions(plan);
    expect(parse).toBe("found");
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ kind: "single", prompt: "Which cache backend?" });
  });
});
