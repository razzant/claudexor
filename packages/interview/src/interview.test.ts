import { describe, expect, it } from "vitest";
import type { InterviewAnswer, InterviewQuestion } from "@claudexor/schema";
import { SpecPack as SpecPackSchema } from "@claudexor/schema";
import {
  InterviewEngine,
  InterviewNotConvergedError,
  type QuestionGenerator,
  type SpecAssembler,
  SpecNotReadyError,
  UnresolvedClarificationsError,
  diffSpecPacks,
  specPackToTaskContract,
} from "./index.js";

// A two-tier deterministic generator: tier 0 asks one question, tier 1 converges.
const twoTierGenerator: QuestionGenerator = async (state) => {
  if (state.tier === 0) {
    return [
      {
        id: "q1",
        tier: 0,
        prompt: "Storage?",
        kind: "single",
        options: [
          { id: "sql", label: "SQL" },
          { id: "kv", label: "KV" },
        ],
        allow_text: false,
      } as InterviewQuestion,
    ];
  }
  return [];
};

const cleanAssembler: SpecAssembler = async (state) => ({
  summary: `Use ${state.answers[0]?.option_ids[0] ?? "?"} storage`,
  success_criteria: [
    { id: "ac1", behavior: "WHEN a record is saved, THE SYSTEM SHALL persist it", required: true },
  ],
  tasks: [{ id: "t1", title: "Implement storage", depends_on: [], done: false }],
  tests: [{ id: "g1", command: "pnpm test", required: true }],
});

describe("InterviewEngine", () => {
  it("runs tiers to convergence, assembles, freezes, and maps to a TaskContract", async () => {
    const engine = new InterviewEngine({
      intent: "add storage",
      generator: twoTierGenerator,
      assembler: cleanAssembler,
    });
    await engine.runToConvergence((qs): InterviewAnswer[] =>
      qs.map((q) => ({ question_id: q.id, option_ids: ["sql"], text: null })),
    );
    const spec = engine.freeze();
    expect(spec.frozen).toBe(true);
    expect(spec.version).toBe(1);
    expect(spec.summary).toContain("sql");
    expect(spec.interview.questions).toHaveLength(1);
    expect(spec.interview.answers).toHaveLength(1);

    const contract = specPackToTaskContract(spec, { repoRoot: "/tmp/repo", mode: "agent" });
    expect(contract.user_intent.raw).toBe("add storage");
    expect(contract.success_criteria[0]?.text).toContain("THE SYSTEM SHALL");
    expect(contract.tests.commands[0]?.command).toBe("pnpm test");
  });

  it("refuses to freeze while a clarification is open (no silent guessing)", async () => {
    const ambiguousAssembler: SpecAssembler = async () => ({
      summary: "ambiguous",
      clarifications: [
        { id: "c1", claim: "single-use or reusable token?", status: "open", resolution: null },
      ],
    });
    const engine = new InterviewEngine({
      intent: "auth",
      generator: twoTierGenerator,
      assembler: ambiguousAssembler,
    });
    await engine.runToConvergence((qs) =>
      qs.map((q) => ({ question_id: q.id, option_ids: ["sql"], text: null })),
    );

    expect(() => engine.freeze()).toThrow(UnresolvedClarificationsError);
    expect(engine.openClarifications()).toHaveLength(1);

    engine.resolveClarification("c1", "single-use");
    const spec = engine.freeze();
    expect(spec.frozen).toBe(true);
    expect(spec.open_questions[0]?.status).toBe("resolved");
  });

  it("fails loudly when the tier cap is hit without convergence (no incomplete freeze)", async () => {
    const neverConverges: QuestionGenerator = async (state) => [
      {
        id: `q${state.tier}`,
        tier: state.tier,
        prompt: "?",
        kind: "single",
        options: [],
        allow_text: true,
      } as InterviewQuestion,
    ];
    const engine = new InterviewEngine({
      intent: "x",
      generator: neverConverges,
      assembler: cleanAssembler,
      maxTiers: 3,
    });
    await expect(
      engine.runToConvergence((qs) =>
        qs.map((q) => ({ question_id: q.id, option_ids: [], text: "y" })),
      ),
    ).rejects.toBeInstanceOf(InterviewNotConvergedError);
    expect(engine.isConverged()).toBe(false);
  });

  it("reuses a stable spec id and auto-increments version across freezes", async () => {
    const engine = new InterviewEngine({
      intent: "x",
      generator: twoTierGenerator,
      assembler: cleanAssembler,
    });
    await engine.runToConvergence((qs) =>
      qs.map((q) => ({ question_id: q.id, option_ids: ["sql"], text: null })),
    );
    const v1 = engine.freeze();
    const v2 = engine.freeze();
    expect(v1.id).toBe(v2.id); // spec-anchored: same id across revisions
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
  });

  it("schema rejects a frozen-but-ambiguous spec and a resolved-without-resolution item", () => {
    const base = {
      schema_version: 2,
      id: "spec-x",
      created_at: new Date().toISOString(),
      version: 1,
      intent: { raw: "x" },
    };
    // frozen + an open clarification -> invalid at the schema (SSOT) level
    expect(() =>
      SpecPackSchema.parse({
        ...base,
        frozen: true,
        open_questions: [{ id: "c1", claim: "?", status: "open", resolution: null }],
      }),
    ).toThrow();
    // resolved but no resolution -> invalid
    expect(() =>
      SpecPackSchema.parse({
        ...base,
        frozen: false,
        open_questions: [{ id: "c1", claim: "?", status: "resolved", resolution: null }],
      }),
    ).toThrow();
  });

  it("maps fail loudly for a non-frozen spec", async () => {
    const engine = new InterviewEngine({
      intent: "x",
      generator: twoTierGenerator,
      assembler: cleanAssembler,
    });
    await engine.runToConvergence((qs) =>
      qs.map((q) => ({ question_id: q.id, option_ids: ["sql"], text: null })),
    );
    const spec = engine.freeze();
    const notFrozen = { ...spec, frozen: false };
    expect(() => specPackToTaskContract(notFrozen, { repoRoot: "/tmp" })).toThrow(
      SpecNotReadyError,
    );
  });

  it("produces a section-level diff across revisions", async () => {
    const v1Engine = new InterviewEngine({
      intent: "x",
      generator: twoTierGenerator,
      assembler: cleanAssembler,
    });
    await v1Engine.runToConvergence((qs) =>
      qs.map((q) => ({ question_id: q.id, option_ids: ["sql"], text: null })),
    );
    const v1 = v1Engine.freeze();

    const v2Engine = new InterviewEngine({
      intent: "x",
      generator: twoTierGenerator,
      assembler: async () => ({
        summary: "Use kv storage",
        success_criteria: [
          {
            id: "ac1",
            behavior: "WHEN a record is saved, THE SYSTEM SHALL persist it",
            required: true,
          },
        ],
        tasks: [
          { id: "t1", title: "Implement storage", depends_on: [], done: false },
          { id: "t2", title: "Add cache", depends_on: ["t1"], done: false },
        ],
        tests: [{ id: "g1", command: "pnpm test", required: true }],
      }),
    });
    await v2Engine.runToConvergence((qs) =>
      qs.map((q) => ({ question_id: q.id, option_ids: ["kv"], text: null })),
    );
    const v2 = v2Engine.freeze();

    const changes = diffSpecPacks(v1, v2);
    expect(changes.some((c) => c.field === "summary" && c.kind === "changed")).toBe(true);
    expect(
      changes.some((c) => c.field === "tasks" && c.kind === "added" && c.after === "Add cache"),
    ).toBe(true);
  });
});
