import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  draftFromPlanAndAnswers,
  extractQuestionsFromPlan,
  freezeSpecFromGrounding,
  persistSpec,
  readAnswers,
  validateAnswers,
} from "./spec.js";

const PLAN = `# SpecPack (plan run-1)

## Intent
fix auth

## Open questions / ambiguities (resolve interactively before \`claudexor run\`)
- Should magic links be single-use?
- Which database table owns sessions?

## Other
ignored
`;

describe("spec command helpers", () => {
  it("extracts ambiguity bullets as text quiz questions", () => {
    const qs = extractQuestionsFromPlan(PLAN);
    expect(qs).toHaveLength(2);
    expect(qs[0]?.id).toBe("q1");
    expect(qs[0]?.kind).toBe("text");
    expect(qs[0]?.prompt).toContain("magic links");
  });

  it("parses structured single/multi/text questions WITH answer choices", () => {
    const plan = `# Plan

## Open Questions
- [single] Which auth flow? :: OAuth :: API key :: Both
- [multi] Which platforms? :: iOS :: Android :: Web
- [text] Any naming constraints?
- (none)

## Next
ignored`;
    const qs = extractQuestionsFromPlan(plan);
    expect(qs).toHaveLength(3); // (none) is skipped; "## Next" ends the block

    // single-choice with options
    expect(qs[0]?.kind).toBe("single");
    expect(qs[0]?.prompt).toBe("Which auth flow?");
    expect(qs[0]?.options.map((o) => o.label)).toEqual(["OAuth", "API key", "Both"]);
    expect(qs[0]?.options.map((o) => o.id)).toEqual(["o1", "o2", "o3"]);
    expect(qs[0]?.allow_text).toBe(false); // choice-only

    // multi-choice with options
    expect(qs[1]?.kind).toBe("multi");
    expect(qs[1]?.options).toHaveLength(3);

    // free-text (no options)
    expect(qs[2]?.kind).toBe("text");
    expect(qs[2]?.options).toEqual([]);
    expect(qs[2]?.allow_text).toBe(true);
  });

  it("degrades gracefully: untagged-with-options => single; tagged choice w/o options => text", () => {
    const plan = `## Open Questions
- Pick a store :: Postgres :: SQLite
- [single] No options here`;
    const qs = extractQuestionsFromPlan(plan);
    expect(qs).toHaveLength(2);
    expect(qs[0]?.kind).toBe("single"); // untagged but has "::" options
    expect(qs[0]?.options.map((o) => o.label)).toEqual(["Postgres", "SQLite"]);
    expect(qs[1]?.kind).toBe("text"); // [single] but no options to pick
    expect(qs[1]?.options).toEqual([]);
  });

  it("parses the LAST Open Questions block and skips template placeholders (echoed prompt)", () => {
    // Simulate a harness that echoes the grounding instruction (template block with
    // <placeholder> bullets) BEFORE its real plan + real Open Questions section.
    const plan = `# Plan

## Open Questions
- [single] <question> :: <option A> :: <option B>
- [text] <question that has no good fixed options>

## My Plan
do the thing

## Open Questions
- [single] Which DB? :: Postgres :: SQLite`;
    const qs = extractQuestionsFromPlan(plan);
    expect(qs).toHaveLength(1); // only the real, last block — placeholders skipped
    expect(qs[0]?.prompt).toBe("Which DB?");
    expect(qs[0]?.options.map((o) => o.label)).toEqual(["Postgres", "SQLite"]);
  });

  it("drops leaked placeholder option labels; degrades to text if all options were placeholders", () => {
    const plan = `## Open Questions
- [single] Real question :: <option A> :: Postgres
- [single] Half-edited :: <option A> :: <option B>`;
    const qs = extractQuestionsFromPlan(plan);
    expect(qs).toHaveLength(2);
    expect(qs[0]?.options.map((o) => o.label)).toEqual(["Postgres"]); // "<option A>" dropped
    expect(qs[0]?.kind).toBe("single");
    expect(qs[1]?.options).toEqual([]); // both placeholders dropped
    expect(qs[1]?.kind).toBe("text"); // degraded (nothing to pick)
  });

  it("keeps a legacy untagged bullet with a single :: as ONE free-text question", () => {
    const plan = "## Open Questions\n- Session store :: Redis vs Postgres?";
    const qs = extractQuestionsFromPlan(plan);
    expect(qs).toHaveLength(1);
    expect(qs[0]?.kind).toBe("text"); // not a 1-option choice
    expect(qs[0]?.prompt).toBe("Session store :: Redis vs Postgres?"); // prose preserved
    expect(qs[0]?.options).toEqual([]);
  });

  it("validateAnswers fails loudly on malformed answers", () => {
    const qs = extractQuestionsFromPlan(
      "## Open Questions\n- [single] Which? :: A :: B\n- [text] Notes?",
    );
    // unknown option id
    expect(() => validateAnswers(qs, [{ question_id: "q1", option_ids: ["o9"], text: null }])).toThrow(/unknown option/);
    // single with >1 option
    expect(() => validateAnswers(qs, [{ question_id: "q1", option_ids: ["o1", "o2"], text: null }])).toThrow(/at most one/);
    // free text where allow_text is false (single choice)
    expect(() => validateAnswers(qs, [{ question_id: "q1", option_ids: ["o1"], text: "extra" }])).toThrow(/free text is not allowed/);
    // unknown question id (stale/malformed answer) fails loudly, not silently dropped
    expect(() => validateAnswers(qs, [{ question_id: "q9", option_ids: [], text: "x" }])).toThrow(/unknown question/);
    // duplicate answers for the same question fail loudly (would otherwise silently use the first)
    expect(() => validateAnswers(qs, [
      { question_id: "q1", option_ids: ["o1"], text: null },
      { question_id: "q1", option_ids: ["o2"], text: null },
    ])).toThrow(/duplicate/);
    // valid answers do not throw
    expect(() => validateAnswers(qs, [
      { question_id: "q1", option_ids: ["o1"], text: null },
      { question_id: "q2", option_ids: [], text: "some notes" },
    ])).not.toThrow();
  });

  it("preserves legitimate angle-bracket option labels (only exact templates are dropped)", () => {
    const plan = "## Open Questions\n- [single] Which header? :: <stdio.h> :: <stdlib.h>";
    const qs = extractQuestionsFromPlan(plan);
    expect(qs).toHaveLength(1);
    expect(qs[0]?.kind).toBe("single");
    expect(qs[0]?.options.map((o) => o.label)).toEqual(["<stdio.h>", "<stdlib.h>"]); // NOT dropped
  });

  it("returns [] for an Open Questions section with only (none) or empty", () => {
    expect(extractQuestionsFromPlan("## Open Questions\n- (none)")).toEqual([]);
    expect(extractQuestionsFromPlan("## Open Questions\n- [text] (none)")).toEqual([]); // (none) after a tag
    expect(extractQuestionsFromPlan("## Open Questions\n\n## Next\nignored")).toEqual([]);
    expect(extractQuestionsFromPlan("# Plan\nno questions section here")).toEqual([]);
  });

  it("records a chip-only choice answer as a RESOLVED clarification (not missing)", () => {
    // Regression: a single/multi answer selected via chips carries option_ids and
    // NO free text. It must resolve (so freeze succeeds) AND be recorded.
    const plan = "## Open Questions\n- [single] Which store? :: Postgres :: SQLite";
    const qs = extractQuestionsFromPlan(plan);
    expect(qs[0]?.kind).toBe("single");
    const draft = draftFromPlanAndAnswers("x", plan, qs, {
      answers: [{ question_id: "q1", option_ids: ["o1"], text: null }],
    });
    expect(draft.clarifications?.filter((c) => c.status === "open")).toHaveLength(0); // none missing
    expect(draft.clarifications?.[0]?.status).toBe("resolved");
    expect(draft.clarifications?.[0]?.resolution).toBe("Postgres"); // selected label recorded
    expect(draft.decided_tradeoffs?.some((t) => t.includes("Postgres"))).toBe(true);
  });

  it("freezes a [single] choice answered by chip and persists the selected label", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claudexor-spec-choice-"));
    const plan = "# Plan\n\n## Open Questions\n- [single] Which store? :: Postgres :: SQLite";
    const spec = await freezeSpecFromGrounding("pick a store", plan, {
      answers: [{ question_id: "q1", option_ids: ["o2"], text: null }], // SQLite
    });
    const persisted = persistSpec(repo, spec, plan);
    const specJson = readFileSync(join(persisted.specDir, "spec.json"), "utf8");
    expect(specJson).toContain("SQLite"); // the user's decision is in the frozen contract
  });

  it("keeps missing answers as open clarifications (freeze fails loudly)", async () => {
    await expect(
      freezeSpecFromGrounding("fix auth", PLAN, {
        answers: [{ question_id: "q1", option_ids: [], text: "single-use" }],
      }),
    ).rejects.toThrow(/open clarification/);
  });

  it("freezes and persists a SpecPack + native PLANS.md projection when all questions are answered", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claudexor-spec-"));
    const spec = await freezeSpecFromGrounding("fix auth", PLAN, {
      answers: [
        { question_id: "q1", option_ids: [], text: "single-use" },
        { question_id: "q2", option_ids: [], text: "sessions" },
      ],
      summary: "Fix auth link/session behavior",
      success_criteria: ["WHEN a magic link is used, THE SYSTEM SHALL invalidate it"],
      tests: ["node test.js"],
    });
    const persisted = persistSpec(repo, spec, PLAN);
    // This is exactly the `specPath` the control-api /spec/freeze returns and an
    // Implement run reads — keep the layout (specDir + "/spec.json") locked.
    const specPath = join(persisted.specDir, "spec.json");
    expect(existsSync(specPath)).toBe(true);
    const specJson = readFileSync(specPath, "utf8");
    const projection = readFileSync(join(persisted.specDir, "PLANS.md"), "utf8");
    expect(specJson).toContain(spec.id);
    expect(projection).toContain(`Claudexor Spec ${spec.id}`);
    expect(projection).toContain("WHEN a magic link is used");
  });

  it("draft builder surfaces every unanswered question as NEEDS_CLARIFICATION", () => {
    const qs = extractQuestionsFromPlan(PLAN);
    const draft = draftFromPlanAndAnswers("fix auth", PLAN, qs, { answers: [] });
    expect(draft.clarifications).toHaveLength(2);
    expect(draft.clarifications?.every((c) => c.status === "open")).toBe(true);
  });

  it("answers files preserve planDir/planRunId so freeze reuses the original plan", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-spec-answers-"));
    const path = join(dir, "answers.json");
    const body = {
      prompt: "x",
      planRunId: "run-original",
      planDir: "/tmp/plan-original",
      questions: [{ id: "q1", tier: 0, prompt: "?", kind: "text", options: [], allow_text: true }],
      answers: [{ question_id: "q1", option_ids: [], text: "answer" }],
    };
    // JSON written exactly like claudexor spec's questions.json draft.
    writeFileSync(path, JSON.stringify(body), "utf8");
    const parsed = readAnswers(path);
    expect(parsed.planRunId).toBe("run-original");
    expect(parsed.planDir).toBe("/tmp/plan-original");
    expect(parsed.answers[0]?.question_id).toBe("q1");
  });
});
