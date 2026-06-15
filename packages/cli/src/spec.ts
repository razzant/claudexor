import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ArtifactStore } from "@claudexor/artifact-store";
import {
  InterviewEngine,
  type SpecDraft,
  type SpecFieldChange,
  diffSpecPacks,
} from "@claudexor/interview";
import { type InterviewAnswer, type InterviewQuestion, type SpecPack, SpecPack as SpecPackSchema } from "@claudexor/schema";
import { ensureDir, hashJson, readJsonSafe, redactSecrets, writeJson, writeText } from "@claudexor/util";

export interface SpecAnswersFile {
  answers: InterviewAnswer[];
  /** Present in the draft questions file so freezing can reuse the exact grounding plan. */
  planRunId?: string;
  planDir?: string;
  questions?: InterviewQuestion[];
  summary?: string;
  success_criteria?: string[];
  non_goals?: string[];
  forbidden_approaches?: string[];
  decided_tradeoffs?: string[];
  tests?: string[];
}

export interface SpecCommandResult {
  status: "questions" | "frozen";
  planRunId: string;
  planDir: string;
  questionsPath?: string;
  specId?: string;
  specDir?: string;
  specHash?: string;
  runHint?: string;
  questions: InterviewQuestion[];
  changes?: SpecFieldChange[];
}

const INTERVIEW_KINDS = new Set(["single", "multi", "text"]);

/**
 * The grounding-plan instruction that DRIVES extractQuestionsFromPlan: it tells the
 * harness to end its read-only plan with a structured `## Open Questions` block in
 * the exact format the parser below understands. Kept HERE, beside its parser, so the
 * producer instruction and consumer stay a co-located contract pair (the daemon
 * surface just calls this — Bible §1: surfaces stay thin).
 */
export function buildGroundingPrompt(prompt: string): string {
  return `${prompt}

---
GROUNDING INSTRUCTION (for Claudexor's spec interview — do this in addition to your plan):
Identify the material decisions a developer must make BEFORE implementing this, then
end your response with a section titled exactly:

## Open Questions

List 2–6 of the MOST important open decisions, one per bullet, in EXACTLY this format:

- [single] <question> :: <option A> :: <option B> :: <option C>
- [multi] <question> :: <option A> :: <option B> :: <option C>
- [text] <question that has no good fixed options>

Rules:
- [single] = pick exactly one; [multi] = pick one or more; [text] = free-form (no "::" options).
- For [single], make options MUTUALLY EXCLUSIVE; for [multi], make options concrete
  INDEPENDENT selections that can be combined. Ground every option in THIS repository.
- Prefer [single]/[multi] with real options over [text] whenever sensible choices exist.
- If there are genuinely no open decisions, write a single bullet: - (none)`;
}

/** A real markdown ATX heading: 1–6 leading `#` then a space. Used as the
 *  open-questions block terminator so an inline `#`-prefixed bullet body (e.g. a
 *  shell `#comment`) does not cut the block short. */
function isMarkdownHeading(line: string): boolean {
  let i = 0;
  while (i < line.length && line[i] === "#") i++;
  return i >= 1 && i <= 6 && line[i] === " ";
}

/** A "no open decisions" sentinel bullet body, e.g. `(none)` / `(none — ...)`. */
function isNoneBullet(body: string): boolean {
  return !body || body.toLowerCase().startsWith("(none");
}

/**
 * A leaked grounding-prompt format placeholder — ONLY the exact templates this
 * module's buildGroundingPrompt emits (`<question>`, `<question that ...>`,
 * `<option A>`…). Narrow on purpose so legitimate angle-bracket options a harness
 * may produce (e.g. `<stdio.h>`, `<Button>`, `<input>`) are NOT dropped.
 */
function isPlaceholder(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t === "<question>" || t === "<question that has no good fixed options>") return true;
  return t.startsWith("<option ") && t.endsWith(">");
}

/**
 * Parse the grounding plan's "Open Questions" section into an interactive interview.
 *
 * The grounding prompt (see claudexord.specQuestions) asks the harness to end its
 * plan with an `## Open Questions` section, one bullet per decision, in the format:
 *
 *   - [single] Which auth flow? :: OAuth :: API key :: Both
 *   - [multi]  Which platforms? :: iOS :: Android :: Web
 *   - [text]   Any naming constraints?
 *
 * `[single|multi|text]` is the answer kind; `::` separates the question from each
 * option. Parsing is TOLERANT so the quiz degrades gracefully and old plans still
 * work: an untagged bullet with no `::` becomes a free-text question (the previous
 * behavior); an untagged bullet WITH options defaults to single-choice; a tagged
 * choice question with no options falls back to text. `(none)` is skipped. This is
 * plain delimiter parsing of the harness's own structured output (a data shape we
 * instructed), not a governance signal — it does not infer risk/success/etc.
 */
export function extractQuestionsFromPlan(plan: string): InterviewQuestion[] {
  const lines = plan.split("\n");
  // Use the LAST "Open Questions" heading, not the first: the grounding prompt is
  // instructed to END the response with this section, and the prompt ITSELF contains
  // a literal "## Open Questions" template — if a harness echoes the instruction, the
  // template would appear earlier, so the real quiz is the final block. (Symmetric
  // with the terminator: a REAL markdown heading whose text mentions the section, so
  // a stray `#open questions` non-heading line can't start the block.)
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = (lines[i] ?? "").trim();
    if (isMarkdownHeading(t) && t.toLowerCase().includes("open questions")) start = i;
  }
  if (start < 0) return [];
  const questions: InterviewQuestion[] = [];
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (isMarkdownHeading(line)) break; // the next real heading ends the block
    if (!line.startsWith("- ") && !line.startsWith("* ")) continue;
    let body = line.slice(2).trim();
    if (isNoneBullet(body)) continue;
    // Optional leading kind tag: [single] | [multi] | [text].
    let kind: InterviewQuestion["kind"] = "text";
    let kindTagged = false;
    if (body.startsWith("[")) {
      const close = body.indexOf("]");
      if (close > 0) {
        const tag = body.slice(1, close).trim().toLowerCase();
        if (INTERVIEW_KINDS.has(tag)) {
          kind = tag as InterviewQuestion["kind"];
          kindTagged = true;
          body = body.slice(close + 1).trim();
        }
      }
    }
    // Re-check after stripping the tag: `- [text] (none)` must still skip.
    if (isNoneBullet(body)) continue;
    // "question :: optA :: optB" — `::` separates the prompt from each option.
    // Only treat `::` as an option delimiter when the bullet is TAGGED, or has 2+
    // option segments (a real choice). An untagged legacy bullet with a single `::`
    // (e.g. prose "Session store :: Redis vs Postgres?") is kept as ONE free-text
    // question, not silently turned into a 1-option choice.
    const segments = body.split("::").map((p) => p.trim()).filter((p) => p.length > 0);
    const splitAsChoice = kindTagged ? segments.length > 1 : segments.length >= 3;
    const promptText = splitAsChoice ? (segments[0] ?? "") : body;
    if (!promptText) continue;
    // Skip the prompt's own format example if it ever leaks through (a pure
    // angle-bracket placeholder like "<question>"), so the user never sees template text.
    if (isPlaceholder(promptText)) continue;
    // Drop any leaked template placeholder option labels (e.g. "<option A>") so a
    // partially-echoed bullet can't show "<option A>" chips. If that empties a choice
    // question's options, the normalization below degrades it to free text.
    const options = (splitAsChoice ? segments.slice(1) : [])
      .filter((label) => !isPlaceholder(label))
      .map((label, i) => ({ id: `o${i + 1}`, label }));
    // Untagged: choice when options were given, else free text. A choice with no
    // options can't be picked, so degrade to text.
    if (!kindTagged) kind = options.length > 0 ? "single" : "text";
    if (kind !== "text" && options.length === 0) kind = "text";
    // Normalize: text questions are free-form (NO options, accept free text);
    // choice questions are choice-only. Keyed off the final kind so a tagged
    // `[text] ... :: A :: B` can't end up unanswerable (options + allow_text:false).
    const isText = kind === "text";
    questions.push({
      id: `q${questions.length + 1}`,
      tier: 0,
      prompt: promptText,
      kind,
      options: isText ? [] : options,
      allow_text: isText,
      rationale: "Surfaced by the grounding plan's open-questions interview.",
    });
  }
  return questions;
}

export function readAnswers(path: string): SpecAnswersFile {
  const parsed = readJsonSafe<SpecAnswersFile | InterviewAnswer[]>(path);
  if (!parsed) throw new Error(`could not parse answers JSON: ${path}`);
  if (Array.isArray(parsed)) return { answers: parsed };
  return { ...parsed, answers: parsed.answers ?? [] };
}

/**
 * The resolved answer for a question, or null when genuinely unanswered. Counts
 * BOTH selected option_ids (resolved to their labels) and free text — so a
 * choice question answered only via chips (text: null) is NOT treated as missing.
 * Without this, single/multi answers would freeze as unresolved clarifications.
 */
function answerText(q: InterviewQuestion, answers: InterviewAnswer[]): string | null {
  const a = answers.find((x) => x.question_id === q.id);
  if (!a) return null;
  const labels = (a.option_ids ?? [])
    .map((id) => q.options.find((o) => o.id === id)?.label)
    .filter((l): l is string => typeof l === "string" && l.length > 0);
  const text = a.text?.trim();
  const parts = text ? [...labels, text] : labels;
  return parts.length > 0 ? parts.join(", ") : null;
}

export function draftFromPlanAndAnswers(prompt: string, plan: string, questions: InterviewQuestion[], file: SpecAnswersFile): SpecDraft {
  // Resolve each interview question to its answer (selected option labels + free
  // text), or null when unanswered. RECORD the resolved decisions in the frozen
  // SpecPack — both structurally (open_questions: status resolved + resolution) and
  // human-readably (decided_tradeoffs) — so an Implement run that reads `specPath`
  // knows exactly what the user chose. Unanswered questions stay `open`, which makes
  // freeze fail loudly (a frozen SpecPack cannot carry open clarifications).
  const resolved = questions
    .map((q) => ({ q, answer: answerText(q, file.answers) }))
    .filter((x): x is { q: InterviewQuestion; answer: string } => x.answer !== null);
  return {
    summary: file.summary ?? `Spec for: ${prompt}`,
    success_criteria: (file.success_criteria ?? []).map((text, i) => ({
      id: `ac${i + 1}`,
      behavior: text,
      required: true,
    })),
    non_goals: file.non_goals ?? [],
    forbidden_approaches: file.forbidden_approaches ?? [],
    decided_tradeoffs: [
      ...(file.decided_tradeoffs ?? []),
      // Provenance lines kept first (stable position) — interview decisions follow.
      "Grounding came from Claudexor plan mode: multi-harness read-only planning plus cross-family plan review.",
      `Plan grounding hash: ${hashJson({ plan })}`,
      ...resolved.map(({ q, answer }) => `Interview — ${q.prompt} → ${answer}`),
    ],
    tests: (file.tests ?? []).map((command, i) => ({ id: `gate-${i + 1}`, command, required: true })),
    tasks: [
      { id: "task-1", title: "Implement against the frozen SpecPack", depends_on: [], done: false },
      { id: "task-2", title: "Run deterministic gates and cross-family review", depends_on: ["task-1"], done: false },
    ],
    clarifications: questions.map((q) => {
      const answer = answerText(q, file.answers);
      return {
        id: `clarify-${q.id}`,
        claim: q.prompt,
        status: answer ? ("resolved" as const) : ("open" as const),
        resolution: answer,
      };
    }),
    // The plan grounding hash lives in decided_tradeoffs (above); native exports
    // carry the full plan text. protected_paths is the only wired constraint.
    constraints: {
      protected_paths: [],
    },
  };
}

/**
 * Validate submitted answers against the question contract BEFORE freezing — fail
 * loudly (Bible §5: no silent guessing) rather than freeze a malformed SpecPack.
 * Rejects an answer for an unknown question id, unknown option ids, more than one
 * option on a single-choice question, and free text where the question disallows it.
 */
export function validateAnswers(questions: InterviewQuestion[], answers: InterviewAnswer[]): void {
  const byId = new Map(questions.map((q) => [q.id, q] as const));
  const seen = new Set<string>();
  for (const a of answers) {
    if (seen.has(a.question_id)) {
      throw new Error(`spec answer: duplicate answer for question "${a.question_id}"`);
    }
    seen.add(a.question_id);
    const q = byId.get(a.question_id);
    if (!q) throw new Error(`spec answer for unknown question "${a.question_id}"`);
    const validIds = new Set(q.options.map((o) => o.id));
    const unknown = (a.option_ids ?? []).filter((id) => !validIds.has(id));
    if (unknown.length > 0) {
      throw new Error(`spec answer for "${q.id}": unknown option id(s): ${unknown.join(", ")}`);
    }
    if (q.kind === "single" && (a.option_ids?.length ?? 0) > 1) {
      throw new Error(`spec answer for "${q.id}": single-choice question accepts at most one option`);
    }
    if (!q.allow_text && (a.text?.trim() ?? "") !== "") {
      throw new Error(`spec answer for "${q.id}": free text is not allowed for this question`);
    }
  }
}

export async function freezeSpecFromGrounding(prompt: string, plan: string, answers: SpecAnswersFile): Promise<SpecPack> {
  const questions = extractQuestionsFromPlan(plan);
  validateAnswers(questions, answers.answers);
  const engine = new InterviewEngine({
    intent: prompt,
    generator: async (state) => (state.tier === 0 ? questions : []),
    assembler: async () => draftFromPlanAndAnswers(prompt, plan, questions, answers),
  });
  await engine.runToConvergence((qs) =>
    qs.map((q) => {
      const a = answers.answers.find((x) => x.question_id === q.id);
      return a ?? { question_id: q.id, option_ids: [], text: null };
    }),
  );
  return engine.freeze();
}

function renderNativePlanProjection(spec: SpecPack, plan: string, specHash: string): string {
  return [
    `# Claudexor Spec ${spec.id} v${spec.version}`,
    "",
    `Spec hash: \`${specHash}\``,
    "",
    "## Intent",
    spec.intent.raw,
    "",
    "## Summary",
    spec.summary || "(none)",
    "",
    "## Acceptance Criteria",
    ...(spec.success_criteria.length ? spec.success_criteria.map((c) => `- [${c.id}] ${c.behavior}`) : ["- (none)"]),
    "",
    "## Tests",
    ...(spec.tests.length ? spec.tests.map((t) => `- ${t.command}`) : ["- (none configured)"]),
    "",
    "## Non-goals",
    ...(spec.non_goals.length ? spec.non_goals.map((x) => `- ${x}`) : ["- (none)"]),
    "",
    "## Forbidden approaches",
    ...(spec.forbidden_approaches.length ? spec.forbidden_approaches.map((x) => `- ${x}`) : ["- (none)"]),
    "",
    "## Source plan grounding",
    redactSecrets(plan).trim(),
    "",
    "> This file is a generated projection for native harnesses. The canonical SSOT",
    `> is .claudexor/specs/${spec.id}/spec.json (hash above). Regenerate rather than editing this projection.`,
    "",
  ].join("\n");
}

export function persistSpec(repoRoot: string, spec: SpecPack, plan: string, previous?: SpecPack | null): {
  specDir: string;
  specHash: string;
  changes: SpecFieldChange[];
} {
  const canonical = SpecPackSchema.parse(spec);
  const specDir = join(repoRoot, ".claudexor", "specs", canonical.id);
  ensureDir(specDir);
  const specHash = hashJson(canonical);
  const changes = previous ? diffSpecPacks(previous, canonical) : [];
  writeJson(join(specDir, "spec.json"), canonical);
  new ArtifactStore(repoRoot).writeYaml(join(specDir, "spec.yaml"), canonical);
  writeText(join(specDir, "PLANS.md"), renderNativePlanProjection(canonical, plan, specHash));
  writeJson(join(specDir, "changes.json"), changes);
  return { specDir, specHash, changes };
}

export function loadPreviousSpec(path?: string): SpecPack | null {
  if (!path) return null;
  const raw = readFileSync(path, "utf8");
  return SpecPackSchema.parse(JSON.parse(raw));
}
