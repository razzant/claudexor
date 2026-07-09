import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  draftFromPlanAndAnswers,
  extractQuestionsFromPlan,
  freezeSpecFromGrounding,
  loadFrozenSpec,
  persistSpec,
  readAnswers,
  resolveRunTestCommands,
  validateAnswers,
} from "./spec.js";

const PLAN = `# SpecPack (plan run-1)

## Intent
fix auth

## Open questions / ambiguities (resolve interactively before \`claudexor agent\`)
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

  it("picks the harness interview block, NOT the echoed instruction or review-findings (real grounding plan)", () => {
    // Reproduces a real grounding plan.md: (1) echoed grounding INSTRUCTION with the
    // placeholder template + Rules, (2) the harness's REAL interview, (3) an
    // orchestrator-appended review-findings "Open questions" carrying a NEEDS_HUMAN
    // error. The interview must surface the REAL block, not the error.
    const plan = `# Plan

## Open Questions

List 2–6 of the MOST important open decisions, one per bullet, in EXACTLY this format:

- [single] <question> :: <option A> :: <option B> :: <option C>
- [text] <question that has no good fixed options>

Rules:
- [single] = pick exactly one; [multi] = pick one or more; [text] = free-form (no "::" options).

## Plan
do the work

## Open Questions
- [single] How to organize the code? :: keep it in src/main.js :: split into src/*.js
- [multi] Which combat actions in v1? :: melee :: dash :: ranged

## Review findings
- 🟠 NEEDS_HUMAN: The declared patch identity does not match the artifact on disk: ... 10550 bytes vs 10551 bytes.

## Open questions
- The declared patch identity does not match the artifact on disk: DIFF_SHA256.txt declares sha256:66713e and 10550 bytes, but recomputing DIFF.patch produced sha256:f8a439 and 10551 bytes.`;
    const qs = extractQuestionsFromPlan(plan);
    expect(qs).toHaveLength(2);
    expect(qs[0]?.prompt).toBe("How to organize the code?");
    expect(qs[0]?.kind).toBe("single");
    expect(qs[1]?.kind).toBe("multi");
    // The review-findings patch error must NOT appear as a question.
    expect(qs.some((q) => q.prompt.includes("patch identity"))).toBe(false);
  });

  it("keeps a legacy free-text interview block before review-findings questions", () => {
    const plan = `# Plan

## Open Questions
- Which session store should own refresh-token state?

## Review findings
- NEEDS_HUMAN: The implementation evidence is incomplete.

## Open questions
- The implementation evidence is incomplete.
- The patch identity needs human review.`;
    const qs = extractQuestionsFromPlan(plan);
    expect(qs).toHaveLength(1);
    expect(qs[0]?.prompt).toBe("Which session store should own refresh-token state?");
    expect(qs.some((q) => q.prompt.includes("patch identity"))).toBe(false);
  });

  it("keeps review-findings context sticky across intervening headings", () => {
    const plan = `# Plan

## Open Questions
- Which session store should own refresh-token state?

## Review findings
- NEEDS_HUMAN: The implementation evidence is incomplete.

## Summary
Review blocked on evidence.

## Open questions
- The implementation evidence is incomplete.
- The patch identity needs human review.`;
    const qs = extractQuestionsFromPlan(plan);
    expect(qs).toHaveLength(1);
    expect(qs[0]?.prompt).toBe("Which session store should own refresh-token state?");
    expect(qs.some((q) => q.prompt.includes("patch identity"))).toBe(false);
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

  it("loads a frozen SpecPack for run commands with resolved path and hash", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claudexor-spec-load-"));
    const spec = await freezeSpecFromGrounding("fix auth", PLAN, {
      answers: [
        { question_id: "q1", option_ids: [], text: "single-use" },
        { question_id: "q2", option_ids: [], text: "sessions" },
      ],
    });
    const persisted = persistSpec(repo, spec, PLAN);
    const specPath = join(persisted.specDir, "spec.json");
    const loaded = loadFrozenSpec(specPath);

    expect(loaded.spec.id).toBe(spec.id);
    expect(loaded.specPath).toBe(realpathSync(specPath));
    expect(loaded.specHash).toBe(persisted.specHash);
  });

  it("uses frozen SpecPack tests when run has no explicit --test flags", async () => {
    const spec = await freezeSpecFromGrounding("fix auth", PLAN, {
      answers: [
        { question_id: "q1", option_ids: [], text: "single-use" },
        { question_id: "q2", option_ids: [], text: "sessions" },
      ],
      tests: ["node test.js", "pnpm verify"],
    });

    expect(resolveRunTestCommands([], spec)).toEqual(["node test.js", "pnpm verify"]);
    expect(resolveRunTestCommands(["pnpm explicit"], spec)).toEqual(["pnpm explicit"]);
    expect(resolveRunTestCommands([], null)).toBeUndefined();
  });

  it("fails loudly when a run --spec file is missing, malformed, or schema-invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-spec-invalid-"));
    expect(() => loadFrozenSpec(join(dir, "missing.json"))).toThrow(/cannot read --spec/);

    const malformed = join(dir, "malformed.json");
    writeFileSync(malformed, "{", "utf8");
    expect(() => loadFrozenSpec(malformed)).toThrow(/invalid --spec '.*' JSON/);

    const invalid = join(dir, "invalid.json");
    writeFileSync(invalid, JSON.stringify({ schema_version: "1.0.0" }), "utf8");
    expect(() => loadFrozenSpec(invalid)).toThrow(/invalid --spec '.*' schema/);
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

describe("commit-review panel lib", () => {
  it("isBlockingSeverity accepts both the gate vocabulary and Claudexor-native blocking severities", async () => {
    const { isBlockingSeverity } = await import("../../../scripts/lib/openrouter-panel.mjs");
    for (const s of ["FAIL", "fail", "BLOCK", "FIX_FIRST", "NEEDS_HUMAN"]) expect(isBlockingSeverity(s)).toBe(true);
    for (const s of ["WARN", "NIT", "", undefined]) expect(isBlockingSeverity(s)).toBe(false);
  });

  it("parseFindingsArray handles bare arrays, tight fences, and garbage", async () => {
    const { parseFindingsArray } = await import("../../../scripts/lib/openrouter-panel.mjs");
    expect(parseFindingsArray('[{"severity":"FAIL","finding":"x"}]').findings).toHaveLength(1);
    // Standard markdown WITHOUT trailing newline before the closing fence.
    expect(parseFindingsArray('```json\n[{"severity":"WARN","finding":"y"}]```').findings).toHaveLength(1);
    expect(parseFindingsArray("no json at all").findings).toBeNull();
    expect(parseFindingsArray('```json\n{"not":"array"}\n```').findings).toBeNull();
    // Quorum shape: junk arrays are UNUSABLE, empty arrays are a clean pass,
    // and finding-shaped items survive filtering.
    expect(parseFindingsArray('[{"unrelated":"junk"},{"foo":1}]').findings).toBeNull();
    // STRICT: half-junk arrays are unusable too (a mixed response is untrustworthy).
    expect(parseFindingsArray('[{"severity":"WARN","finding":"real"},{"junk":1}]').findings).toBeNull();
    expect(parseFindingsArray("[]").findings).toEqual([]);
    expect(parseFindingsArray('[{"severity":"WARN","claim":"uses claim key"}]').findings).toHaveLength(1);
  });
});
