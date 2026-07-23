import type { GateResult, ReviewFinding, TaskContract } from "@claudexor/schema";
import type { CandidateEvidence } from "@claudexor/arbitration";
import type { AttemptTelemetry } from "./attemptTelemetry.js";
import { toolWarnings } from "./attemptTelemetry.js";

export interface CandidateRun {
  attemptId: string;
  harnessId: string;
  label: string;
  diff: string;
  answerText?: string;
  reviewCwd?: string;
  baseSha?: string;
  producedFiles?: string[];
  gates: GateResult[];
  cost: number;
  errored: boolean;
  costEstimated: boolean;
  errors: string[];
  telemetry: AttemptTelemetry;
  infraPhase?: "workspace" | "harness";
}

export function toCandidateEvidence(
  run: CandidateRun,
  contract: TaskContract,
  findings: ReviewFinding[],
  finalReviewClean: boolean,
  reviewVerified = false,
): CandidateEvidence {
  // Success criteria were a spec-only producer (retired with the spec
  // machinery); the acceptance axis is now always empty.
  const acceptanceCovered: string[] = [];
  // A harness error is an explicit failed required gate — never vacuous 0/0.
  const gates = run.errored
    ? [
        ...run.gates,
        {
          id: "harness",
          command: "harness",
          exit_code: 1,
          status: "failed" as const,
          duration_ms: 0,
          required: true,
          stdout_tail: null,
          stderr_tail: null,
          output_truncated: false,
        },
      ]
    : run.gates;
  return {
    attemptId: run.attemptId,
    label: run.label,
    gates,
    acceptanceCovered,
    acceptanceTotal: 0,
    findings,
    testsPassed: gates.filter((gate) => gate.status === "passed").length,
    testsTotal: gates.length,
    finalReviewClean,
    reviewVerified,
    toolWarningsCount:
      run.telemetry.outcome?.toolWarningsCount ?? toolWarnings(run.telemetry).length,
    diffSize: run.diff.split("\n").length,
    diffBytes: Buffer.byteLength(run.diff, "utf8"),
    costUsd: run.cost,
    ...(run.telemetry.outcome?.workState
      ? { workState: run.telemetry.outcome.workState }
      : {}),
  };
}
