/**
 * Run-support helpers: transient retry pacing, gate-derived protected paths,
 * prompt constraints, harness-event redaction/payload projection, and the
 * run summary/findings renderers. Pure functions — no orchestrator state.
 */
import type { HarnessEvent, ModeKind, ProtectedPathApproval, ReviewFinding } from "@claudexor/schema";
import { FallbackReason as FallbackReasonSchema, RouteFallbackPayload as RouteFallbackPayloadSchema } from "@claudexor/schema";
import type { EventLog } from "@claudexor/event-log";
import { isBlocking } from "@claudexor/schema";
import type { CandidateEvidence } from "@claudexor/arbitration";
import { redactSecrets } from "@claudexor/util";
import { observationsFromEvent, recordHarnessMetric } from "@claudexor/budget";
import type { BudgetObservation, InteractionAnswerSet } from "@claudexor/schema";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ArtifactStore } from "@claudexor/artifact-store";

/**
 * Relay cross-share: the prior planners' plans, injected into a later
 * planner's prompt so the harnesses CONVERGE on an aligned plan instead of
 * each planning in isolation. `runPlan` already iterates planners
 * sequentially, so each leg after the first sees what the earlier ones
 * proposed and is asked to reconcile/extend them (not blindly repeat).
 */
export function relayPriorPlansSection(plans: { id: string; text: string }[]): string {
  if (plans.length === 0) return "";
  // No silent truncation: a relayed plan cut at the cap carries an explicit
  // in-band marker so the next planner KNOWS it saw a prefix, not the whole.
  const CAP = 4000;
  const blocks = plans
    .map((p) => {
      const cut = p.text.length > CAP;
      const body = cut ? `${p.text.slice(0, CAP)}\n[... plan truncated at ${CAP} chars — the source run's plan artifact carries the full text]` : p.text;
      return `### Plan already proposed by ${p.id}\n${body}`;
    })
    .join("\n\n");
  return `\n\n---\nOTHER HARNESSES HAVE ALREADY PROPOSED PLANS FOR THIS SAME TASK (below). Read them, then produce YOUR plan: build on what is solid, RECONCILE the differences, and EXPLICITLY call out where you disagree and why. Do not blindly repeat them — converge toward one aligned plan.\n\n${blocks}\n---\n`;
}

export interface TransientRetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

export function transientRetryDelayMs(
  nativeDelayMs: number | null,
  policy: TransientRetryPolicy,
  retryIndex: number,
): number {
  const fallback = policy.initialDelayMs * 2 ** retryIndex;
  const delay = nativeDelayMs ?? fallback;
  return Math.min(delay, policy.maxDelayMs);
}


export function gateProtectedPaths(commands: string[]): string[] {
  if (commands.length === 0) return [];
  const paths = new Set([
    "package.json",
    "**/package.json",
    "test/**",
    "tests/**",
    "__tests__/**",
    "**/*.test.*",
    "**/*.spec.*",
  ]);
  for (const command of commands) {
    for (const raw of command.split(/\s+/)) {
      const token = raw.trim().replace(/^['"]|['"]$/g, "");
      if (
        !token ||
        token.startsWith("-") ||
        token.includes("=") ||
        token.includes("://") ||
        token.startsWith("/")
      )
        continue;
      if (!token.includes("/") && !token.includes(".")) continue;
      const clean = token.replace(/^[./]+/, "").replace(/[),;]+$/g, "");
      if (!clean || clean === "package.json") continue;
      const testish =
        clean.startsWith("test/") ||
        clean.startsWith("tests/") ||
        clean.startsWith("__tests__/") ||
        clean.includes(".test.") ||
        clean.includes(".spec.");
      if (testish) paths.add(clean.endsWith("/") ? `${clean}**` : clean);
    }
  }
  return [...paths];
}


export function promptWithProtectedPathConstraint(
  prompt: string,
  protectedPaths: string[],
  autoProtectedPaths: string[] = [],
  approvals: ProtectedPathApproval[] = [],
): string {
  if (protectedPaths.length === 0 && autoProtectedPaths.length === 0) return prompt;
  const specLines = protectedPaths.length
    ? [
        "",
        "Engine constraint: do not edit spec/config protected paths unless the frozen task contract explicitly asks for it. Protected paths:",
        ...protectedPaths.slice(0, 20).map((p) => `- ${p}`),
      ]
    : [];
  const approvalLines = approvals.length
    ? [
        "",
        "Approved auto-protected gate/test path changes for this run:",
        ...approvals.slice(0, 20).map((a) => `- ${a.path}${a.reason ? ` (${a.reason})` : ""}`),
      ]
    : [];
  const autoLines = autoProtectedPaths.length
    ? [
        "",
        "Engine constraint: do not edit auto-protected gate/test paths, test commands, or package test scripts unless the user explicitly asked to change tests. Auto-protected paths:",
        ...autoProtectedPaths.slice(0, 20).map((p) => `- ${p}`),
        ...approvalLines,
      ]
    : [];
  return [
    prompt,
    ...specLines,
    ...autoLines,
  ].join("\n");
}


export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}


export function redactHarnessEvent(ev: HarnessEvent): HarnessEvent {
  try {
    return JSON.parse(redactSecrets(JSON.stringify(ev))) as HarnessEvent;
  } catch {
    return {
      ...ev,
      text: ev.text ? redactSecrets(ev.text) : undefined,
      error: ev.error ? redactSecrets(ev.error) : undefined,
      payload: ev.payload ? { redacted: true } : undefined,
    };
  }
}


export function harnessEventPayload(
  harnessId: string,
  attemptId: string,
  ev: HarnessEvent,
): Record<string, unknown> {
  const safe = redactHarnessEvent(ev);
  const title =
    safe.error ??
    safe.text ??
    (safe.usage
      ? `usage: ${safe.usage.input_tokens ?? 0} in / ${safe.usage.output_tokens ?? 0} out`
      : safe.type);
  return {
    harness_id: harnessId,
    attempt_id: attemptId,
    session_id: safe.session_id,
    type: safe.type,
    title: String(title).slice(0, 500),
    text: safe.text,
    error: safe.error,
    usage: safe.usage,
    observed_model: safe.observed_model,
    tool: safe.tool,
    interaction: safe.interaction,
    payload: safe.payload,
  };
}

/**
 * Deduplicate the known "final result repeats the last streamed message" shape
 * (adjacent only). Legitimately repeated earlier messages are preserved — a
 * whole-array dedupe would silently merge real output.
 */

export function pushUniqueText(parts: string[], text: string): void {
  const normalized = text.trim();
  if (!normalized) return;
  const last = parts[parts.length - 1]?.trim();
  if (last === normalized) return;
  parts.push(normalized);
}


export function formatFindings(findings: ReviewFinding[]): string {
  if (findings.length === 0) return "(no findings recorded)";
  return findings
    .map(
      (f) =>
        `- [${f.severity}/${f.status}] ${f.claim}` +
        (f.evidence.files.length > 0
          ? ` (${f.evidence.files.map((x) => x.path).join(", ")})`
          : "") +
        (f.proposed_fix ? ` -> fix: ${f.proposed_fix}` : ""),
    )
    .join("\n");
}


export function renderSummary(
  runId: string,
  mode: ModeKind,
  decision: {
    winner: string | null;
    status: string;
    outcome?: string;
    why_winner: string;
    apply_recommendation: string;
  },
  evidences: CandidateEvidence[],
  synthReason: string,
  reviewVerified: boolean,
): string {
  return (
    [
      `# Run ${runId} (${mode})`,
      "",
      `- Status: ${decision.status}`,
      `- Outcome: ${decision.outcome ?? "unknown"}`,
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

/** Pure read: a referenced run's decision/work_product status, or null. */
export function readRunStatus(repoRoot: string, runId: string): string | null {
  const store = new ArtifactStore(repoRoot);
  const sub = store.runPaths(runId);
  const decision = store.readYaml<{ status?: string; outcome?: string }>(
    join(sub.arbitrationDir, "decision.yaml"),
  );
  const wp = store.readYaml<{ kind?: string; meta?: Record<string, unknown> }>(
    join(sub.finalDir, "work_product.yaml"),
  );
  if (!decision && !wp) return null;
  const parts: string[] = [];
  if (decision?.status) parts.push(`decision=${decision.status}`);
  if (wp?.meta?.["result_kind"]) parts.push(`result_kind=${String(wp.meta["result_kind"])}`);
  if (wp?.meta?.["apply_state"]) parts.push(`apply_state=${String(wp.meta["apply_state"])}`);
  return parts.length > 0 ? parts.join(", ") : `run ${runId}: artifacts present`;
}
/** Pure read: a referenced run's recorded patch diff, or null. */
export function readRunPatch(repoRoot: string, runId: string): string | null {
  const store = new ArtifactStore(repoRoot);
  const sub = store.runPaths(runId);
  const path = join(sub.finalDir, "patch.diff");
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** Config-derived runtime knobs (pure projections of ResolvedConfig). */
export interface ResolvedConfigLike {
  global: {
    routing: { env_inheritance: "mirror_native" | "clean" };
    runtime: {
      transient_retry: { max_retries: number; initial_delay_ms: number; max_delay_ms: number };
      reviewer_timeout_ms: number;
      harness_inactivity_timeout_ms: number;
    };
  };
}

export function envInheritance(cfg: ResolvedConfigLike): "mirror_native" | "clean" {
  return cfg.global.routing.env_inheritance;
}

export function transientRetryPolicy(cfg: ResolvedConfigLike): TransientRetryPolicy {
  const c = cfg.global.runtime.transient_retry;
  return { maxRetries: c.max_retries, initialDelayMs: c.initial_delay_ms, maxDelayMs: c.max_delay_ms };
}

export function reviewerTimeoutMs(cfg: ResolvedConfigLike): number {
  return cfg.global.runtime.reviewer_timeout_ms;
}

export function harnessInactivityTimeoutMs(cfg: ResolvedConfigLike): number {
  return cfg.global.runtime.harness_inactivity_timeout_ms;
}

/** Typed auth-switch disclosure: adapters mark auth_switched on a message;
 * the run event log gets the typed route.fallback payload. */
export function observeAuthSwitch(
  log: EventLog | undefined,
  harnessId: string,
  attemptId: string,
  ev: HarnessEvent,
): void {
  if (!log || ev.type !== "message" || ev.payload?.["auth_switched"] !== true) return;
  // Most auth_switched markers mean the preferred auth route was unavailable,
  // so the default reason is `auth_unavailable`. Adapters may override with a
  // more specific typed reason, e.g. `readiness_preferred` when auto selects a
  // smoke-proven route for reliability/cost transparency.
  const overrideReason = FallbackReasonSchema.safeParse(ev.payload?.["reason"]);
  try {
    log.emit(
      "route.fallback.auth_switched",
      RouteFallbackPayloadSchema.parse({
        from_harness: harnessId,
        to_harness: harnessId,
        from_auth_mode: ev.payload?.["from_auth_mode"],
        to_auth_mode: ev.payload?.["to_auth_mode"],
        reason: overrideReason.success ? overrideReason.data : "auth_unavailable",
        attempt_id: attemptId,
      }) as unknown as Record<string, unknown>,
    );
  } catch {
    /* a malformed marker must not fail the run */
  }
}


/** Observe ALL budget/quota signals from one harness event and disclose
 * quota pressure ONCE per attempt (crossing semantics). One owner — the
 * agent, plan, and read-only loops all consume this instead of pasting the
 * loop (critic finding: triplicated logic drifts). */
export function observeBudgetSignals(
  ledger: { observe(o: BudgetObservation): void },
  log: { emit(type: string, payload: Record<string, unknown>): unknown } | undefined,
  harnessId: string,
  attemptId: string,
  ev: HarnessEvent,
  state: { quotaPressureDisclosed: boolean },
): void {
  for (const obs of observationsFromEvent(harnessId, ev)) {
    ledger.observe(obs);
    if (obs.kind === "used_percent" && (obs.used_percent ?? 0) >= 50 && !state.quotaPressureDisclosed) {
      state.quotaPressureDisclosed = true;
      log?.emit("budget.quota_pressure", {
        harness_id: harnessId,
        attempt_id: attemptId,
        used_percent: obs.used_percent,
        resets_at: obs.resets_at ?? null,
      });
    }
  }
}

/** Stall rotation with an HONEST route event: picks via
 * pickStallRotationIdx and emits route.fallback.started only when the idx
 * actually moved — STAY (every alternative cooling) is a retry, not a
 * fallback. Returns the (possibly unchanged) idx. */
export function rotateOnStall(
  poolIds: string[],
  currentIdx: number,
  ledger: { headroom(id: string): number; cooldownActive(id: string): boolean },
  tried: ReadonlySet<string>,
  log: { emit(type: string, payload: Record<string, unknown>): unknown },
  fromHarness: string | null,
): number {
  const pickedIdx = pickStallRotationIdx(poolIds, currentIdx, ledger, tried);
  if (pickedIdx !== currentIdx) {
    log.emit("route.fallback.started", {
      from_harness: fromHarness,
      to_harness: poolIds[pickedIdx],
      reason: "stall",
      headroom: ledger.headroom(poolIds[pickedIdx] as string),
    });
  }
  return pickedIdx;
}

/** Stall-rotation pick: UNTRIED candidates first (the caller's exhaustion
 * check counts distinct harnesses, so headroom alone could ping-pong between
 * two strong harnesses and starve a third), then by remaining rate-window
 * headroom, cooldowns excluded, round-robin order among equals. Pure. */
export function pickStallRotationIdx(
  poolIds: string[],
  currentIdx: number,
  ledger: { headroom(id: string): number; cooldownActive(id: string): boolean },
  tried: ReadonlySet<string> = new Set(),
): number {
  if (poolIds.length === 0) return currentIdx; // total: never NaN via %0
  const rank = (candidates: Array<{ id: string; idx: number }>) =>
    candidates.sort(
      (a, b) =>
        ledger.headroom(b.id) - ledger.headroom(a.id) ||
        ((a.idx - currentIdx + poolIds.length) % poolIds.length) -
          ((b.idx - currentIdx + poolIds.length) % poolIds.length),
    )[0];
  const eligible = poolIds
    .map((id, idx) => ({ id, idx }))
    .filter(({ idx, id }) => idx !== currentIdx && !ledger.cooldownActive(id));
  const next = rank(eligible.filter(({ id }) => !tried.has(id))) ?? rank(eligible);
  // Every alternative cooling: STAY — retrying the stalled-but-not-throttled
  // current harness beats hopping onto a known rate-limited one.
  return next ? next.idx : currentIdx;
}

/** Routing metrics: one settled sample per CLEAN attempt (advisory input;
 * failures never fail the run). Errored/cancelled attempts are NOT samples —
 * a fast-failing harness must not earn a flattering latency average (the
 * router divides by latency). Duration = stream time only (gates excluded). */
export function recordCleanAttemptMetrics(
  configDir: string,
  harnessId: string,
  sample: { costUsd: number; streamMs: number; errored: boolean; aborted: boolean },
): void {
  if (sample.errored || sample.aborted) return;
  recordHarnessMetric(configDir, harnessId, {
    costUsd: sample.costUsd > 0 ? sample.costUsd : null,
    durationMs: sample.streamMs,
  });
}

/** Build the ISOLATED-ENVELOPE sub-run input for an orchestrate SAFE step
 * (start_run/race): inPlace forced false, no thread binding, no nested
 * autonomy, recursion depth incremented. Pure construction; the caller
 * asserts the envelope invariant. */
export function buildEnvelopeSubInput<T extends {
  repoRoot: string;
  portfolio?: unknown;
  web?: unknown;
  externalContextPolicy?: unknown;
  signal?: AbortSignal;
  orchestrateDepth?: number;
}>(
  input: T,
  call: { tool: "start_run" | "race"; prompt: string; mode?: string; n?: number; harness?: string | null },
  remainingUsd: number | null,
) {
  return {
    repoRoot: input.repoRoot,
    prompt: call.prompt,
    mode: (call.tool === "start_run" ? (call.mode ?? "agent") : "agent") as "agent" | "ask" | "plan" | "audit" | "orchestrate",
    n: call.tool === "race" ? call.n : undefined,
    harnesses: call.tool === "start_run" && call.harness ? [call.harness] : undefined,
    portfolio: input.portfolio,
    // Aggregate budget: the sub-run gets only the REMAINING headroom.
    maxUsd: remainingUsd,
    web: input.web,
    externalContextPolicy: input.externalContextPolicy,
    signal: input.signal,
    // SAFETY: isolated envelope, never the live in-place thread tree.
    inPlace: false,
    threadId: undefined,
    executionRoot: undefined,
    autonomy: undefined,
    resumeSessions: undefined,
    onSessionObserved: undefined,
    orchestrateDepth: (input.orchestrateDepth ?? 0) + 1,
  };
}

/**
 * Deliver typed answers to a referenced pending interaction for the
 * orchestrate `answer_question` SAFE step (read-only w.r.t. the tree). The
 * daemon owns the live registry; without an injected service this context
 * cannot reach it, so SKIP honestly.
 *
 * INVARIANT: safe sub-runs are NON-interactive (their sub-input omits
 * onInteraction, so a start_run/race sub-run never raises an interaction and
 * nothing registers under its run id). The only pending interactions
 * therefore belong to the ORCHESTRATE run itself, so `input.runId` is the
 * correct registry key. If sub-runs are ever made interactive, the
 * answer_question plan call MUST carry the target sub-run id instead (the
 * registry is keyed by runId+interactionId).
 */
export async function deliverPlanAnswer(
  input: {
    runId?: string;
    answerInteraction?: (runId: string, interactionId: string, answers: InteractionAnswerSet) => Promise<boolean> | boolean;
  },
  call: {
    interaction_id: string;
    answers: Array<{ question_id: string; selected_labels: string[]; free_text: string | null }>;
  },
): Promise<{ status: "done" | "skipped"; runId: null; detail: string }> {
  if (!input.answerInteraction) {
    return { status: "skipped", runId: null, detail: "no live interaction surface in this context" };
  }
  const delivered = await input.answerInteraction(input.runId ?? "", call.interaction_id, {
    interaction_id: call.interaction_id,
    answers: call.answers.map((a) => ({
      question_id: a.question_id,
      selected_labels: a.selected_labels,
      free_text: a.free_text,
    })),
  });
  return {
    status: delivered ? "done" : "skipped",
    runId: null,
    detail: delivered
      ? `delivered answers to ${call.interaction_id}`
      : `interaction ${call.interaction_id} not found / already resolved`,
  };
}
