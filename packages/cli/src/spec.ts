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

export function extractQuestionsFromPlan(plan: string): InterviewQuestion[] {
  const lines = plan.split("\n");
  const start = lines.findIndex((l) => /^#+\s+.*open questions/i.test(l.trim()));
  if (start < 0) return [];
  const questions: InterviewQuestion[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line.trim())) break;
    const m = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const claim = m[1] ?? "";
    if (!claim || claim.startsWith("(none")) continue;
    questions.push({
      id: `q${questions.length + 1}`,
      tier: 0,
      prompt: claim,
      kind: "text",
      options: [],
      allow_text: true,
      rationale: "Surfaced by cross-family plan review / ambiguity extraction.",
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

function answerText(q: InterviewQuestion, answers: InterviewAnswer[]): string | null {
  return answers.find((a) => a.question_id === q.id)?.text?.trim() || null;
}

export function draftFromPlanAndAnswers(prompt: string, plan: string, questions: InterviewQuestion[], file: SpecAnswersFile): SpecDraft {
  const missing = questions.filter((q) => !answerText(q, file.answers));
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
      "Grounding came from Claudexor plan mode: multi-harness read-only planning plus cross-family plan review.",
      `Plan grounding hash: ${hashJson({ plan })}`,
    ],
    tests: (file.tests ?? []).map((command, i) => ({ id: `gate-${i + 1}`, command, required: true })),
    tasks: [
      { id: "task-1", title: "Implement against the frozen SpecPack", depends_on: [], done: false },
      { id: "task-2", title: "Run deterministic gates and cross-family review", depends_on: ["task-1"], done: false },
    ],
    clarifications: missing.map((q) => ({
      id: `clarify-${q.id}`,
      claim: q.prompt,
      status: "open" as const,
      resolution: null,
    })),
    // The plan grounding hash lives in decided_tradeoffs (above); native exports
    // carry the full plan text. protected_paths is the only wired constraint.
    constraints: {
      protected_paths: [],
    },
  };
}

export async function freezeSpecFromGrounding(prompt: string, plan: string, answers: SpecAnswersFile): Promise<SpecPack> {
  const questions = extractQuestionsFromPlan(plan);
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
