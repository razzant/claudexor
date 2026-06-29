import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import type { ProviderFamily } from "@claudexor/schema";
import { ConformanceReport, ConvergencePredicate, HarnessManifest, ReviewFinding } from "@claudexor/schema";
import { evaluateConvergence } from "./convergence.js";
import { dedupeFindings, parseFindingsDetailed } from "./findings.js";
import { gatesPassed, runGate } from "./gates.js";
import { ReadinessLedger, failureSignature } from "./readiness.js";
import { revalidateFindings } from "./revalidate.js";
import { type ReviewerSpec, reviewCandidate } from "./reviewEngine.js";
import { buildRouteProof, classifyDiversity } from "./route.js";

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

function sameObservedModelReviewer(id: string, family: ProviderFamily, findings: unknown[], observedModel: string): ReviewerSpec {
  const spec = makeReviewer(id, family, findings);
  return {
    ...spec,
    adapter: {
      ...spec.adapter,
      async *run(runSpec) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: runSpec.session_id, ts, observed_model: observedModel };
        yield {
          type: "message",
          session_id: runSpec.session_id,
          ts,
          text: "```json\n" + JSON.stringify(findings) + "\n```",
        };
        yield { type: "completed", session_id: runSpec.session_id, ts };
      },
    },
  };
}

describe("gates", () => {
  it("passes on exit 0, fails on non-zero", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "claudexor-gate-"));
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
    expect(
      buildRouteProof({ harness_id: "x", provider_family: "openai" }, { model_id: "gpt", evidence_source: "metadata" }).status,
    ).toBe("accepted_model_arg");
    expect(buildRouteProof({ harness_id: "x", provider_family: "openai" }, {}).status).toBe("unverified");
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
    const parsed = parseFindingsDetailed(text, { harness_id: "r" }).findings;
    expect(parsed.length).toBe(2);
    const deduped = dedupeFindings(parsed);
    expect(deduped.length).toBe(1);
    expect(deduped[0]?.severity).toBe("BLOCK");
  });

  it("never collapses a NEEDS_HUMAN escalation into a same-key BLOCK", () => {
    const base = { category: "correctness" as const, claim: "x", evidence: { files: [{ path: "a.ts" }] } };
    const findings = [
      ReviewFinding.parse({ id: "h", severity: "NEEDS_HUMAN", reviewer: { harness_id: "a" }, ...base }),
      ReviewFinding.parse({ id: "b", severity: "BLOCK", reviewer: { harness_id: "b" }, ...base }),
    ];
    const deduped = dedupeFindings(findings);
    expect(deduped.some((f) => f.severity === "NEEDS_HUMAN")).toBe(true);
    expect(deduped.some((f) => f.severity === "BLOCK")).toBe(true);
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
    expect(res.crossFamilyHealthy).toBe(true);
    expect(res.healthyProviders.sort()).toEqual(["anthropic", "openai"]);
    expect(res.crossFamilyVerified).toBe(true);
    expect(res.distinctProviders.sort()).toEqual(["anthropic", "openai"]);
    expect(res.findings.length).toBe(2);
    expect(res.routeProofs.every((p) => p.status === "verified")).toBe(true);
  });

  it("records malformed reviewer output as insufficient evidence", async () => {
    const adapter: HarnessAdapter = {
      id: "bad-reviewer",
      async discover() {
        return HarnessManifest.parse({
          id: "bad-reviewer",
          display_name: "bad",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({ harness_id: "bad-reviewer", status: "ok", enabled_intents: ["review"] });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        yield { type: "message", session_id: spec.session_id, ts, text: "not json", observed_model: "bad-model" };
      },
    };
    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a a",
      evidenceDir: "/tmp/x",
      cwd: "/tmp",
      reviewers: [{ adapter, providerFamily: "openai" }],
    });
    expect(res.findings[0]?.severity).toBe("INSUFFICIENT_EVIDENCE");
    expect(res.findings[0]?.status).toBe("insufficient_evidence");
  });

  it("redacts reviewer failures before writing findings or parse-error artifacts", async () => {
    const token = "sk-" + "a".repeat(24);
    const artifactsDir = mkdtempSync(join(tmpdir(), "claudexor-review-artifacts-"));
    const adapter: HarnessAdapter = {
      id: "throwing-reviewer",
      async discover() {
        return HarnessManifest.parse({
          id: "throwing-reviewer",
          display_name: "throwing",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({ harness_id: "throwing-reviewer", status: "ok", enabled_intents: ["review"] });
      },
      async *run() {
        throw new Error(`auth failed with ${token}`);
      },
    };
    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a a",
      evidenceDir: "/tmp/x",
      cwd: "/tmp",
      reviewers: [{ adapter, providerFamily: "openai" }],
      artifactsDir,
      transientRetryPolicy: { maxRetries: 2, initialDelayMs: 0, maxDelayMs: 0 },
    });
    expect(res.findings[0]?.claim).not.toContain(token);
    expect(res.findings[0]?.claim).toContain("[redacted]");
    const parseError = readFileSync(join(artifactsDir, "01-throwing-reviewer", "parse-error.json"), "utf8");
    expect(parseError).not.toContain(token);
    expect(parseError).toContain("[redacted]");
  });

  it("times out a stalled reviewer and forwards abort to the adapter", async () => {
    let aborted = false;
    const artifactsDir = mkdtempSync(join(tmpdir(), "claudexor-review-artifacts-"));
    const adapter: HarnessAdapter = {
      id: "stalled-reviewer",
      async discover() {
        return HarnessManifest.parse({
          id: "stalled-reviewer",
          display_name: "stalled",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({ harness_id: "stalled-reviewer", status: "ok", enabled_intents: ["review"] });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts, observed_model: "stalled-model" };
        const signal = spec.extra["abortSignal"] as AbortSignal | undefined;
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            aborted = true;
            resolve();
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        });
      },
    };
    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a a",
      evidenceDir: "/tmp/x",
      cwd: "/tmp",
      reviewers: [{ adapter, providerFamily: "openai" }],
      reviewerTimeoutMs: 20,
      artifactsDir,
    });
    expect(aborted).toBe(true);
    expect(res.findings[0]?.severity).toBe("INSUFFICIENT_EVIDENCE");
    expect(res.findings[0]?.claim).toContain("timed out");
    expect(res.routeProofs[0]?.status).toBe("verified");
    expect(res.routeProofs[0]?.observed.model_id).toBe("stalled-model");
    expect(existsSync(join(artifactsDir, "reviewer-progress.jsonl"))).toBe(true);
    const metadata = readFileSync(join(artifactsDir, "01-stalled-reviewer", "metadata.json"), "utf8");
    expect(metadata).toContain("timed_out");
    expect(metadata).toContain("stalled-model");
  });

  it("retries a reviewer once it emits typed transient failure with no output", async () => {
    let calls = 0;
    const artifactsDir = mkdtempSync(join(tmpdir(), "claudexor-review-artifacts-"));
    const adapter: HarnessAdapter = {
      id: "transient-reviewer",
      async discover() {
        return HarnessManifest.parse({
          id: "transient-reviewer",
          display_name: "transient",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({ harness_id: "transient-reviewer", status: "ok", enabled_intents: ["review"] });
      },
      async *run(spec) {
        calls += 1;
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts, observed_model: "transient-reviewer-model" };
        if (calls === 1) {
          yield { type: "error", session_id: spec.session_id, ts, error: "stream disconnected", transient: { kind: "stream_disconnect", retry_delay_ms: 0 } };
          yield { type: "completed", session_id: spec.session_id, ts };
          return;
        }
        yield { type: "message", session_id: spec.session_id, ts, text: "```json\n[]\n```" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a a",
      evidenceDir: "/tmp/x",
      cwd: "/tmp",
      reviewers: [{ adapter, providerFamily: "openai" }],
      artifactsDir,
    });
    expect(calls).toBe(2);
    expect(res.findings).toEqual([]);
    expect(res.routeProofs[0]?.status).toBe("verified");
    expect(readFileSync(join(artifactsDir, "01-transient-reviewer", "metadata.json"), "utf8")).toContain("transient_retry");
  });

  it("uses file-backed patch evidence instead of embedding the full diff prompt", async () => {
    let prompt = "";
    const secretDiffLine = "+UNIQUE_REVIEW_BODY_SHOULD_NOT_BE_IN_PROMPT";
    const evidenceDir = mkdtempSync(join(tmpdir(), "claudexor-review-evidence-"));
    const artifactsDir = mkdtempSync(join(tmpdir(), "claudexor-review-artifacts-"));
    const adapter: HarnessAdapter = {
      id: "file-backed-reviewer",
      async discover() {
        return HarnessManifest.parse({
          id: "file-backed-reviewer",
          display_name: "file-backed",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({ harness_id: "file-backed-reviewer", status: "ok", enabled_intents: ["review"] });
      },
      async *run(spec) {
        prompt = spec.prompt;
        const ts = new Date().toISOString();
        yield { type: "message", session_id: spec.session_id, ts, observed_model: "file-backed-model", text: "[]\n" };
      },
    };
    await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: ["diff --git a/a.ts b/a.ts", "@@ -1 +1 @@", secretDiffLine].join("\n"),
      evidenceDir,
      artifactsDir,
      cwd: "/tmp",
      reviewers: [{ adapter, providerFamily: "openai" }],
    });
    expect(prompt).toContain("DIFF.patch");
    expect(prompt).not.toContain(secretDiffLine);
    expect(readFileSync(join(evidenceDir, "DIFF.patch"), "utf8")).toContain(secretDiffLine);
    expect(readFileSync(join(artifactsDir, "evidence", "DIFF.patch"), "utf8")).toContain(secretDiffLine);
    expect(readFileSync(join(artifactsDir, "01-file-backed-reviewer", "metadata.json"), "utf8")).toContain("persistent_diff_path");
    expect(readFileSync(join(artifactsDir, "01-file-backed-reviewer", "raw-normalized-stream.jsonl"), "utf8")).toContain("file-backed-model");
    expect(readFileSync(join(artifactsDir, "01-file-backed-reviewer", "parsed-json-blocks.json"), "utf8")).toContain("[]");
  });

  it("does not count malformed JSON arrays as healthy clean review", async () => {
    const r1 = makeReviewer("rev-openai", "openai", [1]);
    const r2 = makeReviewer("rev-anthropic", "anthropic", [1]);
    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a a",
      evidenceDir: "/tmp/x",
      cwd: "/tmp",
      reviewers: [r1, r2],
    });
    expect(res.crossFamilyHealthy).toBe(false);
    expect(res.crossFamilyVerified).toBe(true);
    expect(res.findings.length).toBeGreaterThan(0);
    expect(res.findings.every((f) => f.severity === "INSUFFICIENT_EVIDENCE")).toBe(true);
  });

  it("keeps route proof verification false when models are not observed", async () => {
    const r1 = makeReviewer("rev-openai", "openai", []);
    const r2 = makeReviewer("rev-anthropic", "anthropic", []);
    const stripObserved = (r: ReviewerSpec): ReviewerSpec => ({
      ...r,
      adapter: {
        ...r.adapter,
        async *run(spec) {
          const ts = new Date().toISOString();
          yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
        },
      },
    });
    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a a",
      evidenceDir: "/tmp/x",
      cwd: "/tmp",
      reviewers: [stripObserved(r1), stripObserved(r2)],
    });
    expect(res.crossFamilyHealthy).toBe(true);
    expect(res.healthyProviders.sort()).toEqual(["anthropic", "openai"]);
    expect(res.crossFamilyVerified).toBe(false);
    expect(res.distinctProviders).toEqual([]);
    expect(res.routeProofs.every((p) => p.status === "unverified")).toBe(true);
  });

  it("RR1: argv-echo (accepted_model_arg) does NOT satisfy crossFamilyVerified", async () => {
    // Reviewers that accepted an explicit model arg but never echoed an observed
    // model in the stream → metadata-tier proof. It must not unblock apply.
    const argvEcho = (id: string, family: ProviderFamily): ReviewerSpec => {
      const spec = makeReviewer(id, family, []);
      return {
        ...spec,
        requestedModel: `${id}-model`,
        adapter: {
          ...spec.adapter,
          async *run(runSpec) {
            const ts = new Date().toISOString();
            yield { type: "message", session_id: runSpec.session_id, ts, text: "[]\n" };
          },
        },
      };
    };
    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a a",
      evidenceDir: "/tmp/x",
      cwd: "/tmp",
      reviewers: [argvEcho("rev-openai", "openai"), argvEcho("rev-anthropic", "anthropic")],
    });
    expect(res.routeProofs.every((p) => p.status === "accepted_model_arg")).toBe(true);
    expect(res.crossFamilyVerified).toBe(false);
    expect(res.distinctProviders).toEqual([]);
  });

  it("keeps per-finding route proof status aligned with same-model fallback classification", async () => {
    const findings = [
      { severity: "WARN", category: "correctness", claim: "same model route", evidence: { files: [{ path: "a.ts", lines: "1" }] } },
    ];
    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a a",
      evidenceDir: "/tmp/x",
      cwd: "/tmp",
      reviewers: [
        sameObservedModelReviewer("rev-openai", "openai", findings, "shared-model"),
        sameObservedModelReviewer("rev-anthropic", "anthropic", findings, "shared-model"),
      ],
    });
    expect(res.crossFamilyHealthy).toBe(true);
    expect(res.crossFamilyVerified).toBe(false);
    expect(res.routeProofs.every((p) => p.status === "same_model_fallback")).toBe(true);
    expect(res.findings.every((f) => f.reviewer.route_proof_status === "same_model_fallback")).toBe(true);
  });
});
