import type { PlanQuestion } from "@claudexor/schema";

/**
 * Engine-owned parser for the planner's tagged `## Open Questions` block
 * (ported from the retired spec-interview grounding parser; the plan
 * lifecycle is its sole owner now). Parsing is bounded to the INSTRUCTED
 * block and degrades gracefully. Once the block contains any recognized
 * `[single]`/`[multi]`/`[text]` bullet it is STRUCTURED: only tagged bullets
 * (and a terminal `(none)`) are questions, and the first nonconforming
 * top-level bullet ends the set (QA-016 — an adapter that appends ordinary
 * todo bullets after the tagged block can no longer fabricate owner
 * questions). A block with NO tagged bullet keeps the tolerant legacy
 * behavior: an untagged bullet with no `::` is a free-text question, one WITH
 * 2+ options defaults to single-choice. A tagged choice with no options falls
 * back to text; `(none)` is TERMINAL (so `(none)` followed by todos is `ready`,
 * not `needs_answers`). This is plain delimiter parsing of the harness's own
 * structured output (a data shape we instructed), not a governance signal
 * (INV-049).
 */

const QUESTION_KINDS = new Set(["single", "multi", "text"]);

function isMarkdownHeading(line: string): boolean {
  return /^#{1,6}\s+\S/.test(line);
}

function markdownHeadingText(line: string): string {
  return line.replace(/^#{1,6}\s+/, "").trim();
}

function isNoneBullet(body: string): boolean {
  return /^\(?none\)?\.?$/i.test(body.trim());
}

function isPlaceholder(text: string): boolean {
  return /^<[^<>]+>$/.test(text.trim());
}

/** Parse the whole plan text; returns the best-scoring Open Questions block.
 * A plan can contain SEVERAL such headings (the echoed prompt template, the
 * real section, appended diagnostics) — parse every block and pick the one
 * with the most STRUCTURED (tagged single/multi) questions; the echoed
 * instruction block is skipped outright by its signature. */
export function extractPlanQuestions(plan: string): {
  parse: "found" | "none_found";
  questions: PlanQuestion[];
} {
  const lines = plan.split("\n");
  const blocks: PlanQuestion[][] = [];
  let sawHeading = false;
  for (let i = 0; i < lines.length; i++) {
    const t = (lines[i] ?? "").trim();
    if (!isMarkdownHeading(t)) continue;
    if (!markdownHeadingText(t).toLowerCase().includes("open questions")) continue;
    sawHeading = true;
    const blockLines: string[] = [];
    for (const raw of lines.slice(i + 1)) {
      if (isMarkdownHeading(raw.trim())) break;
      blockLines.push(raw);
    }
    if (
      blockLines.some((l) => {
        const low = l.toLowerCase();
        return (
          low.includes("in exactly this format") || low.includes("[single] = pick exactly one")
        );
      })
    ) {
      continue;
    }
    blocks.push(parseQuestionBullets(blockLines));
  }
  let best: PlanQuestion[] = [];
  let bestScore: [number, number] = [-1, -1];
  for (const qs of blocks) {
    const tagged = qs.filter((q) => q.kind === "single" || q.kind === "multi").length;
    const score: [number, number] = [tagged, qs.length];
    if (score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1])) {
      bestScore = score;
      best = qs;
    }
  }
  // A heading with only "(none)" bullets is a FOUND block with zero questions
  // (ready); no heading at all is none_found (unverified — disclosed, never
  // silently ready).
  return { parse: sawHeading ? "found" : "none_found", questions: best };
}

/** The recognized `[single]`/`[multi]`/`[text]` kind tag on a bullet body, or
 * null when the body carries no recognized tag (the instructed format always
 * tags; an untagged bullet is a deviation). */
function recognizedTag(body: string): PlanQuestion["kind"] | null {
  if (!body.startsWith("[")) return null;
  const close = body.indexOf("]");
  if (close <= 0) return null;
  const tag = body.slice(1, close).trim().toLowerCase();
  return QUESTION_KINDS.has(tag) ? (tag as PlanQuestion["kind"]) : null;
}

/** The top-level `- `/`* ` list-item body of a line, or null when the line is
 * not a bullet. */
function bulletBody(raw: string): string | null {
  const line = raw.trim();
  if (!line.startsWith("- ") && !line.startsWith("* ")) return null;
  return line.slice(2).trim();
}

/**
 * QA-016: parse the bullets under one `## Open Questions` heading into typed
 * questions, bounded to the INSTRUCTED block. The instructed format tags every
 * bullet (`[single]`/`[multi]`/`[text]`), so once the block contains any tagged
 * bullet it is STRUCTURED: only tagged bullets (and a terminal `(none)`) are
 * questions, and the FIRST nonconforming top-level bullet ends the set — an
 * adapter that appends ordinary todo bullets after the tagged block (Cursor's
 * empty-`planUri` recovery) can no longer fabricate owner questions. A block
 * with NO tagged bullet keeps the tolerant legacy behavior (an untagged bullet
 * with 2+ `::` options is single-choice, else free text). `(none)` is terminal
 * in both modes, so `(none)` followed by todos reads as `ready` (zero
 * questions), never `needs_answers`.
 */
function parseQuestionBullets(blockLines: string[]): PlanQuestion[] {
  const bodies = blockLines.map(bulletBody).filter((body): body is string => body !== null);
  const structured = bodies.some((body) => recognizedTag(body) !== null);
  const questions: PlanQuestion[] = [];
  for (const body of bodies) {
    // `(none)` terminates the question set (never "skip and keep scanning").
    if (isNoneBullet(body)) break;
    const tag = recognizedTag(body);
    // In a structured block, a nonconforming (untagged) bullet ends the set.
    if (structured && tag === null) break;
    const parsed = tag !== null ? parseTaggedBullet(body, tag) : parseTolerantBullet(body);
    if (parsed) questions.push({ ...parsed, id: `q${questions.length + 1}` });
  }
  return questions;
}

function toQuestion(
  kind: PlanQuestion["kind"],
  promptText: string,
  options: { id: string; label: string }[],
): PlanQuestion {
  const resolved = kind !== "text" && options.length === 0 ? "text" : kind;
  const isText = resolved === "text";
  return {
    id: "",
    kind: resolved,
    prompt: promptText,
    options: isText ? [] : options,
    allow_text: isText,
  };
}

/** Parse a bullet that carries a recognized `[single]`/`[multi]`/`[text]` tag. */
function parseTaggedBullet(body: string, kind: PlanQuestion["kind"]): PlanQuestion | null {
  const rest = body.slice(body.indexOf("]") + 1).trim();
  if (isNoneBullet(rest)) return null;
  const segments = rest
    .split("::")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const splitAsChoice = segments.length > 1;
  const promptText = splitAsChoice ? (segments[0] ?? "") : rest;
  if (!promptText || isPlaceholder(promptText)) return null;
  const options = (splitAsChoice ? segments.slice(1) : [])
    .filter((label) => !isPlaceholder(label))
    .map((label, i) => ({ id: `o${i + 1}`, label }));
  return toQuestion(kind, promptText, options);
}

/** Parse an untagged bullet in a wholly-untagged (legacy) block: a bullet with
 * 2+ `::` options is single-choice, otherwise free text. */
function parseTolerantBullet(body: string): PlanQuestion | null {
  if (isNoneBullet(body)) return null;
  const segments = body
    .split("::")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const splitAsChoice = segments.length >= 3;
  const promptText = splitAsChoice ? (segments[0] ?? "") : body;
  if (!promptText || isPlaceholder(promptText)) return null;
  const options = (splitAsChoice ? segments.slice(1) : [])
    .filter((label) => !isPlaceholder(label))
    .map((label, i) => ({ id: `o${i + 1}`, label }));
  return toQuestion(options.length > 0 ? "single" : "text", promptText, options);
}
