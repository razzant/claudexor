import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  draftFromPlanAndAnswers,
  extractQuestionsFromPlan,
  freezeSpecFromGrounding,
  persistSpec,
} from "./spec.js";

const PLAN = `# SpecPack (plan run-1)

## Intent
fix auth

## Open questions / ambiguities (resolve interactively before \`claudex run\`)
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

  it("keeps missing answers as open clarifications (freeze fails loudly)", async () => {
    await expect(
      freezeSpecFromGrounding("fix auth", PLAN, {
        answers: [{ question_id: "q1", option_ids: [], text: "single-use" }],
      }),
    ).rejects.toThrow(/open clarification/);
  });

  it("freezes and persists a SpecPack + native PLANS.md projection when all questions are answered", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claudex-spec-"));
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
    const specJson = readFileSync(join(persisted.specDir, "spec.json"), "utf8");
    const projection = readFileSync(join(persisted.specDir, "PLANS.md"), "utf8");
    expect(specJson).toContain(spec.id);
    expect(projection).toContain(`Claudex Spec ${spec.id}`);
    expect(projection).toContain("WHEN a magic link is used");
  });

  it("draft builder surfaces every unanswered question as NEEDS_CLARIFICATION", () => {
    const qs = extractQuestionsFromPlan(PLAN);
    const draft = draftFromPlanAndAnswers("fix auth", PLAN, qs, { answers: [] });
    expect(draft.clarifications).toHaveLength(2);
    expect(draft.clarifications?.every((c) => c.status === "open")).toBe(true);
  });
});
