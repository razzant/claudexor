import { z } from "zod";
import { Id } from "./primitives.js";
import { RouteProofStatus } from "./route.js";

export const Severity = z.enum([
  "BLOCK",
  "FIX_FIRST",
  "WARN",
  "NIT",
  "OUT_OF_SCOPE",
  "INSUFFICIENT_EVIDENCE",
  "NEEDS_HUMAN",
]);
export type Severity = z.infer<typeof Severity>;

export const FindingCategory = z.enum([
  "correctness",
  "regression",
  "security",
  "performance",
  "maintainability",
  "test_gap",
  "spec_gap",
  "deploy",
  "architecture",
  "ux",
]);
export type FindingCategory = z.infer<typeof FindingCategory>;

export const FindingStatus = z.enum([
  "proposed",
  "accepted",
  "rebutted",
  "fixed",
  "accepted_risk",
  "duplicate",
  "stale",
  "out_of_scope",
  "insufficient_evidence",
]);
export type FindingStatus = z.infer<typeof FindingStatus>;

export const FileEvidence = z.object({
  path: z.string(),
  lines: z.string().nullable().default(null),
});
export type FileEvidence = z.infer<typeof FileEvidence>;

export const CommandEvidence = z.object({
  command: z.string(),
});
export type CommandEvidence = z.infer<typeof CommandEvidence>;

export const FindingEvidence = z.object({
  files: z.array(FileEvidence).default([]),
  diff_hunks: z.array(z.string()).default([]),
  commands: z.array(CommandEvidence).default([]),
  logs: z.array(z.object({ path: z.string() })).default([]),
});
export type FindingEvidence = z.infer<typeof FindingEvidence>;

export const ReviewFinding = z.object({
  id: Id,
  severity: Severity,
  category: FindingCategory,
  claim: z.string(),
  linked_acceptance_criteria: z.array(Id).default([]),
  evidence: FindingEvidence.default({}),
  repro: z
    .object({
      command: z.string().nullable().default(null),
      expected: z.string().nullable().default(null),
      actual: z.string().nullable().default(null),
    })
    .optional(),
  proposed_fix: z.string().nullable().default(null),
  reviewer: z.object({
    harness_id: Id,
    requested_model: z.string().nullable().default(null),
    requested_effort: z.string().nullable().default(null),
    observed_model: z.string().nullable().default(null),
    route_proof_status: RouteProofStatus.default("unverified"),
  }),
  status: FindingStatus.default("proposed"),
  revalidation_note: z.string().optional(),
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;

/** Whether a finding can block convergence given its status + evidence. */
export function isBlocking(f: Pick<ReviewFinding, "severity" | "status" | "evidence">): boolean {
  if (f.status !== "accepted") return false;
  // A NEEDS_HUMAN escalation blocks until a human decides; the escalation
  // itself is the signal, so it does not require file/diff evidence.
  if (f.severity === "NEEDS_HUMAN") return true;
  if (f.severity !== "BLOCK" && f.severity !== "FIX_FIRST") return false;
  const hasEvidence =
    f.evidence.files.length > 0 ||
    f.evidence.diff_hunks.length > 0 ||
    f.evidence.commands.length > 0 ||
    f.evidence.logs.length > 0;
  return hasEvidence; // No evidence -> cannot BLOCK.
}
