import { describe, expect, it } from "vitest";
import {
  ControlHarnessSetupRequest,
  ControlHarnessSetupResponse,
  ControlRunDecisionRequest,
  ControlRunStartRequest,
  ControlSetupJob,
  ControlSetupJobConfirmRequest,
  ControlSetupJobCreateRequest,
  ControlSpecFreezeRequest,
  ControlSpecQuestionsRequest,
  ControlThread,
  HarnessManifest,
  HarnessRunSpec,
  OrchestrateContract,
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
    expect(tc.delivery.mutation_mode).toBe("envelope_live");
    expect(tc.access.requested_profile).toBe("workspace_write");
    expect(tc.access.effective_profile).toBe("workspace_write");
    expect(tc.external_context.effective_mode).toBe("auto");
    expect(tc.budget.portfolio).toBe("subscription-first");
    expect(tc.convergence.require_tests_pass).toBe(true);
    expect(tc.context_policy.no_silent_truncation).toBe(true);
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
      isBlocking({ ...base, evidence: { ...base.evidence, files: [{ path: "a.ts", lines: "1-2" }] } }),
    ).toBe(true);
  });

  it("does not block when only proposed", () => {
    expect(
      isBlocking({
        severity: "BLOCK",
        status: "proposed",
        evidence: { files: [{ path: "a.ts", lines: null }], diff_hunks: [], commands: [], logs: [] },
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
      capabilities: { implement: true, structured_events: true },
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
      reviewerEfforts: { anthropic: "max", openai: "xhigh" },
    });
    expect(req.scope).toEqual({ kind: "project", root: "/repo", context: "auto" });
    expect(req.reviewerEfforts?.anthropic).toBe("max");
    expect(req.reviewerEfforts?.openai).toBe("xhigh");
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
  });

  it("parses harness setup request/response contracts", () => {
    const req = ControlHarnessSetupRequest.parse({ harness: "codex" });
    expect(req.action).toBe("login");
    expect(() => ControlHarnessSetupRequest.parse({ harness: "unknown", action: "login" })).toThrow();
    expect(() => ControlHarnessSetupRequest.parse({ harness: "codex", action: "rm_rf" })).toThrow();
    expect(() => ControlHarnessSetupRequest.parse({ harness: "codex", repoRoot: "/repo" })).toThrow();

    const res = ControlHarnessSetupResponse.parse({
      harness: "codex",
      action: "doctor",
      status: "prepared",
      message: "prepared",
    });
    expect(res.command).toBeNull();
    expect(res.guideUrl).toBeNull();
    expect(res.logPath).toBeNull();
    expect(() =>
      ControlHarnessSetupResponse.parse({
        harness: "unknown",
        action: "doctor",
        status: "prepared",
        message: "prepared",
      }),
    ).toThrow();

    const jobReq = ControlSetupJobCreateRequest.parse({ harness: "cursor", action: "install" });
    expect(jobReq).toEqual({ harness: "cursor", action: "install" });
    expect(ControlSetupJobCreateRequest.parse({ harness: "codex", action: "store_key" })).toEqual({ harness: "codex", action: "store_key" });
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

    const specReq = ControlSpecQuestionsRequest.parse({ prompt: "scope it", scope: { kind: "project", root: "/repo" } });
    expect(specReq.scope.root).toBe("/repo");
    expect(() => ControlSpecQuestionsRequest.parse({ prompt: "legacy", repoRoot: "/repo" })).toThrow();
    expect(() => ControlSpecQuestionsRequest.parse({ prompt: "legacy", scope: { kind: "project", root: "/repo" }, contextMode: "off" })).toThrow();
    expect(() => ControlSpecFreezeRequest.parse({ prompt: "legacy", scope: { kind: "project", root: "/repo" }, inPlace: true, plan: "x" })).toThrow();
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
    expect(t.portfolio).toBe("subscription-first");
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
    expect(s.auth_mode).toBe("unknown");
    expect(s.resume_kind).toBe("none");
    expect(s.state).toBe("live");
  });

  it("parses a ThreadTurn and a SessionReboundLineage", () => {
    const turn = ThreadTurn.parse({ id: "tn-1", thread_id: "th-1", created_at: "2026-06-12T00:00:00Z" });
    expect(turn.kind).toBe("followup");
    const reb = SessionReboundLineage.parse({ thread_id: "th-1", harness_id: "claude", reason: "harness_error" });
    expect(reb.reason).toBe("harness_error");
    expect(reb.open_tasks).toEqual([]);
  });

  it("defaults the orchestrate tool belt to all six tools", () => {
    const c = OrchestrateContract.parse({ thread_id: "th-1", goal: "ship v0.9" });
    expect(c.tool_belt).toEqual(["start_run", "race", "status", "answer_question", "apply", "review"]);
    expect(c.autonomy).toBe("suggest");
  });

  it("carries auth_preference + resume_session_id on a HarnessRunSpec", () => {
    const spec = HarnessRunSpec.parse({ session_id: "se-1", intent: "implement", prompt: "go", cwd: "/repo" });
    expect(spec.auth_preference).toBe("auto");
    expect(spec.resume_session_id).toBeNull();
  });

  it("accepts thread linkage + authPreference on a run start request", () => {
    const req = ControlRunStartRequest.parse({
      prompt: "follow up",
      mode: "agent",
      threadId: "th-1",
      parentRunId: "run-0",
      sessionId: "se-1",
      authPreference: "subscription",
    });
    expect(req.threadId).toBe("th-1");
    expect(req.authPreference).toBe("subscription");
    // `rehost` was removed until its behavior ships (staged-field rule): the
    // strict DTO rejects it LOUDLY instead of accepting a no-op flag.
    expect(() => ControlRunStartRequest.parse({ prompt: "x", mode: "agent", rehost: true })).toThrow(/rehost/);
  });

  it("validates a typed review decision (unblock) request, rejecting unknown keys", () => {
    const d = ControlRunDecisionRequest.parse({ action: "accept_risk", findingIds: ["f-1"], acceptedRisks: ["protected path"] });
    expect(d.action).toBe("accept_risk");
    expect(d.findingIds).toEqual(["f-1"]);
    expect(() => ControlRunDecisionRequest.parse({ action: "bogus" })).toThrow();
    expect(() => ControlRunDecisionRequest.parse({ action: "apply", surprise: 1 })).toThrow();
  });

  it("projects a ControlThread with a needs-me flag", () => {
    const ct = ControlThread.parse({ id: "th-1", createdAt: "x", updatedAt: "y", needsHuman: true });
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
