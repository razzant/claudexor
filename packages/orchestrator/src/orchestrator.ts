import { join } from "node:path";
import type {
  AccessProfile,
  GateResult,
  HarnessEvent,
  ModeKind,
  Portfolio,
  ProjectConfig,
  ReviewFinding,
  RunEvent,
  RunStatus,
  TaskContract,
  WorkspaceEnvelope,
} from "@claudex/schema";
import { HarnessRunSpec, TaskContract as TaskContractSchema, isBlocking } from "@claudex/schema";
import { loadConfig } from "@claudex/config";
import type { AdapterRegistry, HarnessAdapter } from "@claudex/core";
import { ExecutionEngine, HarnessUnavailableError } from "@claudex/core";
import { ArtifactStore } from "@claudex/artifact-store";
import { EventLog } from "@claudex/event-log";
import { buildContextPack, writeEvidencePacket } from "@claudex/context";
import { WorkspaceManager } from "@claudex/workspace";
import { HarnessGateway } from "@claudex/gateway";
import {
  type GateSpec,
  ReadinessLedger,
  type ReviewerSpec,
  evaluateConvergence,
  failureSignature,
  gatesPassed,
  reviewCandidate,
  revalidateFindings,
  runGates,
} from "@claudex/review";
import { type CandidateEvidence, arbitrate } from "@claudex/arbitration";
import { type SynthesisMode, buildSynthesisPlan, decideSynthesis } from "@claudex/synthesis";
import { BudgetLedger, observationFromEvent } from "@claudex/budget";
import { hashJson, newId, nowIso, redactSecrets, safeInvoke } from "@claudex/util";

export interface OrchestratorDeps {
  registry: AdapterRegistry;
  reviewers?: ReviewerSpec[];
  portfolio?: Portfolio;
  maxUsd?: number | null;
  /**
   * Optional per-provider-family reviewer model override (e.g. a cheaper model
   * for benchmark portfolios). No hardcoded versions: the caller supplies the
   * model id, default keeps each harness's own default reviewer model.
   */
  reviewerModels?: Record<string, string>;
}

export interface RunInput {
  repoRoot: string;
  prompt: string;
  mode?: ModeKind;
  harnesses?: string[];
  n?: number;
  baseRef?: string;
  attempts?: number | null;
  synthesis?: SynthesisMode;
  /** Explicit deterministic gate commands (e.g. from `--test` or a bench runner). */
  tests?: string[];
  /** Hard per-run spend cap (USD); overrides deps.maxUsd when set. */
  maxUsd?: number | null;
  /** Access profile (daily mode); e.g. `full` for autonomous terminal tasks. */
  access?: AccessProfile;
  /** Optional model hint forwarded to the harness (daily mode). */
  model?: string;
  /** Pre-assigned ids so a caller (daemon/control-api) knows them before the run starts. */
  runId?: string;
  taskId?: string;
  /** In-process sink for every RunEvent (mirrors events.jsonl) for live observers. */
  onEvent?: (event: RunEvent) => void;
  /** In-process sink for the full per-harness event stream (richer than RunEvent). */
  onHarnessEvent?: (event: HarnessEvent) => void;
  /** Called once when the run id/dir are known, before any harness work begins. */
  onRunStart?: (info: { runId: string; taskId: string; runDir: string }) => void;
  /** Cancellation: aborts the run and cancels in-flight harness work. */
  signal?: AbortSignal;
}

export interface OrchestratorResult {
  runId: string;
  taskId: string;
  mode: ModeKind;
  status: RunStatus;
  winner: string | null;
  runDir: string;
  summary: string;
  candidates: { attemptId: string; harnessId: string; status: string }[];
  decisionPath?: string;
  reviewVerified?: boolean;
}

interface CandidateRun {
  attemptId: string;
  harnessId: string;
  label: string;
  diff: string;
  gates: GateResult[];
  cost: number;
  errored: boolean;
  /** True when any of `cost` is token-estimated (not natively reported). */
  costEstimated: boolean;
}

const LABELS = "ABCDEFGHIJ".split("");

export class Orchestrator {
  private readonly gateway: HarnessGateway;

  constructor(private readonly deps: OrchestratorDeps) {
    this.gateway = new HarnessGateway(deps.registry);
  }

  async run(input: RunInput): Promise<OrchestratorResult> {
    const mode: ModeKind = input.mode ?? "daily";
    switch (mode) {
      case "best_of_n":
      case "create":
      case "benchmark":
        return this.runRace(input, mode);
      case "until_convergence":
        return this.runConvergence(input, mode, null);
      case "max_attempts":
        return this.runConvergence(input, mode, input.attempts ?? 3);
      case "plan":
        return this.runPlan(input);
      case "readonly_swarm":
        return this.runAudit(input);
      case "daily":
      default:
        return this.runDaily(input);
    }
  }

  private async runDaily(input: RunInput): Promise<OrchestratorResult> {
    const harnessId = input.harnesses?.[0] ?? (await this.gateway.resolve()).id;
    const engine = new ExecutionEngine(this.deps.registry);
    const res = await engine.run({
      repoRoot: input.repoRoot,
      prompt: input.prompt,
      harnessId,
      mode: "daily",
      access: input.access,
      model: input.model,
      runId: input.runId,
      taskId: input.taskId,
      onEvent: input.onEvent,
      onHarnessEvent: input.onHarnessEvent,
      onRunStart: input.onRunStart,
      signal: input.signal,
    });
    return {
      runId: res.runId,
      taskId: res.taskId,
      mode: "daily",
      status: res.status,
      winner: res.status === "success" ? "a01" : null,
      runDir: res.runDir,
      summary: res.summary,
      candidates: [{ attemptId: "a01", harnessId: res.harnessId, status: res.status }],
    };
  }

  private async resolveReviewers(): Promise<ReviewerSpec[]> {
    if (this.deps.reviewers) return this.deps.reviewers;
    const specs: ReviewerSpec[] = [];
    const seen = new Set<string>();
    for (const adapter of this.deps.registry.values()) {
      try {
        const m = await adapter.discover();
        if (m.kind === "fake" || seen.has(m.provider_family)) continue;
        seen.add(m.provider_family);
        specs.push({
          adapter,
          providerFamily: m.provider_family,
          requestedModel: this.deps.reviewerModels?.[m.provider_family] ?? null,
        });
      } catch {
        /* unavailable */
      }
      if (specs.length >= 2) break;
    }
    return specs;
  }

  /** Resolve candidate adapters: explicit `--harness`, else available real harnesses; expand to n. */
  private async resolveCandidateAdapters(input: RunInput): Promise<HarnessAdapter[]> {
    let ids = input.harnesses;
    if (!ids || ids.length === 0) {
      ids = await this.gateway.availableReal();
      if (ids.length === 0) {
        throw new HarnessUnavailableError(
          "no available harness for this mode; install codex/claude/cursor/opencode, or pass --harness",
        );
      }
    }
    const pool = ids.map((id) => this.deps.registry.get(id)).filter((a): a is HarnessAdapter => Boolean(a));
    if (pool.length === 0) throw new HarnessUnavailableError(`none of the requested harnesses are registered: ${ids.join(", ")}`);
    const n = input.n ?? pool.length;
    const out: HarnessAdapter[] = [];
    for (let i = 0; i < n; i++) out.push(pool[i % pool.length] as HarnessAdapter);
    return out;
  }

  private projectConfig(repoRoot: string): ProjectConfig | null {
    try {
      return loadConfig(repoRoot).project;
    } catch {
      return null;
    }
  }

  private buildContract(input: RunInput, taskId: string, mode: ModeKind): TaskContract {
    const cfg = this.projectConfig(input.repoRoot);
    // Deterministic gate commands come from `--test`/bench runner first, then the
    // versioned project config. Without these, gateSpecs is empty and convergence
    // is review-only; with them, convergence is test-driven.
    const commands = [...(input.tests ?? []), ...(cfg?.tests?.commands ?? [])]
      .map((c) => c.trim())
      .filter(Boolean)
      .map((command, i) => ({ id: `gate-${i + 1}`, command, required: true }));
    return TaskContractSchema.parse({
      schema_version: 1,
      task_id: taskId,
      created_at: nowIso(),
      repo: { root: input.repoRoot, base_ref: input.baseRef ?? "HEAD", dirty_policy: "snapshot" },
      mode: { kind: mode },
      user_intent: { raw: input.prompt },
      tests: { commands },
      budget: {
        portfolio: this.deps.portfolio ?? cfg?.budget?.portfolio ?? "daily-rich",
        max_usd: input.maxUsd ?? this.deps.maxUsd ?? null,
      },
    });
  }

  private gateSpecs(contract: TaskContract): GateSpec[] {
    return contract.tests.commands.map((c) => ({ id: c.id, command: c.command, required: c.required }));
  }

  /** Terminal result for a cancelled run: emits run.failed with status "cancelled" so every mode ends consistently. */
  private cancelledResult(
    log: EventLog,
    runId: string,
    taskId: string,
    mode: ModeKind,
    runDir: string,
    candidates: { attemptId: string; harnessId: string; status: string }[],
  ): OrchestratorResult {
    log.emit("run.failed", { status: "cancelled" });
    return { runId, taskId, mode, status: "cancelled", winner: null, runDir, summary: "run cancelled", candidates };
  }

  /** Run one candidate inside an already-created envelope. Never creates/disposes the envelope. */
  private async runCandidateInEnvelope(
    adapter: HarnessAdapter,
    envelope: WorkspaceEnvelope,
    attemptId: string,
    label: string,
    contract: TaskContract,
    prompt: string,
    store: ArtifactStore,
    paths: ReturnType<ArtifactStore["runPaths"]>,
    wsm: WorkspaceManager,
    ledger: BudgetLedger,
    onHarnessEvent?: (event: HarnessEvent) => void,
    signal?: AbortSignal,
  ): Promise<CandidateRun> {
    const spec = HarnessRunSpec.parse({
      session_id: newId("ses"),
      intent: "implement",
      prompt,
      cwd: envelope.worktree_path,
      access: "workspace_write",
      env: wsm.envFor(envelope),
    });

    let cost = 0;
    let costEstimated = false;
    let errored = false;
    const onAbort = () => {
      void adapter.cancel?.(spec.session_id)?.catch(() => {});
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      for await (const ev of adapter.run(spec)) {
        if (signal?.aborted) break;
        safeInvoke(onHarnessEvent, ev);
        if (ev.type === "usage" && ev.usage?.cost_usd) {
          cost += ev.usage.cost_usd;
          if (ev.usage.estimated) costEstimated = true;
        }
        if (ev.type === "error") errored = true;
        // Observe budget/quota signals (rate-limit -> cooldown) so the router/loop can react.
        const obs = observationFromEvent(adapter.id, ev);
        if (obs) ledger.observe(obs);
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }

    const diff = await wsm.diff(envelope);
    const gates = await runGates(this.gateSpecs(contract), {
      cwd: envelope.worktree_path,
      env: wsm.envFor(envelope),
    });

    const attemptDir = join(paths.attemptsDir, attemptId);
    store.writeText(join(attemptDir, "patch.diff"), diff);
    store.writeYaml(join(attemptDir, "attempt.yaml"), {
      attempt_id: attemptId,
      harness_id: adapter.id,
      cost_usd: cost,
      errored,
      gates: gates.map((g) => ({ id: g.id, status: g.status })),
      branch: envelope.branch_name,
    });
    return { attemptId, harnessId: adapter.id, label, diff, gates, cost, errored, costEstimated };
  }

  private toEvidence(
    run: CandidateRun,
    contract: TaskContract,
    findings: ReviewFinding[],
    finalReviewClean: boolean,
  ): CandidateEvidence {
    const passed = gatesPassed(run.gates) && !run.errored;
    const acTotal = Math.max(1, contract.success_criteria.length);
    const acCovered = passed
      ? contract.success_criteria.length > 0
        ? contract.success_criteria.map((c) => c.id)
        : ["AC-implicit"]
      : [];
    // Treat a harness error as a failed required gate so it cannot win arbitration.
    const gates = run.errored
      ? [...run.gates, { id: "harness", command: "harness", exit_code: 1, status: "failed" as const, duration_ms: 0, required: true }]
      : run.gates;
    return {
      attemptId: run.attemptId,
      label: run.label,
      gates,
      acceptanceCovered: acCovered,
      acceptanceTotal: acTotal,
      findings,
      testsPassed: run.gates.filter((g) => g.status === "passed").length,
      testsTotal: run.gates.length,
      finalReviewClean,
      diffSize: run.diff.split("\n").length,
      costUsd: run.cost,
    };
  }

  private async runRace(input: RunInput, mode: ModeKind): Promise<OrchestratorResult> {
    const taskId = input.taskId ?? newId("task");
    const runId = input.runId ?? newId("run");
    const store = new ArtifactStore(input.repoRoot);
    const paths = store.createRun(runId);
    const log = new EventLog(paths.eventsPath, runId, taskId, input.onEvent);
    const wsm = new WorkspaceManager(input.repoRoot);

    safeInvoke(input.onRunStart, { runId, taskId, runDir: paths.root });
    log.emit("run.created", { mode, prompt: redactSecrets(input.prompt) });
    const contract = this.buildContract(input, taskId, mode);
    const ledger = new BudgetLedger({ maxUsd: contract.budget.max_usd ?? null });
    store.writeYaml(join(paths.contextDir, "task.yaml"), contract);
    log.emit("task.contract.created", { task_contract_hash: hashJson(contract) });

    const contextPack = await buildContextPack(input.repoRoot, contract).catch(() => null);
    if (contextPack) store.writeYaml(join(paths.contextDir, "context_pack.yaml"), contextPack);

    const reviewDir = join(paths.root, "review-evidence");
    writeEvidencePacket(reviewDir, {
      userIntent: input.prompt,
      diff: "(per-candidate diffs are supplied to reviewers individually)\n",
      tests: contract.tests.commands.map((c) => c.command).join("\n") || "(no test commands configured)",
    });

    const adapters = await this.resolveCandidateAdapters(input);
    const reviewers = await this.resolveReviewers();
    const reviewVerified = reviewers.length >= 2;

    const runs: CandidateRun[] = [];
    let budgetStopped = false;
    for (let i = 0; i < adapters.length; i++) {
      if (input.signal?.aborted) break;
      const adapter = adapters[i] as HarnessAdapter;
      const attemptId = `a${String(i + 1).padStart(2, "0")}`;
      const label = `Candidate ${LABELS[i] ?? i + 1}`;

      const lease = ledger.reserve({ taskId, attemptId, intent: "implement", harnessId: adapter.id });
      if (!lease.granted) {
        log.emit("budget.lease.created", { granted: false, reason: lease.reason, attempt_id: attemptId });
        budgetStopped = true;
        break; // hard cap: do not spawn more paid work
      }

      let envelope: WorkspaceEnvelope | undefined;
      try {
        log.emit("harness.started", { harness_id: adapter.id, attempt_id: attemptId });
        envelope = await wsm.create({ taskId, attemptId, baseRef: contract.repo.base_ref, dirtyPolicy: "snapshot" });
        const run = await this.runCandidateInEnvelope(
          adapter, envelope, attemptId, label, contract, contract.user_intent.raw, store, paths, wsm, ledger, input.onHarnessEvent, input.signal,
        );
        ledger.settle(lease.lease?.lease_id ?? "", run.cost);
        log.emit("harness.completed", { harness_id: adapter.id, attempt_id: attemptId, cost_usd: run.cost });
        runs.push(run);
      } catch (err) {
        ledger.settle(lease.lease?.lease_id ?? "", 0);
        log.emit("run.failed", { harness_id: adapter.id, attempt_id: attemptId, error: err instanceof Error ? err.message : String(err) });
        runs.push({ attemptId, harnessId: adapter.id, label, diff: "", gates: [], cost: 0, errored: true, costEstimated: false });
      } finally {
        if (envelope) await wsm.dispose(envelope); // no worktree leak even on create/run error
      }
    }

    if (input.signal?.aborted) {
      return this.cancelledResult(
        log,
        runId,
        taskId,
        mode,
        paths.root,
        runs.map((r) => ({
          attemptId: r.attemptId,
          harnessId: r.harnessId,
          status: gatesPassed(r.gates) && !r.errored ? "green" : "red",
        })),
      );
    }

    if (runs.length === 0) {
      throw new HarnessUnavailableError("no candidates produced (budget exhausted before any run)");
    }

    log.emit("review.started", { reviewers: reviewers.length, review_verified: reviewVerified });
    const evidences = await this.reviewRuns(runs, reviewers, reviewVerified, reviewDir, input.repoRoot, contract, store, paths, log);

    // Synthesis: if worthwhile, run a synthesizer as a NEW, re-checked candidate.
    const synth = decideSynthesis(evidences, input.synthesis ?? "auto");
    store.writeYaml(join(paths.arbitrationDir, "synthesis.yaml"), synth);
    log.emit("synthesis.started", { synthesize: synth.synthesize, reason: synth.reason });
    if (synth.synthesize && !budgetStopped) {
      const lease = ledger.reserve({ taskId, attemptId: "synth", intent: "synthesize", harnessId: adapters[0]?.id ?? "synth" });
      if (lease.granted) {
        let envelope: WorkspaceEnvelope | undefined;
        try {
          const plan = buildSynthesisPlan(evidences);
          const sourceDiffs = runs.map((r) => `### ${r.label} (${r.attemptId})\n${r.diff}`).join("\n\n");
          const synthAdapter = adapters[0] as HarnessAdapter;
          envelope = await wsm.create({ taskId, attemptId: "synth", baseRef: contract.repo.base_ref, dirtyPolicy: "snapshot" });
          const synthPrompt = `${plan.instructions}\n\nFindings to fix:\n${plan.fixFindings.map((f) => `- ${f}`).join("\n") || "(none)"}\n\nCandidate diffs:\n${sourceDiffs}`;
          const run = await this.runCandidateInEnvelope(
            synthAdapter, envelope, "synth", "Synthesis", contract, synthPrompt, store, paths, wsm, ledger, input.onHarnessEvent, input.signal,
          );
          ledger.settle(lease.lease?.lease_id ?? "", run.cost);
          const synthEvidence = await this.reviewRuns([run], reviewers, reviewVerified, reviewDir, input.repoRoot, contract, store, paths, log);
          evidences.push(...synthEvidence);
          runs.push(run);
        } catch (err) {
          ledger.settle(lease.lease?.lease_id ?? "", 0);
          log.emit("run.failed", { attempt_id: "synth", error: err instanceof Error ? err.message : String(err) });
        } finally {
          if (envelope) await wsm.dispose(envelope);
        }
      }
    }

    const result = arbitrate(evidences, {
      spendUsd: ledger.spend(),
      estimatedSpend: runs.some((r) => r.costEstimated),
    });
    store.writeYaml(join(paths.arbitrationDir, "decision.yaml"), { ...result.decision, review_verified: reviewVerified });
    store.writeYaml(join(paths.arbitrationDir, "pairwise.yaml"), result.pairwise);
    const decisionPath = join(paths.arbitrationDir, "decision.yaml");
    log.emit("arbitration.completed", { winner: result.decision.winner, status: result.decision.status });

    const winnerRun = runs.find((r) => r.attemptId === result.decision.winner) ?? runs[0];
    if (winnerRun) {
      store.writeText(join(paths.finalDir, "patch.diff"), winnerRun.diff);
      store.writeYaml(join(paths.finalDir, "work_product.yaml"), {
        id: newId("wp"),
        kind: mode === "create" ? "new_repo" : "patch",
        source_task_id: taskId,
        producer_attempt_id: winnerRun.attemptId,
        meta: { harness_id: winnerRun.harnessId, synthesis: synth, mode, review_verified: reviewVerified, budget_stopped: budgetStopped },
      });
      store.writeText(join(paths.finalDir, "summary.md"), renderSummary(runId, mode, result.decision, evidences, synth.reason, reviewVerified));
    }

    log.emit("work_product.emitted", { winner: result.decision.winner });
    log.emit(result.decision.status === "success" ? "run.completed" : "run.failed", { status: result.decision.status });

    return {
      runId,
      taskId,
      mode,
      status: result.decision.status,
      winner: result.decision.winner,
      runDir: paths.root,
      summary: result.decision.why_winner,
      candidates: runs.map((r) => ({
        attemptId: r.attemptId,
        harnessId: r.harnessId,
        status: gatesPassed(r.gates) && !r.errored ? "green" : "red",
      })),
      decisionPath,
      reviewVerified,
    };
  }

  /** Review a set of runs and return their evidence (with finalReviewClean + review_verified caveat). */
  private async reviewRuns(
    runs: CandidateRun[],
    reviewers: ReviewerSpec[],
    reviewVerified: boolean,
    reviewDir: string,
    cwd: string,
    contract: TaskContract,
    store: ArtifactStore,
    paths: ReturnType<ArtifactStore["runPaths"]>,
    log: EventLog,
  ): Promise<CandidateEvidence[]> {
    const evidences: CandidateEvidence[] = [];
    for (const run of runs) {
      const result =
        reviewers.length > 0
          ? await reviewCandidate({ candidateLabel: run.label, diff: run.diff, evidenceDir: reviewDir, cwd, reviewers })
          : { findings: [], routeProofs: [], crossFamilyVerified: false, distinctProviders: [] };
      const revalidated = await revalidateFindings(result.findings);
      const noBlockers = !revalidated.some((f) => isBlocking(f));
      // Honest: if reviewers are unavailable, fall back to gates-only and mark review_verified=false.
      const finalReviewClean = reviewers.length === 0 ? gatesPassed(run.gates) && !run.errored : result.crossFamilyVerified && noBlockers;
      store.writeYaml(join(paths.reviewsDir, `${run.attemptId}.yaml`), {
        attempt_id: run.attemptId,
        review_verified: reviewVerified && result.crossFamilyVerified,
        cross_family_verified: result.crossFamilyVerified,
        findings: revalidated,
        route_proofs: result.routeProofs,
      });
      for (const f of revalidated) log.emit("finding.revalidated", { attempt_id: run.attemptId, severity: f.severity, status: f.status });
      evidences.push(this.toEvidence(run, contract, revalidated, finalReviewClean));
    }
    return evidences;
  }

  private async runConvergence(input: RunInput, mode: ModeKind, maxAttempts: number | null): Promise<OrchestratorResult> {
    const taskId = input.taskId ?? newId("task");
    const runId = input.runId ?? newId("run");
    const store = new ArtifactStore(input.repoRoot);
    const paths = store.createRun(runId);
    const log = new EventLog(paths.eventsPath, runId, taskId, input.onEvent);
    const wsm = new WorkspaceManager(input.repoRoot);
    const readiness = new ReadinessLedger();
    const contract = this.buildContract(input, taskId, mode);
    const ledger = new BudgetLedger({ maxUsd: contract.budget.max_usd ?? null });
    store.writeYaml(join(paths.contextDir, "task.yaml"), contract);
    safeInvoke(input.onRunStart, { runId, taskId, runDir: paths.root });
    log.emit("run.created", { mode, prompt: redactSecrets(input.prompt) });

    const reviewDir = join(paths.root, "review-evidence");
    writeEvidencePacket(reviewDir, { userIntent: input.prompt, diff: "(per-attempt)\n" });
    const reviewers = await this.resolveReviewers();
    const reviewVerified = reviewers.length >= 2;

    // One envelope carried forward across attempts so the harness can repair its own work.
    const adapterPool = await this.resolveCandidateAdapters({ ...input, n: undefined });
    let adapterIdx = 0;
    let adapter = adapterPool[0] as HarnessAdapter;
    let envelope: WorkspaceEnvelope | undefined;

    let attempt = 0;
    let converged = false;
    let exhausted = false;
    let lastFindings: ReviewFinding[] = [];
    let lastRun: CandidateRun | null = null;
    let triedSinceProgress = new Set<string>();
    let lastSig = "";
    // until_convergence has NO fixed attempt cap; it stops on convergence, budget hard tier,
    // observed quota cooldown across all harnesses, or genuine no-progress (a stall on the same
    // failure signature after every available harness has tried it).
    const stallThreshold = mode === "until_convergence" ? 4 : 2;
    const allCooledDown = () => adapterPool.every((a) => ledger.cooldownActive(a.id));

    try {
      envelope = await wsm.create({ taskId, attemptId: "converge", baseRef: contract.repo.base_ref, dirtyPolicy: "snapshot" });
      for (;;) {
        if (input.signal?.aborted) break;
        attempt += 1;
        const attemptId = `a${String(attempt).padStart(2, "0")}`;
        const lease = ledger.reserve({ taskId, attemptId, intent: "repair", harnessId: adapter.id });
        if (!lease.granted) {
          exhausted = true;
          break;
        }

        const prompt =
          attempt === 1
            ? contract.user_intent.raw
            : `${contract.user_intent.raw}\n\nThe previous attempt did not converge. Address these review findings (verify each against the code; fix valid ones, rebut invalid ones with evidence):\n${formatFindings(lastFindings)}`;

        let run: CandidateRun;
        try {
          run = await this.runCandidateInEnvelope(adapter, envelope, attemptId, `Attempt ${attempt}`, contract, prompt, store, paths, wsm, ledger, input.onHarnessEvent, input.signal);
          ledger.settle(lease.lease?.lease_id ?? "", run.cost);
        } catch (err) {
          // A throwing adapter (vs. one that yields an error event) is treated as a failed attempt.
          ledger.settle(lease.lease?.lease_id ?? "", 0);
          log.emit("run.failed", { attempt_id: attemptId, error: err instanceof Error ? err.message : String(err) });
          run = { attemptId, harnessId: adapter.id, label: `Attempt ${attempt}`, diff: "", gates: [], cost: 0, errored: true, costEstimated: false };
        }
        lastRun = run;

        const reviewResult =
          reviewers.length > 0
            ? await reviewCandidate({ candidateLabel: `Attempt ${attempt}`, diff: run.diff, evidenceDir: reviewDir, cwd: input.repoRoot, reviewers })
            : { findings: [], routeProofs: [], crossFamilyVerified: false, distinctProviders: [] };
        const revalidated = await revalidateFindings(reviewResult.findings);
        lastFindings = revalidated;
        const finalReviewClean = reviewers.length === 0 ? gatesPassed(run.gates) && !run.errored : reviewResult.crossFamilyVerified && !revalidated.some((f) => isBlocking(f));

        const conv = evaluateConvergence({
          predicate: contract.convergence,
          gates: run.errored ? [...run.gates, { id: "harness", command: "harness", exit_code: 1, status: "failed", duration_ms: 0, required: true }] : run.gates,
          findings: revalidated,
          finalReviewClean,
          diffStableAfterReview: true,
        });
        log.emit("finding.revalidated", { attempt_id: attemptId, converged: conv.converged, reasons: conv.reasons });

        if (conv.converged) {
          converged = true;
          break;
        }

        const sig = failureSignature(conv.reasons);
        readiness.recordRound(sig, conv.reasons.join("; "));
        if (sig !== lastSig) {
          triedSinceProgress = new Set();
          lastSig = sig;
        }
        triedSinceProgress.add(adapter.id);

        if (ledger.tier() === "hard") {
          exhausted = true;
          break;
        }
        if (allCooledDown()) {
          exhausted = true; // quota exhausted across all harnesses
          break;
        }
        if (maxAttempts !== null && attempt >= maxAttempts) break;
        if (readiness.isStalled(sig, stallThreshold)) {
          if (adapterPool.length > 1 && triedSinceProgress.size < adapterPool.length) {
            adapterIdx = (adapterIdx + 1) % adapterPool.length;
            adapter = adapterPool[adapterIdx] as HarnessAdapter;
            log.emit("harness.started", { harness_id: adapter.id, reason: "stall: switched harness" });
          } else {
            break; // tried every available harness on this failure and still stuck -> stop
          }
        }
      }
    } finally {
      if (envelope) await wsm.dispose(envelope);
    }

    const status: RunStatus = input.signal?.aborted
      ? "cancelled"
      : converged
        ? "success"
        : exhausted
          ? "exhausted"
          : "not_converged";

    // Deliver the converged/last work to final/ so `apply` and `inspect` can use it.
    if (lastRun) {
      store.writeText(join(paths.finalDir, "patch.diff"), lastRun.diff);
      store.writeYaml(join(paths.finalDir, "work_product.yaml"), {
        id: newId("wp"),
        kind: "patch",
        source_task_id: taskId,
        producer_attempt_id: lastRun.attemptId,
        meta: { harness_id: lastRun.harnessId, mode, attempts: attempt, status, review_verified: reviewVerified },
      });
      store.writeText(
        join(paths.finalDir, "summary.md"),
        `# Run ${runId} (${mode})\n\n- Status: ${status}\n- Attempts: ${attempt}\n- Winner: ${lastRun.attemptId}\n- Review verified (cross-family): ${reviewVerified}\n`,
      );
    }

    log.emit("work_product.emitted", { winner: lastRun?.attemptId ?? null });
    log.emit(converged ? "run.completed" : "run.failed", { status, attempts: attempt });
    return {
      runId,
      taskId,
      mode,
      status,
      winner: lastRun?.attemptId ?? null,
      runDir: paths.root,
      summary: converged ? `converged in ${attempt} attempt(s)` : `${status} after ${attempt} attempt(s)`,
      candidates: lastRun ? [{ attemptId: lastRun.attemptId, harnessId: lastRun.harnessId, status }] : [],
      reviewVerified,
    };
  }

  /** plan mode: multi-harness planning -> aggregate -> (optional) plan review -> SpecPack. Read-only. */
  private async runPlan(input: RunInput): Promise<OrchestratorResult> {
    const taskId = input.taskId ?? newId("task");
    const runId = input.runId ?? newId("run");
    const store = new ArtifactStore(input.repoRoot);
    const paths = store.createRun(runId);
    const log = new EventLog(paths.eventsPath, runId, taskId, input.onEvent);
    safeInvoke(input.onRunStart, { runId, taskId, runDir: paths.root });
    log.emit("run.created", { mode: "plan", prompt: redactSecrets(input.prompt) });

    const adapters = await this.resolveCandidateAdapters({ ...input, n: undefined });
    const plans: { id: string; text: string }[] = [];
    for (const adapter of adapters) {
      if (input.signal?.aborted) break;
      const spec = HarnessRunSpec.parse({ session_id: newId("ses"), intent: "plan", prompt: input.prompt, cwd: input.repoRoot, access: "readonly" });
      const parts: string[] = [];
      const onAbort = () => {
        void adapter.cancel?.(spec.session_id)?.catch(() => {});
      };
      if (input.signal) {
        if (input.signal.aborted) onAbort();
        else input.signal.addEventListener("abort", onAbort, { once: true });
      }
      try {
        for await (const ev of adapter.run(spec)) {
          if (input.signal?.aborted) break;
          safeInvoke(input.onHarnessEvent, ev);
          if (ev.type === "message" && ev.text) parts.push(ev.text);
        }
      } finally {
        input.signal?.removeEventListener("abort", onAbort);
      }
      const text = parts.join("\n").trim() || "(no output)";
      plans.push({ id: adapter.id, text });
      store.writeText(join(paths.root, "plans", `${adapter.id}.md`), redactSecrets(text) + "\n");
    }

    if (input.signal?.aborted) {
      return this.cancelledResult(
        log,
        runId,
        taskId,
        "plan",
        paths.root,
        plans.map((p) => ({ attemptId: "plan", harnessId: p.id, status: "cancelled" })),
      );
    }

    const reviewers = await this.resolveReviewers();
    let ambiguities: ReviewFinding[] = [];
    if (reviewers.length > 0 && plans.length > 0) {
      const reviewDir = join(paths.root, "review-evidence");
      writeEvidencePacket(reviewDir, { userIntent: input.prompt, diff: "(plan review — no code diff)\n" });
      const res = await reviewCandidate({
        candidateLabel: "Plan",
        diff: plans.map((p) => `## Plan from ${p.id}\n${p.text}`).join("\n\n"),
        evidenceDir: reviewDir,
        cwd: input.repoRoot,
        reviewers,
      });
      ambiguities = res.findings.filter((f) => f.category === "spec_gap" || f.severity === "NEEDS_HUMAN");
      store.writeYaml(join(paths.reviewsDir, "plan-review.yaml"), { findings: res.findings, route_proofs: res.routeProofs });
    }

    const specPack = [
      `# SpecPack (plan ${runId})`,
      "",
      `## Intent\n${input.prompt}`,
      "",
      `## Plans (${plans.length} harness${plans.length === 1 ? "" : "es"})`,
      ...plans.map((p) => `\n### ${p.id}\n${redactSecrets(p.text)}`),
      "",
      "## Open questions / ambiguities (resolve interactively before `claudex run`)",
      ambiguities.length > 0 ? ambiguities.map((a) => `- ${a.claim}`).join("\n") : "- (none surfaced by plan review; the live user interview is the interactive layer)",
    ].join("\n");
    store.writeText(join(paths.finalDir, "plan.md"), specPack + "\n");
    log.emit("run.completed", { status: "success" });

    return {
      runId,
      taskId,
      mode: "plan",
      status: "success",
      winner: null,
      runDir: paths.root,
      summary: `SpecPack from ${plans.length} harness plan(s); ${ambiguities.length} open question(s).`,
      candidates: plans.map((p) => ({ attemptId: "plan", harnessId: p.id, status: "success" })),
    };
  }

  /** readonly_swarm: single read-only audit/map report. */
  private async runAudit(input: RunInput): Promise<OrchestratorResult> {
    const taskId = input.taskId ?? newId("task");
    const runId = input.runId ?? newId("run");
    const store = new ArtifactStore(input.repoRoot);
    const paths = store.createRun(runId);
    const log = new EventLog(paths.eventsPath, runId, taskId, input.onEvent);
    safeInvoke(input.onRunStart, { runId, taskId, runDir: paths.root });
    log.emit("run.created", { mode: "readonly_swarm", prompt: redactSecrets(input.prompt) });

    const adapter = input.harnesses?.[0]
      ? (this.deps.registry.get(input.harnesses[0]) ?? (await this.gateway.resolve()))
      : await this.gateway.resolve();

    const spec = HarnessRunSpec.parse({ session_id: newId("ses"), intent: "audit", prompt: input.prompt, cwd: input.repoRoot, access: "readonly" });
    const parts: string[] = [];
    const onAbort = () => {
      void adapter.cancel?.(spec.session_id)?.catch(() => {});
    };
    if (input.signal) {
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      for await (const ev of adapter.run(spec)) {
        if (input.signal?.aborted) break;
        safeInvoke(input.onHarnessEvent, ev);
        if (ev.type === "message" && ev.text) parts.push(ev.text);
      }
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
    }
    if (input.signal?.aborted) {
      return this.cancelledResult(log, runId, taskId, "readonly_swarm", paths.root, [
        { attemptId: "a01", harnessId: adapter.id, status: "cancelled" },
      ]);
    }
    const report = parts.join("\n").trim() || "(no output)";
    store.writeText(join(paths.finalDir, "report.md"), `# Audit report\n\n${redactSecrets(report)}\n`);
    log.emit("run.completed", { status: "success" });

    return {
      runId,
      taskId,
      mode: "readonly_swarm",
      status: "success",
      winner: null,
      runDir: paths.root,
      summary: report.slice(0, 400),
      candidates: [{ attemptId: "a01", harnessId: adapter.id, status: "success" }],
    };
  }
}

function formatFindings(findings: ReviewFinding[]): string {
  if (findings.length === 0) return "(no findings recorded)";
  return findings
    .map(
      (f) =>
        `- [${f.severity}/${f.status}] ${f.claim}` +
        (f.evidence.files.length > 0 ? ` (${f.evidence.files.map((x) => x.path).join(", ")})` : "") +
        (f.proposed_fix ? ` -> fix: ${f.proposed_fix}` : ""),
    )
    .join("\n");
}

function renderSummary(
  runId: string,
  mode: ModeKind,
  decision: { winner: string | null; status: string; why_winner: string; apply_recommendation: string },
  evidences: CandidateEvidence[],
  synthReason: string,
  reviewVerified: boolean,
): string {
  return (
    [
      `# Run ${runId} (${mode})`,
      "",
      `- Status: ${decision.status}`,
      `- Winner: ${decision.winner ?? "none"}`,
      `- Apply: ${decision.apply_recommendation}`,
      `- Review verified (cross-family): ${reviewVerified}`,
      `- Synthesis: ${synthReason}`,
      "",
      "## Candidates",
      ...evidences.map(
        (e) =>
          `- ${e.label} (${e.attemptId}): gates ${e.testsPassed}/${e.testsTotal}, blockers ${e.findings.filter((f) => isBlocking(f)).length}, cleanReview ${e.finalReviewClean}`,
      ),
      "",
      "## Why winner",
      decision.why_winner,
    ].join("\n") + "\n"
  );
}
