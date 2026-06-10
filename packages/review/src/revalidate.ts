import type { FindingStatus, ReviewFinding } from "@claudexor/schema";

export interface RevalidateDecision {
  status: FindingStatus;
  note?: string;
}

export type Decider = (f: ReviewFinding) => RevalidateDecision | Promise<RevalidateDecision>;

function hasEvidence(f: ReviewFinding): boolean {
  return (
    f.evidence.files.length > 0 ||
    f.evidence.diff_hunks.length > 0 ||
    f.evidence.commands.length > 0 ||
    f.evidence.logs.length > 0
  );
}

/**
 * Deterministic baseline revalidation (no LLM): enforces the evidence rules.
 * The real loop layers an LLM-first Decider on top, but these invariants always
 * hold: no evidence -> cannot block; out-of-scope/insufficient pass through.
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
 * Revalidate every finding (LLM-first when a Decider is provided). Each finding's
 * status is recorded; the deterministic evidence invariant is always applied
 * first so an LLM cannot promote an evidence-free finding to blocking.
 */
export async function revalidateFindings(
  findings: ReviewFinding[],
  decide: Decider = deterministicDecision,
): Promise<ReviewFinding[]> {
  const out: ReviewFinding[] = [];
  for (const f of findings) {
    // Hard invariant first.
    if ((f.severity === "BLOCK" || f.severity === "FIX_FIRST") && !hasEvidence(f)) {
      out.push({ ...f, status: "insufficient_evidence", revalidation_note: "no evidence -> cannot block" });
      continue;
    }
    const d = await decide(f);
    out.push({ ...f, status: d.status, revalidation_note: d.note });
  }
  return out;
}
