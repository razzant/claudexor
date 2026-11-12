import { describe, expect, it } from "vitest";
import {
  makeOutcomeFacts,
  McpRunHandleResult,
  SCHEMA_VERSION,
  validateRunFactsInvariants,
} from "@claudexor/schema";
import {
  canonicalRunId,
  isRecoverableRunDetailIntegrityProblem,
  projectDegradedRecoveryRunDetail,
  projectImmediateRunDetail,
  projectRecoveryRunDetail,
  projectSecretLikeDisclosure,
} from "./mcp-run-projections.js";
import { CliError } from "./cli-error.js";
import {
  describeRunDetailProblem,
  presentRunPrimaryOutput,
  projectRunPrimaryOutput,
} from "./run-detail-projections.js";

const failure = {
  phase: "execute",
  category: "auth",
  code: null,
  harnessId: "claude",
  attemptId: "a01",
  safeMessage: "Authentication expired",
  rawDetailRef: null,
  resetsAt: null,
  vendorFailure: null,
  logRefs: [],
  eventRefs: [],
  runDir: "/tmp/run",
  nextActions: ["Log in again"],
};

const terminalReceipt = validateRunFactsInvariants({
  schema_version: SCHEMA_VERSION,
  run_id: "run-1",
  task_id: "task-1",
  mode: "plan",
  outcome: makeOutcomeFacts("succeeded"),
  deliverable: {
    present: true,
    kind: "plan",
    path: "final/plan.md",
    producer_attempt_id: "p01",
  },
  participants: {
    planners: 1,
    attempts: [
      {
        attempt_id: "p01",
        harness_id: "codex",
        role: "planner",
        deliverable_present: true,
        status: "success",
      },
    ],
  },
  gates: {
    configured: false,
    required: 0,
    total: 0,
    executed: false,
    state: "not_configured",
    receipt_attempt_id: null,
  },
  review: { state: "not_run", blocker_ids: [], blockers: 0 },
  apply: { eligibility: null, operator_decision_present: false },
  required_actions: [],
  generated_at: "2026-08-14T00:00:00.000Z",
});

describe("MCP run detail projections", () => {
  it("redacts secrets from degraded post-terminal problem messages", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const problem = describeRunDetailProblem(
      Object.assign(new Error(`provider failed with ${token}`), {
        code: "provider_failed",
        retryable: true,
      }),
    );
    expect(problem).toEqual({
      code: "provider_failed",
      message: "provider failed with [redacted]",
      retryable: true,
    });
    expect(problem.message).not.toContain(token);
  });

  it("schema-validates primary output and discloses bounded previews", () => {
    const primary = projectRunPrimaryOutput({
      primaryOutput: {
        kind: "report",
        path: "final/report.md",
        text: "Research result",
        bytes: 300_000,
        truncated: true,
      },
    });
    expect(presentRunPrimaryOutput(primary)).toBe(
      "Research result\n\n[Inline preview bounded; full artifact: final/report.md]",
    );
    expect(projectRunPrimaryOutput({ primaryOutput: { kind: "invented", text: 42 } })).toBeNull();
  });

  it("carries cap-governed spend beside an unknown total for the delegation belt", () => {
    const detail = (budget: Record<string, unknown>) => ({
      summary: { runId: "run-1", spendUsd: budget["spendUsd"] },
      budget,
    });
    expect(
      projectImmediateRunDetail(
        detail({ spendUsd: null, controllableSpendUsd: 0, cashKnowledge: "unknown" }),
      ),
    ).toMatchObject({ spendUsd: null, controllableSpendUsd: 0 });
    expect(
      projectImmediateRunDetail(detail({ spendUsd: null, controllableSpendUsd: null })),
    ).toMatchObject({ spendUsd: null, controllableSpendUsd: null });
    expect(projectImmediateRunDetail(null).controllableSpendUsd).toBeNull();
  });

  it("preserves the typed RunFailure on immediate results", () => {
    // A record written before per-try attribution decodes with an empty list.
    expect(projectImmediateRunDetail({ failure }).failure).toEqual({
      ...failure,
      poolAttempts: [],
    });
  });

  it("projects one schema-validated outcome receipt on immediate and recovery results", () => {
    const outcomeFacts = makeOutcomeFacts("cancelled", { reason: "wall_clock_exceeded" });
    const detail = { summary: { runId: "run-1", state: "cancelled", outcomeFacts } };
    expect(projectImmediateRunDetail(detail).outcomeFacts).toEqual(outcomeFacts);
    expect(projectRecoveryRunDetail("__run_result", "run-1", detail)["outcomeFacts"]).toEqual(
      outcomeFacts,
    );
    const malformed = {
      summary: {
        runId: "run-1",
        state: "cancelled",
        outcomeFacts: { lifecycle: "cancelled", reason: "invented" },
      },
    };
    expect(projectImmediateRunDetail(malformed).outcomeFacts).toBeNull();
    expect(projectRecoveryRunDetail("__run_result", "run-1", malformed)["outcomeFacts"]).toBeNull();
  });

  it("preserves the typed RunFailure on recovery inspect results", () => {
    const projected = projectRecoveryRunDetail("__run_result", "run-1", {
      summary: { runId: "run-1", state: "failed" },
      failure,
    });
    expect(projected["failure"]).toEqual({ ...failure, poolAttempts: [] });
  });

  it("projects the exact canonical receipt and binds terminal run/lifecycle identity", () => {
    const detail = {
      summary: { runId: "run-1", taskId: "task-1", state: "succeeded" },
      runFacts: terminalReceipt,
    };
    expect(
      projectImmediateRunDetail(detail, { runId: "run-1", lifecycle: "succeeded" }).runFacts,
    ).toEqual(terminalReceipt);
    expect(projectRecoveryRunDetail("__run_result", "run-1", detail)["runFacts"]).toEqual(
      terminalReceipt,
    );
    expect(() =>
      projectRecoveryRunDetail("__run_result", "run-1", {
        ...detail,
        summary: { ...detail.summary, state: "failed" },
      }),
    ).toThrow(/canonical RunFacts receipt is invalid/);
    expect(() => projectRecoveryRunDetail("__run_result", "run-other", detail)).toThrow(
      /identity does not match/,
    );
  });
  it("resolves a queued job handle only through the daemon's matching job identity", () => {
    const detail = { summary: { jobId: "job-1", runId: "run-1", state: "running" } };
    expect(projectRecoveryRunDetail("__run_status", "job-1", detail)).toMatchObject({
      runId: "run-1",
      status: "running",
    });
    expect(() => projectRecoveryRunDetail("__run_status", "job-other", detail)).toThrow(
      /identity does not match/,
    );
  });

  it("retains Delegate parent checks when resolving a job handle", () => {
    const detail = {
      summary: { jobId: "job-1", runId: "run-1", state: "running", delegatedFromRunId: "parent-1" },
    };
    expect(projectRecoveryRunDetail("__run_result", "job-1", detail, "parent-1")).toMatchObject({
      runId: "run-1",
      status: "running",
    });
    expect(() => projectRecoveryRunDetail("__run_result", "job-1", detail, "parent-other")).toThrow(
      /not a child/,
    );
  });

  it("keeps compact execution evidence valid on strict MCP recovery outputs", () => {
    const attemptExecution = [
      {
        attemptId: "a01",
        harnessId: "claude",
        usageCost: {
          cashUsd: 0,
          valuationUsd: 0.25,
          unknownUsd: 0,
          cashKnowledge: "unknown",
          valuationKnowledge: "estimated",
        },
      },
    ];
    const projected = projectRecoveryRunDetail("__run_result", "run-1", {
      summary: { runId: "run-1", taskId: "task-1", state: "succeeded" },
      runFacts: terminalReceipt,
      attemptExecution,
    });
    expect(McpRunHandleResult.parse(projected).attemptExecution).toEqual(attemptExecution);
  });

  it("carries the secret-like disclosure as a typed fact that an answer-first run_result cannot drop (INV-062)", () => {
    const secretLike = {
      files: [{ path: "tests/redact.test.ts", matches: 2, kinds: ["openai_compatible_api_key"] }],
      binary_paths: ["assets/x.bin"],
      media_withheld: ["shots/a.png"],
      answer_matches: 1,
      total_matches: 3,
    };
    const detail = (meta: Record<string, unknown>) => ({
      summary: { runId: "run-1", taskId: "task-1", state: "succeeded" },
      runFacts: terminalReceipt,
      // run_result answers with the primary output text, not the summary.md line.
      finalSummary: "- Secret-like strings: 2 in 1 changed file(s)",
      workProduct: { id: "wp-1", kind: "patch", meta },
    });
    const expected = {
      totalMatches: 3,
      answerMatches: 1,
      files: secretLike.files,
      binaryPaths: ["assets/x.bin"],
      mediaWithheld: ["shots/a.png"],
      persistedPatch: "redacted",
      exactPatchRecorded: true,
    };
    for (const mode of ["__run_result", "__inspect"]) {
      const projected = projectRecoveryRunDetail(
        mode,
        "run-1",
        detail({
          secret_like: secretLike,
          persisted_patch: "redacted",
          exact_patch_object: `sha256:${"0".repeat(64)}`,
        }),
      );
      expect(McpRunHandleResult.parse(projected).secretLike).toEqual(expected);
    }
    // A redacted copy whose exact object could not be stored says so.
    expect(
      projectSecretLikeDisclosure(
        detail({ secret_like: secretLike, persisted_patch: "redacted", exact_patch_object: null }),
      ),
    ).toMatchObject({ persistedPatch: "redacted", exactPatchRecorded: false });
    // Media-only disclosure: the saved patch itself is exact.
    expect(
      projectSecretLikeDisclosure(
        detail({ secret_like: { ...secretLike, files: [], binary_paths: [], total_matches: 0 } }),
      ),
    ).toMatchObject({ persistedPatch: "exact", exactPatchRecorded: null, totalMatches: 0 });
    // Clean runs, missing work products and malformed records project null.
    expect(projectSecretLikeDisclosure(detail({}))).toBeNull();
    expect(projectSecretLikeDisclosure(null)).toBeNull();
    expect(projectSecretLikeDisclosure(detail({ secret_like: { files: "nope" } }))).toBeNull();
    expect(
      McpRunHandleResult.parse(projectRecoveryRunDetail("__run_result", "run-1", detail({})))
        .secretLike,
    ).toBeNull();
    expect(
      McpRunHandleResult.parse(projectDegradedRecoveryRunDetail("run-1", new Error("x")))
        .secretLike,
    ).toBeNull();
  });

  it("validates lineage before active-state receipt short-circuit, then returns honest null", () => {
    const raced = {
      summary: { runId: "run-1", state: "running", delegatedFromRunId: "run-parent" },
      runFacts: terminalReceipt,
    };
    expect(
      projectRecoveryRunDetail("__run_status", "run-1", raced, "run-parent")["runFacts"],
    ).toBeNull();
    expect(() =>
      projectRecoveryRunDetail("__run_status", "run-1", raced, "run-other-parent"),
    ).toThrow(/not a child/);
  });

  it("still validates a present receipt for an unknown legacy lifecycle", () => {
    expect(
      projectRecoveryRunDetail("__run_status", "run-1", {
        summary: { runId: "run-1", state: "legacy-settled" },
        runFacts: terminalReceipt,
      })["runFacts"],
    ).toEqual(terminalReceipt);
  });

  it("builds a secret-redacted minimal handle only for the two integrity codes", () => {
    const token = `ghp_${"b".repeat(36)}`;
    const error = new CliError("operational", `invalid receipt ${token}`, {
      code: "run_facts_invalid",
      retryable: false,
    });
    expect(isRecoverableRunDetailIntegrityProblem(error)).toBe(true);
    const degraded = projectDegradedRecoveryRunDetail("run-1", error);
    expect(McpRunHandleResult.parse(degraded)).toEqual(degraded);
    expect(degraded).toMatchObject({
      runId: "run-1",
      status: null,
      runFacts: null,
      outcomeFacts: null,
      applyEligibility: null,
      detailProblem: { code: "run_facts_invalid", retryable: false },
    });
    expect(JSON.stringify(degraded)).not.toContain(token);
    expect(
      isRecoverableRunDetailIntegrityProblem(
        Object.assign(new Error("untyped"), {
          code: "run_facts_invalid",
          mcpRecoveryTypedControlProblem: false,
        }),
      ),
    ).toBe(false);
    expect(
      isRecoverableRunDetailIntegrityProblem(
        Object.assign(new Error("auth"), { code: "unauthorized", retryable: false }),
      ),
    ).toBe(false);
  });

  it("projects continuation facts verbatim and leaves unprojected facts unknown", () => {
    const resumable = {
      cause: "pool_exhausted",
      resetsAt: "2026-10-20T00:00:00.000Z",
      limitWindow: "five_hour",
      limitEvidence: null,
      carriers: ["native", "packet"],
      limitCode: "usage_limit",
      session: { harness: "codex", nativeSessionId: "native-1", holderProfileId: "codex-work" },
      workspace: { kind: "retained_envelope", root: "/kept/tree" },
    };
    const retainedEnvelope = {
      root: "/kept/tree",
      bytes: 1024,
      retainedAt: "2026-10-19T00:00:00.000Z",
      cause: "pool_exhausted",
    };
    // #411(c): the actual source and the moved source's retirement fact, verbatim.
    const continuity = [
      {
        tryIndex: 0,
        attemptId: "a01",
        carrier: "native_moved",
        cause: "pool_exhausted",
        from: { runId: "run-ancestor", attemptId: "a01", profileId: "codex-work" },
        to: { profileId: "codex-other" },
        workspace: "same_root",
        memory: "partial",
        instructions: "as_sent",
        reingestedTokens: null,
        observedModel: null,
        modelMismatch: null,
        identityCheck: "matched_before_effects",
        inputDelivery: "confirmed",
        sourceRetirement: "retired",
      },
    ];
    const terminal = {
      summary: {
        runId: "run-1",
        state: "failed",
        continueFrom: "run-0",
        resumable,
        continuity,
        retainedEnvelope,
      },
    };
    for (const mode of ["__run_status", "__run_result", "__run_inspect"]) {
      const projected = McpRunHandleResult.parse(projectRecoveryRunDetail(mode, "run-1", terminal));
      expect(projected).toMatchObject({
        continueFrom: "run-0",
        resumable,
        continuity,
        retainedEnvelope,
      });
    }
    // The daemon's explicit nulls stay nulls; list-shaped details without receipts omit them.
    const finished = projectRecoveryRunDetail("__run_status", "run-1", {
      summary: {
        runId: "run-1",
        state: "succeeded",
        continueFrom: null,
        resumable: null,
        retainedEnvelope: null,
      },
    });
    expect(finished).toMatchObject({ continueFrom: null, resumable: null, retainedEnvelope: null });
    expect(finished).not.toHaveProperty("continuity");
    // Absent or malformed facts are unknown, never an invented "nothing to continue".
    const unknown = projectRecoveryRunDetail("__run_status", "run-1", {
      summary: { runId: "run-1", state: "failed", resumable: { cause: "invented" } },
    });
    for (const key of ["continueFrom", "resumable", "continuity", "retainedEnvelope"])
      expect(unknown).not.toHaveProperty(key);
    expect(projectDegradedRecoveryRunDetail("run-1", new Error("x"))).not.toHaveProperty(
      "resumable",
    );
  });

  it("converges a job id on its bound run and refuses any other identity", () => {
    expect(canonicalRunId("run-1", { runId: "run-1", jobId: "job-1" })).toBe("run-1");
    expect(canonicalRunId("job-1", { runId: "run-1", jobId: "job-1" })).toBe("run-1");
    expect(canonicalRunId("job-1", { runId: "job-1", jobId: "job-1" })).toBe("job-1");
    expect(() => canonicalRunId("job-2", { runId: "run-1", jobId: "job-1" })).toThrow(
      /identity does not match/,
    );
    expect(() => canonicalRunId("run-1", undefined)).toThrow(/identity does not match/);
  });
});
