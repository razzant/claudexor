import type {
  ClarificationItem,
  InterviewAnswer,
  InterviewQuestion,
  SpecPack,
} from "@claudex/schema";
import { SpecPack as SpecPackSchema } from "@claudex/schema";
import { newId, nowIso } from "@claudex/util";

/** Snapshot of interview state handed to the (harness-driven) generator/assembler. */
export interface InterviewState {
  intent: string;
  tier: number;
  questions: InterviewQuestion[];
  answers: InterviewAnswer[];
  clarifications: ClarificationItem[];
}

/**
 * Produces the next tier of quiz cards given the state so far (returns [] when the
 * interview has converged). Injected so a harness/LLM drives it; tests use a fake.
 */
export type QuestionGenerator = (state: InterviewState) => Promise<InterviewQuestion[]>;

/** Spec fields the assembler derives from the answers (the LLM-driven synthesis step). */
export interface SpecDraft {
  summary?: string;
  success_criteria?: SpecPack["success_criteria"];
  non_goals?: string[];
  forbidden_approaches?: string[];
  decided_tradeoffs?: string[];
  constraints?: SpecPack["constraints"];
  tests?: SpecPack["tests"];
  tasks?: SpecPack["tasks"];
  /** Newly surfaced ambiguities; merged into open_questions (nothing guessed silently). */
  clarifications?: ClarificationItem[];
}

export type SpecAssembler = (state: InterviewState) => Promise<SpecDraft>;

export interface InterviewEngineOptions {
  intent: string;
  generator: QuestionGenerator;
  assembler: SpecAssembler;
  /** Stable spec id reused across freezes (spec-anchored history). Default: generated once. */
  specId?: string;
  /** Safety cap on tiers so a misbehaving generator cannot loop forever. Default 12. */
  maxTiers?: number;
}

/** Thrown when freeze is attempted while ambiguities remain unresolved. */
export class UnresolvedClarificationsError extends Error {
  constructor(public readonly open: ClarificationItem[]) {
    super(`cannot freeze SpecPack: ${open.length} open clarification(s) — resolve them first (no silent guessing)`);
    this.name = "UnresolvedClarificationsError";
  }
}

/** Thrown when the interview hits the tier cap without the generator converging. */
export class InterviewNotConvergedError extends Error {
  constructor(public readonly tiers: number) {
    super(`interview did not converge within ${tiers} tier(s) — refusing to assemble an incomplete spec (no silent guessing)`);
    this.name = "InterviewNotConvergedError";
  }
}

/**
 * Deterministic state machine for the spec interview. The LLM-driven parts
 * (question generation, draft assembly) are injected; this engine owns the
 * invariant-bearing logic: hierarchical Q&A, NEEDS_CLARIFICATION tracking, and a
 * freeze that fails loudly while ambiguities are open.
 */
export class InterviewEngine {
  private tier = 0;
  private readonly questions: InterviewQuestion[] = [];
  private readonly answers: InterviewAnswer[] = [];
  private readonly clarifications: ClarificationItem[] = [];
  private draft: SpecDraft = {};
  /** Stable id for the whole spec lifecycle so successive freezes stack as revisions. */
  private readonly specId: string;
  /** Monotonic revision counter; each freeze() increments it. */
  private revision = 0;
  /** True once the generator signals convergence (returns []). */
  private converged = false;

  constructor(private readonly opts: InterviewEngineOptions) {
    this.specId = opts.specId ?? newId("spec");
  }

  state(): InterviewState {
    return {
      intent: this.opts.intent,
      tier: this.tier,
      questions: [...this.questions],
      answers: [...this.answers],
      clarifications: [...this.clarifications],
    };
  }

  /** Generate and append the next tier of questions; returns [] when converged. */
  async nextTier(): Promise<InterviewQuestion[]> {
    const next = await this.opts.generator(this.state());
    if (next.length > 0) {
      // Stamp the current tier depth defensively (don't trust the generator to set it).
      const stamped = next.map((q) => ({ ...q, tier: this.tier }));
      this.questions.push(...stamped);
      this.tier += 1;
      return stamped;
    }
    this.converged = true;
    return next;
  }

  /** Whether the generator has signaled convergence (returned [] at least once). */
  isConverged(): boolean {
    return this.converged;
  }

  /** Record answers (idempotent per question id — the latest answer wins). */
  answer(answers: InterviewAnswer[]): void {
    for (const a of answers) {
      const idx = this.answers.findIndex((x) => x.question_id === a.question_id);
      if (idx >= 0) this.answers[idx] = a;
      else this.answers.push(a);
    }
  }

  openClarifications(): ClarificationItem[] {
    return this.clarifications.filter((c) => c.status === "open");
  }

  resolveClarification(id: string, resolution: string): void {
    const c = this.clarifications.find((x) => x.id === id);
    if (!c) throw new Error(`no such clarification: ${id}`);
    c.status = "resolved";
    c.resolution = resolution;
  }

  /**
   * Run the assembler to synthesize draft spec fields from the answers and merge
   * any newly surfaced clarifications. Call before freeze; safe to call repeatedly.
   */
  async assemble(): Promise<SpecDraft> {
    this.draft = await this.opts.assembler(this.state());
    for (const c of this.draft.clarifications ?? []) {
      if (!this.clarifications.some((x) => x.id === c.id)) this.clarifications.push(c);
    }
    return this.draft;
  }

  /**
   * Freeze into a validated SpecPack. Reuses the stable spec id and auto-increments
   * the revision so successive freezes stack as spec-anchored history. Fails loudly
   * if any clarification is still open (no silent guessing — a core invariant).
   */
  freeze(): SpecPack {
    const open = this.openClarifications();
    if (open.length > 0) throw new UnresolvedClarificationsError(open);
    this.revision += 1;
    return SpecPackSchema.parse({
      schema_version: 1,
      id: this.specId,
      created_at: nowIso(),
      version: this.revision,
      frozen: true,
      intent: { raw: this.opts.intent, normalized: this.draft.summary },
      summary: this.draft.summary ?? "",
      success_criteria: this.draft.success_criteria ?? [],
      non_goals: this.draft.non_goals ?? [],
      forbidden_approaches: this.draft.forbidden_approaches ?? [],
      decided_tradeoffs: this.draft.decided_tradeoffs ?? [],
      constraints: this.draft.constraints ?? {},
      tests: this.draft.tests ?? [],
      tasks: this.draft.tasks ?? [],
      open_questions: this.clarifications,
      interview: { questions: this.questions, answers: this.answers },
    });
  }

  /**
   * Convenience: run tiers until the generator converges (returns []), then assemble.
   * If the tier cap is hit WITHOUT convergence, fail loudly rather than assemble an
   * incomplete spec — capped exhaustion is not convergence (no silent guessing).
   */
  async runToConvergence(answerFor: (qs: InterviewQuestion[]) => InterviewAnswer[]): Promise<void> {
    const maxTiers = this.opts.maxTiers ?? 12;
    for (let i = 0; i < maxTiers; i++) {
      const qs = await this.nextTier();
      if (qs.length === 0) break;
      this.answer(answerFor(qs));
    }
    if (!this.converged) throw new InterviewNotConvergedError(maxTiers);
    await this.assemble();
  }
}
