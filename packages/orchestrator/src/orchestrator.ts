import { join } from "node:path";
import type {
  GateResult,
  ModeKind,
  Portfolio,
  ReviewFinding,
  RunStatus,
  TaskContract,
  WorkspaceEnvelope,
} from "@claudex/schema";
import { HarnessRunSpec, TaskContract as TaskContractSchema, isBlocking } from "@claudex/schema";
import type { AdapterRegistry, HarnessAdapter } from "@claudex/core";
import { ExecutionEngine, HarnessUnavailableError } from "@claudex/core";
import { ArtifactStore } from "@claudex/artifact-store";
import { EventLog } from "@claudex/event-log";
import { buildContextPack, writeEvidencePacket } from "@claudex/context";
import { WorkspaceManager } from "@claudex/workspace";
import { HarnessGateway } from "@claudex/gateway";
import {
  type GateSpec,
  type ReviewerSpec,
  gatesPassed,
  reviewMatrix,
  revalidateFindings,
  runGates,
} from "@claudex/review";
import { type CandidateEvidence, arbitrate } from "@claudex/arbitration";
import { type SynthesisMode, decideSynthesis } from "@claudex/synthesis";
import { BudgetLedger } from "@claudex/budget";
import { hashJson, newId, nowIso, redactSecrets } from "@claudex/util";

export interface OrchestratorDeps {
  registry: AdapterRegistry;
  /** Explicit reviewer panel (else resolved from the gateway: distinct families). */
  reviewers?: ReviewerSpec[];
  portfolio?: Portfolio;
  /** Max USD for the whole run (drives the circuit breaker). */
  maxUsd?: number | null;
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
}

interface CandidateRun {
  attemptId: string;
  harnessId: string;
  label: string;
  diff: string;
  gates: GateResult[];
  cost: number;
  envelope: WorkspaceEnvelope;
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
      case "readonly_swarm":
        return this.runReadonly(input, mode);
      case "daily":
      default:
        return this.runDaily(input);
    }
  }

  /** Daily mode delegates to the minimal single-attempt engine (native parity). */
  private async runDaily(input: RunInput): Promise<OrchestratorResult> {
    let harnessId = input.harnesses?.[0];
    if (!harnessId) harnessId = (await this.gateway.resolve()).id;
    const engine = new ExecutionEngine(this.deps.registry);
    const res = await engine.run({ repoRoot: input.repoRoot, prompt: input.prompt, harnessId, mode: "daily" });
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
        specs.push({ adapter, providerFamily: m.provider_family });
      } catch {
        /* unavailable */
      }
      if (specs.length >= 2) break;
    }
    return specs;
  }

  private candidateHarnesses(input: RunInput): HarnessAdapter[] {
    const ids = input.harnesses ?? [];
    const adapters: HarnessAdapter[] = [];
    for (const id of ids) {
      const a = this.deps.registry.get(id);
      if (a) adapters.push(a);
    }
    if (adapters.length > 0) {
      // expand to n by repeating the pool (diverse seeds) when n exceeds pool size
      const n = input.n ?? adapters.length;
      const out: HarnessAdapter[] = [];
      for (let i = 0; i < n; i++) out.push(adapters[i % adapters.length] as HarnessAdapter);
      return out;
    }
    return adapters;
  }

  private buildContract(input: RunInput, taskId: string, mode: ModeKind): TaskContract {
    return TaskContractSchema.parse({
      schema_version: 1,
      task_id: taskId,
      created_at: nowIso(),
      repo: { root: input.repoRoot, base_ref: input.baseRef ?? "HEAD", dirty_policy: "snapshot" },
      mode: { kind: mode },
      user_intent: { raw: input.prompt },
      budget: { portfolio: this.deps.portfolio ?? "daily-rich" },
    });
  }

  private gateSpecs(contract: TaskContract): GateSpec[] {
    return contract.tests.commands.map((c) => ({ id: c.id, command: c.command, required: c.required }));
  }

  private async runCandidate(
    adapter: HarnessAdapter,
    label: string,
    attemptId: string,
    contract: TaskContract,
    store: ArtifactStore,
    paths: ReturnType<ArtifactStore["runPaths"]>,
    wsm: WorkspaceManager,
    ledger: BudgetLedger,
  ): Promise<CandidateRun> {
    const lease = ledger.reserve({
      taskId: contract.task_id,
      attemptId,
      intent: "implement",
      harnessId: adapter.id,
    });
    const envelope = await wsm.create({
      taskId: contract.task_id,
      attemptId,
      baseRef: contract.repo.base_ref,
      dirtyPolicy: "snapshot",
    });
    const spec = HarnessRunSpec.parse({
      session_id: newId("ses"),
      intent: "implement",
      prompt: contract.user_intent.raw,
      cwd: envelope.worktree_path,
      access: "workspace_write",
      env: wsm.envFor(envelope),
    });

    let cost = 0;
    for await (const ev of adapter.run(spec)) {
      if (ev.type === "usage" && ev.usage?.cost_usd) cost += ev.usage.cost_usd;
    }
    if (lease.lease?.lease_id) ledger.settle(lease.lease.lease_id, cost);

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
      gates: gates.map((g) => ({ id: g.id, status: g.status })),
      branch: envelope.branch_name,
    });

    return { attemptId, harnessId: adapter.id, label, diff, gates, cost, envelope };
  }

  private toEvidence(run: CandidateRun, contract: TaskContract, findings: ReviewFinding[], finalReviewClean: boolean): CandidateEvidence {
    const passed = gatesPassed(run.gates);
    const acTotal = Math.max(1, contract.success_criteria.length);
    const acCovered = passed
      ? contract.success_criteria.length > 0
        ? contract.success_criteria.map((c) => c.id)
        : ["AC-implicit"]
      : [];
    return {
      attemptId: run.attemptId,
      label: run.label,
      gates: run.gates,
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
    const taskId = newId("task");
    const runId = newId("run");
    const store = new ArtifactStore(input.repoRoot);
    const paths = store.createRun(runId);
    const log = new EventLog(paths.eventsPath, runId, taskId);
    const wsm = new WorkspaceManager(input.repoRoot);
    const ledger = new BudgetLedger({ maxUsd: this.deps.maxUsd ?? null });

    log.emit("run.created", { mode, prompt: redactSecrets(input.prompt) });
    const contract = this.buildContract(input, taskId, mode);
    store.writeYaml(join(paths.contextDir, "task.yaml"), contract);
    log.emit("task.contract.created", { task_contract_hash: hashJson(contract) });

    const contextPack = await buildContextPack(input.repoRoot, contract).catch(() => null);
    if (contextPack) store.writeYaml(join(paths.contextDir, "context_pack.yaml"), contextPack);
    log.emit("context.pack.created", { hash: contextPack?.hash ?? null });

    const reviewDir = join(paths.root, "review-evidence");
    writeEvidencePacket(reviewDir, {
      userIntent: input.prompt,
      diff: "(per-candidate diffs are supplied to reviewers individually)\n",
      tests: contract.tests.commands.map((c) => c.command).join("\n") || "(no test commands configured)",
    });

    const adapters = this.candidateHarnesses(input);
    if (adapters.length === 0) {
      throw new HarnessUnavailableError("no candidate harnesses; pass --harness or install one");
    }

    const runs: CandidateRun[] = [];
    for (let i = 0; i < adapters.length; i++) {
      const adapter = adapters[i] as HarnessAdapter;
      const attemptId = `a${String(i + 1).padStart(2, "0")}`;
      const label = `Candidate ${LABELS[i] ?? i + 1}`;
      log.emit("harness.started", { harness_id: adapter.id, attempt_id: attemptId });
      const run = await this.runCandidate(adapter, label, attemptId, contract, store, paths, wsm, ledger);
      log.emit("harness.completed", { harness_id: adapter.id, attempt_id: attemptId, cost_usd: run.cost });
      runs.push(run);
    }

    const reviewers = await this.resolveReviewers();
    log.emit("review.started", { reviewers: reviewers.length });
    const matrix = await reviewMatrix(
      runs.map((r) => ({ attemptId: r.attemptId, label: r.label, diff: r.diff, evidenceDir: reviewDir, cwd: input.repoRoot })),
      reviewers,
    );

    const evidences: CandidateEvidence[] = [];
    for (const run of runs) {
      const m = matrix.find((x) => x.attemptId === run.attemptId);
      const revalidated = m ? await revalidateFindings(m.result.findings) : [];
      const crossFamily = m?.result.crossFamilyVerified ?? false;
      const noBlockers = !revalidated.some((f) => isBlocking(f));
      // If no reviewers are available, fall back to gates-only cleanliness (route unverified).
      const finalReviewClean = reviewers.length === 0 ? gatesPassed(run.gates) : crossFamily && noBlockers;
      store.writeYaml(join(paths.reviewsDir, `${run.attemptId}.yaml`), {
        attempt_id: run.attemptId,
        cross_family_verified: crossFamily,
        findings: revalidated,
        route_proofs: m?.result.routeProofs ?? [],
      });
      for (const f of revalidated) log.emit("finding.revalidated", { attempt_id: run.attemptId, severity: f.severity, status: f.status });
      evidences.push(this.toEvidence(run, contract, revalidated, finalReviewClean));
    }

    const synth = decideSynthesis(evidences, input.synthesis ?? "auto");
    store.writeYaml(join(paths.arbitrationDir, "synthesis.yaml"), synth);
    log.emit("synthesis.started", { synthesize: synth.synthesize, reason: synth.reason });

    const result = arbitrate(evidences, { exactUsd: ledger.spend() });
    store.writeYaml(join(paths.arbitrationDir, "decision.yaml"), result.decision);
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
        meta: { harness_id: winnerRun.harnessId, synthesis: synth, mode },
      });
      store.writeText(
        join(paths.finalDir, "summary.md"),
        renderSummary(runId, mode, result.decision, evidences, synth.reason),
      );
    }

    for (const run of runs) await wsm.dispose(run.envelope);

    log.emit("work_product.emitted", { winner: result.decision.winner });
    log.emit(result.decision.status === "success" ? "run.completed" : "run.failed", {
      status: result.decision.status,
    });

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
        status: gatesPassed(r.gates) ? "green" : "red",
      })),
      decisionPath,
    };
  }

  private async runConvergence(
    input: RunInput,
    mode: ModeKind,
    maxAttempts: number | null,
  ): Promise<OrchestratorResult> {
    const taskId = newId("task");
    const runId = newId("run");
    const store = new ArtifactStore(input.repoRoot);
    const paths = store.createRun(runId);
    const log = new EventLog(paths.eventsPath, runId, taskId);
    const wsm = new WorkspaceManager(input.repoRoot);
    const ledger = new BudgetLedger({ maxUsd: this.deps.maxUsd ?? null });
    const contract = this.buildContract(input, taskId, mode);
    store.writeYaml(join(paths.contextDir, "task.yaml"), contract);
    log.emit("run.created", { mode, prompt: redactSecrets(input.prompt) });

    const reviewDir = join(paths.root, "review-evidence");
    writeEvidencePacket(reviewDir, { userIntent: input.prompt, diff: "(per-attempt)\n" });
    const reviewers = await this.resolveReviewers();

    let attempt = 0;
    let converged = false;
    let lastWinner: CandidateRun | null = null;
    const hardCeiling = maxAttempts ?? 50; // safety ceiling for until-convergence in absence of budget caps

    while (attempt < hardCeiling) {
      attempt += 1;
      const attemptId = `a${String(attempt).padStart(2, "0")}`;
      const adapter = this.deps.registry.get(input.harnesses?.[0] ?? (await this.gateway.resolve()).id);
      if (!adapter) break;
      const run = await this.runCandidate(adapter, `Attempt ${attempt}`, attemptId, contract, store, paths, wsm, ledger);
      lastWinner = run;

      const matrix = await reviewMatrix(
        [{ attemptId, label: `Attempt ${attempt}`, diff: run.diff, evidenceDir: reviewDir, cwd: input.repoRoot }],
        reviewers,
      );
      const revalidated = matrix[0] ? await revalidateFindings(matrix[0].result.findings) : [];
      const noBlockers = !revalidated.some((f) => isBlocking(f));
      const crossFamily = matrix[0]?.result.crossFamilyVerified ?? false;
      const finalReviewClean = reviewers.length === 0 ? gatesPassed(run.gates) : crossFamily && noBlockers;
      const passed = gatesPassed(run.gates);

      await wsm.dispose(run.envelope);

      if (passed && noBlockers && finalReviewClean) {
        converged = true;
        break;
      }
      if (ledger.tier() === "hard") break;
    }

    const status: RunStatus = converged ? "success" : maxAttempts !== null ? "not_converged" : "exhausted";
    log.emit(converged ? "run.completed" : "run.failed", { status, attempts: attempt });
    return {
      runId,
      taskId,
      mode,
      status,
      winner: lastWinner?.attemptId ?? null,
      runDir: paths.root,
      summary: converged ? `converged in ${attempt} attempt(s)` : `${status} after ${attempt} attempt(s)`,
      candidates: lastWinner ? [{ attemptId: lastWinner.attemptId, harnessId: lastWinner.harnessId, status }] : [],
    };
  }

  /** plan / readonly_swarm: run harnesses read-only and produce a report. */
  private async runReadonly(input: RunInput, mode: ModeKind): Promise<OrchestratorResult> {
    const taskId = newId("task");
    const runId = newId("run");
    const store = new ArtifactStore(input.repoRoot);
    const paths = store.createRun(runId);
    const log = new EventLog(paths.eventsPath, runId, taskId);
    log.emit("run.created", { mode, prompt: redactSecrets(input.prompt) });

    const adapter = this.deps.registry.get(input.harnesses?.[0] ?? (await this.gateway.resolve()).id);
    if (!adapter) throw new HarnessUnavailableError("no harness available for read-only run");

    const spec = HarnessRunSpec.parse({
      session_id: newId("ses"),
      intent: mode === "plan" ? "plan" : "audit",
      prompt: input.prompt,
      cwd: input.repoRoot,
      access: "readonly",
    });
    const parts: string[] = [];
    for await (const ev of adapter.run(spec)) {
      if (ev.type === "message" && ev.text) parts.push(ev.text);
    }
    const report = parts.join("\n").trim() || "(no output)";
    const reportPath = join(paths.finalDir, mode === "plan" ? "plan.md" : "report.md");
    store.writeText(reportPath, `# ${mode} report\n\n${redactSecrets(report)}\n`);
    log.emit("run.completed", { status: "success" });

    return {
      runId,
      taskId,
      mode,
      status: "success",
      winner: null,
      runDir: paths.root,
      summary: report.slice(0, 400),
      candidates: [{ attemptId: "a01", harnessId: adapter.id, status: "success" }],
    };
  }
}

function renderSummary(
  runId: string,
  mode: ModeKind,
  decision: { winner: string | null; status: string; why_winner: string; apply_recommendation: string },
  evidences: CandidateEvidence[],
  synthReason: string,
): string {
  const lines = [
    `# Run ${runId} (${mode})`,
    "",
    `- Status: ${decision.status}`,
    `- Winner: ${decision.winner ?? "none"}`,
    `- Apply: ${decision.apply_recommendation}`,
    `- Synthesis: ${synthReason}`,
    "",
    "## Candidates",
    ...evidences.map(
      (e) =>
        `- ${e.label} (${e.attemptId}): gates ${e.testsPassed}/${e.testsTotal}, blockers ${e.findings.filter((f) => isBlocking(f)).length}, cleanReview ${e.finalReviewClean}`,
    ),
    "",
    `## Why winner`,
    decision.why_winner,
  ];
  return lines.join("\n") + "\n";
}
