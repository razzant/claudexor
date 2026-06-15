import type { FindingStatus, ReviewFinding } from "@claudexor/schema";

export interface RevalidateDecision {
  status: FindingStatus;
  note?: string;
}

function hasEvidence(f: ReviewFinding): boolean {
  return (
    f.evidence.files.length > 0 ||
    f.evidence.diff_hunks.length > 0 ||
    f.evidence.commands.length > 0 ||
    f.evidence.logs.length > 0
  );
}

/**
 * Deterministic revalidation (no LLM): enforces the evidence invariants that
 * always hold — no evidence -> cannot block; out-of-scope/insufficient pass
 * through; a NEEDS_HUMAN escalation stays a blocking human gate.
 */
export function deterministicDecision(f: ReviewFinding): RevalidateDecision {
  if (f.severity === "OUT_OF_SCOPE") return { status: "out_of_scope" };
  if (f.severity === "INSUFFICIENT_EVIDENCE") return { status: "insufficient_evidence" };
  // A reviewer escalation to a human BLOCKS until a human decides — it must
  // never silently downgrade to a non-blocking accepted risk.
  if (f.severity === "NEEDS_HUMAN") return { status: "accepted", note: "human decision required" };
  if ((f.severity === "BLOCK" || f.severity === "FIX_FIRST") && !hasEvidence(f)) {
    return { status: "insufficient_evidence", note: "no evidence -> cannot block" };
  }
  return { status: "accepted" };
}

/**
 * Revalidate every finding deterministically. Each finding's status is recorded;
 * the evidence-free BLOCK/FIX_FIRST invariant is applied so a reviewer cannot
 * leave an evidence-free finding in a blocking state.
 */
export async function revalidateFindings(findings: ReviewFinding[]): Promise<ReviewFinding[]> {
  const out: ReviewFinding[] = [];
  for (const f of findings) {
    const d = deterministicDecision(f);
    out.push({ ...f, status: d.status, revalidation_note: d.note });
  }
  return out;
}
