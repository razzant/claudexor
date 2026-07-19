import type { PlanQuestion } from "@claudexor/schema";

/**
 * Engine-owned parser for the planner's tagged `## Open Questions` block
 * (ported from the retired spec-interview grounding parser; the plan
 * lifecycle is its sole owner now). Parsing is TOLERANT so the loop degrades
 * gracefully: an untagged bullet with no `::` becomes a free-text question;
 * an untagged bullet WITH 2+ options defaults to single-choice; a tagged
 * choice with no options falls back to text; `(none)` bullets are skipped.
 * This is plain delimiter parsing of the harness's own structured output (a
 * data shape we instructed), not a governance signal (INV-049).
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

function parseQuestionBullets(blockLines: string[]): PlanQuestion[] {
  const questions: PlanQuestion[] = [];
  for (const raw of blockLines) {
    const line = raw.trim();
    if (!line.startsWith("- ") && !line.startsWith("* ")) continue;
    let body = line.slice(2).trim();
    if (isNoneBullet(body)) continue;
    let kind: PlanQuestion["kind"] = "text";
    let kindTagged = false;
    if (body.startsWith("[")) {
      const close = body.indexOf("]");
      if (close > 0) {
        const tag = body.slice(1, close).trim().toLowerCase();
        if (QUESTION_KINDS.has(tag)) {
          kind = tag as PlanQuestion["kind"];
          kindTagged = true;
          body = body.slice(close + 1).trim();
        }
      }
    }
    if (isNoneBullet(body)) continue;
    const segments = body
      .split("::")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    const splitAsChoice = kindTagged ? segments.length > 1 : segments.length >= 3;
    const promptText = splitAsChoice ? (segments[0] ?? "") : body;
    if (!promptText || isPlaceholder(promptText)) continue;
    const options = (splitAsChoice ? segments.slice(1) : [])
      .filter((label) => !isPlaceholder(label))
      .map((label, i) => ({ id: `o${i + 1}`, label }));
    if (!kindTagged) kind = options.length > 0 ? "single" : "text";
    if (kind !== "text" && options.length === 0) kind = "text";
    const isText = kind === "text";
    questions.push({
      id: `q${questions.length + 1}`,
      kind,
      prompt: promptText,
      options: isText ? [] : options,
      allow_text: isText,
    });
  }
  return questions;
}
