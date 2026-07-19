import type { ModeKind } from "./primitives.js";

/** Mode/strategy coherence (D11): meaningless flag combinations are refused
 * at every wire boundary instead of being silently ignored. ONE owner — the
 * control-api normalization funnel throws these as 400s; kept beside the
 * schema (not baked in as a union) so `.omit`/`.shape` consumers survive. */
export function runStartStrategyViolations(value: {
  mode?: ModeKind;
  deepScan?: boolean;
  untilClean?: boolean;
  attempts?: number | null;
  create?: boolean;
  council?: boolean;
  n?: number;
  delegate?: boolean;
  reviewerPanel?: unknown;
}): string[] {
  const mode = value.mode ?? "agent";
  const violations: string[] = [];
  if (value.deepScan === true && mode !== "ask") {
    violations.push(`deepScan is an ask strategy; mode is '${mode}'`);
  }
  if (value.untilClean === true && mode !== "agent") {
    violations.push(`untilClean is an agent strategy; mode is '${mode}'`);
  }
  if (value.attempts != null && mode !== "agent") {
    violations.push(`attempts is an agent strategy; mode is '${mode}'`);
  }
  if (value.create === true && mode !== "agent") {
    violations.push(`create is an agent strategy; mode is '${mode}'`);
  }
  // Council (INV-031) is a PLAN strategy: N harnesses draft in parallel, the
  // primary merges into one plan + one question set.
  if (value.council === true && mode !== "plan") {
    violations.push(`council is a plan strategy; mode is '${mode}'`);
  }
  // `n` widens best-of (agent), deep-scan (ask), or council membership (plan).
  // On a PLAIN plan run (no council) it is meaningless and refused; council is
  // the one flag that legalizes `n` on a plan.
  const nLegal =
    mode === "agent" ||
    (mode === "ask" && value.deepScan === true) ||
    (mode === "plan" && value.council === true);
  if (value.n !== undefined && !nLegal) {
    violations.push(
      mode === "plan"
        ? `n sets council membership width on a plan run; pass --council (mode is 'plan' without council)`
        : `n sets the best-of race width (agent) or deep-scan width (ask); mode is '${mode}'`,
    );
  }
  if (value.council === true && value.n !== undefined && (value.n < 2 || value.n > 4)) {
    violations.push(`council membership n must be between 2 and 4 (got ${value.n})`);
  }
  if (value.delegate === true && mode !== "agent") {
    violations.push(`delegate is an agent strategy; mode is '${mode}'`);
  }
  if (value.reviewerPanel !== undefined && mode !== "agent") {
    violations.push(
      `reviewerPanel only applies to agent runs (plan review was retired in v3; Council is the plan critique path); mode is '${mode}'`,
    );
  }
  return violations;
}
