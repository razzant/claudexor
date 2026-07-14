import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import type { ProviderFamily } from "@claudexor/schema";
import {
  ConformanceReport,
  ConvergencePredicate,
  HarnessManifest,
  ReviewFinding,
  RunEventType,
} from "@claudexor/schema";
import { evaluateConvergence } from "./convergence.js";
import { dedupeFindings, extractJsonBlocks, parseFindingsDetailed } from "./findings.js";
import { gatesPassed, runGate } from "./gates.js";
import { ReadinessLedger, failureSignature } from "./readiness.js";
import { revalidateFindings } from "./revalidate.js";
import { type ReviewerProgressEvent, type ReviewerSpec, reviewCandidate } from "./reviewEngine.js";
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

function makeReviewWorkspace(prefix = "claudexor-review-candidate-"): {
  cwd: string;
  evidenceDir: string;
} {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  const evidenceDir = join(cwd, ".claudexor-review-evidence");
  mkdirSync(evidenceDir, { recursive: true });
  writeMandatoryReviewEvidence(evidenceDir);
  return { cwd, evidenceDir };
}

function writeMandatoryReviewEvidence(evidenceDir: string): void {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, "USER_INTENT.md"), "review candidate\n");
  writeFileSync(join(evidenceDir, "FORBIDDEN_FINDINGS.md"), "(none)\n");
  writeFileSync(join(evidenceDir, "PLAN_ACCEPTED.md"), "(none)\n");
  writeFileSync(join(evidenceDir, "TESTS.txt"), "(tests not run)\n");
  writeFileSync(join(evidenceDir, "DECIDED_TRADEOFFS.md"), "(none)\n");
}

describe("reviewer progress event schema contract", () => {
  it("keeps every reviewer progress event type accepted by RunEventType", () => {
    const reviewerEventTypes: ReviewerProgressEvent["type"][] = [
      "reviewer.started",
      "reviewer.first_event",
      "reviewer.auth_switched",
      "reviewer.completed",
      "reviewer.timed_out",
      "reviewer.failed",
    ];

    for (const type of reviewerEventTypes) {
      expect(RunEventType.options).toContain(type);
    }
  });
});

function sameObservedModelReviewer(
  id: string,
  family: ProviderFamily,
  findings: unknown[],
  observedModel: string,
): ReviewerSpec {
  const spec = makeReviewer(id, family, findings);
  return {
    ...spec,
    adapter: {
      ...spec.adapter,
      async *run(runSpec) {
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: runSpec.session_id,
          ts,
          observed_model: observedModel,
        };
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
    const passed = await runGate({ id: "a", command: "printf 'ok\\n'" }, { cwd });
    const failed = await runGate(
      { id: "b", command: "printf 'out\\n'; printf 'err\\n' >&2; exit 3" },
      { cwd },
    );
    expect(passed.status).toBe("passed");
    expect(passed.stdout_tail).toBe(null);
    expect(failed.status).toBe("failed");
    expect(failed.stdout_tail).toBe("out");
    expect(failed.stderr_tail).toBe("err");
    expect(failed.output_truncated).toBe(false);
    expect(gatesPassed([await runGate({ id: "a", command: "exit 0" }, { cwd })])).toBe(true);
  });

  it("marks gate output truncated only when the stored redacted tail is sliced", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "claudexor-gate-trim-"));
    const failed = await runGate(
      {
        id: "trimmed",
        command: "printf 'kept'; printf '%13000s' ''; exit 3",
      },
      { cwd },
    );
    expect(failed.status).toBe("failed");
    expect(failed.stdout_tail).toBe("kept");
    expect(failed.output_truncated).toBe(false);
  });
});

describe("route proof", () => {
  it("verified with observed model, unverified without", () => {
    expect(
      buildRouteProof(
        { harness_id: "x", provider_family: "openai" },
        { model_id: "gpt", evidence_source: "stream_event" },
      ).status,
    ).toBe("verified");
    expect(
      buildRouteProof(
        { harness_id: "x", provider_family: "openai" },
        { model_id: "gpt", evidence_source: "metadata" },
      ).status,
    ).toBe("accepted_model_arg");
    expect(buildRouteProof({ harness_id: "x", provider_family: "openai" }, {}).status).toBe(
      "unverified",
    );
  });
  it("classifyDiversity marks same-model fallback", () => {
    const proofs = [
      buildRouteProof(
        { harness_id: "a", provider_family: "openai" },
        { model_id: "m", evidence_source: "stream_event" },
      ),
      buildRouteProof(
        { harness_id: "b", provider_family: "anthropic" },
        { model_id: "m", evidence_source: "stream_event" },
      ),
    ];
    expect(classifyDiversity(proofs).every((p) => p.status === "same_model_fallback")).toBe(true);
  });
  it("classifyDiversity keeps repeated same-family model samples verified", () => {
    const proofs = [
      buildRouteProof(
        { harness_id: "cursor", provider_family: "cursor", model_hint: "m" },
        { model_id: "m", evidence_source: "stream_event" },
      ),
      buildRouteProof(
        { harness_id: "cursor", provider_family: "cursor", model_hint: "m" },
        { model_id: "m", evidence_source: "stream_event" },
      ),
    ];
    expect(classifyDiversity(proofs).map((p) => p.status)).toEqual(["verified", "verified"]);
  });
  it("classifyDiversity flags same-family distinct requested models that collapse to one observed model", () => {
    const proofs = [
      buildRouteProof(
        { harness_id: "cursor", provider_family: "cursor", model_hint: "gemini-3.1-pro" },
        { model_id: "Gemini Pro", evidence_source: "stream_event" },
      ),
      buildRouteProof(
        { harness_id: "cursor", provider_family: "cursor", model_hint: "gemini-3.5-flash" },
        { model_id: "Gemini Pro", evidence_source: "stream_event" },
      ),
    ];
    expect(classifyDiversity(proofs).map((p) => p.status)).toEqual([
      "same_model_fallback",
      "same_model_fallback",
    ]);
  });
  it("classifyDiversity still labels unknown-family model collapse", () => {
    const proofs = [
      buildRouteProof(
        { harness_id: "x", provider_family: "unknown", model_hint: "a" },
        { model_id: "shared", evidence_source: "stream_event" },
      ),
      buildRouteProof(
        { harness_id: "y", provider_family: "unknown", model_hint: "b" },
        { model_id: "shared", evidence_source: "stream_event" },
      ),
    ];
    expect(classifyDiversity(proofs).map((p) => p.status)).toEqual([
      "same_model_fallback",
      "same_model_fallback",
    ]);
  });
});

describe("findings", () => {
  it("parses fenced json then dedupes keeping most severe", () => {
    const text =
      "```json\n" +
      JSON.stringify([
        {
          severity: "WARN",
          category: "correctness",
          claim: "x",
          evidence: { files: [{ path: "a.ts" }] },
        },
        {
          severity: "BLOCK",
          category: "correctness",
          claim: "x",
          evidence: { files: [{ path: "a.ts" }] },
        },
      ]) +
      "\n```";
    const parsed = parseFindingsDetailed(text, { harness_id: "r" }).findings;
    expect(parsed.length).toBe(2);
    const deduped = dedupeFindings(parsed);
    expect(deduped.length).toBe(1);
    expect(deduped[0]?.severity).toBe("BLOCK");
  });

  it("parses a standalone bare json line before later reviewer prose", () => {
    const parsed = parseFindingsDetailed("[]\nreview notes after the JSON block []", {
      harness_id: "r",
    });
    expect(parsed).toEqual({ findings: [], malformed: 0 });
  });

  it("extracts a final pretty bare JSON array without suffix rejoining every log line", () => {
    const noisyLines = Array.from({ length: 200 }, (_, i) => `{not json ${i}}`);
    const text = [
      "reviewer notes",
      ...noisyLines,
      "[",
      '  {"severity":"NIT","category":"maintainability","claim":"x","evidence":{"files":[]}}',
      "]",
    ].join("\n");

    expect(extractJsonBlocks(text)).toEqual([
      [
        {
          severity: "NIT",
          category: "maintainability",
          claim: "x",
          evidence: { files: [] },
        },
      ],
    ]);
  });

  it("does not promote standalone illustrative json object lines from prose", () => {
    const parsed = parseFindingsDetailed('notes\n{"claim":"example only"}\nmore notes', {
      harness_id: "r",
    });
    expect(parsed).toEqual({ findings: [], malformed: 0 });
  });

  it("ignores fenced standalone objects and still extracts a later review array", () => {
    const text = [
      "```json",
      '{"claim":"example only"}',
      "```",
      "reviewer notes",
      "[",
      '  {"severity":"WARN","category":"correctness","claim":"real finding","evidence":{"files":[{"path":"x.ts"}]}}',
      "]",
    ].join("\n");
    const parsed = parseFindingsDetailed(text, { harness_id: "r" });
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.claim).toBe("real finding");
    expect(parsed.malformed).toBe(0);
  });

  it("never collapses a NEEDS_HUMAN escalation into a same-key BLOCK", () => {
    const base = {
      category: "correctness" as const,
      claim: "x",
      evidence: { files: [{ path: "a.ts" }] },
    };
    const findings = [
      ReviewFinding.parse({
        id: "h",
        severity: "NEEDS_HUMAN",
        reviewer: { harness_id: "a" },
        ...base,
      }),
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

  it("rejects reviewer file evidence paths outside candidate and evidence roots", async () => {
    const candidateRoot = mkdtempSync(join(tmpdir(), "claudexor-revalidate-candidate-"));
    const evidenceDir = join(candidateRoot, ".claudexor-review-evidence");
    mkdirSync(evidenceDir);
    writeFileSync(join(candidateRoot, "src.ts"), "export const ok = true;\n");
    writeFileSync(join(evidenceDir, "TESTS.txt"), "pnpm test\n");

    const absoluteOnly = ReviewFinding.parse({
      id: "abs",
      severity: "BLOCK",
      category: "security",
      claim: "absolute path should not prove a blocker",
      evidence: { files: [{ path: join(tmpdir(), "outside.ts"), lines: "1" }] },
      reviewer: { harness_id: "r" },
    });
    const traversalOnly = ReviewFinding.parse({
      id: "trav",
      severity: "FIX_FIRST",
      category: "correctness",
      claim: "sibling path should not prove a blocker",
      evidence: { logs: [{ path: "../sibling/log.txt" }] },
      reviewer: { harness_id: "r" },
    });
    const candidateFile = ReviewFinding.parse({
      id: "file",
      severity: "BLOCK",
      category: "correctness",
      claim: "candidate file evidence is valid",
      evidence: { files: [{ path: "src.ts", lines: "1" }] },
      reviewer: { harness_id: "r" },
    });
    const evidenceFile = ReviewFinding.parse({
      id: "packet",
      severity: "BLOCK",
      category: "deploy",
      claim: "evidence packet file is valid",
      evidence: { logs: [{ path: "TESTS.txt" }] },
      reviewer: { harness_id: "r" },
    });
    const absoluteCandidateFile = ReviewFinding.parse({
      id: "absolute-file",
      severity: "FIX_FIRST",
      category: "correctness",
      claim: "absolute candidate file evidence is invalid",
      evidence: { files: [{ path: join(candidateRoot, "src.ts"), lines: "1" }] },
      reviewer: { harness_id: "r" },
    });
    const absoluteEvidenceFile = ReviewFinding.parse({
      id: "absolute-packet",
      severity: "FIX_FIRST",
      category: "deploy",
      claim: "absolute evidence packet file is invalid",
      evidence: { logs: [{ path: join(evidenceDir, "TESTS.txt") }] },
      reviewer: { harness_id: "r" },
    });

    const [abs, traversal, file, packet, absoluteFile, absolutePacket] = await revalidateFindings(
      [
        absoluteOnly,
        traversalOnly,
        candidateFile,
        evidenceFile,
        absoluteCandidateFile,
        absoluteEvidenceFile,
      ],
      { candidateRoot, evidenceDir },
    );

    expect(abs?.status).toBe("insufficient_evidence");
    expect(abs?.revalidation_note).toMatch(/invalid evidence paths/);
    expect(abs?.evidence.files).toHaveLength(0);
    expect(traversal?.status).toBe("insufficient_evidence");
    expect(traversal?.evidence.logs).toHaveLength(0);
    expect(file?.status).toBe("accepted");
    expect(packet?.status).toBe("accepted");
    expect(absoluteFile?.status).toBe("insufficient_evidence");
    expect(absoluteFile?.evidence.files).toHaveLength(0);
    expect(absolutePacket?.status).toBe("insufficient_evidence");
    expect(absolutePacket?.evidence.logs).toHaveLength(0);
  });

  it("keeps non-path evidence when invalid reviewer paths are stripped", async () => {
    const candidateRoot = mkdtempSync(join(tmpdir(), "claudexor-revalidate-candidate-"));
    const withDiffEvidence = ReviewFinding.parse({
      id: "diff",
      severity: "BLOCK",
      category: "correctness",
      claim: "diff evidence can still prove the finding",
      evidence: {
        files: [{ path: "/tmp/outside.ts", lines: "1" }],
        diff_hunks: ["@@ -1 +1 @@"],
      },
      reviewer: { harness_id: "r" },
    });

    const [finding] = await revalidateFindings([withDiffEvidence], { candidateRoot });

    expect(finding?.status).toBe("accepted");
    expect(finding?.evidence.files).toHaveLength(0);
    expect(finding?.evidence.diff_hunks).toEqual(["@@ -1 +1 @@"]);
  });

  it("keeps safe relative evidence paths even when the cited path does not exist yet", async () => {
    const candidateRoot = mkdtempSync(join(tmpdir(), "claudexor-revalidate-candidate-"));
    const missingFile = ReviewFinding.parse({
      id: "missing-file",
      severity: "BLOCK",
      category: "test_gap",
      claim: "missing expected test file",
      evidence: { files: [{ path: "packages/foo/X.test.ts", lines: "missing" }] },
      reviewer: { harness_id: "r" },
    });

    const [finding] = await revalidateFindings([missingFile], { candidateRoot });

    expect(finding?.status).toBe("accepted");
    expect(finding?.evidence.files).toEqual([{ path: "packages/foo/X.test.ts", lines: "missing" }]);
  });

  it("preserves already-processed finding statuses during deterministic revalidation", async () => {
    const fixed = ReviewFinding.parse({
      id: "fixed",
      severity: "BLOCK",
      status: "fixed",
      category: "correctness",
      claim: "already fixed",
      evidence: { files: [{ path: "a.ts", lines: "1" }] },
      reviewer: { harness_id: "r" },
    });

    const [finding] = await revalidateFindings([fixed]);

    expect(finding?.status).toBe("fixed");
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
    const r = evaluateConvergence({
      predicate,
      gates: [],
      findings: [f],
      finalReviewClean: true,
      diffStableAfterReview: true,
    });
    expect(r.converged).toBe(false);
    expect(r.openBlockers.length).toBe(1);
  });
  it("converged when gates pass, no blockers, fresh clean review", () => {
    const r = evaluateConvergence({
      predicate,
      gates: [
        {
          id: "t",
          command: "test",
          exit_code: 0,
          status: "passed",
          duration_ms: 1,
          required: true,
          stdout_tail: null,
          stderr_tail: null,
          output_truncated: false,
        },
      ],
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
    // A different signature is independent — no cross-signature stall bleed.
    expect(ledger.isStalled(failureSignature(["other"]))).toBe(false);
  });
});

describe("reviewEngine", () => {
  it("cross-family review aggregates findings and verifies diversity", async () => {
    const r1 = makeReviewer("rev-openai", "openai", [
      {
        severity: "FIX_FIRST",
        category: "correctness",
        claim: "bug A",
        evidence: { files: [{ path: "a.ts", lines: "3" }] },
      },
    ]);
    const r2 = makeReviewer("rev-anthropic", "anthropic", [
      {
        severity: "WARN",
        category: "maintainability",
        claim: "nit B",
        evidence: { files: [{ path: "b.ts" }] },
      },
    ]);
    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a a",
      ...makeReviewWorkspace(),
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
        return ConformanceReport.parse({
          harness_id: "bad-reviewer",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        yield {
          type: "message",
          session_id: spec.session_id,
          ts,
          text: "not json",
          observed_model: "bad-model",
        };
      },
    };
    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a a",
      ...makeReviewWorkspace(),
      reviewers: [{ adapter, providerFamily: "openai" }],
    });
    expect(res.findings[0]?.severity).toBe("INSUFFICIENT_EVIDENCE");
    expect(res.findings[0]?.status).toBe("insufficient_evidence");
  });

  it("keeps valid findings from mixed malformed reviewer output but marks the reviewer unhealthy", async () => {
    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a x",
      ...makeReviewWorkspace(),
      reviewers: [
        makeReviewer("mixed-reviewer", "openai", [
          {
            severity: "BLOCK",
            category: "correctness",
            claim: "valid finding survives",
            evidence: { files: [{ path: "x.ts", lines: "1" }] },
          },
          1,
        ]),
        makeReviewer("clean-reviewer", "anthropic", []),
      ],
    });

    expect(res.findings.some((f) => f.claim === "valid finding survives")).toBe(true);
    expect(res.findings.some((f) => f.severity === "INSUFFICIENT_EVIDENCE")).toBe(true);
    expect(res.healthyProviders).toEqual(["anthropic"]);
    expect(res.crossFamilyHealthy).toBe(false);
    expect(res.crossFamilyVerified).toBe(false);
  });

  it("treats a bare empty findings array as parseable clean output", async () => {
    const adapter: HarnessAdapter = {
      id: "empty-json-reviewer",
      async discover() {
        return HarnessManifest.parse({
          id: "empty-json-reviewer",
          display_name: "empty",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "empty-json-reviewer",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts, observed_model: "empty-model" };
        yield { type: "message", session_id: spec.session_id, ts, text: "[]" };
        yield {
          type: "message",
          session_id: spec.session_id,
          ts,
          text: "post-review summary with another [] token",
        };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a a",
      ...makeReviewWorkspace(),
      reviewers: [{ adapter, providerFamily: "openai" }],
    });
    expect(res.findings).toEqual([]);
    expect(res.routeProofs[0]?.status).toBe("verified");
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
        return ConformanceReport.parse({
          harness_id: "throwing-reviewer",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run() {
        throw new Error(`auth failed with ${token}`);
      },
    };
    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a a",
      ...makeReviewWorkspace(),
      reviewers: [{ adapter, providerFamily: "openai" }],
      artifactsDir,
      transientRetryPolicy: { maxRetries: 2, initialDelayMs: 0, maxDelayMs: 0 },
    });
    expect(res.findings[0]?.claim).not.toContain(token);
    expect(res.findings[0]?.claim).toContain("[redacted]");
    const parseError = readFileSync(
      join(artifactsDir, "01-throwing-reviewer", "parse-error.json"),
      "utf8",
    );
    expect(parseError).not.toContain(token);
    expect(parseError).toContain("[redacted]");
  });

  it("treats reviewer error events as failed reviewer output with redacted detail", async () => {
    const token = "sk-" + "b".repeat(24);
    const artifactsDir = mkdtempSync(join(tmpdir(), "claudexor-review-artifacts-"));
    const adapter: HarnessAdapter = {
      id: "error-event-reviewer",
      async discover() {
        return HarnessManifest.parse({
          id: "error-event-reviewer",
          display_name: "error-event",
          kind: "local_cli",
          provider_family: "cursor",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "error-event-reviewer",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts, observed_model: "cursor-model" };
        yield {
          type: "error",
          session_id: spec.session_id,
          ts,
          error: `cursor-agent exited with ${token}`,
        };
      },
    };

    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a a",
      ...makeReviewWorkspace(),
      reviewers: [{ adapter, providerFamily: "cursor" }],
      artifactsDir,
      transientRetryPolicy: { maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0 },
    });

    expect(res.findings[0]?.claim).toContain("Reviewer failed:");
    expect(res.findings[0]?.claim).toContain("Reviewer emitted error event");
    expect(res.findings[0]?.claim).not.toContain(token);
    expect(res.findings[0]?.claim).toContain("[redacted]");
    expect(res.routeProofs[0]?.status).toBe("verified");
    expect(res.routeProofs[0]?.observed.model_id).toBe("cursor-model");
    const metadata = readFileSync(
      join(artifactsDir, "01-error-event-reviewer", "metadata.json"),
      "utf8",
    );
    expect(metadata).toContain('"status": "failed"');
    expect(metadata).toContain("Reviewer emitted error event");
    expect(metadata).not.toContain(token);
    const progress = readFileSync(join(artifactsDir, "reviewer-progress.jsonl"), "utf8");
    expect(progress).toContain('"type":"reviewer.failed"');
    expect(progress).not.toContain('"type":"reviewer.completed"');
    const parseError = readFileSync(
      join(artifactsDir, "01-error-event-reviewer", "parse-error.json"),
      "utf8",
    );
    expect(parseError).toContain("Reviewer emitted error event");
    expect(parseError).not.toContain(token);
  });

  it("times out a stalled reviewer and forwards abort to the adapter", async () => {
    let childSignal: AbortSignal | undefined;
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
        return ConformanceReport.parse({
          harness_id: "stalled-reviewer",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        yield { type: "started", session_id: spec.session_id, ts, observed_model: "stalled-model" };
        const signal = spec.extra["abortSignal"] as AbortSignal | undefined;
        childSignal = signal;
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a a",
      ...makeReviewWorkspace(),
      reviewers: [{ adapter, providerFamily: "openai" }],
      reviewerTimeoutMs: 20,
      artifactsDir,
    });
    expect(childSignal?.aborted).toBe(true);
    expect(res.findings[0]?.severity).toBe("INSUFFICIENT_EVIDENCE");
    expect(res.findings[0]?.claim).toContain("timed out");
    expect(res.routeProofs[0]?.status).toBe("verified");
    expect(res.routeProofs[0]?.observed.model_id).toBe("stalled-model");
    expect(existsSync(join(artifactsDir, "reviewer-progress.jsonl"))).toBe(true);
    const metadata = readFileSync(
      join(artifactsDir, "01-stalled-reviewer", "metadata.json"),
      "utf8",
    );
    expect(metadata).toContain("timed_out");
    expect(metadata).toContain("stalled-model");
  });

  it("cancels an active reviewer immediately when the parent run signal aborts", async () => {
    let childSignal: AbortSignal | undefined;
    let secondStarted = false;
    const artifactsDir = mkdtempSync(join(tmpdir(), "claudexor-review-artifacts-"));
    const parent = new AbortController();
    const stalled: HarnessAdapter = {
      id: "cancelled-reviewer",
      async discover() {
        return HarnessManifest.parse({
          id: "cancelled-reviewer",
          display_name: "cancelled",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "cancelled-reviewer",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        const signal = spec.extra["abortSignal"] as AbortSignal | undefined;
        childSignal = signal;
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: "cancelled-model",
        };
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    const second: HarnessAdapter = {
      id: "second-reviewer",
      async discover() {
        return HarnessManifest.parse({
          id: "second-reviewer",
          display_name: "second",
          kind: "local_cli",
          provider_family: "anthropic",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "second-reviewer",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run() {
        secondStarted = true;
        yield { type: "message", session_id: "s", ts: new Date().toISOString(), text: "[]" };
      },
    };
    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a a",
      ...makeReviewWorkspace(),
      reviewers: [
        { adapter: stalled, providerFamily: "openai" },
        { adapter: second, providerFamily: "anthropic" },
      ],
      reviewerTimeoutMs: 30_000,
      artifactsDir,
      signal: parent.signal,
      onReviewerEvent: (event) => {
        if (event.type === "reviewer.first_event") parent.abort();
      },
    });
    expect(childSignal?.aborted).toBe(true);
    expect(secondStarted).toBe(false);
    expect(res.findings[0]?.severity).toBe("INSUFFICIENT_EVIDENCE");
    expect(res.findings[0]?.claim).toContain("Reviewer failed: Reviewer cancelled");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const progress = readFileSync(join(artifactsDir, "reviewer-progress.jsonl"), "utf8");
    expect(progress).toContain("reviewer.failed");
    expect(progress).toContain("Reviewer cancelled");
    expect(progress).not.toContain("reviewer.completed");
    const metadata = readFileSync(
      join(artifactsDir, "01-cancelled-reviewer", "metadata.json"),
      "utf8",
    );
    expect(metadata).toContain('"status": "failed"');
    expect(metadata).toContain("Reviewer cancelled");
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
        return ConformanceReport.parse({
          harness_id: "transient-reviewer",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        calls += 1;
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: "transient-reviewer-model",
        };
        if (calls === 1) {
          yield {
            type: "error",
            session_id: spec.session_id,
            ts,
            error: "stream disconnected",
            transient: { kind: "stream_disconnect", retry_delay_ms: 0 },
          };
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
      ...makeReviewWorkspace(),
      reviewers: [{ adapter, providerFamily: "openai" }],
      artifactsDir,
    });
    expect(calls).toBe(2);
    expect(res.findings).toEqual([]);
    expect(res.routeProofs[0]?.status).toBe("verified");
    expect(
      readFileSync(join(artifactsDir, "01-transient-reviewer", "metadata.json"), "utf8"),
    ).toContain("transient_retry");
  });

  it("does not carry route proof from a failed transient reviewer try into the successful retry", async () => {
    let calls = 0;
    const adapter: HarnessAdapter = {
      id: "transient-unobserved-retry",
      async discover() {
        return HarnessManifest.parse({
          id: "transient-unobserved-retry",
          display_name: "transient",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "transient-unobserved-retry",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        calls += 1;
        const ts = new Date().toISOString();
        if (calls === 1) {
          yield {
            type: "started",
            session_id: spec.session_id,
            ts,
            observed_model: "failed-try-model",
          };
          yield {
            type: "error",
            session_id: spec.session_id,
            ts,
            error: "stream disconnected",
            transient: { kind: "stream_disconnect", retry_delay_ms: 0 },
          };
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
      ...makeReviewWorkspace(),
      reviewers: [{ adapter, providerFamily: "openai" }],
      transientRetryPolicy: { maxRetries: 2, initialDelayMs: 0, maxDelayMs: 0 },
    });
    expect(calls).toBe(2);
    expect(res.routeProofs[0]?.status).toBe("unverified");
    expect(res.routeProofs[0]?.observed.model_id).toBeNull();
  });

  it("uses file-backed patch evidence instead of embedding the full diff prompt", async () => {
    let prompt = "";
    let reviewerCwd = "";
    const secretDiffLine = "+UNIQUE_REVIEW_BODY_SHOULD_NOT_BE_IN_PROMPT";
    const evidenceDir = mkdtempSync(join(tmpdir(), "claudexor-review-evidence-"));
    const artifactsDir = mkdtempSync(join(tmpdir(), "claudexor-review-artifacts-"));
    const candidateRoot = mkdtempSync(join(tmpdir(), "claudexor-candidate-root-"));
    writeFileSync(join(evidenceDir, "USER_INTENT.md"), "review the candidate\n");
    writeFileSync(join(evidenceDir, "FORBIDDEN_FINDINGS.md"), "(none)\n");
    writeFileSync(join(evidenceDir, "PLAN_ACCEPTED.md"), "(none)\n");
    writeFileSync(join(evidenceDir, "DIFF.patch"), "placeholder\n");
    writeFileSync(join(evidenceDir, "TESTS.txt"), "pnpm test\n");
    writeFileSync(join(evidenceDir, "DECIDED_TRADEOFFS.md"), "do not rerun full gates\n");
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
        return ConformanceReport.parse({
          harness_id: "file-backed-reviewer",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        prompt = spec.prompt;
        reviewerCwd = spec.cwd;
        const ts = new Date().toISOString();
        yield {
          type: "message",
          session_id: spec.session_id,
          ts,
          observed_model: "file-backed-model",
          text: "[]\n",
        };
      },
    };
    await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: ["diff --git a/a.ts b/a.ts", "@@ -1 +1 @@", secretDiffLine].join("\n"),
      evidenceDir,
      artifactsDir,
      cwd: candidateRoot,
      reviewers: [{ adapter, providerFamily: "openai" }],
    });
    expect(prompt).toContain("DIFF.patch");
    expect(reviewerCwd).not.toBe(candidateRoot);
    expect(prompt).toContain(`Candidate root: ${reviewerCwd}.`);
    expect(prompt).toContain(
      "Do not inspect or cite sibling/base repository paths outside Candidate root",
    );
    expect(prompt).toContain("Do not cite absolute Candidate root");
    expect(prompt).toContain("Treat TESTS.txt as the gate evidence");
    expect(prompt).not.toContain(secretDiffLine);
    expect(readFileSync(join(evidenceDir, "DIFF.patch"), "utf8")).toContain(secretDiffLine);
    expect(readFileSync(join(artifactsDir, "evidence", "DIFF.patch"), "utf8")).toContain(
      secretDiffLine,
    );
    expect(readFileSync(join(artifactsDir, "evidence", "USER_INTENT.md"), "utf8")).toContain(
      "review the candidate",
    );
    expect(readFileSync(join(artifactsDir, "evidence", "TESTS.txt"), "utf8")).toContain(
      "pnpm test",
    );
    expect(readFileSync(join(artifactsDir, "evidence", "metadata.json"), "utf8")).toContain(
      candidateRoot,
    );
    const metadata = readFileSync(
      join(artifactsDir, "01-file-backed-reviewer", "metadata.json"),
      "utf8",
    );
    expect(metadata).toContain("persistent_diff_path");
    expect(metadata).toContain(candidateRoot);
    expect(metadata).toContain(reviewerCwd);
    expect(
      readFileSync(join(artifactsDir, "01-file-backed-reviewer", "prompt.md"), "utf8"),
    ).toContain(`source_candidate_root: ${candidateRoot}`);
    expect(
      readFileSync(join(artifactsDir, "01-file-backed-reviewer", "prompt.md"), "utf8"),
    ).toContain(`candidate_root: ${reviewerCwd}`);
    expect(
      readFileSync(
        join(artifactsDir, "01-file-backed-reviewer", "raw-normalized-stream.jsonl"),
        "utf8",
      ),
    ).toContain("file-backed-model");
    expect(
      readFileSync(
        join(artifactsDir, "01-file-backed-reviewer", "parsed-json-blocks.json"),
        "utf8",
      ),
    ).toContain("[]");
  });

  it("refuses secret-like diff evidence before starting reviewers", async () => {
    let reviewerStarted = false;
    const evidenceDir = mkdtempSync(join(tmpdir(), "claudexor-review-evidence-"));
    const artifactsDir = mkdtempSync(join(tmpdir(), "claudexor-review-artifacts-"));
    const candidateRoot = mkdtempSync(join(tmpdir(), "claudexor-candidate-root-"));
    writeMandatoryReviewEvidence(evidenceDir);
    const fakeKey = "sk-" + "abcdefghijklmnopqrstuvwxyz";
    const adapter: HarnessAdapter = {
      id: "secret-diff-reviewer",
      async discover() {
        return HarnessManifest.parse({
          id: "secret-diff-reviewer",
          display_name: "secret diff reviewer",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "secret-diff-reviewer",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run() {
        reviewerStarted = true;
      },
    };

    await expect(
      reviewCandidate({
        candidateLabel: "Candidate A",
        diff: `diff --git a/.env b/.env\n@@ -1 +1 @@\n-OLD=1\n+OPENAI_API_KEY=${fakeKey}\n`,
        evidenceDir,
        artifactsDir,
        cwd: candidateRoot,
        reviewers: [{ adapter, providerFamily: "openai" }],
      }),
    ).rejects.toThrow(/refusing to persist raw DIFF\.patch/);
    expect(reviewerStarted).toBe(false);
    expect(existsSync(join(evidenceDir, "DIFF.patch"))).toBe(false);
    expect(existsSync(join(artifactsDir, "evidence", "DIFF.patch"))).toBe(false);
  });

  it("redacts secret-like prose evidence before persistent artifacts and reviewer workspaces", async () => {
    let reviewerEvidence = "";
    const evidenceDir = mkdtempSync(join(tmpdir(), "claudexor-review-evidence-"));
    const artifactsDir = mkdtempSync(join(tmpdir(), "claudexor-review-artifacts-"));
    const candidateRoot = mkdtempSync(join(tmpdir(), "claudexor-candidate-root-"));
    writeMandatoryReviewEvidence(evidenceDir);
    const fakeKey = "sk-" + "abcdefghijklmnopqrstuvwxyz";
    writeFileSync(join(evidenceDir, "USER_INTENT.md"), `review prose ${fakeKey}\n`);
    const adapter: HarnessAdapter = {
      id: "prose-redaction-reviewer",
      async discover() {
        return HarnessManifest.parse({
          id: "prose-redaction-reviewer",
          display_name: "prose redaction reviewer",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "prose-redaction-reviewer",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        reviewerEvidence = readFileSync(
          join(spec.cwd, ".claudexor-review-evidence", "USER_INTENT.md"),
          "utf8",
        );
        const ts = new Date().toISOString();
        yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
      },
    };

    await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      evidenceDir,
      artifactsDir,
      cwd: candidateRoot,
      reviewers: [{ adapter, providerFamily: "openai" }],
    });

    const persistentEvidence = readFileSync(
      join(artifactsDir, "evidence", "USER_INTENT.md"),
      "utf8",
    );
    expect(readFileSync(join(evidenceDir, "USER_INTENT.md"), "utf8")).toContain(fakeKey);
    expect(persistentEvidence).toContain("[redacted]");
    expect(persistentEvidence).not.toContain(fakeKey);
    expect(reviewerEvidence).toContain("[redacted]");
    expect(reviewerEvidence).not.toContain(fakeKey);
  });

  it("fails closed on incomplete mandatory evidence before starting reviewers", async () => {
    let reviewerStarted = false;
    const evidenceDir = mkdtempSync(join(tmpdir(), "claudexor-review-evidence-"));
    const artifactsDir = mkdtempSync(join(tmpdir(), "claudexor-review-artifacts-"));
    const candidateRoot = mkdtempSync(join(tmpdir(), "claudexor-candidate-root-"));
    writeFileSync(join(evidenceDir, "USER_INTENT.md"), "review incomplete evidence\n");
    const adapter: HarnessAdapter = {
      id: "must-not-start",
      async discover() {
        return HarnessManifest.parse({
          id: "must-not-start",
          display_name: "must-not-start",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "must-not-start",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run() {
        reviewerStarted = true;
      },
    };

    await expect(
      reviewCandidate({
        candidateLabel: "Candidate A",
        diff: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
        evidenceDir,
        artifactsDir,
        cwd: candidateRoot,
        reviewers: [{ adapter, providerFamily: "openai" }],
      }),
    ).rejects.toThrow(/mandatory evidence preflight failed/);
    expect(reviewerStarted).toBe(false);
    expect(readFileSync(join(evidenceDir, "DIFF.patch"), "utf8")).toContain("diff --git");
    expect(readFileSync(join(evidenceDir, "DIFF_SUMMARY.md"), "utf8")).toContain("Diff Summary");
  });

  it("persists source evidence when the default artifacts dir is inside the evidence dir", async () => {
    const candidateRoot = mkdtempSync(join(tmpdir(), "claudexor-candidate-root-"));
    const evidenceDir = mkdtempSync(join(tmpdir(), "claudexor-review-evidence-"));
    writeMandatoryReviewEvidence(evidenceDir);
    writeFileSync(join(evidenceDir, "USER_INTENT.md"), "review default evidence\n");
    writeFileSync(join(evidenceDir, "FORBIDDEN_FINDINGS.md"), "(none)\n");

    await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      evidenceDir,
      cwd: candidateRoot,
      reviewers: [makeReviewer("default-artifacts-reviewer", "openai", [])],
    });

    const persisted = join(evidenceDir, "reviewer-artifacts", "evidence");
    expect(readFileSync(join(persisted, "USER_INTENT.md"), "utf8")).toContain(
      "review default evidence",
    );
    expect(readFileSync(join(persisted, "FORBIDDEN_FINDINGS.md"), "utf8")).toContain("(none)");
    expect(readFileSync(join(persisted, "DIFF.patch"), "utf8")).toContain("+new");
    expect(readFileSync(join(persisted, "DIFF_SHA256.txt"), "utf8").trim()).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
  });

  it("removes temporary reviewer workspace base directories after fallback isolation", async () => {
    const candidateRoot = mkdtempSync(join(tmpdir(), "claudexor-candidate-root-"));
    const evidenceDir = mkdtempSync(join(tmpdir(), "claudexor-review-evidence-"));
    const artifactsDir = join(candidateRoot, "review-artifacts");
    writeMandatoryReviewEvidence(evidenceDir);
    writeFileSync(join(evidenceDir, "USER_INTENT.md"), "review fallback cleanup\n");
    writeFileSync(join(evidenceDir, "FORBIDDEN_FINDINGS.md"), "(none)\n");
    let reviewerCwd = "";
    const adapter: HarnessAdapter = {
      id: "fallback-cleanup-reviewer",
      async discover() {
        return HarnessManifest.parse({
          id: "fallback-cleanup-reviewer",
          display_name: "fallback cleanup",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "fallback-cleanup-reviewer",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        reviewerCwd = spec.cwd;
        const ts = new Date().toISOString();
        yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
      },
    };

    await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      evidenceDir,
      artifactsDir,
      cwd: candidateRoot,
      reviewers: [{ adapter, providerFamily: "openai" }],
    });

    const tempBase = dirname(reviewerCwd);
    expect(tempBase).toContain("claudexor-review-workspaces-");
    expect(existsSync(tempBase)).toBe(false);
  });

  it("treats child directory names that start with two dots as inside reviewer roots", async () => {
    const candidateRoot = mkdtempSync(join(tmpdir(), "claudexor-candidate-root-"));
    const evidenceDir = mkdtempSync(join(tmpdir(), "claudexor-review-evidence-"));
    const artifactsDir = join(candidateRoot, "..review-artifacts");
    writeMandatoryReviewEvidence(evidenceDir);
    writeFileSync(join(candidateRoot, "candidate.txt"), "source\n");
    writeFileSync(join(evidenceDir, "USER_INTENT.md"), "review dotted child isolation\n");
    writeFileSync(join(evidenceDir, "FORBIDDEN_FINDINGS.md"), "(none)\n");

    let reviewerCwd = "";
    const adapter: HarnessAdapter = {
      id: "dotted-child-reviewer",
      async discover() {
        return HarnessManifest.parse({
          id: "dotted-child-reviewer",
          display_name: "dotted child",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "dotted-child-reviewer",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        reviewerCwd = spec.cwd;
        const ts = new Date().toISOString();
        yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
      },
    };

    await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      evidenceDir,
      artifactsDir,
      cwd: candidateRoot,
      reviewers: [{ adapter, providerFamily: "openai" }],
    });

    const tempBase = dirname(reviewerCwd);
    expect(reviewerCwd).not.toContain(artifactsDir);
    expect(tempBase).toContain("claudexor-review-workspaces-");
    expect(existsSync(tempBase)).toBe(false);
  });

  it("does not mask review results when temporary reviewer workspace base cleanup fails", async () => {
    const candidateRoot = mkdtempSync(join(tmpdir(), "claudexor-candidate-root-"));
    const evidenceDir = mkdtempSync(join(tmpdir(), "claudexor-review-evidence-"));
    const artifactsDir = join(candidateRoot, "review-artifacts");
    writeMandatoryReviewEvidence(evidenceDir);
    writeFileSync(join(candidateRoot, "candidate.txt"), "source\n");
    writeFileSync(join(evidenceDir, "USER_INTENT.md"), "review cleanup failure\n");
    writeFileSync(join(evidenceDir, "FORBIDDEN_FINDINGS.md"), "(none)\n");

    let reviewerCwd = "";
    const adapter: HarnessAdapter = {
      id: "cleanup-failure-reviewer",
      async discover() {
        return HarnessManifest.parse({
          id: "cleanup-failure-reviewer",
          display_name: "cleanup failure",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "cleanup-failure-reviewer",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        reviewerCwd = spec.cwd;
        chmodSync(reviewerCwd, 0o000);
        const ts = new Date().toISOString();
        yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
      },
    };

    try {
      const res = await reviewCandidate({
        candidateLabel: "Candidate A",
        diff: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
        evidenceDir,
        artifactsDir,
        cwd: candidateRoot,
        reviewers: [{ adapter, providerFamily: "openai" }],
      });

      expect(res.findings).toEqual([]);
      expect(existsSync(join(artifactsDir, "reviewer-workspace-base-cleanup-error.json"))).toBe(
        true,
      );
    } finally {
      try {
        if (reviewerCwd && existsSync(reviewerCwd)) chmodSync(reviewerCwd, 0o700);
      } catch {
        // Best-effort permission restore before removing the sabotaged temp tree.
      }
      const tempBase = reviewerCwd ? dirname(reviewerCwd) : "";
      if (tempBase) rmSync(tempBase, { recursive: true, force: true });
    }
  });

  it("does not copy reviewer workspace symlinks that resolve outside the candidate root", async () => {
    const candidateRoot = mkdtempSync(join(tmpdir(), "claudexor-candidate-root-"));
    const evidenceDir = mkdtempSync(join(tmpdir(), "claudexor-review-evidence-"));
    const artifactsDir = join(candidateRoot, "review-artifacts");
    const outsideDir = mkdtempSync(join(tmpdir(), "claudexor-outside-secret-"));
    const outsideSecret = join(outsideDir, "secret.txt");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(candidateRoot, "candidate.txt"), "source\n");
    writeFileSync(join(candidateRoot, "safe-target.txt"), "safe\n");
    writeFileSync(join(artifactsDir, "secret.txt"), "artifact secret\n");
    writeFileSync(outsideSecret, "secret\n");
    writeMandatoryReviewEvidence(evidenceDir);
    symlinkSync("safe-target.txt", join(candidateRoot, "safe-link"));
    symlinkSync(
      join("..", basename(candidateRoot), "safe-target.txt"),
      join(candidateRoot, "relocates-outside-link"),
    );
    symlinkSync("review-artifacts/secret.txt", join(candidateRoot, "artifact-link"));
    symlinkSync(outsideSecret, join(candidateRoot, "outside-link"));
    writeFileSync(join(evidenceDir, "USER_INTENT.md"), "review symlink isolation\n");
    writeFileSync(join(evidenceDir, "FORBIDDEN_FINDINGS.md"), "(none)\n");

    let safeLinkVisible = false;
    let relocatesOutsideLinkVisible = false;
    let artifactLinkVisible = false;
    let outsideLinkVisible = false;
    const adapter: HarnessAdapter = {
      id: "symlink-reviewer",
      async discover() {
        return HarnessManifest.parse({
          id: "symlink-reviewer",
          display_name: "symlink reviewer",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "symlink-reviewer",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        safeLinkVisible = existsSync(join(spec.cwd, "safe-link"));
        relocatesOutsideLinkVisible = existsSync(join(spec.cwd, "relocates-outside-link"));
        artifactLinkVisible = existsSync(join(spec.cwd, "artifact-link"));
        outsideLinkVisible = existsSync(join(spec.cwd, "outside-link"));
        const ts = new Date().toISOString();
        yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
      },
    };

    try {
      await reviewCandidate({
        candidateLabel: "Candidate A",
        diff: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
        evidenceDir,
        artifactsDir,
        cwd: candidateRoot,
        reviewers: [{ adapter, providerFamily: "openai" }],
      });
      expect(safeLinkVisible).toBe(true);
      expect(relocatesOutsideLinkVisible).toBe(false);
      expect(artifactLinkVisible).toBe(false);
      expect(outsideLinkVisible).toBe(false);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("initializes reviewer workspace git baselines without running template hooks", async () => {
    const candidateRoot = mkdtempSync(join(tmpdir(), "claudexor-candidate-root-"));
    const evidenceDir = mkdtempSync(join(tmpdir(), "claudexor-review-evidence-"));
    writeMandatoryReviewEvidence(evidenceDir);
    const templateDir = mkdtempSync(join(tmpdir(), "claudexor-git-template-"));
    const hooksDir = join(templateDir, "hooks");
    mkdirSync(hooksDir, { recursive: true });
    for (const hookName of ["pre-commit", "post-commit"]) {
      const hookPath = join(hooksDir, hookName);
      writeFileSync(hookPath, "#!/bin/sh\nexit 42\n");
      chmodSync(hookPath, 0o755);
    }
    writeFileSync(join(candidateRoot, "candidate.txt"), "source\n");
    writeFileSync(join(evidenceDir, "USER_INTENT.md"), "review hook bypass\n");
    writeFileSync(join(evidenceDir, "FORBIDDEN_FINDINGS.md"), "(none)\n");

    let reviewerCwd = "";
    const adapter: HarnessAdapter = {
      id: "hook-bypass-reviewer",
      async discover() {
        return HarnessManifest.parse({
          id: "hook-bypass-reviewer",
          display_name: "hook bypass",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "hook-bypass-reviewer",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        reviewerCwd = spec.cwd;
        const ts = new Date().toISOString();
        yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
      },
    };

    const previousTemplate = process.env.GIT_TEMPLATE_DIR;
    process.env.GIT_TEMPLATE_DIR = templateDir;
    try {
      const res = await reviewCandidate({
        candidateLabel: "Candidate A",
        diff: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
        evidenceDir,
        cwd: candidateRoot,
        reviewers: [{ adapter, providerFamily: "openai" }],
      });
      expect(reviewerCwd).toContain("01-hook-bypass-reviewer");
      expect(res.findings).toEqual([]);
    } finally {
      if (previousTemplate === undefined) {
        delete process.env.GIT_TEMPLATE_DIR;
      } else {
        process.env.GIT_TEMPLATE_DIR = previousTemplate;
      }
    }
  });

  it("copies reviewer evidence from excluded .claudexor run artifacts into reviewer workspaces", async () => {
    const candidateRoot = mkdtempSync(join(tmpdir(), "claudexor-candidate-root-"));
    const evidenceDir = join(candidateRoot, ".claudexor", "runs", "run-x", "review-evidence");
    const artifactsDir = mkdtempSync(join(tmpdir(), "claudexor-review-artifacts-"));
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(candidateRoot, "candidate.txt"), "source\n");
    writeFileSync(join(evidenceDir, "USER_INTENT.md"), "review hidden evidence\n");
    writeFileSync(join(evidenceDir, "FORBIDDEN_FINDINGS.md"), "(none)\n");
    writeFileSync(join(evidenceDir, "PLAN_ACCEPTED.md"), "plan accepted\n");
    writeFileSync(join(evidenceDir, "DECIDED_TRADEOFFS.md"), "tradeoffs\n");
    writeFileSync(join(evidenceDir, "TESTS.txt"), "pnpm test\n");

    let reviewerEvidenceDir = "";
    const adapter: HarnessAdapter = {
      id: "hidden-evidence-reviewer",
      async discover() {
        return HarnessManifest.parse({
          id: "hidden-evidence-reviewer",
          display_name: "hidden evidence",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "hidden-evidence-reviewer",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        const evidenceLine = spec.prompt
          .split("\n")
          .find((line) => line.startsWith("First read the evidence packet in "));
        const prefix = "First read the evidence packet in ";
        const marker = " (USER_INTENT.md";
        expect(evidenceLine).toBeTruthy();
        const markerIndex = evidenceLine?.indexOf(marker) ?? -1;
        expect(markerIndex).toBeGreaterThan(prefix.length);
        reviewerEvidenceDir = (evidenceLine ?? "").slice(prefix.length, markerIndex);
        expect(reviewerEvidenceDir).toBe(join(spec.cwd, ".claudexor-review-evidence"));
        expect(
          execFileSync("git", ["ls-files", ".claudexor-review-evidence/USER_INTENT.md"], {
            cwd: spec.cwd,
            encoding: "utf8",
          }).trim(),
        ).toBe(".claudexor-review-evidence/USER_INTENT.md");
        const ts = new Date().toISOString();
        expect(readFileSync(join(reviewerEvidenceDir, "USER_INTENT.md"), "utf8")).toContain(
          "review hidden evidence",
        );
        expect(readFileSync(join(reviewerEvidenceDir, "FORBIDDEN_FINDINGS.md"), "utf8")).toContain(
          "(none)",
        );
        expect(readFileSync(join(reviewerEvidenceDir, "PLAN_ACCEPTED.md"), "utf8")).toContain(
          "plan accepted",
        );
        expect(readFileSync(join(reviewerEvidenceDir, "DECIDED_TRADEOFFS.md"), "utf8")).toContain(
          "tradeoffs",
        );
        expect(readFileSync(join(reviewerEvidenceDir, "TESTS.txt"), "utf8")).toContain("pnpm test");
        yield { type: "started", session_id: spec.session_id, ts, observed_model: "hidden-model" };
        yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };

    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a/candidate.txt b/candidate.txt\n@@ -1 +1 @@\n-source\n+changed\n",
      evidenceDir,
      artifactsDir,
      cwd: candidateRoot,
      reviewers: [{ adapter, providerFamily: "openai" }],
    });

    expect(res.findings).toEqual([]);
    expect(reviewerEvidenceDir).toContain(".claudexor");
    expect(readFileSync(join(artifactsDir, "evidence", "USER_INTENT.md"), "utf8")).toContain(
      "review hidden evidence",
    );
  });

  it("copies versioned project config without copying .claudexor runtime artifacts", async () => {
    const candidateRoot = mkdtempSync(join(tmpdir(), "claudexor-candidate-root-"));
    const evidenceDir = mkdtempSync(join(tmpdir(), "claudexor-review-evidence-"));
    const artifactsDir = mkdtempSync(join(tmpdir(), "claudexor-review-artifacts-"));
    mkdirSync(join(candidateRoot, ".claudexor", "runs", "run-x"), { recursive: true });
    writeFileSync(
      join(candidateRoot, ".claudexor", "config.yaml"),
      "context:\n  mandatory_files: [README.md]\n",
    );
    writeFileSync(join(candidateRoot, ".claudexor", "runs", "run-x", "events.jsonl"), "{}\n");
    writeFileSync(join(candidateRoot, ".claudexor", ".gitignore"), "*\n");
    writeFileSync(join(candidateRoot, "README.md"), "candidate docs\n");
    writeMandatoryReviewEvidence(evidenceDir);

    let sawProjectConfig = false;
    let sawRunArtifact = true;
    let sawRuntimeGitignore = true;
    const adapter: HarnessAdapter = {
      id: "project-config-reviewer",
      async discover() {
        return HarnessManifest.parse({
          id: "project-config-reviewer",
          display_name: "project config reviewer",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "project-config-reviewer",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        sawProjectConfig = existsSync(join(spec.cwd, ".claudexor", "config.yaml"));
        sawRunArtifact = existsSync(join(spec.cwd, ".claudexor", "runs", "run-x", "events.jsonl"));
        sawRuntimeGitignore = existsSync(join(spec.cwd, ".claudexor", ".gitignore"));
        const ts = new Date().toISOString();
        yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
      },
    };

    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a/README.md b/README.md\n@@ -1 +1 @@\n-old\n+new\n",
      evidenceDir,
      artifactsDir,
      cwd: candidateRoot,
      reviewers: [{ adapter, providerFamily: "openai" }],
    });

    expect(res.findings).toEqual([]);
    expect(sawProjectConfig).toBe(true);
    expect(sawRunArtifact).toBe(false);
    expect(sawRuntimeGitignore).toBe(false);
  });

  it("copies diff-touched evidence under normally ignored project output paths", async () => {
    const candidateRoot = mkdtempSync(join(tmpdir(), "claudexor-candidate-root-"));
    const evidenceDir = mkdtempSync(join(tmpdir(), "claudexor-review-evidence-"));
    const artifactsDir = mkdtempSync(join(tmpdir(), "claudexor-review-artifacts-"));
    for (const dir of [
      "dist",
      "coverage",
      ".next",
      ".cache",
      ".claudexor/specs",
      ".claudexor/runs/run-x",
    ]) {
      mkdirSync(join(candidateRoot, dir), { recursive: true });
    }
    writeFileSync(join(candidateRoot, "dist", "bundle.js"), "candidate bundle\n");
    writeFileSync(join(candidateRoot, "dist", "local-only.js"), "local build sibling\n");
    writeFileSync(join(candidateRoot, "coverage", "lcov.info"), "TN:\n");
    writeFileSync(join(candidateRoot, ".next", "trace.json"), "{}\n");
    writeFileSync(join(candidateRoot, ".cache", "artifact.json"), "{}\n");
    writeFileSync(join(candidateRoot, ".claudexor", "specs", "story.md"), "# Story\n");
    writeFileSync(join(candidateRoot, ".claudexor", "runs", "run-x", "events.jsonl"), "{}\n");
    writeFileSync(join(candidateRoot, "README.md"), "candidate docs\n");
    writeMandatoryReviewEvidence(evidenceDir);

    let sawDistBundle = false;
    let sawDistSibling = true;
    let sawCoverage = false;
    let sawNext = false;
    let sawCache = false;
    let sawSpec = false;
    let sawRunArtifact = true;
    const adapter: HarnessAdapter = {
      id: "preserved-output-reviewer",
      async discover() {
        return HarnessManifest.parse({
          id: "preserved-output-reviewer",
          display_name: "preserved output reviewer",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "preserved-output-reviewer",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        sawDistBundle = existsSync(join(spec.cwd, "dist", "bundle.js"));
        sawDistSibling = existsSync(join(spec.cwd, "dist", "local-only.js"));
        sawCoverage = existsSync(join(spec.cwd, "coverage", "lcov.info"));
        sawNext = existsSync(join(spec.cwd, ".next", "trace.json"));
        sawCache = existsSync(join(spec.cwd, ".cache", "artifact.json"));
        sawSpec = existsSync(join(spec.cwd, ".claudexor", "specs", "story.md"));
        sawRunArtifact = existsSync(join(spec.cwd, ".claudexor", "runs", "run-x", "events.jsonl"));
        const ts = new Date().toISOString();
        yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
      },
    };

    const diff = [
      "diff --git a/dist/bundle.js b/dist/bundle.js",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/coverage/lcov.info b/coverage/lcov.info",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/.next/trace.json b/.next/trace.json",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/.cache/artifact.json b/.cache/artifact.json",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/.claudexor/specs/story.md b/.claudexor/specs/story.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");

    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff,
      evidenceDir,
      artifactsDir,
      cwd: candidateRoot,
      reviewers: [{ adapter, providerFamily: "openai" }],
    });

    expect(res.findings).toEqual([]);
    expect(sawDistBundle).toBe(true);
    expect(sawDistSibling).toBe(false);
    expect(sawCoverage).toBe(true);
    expect(sawNext).toBe(true);
    expect(sawCache).toBe(true);
    expect(sawSpec).toBe(true);
    expect(sawRunArtifact).toBe(false);
  });

  it("tracks copied candidate files even when candidate gitignore ignores them", async () => {
    const candidateRoot = mkdtempSync(join(tmpdir(), "claudexor-candidate-root-"));
    const evidenceDir = mkdtempSync(join(tmpdir(), "claudexor-review-evidence-"));
    const artifactsDir = mkdtempSync(join(tmpdir(), "claudexor-review-artifacts-"));
    writeFileSync(join(candidateRoot, ".gitignore"), "ignored-but-versioned.txt\n");
    writeFileSync(join(candidateRoot, "ignored-but-versioned.txt"), "tracked despite ignore\n");
    writeFileSync(join(candidateRoot, "README.md"), "candidate docs\n");
    writeMandatoryReviewEvidence(evidenceDir);

    let sawIgnoredFile = false;
    let trackedIgnoredFile = "";
    const adapter: HarnessAdapter = {
      id: "ignored-file-reviewer",
      async discover() {
        return HarnessManifest.parse({
          id: "ignored-file-reviewer",
          display_name: "ignored file reviewer",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "ignored-file-reviewer",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        sawIgnoredFile = existsSync(join(spec.cwd, "ignored-but-versioned.txt"));
        trackedIgnoredFile = execFileSync("git", ["ls-files", "--", "ignored-but-versioned.txt"], {
          cwd: spec.cwd,
          encoding: "utf8",
        }).trim();
        const ts = new Date().toISOString();
        yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
      },
    };

    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a/README.md b/README.md\n@@ -1 +1 @@\n-old\n+new\n",
      evidenceDir,
      artifactsDir,
      cwd: candidateRoot,
      reviewers: [{ adapter, providerFamily: "openai" }],
    });

    expect(res.findings).toEqual([]);
    expect(sawIgnoredFile).toBe(true);
    expect(trackedIgnoredFile).toBe("ignored-but-versioned.txt");
  });

  it("does not copy paths from the shared sensitive-resource policy into reviewer workspaces", async () => {
    const candidateRoot = mkdtempSync(join(tmpdir(), "claudexor-candidate-root-"));
    const evidenceDir = mkdtempSync(join(tmpdir(), "claudexor-review-evidence-"));
    const artifactsDir = mkdtempSync(join(tmpdir(), "claudexor-review-artifacts-"));
    writeFileSync(join(candidateRoot, ".env"), "TOKEN=secret\n");
    writeFileSync(join(candidateRoot, ".envrc"), "export TOKEN=secret\n");
    writeFileSync(join(candidateRoot, ".env.local"), "TOKEN=local-secret\n");
    writeFileSync(join(candidateRoot, ".env.example"), "TOKEN=\n");
    writeFileSync(join(candidateRoot, "signing.key"), "not-real-key\n");
    writeFileSync(join(candidateRoot, "credentials.json"), "{}\n");
    const jwt = `eyJ${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`;
    writeFileSync(join(candidateRoot, "notes.txt"), `embedded ${jwt}\n`);
    symlinkSync(".env", join(candidateRoot, "env-alias"));
    writeFileSync(join(candidateRoot, ".npmrc"), "//registry.npmjs.org/:_authToken=secret\n");
    writeFileSync(join(candidateRoot, ".netrc"), "machine example.test password secret\n");
    mkdirSync(join(candidateRoot, ".ssh"), { recursive: true });
    writeFileSync(join(candidateRoot, ".ssh", "id_ed25519"), "private key\n");
    mkdirSync(join(candidateRoot, ".cursor"), { recursive: true });
    writeFileSync(join(candidateRoot, ".cursor", "state.json"), "{}\n");
    mkdirSync(join(candidateRoot, ".codex"), { recursive: true });
    writeFileSync(join(candidateRoot, ".codex", "auth.json"), "{}\n");
    mkdirSync(join(candidateRoot, ".claude"), { recursive: true });
    writeFileSync(join(candidateRoot, ".claude", "session.json"), "{}\n");
    writeFileSync(join(candidateRoot, "README.md"), "candidate docs\n");
    writeMandatoryReviewEvidence(evidenceDir);

    let sawDotEnv = true;
    let sawEnvrc = true;
    let sawLocalEnv = true;
    let sawEnvExample = false;
    let sawKey = true;
    let sawCredentials = true;
    let sawEnvAlias = true;
    let sawContentSecret = true;
    let sawNpmrc = true;
    let sawNetrc = true;
    let sawSsh = true;
    let sawCursor = true;
    let sawCodex = true;
    let sawClaude = true;
    const adapter: HarnessAdapter = {
      id: "env-secret-reviewer",
      async discover() {
        return HarnessManifest.parse({
          id: "env-secret-reviewer",
          display_name: "env secret reviewer",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "env-secret-reviewer",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        sawDotEnv = existsSync(join(spec.cwd, ".env"));
        sawEnvrc = existsSync(join(spec.cwd, ".envrc"));
        sawLocalEnv = existsSync(join(spec.cwd, ".env.local"));
        sawEnvExample = existsSync(join(spec.cwd, ".env.example"));
        sawKey = existsSync(join(spec.cwd, "signing.key"));
        sawCredentials = existsSync(join(spec.cwd, "credentials.json"));
        sawEnvAlias = existsSync(join(spec.cwd, "env-alias"));
        sawContentSecret = existsSync(join(spec.cwd, "notes.txt"));
        sawNpmrc = existsSync(join(spec.cwd, ".npmrc"));
        sawNetrc = existsSync(join(spec.cwd, ".netrc"));
        sawSsh = existsSync(join(spec.cwd, ".ssh"));
        sawCursor = existsSync(join(spec.cwd, ".cursor"));
        sawCodex = existsSync(join(spec.cwd, ".codex"));
        sawClaude = existsSync(join(spec.cwd, ".claude"));
        const ts = new Date().toISOString();
        yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
      },
    };

    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a/README.md b/README.md\n@@ -1 +1 @@\n-old\n+new\n",
      evidenceDir,
      artifactsDir,
      cwd: candidateRoot,
      reviewers: [{ adapter, providerFamily: "openai" }],
    });

    expect(res.findings).toEqual([]);
    expect(sawDotEnv).toBe(false);
    expect(sawEnvrc).toBe(false);
    expect(sawLocalEnv).toBe(false);
    expect(sawEnvExample).toBe(true);
    expect(sawKey).toBe(false);
    expect(sawCredentials).toBe(false);
    expect(sawEnvAlias).toBe(false);
    expect(sawContentSecret).toBe(false);
    expect(sawNpmrc).toBe(false);
    expect(sawNetrc).toBe(false);
    expect(sawSsh).toBe(false);
    expect(sawCursor).toBe(false);
    expect(sawCodex).toBe(false);
    expect(sawClaude).toBe(false);
  });

  it("isolates reviewer workspace setup failures to the failing reviewer", async () => {
    const missingCandidateRoot = join(tmpdir(), `claudexor-missing-candidate-${Date.now()}`);
    const evidenceDir = mkdtempSync(join(tmpdir(), "claudexor-review-evidence-"));
    const artifactsDir = mkdtempSync(join(tmpdir(), "claudexor-review-artifacts-"));
    writeFileSync(join(evidenceDir, "USER_INTENT.md"), "setup failure review\n");
    writeFileSync(join(evidenceDir, "FORBIDDEN_FINDINGS.md"), "(none)\n");
    writeFileSync(join(evidenceDir, "PLAN_ACCEPTED.md"), "plan accepted\n");
    writeFileSync(join(evidenceDir, "DECIDED_TRADEOFFS.md"), "tradeoffs\n");
    writeFileSync(join(evidenceDir, "TESTS.txt"), "pnpm test\n");

    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a/missing.txt b/missing.txt\n@@ -1 +1 @@\n-old\n+new\n",
      evidenceDir,
      artifactsDir,
      cwd: missingCandidateRoot,
      reviewers: [makeReviewer("setup-failing-reviewer", "openai", [])],
    });

    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]?.severity).toBe("INSUFFICIENT_EVIDENCE");
    expect(res.findings[0]?.claim).toContain("Reviewer setup failed");
    expect(res.routeProofs).toHaveLength(1);
    expect(
      readFileSync(join(artifactsDir, "01-setup-failing-reviewer", "metadata.json"), "utf8"),
    ).toContain("reviewer setup failed");
    expect(readFileSync(join(artifactsDir, "reviewer-progress.jsonl"), "utf8")).toContain(
      "reviewer.failed",
    );
  });

  it("reports the total changed file count even when diff summary truncates the list", async () => {
    const { cwd: candidateRoot, evidenceDir } = makeReviewWorkspace(
      "claudexor-review-summary-candidate-",
    );
    const artifactsDir = mkdtempSync(join(tmpdir(), "claudexor-review-artifacts-"));
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, "USER_INTENT.md"), "review summary\n");
    const diff = Array.from({ length: 85 }, (_, i) => {
      const file = `file-${String(i).padStart(2, "0")}.txt`;
      return `diff --git a/${file} b/${file}\n@@ -1 +1 @@\n-old\n+new`;
    }).join("\n");

    await reviewCandidate({
      candidateLabel: "Candidate A",
      diff,
      evidenceDir,
      artifactsDir,
      cwd: candidateRoot,
      reviewers: [makeReviewer("summary-reviewer", "openai", [])],
    });

    const summary = readFileSync(join(artifactsDir, "evidence", "DIFF_SUMMARY.md"), "utf8");
    expect(summary).toContain("- Files: 85");
    expect(summary).toContain("- ... 5 more file(s) omitted");
  });

  it("emits typed reviewer progress and metadata for auth route switches", async () => {
    const { cwd: candidateRoot, evidenceDir } = makeReviewWorkspace(
      "claudexor-review-auth-switch-candidate-",
    );
    const artifactsDir = mkdtempSync(join(tmpdir(), "claudexor-review-artifacts-"));
    const adapter: HarnessAdapter = {
      id: "auth-switch-reviewer",
      async discover() {
        return HarnessManifest.parse({
          id: "auth-switch-reviewer",
          display_name: "auth switch",
          kind: "local_cli",
          provider_family: "cursor",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "auth-switch-reviewer",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        yield {
          type: "message",
          session_id: spec.session_id,
          ts,
          text: "[auth] auto selected api_key route",
          payload: {
            auth_switched: true,
            from_auth_mode: "local_session",
            to_auth_mode: "api_key",
            reason: "readiness_preferred",
          },
        };
        yield { type: "started", session_id: spec.session_id, ts, observed_model: "cursor-model" };
        yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    const progressEvents: string[] = [];

    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-old\n+new\n",
      evidenceDir,
      artifactsDir,
      cwd: candidateRoot,
      reviewers: [{ adapter, providerFamily: "cursor" }],
      onReviewerEvent: (event) => progressEvents.push(event.type),
    });

    expect(res.findings).toEqual([]);
    expect(progressEvents).toContain("reviewer.auth_switched");
    const progress = readFileSync(join(artifactsDir, "reviewer-progress.jsonl"), "utf8");
    expect(progress).toContain('"type":"reviewer.auth_switched"');
    expect(progress).toContain('"reason":"readiness_preferred"');
    expect(progress).toContain('"from_auth_mode":"local_session"');
    expect(progress).toContain('"to_auth_mode":"api_key"');
    const metadata = readFileSync(
      join(artifactsDir, "01-auth-switch-reviewer", "metadata.json"),
      "utf8",
    );
    expect(metadata).toContain('"auth_switch"');
    expect(metadata).toContain('"reason": "readiness_preferred"');
    const transcript = readFileSync(
      join(artifactsDir, "01-auth-switch-reviewer", "transcript.md"),
      "utf8",
    );
    expect(transcript).not.toContain("[auth]");
  });

  it("does not persist evidence symlinks that resolve outside the source evidence dir", async () => {
    const { cwd: candidateRoot, evidenceDir } = makeReviewWorkspace(
      "claudexor-review-evidence-symlink-candidate-",
    );
    const externalRoot = mkdtempSync(join(tmpdir(), "claudexor-review-external-"));
    const artifactsDir = mkdtempSync(join(tmpdir(), "claudexor-review-artifacts-"));
    mkdirSync(evidenceDir, { recursive: true });
    mkdirSync(join(evidenceDir, "nested"), { recursive: true });
    writeFileSync(join(evidenceDir, "USER_INTENT.md"), "review evidence symlink\n");
    writeFileSync(join(externalRoot, "secret.txt"), "secret\n");
    symlinkSync(join(externalRoot, "secret.txt"), join(evidenceDir, "leak.txt"));
    symlinkSync(join(externalRoot, "secret.txt"), join(evidenceDir, "nested", "leak.txt"));

    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-old\n+new\n",
      evidenceDir,
      artifactsDir,
      cwd: candidateRoot,
      reviewers: [makeReviewer("evidence-symlink-reviewer", "openai", [])],
    });

    expect(res.findings).toEqual([]);
    expect(existsSync(join(artifactsDir, "evidence", "leak.txt"))).toBe(false);
    expect(existsSync(join(artifactsDir, "evidence", "nested", "leak.txt"))).toBe(false);
  });

  it("runs reviewers in disposable workspaces so mutations cannot alter the source candidate", async () => {
    const { cwd: candidateRoot, evidenceDir } = makeReviewWorkspace(
      "claudexor-review-isolation-candidate-",
    );
    const artifactsDir = mkdtempSync(join(tmpdir(), "claudexor-review-artifacts-"));
    writeFileSync(join(candidateRoot, "kept.txt"), "original\n");
    let reviewerCwd = "";
    const adapter: HarnessAdapter = {
      id: "mutating-reviewer",
      async discover() {
        return HarnessManifest.parse({
          id: "mutating-reviewer",
          display_name: "mutating",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "mutating-reviewer",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        reviewerCwd = spec.cwd;
        writeFileSync(join(spec.cwd, "kept.txt"), "mutated\n");
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: "mutating-model",
        };
        yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };

    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a/kept.txt b/kept.txt\n@@ -1 +1 @@\n-original\n+changed\n",
      evidenceDir,
      artifactsDir,
      cwd: candidateRoot,
      reviewers: [{ adapter, providerFamily: "openai" }],
    });

    expect(res.findings).toEqual([]);
    expect(reviewerCwd).not.toBe(candidateRoot);
    expect(readFileSync(join(candidateRoot, "kept.txt"), "utf8")).toBe("original\n");
    expect(existsSync(reviewerCwd)).toBe(false);
    expect(
      readFileSync(join(artifactsDir, "01-mutating-reviewer", "metadata.json"), "utf8"),
    ).toContain(`"source_candidate_root": "${candidateRoot}"`);
    expect(
      readFileSync(join(artifactsDir, "01-mutating-reviewer", "metadata.json"), "utf8"),
    ).toContain(`"reviewer_workspace_cleanup": "removed"`);
  });

  it("does not count malformed JSON arrays as healthy clean review", async () => {
    const r1 = makeReviewer("rev-openai", "openai", [1]);
    const r2 = makeReviewer("rev-anthropic", "anthropic", [1]);
    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a a",
      ...makeReviewWorkspace(),
      reviewers: [r1, r2],
    });
    expect(res.crossFamilyHealthy).toBe(false);
    expect(res.crossFamilyVerified).toBe(false);
    expect(res.findings.length).toBeGreaterThan(0);
    expect(res.findings.every((f) => f.severity === "INSUFFICIENT_EVIDENCE")).toBe(true);
  });

  it("keeps parseable findings but fails closed when a reviewer emits an error after valid output", async () => {
    const adapter: HarnessAdapter = {
      id: "late-error-reviewer",
      async discover() {
        return HarnessManifest.parse({
          id: "late-error-reviewer",
          display_name: "late error",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "late-error-reviewer",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: "late-error-model",
        };
        yield {
          type: "message",
          session_id: spec.session_id,
          ts,
          text: JSON.stringify([
            {
              severity: "WARN",
              category: "correctness",
              claim: "keep this finding",
              evidence: { files: [{ path: "x.ts", lines: "1" }] },
              proposed_fix: "fix x",
            },
          ]),
        };
        yield {
          type: "error",
          session_id: spec.session_id,
          ts,
          error: "late stderr after final answer",
        };
      },
    };

    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-old\n+new\n",
      ...makeReviewWorkspace(),
      reviewers: [
        { adapter, providerFamily: "openai" },
        makeReviewer("clean-anthropic", "anthropic", []),
      ],
    });

    expect(res.findings.some((f) => f.claim === "keep this finding" && f.severity === "WARN")).toBe(
      true,
    );
    expect(
      res.findings.some(
        (f) =>
          f.severity === "INSUFFICIENT_EVIDENCE" &&
          f.claim.includes("Reviewer failed after parseable JSON output"),
      ),
    ).toBe(true);
    expect(res.healthyProviders).toEqual(["anthropic"]);
    expect(res.crossFamilyHealthy).toBe(false);
    expect(res.crossFamilyVerified).toBe(false);
  });

  it("records parsed findings once when malformed output is followed by reviewer failure", async () => {
    const adapter: HarnessAdapter = {
      id: "malformed-late-error-reviewer",
      async discover() {
        return HarnessManifest.parse({
          id: "malformed-late-error-reviewer",
          display_name: "malformed late error",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "malformed-late-error-reviewer",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: "malformed-late-error-model",
        };
        yield {
          type: "message",
          session_id: spec.session_id,
          ts,
          text: JSON.stringify([
            {
              severity: "INSUFFICIENT_EVIDENCE",
              category: "test_gap",
              claim: "valid insufficient finding survives once",
              evidence: { files: [{ path: "x.ts", lines: "1" }] },
            },
            1,
          ]),
        };
        yield {
          type: "error",
          session_id: spec.session_id,
          ts,
          error: "late stderr after malformed output",
        };
      },
    };

    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-old\n+new\n",
      ...makeReviewWorkspace(),
      reviewers: [{ adapter, providerFamily: "openai" }],
    });

    expect(
      res.findings.filter((f) => f.claim === "valid insufficient finding survives once"),
    ).toHaveLength(1);
    expect(
      res.findings.some(
        (f) =>
          f.severity === "INSUFFICIENT_EVIDENCE" &&
          f.claim.includes("Reviewer produced 1 malformed finding item"),
      ),
    ).toBe(true);
    expect(
      res.findings.some(
        (f) =>
          f.severity === "INSUFFICIENT_EVIDENCE" &&
          f.claim.includes("Reviewer failed after parseable JSON output"),
      ),
    ).toBe(true);
    expect(res.crossFamilyHealthy).toBe(false);
  });

  it("keeps parseable findings but fails closed when a reviewer throws after valid output", async () => {
    const adapter: HarnessAdapter = {
      id: "throw-after-output-reviewer",
      async discover() {
        return HarnessManifest.parse({
          id: "throw-after-output-reviewer",
          display_name: "throw after output",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "throw-after-output-reviewer",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: "throw-after-output-model",
        };
        yield {
          type: "message",
          session_id: spec.session_id,
          ts,
          text: JSON.stringify([
            {
              severity: "BLOCK",
              category: "correctness",
              claim: "keep thrown finding",
              evidence: { files: [{ path: "x.ts", lines: "1" }] },
            },
          ]),
        };
        throw new Error("transport closed after output");
      },
    };

    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-old\n+new\n",
      ...makeReviewWorkspace(),
      reviewers: [
        { adapter, providerFamily: "openai" },
        makeReviewer("clean-anthropic", "anthropic", []),
      ],
    });

    expect(
      res.findings.some((f) => f.claim === "keep thrown finding" && f.severity === "BLOCK"),
    ).toBe(true);
    expect(
      res.findings.some(
        (f) =>
          f.severity === "INSUFFICIENT_EVIDENCE" &&
          f.claim.includes("Reviewer failed after parseable JSON output"),
      ),
    ).toBe(true);
    expect(res.healthyProviders).toEqual(["anthropic"]);
    expect(res.crossFamilyHealthy).toBe(false);
    expect(res.crossFamilyVerified).toBe(false);
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
      ...makeReviewWorkspace(),
      reviewers: [stripObserved(r1), stripObserved(r2)],
    });
    expect(res.crossFamilyHealthy).toBe(true);
    expect(res.healthyProviders.sort()).toEqual(["anthropic", "openai"]);
    expect(res.crossFamilyVerified).toBe(false);
    expect(res.distinctProviders).toEqual([]);
    expect(res.routeProofs.every((p) => p.status === "unverified")).toBe(true);
  });

  it("argv-echo (accepted_model_arg) does NOT satisfy crossFamilyVerified", async () => {
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
      ...makeReviewWorkspace(),
      reviewers: [argvEcho("rev-openai", "openai"), argvEcho("rev-anthropic", "anthropic")],
    });
    expect(res.routeProofs.every((p) => p.status === "accepted_model_arg")).toBe(true);
    expect(res.crossFamilyVerified).toBe(false);
    expect(res.distinctProviders).toEqual([]);
  });

  it("keeps per-finding route proof status aligned with same-model fallback classification", async () => {
    const findings = [
      {
        severity: "WARN",
        category: "correctness",
        claim: "same model route",
        evidence: { files: [{ path: "a.ts", lines: "1" }] },
      },
    ];
    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a a",
      ...makeReviewWorkspace(),
      reviewers: [
        sameObservedModelReviewer("rev-openai", "openai", findings, "shared-model"),
        sameObservedModelReviewer("rev-anthropic", "anthropic", findings, "shared-model"),
      ],
    });
    expect(res.crossFamilyHealthy).toBe(true);
    expect(res.crossFamilyVerified).toBe(false);
    expect(res.routeProofs.every((p) => p.status === "same_model_fallback")).toBe(true);
    expect(res.findings.every((f) => f.reviewer.route_proof_status === "same_model_fallback")).toBe(
      true,
    );
  });

  it("keeps per-finding route proof status aligned by reviewer position for duplicate specs", async () => {
    const duplicate = (observedModel: string | null, text: string): ReviewerSpec => {
      const adapter: HarnessAdapter = {
        id: "rev-cursor",
        async discover() {
          return HarnessManifest.parse({
            id: "rev-cursor",
            display_name: "rev-cursor",
            kind: "local_cli",
            provider_family: "cursor",
            capabilities: { review: true, structured_output: true },
          });
        },
        async doctor() {
          return ConformanceReport.parse({
            harness_id: "rev-cursor",
            status: "ok",
            enabled_intents: ["review"],
          });
        },
        async *run(spec) {
          const ts = new Date().toISOString();
          if (observedModel)
            yield {
              type: "started",
              session_id: spec.session_id,
              ts,
              observed_model: observedModel,
            };
          if (text) yield { type: "message", session_id: spec.session_id, ts, text };
          yield { type: "completed", session_id: spec.session_id, ts };
        },
      };
      return { adapter, providerFamily: "cursor", requestedModel: "same-model" };
    };
    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a a",
      ...makeReviewWorkspace(),
      reviewers: [duplicate(null, ""), duplicate("same-model", "[]\n")],
    });
    expect(res.routeProofs.map((p) => p.status)).toEqual(["accepted_model_arg", "verified"]);
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]?.reviewer.route_proof_status).toBe("accepted_model_arg");
  });

  it("passes reviewer auth preference into reviewer run specs", async () => {
    let seenAuthPreference: string | null = null;
    const base = makeReviewer("rev-cursor", "cursor", []);
    const reviewer: ReviewerSpec = {
      ...base,
      authPreference: "api_key",
      adapter: {
        ...base.adapter,
        async *run(spec) {
          seenAuthPreference = spec.auth_preference;
          const ts = new Date().toISOString();
          yield {
            type: "started",
            session_id: spec.session_id,
            ts,
            observed_model: "cursor-model",
          };
          yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
          yield { type: "completed", session_id: spec.session_id, ts };
        },
      },
    };

    await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a a",
      ...makeReviewWorkspace(),
      reviewers: [reviewer],
    });

    expect(seenAuthPreference).toBe("api_key");
  });
});

describe("reviewer preserve set uses the shared quote-aware diff parser (INV-050)", () => {
  it("decodes git C-quoted non-ASCII paths (octal escapes) into real touched paths", async () => {
    const { __testExtractDiffTouchedPaths } = await import("./reviewEngine.js");
    const diff = [
      'diff --git "a/\\321\\204\\320\\260\\320\\271\\320\\273.txt" "b/\\321\\204\\320\\260\\320\\271\\320\\273.txt"',
      "index 000..111 100644",
      '--- "a/\\321\\204\\320\\260\\320\\271\\320\\273.txt"',
      '+++ "b/\\321\\204\\320\\260\\320\\271\\320\\273.txt"',
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    const paths = __testExtractDiffTouchedPaths(diff);
    expect([...paths]).toContain("файл.txt");
  });
});
