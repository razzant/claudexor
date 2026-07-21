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

  add("handshake-response", "ControlHandshakeResponse", {
    protocolMajor: schema.CONTROL_PROTOCOL_MAJOR,
    compatible: true,
    operationsPath: "/v2/operations",
    engine: { version: "3.0.0", sha: "a".repeat(40), entry: "/opt/claudexor/daemon.js" },
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

  return fixtures;
}
