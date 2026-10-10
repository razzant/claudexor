/**
 * Canonical wire fixtures for the TS↔Swift drift gate (D13).
 *
 * Every fixture VALUE is constructed here and passed through the REAL Zod
 * schema (relative dist import — the repo scripts pattern; `pnpm build`
 * first). A fixture that stops parsing fails generation loudly, so the set
 * can never drift from the server contract. The Swift side decodes each
 * JSON, re-encodes, and compares CANONICALIZED JSON (sorted keys,
 * normalized numbers) — never raw bytes (advisor addendum #7).
 *
 * Keep fixtures REPRESENTATIVE, not exhaustive: one minimal + one maximal
 * variant per DTO, plus every union/enum branch a Swift decoder could
 * plausibly get wrong. Grow this list as cuts land new contracts.
 */
import { readFileSync } from "node:fs";
import * as schema from "../../packages/schema/dist/index.js";

const parse = (name, value) => {
  const zod = schema[name];
  if (!zod || typeof zod.parse !== "function") {
    throw new Error(`wire-fixtures: schema export '${name}' is missing or not a Zod schema`);
  }
  return zod.parse(value);
};

const NOW = "2026-07-19T12:00:00.000Z";

/** @type {Array<{ name: string, schema: string, value: unknown }>} */
export function buildWireFixtures() {
  const fixtures = [];
  const add = (name, schemaName, value) =>
    fixtures.push({ name, schema: schemaName, value: parse(schemaName, value) });

  add(
    "effort-resolution-downward",
    "EffortResolution",
    JSON.parse(
      readFileSync(
        new URL("../../packages/schema/fixtures/effort-resolution.json", import.meta.url),
        "utf8",
      ),
    ),
  );

  add("handshake-response", "ControlHandshakeResponse", {
    protocolMajor: schema.CONTROL_PROTOCOL_MAJOR,
    compatible: true,
    operationsPath: "/v2/operations",
    engine: { version: "3.0.0", sha: "a".repeat(40), entry: "/opt/claudexor/daemon.js" },
  });
  // Unstamped-build variant: the engine discloses `sha: "unknown"` honestly
  // before packaged sha stamping lands (Ф4). Locks the Swift handshake decode
  // (QA-002) + the About panel's honest "unknown" display for that branch.
  add("handshake-response-unknown-sha", "ControlHandshakeResponse", {
    protocolMajor: schema.CONTROL_PROTOCOL_MAJOR,
    compatible: true,
    operationsPath: "/v2/operations",
    engine: { version: "3.1.0", sha: "unknown", entry: "/opt/claudexor/daemon.js" },
  });
  // Recovery-only admission (issue #165 D5): transport/protocol succeed while
  // product routes stay closed; Swift must decode servingMode losslessly so
  // the I-A loop can keep the existing Connecting behavior until normal.
  add("handshake-response-recovery-only", "ControlHandshakeResponse", {
    protocolMajor: schema.CONTROL_PROTOCOL_MAJOR,
    compatible: true,
    operationsPath: "/v2/operations",
    engine: { version: "3.4.0", sha: "b".repeat(40), entry: "/opt/claudexor/daemon.js" },
    servingMode: "recovery_only",
  });

  add("problem-minimal", "ControlProblem", {
    code: "plan_not_ready",
    message: "plan run-x is not ready: 2 open question(s)",
    retryable: false,
  });
  add("problem-maximal", "ControlProblem", {
    code: "trust_full_access_required",
    message: "unsandboxed full access requires a per-repo grant",
    retryable: false,
    fieldErrors: { access: ["full access is not allowed for this repo"] },
    requiredActions: ["grant full access in Settings"],
    evidenceRefs: ["run:run-1/events.jsonl"],
    context: { turnId: "turn-abc", repoRoot: "/tmp/proj" },
  });

  add("thread-minimal", "ControlThread", {
    id: "th-1",
    createdAt: NOW,
    updatedAt: NOW,
  });
  add("thread-maximal", "ControlThread", {
    id: "th-2",
    title: "Fix the parser",
    folder: "Parser work",
    repoRoot: "/tmp/proj",
    mode: "agent",
    workspaceMode: "isolated",
    authPreference: "subscription",
    primaryHarness: "claude",
    eligibleHarnesses: ["claude", "codex"],
    credentialProfileId: "exp-a",
    access: "full",
    state: "closed",
    trashedAt: null,
    purgeAfter: null,
    runIds: ["run-1", "run-2"],
    headRunId: "run-2",
    needsHuman: true,
    createdAt: NOW,
    updatedAt: NOW,
  });

  add("thread-delegated", "ControlThread", {
    id: "th-3",
    repoRoot: "/tmp/proj",
    mode: "agent",
    workspaceMode: "delegated",
    workspaceRoot: "/tmp/checking-copy",
    access: "full",
    runIds: [],
    createdAt: NOW,
    updatedAt: NOW,
  });

  // ControlThreadTurn: minimal (no continuity yet) + a lane-switch continuation
  // (INV-137). The continuity field is the V9b DTO extension the Swift decoder
  // must round-trip.
  add("thread-turn-minimal", "ControlThreadTurn", {
    id: "tn-1",
    threadId: "th-1",
    kind: "initial",
    prompt: "add a multiply feature",
    createdAt: NOW,
  });
  add("thread-turn-continuity-packet", "ControlThreadTurn", {
    id: "tn-2",
    threadId: "th-1",
    runId: "run-3",
    parentRunId: "run-2",
    kind: "followup",
    prompt: "now optimize it",
    run: {
      state: "succeeded",
      mode: "agent",
      strategy: null,
      n: 1,
      result: { kind: "answer" },
      spendUsd: 0.12,
      outputReadyState: "ready",
      waitingOnUser: false,
      finishedAt: NOW,
    },
    continuity: {
      kind: "packet",
      packetTurns: 3,
      summarized: true,
      laneSwitchedFrom: { harness: "codex", profileId: "exp-a" },
    },
    createdAt: NOW,
  });
  add("thread-turn-delegation", "ControlThreadTurn", {
    id: "tn-delegate",
    threadId: "th-1",
    runId: "run-delegate-parent",
    kind: "followup",
    prompt: "delegate this",
    run: {
      state: "succeeded",
      mode: "agent",
      result: { kind: "answer" },
      outputReadyState: "ready",
      delegation: {
        requested: true,
        effective: true,
        used: true,
        reason: "used",
        remediation: null,
      },
      delegatedChildRunIds: ["run-child-1", "run-child-2"],
    },
    createdAt: NOW,
  });
  add("thread-turn-native-resume", "ControlThreadTurn", {
    id: "tn-3",
    threadId: "th-1",
    runId: "run-4",
    kind: "followup",
    prompt: "and add a test",
    continuity: {
      kind: "native_resume",
      packetTurns: 0,
      summarized: false,
      laneSwitchedFrom: null,
    },
    createdAt: NOW,
  });

  // Implement turn that froze an approved plan and was forced over open
  // questions: exercises the non-default planHash / planReadinessOverridden
  // branch the Swift decoder must round-trip and the Implement receipt renders
  // (QA-046). Minimal/continuity fixtures above cover the null/false default.
  add("thread-turn-plan-implemented", "ControlThreadTurn", {
    id: "tn-5",
    threadId: "th-1",
    runId: "run-6",
    planRunId: "run-plan-1",
    planHash: "a".repeat(64),
    planReadinessOverridden: true,
    kind: "followup",
    prompt: "implement the approved plan",
    createdAt: NOW,
  });

  add("outcome-facts-clean", "RunOutcomeFacts", {
    lifecycle: "succeeded",
    noChanges: false,
    checks: "passed",
    review: "approved",
    reason: null,
  });
  add("outcome-facts-needs-decision", "RunOutcomeFacts", {
    lifecycle: "succeeded",
    noChanges: false,
    checks: "not_configured",
    review: "blocked",
    reason: "review_blocked",
  });
  add("outcome-facts-failed", "RunOutcomeFacts", {
    lifecycle: "failed",
    noChanges: true,
    checks: "not_configured",
    review: "not_run",
    reason: "budget_exhausted",
  });

  // Delegate readiness/outcome are consumed directly by the Swift composer
  // and run receipts. Pin both cross-language shapes so a reason/remediation
  // or requested/effective/used drift cannot silently disable or mislabel the
  // control surface.
  add("delegation-capability-ready", "DelegationCapability", {
    available: true,
    reason: "ready",
    remediation: null,
    requiresFullAccess: true,
  });
  add("run-delegation-degraded", "RunDelegationInfo", {
    requested: true,
    effective: false,
    used: false,
    reason: "runtime_unavailable",
    remediation: "Update or repair the Claudexor runtime, then retry Delegate.",
  });
  add("run-failure-delegation-drain-timeout", "RunFailure", {
    phase: "terminalization",
    category: "internal",
    code: "delegation_child_drain_timeout",
    safeMessage: "Timed out draining delegated children before parent terminalization.",
    eventRefs: ["events.jsonl#delegation-child-drain"],
    nextActions: ["Inspect child run terminals and retry the parent after recovery."],
  });
  // A refusal carrying a NON-NULL resetsAt. The fixture above leaves it null,
  // and the canonicalizer drops null keys — so the whole reopen-time contract
  // rode the gate invisibly while the Swift DTO silently discarded it, forcing
  // clients back to parsing "resets …" out of safeMessage.
  add("run-failure-subscription-window-exhausted", "RunFailure", {
    phase: "routing",
    // 8bd240b3: a spent subscription window is NOT a budget denial — the
    // engine's only emitter of this code sets harness_unavailable (wave NIT).
    category: "harness_unavailable",
    code: "subscription_window_exhausted",
    harnessId: "claude",
    safeMessage: "Every candidate's subscription window is spent.",
    resetsAt: "2026-07-19T17:00:00.000Z",
    nextActions: ["Wait for the window to reopen, or route to another credential."],
  });

  add("budget-snapshot-unlimited", "ControlBudgetSnapshot", {
    paidBudget: { kind: "unlimited" },
    spendUsd: null,
    remainingUsd: null,
    estimated: false,
    source: "unknown",
  });
  add("budget-snapshot-capped", "ControlBudgetSnapshot", {
    paidBudget: { kind: "finite", maxUsd: 2.5 },
    spendUsd: 1.25,
    remainingUsd: 1.25,
    estimated: true,
    source: "decision",
  });

  // Subscription run: cash exact $0 with a KNOWN non-null token valuation and
  // partial event evidence — exercises the non-default valuationUsd /
  // valuationKnowledge / evidence branch (QA-023c). The two fixtures above pin
  // the null/"unknown"/"complete" default.
  add("budget-snapshot-valued", "ControlBudgetSnapshot", {
    paidBudget: { kind: "unlimited" },
    spendUsd: 0,
    valuationUsd: 0.87,
    valuationKnowledge: "estimated",
    remainingUsd: null,
    estimated: false,
    source: "events",
    evidence: "incomplete",
  });

  add("plan-readiness-ready", "PlanReadiness", { state: "ready", questionCount: 0 });
  add("plan-readiness-needs-answers", "PlanReadiness", {
    state: "needs_answers",
    questionCount: 3,
  });
  add("plan-questions", "PlanQuestionsArtifact", {
    parse: "found",
    questions: [
      {
        id: "q1",
        kind: "single",
        prompt: "Which store?",
        options: [
          { id: "o1", label: "sqlite" },
          { id: "o2", label: "json" },
        ],
        allow_text: false,
      },
      { id: "q2", kind: "text", prompt: "Anything else?", options: [], allow_text: true },
    ],
  });

  add("apply-eligibility-yes", "ApplyEligibility", {
    eligible: true,
    state: "succeeded",
    reason: null,
    requiredAction: null,
  });
  add("apply-eligibility-no", "ApplyEligibility", {
    eligible: false,
    state: "succeeded",
    reason: "review blocked: 2 open finding(s)",
    requiredAction: "decision",
  });

  add("quota-response", "ControlQuotaResponse", {
    snapshots: [
      {
        subject: {
          harness: "codex",
          credential_route: "vendor_native",
          plan_label: "pro",
          subject_id: "work",
        },
        constraints: [
          {
            id: "primary",
            label: "5h window",
            used_ratio: 0.42,
            window_seconds: 18000,
            resets_at: NOW,
            cooldown_until: null,
          },
        ],
        source: "codex_app_server",
        observed_at: NOW,
        freshness: "fresh",
      },
    ],
    absences: [
      {
        subject: {
          harness: "claude",
          credential_route: "vendor_native",
          plan_label: null,
          subject_id: "koshak",
        },
        reason: "not_logged_in",
        detail: null,
        observed_at: NOW,
      },
    ],
    refreshed_at: NOW,
  });

  // ControlHarnessSettingsPatch is STRICT server-side: a key the schema never
  // declared 400s the whole save (GitHub #18 — the Swift client used to send a
  // dead `maxUsd`). This MAXIMAL fixture populates every allowed key, so the
  // Swift HarnessSettingsPatch decode→re-encode round trip drifts loudly the
  // moment its key set diverges from this SSOT schema.
  add("harness-settings-patch-maximal", "ControlHarnessSettingsPatch", {
    enabled: true,
    nativeCredentialsEnabled: true,
    defaultModel: "gpt-5.5",
    effort: "high",
    maxTurns: 40,
    maxRounds: 6,
    toolsAllow: ["bash", "read"],
    toolsDeny: ["net"],
    fallbackModel: "gpt-5-mini",
    web: "live",
    authPreference: "subscription",
    profileLimitAction: "rotate",
  });

  // POST /settings answers with the effective snapshot (GET's shape), not the
  // v0.x `{path}` receipt — the Swift client decoding the dead receipt shape
  // read every successful save as a failure (GitHub #20). This MAXIMAL
  // fixture pins the response contract the same way the patch fixture above
  // pins the request.
  add("settings-snapshot-maximal", "ControlSettingsSnapshot", {
    sources: ["/home/u/.claudexor/v3/config.yaml"],
    interactionTimeoutMs: 900_000,
    routing: {
      primaryHarness: "codex",
      eligibleHarnesses: ["codex", "claude"],
      envInheritance: "clean",
      authPreference: "subscription",
      goal: "quality",
      paidFallback: "never",
      qualityTiers: {
        implement: [[{ harness: "codex", model: "gpt-5.6-sol", effort: "high" }]],
      },
    },
    budget: { paidBudgetPerRun: { kind: "finite", maxUsd: 4 } },
    runtime: {
      reviewerTimeoutMs: 600_000,
      harnessInactivityTimeoutMs: 1_200_000,
      concurrency: {
        configured: {
          maxConcurrent: "unlimited",
          maxConcurrentNonModelJobs: 48,
          maxConcurrentModelOperations: "unlimited",
          sources: {
            max_concurrent: "config",
            max_concurrent_non_model_jobs: "config",
            max_concurrent_model_operations: "default",
            max_parallel_candidates: "config",
            max_deep_scan_width: "config",
            max_council_members: "config",
          },
          maxParallelCandidates: 6,
          maxDeepScanWidth: 16,
          maxCouncilMembers: 6,
        },
        effective: {
          maxConcurrent: 24,
          maxConcurrentNonModelJobs: "unlimited",
          maxConcurrentModelOperations: "unlimited",
          sources: {
            max_concurrent: "config",
            max_concurrent_non_model_jobs: "default",
            max_concurrent_model_operations: "default",
            max_parallel_candidates: "default",
            max_deep_scan_width: "default",
            max_council_members: "default",
          },
          maxParallelCandidates: 4,
          maxDeepScanWidth: 8,
          maxCouncilMembers: 4,
        },
        restartRequired: true,
      },
      transientRetry: { maxRetries: 2, initialDelayMs: 1_000, maxDelayMs: 10_000 },
    },
    harnesses: {
      codex: {
        enabled: true,
        nativeCredentialsEnabled: true,
        defaultModel: "gpt-5.6-sol",
        effort: "high",
        maxTurns: 40,
        maxRounds: 6,
        toolsAllow: ["bash", "read"],
        toolsDeny: ["net"],
        fallbackModel: "gpt-5-mini",
        web: "live",
        authPreference: "subscription",
        profileLimitAction: "rotate",
      },
    },
  });

  return fixtures;
}
