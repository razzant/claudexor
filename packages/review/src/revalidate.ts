import { isAbsolute, relative, resolve } from "node:path";
import type { FindingEvidence, FindingStatus, ReviewFinding } from "@claudexor/schema";

export interface RevalidateDecision {
  status: FindingStatus;
  note?: string;
}

export interface RevalidateOptions {
  candidateRoot?: string;
  evidenceDir?: string;
}

interface EvidenceValidationResult {
  evidence: FindingEvidence;
  invalidPathCount: number;
}

function hasEvidence(f: ReviewFinding): boolean {
  return (
    f.evidence.files.length > 0 ||
    f.evidence.diff_hunks.length > 0 ||
    f.evidence.commands.length > 0 ||
    f.evidence.logs.length > 0
  );
}

function isSameOrInside(parent: string, target: string): boolean {
  const rel = relative(resolve(parent), resolve(target));
  const firstPart = rel.split(/[\\/]+/)[0];
  return rel === "" || (!!rel && firstPart !== ".." && !isAbsolute(rel));
}

function hasTraversalSegment(pathValue: string): boolean {
  return pathValue.split(/[\\/]+/).some((part) => part === "..");
}

function isSafeRelativeEvidencePath(pathValue: string, options: RevalidateOptions): boolean {
  if (!pathValue || hasTraversalSegment(pathValue)) return false;
  if (isAbsolute(pathValue)) return false;
  const roots = [options.candidateRoot, options.evidenceDir].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (roots.length === 0) return true;
  return roots.some((root) => isSameOrInside(root, resolve(root, pathValue)));
}

function validateEvidence(
  evidence: FindingEvidence,
  options: RevalidateOptions,
): EvidenceValidationResult {
  let invalidPathCount = 0;
  const files = evidence.files.filter((file) => {
    const ok = isSafeRelativeEvidencePath(file.path, options);
    if (!ok) invalidPathCount++;
    return ok;
  });
  const logs = evidence.logs.filter((log) => {
    const ok = isSafeRelativeEvidencePath(log.path, options);
    if (!ok) invalidPathCount++;
    return ok;
  });
  return {
    evidence: {
      files,
      logs,
      diff_hunks: evidence.diff_hunks,
      commands: evidence.commands,
    },
    invalidPathCount,
  };
}

/**
 * Deterministic revalidation (no LLM): enforces the evidence invariants that
 * always hold — no evidence -> cannot block; out-of-scope/insufficient pass
 * through; a NEEDS_HUMAN escalation stays a blocking human gate.
 */
export function deterministicDecision(
  f: ReviewFinding,
  options: RevalidateOptions = {},
): RevalidateDecision {
  if (["fixed", "rebutted", "accepted_risk", "duplicate"].includes(f.status)) {
    return { status: f.status };
  }
  if (f.severity === "OUT_OF_SCOPE") return { status: "out_of_scope" };
  if (f.severity === "INSUFFICIENT_EVIDENCE") return { status: "insufficient_evidence" };
  // A reviewer escalation to a human BLOCKS until a human decides — it must
  // never silently downgrade to a non-blocking accepted risk.
  if (f.severity === "NEEDS_HUMAN") return { status: "accepted", note: "human decision required" };
  if (f.severity === "BLOCK" || f.severity === "FIX_FIRST") {
    const validated = validateEvidence(f.evidence, options);
    const candidate = { ...f, evidence: validated.evidence };
    if (!hasEvidence(candidate)) {
      return {
        status: "insufficient_evidence",
        note:
          validated.invalidPathCount > 0
            ? "invalid evidence paths -> cannot block"
            : "no evidence -> cannot block",
      };
    }
  }
  return { status: "accepted" };
}

/**
 * Revalidate every finding deterministically. Each finding's status is recorded;
 * the evidence-free BLOCK/FIX_FIRST invariant is applied so a reviewer cannot
 * leave an evidence-free finding in a blocking state.
 */
export async function revalidateFindings(
  findings: ReviewFinding[],
  options: RevalidateOptions = {},
): Promise<ReviewFinding[]> {
  const out: ReviewFinding[] = [];
  for (const f of findings) {
    const validated = validateEvidence(f.evidence, options);
    const d = deterministicDecision(f, options);
    out.push({ ...f, evidence: validated.evidence, status: d.status, revalidation_note: d.note });
  }
  return out;
}
