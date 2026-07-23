import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PlanQuestionsArtifact, derivePlanReadiness } from "@claudexor/schema";

/**
 * Implement-time plan readiness, DERIVED at run-start from the frozen plan's
 * `final/questions.json` (the sibling of the planRef `final/plan.md`). One
 * server-side owner derives readiness from that single artifact — nothing
 * re-parses plan prose. A missing/corrupt artifact (a pre-v3 plan run, or a
 * plan produced without a tagged Open Questions block) counts as `unverified`:
 * implement is ALLOWED but never silently claimed "ready".
 */
export function planImplementReadiness(planRefPath: string): {
  state: "ready" | "needs_answers" | "unverified";
  questionCount: number;
} {
  let text: string;
  try {
    text = readFileSync(join(dirname(planRefPath), "questions.json"), "utf8");
  } catch {
    return { state: "unverified", questionCount: 0 };
  }
  try {
    return derivePlanReadiness(PlanQuestionsArtifact.parse(JSON.parse(text)));
  } catch {
    return { state: "unverified", questionCount: 0 };
  }
}

/**
 * Run-start readiness gate (QA-045 / D17). Implementing an approved plan that
 * still has open owner questions is refused HERE — pre-worktree, pre-spawn,
 * pre-spend — with a typed `plan_not_ready` (HTTP 409). Refusing at run-start,
 * rather than with a bespoke early return in the control API, is what makes the
 * refusal a DURABLE refused turn: the daemon settles the job terminal with no
 * run bound and records `enqueue_error = plan_not_ready` on the turn (INV-093).
 *
 * The refusal is `retryable=false` (round-2 #4). Exact Retry replays the
 * recorded params VERBATIM, and INV-081 freezes the planRef to the ORIGINAL
 * plan whose `questions.json` still carries the open questions — so a retry can
 * never become ready no matter how many times it runs this preflight. Answering
 * the questions produces a LATER plan turn; the honest remediation is to answer
 * them and create a NEW Implement turn against the latest plan (or pass
 * `overridePlanReadiness:true`). The operator's explicit override
 * (`plan_readiness_overridden`, recorded on the turn at create) skips this gate
 * and is unchanged.
 */
export function assertPlanImplementReady(planRunId: string, planRefPath: string): void {
  const readiness = planImplementReadiness(planRefPath);
  if (readiness.state === "needs_answers") {
    throw Object.assign(
      new Error(
        `plan ${planRunId} is not ready: ${readiness.questionCount} open question(s) — answer them and create a NEW Implement turn against the latest plan, or pass overridePlanReadiness:true`,
      ),
      { status: 409, code: "plan_not_ready", retryable: false },
    );
  }
}
