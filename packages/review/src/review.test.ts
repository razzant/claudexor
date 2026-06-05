import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@claudex/core";
import type { ProviderFamily } from "@claudex/schema";
import { ConformanceReport, ConvergencePredicate, HarnessManifest, ReviewFinding } from "@claudex/schema";
import { evaluateConvergence } from "./convergence.js";
import { dedupeFindings, parseFindings } from "./findings.js";
import { gatesPassed, runGate } from "./gates.js";
import { ReadinessLedger, failureSignature } from "./readiness.js";
import { revalidateFindings } from "./revalidate.js";
import { type ReviewerSpec, reviewCandidate } from "./reviewEngine.js";
import { buildRouteProof, classifyDiversity, verifyCrossFamily } from "./route.js";

function makeReviewer(id: string, family: ProviderFamily, findings: unknown[]): ReviewerSpec {
  const adapter: HarnessAdapter = {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: family,
        capabilities: { review: true, structured_output: true },
      });
    },
    async doctor() {
      return ConformanceReport.parse({ harness_id: id, status: "ok", enabled_intents: ["review"] });
    },
    async *run(spec) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: spec.session_id, ts, observed_model: `${id}-model` };
      yield {
        type: "message",
        session_id: spec.session_id,
        ts,
        text: "```json\n" + JSON.stringify(findings) + "\n```",
      };
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  };
  return { adapter, providerFamily: family };
}

describe("gates", () => {
  it("passes on exit 0, fails on non-zero", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "claudex-gate-"));
    expect((await runGate({ id: "a", command: "exit 0" }, { cwd })).status).toBe("passed");
    expect((await runGate({ id: "b", command: "exit 3" }, { cwd })).status).toBe("failed");
    expect(gatesPassed([await runGate({ id: "a", command: "exit 0" }, { cwd })])).toBe(true);
  });
});

describe("route proof", () => {
  it("verified with observed model, unverified without", () => {
    expect(
      buildRouteProof({ harness_id: "x", provider_family: "openai" }, { model_id: "gpt", evidence_source: "stream_event" }).status,
    ).toBe("verified");
    expect(buildRouteProof({ harness_id: "x", provider_family: "openai" }, {}).status).toBe("unverified");
  });
  it("cross-family needs >= 2 distinct families", () => {
    expect(verifyCrossFamily(["openai", "anthropic"]).verified).toBe(true);
    expect(verifyCrossFamily(["openai", "openai"]).verified).toBe(false);
  });
  it("classifyDiversity marks same-model fallback", () => {
    const proofs = [
      buildRouteProof({ harness_id: "a", provider_family: "openai" }, { model_id: "m", evidence_source: "stream_event" }),
      buildRouteProof({ harness_id: "b", provider_family: "anthropic" }, { model_id: "m", evidence_source: "stream_event" }),
    ];
    expect(classifyDiversity(proofs).every((p) => p.status === "same_model_fallback")).toBe(true);
  });
});

describe("findings", () => {
  it("parses fenced json then dedupes keeping most severe", () => {
    const text =
      "```json\n" +
      JSON.stringify([
        { severity: "WARN", category: "correctness", claim: "x", evidence: { files: [{ path: "a.ts" }] } },
        { severity: "BLOCK", category: "correctness", claim: "x", evidence: { files: [{ path: "a.ts" }] } },
      ]) +
      "\n```";
    const parsed = parseFindings(text, { harness_id: "r" });
    expect(parsed.length).toBe(2);
    const deduped = dedupeFindings(parsed);
    expect(deduped.length).toBe(1);
    expect(deduped[0]?.severity).toBe("BLOCK");
  });
});

describe("revalidate", () => {
  it("drops evidence-free BLOCK to insufficient_evidence; accepts with evidence", async () => {
    const noEvidence = ReviewFinding.parse({
      id: "f1",
      severity: "BLOCK",
      category: "correctness",
      claim: "x",
      reviewer: { harness_id: "r" },
    });
    const withEvidence = ReviewFinding.parse({
      id: "f2",
      severity: "BLOCK",
      category: "correctness",
      claim: "x",
      evidence: { files: [{ path: "a.ts", lines: "1" }] },
      reviewer: { harness_id: "r" },
    });
    const [a, b] = await revalidateFindings([noEvidence, withEvidence]);
    expect(a?.status).toBe("insufficient_evidence");
    expect(b?.status).toBe("accepted");
  });
});

describe("convergence", () => {
  const predicate = ConvergencePredicate.parse({});
  it("not converged with an open accepted BLOCK", () => {
    const f = ReviewFinding.parse({
      id: "f",
      severity: "BLOCK",
      status: "accepted",
      category: "correctness",
      claim: "x",
      evidence: { files: [{ path: "a.ts", lines: "1" }] },
      reviewer: { harness_id: "r" },
    });
    const r = evaluateConvergence({ predicate, gates: [], findings: [f], finalReviewClean: true, diffStableAfterReview: true });
    expect(r.converged).toBe(false);
    expect(r.openBlockers.length).toBe(1);
  });
  it("converged when gates pass, no blockers, fresh clean review", () => {
    const r = evaluateConvergence({
      predicate,
      gates: [{ id: "t", command: "test", exit_code: 0, status: "passed", duration_ms: 1, required: true }],
      findings: [],
      finalReviewClean: true,
      diffStableAfterReview: true,
    });
    expect(r.converged).toBe(true);
  });
});

describe("readiness", () => {
  it("detects a stall after a repeated failure signature", () => {
    const ledger = new ReadinessLedger();
    const sig = failureSignature(["tests failing"]);
    ledger.recordRound(sig, "x");
    expect(ledger.isStalled(sig)).toBe(false);
    ledger.recordRound(sig, "x");
    expect(ledger.isStalled(sig)).toBe(true);
    expect(ledger.rounds()).toBe(2);
  });
});

describe("reviewEngine", () => {
  it("cross-family review aggregates findings and verifies diversity", async () => {
    const r1 = makeReviewer("rev-openai", "openai", [
      { severity: "FIX_FIRST", category: "correctness", claim: "bug A", evidence: { files: [{ path: "a.ts", lines: "3" }] } },
    ]);
    const r2 = makeReviewer("rev-anthropic", "anthropic", [
      { severity: "WARN", category: "maintainability", claim: "nit B", evidence: { files: [{ path: "b.ts" }] } },
    ]);
    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a a",
      evidenceDir: "/tmp/x",
      cwd: "/tmp",
      reviewers: [r1, r2],
    });
    expect(res.crossFamilyVerified).toBe(true);
    expect(res.distinctProviders.sort()).toEqual(["anthropic", "openai"]);
    expect(res.findings.length).toBe(2);
    expect(res.routeProofs.every((p) => p.status === "verified")).toBe(true);
  });
});
