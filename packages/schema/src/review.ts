import { z } from "zod";
import { Id } from "./primitives.js";
import { RouteProofStatus } from "./route.js";

export const Severity = z
  .enum([
    "BLOCK",
    "FIX_FIRST",
    "WARN",
    "NIT",
    "OUT_OF_SCOPE",
    "INSUFFICIENT_EVIDENCE",
    "NEEDS_HUMAN",
  ])
  .describe(
    "Reviewer-assigned severity of a finding: BLOCK and FIX_FIRST can block convergence when accepted with evidence, WARN/NIT are advisory, OUT_OF_SCOPE and INSUFFICIENT_EVIDENCE are triage verdicts, NEEDS_HUMAN escalates to a human decision.",
  );
export type Severity = z.infer<typeof Severity>;

export const FindingCategory = z
  .enum([
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
  ])
  .describe("Subject-matter category of a review finding.");
export type FindingCategory = z.infer<typeof FindingCategory>;

export const FindingStatus = z
  .enum([
    "proposed",
    "accepted",
    "rebutted",
    "fixed",
    "accepted_risk",
    "duplicate",
    "stale",
    "out_of_scope",
    "insufficient_evidence",
  ])
  .describe(
    "Lifecycle status of a finding, from proposed through accepted/rebutted/fixed to terminal triage states (accepted_risk, duplicate, stale, out_of_scope, insufficient_evidence).",
  );
export type FindingStatus = z.infer<typeof FindingStatus>;

export const FileEvidence = z
  .object({
    path: z.string().describe("Repo-relative file path."),
    lines: z
      .string()
      .nullable()
      .default(null)
      .describe('Line range in the file (e.g. "10-42"); null when the whole file is cited.'),
  })
  .describe("File citation supporting a finding.");
export type FileEvidence = z.infer<typeof FileEvidence>;

export const CommandEvidence = z
  .object({
    command: z.string().describe("Command whose output supports the finding."),
  })
  .describe("Command citation supporting a finding.");
export type CommandEvidence = z.infer<typeof CommandEvidence>;

export const FindingEvidence = z
  .object({
    files: z.array(FileEvidence).default([]).describe("File citations."),
    diff_hunks: z.array(z.string()).default([]).describe("Diff hunks quoted as evidence."),
    commands: z
      .array(CommandEvidence)
      .default([])
      .describe("Commands whose output supports the finding."),
    logs: z
      .array(z.object({ path: z.string().describe("Log file path.") }))
      .default([])
      .describe("Log files cited as evidence."),
  })
  .describe("Evidence backing a finding; a finding without evidence cannot block.");
export type FindingEvidence = z.infer<typeof FindingEvidence>;

export const ReviewFinding = z
  .object({
    id: Id.describe("Finding id."),
    severity: Severity,
    category: FindingCategory,
    claim: z.string().describe("The reviewer's claim, stated concretely."),
    linked_acceptance_criteria: z
      .array(Id)
      .default([])
      .describe("Ids of acceptance criteria this finding relates to."),
    evidence: FindingEvidence.default({}),
    proposed_fix: z
      .string()
      .nullable()
      .default(null)
      .describe("Reviewer-proposed fix; null when none was offered."),
    reviewer: z
      .object({
        harness_id: Id.describe("Harness that produced the review."),
        requested_model: z
          .string()
          .nullable()
          .default(null)
          .describe("Model requested for the reviewer route."),
        requested_effort: z
          .string()
          .nullable()
          .default(null)
          .describe("Reasoning effort requested for the reviewer route."),
        observed_model: z
          .string()
          .nullable()
          .default(null)
          .describe("Model the harness actually reported using."),
        route_proof_status: RouteProofStatus.default("unverified"),
      })
      .describe("Who reviewed: the harness/model route and its verification status."),
    status: FindingStatus.default("proposed"),
    revalidation_note: z
      .string()
      .optional()
      .describe("Note recorded when the finding was revalidated against a changed tree."),
  })
  .describe("One evidence-backed review finding produced by a reviewer harness.");
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
