import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { assertPlanImplementReady, planImplementReadiness } from "./plan-implement-readiness.js";

// W-h: reap every temp dir this suite creates so the gate stops leaking tmpdirs.
const reapDirs: string[] = [];
function reapMk(...args: Parameters<typeof mkdtempSync>): string {
  const dir = mkdtempSync(...args);
  reapDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of reapDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Materialize a plan run's final/ dir with a questions.json and return the
 * planRef path (the sibling final/plan.md the runner receives). */
function planRefWithQuestions(questions: string | null): string {
  const finalDir = reapMk(join(tmpdir(), "cdx-plan-ready-"));
  if (questions !== null) writeFileSync(join(finalDir, "questions.json"), questions);
  const planPath = join(finalDir, "plan.md");
  writeFileSync(planPath, "# Plan\n");
  return planPath;
}

describe("plan-implement-readiness — run-start readiness gate (QA-045)", () => {
  it("derives needs_answers from a tagged block with open questions", () => {
    const planPath = planRefWithQuestions(
      JSON.stringify({
        parse: "found",
        questions: [
          { id: "q1", kind: "single", prompt: "How to store it?", options: [], allow_text: false },
        ],
      }),
    );
    expect(planImplementReadiness(planPath)).toEqual({ state: "needs_answers", questionCount: 1 });
  });

  it("derives ready when the block parsed with zero open questions", () => {
    const planPath = planRefWithQuestions(JSON.stringify({ parse: "found", questions: [] }));
    expect(planImplementReadiness(planPath)).toEqual({ state: "ready", questionCount: 0 });
  });

  it("treats a missing/corrupt/untagged artifact as unverified (implement allowed, never silently ready)", () => {
    expect(planImplementReadiness(planRefWithQuestions(null))).toEqual({
      state: "unverified",
      questionCount: 0,
    });
    expect(planImplementReadiness(planRefWithQuestions("{not json"))).toEqual({
      state: "unverified",
      questionCount: 0,
    });
    expect(
      planImplementReadiness(planRefWithQuestions(JSON.stringify({ parse: "none_found" }))),
    ).toEqual({ state: "unverified", questionCount: 0 });
  });

  it("assertPlanImplementReady throws a typed 409 NON-retryable plan_not_ready only when questions remain", () => {
    const notReady = planRefWithQuestions(
      JSON.stringify({
        parse: "found",
        questions: [
          { id: "q1", kind: "single", prompt: "Q?", options: [], allow_text: false },
          { id: "q2", kind: "text", prompt: "Q2?", options: [], allow_text: true },
        ],
      }),
    );
    try {
      assertPlanImplementReady("run-plan-1", notReady);
      throw new Error("expected assertPlanImplementReady to throw");
    } catch (err) {
      const e = err as Error & { status?: number; code?: string; retryable?: boolean };
      expect(e.status).toBe(409);
      expect(e.code).toBe("plan_not_ready");
      // Round-2 #4: Exact Retry replays the frozen planRef verbatim (INV-081),
      // so its questions.json can never become answered — the refusal is NOT
      // retryable, and the remediation is a NEW Implement turn against the
      // latest plan.
      expect(e.retryable).toBe(false);
      expect(e.message).toContain("run-plan-1");
      expect(e.message).toContain("2 open question(s)");
      expect(e.message).toContain("NEW Implement turn");
      expect(e.message).toContain("overridePlanReadiness");
    }

    // Ready / unverified plans pass the gate without throwing.
    expect(() =>
      assertPlanImplementReady(
        "run-plan-2",
        planRefWithQuestions(JSON.stringify({ parse: "found", questions: [] })),
      ),
    ).not.toThrow();
    expect(() => assertPlanImplementReady("run-plan-3", planRefWithQuestions(null))).not.toThrow();
  });
});
