import type { ReviewFinding, RouteProofStatus, Severity } from "@claudexor/schema";
import { ReviewFinding as ReviewFindingSchema } from "@claudexor/schema";
import { newId } from "@claudexor/util";


/** Extract JSON payloads from a reviewer's free-text output (fenced or bare). */
export function extractJsonBlocks(text: string): unknown[] {
  const results: unknown[] = [];
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  const isSingleFindingObject = (value: Record<string, unknown>): boolean =>
    "severity" in value && ("claim" in value || "message" in value || "evidence" in value);
  const isReviewPayload = (value: unknown, allowSingleObject: boolean): boolean => {
    if (Array.isArray(value)) return true;
    if (!isRecord(value)) return false;
    if (Array.isArray(value.findings)) return true;
    return allowSingleObject && isSingleFindingObject(value);
  };
  const tryParse = (candidate: string, allowSingleObject = false): boolean => {
    const trimmed = candidate.trim();
    if (!trimmed) return false;
    try {
      const parsed = JSON.parse(trimmed);
      if (!isReviewPayload(parsed, allowSingleObject)) return false;
      results.push(parsed);
      return true;
    } catch {
      return false;
    }
  };
  const findBalancedJsonEnd = (source: string, start: number): number | null => {
    const open = source[start];
    if (open !== "[" && open !== "{") return null;
    const stack: string[] = [open];
    let inString = false;
    let escaped = false;
    for (let i = start + 1; i < source.length; i += 1) {
      const ch = source[i] ?? "";
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "[" || ch === "{") {
        stack.push(ch);
        continue;
      }
      if (ch === "]" || ch === "}") {
        const expected = ch === "]" ? "[" : "{";
        if (stack.pop() !== expected) return null;
        if (stack.length === 0) return i + 1;
      }
    }
    return null;
  };
  const isWhitespaceOnly = (source: string, start: number): boolean => {
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i] ?? "";
      if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") return false;
    }
    return true;
  };
  const jsonLineStarts = (source: string, open: "[" | "{"): number[] => {
    const starts: number[] = [];
    let lineStart = 0;
    for (let i = 0; i <= source.length; i += 1) {
      if (i < source.length && source[i] !== "\n") continue;
      const lineEnd = i > lineStart && source[i - 1] === "\r" ? i - 1 : i;
      let first = lineStart;
      while (first < lineEnd) {
        const ch = source[first] ?? "";
        if (ch !== " " && ch !== "\t") break;
        first += 1;
      }
      const ch = source[first] ?? "";
      if (first < lineEnd && ch === open) starts.push(first);
      lineStart = i + 1;
    }
    return starts;
  };
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  let found = false;
  while ((m = fence.exec(text)) !== null) {
    found = tryParse(m[1] ?? "", true) || found;
  }
  if (!found) {
    const trimmed = text.trim();
    if (!tryParse(trimmed, true)) {
      const arrayStarts = jsonLineStarts(trimmed, "[");
      const starts = arrayStarts.length > 0 ? arrayStarts : jsonLineStarts(trimmed, "{");
      for (let i = starts.length - 1; i >= 0; i -= 1) {
        const start = starts[i] ?? 0;
        const end = findBalancedJsonEnd(trimmed, start);
        if (end === null) continue;
        const candidate = trimmed.slice(start, end);
        if (isWhitespaceOnly(trimmed, end)) {
          if (tryParse(candidate, true)) break;
          continue;
        }
        // Some native transcripts duplicate status text after the model's final
        // JSON block. Prefer the last complete line-start JSON block over
        // discarding an otherwise valid reviewer response.
        if (tryParse(candidate, true)) break;
      }
    }
    const lines = trimmed.split(/\r?\n/);
    if (results.length === 0) {
      for (const line of lines) {
        const candidate = line.trim();
        if (
          (candidate.startsWith("[") && candidate.endsWith("]")) ||
          (candidate.startsWith("{") && candidate.endsWith("}"))
        ) {
          if (tryParse(candidate, true)) break;
        }
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

export function parseFindingsDetailed(
  text: string,
  reviewer: ReviewerInfo,
): { findings: ReviewFinding[]; malformed: number } {
  const raw: any[] = [];
  for (const block of extractJsonBlocks(text)) {
    if (Array.isArray(block)) raw.push(...block);
    else if (block && typeof block === "object") {
      const candidate = block as { findings?: unknown };
      if (Array.isArray(candidate.findings)) raw.push(...candidate.findings);
      else raw.push(block);
    }
  }
  const out: ReviewFinding[] = [];
  let malformed = 0;
  for (const r of raw) {
    if (!r || typeof r !== "object") {
      malformed += 1;
      continue;
    }
    // A finding WITHOUT a severity is malformed, not "WARN by default": the
    // fail-closed verdict parse must never silently downgrade what might have
    // been a blocker into a non-blocking level (the one lenient branch this
    // parser used to have).
    if (r.severity === undefined || r.severity === null) {
      malformed += 1;
      continue;
    }
    try {
      out.push(
        ReviewFindingSchema.parse({
          id: r.id ?? newId("f"),
          severity: r.severity,
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
  const insufficientEvidence: ReviewFinding[] = [];
  for (const f of findings) {
    if (f.severity === "NEEDS_HUMAN") {
      humanGates.push(f);
      continue;
    }
    if (f.severity === "INSUFFICIENT_EVIDENCE") {
      insufficientEvidence.push(f);
      continue;
    }
    const files = f.evidence.files
      .map((x) => x.path)
      .sort()
      .join(",");
    const key = `${f.category}|${f.claim.toLowerCase().slice(0, 120)}|${files}`;
    const existing = seen.get(key);
    if (!existing || severityRank(f.severity) > severityRank(existing.severity)) {
      seen.set(key, f);
    }
  }
  return [...seen.values(), ...humanGates, ...insufficientEvidence];
}
