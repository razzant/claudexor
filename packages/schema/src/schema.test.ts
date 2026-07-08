import { describe, expect, it } from "vitest";
import {
  ControlRunDecisionRequest,
  ControlRunStartRequest,
  ControlSetupJob,
  ControlSetupJobConfirmRequest,
  ControlSetupJobCreateRequest,
  ControlSettingsSnapshot,
  ControlSpecFreezeRequest,
  ControlSpecQuestionsRequest,
  ControlThread,
  HarnessManifest,
  HarnessRunSpec,
  OrchestrateContract,
  OrchestratePlan,
  OrchestratePlanProgress,
  SpecPack,
  TOOL_RISK,
  toolRisk,
  ReviewFinding,
  RouteProof,
  Session,
  SessionReboundLineage,
  TaskContract,
  Thread,
  ThreadTurn,
  isBlocking,
} from "./index.js";

describe("TaskContract", () => {
  it("applies defaults from minimal input", () => {
    const tc = TaskContract.parse({
      task_id: "t-1",
      created_at: "2026-06-05T00:00:00Z",
      repo: { root: "/repo", base_ref: "main" },
      schema_version: 2,
      mode: { kind: "agent" },
      user_intent: { raw: "do the thing" },
    });
    expect(tc.access.requested_profile).toBe("workspace_write");
    expect(tc.access.effective_profile).toBe("workspace_write");
    expect(tc.external_context.effective_mode).toBe("auto");
    expect(tc.budget.portfolio).toBe("subscription-first");
    expect(tc.constraints.protected_path_approvals).toEqual([]);
    expect(tc.convergence.require_tests_pass).toBe(true);
  });
});

describe("SpecPack", () => {
  it("rejects per-run protected path approvals inside frozen spec constraints", () => {
    expect(() =>
      SpecPack.parse({
        schema_version: 2,
        id: "spec-1",
        created_at: "2026-06-29T00:00:00Z",
        version: 1,
        frozen: true,
        intent: { raw: "update tests" },
        constraints: {
          protected_paths: ["test/**"],
          protected_path_approvals: [{ path: "test/**", reason: "self-authorized by spec" }],
        },
      }),
    ).toThrow(/protected_path_approvals/);
  });
});

describe("ControlSettingsSnapshot", () => {
  it("carries daemon-effective runtime settings for CLI/IDE projections", () => {
    const snapshot = ControlSettingsSnapshot.parse({
      runtime: {
        reviewerTimeoutMs: 2_400_000,
        transientRetry: {
          maxRetries: 3,
          initialDelayMs: 2_000,
          maxDelayMs: 20_000,
        },
      },
    });
    expect(snapshot.runtime.reviewerTimeoutMs).toBe(2_400_000);
    expect(snapshot.runtime.transientRetry.maxRetries).toBe(3);
    expect(snapshot.runtime.transientRetry.initialDelayMs).toBe(2_000);
    expect(snapshot.runtime.transientRetry.maxDelayMs).toBe(20_000);
  });
});

describe("ReviewFinding.isBlocking", () => {
  const base = {
    severity: "BLOCK" as const,
    status: "accepted" as const,
    evidence: { files: [], diff_hunks: [], commands: [], logs: [] },
  };

  it("does not block without evidence (no evidence -> cannot BLOCK)", () => {
    expect(isBlocking(base)).toBe(false);
  });

  it("blocks when accepted + BLOCK + has evidence", () => {
    expect(
      isBlocking({
        ...base,
        evidence: { ...base.evidence, files: [{ path: "a.ts", lines: "1-2" }] },
      }),
    ).toBe(true);
  });

  it("does not block when only proposed", () => {
    expect(
      isBlocking({
        severity: "BLOCK",
        status: "proposed",
        evidence: {
          files: [{ path: "a.ts", lines: null }],
          diff_hunks: [],
          commands: [],
          logs: [],
        },
      }),
    ).toBe(false);
  });

  it("parses a full finding with reviewer route proof", () => {
    const f = ReviewFinding.parse({
      id: "f-1",
      severity: "FIX_FIRST",
      category: "correctness",
      claim: "off-by-one",
      evidence: { files: [{ path: "x.ts", lines: "10" }] },
      reviewer: { harness_id: "claude", requested_effort: "max", route_proof_status: "verified" },
    });
    expect(f.status).toBe("proposed");
    expect(f.reviewer.requested_effort).toBe("max");
    expect(f.reviewer.route_proof_status).toBe("verified");
  });
});

describe("RouteProof + HarnessManifest", () => {
  it("parses a same-model fallback route proof", () => {
    const rp = RouteProof.parse({
      requested: { harness_id: "codex", provider_family: "openai" },
      observed: { provider: "openai", model_id: "gpt-5.5", evidence_source: "stream_event" },
      status: "verified",
    });
    expect(rp.status).toBe("verified");
    expect(rp.requested.model_hint).toBeNull();
  });

  it("parses a harness manifest with capabilities", () => {
    const m = HarnessManifest.parse({
      id: "fake-success",
      display_name: "Fake",
      kind: "fake",
      provider_family: "local",
      capabilities: { implement: true, review: true },
    });
    expect(m.capabilities.implement).toBe(true);
    expect(m.capabilities.quota_signal).toBe("unknown");
  });
});

describe("Control API schemas", () => {
  it("accepts reviewer effort overrides on run start requests", () => {
    const req = ControlRunStartRequest.parse({
      prompt: "review it",
      mode: "agent",
      scope: { kind: "project", root: "/repo" },
      reviewerPanel: [
        { harness: "claude", model: "claude-opus-4-8", effort: "max" },
        { harness: "cursor", model: "gemini-3.1-pro" },
        { harness: "cursor", model: "gemini-3.5-flash" },
      ],
      reviewerEfforts: { anthropic: "max", openai: "xhigh" },
      reviewerModels: { anthropic: "claude-opus-4-8", openai: "gpt-4o" },
    });
    expect(req.scope).toEqual({ kind: "project", root: "/repo", context: "auto" });
    expect(req.reviewerPanel).toEqual([
      { harness: "claude", model: "claude-opus-4-8", effort: "max" },
      { harness: "cursor", model: "gemini-3.1-pro" },
      { harness: "cursor", model: "gemini-3.5-flash" },
    ]);
    expect(req.reviewerEfforts?.anthropic).toBe("max");
    expect(req.reviewerEfforts?.openai).toBe("xhigh");
    expect(req.reviewerModels?.anthropic).toBe("claude-opus-4-8");
    expect(req.reviewerModels?.openai).toBe("gpt-4o");
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "legacy",
        mode: "agent",
        repoRoot: "/repo",
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        reviewerEfforts: { anthropic: 1 },
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        reviewerEfforts: { anthropic: "banana" },
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        reviewerModels: { opneai: "gpt-4o" },
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        primaryHarness: "",
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        primaryHarness: "   ",
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        model: "",
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        model: "   ",
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        reviewerModels: { openai: "" },
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        reviewerModels: { openai: "   " },
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        harnesses: ["codex", "   "],
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        tests: ["pnpm test", "   "],
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        reviewerPanel: [{ harness: "", model: "gpt" }],
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        reviewerPanel: [{ harness: "   ", model: "gpt" }],
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        reviewerPanel: [{ harness: "cursor", model: "   " }],
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        reviewerPanel: [{ harness: "cursor", effort: "turbo" }],
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        specPath: "   ",
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        protectedPathApprovals: [{ path: "   " }],
      }),
    ).toThrow();
    expect(() =>
      ControlRunStartRequest.parse({
        prompt: "bad",
        mode: "ask",
        protectedPathApprovals: [{ path: "packages/**/*.test.ts", reason: "   " }],
      }),
    ).toThrow();
  });

  it("parses setup-job + spec contracts", () => {
    const jobReq = ControlSetupJobCreateRequest.parse({ harness: "cursor", action: "install" });
    expect(jobReq).toEqual({ harness: "cursor", action: "install" });
    expect(ControlSetupJobCreateRequest.parse({ harness: "codex", action: "store_key" })).toEqual({
      harness: "codex",
      action: "store_key",
    });
    const job = ControlSetupJob.parse({
      jobId: "setup-1",
      harness: "cursor",
      action: "install",
      state: "waiting_for_input",
      message: "confirm",
      riskFlags: ["network_download"],
      requiresConfirmation: true,
      createdAt: new Date().toISOString(),
    });
    expect(job.command).toBeNull();
    expect(job.finishedAt).toBeNull();
    expect(ControlSetupJobConfirmRequest.parse({}).confirmed).toBe(true);

    const specReq = ControlSpecQuestionsRequest.parse({
      prompt: "scope it",
      scope: { kind: "project", root: "/repo" },
    });
    expect(specReq.scope.root).toBe("/repo");
    expect(specReq.scope.context).toBe("auto"); // defaulted
    // The macOS RunScope serializes `context` — the spec scope MUST accept it (a
    // strict scope without it 400'd /spec/questions before grounding ran).
    const specWithCtx = ControlSpecQuestionsRequest.parse({
      prompt: "x",
      scope: { kind: "project", root: "/repo", context: "auto" },
    });
    expect(specWithCtx.scope.context).toBe("auto");
    // "deep" was retired in the v0.15 triage — it never had distinct behavior;
    // an old client sending it must fail loudly, not silently rewrite.
    expect(() =>
      ControlSpecFreezeRequest.parse({
        prompt: "x",
        scope: { kind: "project", root: "/repo", context: "deep" },
      }),
    ).toThrow();
    expect(() =>
      ControlSpecQuestionsRequest.parse({ prompt: "legacy", repoRoot: "/repo" }),
    ).toThrow();
    expect(() =>
      ControlSpecQuestionsRequest.parse({
        prompt: "legacy",
        scope: { kind: "project", root: "/repo" },
        contextMode: "off",
      }),
    ).toThrow();
    expect(() =>
      ControlSpecFreezeRequest.parse({
        prompt: "legacy",
        scope: { kind: "project", root: "/repo" },
        inPlace: true,
        plan: "x",
      }),
    ).toThrow();
  });
});

describe("v0.9 threads / sessions / orchestrate / decision", () => {
  it("parses a Thread with defaults (SSOT entity)", () => {
    const t = Thread.parse({
      schema_version: 2,
      id: "th-1",
      created_at: "2026-06-12T00:00:00Z",
      updated_at: "2026-06-12T00:00:00Z",
    });
    expect(t.state).toBe("active");
    expect(t.auth_preference).toBe("auto");
    expect(t.repo).toBeNull();
    expect(t.run_ids).toEqual([]);
  });

  it("parses a Session as a re-hostable cache pointer", () => {
    const s = Session.parse({
      id: "se-1",
      thread_id: "th-1",
      harness_id: "codex",
      created_at: "2026-06-12T00:00:00Z",
      updated_at: "2026-06-12T00:00:00Z",
    });
    expect(s.native_session_id).toBeNull();
    expect(s.last_observed_model).toBeNull();
    expect(s.resume_kind).toBe("none");
    expect(s.state).toBe("live");
  });

  it("defaults a Thread to an in-place workspace", () => {
    const t = Thread.parse({
      schema_version: 2,
      id: "th-1",
      created_at: "2026-06-12T00:00:00Z",
      updated_at: "2026-06-12T00:00:00Z",
    });
    expect(t.workspace.mode).toBe("in_place");
    expect(t.workspace.worktree_path).toBeNull();
    expect(t.state).toBe("active");
  });

  it("parses a ThreadTurn and a SessionReboundLineage", () => {
    const turn = ThreadTurn.parse({
      id: "tn-1",
      thread_id: "th-1",
      created_at: "2026-06-12T00:00:00Z",
    });
    expect(turn.kind).toBe("followup");
    const reb = SessionReboundLineage.parse({
      thread_id: "th-1",
      harness_id: "claude",
      reason: "harness_error",
    });
    expect(reb.reason).toBe("harness_error");
  });

  it("defaults the orchestrate tool belt to the autonomously-executable tools (answer_question excluded)", () => {
    const c = OrchestrateContract.parse({ thread_id: "th-1", goal: "ship v0.9" });
    // answer_question is intentionally not in the default belt: safe sub-runs are
    // non-interactive so an auto-executed plan has nothing to answer.
    expect(c.tool_belt).toEqual(["start_run", "race", "status", "apply", "review"]);
    expect(c.autonomy).toBe("suggest");
  });

  it("classifies tool risk FAIL-CLOSED: apply risky, the 5 others safe, unknown risky", () => {
    expect(TOOL_RISK).toEqual({
      start_run: "safe",
      race: "safe",
      status: "safe",
      answer_question: "safe",
      review: "safe",
      apply: "risky",
    });
    expect(toolRisk("apply")).toBe("risky");
    for (const t of ["start_run", "race", "status", "answer_question", "review"]) {
      expect(toolRisk(t)).toBe("safe");
    }
    // Any unknown/undeclared tool is risky (the executor never auto-runs it).
    expect(toolRisk("totally_unknown_tool")).toBe("risky");
    expect(toolRisk("")).toBe("risky");
  });

  it("parses PER-TOOL typed plan-call args (discriminated union) and applies defaults", () => {
    const plan = OrchestratePlan.parse({
      tool_calls: [
        { tool: "start_run", prompt: "fix the bug" },
        { tool: "race", prompt: "two ways", n: 3 },
        { tool: "review", run_id: "run-1" },
        { tool: "status", run_id: "run-2" },
        {
          tool: "answer_question",
          interaction_id: "int-1",
          answers: [{ question_id: "q1", selected_labels: ["yes"] }],
        },
        { tool: "apply", run_id: "run-3" },
      ],
    });
    const start = plan.tool_calls[0];
    expect(start.tool === "start_run" && start.mode).toBe("agent"); // default mode
    const race = plan.tool_calls[1];
    expect(race.tool === "race" && race.n).toBe(3);
    const apply = plan.tool_calls[5];
    expect(apply.tool === "apply" && apply.mode).toBe("apply"); // default apply mode
  });

  it("rejects malformed per-tool args loudly (wrong/missing fields, n<2, unknown tool)", () => {
    // start_run requires a non-empty prompt.
    expect(() =>
      OrchestratePlan.parse({ tool_calls: [{ tool: "start_run", prompt: "" }] }),
    ).toThrow();
    // race n must be >= 2.
    expect(() =>
      OrchestratePlan.parse({ tool_calls: [{ tool: "race", prompt: "x", n: 1 }] }),
    ).toThrow();
    // apply requires a run_id.
    expect(() => OrchestratePlan.parse({ tool_calls: [{ tool: "apply" }] })).toThrow();
    // an undeclared tool is not in the discriminated union.
    expect(() => OrchestratePlan.parse({ tool_calls: [{ tool: "rm_rf", prompt: "x" }] })).toThrow();
    // empty plan rejected (min 1).
    expect(() => OrchestratePlan.parse({ tool_calls: [] })).toThrow();
  });

  it("validates typed executor progress (OrchestratePlanProgress)", () => {
    const p = OrchestratePlanProgress.parse({
      autonomy: "auto_safe",
      steps: [
        { index: 0, tool: "start_run", risk: "safe", status: "done", run_id: "run-9" },
        { index: 1, tool: "apply", risk: "risky", status: "blocked", detail: "needs human" },
      ],
      stopped_reason: "blocked at risky step #1",
    });
    expect(p.steps[1]?.status).toBe("blocked");
    expect(p.steps[1]?.run_id).toBeNull();
    expect(p.stopped_reason).toContain("risky");
  });

  it("carries auth_preference + resume_session_id on a HarnessRunSpec", () => {
    const spec = HarnessRunSpec.parse({
      session_id: "se-1",
      intent: "implement",
      prompt: "go",
      cwd: "/repo",
    });
    expect(spec.auth_preference).toBe("auto");
    expect(spec.resume_session_id).toBeNull();
  });

  it("accepts thread linkage + planRunId + authPreference on a run start request", () => {
    const req = ControlRunStartRequest.parse({
      prompt: "follow up",
      mode: "agent",
      threadId: "th-1",
      parentRunId: "run-0",
      planRunId: "run-plan-1",
      authPreference: "subscription",
      protectedPathApprovals: [
        { path: "packages/**/*.test.ts", reason: "test authoring requested" },
      ],
    });
    expect(req.threadId).toBe("th-1");
    expect(req.planRunId).toBe("run-plan-1");
    expect(req.authPreference).toBe("subscription");
    expect(req.protectedPathApprovals?.[0]?.path).toBe("packages/**/*.test.ts");
    // `sessionId` was removed (it had no consumer — staged-field rule): the strict
    // DTO now rejects it LOUDLY instead of accepting a no-op field.
    expect(() =>
      ControlRunStartRequest.parse({ prompt: "x", mode: "agent", sessionId: "se-1" }),
    ).toThrow(/sessionId/);
  });

  it("validates a typed review decision (unblock) request, rejecting unknown keys", () => {
    const d = ControlRunDecisionRequest.parse({
      action: "accept_risk",
      findingIds: ["f-1"],
      acceptedRisks: ["protected path"],
    });
    expect(d.action).toBe("accept_risk");
    expect(d.findingIds).toEqual(["f-1"]);
    expect(() => ControlRunDecisionRequest.parse({ action: "bogus" })).toThrow();
    expect(() => ControlRunDecisionRequest.parse({ action: "apply", surprise: 1 })).toThrow();
  });

  it("projects a ControlThread with a needs-me flag", () => {
    const ct = ControlThread.parse({
      id: "th-1",
      createdAt: "x",
      updatedAt: "y",
      needsHuman: true,
    });
    expect(ct.needsHuman).toBe(true);
    expect(ct.authPreference).toBe("auto");
    expect(ct.state).toBe("active");
  });

  it("defaults the new convergence + task_graph fields on a TaskContract", () => {
    const tc = TaskContract.parse({
      task_id: "t-1",
      created_at: "2026-06-12T00:00:00Z",
      repo: { root: "/repo", base_ref: "main" },
      schema_version: 2,
      mode: { kind: "agent" },
      user_intent: { raw: "do the thing" },
    });
    expect(tc.convergence.require_no_accepted_needs_human_open).toBe(true);
    expect(tc.task_graph).toBeNull();
  });
});
