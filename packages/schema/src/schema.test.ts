import { describe, expect, it } from "vitest";
import {
  HarnessManifest,
  ReviewFinding,
  RouteProof,
  TaskContract,
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
    expect(tc.access.profile).toBe("workspace_write");
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
      reviewer: { harness_id: "claude", route_proof_status: "verified" },
    });
    expect(f.status).toBe("proposed");
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
