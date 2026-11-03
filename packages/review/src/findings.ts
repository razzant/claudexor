import type { ReviewFinding, RouteProofStatus, Severity } from "@claudexor/schema";
import { ReviewFinding as ReviewFindingSchema } from "@claudexor/schema";
import { newId } from "@claudexor/util";
import { parseSealedReviewDecisionEnvelopeDetailed } from "./sealedReviewEnvelope.js";
export { sealedReviewTranscriptFromEvents } from "./sealedReviewEnvelope.js";

const MAX_BALANCED_JSON_CANDIDATES = 64;

/** Extract JSON payloads from a reviewer's free-text output (fenced or bare). */
export function extractJsonBlocks(text: string): unknown[] {
  return extractJsonBlocksDetailed(text).blocks;
}

/** The payloads read, and how many payloads the reading could not account for:
 * a glued payload that could not be read (incomplete, unparseable or past the
 * candidate bound), a later fence or value that opens like JSON but was not
 * read, or a one-line payload nested in a span the reader could not read. The
 * findings parser counts those as malformed, never as a clean review. */
function extractJsonBlocksDetailed(text: string): { blocks: unknown[]; malformed: number } {
  const results: unknown[] = [];
  let malformed = 0;
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
  /** How the value opening at `start` ends: `closed` just past its closer, `open`
   * at the end of the text when nothing closes it, or `broken` just past a closer
   * that does not match its opener. */
  const scanJson = (
    source: string,
    start: number,
  ): { state: "closed" | "open" | "broken"; end: number } => {
    const stack: string[] = [source[start] ?? ""];
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
        if (stack.pop() !== expected) return { state: "broken", end: i + 1 };
        if (stack.length === 0) return { state: "closed", end: i + 1 };
      }
    }
    return { state: "open", end: source.length };
  };
  const findBalancedJsonEnd = (source: string, start: number): number | null => {
    const scan = scanJson(source, start);
    return scan.state === "closed" ? scan.end : null;
  };
  const isWhitespaceOnly = (source: string, start: number): boolean => {
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i] ?? "";
      if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") return false;
    }
    return true;
  };
  /** Where `[` or `{` begins a line (after spaces or tabs), in order. */
  const lineStarts = (source: string): number[] => {
    const starts: number[] = [];
    let lineStart = 0;
    for (let i = 0; i <= source.length; i += 1) {
      if (i < source.length && source[i] !== "\n") continue;
      let first = lineStart;
      while (source[first] === " " || source[first] === "\t") first += 1;
      if (first < i && (source[first] === "[" || source[first] === "{")) starts.push(first);
      lineStart = i + 1;
    }
    return starts;
  };
  const beginsLine = (source: string, at: number): boolean => {
    let i = at - 1;
    while (source[i] === " " || source[i] === "\t") i -= 1;
    return i < 0 || source[i] === "\n";
  };
  /** Whether the value at `start` opens like JSON content (`[{`, `[[`, `["`,
   * `[]`, `{"`, `{}`), not like bracketed prose (`[x]`, `[1]`, `[see`). */
  const opensLikeJson = (source: string, start: number): boolean => {
    let next = start + 1;
    while (" \t\r\n".includes(source[next] ?? "x")) next += 1;
    const ch = source[next];
    return source[start] === "["
      ? ch === "{" || ch === "[" || ch === '"' || ch === "]"
      : ch === '"' || ch === "}";
  };
  /** One structural pass over every line-start `[` and `{`, before any choice:
   * each one outside an earlier span opens a top-level span (its value, then each
   * value glued after it with only spaces or tabs between; one that never closes
   * runs to the end, a wrong closer ends it there). A line start inside a span is
   * nested in it, of either bracket, never a payload of its own. Spans are
   * disjoint, so the pass is linear and needs no candidate bound. */
  const topLevelSpans = (source: string) => {
    const spans: { start: number; head: ReturnType<typeof scanJson>; end: number }[] = [];
    let covered = 0;
    for (const start of lineStarts(source)) {
      if (start < covered) continue;
      const head = scanJson(source, start);
      let last = head;
      while (last.state === "closed") {
        let next = last.end;
        while (source[next] === " " || source[next] === "\t") next += 1;
        if (source[next] !== "[" && source[next] !== "{") break;
        last = scanJson(source, next);
      }
      spans.push({ start, head, end: last.end });
      covered = last.end;
    }
    return spans;
  };
  /** A draft and its answer can share one line: an Antigravity final is the
   * exact concatenation of its frames, so `[]` then `[{...}]` arrive as
   * `[][{...}]`. After the chosen line-start payload, each further payload that
   * follows it with only spaces or tabs between is read too; prose or a line
   * break ends them. One that cannot be read is counted as malformed, and then
   * nothing after it is accounted for. Returns where the read payloads end. */
  const readAdjacent = (source: string, from: number): number => {
    let end = from;
    for (let read = 1; ; read += 1) {
      let next = end;
      while (source[next] === " " || source[next] === "\t") next += 1;
      if (source[next] !== "[" && source[next] !== "{") return end;
      const member = read < MAX_BALANCED_JSON_CANDIDATES ? findBalancedJsonEnd(source, next) : null;
      if (member === null || !tryParse(source.slice(next, member), true)) {
        malformed += 1;
        return source.length;
      }
      end = member;
    }
  };
  /** After the first payload read, the text must hold no other payload. A value
   * that opens like JSON counts only as an exact copy of one read; any other is
   * unaccounted, whether it parses (another answer, the wrong schema, an object
   * or an empty answer beside findings) or not (it never closes, closes on the
   * wrong bracket or is invalid), and so is a line that opens a value and never
   * closes it. The reading is then malformed, never a clean review. Bracketed
   * prose passes, though values inside it are still examined; past the bound
   * nothing more is proven. `skip` ranges (complete fences, judged on their own)
   * are passed over. Nothing is read from here. */
  const unaccounted = (source: string, from: number, skip: [number, number][] = []): boolean => {
    const read = new Set(results.map((value) => JSON.stringify(value)));
    let probes = 0;
    for (let i = from; i < source.length; i += 1) {
      const fenced = skip.find(([start, end]) => i >= start && i < end);
      if (fenced) {
        i = fenced[1] - 1;
        continue;
      }
      if (source[i] !== "[" && source[i] !== "{") continue;
      if (++probes > MAX_BALANCED_JSON_CANDIDATES) return true;
      const scan = scanJson(source, i);
      if (!opensLikeJson(source, i)) {
        if (scan.state === "open" && beginsLine(source, i)) return true;
        continue;
      }
      if (scan.state !== "closed") return true;
      let value: unknown;
      try {
        value = JSON.parse(source.slice(i, scan.end));
      } catch {
        return true;
      }
      if (!read.has(JSON.stringify(value))) return true;
      i = scan.end - 1;
    }
    return false;
  };
  // Fenced payloads: every complete fence is read. After the first one read, a
  // fence whose content opens like JSON but is no review payload is an unread
  // payload, and so is any payload outside the fences; before it, as on the bare
  // path, such a value is an example or a draft.
  const fence = "```";
  const fences: { start: number; end: number; body: string; read: boolean }[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(fence, cursor);
    if (start < 0) break;
    const bodyStart = start + fence.length;
    const close = text.indexOf(fence, bodyStart);
    if (close < 0) break;
    let body = text.slice(bodyStart, close);
    if (body.startsWith("json")) body = body.slice("json".length);
    fences.push({ start, end: close + fence.length, body, read: tryParse(body, true) });
    cursor = close + fence.length;
  }
  const firstRead = fences.find((candidate) => candidate.read);
  if (firstRead) {
    for (const { start, body, read } of fences) {
      const content = body.trim();
      const later = start >= firstRead.end;
      if (later && !read && (content[0] === "[" || content[0] === "{") && opensLikeJson(content, 0))
        malformed += 1;
    }
    const skip = fences.map(({ start, end }): [number, number] => [start, end]);
    if (unaccounted(text, firstRead.end, skip)) malformed += 1;
    return { blocks: results, malformed };
  }
  const trimmed = text.trim();
  if (tryParse(trimmed, true)) return { blocks: results, malformed };
  // The newest top-level line-start payload (arrays before objects) and its
  // glued payloads; then a complete one-line payload; never a nested one.
  const spans = topLevelSpans(trimmed);
  const arrays = spans.filter((span) => trimmed[span.start] === "[");
  const candidates = arrays.length > 0 ? arrays : spans;
  let readStart = -1;
  let readEnd = trimmed.length;
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const { start, head } = candidates[i]!;
    if (head.state !== "closed") continue;
    const candidate = trimmed.slice(start, head.end);
    if (isWhitespaceOnly(trimmed, head.end)) {
      if (!tryParse(candidate, true)) continue;
      readStart = start;
      break;
    }
    // Some native transcripts duplicate status text after the model's final
    // JSON block. Prefer the last complete line-start JSON block over
    // discarding an otherwise valid reviewer response.
    if (tryParse(candidate, true)) {
      readStart = start;
      readEnd = readAdjacent(trimmed, head.end);
      break;
    }
  }
  if (readStart < 0) {
    for (let lineStart = 0; ;) {
      const newline = trimmed.indexOf("\n", lineStart);
      const lineEnd = newline < 0 ? trimmed.length : newline;
      const candidate = trimmed.slice(lineStart, lineEnd).trim();
      if (
        ((candidate.startsWith("[") && candidate.endsWith("]")) ||
          (candidate.startsWith("{") && candidate.endsWith("}"))) &&
        tryParse(candidate, true)
      ) {
        readStart = lineStart;
        readEnd = lineEnd;
        // A line inside a top-level span is part of a payload the reader could not read.
        if (spans.some((span) => span.start < lineStart && lineStart < span.end)) malformed += 1;
        break;
      }
      if (newline < 0) break;
      lineStart = newline + 1;
    }
  }
  if (readStart >= 0 && unaccounted(trimmed, readEnd)) malformed += 1;
  return { blocks: results, malformed };
}

export interface ReviewerInfo {
  harness_id: string;
  requested_model?: string | null;
  requested_effort?: string | null;
  credential_profile_id?: string | null;
  observed_model?: string | null;
  observed_credential_profile_id?: string | null;
  route_proof_status?: RouteProofStatus;
}

export function parseFindingsDetailed(
  text: string,
  reviewer: ReviewerInfo,
): { findings: ReviewFinding[]; malformed: number } {
  const extracted = extractJsonBlocksDetailed(text);
  const raw: any[] = [];
  for (const block of extracted.blocks) {
    if (Array.isArray(block)) raw.push(...block);
    else if (block && typeof block === "object") {
      const candidate = block as { findings?: unknown };
      if (Array.isArray(candidate.findings)) raw.push(...candidate.findings);
      else raw.push(block);
    }
  }
  const out: ReviewFinding[] = [];
  let malformed = extracted.malformed;
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
            ...(reviewer.credential_profile_id !== undefined
              ? { credential_profile_id: reviewer.credential_profile_id ?? null }
              : {}),
            observed_model: reviewer.observed_model ?? null,
            ...(reviewer.observed_credential_profile_id !== undefined
              ? { observed_credential_profile_id: reviewer.observed_credential_profile_id ?? null }
              : {}),
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

export interface SealedReviewEnvelopeParse {
  findings: ReviewFinding[];
  malformed: number;
  error: string | null;
  blocks: unknown[];
}

/** Strict parser for a frozen release review. Generic/diff review intentionally
 * remains lenient; a sealed verdict is authority only when its completion
 * envelope proves every required checklist row and agrees with its findings. */
export function parseSealedReviewEnvelopeDetailed(
  text: string,
  reviewer: ReviewerInfo,
): SealedReviewEnvelopeParse {
  const decision = parseSealedReviewDecisionEnvelopeDetailed(text);
  const shouldNormalize =
    decision.error === null || decision.findings.length > 0 || decision.malformed > 0;
  const parsed = shouldNormalize
    ? parseFindingsDetailed(JSON.stringify({ findings: decision.rawFindings }), reviewer)
    : { findings: [], malformed: decision.malformed };
  if (decision.error !== null) {
    return {
      findings: parsed.findings,
      malformed: parsed.malformed,
      error: decision.error,
      blocks: decision.blocks,
    };
  }
  if (parsed.malformed > 0 || parsed.findings.length !== decision.rawFindings.length) {
    return {
      findings: parsed.findings,
      malformed: parsed.malformed,
      error: "sealed findings contain malformed items",
      blocks: decision.blocks,
    };
  }
  return { findings: parsed.findings, malformed: 0, error: null, blocks: decision.blocks };
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
