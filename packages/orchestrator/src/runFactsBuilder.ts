import { join } from "node:path";
import type { ArtifactStore } from "@claudexor/artifact-store";
import { deriveApplyEligibility } from "@claudexor/delivery";
import {
  CouncilProjection,
  DecisionRecord,
  RunFacts,
  RunTelemetry,
  SCHEMA_VERSION,
  TaskContract,
  WorkProduct,
  needsDecision,
  requiredActionsFor,
  validateRunFactsInvariants,
  type RunOutcomeFacts,
  type RunParticipant,
} from "@claudexor/schema";
import { nowIso, readTextSafe, redactSecrets, sha256 } from "@claudexor/util";
import type { AnnouncedRunContext } from "./runTerminals.js";
import type { OrchestratorResult } from "./orchestrator.js";
import { readReviewArtifacts } from "./runFactsReview.js";
import { canonicalDeliverable } from "./runFactsDeliverable.js";

interface CouncilRosterEvidence {
  members: Array<{
    attemptId: string;
    harnessId: string;
    failed: boolean;
    drafted: boolean;
  }>;
  mergeAttemptId: string | null;
  mergeHarnessId: string | null;
  mergeFailed: boolean;
}

function parseArtifact<T>(
  store: ArtifactStore,
  path: string,
  schema: {
    safeParse(
      value: unknown,
    ):
      | { success: true; data: T }
      | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
  },
): T | null {
  // Three-state read (fail loudly): a missing canonical artifact is a
  // legitimate absence, but a present-yet-invalid one is corrupted terminal
  // evidence. Returning null for it would silently rewrite contract truth
  // (e.g. a corrupted task.yaml projecting as "gates not configured" in the
  // immutable receipt), so it throws instead and lands in the fail-closed
  // terminal-facts path.
  const raw = store.readYaml(path);
  if (raw === null) {
    if (readTextSafe(path) === null) return null;
    throw new Error(`canonical run artifact is not readable YAML: ${path}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(`canonical run artifact is invalid: ${path} (${issues})`);
  }
  return parsed.data;
}

function participantRole(args: {
  mode: OrchestratorResult["mode"];
  attemptId: string;
  mergeAttemptId: string | null;
  reducerAttemptId: string | null;
  hasDeepScanProjection: boolean;
}): RunParticipant["role"] {
  if (args.mode === "plan") {
    if (args.mergeAttemptId && args.attemptId === args.mergeAttemptId) return "merge";
    return "planner";
  }
  if (args.mode === "ask" && args.hasDeepScanProjection) {
    return args.attemptId === args.reducerAttemptId ? "reducer" : "scout";
  }
  return "candidate";
}

function councilRosterEvidence(
  ctx: AnnouncedRunContext,
  council: CouncilProjection | null,
): CouncilRosterEvidence | null {
  const events = ctx.log.readAll().events;
  let startedMembers: string[] = [];
  const failedByHarness = new Map<string, string>();
  const draftedHarnessIds = new Set<string>();
  const harnessByAttempt = new Map<string, string>();
  let mergedEventSeen = false;

  for (const event of events) {
    const payload = event.payload;
    if (event.type === "council.started") {
      const members = payload["members"];
      if (Array.isArray(members)) {
        startedMembers = members.filter(
          (member): member is string => typeof member === "string" && member.length > 0,
        );
      }
    } else if (event.type === "council.member.failed") {
      const attemptId = payload["attempt_id"];
      const harnessId = payload["harness_id"];
      if (typeof attemptId === "string" && typeof harnessId === "string") {
        failedByHarness.set(harnessId, attemptId);
        harnessByAttempt.set(attemptId, harnessId);
      }
    } else if (event.type === "council.draft") {
      const harnessId = payload["harness_id"];
      if (typeof harnessId === "string") draftedHarnessIds.add(harnessId);
    } else if (event.type === "harness.started" || event.type === "budget.lease.created") {
      const attemptId = payload["attempt_id"];
      const harnessId = payload["harness_id"];
      if (typeof attemptId === "string" && typeof harnessId === "string") {
        harnessByAttempt.set(attemptId, harnessId);
      }
    } else if (event.type === "council.merged") {
      mergedEventSeen = true;
    }
  }

  const memberHarnessIds =
    startedMembers.length > 0
      ? startedMembers
      : (council?.members.map((member) => member.harnessId) ?? []);
  if (memberHarnessIds.length === 0) return null;

  const membershipByHarness = new Map(
    council?.members.map((member) => [member.harnessId, member] as const) ?? [],
  );
  const members = memberHarnessIds.map((harnessId, index) => {
    const membership = membershipByHarness.get(harnessId);
    return {
      attemptId: failedByHarness.get(harnessId) ?? `p${String(index + 1).padStart(2, "0")}`,
      harnessId,
      failed: membership?.status === "failed" || failedByHarness.has(harnessId),
      drafted:
        draftedHarnessIds.has(harnessId) ||
        membership?.status === "drafted" ||
        membership?.status === "merged",
    };
  });
  const mergeAttemptId =
    council || mergedEventSeen ? `p${String(memberHarnessIds.length + 1).padStart(2, "0")}` : null;
  const primaryHarnessId =
    council?.members.find((member) => member.role === "primary")?.harnessId ?? null;

  return {
    members,
    mergeAttemptId,
    mergeHarnessId:
      (mergeAttemptId ? harnessByAttempt.get(mergeAttemptId) : null) ??
      council?.mergedBy ??
      primaryHarnessId,
    mergeFailed: council !== null && council.mergedBy === null,
  };
}

function participantsFor(args: {
  ctx: AnnouncedRunContext;
  mode: OrchestratorResult["mode"];
  telemetry: RunTelemetry | null;
  council: CouncilProjection | null;
  reviewerHarnessIds: string[];
}): RunParticipant[] {
  const { ctx, mode, telemetry, council } = args;
  const reducerAttemptId = telemetry?.deep_scan_synthesis?.reducer_attempt_id ?? null;
  const hasDeepScanProjection = telemetry?.deep_scan_synthesis != null;
  const councilEvidence = mode === "plan" ? councilRosterEvidence(ctx, council) : null;
  // Stable council ids keep denied pre-spawn lanes role-labelled.
  const mergeAttemptId = councilEvidence?.mergeAttemptId ?? null;
  const attempts: RunParticipant[] = telemetry
    ? telemetry.attempts.map((attempt) => ({
        attempt_id: attempt.attempt_id,
        harness_id: attempt.harness_id,
        role: participantRole({
          mode,
          attemptId: attempt.attempt_id,
          mergeAttemptId,
          reducerAttemptId,
          hasDeepScanProjection,
        }),
        deliverable_present: attempt.outcome.deliverable_present,
        status: attempt.outcome.status,
      }))
    : (() => {
        const started = new Map<string, string>();
        for (const event of ctx.log.readAll().events) {
          if (event.type !== "harness.started") continue;
          const attemptId = event.payload["attempt_id"];
          const harnessId = event.payload["harness_id"];
          if (typeof attemptId === "string" && typeof harnessId === "string") {
            started.set(attemptId, harnessId);
          }
        }
        return [...started].map(([attemptId, harnessId]) => ({
          attempt_id: attemptId,
          harness_id: harnessId,
          role: participantRole({
            mode,
            attemptId,
            mergeAttemptId,
            reducerAttemptId,
            hasDeepScanProjection,
          }),
          deliverable_present: false,
          status: null,
        }));
      })();
  if (councilEvidence) {
    const presentAttemptIds = new Set(
      attempts.flatMap((attempt) => (attempt.attempt_id ? [attempt.attempt_id] : [])),
    );
    for (const member of councilEvidence.members) {
      if (presentAttemptIds.has(member.attemptId)) continue;
      attempts.push({
        attempt_id: member.attemptId,
        harness_id: member.harnessId,
        role: "planner",
        deliverable_present: member.drafted,
        status: member.failed ? "failed" : member.drafted ? "success" : null,
      });
      presentAttemptIds.add(member.attemptId);
    }
    if (
      councilEvidence.mergeAttemptId &&
      councilEvidence.mergeHarnessId &&
      !presentAttemptIds.has(councilEvidence.mergeAttemptId)
    ) {
      attempts.push({
        attempt_id: councilEvidence.mergeAttemptId,
        harness_id: councilEvidence.mergeHarnessId,
        role: "merge",
        deliverable_present: !councilEvidence.mergeFailed,
        status: councilEvidence.mergeFailed ? "failed" : "success",
      });
    }
    const councilOrder = new Map(
      [
        ...councilEvidence.members.map((member) => member.attemptId),
        ...(councilEvidence.mergeAttemptId ? [councilEvidence.mergeAttemptId] : []),
      ].map((attemptId, index) => [attemptId, index] as const),
    );
    attempts.sort(
      (left, right) =>
        (left.attempt_id
          ? (councilOrder.get(left.attempt_id) ?? Number.MAX_SAFE_INTEGER)
          : Number.MAX_SAFE_INTEGER) -
        (right.attempt_id
          ? (councilOrder.get(right.attempt_id) ?? Number.MAX_SAFE_INTEGER)
          : Number.MAX_SAFE_INTEGER),
    );
  }
  for (const harnessId of args.reviewerHarnessIds) {
    attempts.push({
      attempt_id: null,
      harness_id: harnessId,
      role: "reviewer",
      deliverable_present: false,
      status: null,
    });
  }
  return attempts;
}

interface GateReceipt {
  attemptId: string;
  gates: Array<{ id: string; status: string }>;
}

function gateReceipts(ctx: AnnouncedRunContext): GateReceipt[] {
  const receipts: GateReceipt[] = [];
  for (const event of ctx.log.readAll().events) {
    if (event.type !== "gate.completed") continue;
    const payload = event.payload;
    const attemptId = payload["attempt_id"];
    const rawGates = payload["gates"];
    if (typeof attemptId !== "string" || !Array.isArray(rawGates)) continue;
    const gates: GateReceipt["gates"] = [];
    for (const raw of rawGates) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const record = raw as Record<string, unknown>;
      if (typeof record["id"] !== "string" || typeof record["status"] !== "string") continue;
      gates.push({ id: record["id"], status: record["status"] });
    }
    receipts.push({ attemptId, gates });
  }
  return receipts;
}

function terminalGateReceipt(
  ctx: AnnouncedRunContext,
  telemetry: RunTelemetry | null,
  decision: DecisionRecord | null,
  producerAttemptId: string | null,
): GateReceipt | null {
  const receipts = gateReceipts(ctx);
  if (decision?.final_verify?.attempted) {
    const emitted = [...receipts]
      .reverse()
      .find((candidate) => candidate.attemptId === "final-verify");
    if (emitted) return emitted;
    // An attempted final verify is authoritative even with no emitted gates.
    return {
      attemptId: "final-verify",
      gates: decision.final_verify.gates.map((gate) => ({
        id: gate.id,
        status: gate.status,
      })),
    };
  }
  const authoritativeAttemptId =
    decision?.winner ?? producerAttemptId ?? telemetry?.final_attempt_id ?? null;
  if (authoritativeAttemptId) {
    // Never promote a losing candidate's gates merely because the winner's
    // receipt is missing. Missing authority fails closed in gateProjection.
    return (
      [...receipts].reverse().find((candidate) => candidate.attemptId === authoritativeAttemptId) ??
      null
    );
  }
  return receipts.at(-1) ?? null;
}

function gateProjection(
  ctx: AnnouncedRunContext,
  contract: TaskContract | null,
  telemetry: RunTelemetry | null,
  decision: DecisionRecord | null,
  producerAttemptId: string | null,
  terminalOutcome: RunOutcomeFacts,
): {
  gates: RunFacts["gates"];
  checks: RunOutcomeFacts["checks"];
} {
  const commands = contract?.tests.commands ?? [];
  if (commands.length === 0) {
    return {
      gates: {
        configured: false,
        required: 0,
        total: 0,
        executed: false,
        state: "not_configured",
        receipt_attempt_id: null,
      },
      // FinalVerifier and the protected live apply are deterministic checks
      // that run even when the contract configures no gates. A fail-closed
      // terminal CHECKS axis wins over the unconfigured default — otherwise a
      // refused delivery would normalize to run.completed and become
      // apply-eligible. gates.* stays honestly not_configured: it describes
      // configured contract gates only.
      checks: terminalOutcome.checks === "failed" ? "failed" : "not_configured",
    };
  }
  const receipt = terminalGateReceipt(ctx, telemetry, decision, producerAttemptId);
  const configuredIds = new Set(commands.map((command) => command.id));
  const observed = new Map(
    (receipt?.gates ?? [])
      .filter((gate) => configuredIds.has(gate.id))
      .map((gate) => [gate.id, gate.status] as const),
  );
  const allConfiguredObserved = commands.every((command) => observed.has(command.id));
  const allRequiredPassed = commands
    .filter((command) => command.required)
    .every((command) => observed.get(command.id) === "passed");
  if (!receipt || observed.size === 0) {
    return {
      gates: {
        configured: true,
        required: commands.filter((command) => command.required).length,
        total: commands.length,
        executed: false,
        state: "skipped",
        receipt_attempt_id: null,
      },
      // Missing required gate receipts fail closed as skipped.
      checks: "failed",
    };
  }
  const observedState = !allConfiguredObserved
    ? "skipped"
    : allRequiredPassed
      ? "passed"
      : "failed";
  // A protected live delivery can be refused after a fresh verify passed
  // (for example, when the target changes between verification and mutation).
  // The terminal CHECKS axis is then fail-closed even though the now-stale
  // receipt was green. Preserve that terminal truth and mark the receipt
  // non-authoritative instead of greenwashing the blocked outcome.
  const state =
    observedState === "passed" && terminalOutcome.checks === "failed" ? "skipped" : observedState;
  return {
    gates: {
      configured: true,
      required: commands.filter((command) => command.required).length,
      total: commands.length,
      executed: true,
      state,
      receipt_attempt_id: receipt.attemptId,
    },
    checks: state === "passed" ? "passed" : "failed",
  };
}

function applyStateOf(workProduct: WorkProduct | null) {
  const value = workProduct?.meta["apply_state"];
  return value === "not_applied" ||
    value === "applied" ||
    value === "applied_review_blocked" ||
    value === "reverted"
    ? value
    : null;
}

/** Build and validate the terminal projection from canonical artifacts. */
export function buildRunFacts(
  ctx: AnnouncedRunContext,
  terminalOutcome: RunOutcomeFacts,
): RunFacts {
  const contract = parseArtifact(ctx.store, join(ctx.paths.contextDir, "task.yaml"), TaskContract);
  const telemetry = parseArtifact(
    ctx.store,
    join(ctx.paths.finalDir, "telemetry.yaml"),
    RunTelemetry,
  );
  const workProduct = parseArtifact(
    ctx.store,
    join(ctx.paths.finalDir, "work_product.yaml"),
    WorkProduct,
  );
  const decision = parseArtifact(
    ctx.store,
    join(ctx.paths.arbitrationDir, "decision.yaml"),
    DecisionRecord,
  );
  const council = parseArtifact(
    ctx.store,
    join(ctx.paths.root, "council", "membership.yaml"),
    CouncilProjection,
  );
  const operatorDecision = ctx.store.readYaml<Record<string, unknown>>(
    join(ctx.paths.arbitrationDir, "operator_decision.yaml"),
  );
  const patch = readTextSafe(join(ctx.paths.finalDir, "patch.diff")) ?? "";
  const operatorDecisionMatchesPatch =
    !!operatorDecision &&
    patch.trim().length > 0 &&
    (operatorDecision["action"] === "accept_risk" ||
      operatorDecision["action"] === "override_needs_human") &&
    operatorDecision["patch_sha256"] === sha256(patch);
  const deliverable = canonicalDeliverable({
    ctx,
    mode: ctx.mode,
    workProduct,
    telemetry,
    decision,
  });
  const reviews = readReviewArtifacts(ctx, decision?.winner ?? telemetry?.final_attempt_id ?? null);
  const gate = gateProjection(
    ctx,
    contract,
    telemetry,
    decision,
    deliverable.producer_attempt_id,
    terminalOutcome,
  );
  const outcome: RunOutcomeFacts = {
    ...terminalOutcome,
    checks: gate.checks,
    ...(gate.checks === "failed" && terminalOutcome.lifecycle === "succeeded"
      ? { reason: "checks_failed" as const }
      : {}),
  };
  const operatorDecisionPresent = operatorDecisionMatchesPatch && needsDecision(outcome, false);
  const participants = participantsFor({
    ctx,
    mode: ctx.mode,
    telemetry,
    council,
    reviewerHarnessIds: reviews.reviewerHarnessIds,
  });
  const decisionWithCanonicalFacts = decision ? { ...decision, facts: outcome } : null;
  const applyEligibility =
    patch.trim() && contract && decisionWithCanonicalFacts
      ? deriveApplyEligibility({
          state: outcome.lifecycle,
          decision: decisionWithCanonicalFacts,
          workProduct,
          patch,
          originalRepoRoot: contract.repo.root,
          targetRepoRoot: contract.repo.root,
          operatorDecision:
            operatorDecisionPresent && typeof operatorDecision?.["patch_sha256"] === "string"
              ? {
                  action: String(operatorDecision["action"]),
                  patch_sha256: operatorDecision["patch_sha256"],
                }
              : null,
          applyState: applyStateOf(workProduct),
          workState: outcome.work_state ?? null,
        })
      : null;

  const rawFacts = {
    schema_version: SCHEMA_VERSION,
    run_id: ctx.runId,
    task_id: ctx.taskId,
    mode: ctx.mode,
    outcome,
    deliverable,
    participants: {
      planners: participants.filter((participant) => participant.role === "planner").length,
      attempts: participants,
    },
    gates: gate.gates,
    review: {
      state: outcome.review,
      blocker_ids: reviews.blockerIds,
      blockers: reviews.blockerIds.length,
    },
    apply: {
      eligibility: applyEligibility,
      operator_decision_present: operatorDecisionPresent,
    },
    required_actions: requiredActionsFor(outcome, operatorDecisionPresent),
    generated_at: nowIso(),
  };
  // Redact once so every surface can preserve exact object identity.
  return validateRunFactsInvariants(JSON.parse(redactSecrets(JSON.stringify(rawFacts))) as unknown);
}
