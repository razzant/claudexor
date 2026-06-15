import type { ReviewFinding, RouteProofStatus, Severity } from "@claudexor/schema";
import { ReviewFinding as ReviewFindingSchema } from "@claudexor/schema";
import { newId } from "@claudexor/util";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Extract JSON payloads from a reviewer's free-text output (fenced or bare). */
export function extractJsonBlocks(text: string): unknown[] {
  const results: unknown[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  let found = false;
  while ((m = fence.exec(text)) !== null) {
    try {
      results.push(JSON.parse(m[1] ?? ""));
      found = true;
    } catch {
      /* skip */
    }
  }
  if (!found) {
    const trimmed = text.trim();
    const candidates = [trimmed];
    const lines = trimmed.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const candidate = lines.slice(i).join("\n").trim();
      if (candidate.startsWith("[") || candidate.startsWith("{")) candidates.push(candidate);
    }
    for (const candidate of candidates) {
      try {
        results.push(JSON.parse(candidate));
        break;
      } catch {
        /* try the next JSON-looking suffix */
      }
    }
  }
  return results;
}

export interface ReviewerInfo {
  harness_id: string;
  requested_model?: string | null;
  requested_effort?: string | null;
  observed_model?: string | null;
  route_proof_status?: RouteProofStatus;
}

export function parseFindingsDetailed(text: string, reviewer: ReviewerInfo): { findings: ReviewFinding[]; malformed: number } {
  const raw: any[] = [];
  for (const block of extractJsonBlocks(text)) {
    if (Array.isArray(block)) raw.push(...block);
    else if (block && typeof block === "object" && Array.isArray((block as any).findings)) {
      raw.push(...(block as any).findings);
    } else if (block && typeof block === "object") {
      raw.push(block);
    }
  }
  const out: ReviewFinding[] = [];
  let malformed = 0;
  for (const r of raw) {
    if (!r || typeof r !== "object") {
      malformed += 1;
      continue;
    }
    try {
      out.push(
        ReviewFindingSchema.parse({
          id: r.id ?? newId("f"),
          severity: r.severity ?? "WARN",
          category: r.category ?? "correctness",
          claim: String(r.claim ?? r.message ?? "(no claim)"),
          linked_acceptance_criteria: r.linked_acceptance_criteria ?? [],
          evidence: r.evidence ?? {},
          proposed_fix: r.proposed_fix ?? null,
          reviewer: {
            harness_id: reviewer.harness_id,
            requested_model: reviewer.requested_model ?? null,
            requested_effort: reviewer.requested_effort ?? null,
            observed_model: reviewer.observed_model ?? null,
            route_proof_status: reviewer.route_proof_status ?? "unverified",
          },
          status: "proposed",
        }),
      );
    } catch {
      malformed += 1;
    }
  }
  return { findings: out, malformed };
}

const SEVERITY_ORDER: Severity[] = [
  "INSUFFICIENT_EVIDENCE",
  "NIT",
  "OUT_OF_SCOPE",
  "WARN",
  "NEEDS_HUMAN",
  "FIX_FIRST",
  "BLOCK",
];

function severityRank(s: Severity): number {
  return SEVERITY_ORDER.indexOf(s);
}

/**
 * Merge near-duplicate findings (same category + claim + file set), keeping the
 * most severe. NEEDS_HUMAN is an orthogonal human-gate, not a severity rung — it
 * is never collapsed into (or replaced by) another finding, so a same-key BLOCK
 * from a second reviewer can never silently swallow a human-approval escalation.
 */
export function dedupeFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const seen = new Map<string, ReviewFinding>();
  const humanGates: ReviewFinding[] = [];
  for (const f of findings) {
    if (f.severity === "NEEDS_HUMAN") {
      humanGates.push(f);
      continue;
    }
    const files = f.evidence.files.map((x) => x.path).sort().join(",");
    const key = `${f.category}|${f.claim.toLowerCase().slice(0, 120)}|${files}`;
    const existing = seen.get(key);
    if (!existing || severityRank(f.severity) > severityRank(existing.severity)) {
      seen.set(key, f);
    }
  }
  return [...seen.values(), ...humanGates];
}
