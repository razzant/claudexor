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
  n?: number;
  autonomy?: unknown;
  maxToolCalls?: number;
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
  if (value.n !== undefined && mode !== "agent" && !(mode === "ask" && value.deepScan === true)) {
    violations.push(
      `n sets the best-of race width (agent) or deep-scan width (ask); mode is '${mode}'`,
    );
  }
  if (value.autonomy !== undefined && mode !== "orchestrate") {
    violations.push(`autonomy is an orchestrate knob; mode is '${mode}'`);
  }
  if (value.maxToolCalls !== undefined && mode !== "orchestrate") {
    violations.push(`maxToolCalls is an orchestrate knob; mode is '${mode}'`);
  }
  return violations;
}
