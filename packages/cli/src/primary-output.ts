import { join } from "node:path";
import { readTextSafe } from "@claudexor/util";
import type { ModeKind } from "@claudexor/schema";

export interface CliPrimaryOutput {
  kind: string;
  path: string;
  text: string;
}

interface CliPrimaryOutputCandidate {
  kind: string;
  path: string;
}

export function primaryOutputCandidatesForCli(mode?: ModeKind): CliPrimaryOutputCandidate[] {
  return mode === "ask"
    ? [{ kind: "answer", path: "final/answer.md" }]
    : mode === "plan"
      ? [{ kind: "plan", path: "final/plan.md" }]
      : mode === "audit"
        ? [
            { kind: "report", path: "final/report.md" },
            { kind: "report", path: "final/explore.md" },
            { kind: "summary", path: "final/summary.md" },
          ]
        : mode === "orchestrate"
          ? [
              { kind: "report", path: "final/orchestration.md" },
              { kind: "summary", path: "final/summary.md" },
            ]
          : [
              { kind: "answer", path: "final/answer.md" },
              { kind: "summary", path: "final/summary.md" },
              { kind: "patch", path: "final/patch.diff" },
            ];
}

export function primaryOutputForCli(root: string, mode?: ModeKind): CliPrimaryOutput | null {
  for (const candidate of primaryOutputCandidatesForCli(mode)) {
    const text = readTextSafe(join(root, candidate.path));
    if (text?.trim()) return { ...candidate, text };
  }
  const failure = readTextSafe(join(root, "final/failure.yaml"));
  return failure?.trim() ? { kind: "diagnostic", path: "final/failure.yaml", text: failure } : null;
}
