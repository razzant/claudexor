import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
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
import { credentialProfileUnpinned, type HarnessAdapter } from "@claudexor/core";
import type { CredentialProfile, ProviderFamily } from "@claudexor/schema";
import {
  ConformanceReport,
  ConvergencePredicate,
  type HarnessEvent,
  HarnessManifest,
  ReviewFinding,
  RunEventType,
  strictifyForStructuredOutput,
} from "@claudexor/schema";
import { evaluateConvergence } from "./convergence.js";
import {
  dedupeFindings,
  extractJsonBlocks,
  parseFindingsDetailed,
  parseSealedReviewEnvelopeDetailed,
  sealedReviewTranscriptFromEvents,
} from "./findings.js";
import { buildTestCommandGrant, gatesPassed, runGate } from "./gates.js";
import { ReadinessLedger, failureSignature } from "./readiness.js";
import { revalidateFindings } from "./revalidate.js";
import { type ReviewerProgressEvent, type ReviewerSpec, reviewCandidate } from "./reviewEngine.js";
import { SEALED_REVIEW_OUTPUT_SCHEMA } from "./reviewPrompt.js";
import { buildRouteProof, classifyDiversity } from "./route.js";
import { rmSync as __rmSyncReap } from "node:fs";
import { afterAll as __afterAllReap } from "vitest";

// W-h: reap every temp dir this suite creates so the gate stops leaking tmpdirs.
const __reapDirs: string[] = [];
function reapMk(...args: Parameters<typeof mkdtempSync>): string {
  const dir = mkdtempSync(...args);
  __reapDirs.push(dir);
  return dir;
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
__afterAllReap(() => {
  for (const dir of __reapDirs.splice(0)) __rmSyncReap(dir, { recursive: true, force: true });
});

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

function makeWorkspaceProbeReviewer(id: string, probe: (cwd: string) => void): ReviewerSpec {
  const adapter: HarnessAdapter = {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "openai",
        capabilities: { review: true, structured_output: true },
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["review"],
      });
    },
    async *run(spec) {
      probe(spec.cwd);
      const ts = new Date().toISOString();
      yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
    },
  };
  return { adapter, providerFamily: "openai" };
}

function makeReviewWorkspace(prefix = "claudexor-review-candidate-"): {
  cwd: string;
  evidenceDir: string;
} {
  const cwd = reapMk(join(tmpdir(), prefix));
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

function initGitFixture(cwd: string): void {
  execFileSync(
    "git",
    ["-c", "init.templateDir=", "-c", "core.hooksPath=/dev/null", "init", "--quiet"],
    { cwd },
  );
}

function gitAddFixture(cwd: string, paths: string[]): void {
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "add", "--force", "--", ...paths], {
    cwd,
  });
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

describe("reviewer env: explicit Playwright value in the caller patch wins over the automatic cache (#449 item 10)", () => {
  it("keeps an explicit 0 from the caller env, and otherwise never injects 0 (both directions)", async () => {
    const seen: Array<Record<string, string>> = [];
    const probe = () => {
      const reviewer = makeReviewer("env-probe", "anthropic", []);
      const run = reviewer.adapter.run.bind(reviewer.adapter);
      reviewer.adapter.run = async function* (spec) {
        seen.push({ ...spec.env });
        yield* run(spec);
      };
      return reviewer;
    };
    const workspace = makeReviewWorkspace();
    await reviewCandidate({
      candidateLabel: "explicit",
      diff: "diff --git a/a b/a\n",
      ...workspace,
      reviewers: [probe()],
      env: { PLAYWRIGHT_BROWSERS_PATH: "0" },
    });
    await reviewCandidate({
      candidateLabel: "automatic",
      diff: "diff --git a/a b/a\n",
      ...workspace,
      reviewers: [probe()],
    });
    expect(seen).toHaveLength(2);
    const [explicit, automatic] = seen as [Record<string, string>, Record<string, string>];
    expect(explicit["PLAYWRIGHT_BROWSERS_PATH"]).toBe("0");
    expect(explicit["CLAUDEXOR_HOME_SCOPED"]).toBe("1");
    expect(automatic["PLAYWRIGHT_BROWSERS_PATH"]).not.toBe("0");
    expect(automatic["CLAUDEXOR_HOME_SCOPED"]).toBe("1");
  });
});

describe("sealed release native reviewer contract", () => {
  it("reviews explicit ordinary-folder postimages with an empty diff and no Git inventory", async () => {
    const workspace = makeReviewWorkspace();
    mkdirSync(join(workspace.cwd, "assets"));
    writeFileSync(join(workspace.cwd, "assets", "result.bin"), Buffer.from([0, 255, 1]));
    writeFileSync(join(workspace.cwd, "outside.txt"), "not selected");
    let checked = false;
    const reviewer = makeWorkspaceProbeReviewer("file-reviewer", (cwd) => {
      expect([...readFileSync(join(cwd, "assets", "result.bin"))]).toEqual([0, 255, 1]);
      expect(existsSync(join(cwd, "outside.txt"))).toBe(false);
      checked = true;
    });
    await reviewCandidate({
      candidateLabel: "Folder result",
      diff: "",
      candidatePaths: ["assets/result.bin"],
      ...workspace,
      reviewers: [reviewer],
    });
    expect(checked).toBe(true);
    expect(existsSync(join(workspace.cwd, ".git"))).toBe(false);
  });
  it("enforces the existing panel cap on streamed unknown premium amount and retains partial money", async () => {
    const reviewer = makeReviewer("premium-budget", "anthropic", []);
    let continued = false;
    reviewer.adapter.run = async function* (spec) {
      const common = {
        session_id: spec.session_id,
        ts: new Date().toISOString(),
        credential_route: "vendor_native" as const,
        processing_cost_basis: {
          kind: "paid_credits" as const,
          nativeMode: "fast",
          source: "fixture",
        },
      };
      yield { ...common, type: "started" as const };
      yield {
        ...common,
        type: "usage" as const,
        usage: { cost_usd: 2, cost_basis: { kind: "unknown" as const, source: "fixture" } },
      };
      continued = true;
      yield { ...common, type: "message" as const, text: "```json\n[]\n```" };
    };
    const amounts: number[] = [];
    const result = await reviewCandidate({
      candidateLabel: "Candidate",
      diff: "diff --git a/a b/a\n",
      ...makeReviewWorkspace(),
      reviewers: [reviewer],
      onUsageCost: (usd) => {
        amounts.push(usd);
        return usd >= 1;
      },
    });
    expect(amounts).toEqual([2]);
    expect(continued).toBe(false);
    expect(result).toMatchObject({
      reviewSpendUsd: 2,
      reviewCashUsd: 0,
      reviewCashKnowledge: "unknown",
      reviewUnknownUsd: 2,
    });
  });

  it("reports cumulative panel spend across simultaneous reviewer indexes", async () => {
    const reviewers = ["a", "b"].map((id) => {
      const reviewer = makeReviewer(id, "anthropic", []);
      reviewer.adapter.run = async function* (spec) {
        const common = {
          session_id: spec.session_id,
          ts: new Date().toISOString(),
          credential_route: "managed_api_key" as const,
        };
        yield { ...common, type: "started" as const };
        yield { ...common, type: "usage" as const, usage: { cost_usd: 0.6 } };
        yield { ...common, type: "message" as const, text: "```json\n[]\n```" };
      };
      return reviewer;
    });
    const amounts: number[] = [];
    const result = await reviewCandidate({
      candidateLabel: "Candidate",
      diff: "diff --git a/a b/a\n",
      ...makeReviewWorkspace(),
      reviewers,
      onUsageCost: (usd) => {
        amounts.push(usd);
        return usd >= 1;
      },
    });
    expect(amounts).toEqual([0.6, 1.2]);
    expect(result.reviewCashUsd).toBe(1.2);
  });
  it.each([
    {
      mode: "standard",
      kind: "included",
      amount: "unknown",
      cash: "exact",
      valuation: 0,
      unknown: 2,
    },
    {
      mode: "fast",
      kind: "paid_credits",
      amount: "unknown",
      cash: "unknown",
      valuation: 0,
      unknown: 2,
    },
    {
      mode: "fast",
      kind: "paid_credits",
      amount: "valuation",
      cash: "unknown",
      valuation: 2,
      unknown: 0,
    },
  ] as const)(
    "separates reviewer processing $mode / $amount amount from tariff billing",
    async ({ mode, kind, amount, cash, valuation, unknown }) => {
      const reviewer = makeReviewer("processing-reviewer", "anthropic", []);
      reviewer.adapter.run = async function* (spec) {
        const common = {
          session_id: spec.session_id,
          ts: new Date().toISOString(),
          credential_route: "vendor_native" as const,
          processing: {
            requested: mode,
            submitted: mode,
            submittedNative: mode,
            observed: "unknown" as const,
            observedNative: [],
            reason: null,
            source: "fixture",
          },
          processing_cost_basis: { kind, nativeMode: mode, source: "fixture" },
        };
        yield { ...common, type: "started" as const };
        yield {
          ...common,
          type: "usage" as const,
          usage: { cost_usd: 2, cost_basis: { kind: amount, source: "fixture" } },
        };
        yield { ...common, type: "message" as const, text: "```json\n[]\n```" };
        yield { ...common, type: "completed" as const };
      };
      const result = await reviewCandidate({
        candidateLabel: "Candidate",
        diff: "diff --git a/a b/a\n",
        ...makeReviewWorkspace(),
        reviewers: [reviewer],
      });
      expect(result).toMatchObject({
        reviewCashUsd: 0,
        reviewCashKnowledge: cash,
        reviewValuationUsd: valuation,
        reviewUnknownUsd: unknown,
      });
    },
  );
  it.each([false, true])(
    "admits the exact prepared reviewer before native dispatch (refused=%s)",
    async (refused) => {
      const reviewer = makeReviewer("processing-admission-reviewer", "anthropic", []);
      reviewer.processingPreference = "fast";
      reviewer.adapter.prepareProcessing = async () => ({
        model: null,
        receipt: {
          requested: "fast",
          submitted: "fast",
          submittedNative: "priority",
          observed: "unknown",
          observedNative: [],
          reason: null,
          source: "fixture",
        },
        costBasis: { kind: "paid_credits", nativeMode: "priority", source: "fixture" },
      });
      const order: string[] = [];
      reviewer.adapter.run = async function* (spec) {
        order.push("native");
        yield {
          type: "message",
          session_id: spec.session_id,
          ts: new Date().toISOString(),
          text: "```json\n[]\n```",
        };
      };
      await reviewCandidate({
        candidateLabel: "Candidate",
        diff: "diff --git a/a b/a\n",
        ...makeReviewWorkspace(),
        reviewers: [reviewer],
        onBeforeDispatch: (index, actual) => {
          expect(index).toBe(0);
          expect(actual.processing_cost_basis?.kind).toBe("paid_credits");
          expect(actual.processing?.submittedNative).toBe("priority");
          order.push("admission");
          if (refused) throw new Error("fixture budget admission refused");
        },
      });
      expect(order).toEqual(refused ? ["admission"] : ["admission", "native"]);
    },
  );
  it("keeps the release transport schema provider-strict and semantic-free", () => {
    expect(strictifyForStructuredOutput(SEALED_REVIEW_OUTPUT_SCHEMA)).toEqual(
      SEALED_REVIEW_OUTPUT_SCHEMA,
    );
    expect(JSON.stringify(SEALED_REVIEW_OUTPUT_SCHEMA)).not.toMatch(/"(?:enum|const|minimum)"\s*:/);
  });

  it("accepts only one exact JSON envelope and rejects surrounding reviewer prose", () => {
    const reviewer = {
      harness_id: "codex",
      requested_model: "gpt-5.6-sol",
      requested_effort: "xhigh",
      observed_model: "gpt-5.6-sol",
      route_proof_status: "verified",
    } as const;
    const envelope = JSON.stringify({
      completion: {
        verdict: "PASS",
        checklist: [
          "sealed_evidence",
          "intent_and_scope",
          "runtime_and_security",
          "tests_and_release",
        ].map((item) => ({ item, completed: true })),
        findingCount: 0,
      },
      findings: [],
    });

    expect(parseSealedReviewEnvelopeDetailed(`  ${envelope}\n`, reviewer).error).toBeNull();
    for (const output of [
      `CRITICAL: omitted from JSON\n${envelope}`,
      `${envelope}\nAdditional caveat`,
      `\`\`\`json\n${envelope}\n\`\`\``,
      `${envelope}\n${envelope}`,
    ]) {
      expect(parseSealedReviewEnvelopeDetailed(output, reviewer)).toMatchObject({
        findings: [],
        malformed: 0,
        error: "sealed review output must be exactly one JSON object with no surrounding prose",
      });
    }
  });

  it("submits the release schema only for frozen sealed reviews", async () => {
    const { cwd, evidenceDir } = makeReviewWorkspace("claudexor-generic-review-schema-");
    const artifactsDir = reapMk(join(tmpdir(), "claudexor-generic-review-schema-artifacts-"));
    initGitFixture(cwd);
    let submittedOutputSchema: unknown = "not observed";
    let submittedPrompt = "";
    const adapter: HarnessAdapter = {
      id: "generic-reviewer",
      async discover() {
        throw new Error("not used");
      },
      async doctor() {
        throw new Error("not used");
      },
      async *run(spec) {
        submittedOutputSchema = spec.output_schema;
        submittedPrompt = spec.prompt;
        const ts = new Date().toISOString();
        yield { type: "message", session_id: spec.session_id, ts, text: "[]" };
      },
    };

    try {
      await reviewCandidate({
        candidateLabel: "Generic candidate",
        diff: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
        evidenceDir,
        artifactsDir,
        cwd,
        reviewers: [{ adapter, providerFamily: "openai" }],
      });
      expect(submittedOutputSchema).toBeUndefined();
      expect(submittedPrompt).not.toContain("All four evidence arrays are required");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("prompts for an explicit completion envelope while preserving generic findings", async () => {
    const { cwd, evidenceDir } = makeReviewWorkspace("claudexor-release-review-");
    const artifactsDir = reapMk(join(tmpdir(), "claudexor-release-review-artifacts-"));
    const diff = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    writeFileSync(join(evidenceDir, "DIFF.patch"), diff);
    writeFileSync(join(evidenceDir, "DIFF_SUMMARY.md"), "one release file changed\n");
    writeFileSync(join(evidenceDir, "FREEZE.json"), "{}\n");
    writeFileSync(join(evidenceDir, "MANIFEST.sha256"), "sealed fixture\n");
    initGitFixture(cwd);
    let prompt = "";
    let submittedSessionId = "";
    let submittedExternalContextPolicy = "";
    let submittedWebPolicy = "";
    let submittedOutputSchema: unknown;
    let sawLiveTranscriptProgress = false;
    let emitDuplicateTypedFinal = false;
    let reviewPayload = {
      completion: {
        verdict: "PASS",
        checklist: [
          "sealed_evidence",
          "intent_and_scope",
          "runtime_and_security",
          "tests_and_release",
        ].map((item) => ({ item, completed: true })),
        findingCount: 1,
      },
      findings: [
        {
          severity: "WARN",
          category: "test_gap",
          claim: "release wrapper finding",
          evidence: { files: [], diff_hunks: [], commands: [], logs: [] },
          proposed_fix: "Add the missing release assertion.",
        },
      ],
    };
    const adapter: HarnessAdapter = {
      id: "release-reviewer",
      async discover() {
        return HarnessManifest.parse({
          id: "release-reviewer",
          display_name: "release reviewer",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "release-reviewer",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        prompt = spec.prompt;
        submittedSessionId = spec.session_id;
        submittedExternalContextPolicy = spec.external_context_policy;
        submittedWebPolicy = spec.tool_permission_policy.web;
        submittedOutputSchema = spec.output_schema;
        const ts = new Date().toISOString();
        const text = JSON.stringify(reviewPayload);
        yield {
          type: "message",
          session_id: spec.session_id,
          ts,
          observed_model: "release-model",
          credential_route: "vendor_native",
          text,
        };
        sawLiveTranscriptProgress =
          readFileSync(join(artifactsDir, "01-release-reviewer", "transcript.md"), "utf8") ===
          `${text}\n`;
        const finalEvent = {
          type: "message",
          session_id: spec.session_id,
          ts,
          observed_model: "release-model",
          credential_route: "vendor_native",
          text,
          final: true,
          payload: { final_source: "last_agent_message" },
        } satisfies HarnessEvent;
        yield finalEvent;
        if (emitDuplicateTypedFinal) yield finalEvent;
      },
    };
    try {
      const result = await reviewCandidate({
        candidateLabel: "Release candidate",
        diff,
        evidenceDir,
        evidenceReadOnly: true,
        frozenIdentity: {
          candidateSha: "a".repeat(40),
          candidateTree: "b".repeat(40),
          packetManifestSha256: "c".repeat(64),
        },
        env: { CLAUDEXOR_REVIEW_WAVE_ID: "11111111-1111-4111-8111-111111111111" },
        artifactsDir,
        cwd,
        reviewers: [
          {
            adapter,
            providerFamily: "openai",
            requestedModel: "release-model",
            requestedEffort: "xhigh",
          },
        ],
      });
      expect(prompt).toContain("exact release-review envelope");
      expect(prompt).toContain(
        "sealed_evidence, intent_and_scope, runtime_and_security, tests_and_release",
      );
      expect(prompt).toContain("findingCount must exactly equal findings.length");
      expect(submittedExternalContextPolicy).toBe("live");
      expect(submittedWebPolicy).toBe("live");
      expect(submittedOutputSchema).toEqual(SEALED_REVIEW_OUTPUT_SCHEMA);
      expect(sawLiveTranscriptProgress).toBe(true);
      expect(readFileSync(join(artifactsDir, "01-release-reviewer", "prompt.md"), "utf8")).toBe(
        prompt,
      );
      expect(readFileSync(join(artifactsDir, "01-release-reviewer", "transcript.md"), "utf8")).toBe(
        `${JSON.stringify(reviewPayload)}\n`,
      );
      expect(result.findings.map((finding) => finding.claim)).toContain("release wrapper finding");
      expect(
        JSON.parse(
          readFileSync(join(artifactsDir, "01-release-reviewer", "metadata.json"), "utf8"),
        ),
      ).not.toHaveProperty("review_subject");
      expect(
        JSON.parse(
          readFileSync(join(artifactsDir, "01-release-reviewer", "metadata.json"), "utf8"),
        ),
      ).toMatchObject({
        review_wave_id: "11111111-1111-4111-8111-111111111111",
        review_runtime_version: expect.any(String),
        review_runtime_build_sha: expect.stringMatching(/^(?:[0-9a-f]{40}|unknown)$/),
        review_runtime_entry: expect.any(String),
        review_runtime_entry_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        session_id: submittedSessionId,
        external_context_policy: "live",
        tool_web_policy: "live",
        submitted_prompt_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        auth_mode: "local_session",
        auth_modes: ["local_session"],
      });
      expect(readFileSync(join(artifactsDir, "reviewer-progress.jsonl"), "utf8")).toContain(
        '"review_wave_id":"11111111-1111-4111-8111-111111111111"',
      );

      // A parseable clean-looking object is not release evidence unless its
      // checklist is the exact completed contract. Preserve the parse error
      // and fail closed instead of turning malformed output into a false PASS.
      reviewPayload = {
        completion: {
          verdict: "PASS",
          checklist: [{ item: "sealed_evidence", completed: true }],
          findingCount: 0,
        },
        findings: [],
      };
      const invalidArtifactsDir = reapMk(
        join(tmpdir(), "claudexor-invalid-release-review-artifacts-"),
      );
      try {
        const invalid = await reviewCandidate({
          candidateLabel: "Release candidate",
          diff,
          evidenceDir,
          evidenceReadOnly: true,
          frozenIdentity: {
            candidateSha: "a".repeat(40),
            candidateTree: "b".repeat(40),
            packetManifestSha256: "c".repeat(64),
          },
          env: { CLAUDEXOR_REVIEW_WAVE_ID: "22222222-2222-4222-8222-222222222222" },
          artifactsDir: invalidArtifactsDir,
          cwd,
          reviewers: [{ adapter, providerFamily: "openai", requestedModel: "release-model" }],
        });
        expect(invalid.findings).toHaveLength(1);
        expect(invalid.findings[0]?.severity).toBe("INSUFFICIENT_EVIDENCE");
        expect(
          JSON.parse(
            readFileSync(
              join(invalidArtifactsDir, "01-release-reviewer", "parse-error.json"),
              "utf8",
            ),
          ),
        ).toMatchObject({ error: "invalid_sealed_review_envelope" });
      } finally {
        rmSync(invalidArtifactsDir, { recursive: true, force: true });
      }

      reviewPayload = {
        completion: {
          verdict: "PASS",
          checklist: [
            "sealed_evidence",
            "intent_and_scope",
            "runtime_and_security",
            "tests_and_release",
          ].map((item) => ({ item, completed: true })),
          findingCount: 0,
        },
        findings: [],
      };
      emitDuplicateTypedFinal = true;
      const duplicateArtifactsDir = reapMk(
        join(tmpdir(), "claudexor-duplicate-final-review-artifacts-"),
      );
      try {
        const duplicate = await reviewCandidate({
          candidateLabel: "Release candidate",
          diff,
          evidenceDir,
          evidenceReadOnly: true,
          frozenIdentity: {
            candidateSha: "a".repeat(40),
            candidateTree: "b".repeat(40),
            packetManifestSha256: "c".repeat(64),
          },
          env: { CLAUDEXOR_REVIEW_WAVE_ID: "55555555-5555-4555-8555-555555555555" },
          artifactsDir: duplicateArtifactsDir,
          cwd,
          reviewers: [{ adapter, providerFamily: "openai", requestedModel: "release-model" }],
        });
        expect(duplicate.findings).toHaveLength(1);
        expect(duplicate.findings[0]?.severity).toBe("INSUFFICIENT_EVIDENCE");
        expect(
          JSON.parse(
            readFileSync(
              join(duplicateArtifactsDir, "01-release-reviewer", "parse-error.json"),
              "utf8",
            ),
          ),
        ).toMatchObject({
          error: "invalid_sealed_review_envelope",
          detail: "sealed review requires exactly one typed final message; observed 2",
        });
      } finally {
        rmSync(duplicateArtifactsDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("never retries a transient failure inside one frozen review slot", async () => {
    const { cwd, evidenceDir } = makeReviewWorkspace("claudexor-release-no-retry-");
    const artifactsDir = reapMk(join(tmpdir(), "claudexor-release-no-retry-artifacts-"));
    const diff = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    for (const [name, contents] of [
      ["DIFF.patch", diff],
      ["DIFF_SUMMARY.md", "one release file changed\n"],
      ["FREEZE.json", "{}\n"],
      ["MANIFEST.sha256", "sealed fixture\n"],
    ] as const) {
      writeFileSync(join(evidenceDir, name), contents);
    }
    initGitFixture(cwd);
    let calls = 0;
    const adapter: HarnessAdapter = {
      id: "release-no-retry",
      async discover() {
        throw new Error("not used");
      },
      async doctor() {
        throw new Error("not used");
      },
      async *run(spec) {
        calls += 1;
        const ts = new Date().toISOString();
        yield {
          type: "error",
          session_id: spec.session_id,
          ts,
          error: "stream disconnected",
          transient: { kind: "stream_disconnect", retry_delay_ms: 0 },
        };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    try {
      const result = await reviewCandidate({
        candidateLabel: "Release candidate",
        diff,
        evidenceDir,
        evidenceReadOnly: true,
        frozenIdentity: {
          candidateSha: "a".repeat(40),
          candidateTree: "b".repeat(40),
          packetManifestSha256: "c".repeat(64),
        },
        env: { CLAUDEXOR_REVIEW_WAVE_ID: "33333333-3333-4333-8333-333333333333" },
        artifactsDir,
        cwd,
        reviewers: [
          {
            adapter,
            providerFamily: "openai",
            requestedModel: "gpt-5.6-sol",
            requestedEffort: "xhigh",
          },
        ],
        transientRetryPolicy: { maxRetries: 9, initialDelayMs: 0, maxDelayMs: 0 },
      });
      expect(calls).toBe(1);
      expect(result.findings.some((finding) => finding.severity === "INSUFFICIENT_EVIDENCE")).toBe(
        true,
      );
      expect(
        JSON.parse(
          readFileSync(join(artifactsDir, "01-release-no-retry", "metadata.json"), "utf8"),
        ),
      ).not.toHaveProperty("transient_retry");
      expect(
        JSON.parse(
          readFileSync(join(artifactsDir, "01-release-no-retry", "parse-error.json"), "utf8"),
        ),
      ).toMatchObject({
        error: "invalid_sealed_review_envelope",
        detail: "sealed review requires exactly one typed final message; observed 0",
        reviewer_error: "Reviewer emitted error event: stream disconnected",
      });
      await expect(
        reviewCandidate({
          candidateLabel: "Release candidate",
          diff,
          evidenceDir,
          evidenceReadOnly: true,
          frozenIdentity: {
            candidateSha: "a".repeat(40),
            candidateTree: "b".repeat(40),
            packetManifestSha256: "c".repeat(64),
          },
          env: { CLAUDEXOR_REVIEW_WAVE_ID: "44444444-4444-4444-8444-444444444444" },
          artifactsDir,
          cwd,
          reviewers: [{ adapter, providerFamily: "openai" }],
        }),
      ).rejects.toThrow(/fresh empty artifacts directory/);
      expect(calls).toBe(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});

describe("reviewer artifact paths", () => {
  it("trims a long sanitized suffix before creating reviewer artifact paths", async () => {
    const { cwd, evidenceDir } = makeReviewWorkspace("claudexor-reviewer-slug-");
    const artifactsDir = reapMk(join(tmpdir(), "claudexor-reviewer-slug-artifacts-"));
    const reviewerId = `a${"-".repeat(16 * 1024)}!`;

    await reviewCandidate({
      candidateLabel: "Reviewer slug candidate",
      diff: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      evidenceDir,
      artifactsDir,
      cwd,
      reviewers: [makeReviewer(reviewerId, "openai", [])],
    });

    expect(existsSync(join(artifactsDir, "01-a", "metadata.json"))).toBe(true);
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
    const cwd = reapMk(join(tmpdir(), "claudexor-gate-"));
    const passed = await runGate(
      { id: "a", program: process.execPath, args: ["-e", "process.stdout.write('ok\\n')"] },
      { cwd },
    );
    const failed = await runGate(
      {
        id: "b",
        program: process.execPath,
        args: [
          "-e",
          "process.stdout.write('out\\n'); process.stderr.write('err\\n'); process.exit(3)",
        ],
      },
      { cwd },
    );
    expect(passed.status).toBe("passed");
    expect(passed.stdout_tail).toBe(null);
    expect(failed.status).toBe("failed");
    expect(failed.stdout_tail).toBe("out");
    expect(failed.stderr_tail).toBe("err");
    expect(failed.output_truncated).toBe(false);
    expect(
      gatesPassed([
        await runGate(
          { id: "a", program: process.execPath, args: ["-e", "process.exit(0)"] },
          { cwd },
        ),
      ]),
    ).toBe(true);
  });

  it("marks gate output truncated only when the stored redacted tail is sliced", async () => {
    const cwd = reapMk(join(tmpdir(), "claudexor-gate-trim-"));
    const failed = await runGate(
      {
        id: "trimmed",
        program: process.execPath,
        args: ["-e", "process.stdout.write('kept' + ' '.repeat(13000)); process.exit(3)"],
      },
      { cwd },
    );
    expect(failed.status).toBe("failed");
    expect(failed.stdout_tail).toBe("kept");
    expect(failed.output_truncated).toBe(false);
  });

  it("runs a gate with its fixed env entries on top of the caller's env", async () => {
    const cwd = reapMk(join(tmpdir(), "claudexor-gate-env-"));
    const check =
      "process.exit(process.env.CX_GATE_FIXED === '1' && process.env.CX_GATE_CALLER === 'kept' ? 0 : 4)";
    const gate = await runGate(
      { id: "env", program: process.execPath, args: ["-e", check], env: { CX_GATE_FIXED: "1" } },
      { cwd, env: { CX_GATE_CALLER: "kept" } },
    );
    expect(gate).toMatchObject({ status: "passed", exit_code: 0 });
  });

  it("marks stored output truncated when a leftover kept the gate's pipe open past the drain", async () => {
    // The verdict is still the exit code; only the stored evidence is qualified.
    const cwd = reapMk(join(tmpdir(), "claudexor-gate-drain-"));
    const held = (code: number) =>
      [
        "const {spawn}=require('node:child_process')",
        "process.stdout.write('partial\\n')",
        "spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:['ignore',1,'ignore']})",
        `setTimeout(()=>process.exit(${code}),50)`,
      ].join(";");
    const failed = await runGate(
      { id: "held", program: process.execPath, args: ["-e", held(3)] },
      { cwd },
    );
    expect(failed).toMatchObject({ status: "failed", exit_code: 3, stdout_tail: "partial" });
    expect(failed.output_truncated).toBe(true);
    const passed = await runGate(
      { id: "held-ok", program: process.execPath, args: ["-e", held(0)] },
      { cwd },
    );
    expect(passed).toMatchObject({ status: "passed", stdout_tail: null, output_truncated: false });
  }, 20_000);

  it("requires an exact external grant for versioned project commands", async () => {
    const cwd = reapMk(join(tmpdir(), "claudexor-gate-trust-"));
    writeFileSync(join(cwd, "gate.js"), "require('node:fs').writeFileSync('ran.txt', 'yes')\n");
    const invocation = { program: process.execPath, args: ["gate.js"], envAllowlist: [] };
    const context = { projectRoot: cwd, accessProfile: "workspace_write" as const };
    const ungranted = await runGate(
      { id: "ungranted", ...invocation, trustRequired: true, ...context },
      { cwd },
    );
    expect(ungranted.status).toBe("failed");
    expect(existsSync(join(cwd, "ran.txt"))).toBe(false);

    const grant = buildTestCommandGrant(invocation, cwd, context.accessProfile);
    const trusted = await runGate(
      {
        id: "trusted",
        ...invocation,
        trustRequired: true,
        trustGrant: grant,
        ...context,
      },
      { cwd },
    );
    expect(trusted.status).toBe("passed");
    expect(readFileSync(join(cwd, "ran.txt"), "utf8")).toBe("yes");

    const verifyCwd = reapMk(join(tmpdir(), "claudexor-gate-verify-tree-"));
    writeFileSync(
      join(verifyCwd, "gate.js"),
      "require('node:fs').writeFileSync('ran.txt', 'yes')\n",
    );
    const relocated = await runGate(
      {
        id: "relocated-fresh-tree",
        ...invocation,
        trustRequired: true,
        trustGrant: grant,
        ...context,
      },
      { cwd: verifyCwd },
    );
    expect(relocated.status).toBe("passed");
    expect(readFileSync(join(verifyCwd, "ran.txt"), "utf8")).toBe("yes");

    rmSync(join(cwd, "ran.txt"));
    const changedArg = await runGate(
      {
        id: "changed",
        ...invocation,
        args: ["other.js"],
        trustRequired: true,
        trustGrant: grant,
        ...context,
      },
      { cwd },
    );
    expect(changedArg.status).toBe("failed");
    expect(existsSync(join(cwd, "ran.txt"))).toBe(false);

    mkdirSync(join(cwd, ".claudexor"), { recursive: true });
    writeFileSync(
      join(cwd, ".claudexor", "config.yaml"),
      "version: 1\ncontext:\n  include: [src/**]\n",
    );
    const changedConfig = await runGate(
      {
        id: "changed-config",
        ...invocation,
        trustRequired: true,
        trustGrant: grant,
        ...context,
      },
      { cwd },
    );
    expect(changedConfig.status).toBe("failed");
    rmSync(join(cwd, ".claudexor"), { recursive: true });

    writeFileSync(join(cwd, "gate.js"), "process.exit(0)\n");
    const changedScript = await runGate(
      {
        id: "changed-script",
        ...invocation,
        trustRequired: true,
        trustGrant: grant,
        ...context,
      },
      { cwd },
    );
    expect(changedScript.status).toBe("failed");
  });

  it("revokes a package-manager command when package.json changes", async () => {
    const cwd = reapMk(join(tmpdir(), "claudexor-gate-package-script-"));
    // Use the package manager shipped with Node so the trust test does not ask
    // an unpinned Corepack shim to select a host-global pnpm release.
    const invocation = { program: "npm", args: ["test"], envAllowlist: [] };
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
    );
    const grant = buildTestCommandGrant(invocation, cwd, "workspace_write");
    const spec = {
      id: "package-script",
      ...invocation,
      trustRequired: true,
      trustGrant: grant,
      projectRoot: cwd,
      accessProfile: "workspace_write" as const,
    };
    expect((await runGate(spec, { cwd })).status).toBe("passed");
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } }),
    );
    expect((await runGate(spec, { cwd })).status).toBe("failed");
  });
});

describe("route proof", () => {
  it("verified with observed model, unverified without", () => {
    const observed = buildRouteProof(
      {
        harness_id: "x",
        provider_family: "openai",
        credential_profile_id: "review-a",
      },
      {
        model_id: "gpt",
        credential_profile_id: "review-a",
        evidence_source: "stream_event",
      },
    );
    expect(observed.status).toBe("verified");
    expect(observed.requested.credential_profile_id).toBe("review-a");
    expect(observed.observed.credential_profile_id).toBe("review-a");
    expect(
      buildRouteProof(
        {
          harness_id: "x",
          provider_family: "openai",
          credential_profile_id: "review-a",
        },
        { model_id: "gpt", evidence_source: "stream_event" },
      ).status,
    ).toBe("unverified");
    expect(
      buildRouteProof(
        {
          harness_id: "x",
          provider_family: "openai",
          credential_profile_id: "review-a",
        },
        {
          model_id: "gpt",
          credential_profile_id: "other-profile",
          evidence_source: "stream_event",
        },
      ).status,
    ).toBe("unverified");
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
  it("projects exactly one typed final for sealed reviews", () => {
    const codexEnvelope = '{"completion":{"verdict":"PASS"},"findings":[]}';
    expect(
      sealedReviewTranscriptFromEvents([
        { type: "started", text: "ignored" },
        { type: "message", text: codexEnvelope },
        {
          type: "message",
          text: codexEnvelope,
          final: true,
          payload: { final_source: "last_agent_message" },
        },
      ]),
    ).toBe(`${codexEnvelope}\n`);

    const claudeEnvelope = '{"completion":{"verdict":"FAIL"},"findings":[{}]}';
    expect(
      sealedReviewTranscriptFromEvents([
        { type: "message", text: "I found one issue." },
        {
          type: "message",
          text: `${claudeEnvelope}\n`,
          final: true,
          payload: { final_source: "structured_output" },
        },
      ]),
    ).toBe(`${claudeEnvelope}\n`);

    expect(() =>
      sealedReviewTranscriptFromEvents([{ type: "message", text: codexEnvelope }]),
    ).toThrow(/exactly one typed final message; observed 0/);
    expect(() =>
      sealedReviewTranscriptFromEvents([
        {
          type: "message",
          text: codexEnvelope,
          final: true,
          payload: { final_source: "result" },
        },
        {
          type: "message",
          text: codexEnvelope,
          final: true,
          payload: { final_source: "last_agent_message" },
        },
      ]),
    ).toThrow(/exactly one typed final message; observed 2/);
    expect(
      sealedReviewTranscriptFromEvents([{ type: "message", text: codexEnvelope, final: true }]),
    ).toBe(`${codexEnvelope}\n`);
  });

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
    const candidateRoot = reapMk(join(tmpdir(), "claudexor-revalidate-candidate-"));
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
    const candidateRoot = reapMk(join(tmpdir(), "claudexor-revalidate-candidate-"));
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
    const candidateRoot = reapMk(join(tmpdir(), "claudexor-revalidate-candidate-"));
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

  it("separates native reviewer valuation from API-key cash", async () => {
    const costReviewer = (
      id: string,
      family: ProviderFamily,
      route: "vendor_native" | "managed_api_key",
      cost: number,
    ): ReviewerSpec => ({
      providerFamily: family,
      adapter: {
        id,
        async discover() {
          throw new Error("not used");
        },
        async doctor() {
          throw new Error("not used");
        },
        async *run(spec) {
          const ts = new Date().toISOString();
          yield {
            type: "started" as const,
            session_id: spec.session_id,
            ts,
            observed_model: `${id}-model`,
            credential_route: route,
          };
          yield {
            type: "usage" as const,
            session_id: spec.session_id,
            ts,
            credential_route: route,
            usage: { cost_usd: cost, estimated: false },
          };
          yield {
            type: "message" as const,
            session_id: spec.session_id,
            ts,
            credential_route: route,
            text: "```json\n[]\n```",
          };
          yield { type: "completed" as const, session_id: spec.session_id, ts };
        },
      },
    });
    const result = await reviewCandidate({
      candidateLabel: "Candidate",
      diff: "diff --git a/a b/a\n",
      ...makeReviewWorkspace(),
      reviewers: [
        {
          ...costReviewer("native", "anthropic", "vendor_native", 0.75),
          adapter: {
            ...costReviewer("native", "anthropic", "vendor_native", 0.75).adapter,
            async *run(spec) {
              const ts = new Date().toISOString();
              yield {
                type: "started" as const,
                session_id: spec.session_id,
                ts,
                observed_model: "native-model",
                credential_route: "vendor_native" as const,
              };
              yield {
                type: "usage" as const,
                session_id: spec.session_id,
                ts,
                credential_route: "vendor_native" as const,
                usage: { cost_usd: 0.75, estimated: true },
              };
              yield {
                type: "message" as const,
                session_id: spec.session_id,
                ts,
                credential_route: "vendor_native" as const,
                text: "```json\n[]\n```",
              };
            },
          },
        },
        costReviewer("api", "openai", "managed_api_key", 0.25),
      ],
    });
    expect(result.reviewSpendUsd).toBe(1);
    expect(result.reviewCashUsd).toBe(0.25);
    expect(result.reviewCashKnowledge).toBe("exact");
    expect(result.reviewValuationUsd).toBe(0.75);
    expect(result.reviewValuationKnowledge).toBe("estimated");
    expect(result.reviewUnknownUsd).toBe(0);
  });

  it("keeps proven native zero cash exact without usage and paid or undisclosed routes unknown", async () => {
    const noUsageReviewer = (
      id: string,
      route?: "vendor_native" | "managed_api_key",
    ): ReviewerSpec => ({
      providerFamily: "openai",
      adapter: {
        id,
        async discover() {
          throw new Error("not used");
        },
        async doctor() {
          throw new Error("not used");
        },
        async *run(spec) {
          const ts = new Date().toISOString();
          yield {
            type: "started" as const,
            session_id: spec.session_id,
            ts,
            observed_model: `${id}-model`,
            ...(route ? { credential_route: route } : {}),
          };
          yield {
            type: "message" as const,
            session_id: spec.session_id,
            ts,
            ...(route ? { credential_route: route } : {}),
            text: "```json\n[]\n```",
          };
          yield { type: "completed" as const, session_id: spec.session_id, ts };
        },
      },
    });
    const run = (reviewer: ReviewerSpec) =>
      reviewCandidate({
        candidateLabel: "Candidate",
        diff: "diff --git a/a b/a\n",
        ...makeReviewWorkspace(),
        reviewers: [reviewer],
      });

    await expect(run(noUsageReviewer("native-zero", "vendor_native"))).resolves.toMatchObject({
      reviewCashUsd: 0,
      reviewCashKnowledge: "exact",
      reviewValuationKnowledge: "unknown",
    });
    await expect(run(noUsageReviewer("api-missing", "managed_api_key"))).resolves.toMatchObject({
      reviewCashUsd: 0,
      reviewCashKnowledge: "unknown",
    });
    await expect(run(noUsageReviewer("route-missing"))).resolves.toMatchObject({
      reviewCashUsd: 0,
      reviewCashKnowledge: "unknown",
    });

    const failedNative = noUsageReviewer("native-failed", "vendor_native");
    failedNative.adapter.run = async function* (spec) {
      const ts = new Date().toISOString();
      yield {
        type: "started" as const,
        session_id: spec.session_id,
        ts,
        credential_route: "vendor_native" as const,
      };
      yield {
        type: "error" as const,
        session_id: spec.session_id,
        ts,
        credential_route: "vendor_native" as const,
        error: "native reviewer failed after route proof",
      };
    };
    await expect(run(failedNative)).resolves.toMatchObject({
      reviewCashUsd: 0,
      reviewCashKnowledge: "exact",
    });
  });

  it("classifies each reviewer retry usage by that try's credential route", async () => {
    let invocation = 0;
    const reviewer: ReviewerSpec = {
      providerFamily: "anthropic",
      adapter: {
        id: "route-switch",
        async discover() {
          throw new Error("not used");
        },
        async doctor() {
          throw new Error("not used");
        },
        async *run(spec) {
          invocation += 1;
          const ts = new Date().toISOString();
          const route = invocation === 1 ? "vendor_native" : "managed_api_key";
          yield {
            type: "started" as const,
            session_id: spec.session_id,
            ts,
            observed_model: "review-model",
            credential_route: route,
          };
          yield {
            type: "usage" as const,
            session_id: spec.session_id,
            ts,
            credential_route: route,
            usage: { cost_usd: invocation === 1 ? 0.75 : 0.25 },
          };
          if (invocation === 1) {
            yield {
              type: "status" as const,
              session_id: spec.session_id,
              ts,
              transient: { kind: "network", retry_delay_ms: 0 },
            };
            return;
          }
          yield {
            type: "message" as const,
            session_id: spec.session_id,
            ts,
            text: "```json\n[]\n```",
          };
          yield { type: "completed" as const, session_id: spec.session_id, ts };
        },
      },
    };
    const result = await reviewCandidate({
      candidateLabel: "Candidate",
      diff: "diff --git a/a b/a\n",
      ...makeReviewWorkspace(),
      reviewers: [reviewer],
      transientRetryPolicy: { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 1 },
    });
    expect(invocation).toBe(2);
    expect(result.reviewSpendUsd).toBe(1);
    expect(result.reviewCashUsd).toBe(0.25);
    expect(result.reviewValuationUsd).toBe(0.75);
    expect(result.reviewUnknownUsd).toBe(0);
  });

  it("runs reviewers concurrently while preserving input-ordered results and telemetry", async () => {
    let active = 0;
    let maxActive = 0;
    let releaseReviewers!: () => void;
    const reviewersStarted = new Promise<void>((resolve) => {
      releaseReviewers = resolve;
    });
    const artifactsDir = reapMk(join(tmpdir(), "claudexor-review-artifacts-"));
    const concurrentReviewer = (
      id: string,
      family: ProviderFamily,
      delayMs: number,
    ): ReviewerSpec => {
      const adapter: HarnessAdapter = {
        id,
        async discover() {
          throw new Error("not used");
        },
        async doctor() {
          throw new Error("not used");
        },
        async *run(spec) {
          active++;
          maxActive = Math.max(maxActive, active);
          if (active === 2) releaseReviewers();
          try {
            const ts = new Date().toISOString();
            yield {
              type: "started",
              session_id: spec.session_id,
              ts,
              observed_model: `${id}-model`,
            };
            await reviewersStarted;
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            yield {
              type: "message",
              session_id: spec.session_id,
              ts,
              text: `\`\`\`json\n${JSON.stringify([
                {
                  severity: "WARN",
                  category: "maintainability",
                  claim: `${id} finding`,
                  evidence: { files: [{ path: "DIFF.patch" }] },
                },
              ])}\n\`\`\``,
            };
            yield { type: "completed", session_id: spec.session_id, ts };
          } finally {
            active--;
          }
        },
      };
      return { adapter, providerFamily: family, requestedModel: `${id}-model` };
    };

    const result = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a a",
      ...makeReviewWorkspace(),
      artifactsDir,
      reviewers: [
        concurrentReviewer("slow", "openai", 80),
        concurrentReviewer("fast", "anthropic", 10),
      ],
    });

    expect(maxActive).toBe(2);
    expect(result.reviewerRequests.map((request) => request.harness_id)).toEqual(["slow", "fast"]);
    expect(result.findings.map((finding) => finding.claim)).toEqual([
      "slow finding",
      "fast finding",
    ]);
    for (const [dir, id] of [
      ["01-slow", "slow"],
      ["02-fast", "fast"],
    ] as const) {
      const metadata = readFileSync(join(artifactsDir, dir, "metadata.json"), "utf8");
      expect(metadata).toContain('"start_time"');
      expect(metadata).toContain('"first_event_time"');
      expect(metadata).toContain('"completion_time"');
      expect(metadata).toContain(`"harness_id": "${id}"`);
    }
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
    const artifactsDir = reapMk(join(tmpdir(), "claudexor-review-artifacts-"));
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
    const artifactsDir = reapMk(join(tmpdir(), "claudexor-review-artifacts-"));
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
    let scratchHome = "";
    const artifactsDir = reapMk(join(tmpdir(), "claudexor-review-artifacts-"));
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
        scratchHome = spec.env?.HOME ?? "";
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
    expect(scratchHome).not.toBe("");
    expect(existsSync(scratchHome)).toBe(false);
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

  it("cancels every active reviewer immediately when the parent run signal aborts", async () => {
    let childSignal: AbortSignal | undefined;
    let secondSignal: AbortSignal | undefined;
    let secondStarted = false;
    let ready = 0;
    let releaseBoth!: () => void;
    const bothReady = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const waitForBoth = async () => {
      ready++;
      if (ready === 2) releaseBoth();
      await bothReady;
    };
    const artifactsDir = reapMk(join(tmpdir(), "claudexor-review-artifacts-"));
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
        await waitForBoth();
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
      async *run(spec) {
        secondStarted = true;
        secondSignal = spec.extra["abortSignal"] as AbortSignal | undefined;
        await waitForBoth();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts: new Date().toISOString(),
          observed_model: "second-model",
        };
        await new Promise<void>((resolve) => {
          if (secondSignal?.aborted) {
            resolve();
            return;
          }
          secondSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
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
    expect(secondStarted).toBe(true);
    expect(secondSignal?.aborted).toBe(true);
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

  it("does not launch reviewer adapters when the parent signal is already aborted", async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const spec = makeReviewer("pre-aborted", "openai", []);
    const run = spec.adapter.run.bind(spec.adapter);
    spec.adapter.run = (input) => {
      calls++;
      return run(input);
    };

    const result = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a a",
      ...makeReviewWorkspace(),
      reviewers: [spec],
      signal: controller.signal,
    });

    expect(calls).toBe(0);
    expect(result.reviewerRequests).toHaveLength(1);
    expect(result.routeProofs[0]?.observed.evidence_source).toBe("unavailable");
  });

  it("retries a reviewer once it emits typed transient failure with no output", async () => {
    let calls = 0;
    const artifactsDir = reapMk(join(tmpdir(), "claudexor-review-artifacts-"));
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
    const evidenceDir = reapMk(join(tmpdir(), "claudexor-review-evidence-"));
    const artifactsDir = reapMk(join(tmpdir(), "claudexor-review-artifacts-"));
    const candidateRoot = reapMk(join(tmpdir(), "claudexor-candidate-root-"));
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
    expect(readFileSync(join(artifactsDir, "01-file-backed-reviewer", "prompt.md"), "utf8")).toBe(
      prompt,
    );
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

  it("gives the reviewer the exact credential-shaped diff and prose it reviews (INV-146)", async () => {
    let seenDiff = "";
    let seenIntent = "";
    const evidenceDir = reapMk(join(tmpdir(), "claudexor-review-evidence-"));
    const artifactsDir = reapMk(join(tmpdir(), "claudexor-review-artifacts-"));
    const candidateRoot = reapMk(join(tmpdir(), "claudexor-candidate-root-"));
    writeMandatoryReviewEvidence(evidenceDir);
    const fakeKey = "sk-" + "abcdefghijklmnopqrstuvwxyz";
    writeFileSync(join(evidenceDir, "USER_INTENT.md"), `review prose ${fakeKey}\n`);
    const diff = `diff --git a/.env b/.env\n@@ -1 +1 @@\n-OLD=1\n+OPENAI_API_KEY=${fakeKey}\n`;
    const adapter: HarnessAdapter = {
      id: "exact-evidence-reviewer",
      async discover() {
        return HarnessManifest.parse({
          id: "exact-evidence-reviewer",
          display_name: "exact evidence reviewer",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "exact-evidence-reviewer",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        // The consumer reads its own workspace copy; nothing is echoed back.
        const evidence = join(spec.cwd, ".claudexor-review-evidence");
        seenDiff = readFileSync(join(evidence, "DIFF.patch"), "utf8");
        seenIntent = readFileSync(join(evidence, "USER_INTENT.md"), "utf8");
        const ts = new Date().toISOString();
        yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
      },
    };

    await reviewCandidate({
      candidateLabel: "Candidate A",
      diff,
      evidenceDir,
      artifactsDir,
      cwd: candidateRoot,
      reviewers: [{ adapter, providerFamily: "openai" }],
    });

    expect(seenDiff).toBe(diff);
    expect(seenIntent).toBe(`review prose ${fakeKey}\n`);
    expect(readFileSync(join(artifactsDir, "evidence", "DIFF.patch"), "utf8")).toBe(diff);
    expect(readFileSync(join(artifactsDir, "evidence", "USER_INTENT.md"), "utf8")).toContain(
      fakeKey,
    );
  });

  it("fails closed on incomplete mandatory evidence before starting reviewers", async () => {
    let reviewerStarted = false;
    const evidenceDir = reapMk(join(tmpdir(), "claudexor-review-evidence-"));
    const artifactsDir = reapMk(join(tmpdir(), "claudexor-review-artifacts-"));
    const candidateRoot = reapMk(join(tmpdir(), "claudexor-candidate-root-"));
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
    const candidateRoot = reapMk(join(tmpdir(), "claudexor-candidate-root-"));
    const evidenceDir = reapMk(join(tmpdir(), "claudexor-review-evidence-"));
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
    const candidateRoot = reapMk(join(tmpdir(), "claudexor-candidate-root-"));
    const evidenceDir = reapMk(join(tmpdir(), "claudexor-review-evidence-"));
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
    const candidateRoot = reapMk(join(tmpdir(), "claudexor-candidate-root-"));
    const evidenceDir = reapMk(join(tmpdir(), "claudexor-review-evidence-"));
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
    const candidateRoot = reapMk(join(tmpdir(), "claudexor-candidate-root-"));
    const evidenceDir = reapMk(join(tmpdir(), "claudexor-review-evidence-"));
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
    const candidateRoot = reapMk(join(tmpdir(), "claudexor-candidate-root-"));
    const evidenceDir = reapMk(join(tmpdir(), "claudexor-review-evidence-"));
    const artifactsDir = join(candidateRoot, "review-artifacts");
    const outsideDir = reapMk(join(tmpdir(), "claudexor-outside-secret-"));
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
    initGitFixture(candidateRoot);
    gitAddFixture(candidateRoot, [
      "candidate.txt",
      "safe-target.txt",
      "safe-link",
      "relocates-outside-link",
      "artifact-link",
      "outside-link",
    ]);
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
        safeLinkVisible = pathEntryExists(join(spec.cwd, "safe-link"));
        relocatesOutsideLinkVisible = pathEntryExists(join(spec.cwd, "relocates-outside-link"));
        artifactLinkVisible = pathEntryExists(join(spec.cwd, "artifact-link"));
        outsideLinkVisible = pathEntryExists(join(spec.cwd, "outside-link"));
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
    const candidateRoot = reapMk(join(tmpdir(), "claudexor-candidate-root-"));
    const evidenceDir = reapMk(join(tmpdir(), "claudexor-review-evidence-"));
    writeMandatoryReviewEvidence(evidenceDir);
    const templateDir = reapMk(join(tmpdir(), "claudexor-git-template-"));
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
    const candidateRoot = reapMk(join(tmpdir(), "claudexor-candidate-root-"));
    const evidenceDir = join(candidateRoot, ".claudexor", "runs", "run-x", "review-evidence");
    const artifactsDir = reapMk(join(tmpdir(), "claudexor-review-artifacts-"));
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
    const candidateRoot = reapMk(join(tmpdir(), "claudexor-candidate-root-"));
    const evidenceDir = reapMk(join(tmpdir(), "claudexor-review-evidence-"));
    const artifactsDir = reapMk(join(tmpdir(), "claudexor-review-artifacts-"));
    mkdirSync(join(candidateRoot, ".claudexor", "runs", "run-x"), { recursive: true });
    writeFileSync(
      join(candidateRoot, ".claudexor", "config.yaml"),
      "context:\n  mandatory_files: [README.md]\n",
    );
    writeFileSync(join(candidateRoot, ".claudexor", "runs", "run-x", "events.jsonl"), "{}\n");
    writeFileSync(join(candidateRoot, ".claudexor", ".gitignore"), "*\n");
    writeFileSync(join(candidateRoot, "README.md"), "candidate docs\n");
    initGitFixture(candidateRoot);
    gitAddFixture(candidateRoot, [".claudexor/config.yaml", "README.md"]);
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
    const candidateRoot = reapMk(join(tmpdir(), "claudexor-candidate-root-"));
    const evidenceDir = reapMk(join(tmpdir(), "claudexor-review-evidence-"));
    const artifactsDir = reapMk(join(tmpdir(), "claudexor-review-artifacts-"));
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

  it("copies Git-visible and diff-touched files without ignored local siblings", async () => {
    const candidateRoot = reapMk(join(tmpdir(), "claudexor-candidate-root-"));
    const evidenceDir = reapMk(join(tmpdir(), "claudexor-review-evidence-"));
    const artifactsDir = reapMk(join(tmpdir(), "claudexor-review-artifacts-"));
    mkdirSync(join(candidateRoot, "ignored"), { recursive: true });
    writeFileSync(
      join(candidateRoot, ".gitignore"),
      "AGENTS.md\nignored/\nold.txt\ndeleted.txt\nblob.bin\n",
    );
    writeFileSync(join(candidateRoot, "README.md"), "candidate docs\n");
    writeFileSync(join(candidateRoot, "new.txt"), "renamed candidate postimage\n");
    writeFileSync(join(candidateRoot, "visible-untracked.txt"), "ordinary candidate context\n");
    writeFileSync(join(candidateRoot, "AGENTS.md"), "private local operator guidance\n");
    writeFileSync(join(candidateRoot, "old.txt"), "private ignored rename replacement\n");
    writeFileSync(join(candidateRoot, "deleted.txt"), "private ignored deletion replacement\n");
    writeFileSync(join(candidateRoot, "blob.bin"), "private ignored binary replacement\n");
    writeFileSync(join(candidateRoot, "ignored", "changed.ts"), "export const changed = true;\n");
    writeFileSync(join(candidateRoot, "ignored", "private-notes.md"), "private sibling\n");
    initGitFixture(candidateRoot);
    gitAddFixture(candidateRoot, [".gitignore", "README.md", "new.txt"]);
    writeMandatoryReviewEvidence(evidenceDir);

    let visibility: Record<string, boolean> = {};
    const reviewer = makeWorkspaceProbeReviewer("candidate-inventory-reviewer", (cwd) => {
      visibility = {
        tracked: existsSync(join(cwd, "README.md")),
        untrackedVisible: existsSync(join(cwd, "visible-untracked.txt")),
        diffTouchedIgnored: existsSync(join(cwd, "ignored", "changed.ts")),
        ignoredSibling: existsSync(join(cwd, "ignored", "private-notes.md")),
        localInstructions: existsSync(join(cwd, "AGENTS.md")),
        renamePostimage: existsSync(join(cwd, "new.txt")),
        renameOldReplacement: existsSync(join(cwd, "old.txt")),
        deletedReplacement: existsSync(join(cwd, "deleted.txt")),
        binaryDeletedReplacement: existsSync(join(cwd, "blob.bin")),
      };
    });

    const diff = [
      "diff --git a/README.md b/README.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/ignored/changed.ts b/ignored/changed.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/ignored/changed.ts",
      "@@ -0,0 +1 @@",
      "+export const changed = true;",
      "diff --git a/old.txt b/new.txt",
      "similarity index 100%",
      "rename from old.txt",
      "rename to new.txt",
      "diff --git a/deleted.txt b/deleted.txt",
      "deleted file mode 100644",
      "--- a/deleted.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-deleted candidate preimage",
      "diff --git a/blob.bin b/blob.bin",
      "deleted file mode 100644",
      "index 1234567..0000000",
      "GIT binary patch",
      "literal 0",
      "HcmV?d00001",
    ].join("\n");
    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff,
      evidenceDir,
      artifactsDir,
      cwd: candidateRoot,
      reviewers: [reviewer],
    });

    expect(res.findings).toEqual([]);
    expect(visibility).toEqual({
      tracked: true,
      untrackedVisible: true,
      diffTouchedIgnored: true,
      ignoredSibling: false,
      localInstructions: false,
      renamePostimage: true,
      renameOldReplacement: false,
      deletedReplacement: false,
      binaryDeletedReplacement: false,
    });
  });

  it.skipIf(process.platform === "win32")(
    "keeps POSIX backslashes distinct from directory separators in the candidate inventory",
    async () => {
      const candidateRoot = reapMk(join(tmpdir(), "claudexor-candidate-root-"));
      const evidenceDir = join(candidateRoot, "..\\review-evidence");
      const artifactsDir = reapMk(join(tmpdir(), "claudexor-review-artifacts-"));
      mkdirSync(join(candidateRoot, "safe"));
      writeFileSync(join(candidateRoot, ".gitignore"), "safe/\n");
      writeFileSync(join(candidateRoot, "README.md"), "candidate docs\n");
      writeFileSync(join(candidateRoot, "safe\\private.txt"), "tracked literal backslash\n");
      writeFileSync(
        join(candidateRoot, "safe\\node_modules\\code.ts"),
        "tracked literal separators\n",
      );
      writeFileSync(join(candidateRoot, "safe", "private.txt"), "ignored local sibling\n");
      initGitFixture(candidateRoot);
      gitAddFixture(candidateRoot, [
        ".gitignore",
        "README.md",
        "safe\\private.txt",
        "safe\\node_modules\\code.ts",
      ]);
      writeMandatoryReviewEvidence(evidenceDir);

      let trackedBackslash = false;
      let trackedBlockedName = false;
      let ignoredSeparatorSibling = true;
      let sourceEvidenceVisible = true;
      const reviewer = makeWorkspaceProbeReviewer("posix-path-reviewer", (cwd) => {
        trackedBackslash = existsSync(join(cwd, "safe\\private.txt"));
        trackedBlockedName = existsSync(join(cwd, "safe\\node_modules\\code.ts"));
        ignoredSeparatorSibling = existsSync(join(cwd, "safe", "private.txt"));
        sourceEvidenceVisible = existsSync(join(cwd, "..\\review-evidence", "USER_INTENT.md"));
      });

      const res = await reviewCandidate({
        candidateLabel: "Candidate A",
        diff: "diff --git a/README.md b/README.md\n@@ -1 +1 @@\n-old\n+new\n",
        evidenceDir,
        artifactsDir,
        cwd: candidateRoot,
        reviewers: [reviewer],
      });

      expect(res.findings).toEqual([]);
      expect(trackedBackslash).toBe(true);
      expect(trackedBlockedName).toBe(true);
      expect(ignoredSeparatorSibling).toBe(false);
      expect(sourceEvidenceVisible).toBe(false);
    },
  );

  it("keeps an aliased in-tree source evidence directory out of the candidate plane", async () => {
    const candidateRoot = reapMk(join(tmpdir(), "claudexor-candidate-root-"));
    const aliasRoot = reapMk(join(tmpdir(), "claudexor-candidate-alias-"));
    const candidateAlias = join(aliasRoot, "candidate");
    symlinkSync(candidateRoot, candidateAlias, "dir");
    const realEvidenceDir = join(candidateRoot, "real-evidence");
    const evidenceDir = join(candidateAlias, "review-material");
    const artifactsDir = reapMk(join(tmpdir(), "claudexor-review-artifacts-"));
    writeFileSync(join(candidateRoot, "README.md"), "candidate docs\n");
    writeMandatoryReviewEvidence(realEvidenceDir);
    symlinkSync("real-evidence", join(candidateRoot, "review-material"), "dir");
    initGitFixture(candidateRoot);
    gitAddFixture(candidateRoot, ["README.md"]);

    let sourceEvidenceVisible = true;
    let sourceEvidenceTargetVisible = true;
    let canonicalEvidenceVisible = false;
    const reviewer = makeWorkspaceProbeReviewer("evidence-plane-reviewer", (cwd) => {
      sourceEvidenceVisible = pathEntryExists(join(cwd, "review-material"));
      sourceEvidenceTargetVisible = pathEntryExists(join(cwd, "real-evidence", "USER_INTENT.md"));
      canonicalEvidenceVisible = existsSync(
        join(cwd, ".claudexor-review-evidence", "USER_INTENT.md"),
      );
    });

    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a/README.md b/README.md\n@@ -1 +1 @@\n-old\n+new\n",
      evidenceDir,
      artifactsDir,
      cwd: candidateAlias,
      reviewers: [reviewer],
    });

    expect(res.findings).toEqual([]);
    expect(sourceEvidenceVisible).toBe(false);
    expect(sourceEvidenceTargetVisible).toBe(false);
    expect(canonicalEvidenceVisible).toBe(true);
  });

  it("rejects an evidence directory that contains the candidate root", async () => {
    const evidenceDir = reapMk(join(tmpdir(), "claudexor-review-parent-evidence-"));
    const candidateRoot = join(evidenceDir, "candidate");
    mkdirSync(candidateRoot);
    writeMandatoryReviewEvidence(evidenceDir);

    await expect(
      reviewCandidate({
        candidateLabel: "Candidate A",
        diff: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
        evidenceDir,
        cwd: candidateRoot,
        reviewers: [makeReviewer("must-not-start", "openai", [])],
      }),
    ).rejects.toThrow(/evidence directory must not contain the candidate root/);
  });

  it("limits non-Git reviewer workspaces to diff-touched postimages", async () => {
    const candidateRoot = reapMk(join(tmpdir(), "claudexor-candidate-root-"));
    const evidenceDir = reapMk(join(tmpdir(), "claudexor-review-evidence-"));
    const artifactsDir = reapMk(join(tmpdir(), "claudexor-review-artifacts-"));
    writeFileSync(join(candidateRoot, "changed.ts"), "export const changed = true;\n");
    writeFileSync(join(candidateRoot, "private-notes.md"), "unrelated local prose\n");
    writeMandatoryReviewEvidence(evidenceDir);

    let sawChanged = false;
    let sawSibling = true;
    const reviewer = makeWorkspaceProbeReviewer("non-git-inventory-reviewer", (cwd) => {
      sawChanged = existsSync(join(cwd, "changed.ts"));
      sawSibling = existsSync(join(cwd, "private-notes.md"));
    });

    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: ["diff --git a/changed.ts b/changed.ts", "@@ -1 +1 @@", "-old", "+new"].join("\n"),
      evidenceDir,
      artifactsDir,
      cwd: candidateRoot,
      reviewers: [reviewer],
    });

    expect(res.findings).toEqual([]);
    expect(sawChanged).toBe(true);
    expect(sawSibling).toBe(false);
    expect(
      JSON.parse(readFileSync(join(artifactsDir, "evidence", "metadata.json"), "utf8"))
        .candidate_inventory_mode,
    ).toBe("diff_only");
  });

  it("tracks copied candidate files even when candidate gitignore ignores them", async () => {
    const candidateRoot = reapMk(join(tmpdir(), "claudexor-candidate-root-"));
    const evidenceDir = reapMk(join(tmpdir(), "claudexor-review-evidence-"));
    const artifactsDir = reapMk(join(tmpdir(), "claudexor-review-artifacts-"));
    writeFileSync(join(candidateRoot, ".gitignore"), "ignored-but-versioned.txt\n");
    writeFileSync(join(candidateRoot, "ignored-but-versioned.txt"), "tracked despite ignore\n");
    writeFileSync(join(candidateRoot, "README.md"), "candidate docs\n");
    initGitFixture(candidateRoot);
    gitAddFixture(candidateRoot, [".gitignore", "ignored-but-versioned.txt", "README.md"]);
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

  it("copies credential-named and credential-shaped candidate files into reviewer workspaces exactly (INV-146)", async () => {
    const candidateRoot = reapMk(join(tmpdir(), "claudexor-candidate-root-"));
    const evidenceDir = reapMk(join(tmpdir(), "claudexor-review-evidence-"));
    const artifactsDir = reapMk(join(tmpdir(), "claudexor-review-artifacts-"));
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
    mkdirSync(join(candidateRoot, "packages", "secrets", "src"), { recursive: true });
    writeFileSync(join(candidateRoot, "packages", "secrets", "src", "index.ts"), "export {};\n");
    mkdirSync(join(candidateRoot, "secrets"), { recursive: true });
    writeFileSync(join(candidateRoot, "secrets", "service.json"), "{}\n");
    writeFileSync(join(candidateRoot, "README.md"), "candidate docs\n");
    initGitFixture(candidateRoot);
    gitAddFixture(candidateRoot, [
      ".env",
      ".envrc",
      ".env.local",
      ".env.example",
      "signing.key",
      "credentials.json",
      "notes.txt",
      "env-alias",
      ".npmrc",
      ".netrc",
      ".ssh/id_ed25519",
      ".cursor/state.json",
      ".codex/auth.json",
      ".claude/session.json",
      "packages/secrets/src/index.ts",
      "secrets/service.json",
      "README.md",
    ]);
    writeMandatoryReviewEvidence(evidenceDir);

    const expected = [
      ".env",
      ".envrc",
      ".env.local",
      ".env.example",
      "signing.key",
      "credentials.json",
      "notes.txt",
      "env-alias",
      ".npmrc",
      ".netrc",
      ".ssh/id_ed25519",
      ".cursor/state.json",
      ".codex/auth.json",
      ".claude/session.json",
      "packages/secrets/src/index.ts",
      "secrets/service.json",
    ];
    const seen = new Map<string, string | null>();
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
        for (const path of expected)
          seen.set(
            path,
            existsSync(join(spec.cwd, path)) ? readFileSync(join(spec.cwd, path), "utf8") : null,
          );
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
    for (const path of expected)
      expect(seen.get(path), path).toBe(readFileSync(join(candidateRoot, path), "utf8"));
    expect(seen.get("notes.txt")).toContain(jwt);
  });

  it("isolates reviewer workspace setup failures to the failing reviewer", async () => {
    const missingCandidateRoot = join(tmpdir(), `claudexor-missing-candidate-${Date.now()}`);
    const evidenceDir = reapMk(join(tmpdir(), "claudexor-review-evidence-"));
    const artifactsDir = reapMk(join(tmpdir(), "claudexor-review-artifacts-"));
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
    const artifactsDir = reapMk(join(tmpdir(), "claudexor-review-artifacts-"));
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
    const artifactsDir = reapMk(join(tmpdir(), "claudexor-review-artifacts-"));
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

  it("gives parallel pinned reviewer slots distinct scratch homes and preserves profile identity", async () => {
    const { cwd: candidateRoot, evidenceDir } = makeReviewWorkspace(
      "claudexor-review-profile-isolation-candidate-",
    );
    const artifactsDir = reapMk(join(tmpdir(), "claudexor-review-artifacts-"));
    const homes = new Map<string, string>();
    const unpinned = new Map<string, boolean>();
    const profile = (id: string, harness: string): CredentialProfile => ({
      profile_id: id,
      harness_id: harness,
      display_name: id,
      credential_kind: "config_dir_login",
      isolation_locator: `/tmp/${harness}-${id}`,
      secret_ref: null,
      enabled: true,
      created_at: null,
    });
    const reviewer = (
      id: string,
      family: ProviderFamily,
      pinned: CredentialProfile,
      selection: Pick<ReviewerSpec, "profilePinned"> = {},
    ): ReviewerSpec => {
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
          return ConformanceReport.parse({
            harness_id: id,
            status: "ok",
            enabled_intents: ["review"],
          });
        },
        async *run(spec) {
          homes.set(id, spec.env?.HOME ?? "");
          unpinned.set(id, credentialProfileUnpinned(spec));
          expect(spec.credential_profile?.profile_id).toBe(pinned.profile_id);
          const ts = new Date().toISOString();
          yield {
            type: "started",
            session_id: spec.session_id,
            ts,
            observed_model: `${id}-model`,
            credential_profile_id: pinned.profile_id,
          };
          yield { type: "message", session_id: spec.session_id, ts, text: "[]\n" };
          yield { type: "completed", session_id: spec.session_id, ts };
        },
      };
      return { adapter, providerFamily: family, credentialProfile: pinned, ...selection };
    };

    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-old\n+new\n",
      evidenceDir,
      artifactsDir,
      cwd: candidateRoot,
      reviewers: [
        reviewer("profile-review-a", "openai", profile("a", "profile-review-a")),
        reviewer("profile-review-b", "anthropic", profile("b", "profile-review-b"), {
          profilePinned: false,
        }),
      ],
    });

    expect(res.findings).toEqual([]);
    // #363: only a pool-chosen seat reaches its adapter as unpinned; a seat
    // with no pin fact keeps the strict pin contract.
    expect(unpinned.get("profile-review-a")).toBe(false);
    expect(unpinned.get("profile-review-b")).toBe(true);
    expect(homes.get("profile-review-a")).toBeTruthy();
    expect(homes.get("profile-review-b")).toBeTruthy();
    expect(homes.get("profile-review-a")).not.toBe(homes.get("profile-review-b"));
    expect(res.routeProofs[0]?.observed.credential_profile_id).toBe("a");
    expect(res.routeProofs[1]?.observed.credential_profile_id).toBe("b");
    const metadataA = readFileSync(
      join(artifactsDir, "01-profile-review-a", "metadata.json"),
      "utf8",
    );
    const metadataB = readFileSync(
      join(artifactsDir, "02-profile-review-b", "metadata.json"),
      "utf8",
    );
    expect(metadataA).toContain('"credential_profile_id": "a"');
    expect(metadataB).toContain('"credential_profile_id": "b"');
  });

  it("isolates duplicate same-harness slots and cleans a failed sibling independently", async () => {
    const { cwd: candidateRoot, evidenceDir } = makeReviewWorkspace(
      "claudexor-review-duplicate-isolation-candidate-",
    );
    const artifactsDir = reapMk(join(tmpdir(), "claudexor-review-artifacts-"));
    const profile = (id: string): CredentialProfile => ({
      profile_id: id,
      harness_id: "same-harness-reviewer",
      display_name: id,
      credential_kind: "config_dir_login",
      isolation_locator: `/tmp/same-harness-${id}`,
      secret_ref: null,
      enabled: true,
      created_at: null,
    });
    const seen = new Map<
      string,
      { home: string; claudeConfig: string; cwd: string; profile: string }
    >();
    let failReady!: () => void;
    const failedReviewerReady = new Promise<void>((resolve) => {
      failReady = resolve;
    });
    let failRelease!: () => void;
    const allowFailedReviewerToExit = new Promise<void>((resolve) => {
      failRelease = resolve;
    });
    let failedCleanupObservedWhileSuccessRunning = false;
    const adapter: HarnessAdapter = {
      id: "same-harness-reviewer",
      async discover() {
        return HarnessManifest.parse({
          id: "same-harness-reviewer",
          display_name: "same harness",
          kind: "local_cli",
          provider_family: "openai",
          capabilities: { review: true, structured_output: true },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "same-harness-reviewer",
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        const profileId = spec.credential_profile?.profile_id ?? "missing";
        const home = spec.env?.HOME ?? "";
        const claudeConfig = spec.env?.CLAUDE_CONFIG_DIR ?? "";
        seen.set(profileId, {
          home,
          claudeConfig,
          cwd: spec.cwd,
          profile: spec.credential_profile?.isolation_locator ?? "",
        });
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: `same-harness-${profileId}`,
          credential_profile_id: profileId,
        };
        if (profileId === "failed") {
          failReady();
          await allowFailedReviewerToExit;
          throw new Error("intentional sibling failure");
        }

        await failedReviewerReady;
        failRelease();
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const failed = seen.get("failed");
          if (
            failed &&
            !existsSync(failed.home) &&
            !existsSync(failed.cwd) &&
            existsSync(home) &&
            existsSync(spec.cwd)
          ) {
            failedCleanupObservedWhileSuccessRunning = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        yield {
          type: "message",
          session_id: spec.session_id,
          ts: new Date().toISOString(),
          text: "[]\n",
        };
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    };

    const res = await reviewCandidate({
      candidateLabel: "Candidate A",
      diff: "diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-old\n+new\n",
      evidenceDir,
      artifactsDir,
      cwd: candidateRoot,
      reviewers: [
        { adapter, providerFamily: "openai", credentialProfile: profile("failed") },
        { adapter, providerFamily: "openai", credentialProfile: profile("successful") },
      ],
      transientRetryPolicy: { maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0 },
    });

    const failed = seen.get("failed");
    const successful = seen.get("successful");
    expect(failed).toBeDefined();
    expect(successful).toBeDefined();
    expect(failed?.home).not.toBe(successful?.home);
    expect(failed?.claudeConfig).not.toBe(successful?.claudeConfig);
    expect(failed?.cwd).not.toBe(successful?.cwd);
    expect(failed?.profile).not.toBe(successful?.profile);
    expect(failedCleanupObservedWhileSuccessRunning).toBe(true);
    expect(existsSync(failed?.home ?? "")).toBe(false);
    expect(existsSync(failed?.cwd ?? "")).toBe(false);
    expect(existsSync(successful?.home ?? "")).toBe(false);
    expect(existsSync(successful?.cwd ?? "")).toBe(false);
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]?.severity).toBe("INSUFFICIENT_EVIDENCE");
    expect(res.findings[0]?.claim).toContain("intentional sibling failure");
    expect(res.routeProofs[0]?.requested.credential_profile_id).toBe("failed");
    expect(res.routeProofs[1]?.observed.credential_profile_id).toBe("successful");
    expect(res.healthyProviders).toEqual(["openai"]);
    expect(
      readFileSync(join(artifactsDir, "01-same-harness-reviewer", "metadata.json"), "utf8"),
    ).toContain('"reviewer_workspace_cleanup": "removed"');
    expect(
      readFileSync(join(artifactsDir, "02-same-harness-reviewer", "metadata.json"), "utf8"),
    ).toContain('"reviewer_workspace_cleanup": "removed"');
  });

  it("does not persist evidence symlinks that resolve outside the source evidence dir", async () => {
    const { cwd: candidateRoot, evidenceDir } = makeReviewWorkspace(
      "claudexor-review-evidence-symlink-candidate-",
    );
    const externalRoot = reapMk(join(tmpdir(), "claudexor-review-external-"));
    const artifactsDir = reapMk(join(tmpdir(), "claudexor-review-artifacts-"));
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
    const artifactsDir = reapMk(join(tmpdir(), "claudexor-review-artifacts-"));
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
    const { __testExtractDiffPostimagePaths } = await import("./reviewEngine.js");
    const diff = [
      'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
      "index 000..111 100644",
      '--- "a/caf\\303\\251.txt"',
      '+++ "b/caf\\303\\251.txt"',
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    const paths = __testExtractDiffPostimagePaths(diff);
    expect([...paths]).toContain("café.txt");
  });

  it("includes only candidate postimages for renames and deletions", async () => {
    const { __testExtractDiffPostimagePaths } = await import("./reviewEngine.js");
    const diff = [
      "diff --git a/old.txt b/new.txt",
      "similarity index 100%",
      "rename from old.txt",
      "rename to new.txt",
      "diff --git a/deleted.txt b/deleted.txt",
      "deleted file mode 100644",
      "--- a/deleted.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-deleted candidate preimage",
      "diff --git a/blob.bin b/blob.bin",
      "deleted file mode 100644",
      "index 1234567..0000000",
      "GIT binary patch",
      "literal 0",
      "HcmV?d00001",
      "",
    ].join("\n");

    expect([...__testExtractDiffPostimagePaths(diff)]).toEqual(["new.txt"]);
  });
});

describe("reviewer dispatch consumes ONE prepared result (model-id effort carrier)", () => {
  it("--model == processing.submittedNative == prepared model; the effort receipt lands in the reviewer artifact once", async () => {
    const { cwd, evidenceDir } = makeReviewWorkspace("claudexor-review-effort-variant-");
    const artifactsDir = reapMk(join(tmpdir(), "claudexor-review-effort-variant-artifacts-"));
    initGitFixture(cwd);
    const seen: Array<{ model: string | null; effort: string | null; sent: string | null }> = [];
    const adapter: HarnessAdapter = {
      id: "variant-reviewer",
      effortParameter: "--model",
      async discover() {
        throw new Error("not used");
      },
      async doctor() {
        throw new Error("not used");
      },
      async prepareProcessing(spec) {
        // The adapter's preparation: level first (max → the listed xhigh), one result.
        expect(spec).toMatchObject({ model: "grok-4.7-high", effort: "max" });
        return {
          model: "grok-4.7-xhigh",
          receipt: {
            requested: null,
            submitted: null,
            submittedNative: "grok-4.7-xhigh",
            observed: "unknown",
            observedNative: [],
            reason: null,
            source: "fixture_account_inventory",
          },
          costBasis: { nativeMode: "grok-4.7-xhigh", kind: "unknown", source: "fixture" },
          effort: {
            requested: "max",
            submitted: "xhigh",
            resolution: "downward",
            source: "account_catalog",
            parameter: "--model",
            observed: null,
            observedSource: null,
            reason: "fixture: max placed on grok-4.7 → xhigh",
          },
        };
      },
      async *run(spec) {
        // What a real adapter sends: the receipt's final id, never the hint.
        seen.push({
          model: spec.model_hint ?? null,
          effort: spec.effort_hint ?? null,
          sent: spec.processing?.submittedNative ?? spec.model_hint ?? null,
        });
        const ts = new Date().toISOString();
        yield {
          type: "started",
          session_id: spec.session_id,
          ts,
          observed_model: "grok-4.7-xhigh",
        };
        yield { type: "message", session_id: spec.session_id, ts, text: "[]" };
        yield { type: "completed", session_id: spec.session_id, ts };
      },
    };
    try {
      const result = await reviewCandidate({
        candidateLabel: "Variant candidate",
        diff: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
        evidenceDir,
        artifactsDir,
        cwd,
        reviewers: [
          {
            adapter,
            providerFamily: "cursor",
            requestedModel: "grok-4.7-high",
            requestedEffort: "max",
          },
        ],
      });
      expect(seen).toEqual([{ model: "grok-4.7-high", effort: "max", sent: "grok-4.7-xhigh" }]);
      const dir = join(artifactsDir, "01-variant-reviewer");
      const metadata = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8")) as Record<
        string,
        unknown
      >;
      expect(metadata["requested_model"]).toBe("grok-4.7-high");
      expect(metadata["requested_effort"]).toBe("max");
      expect(metadata["effort_resolution"]).toMatchObject({
        requested: "max",
        submitted: "xhigh",
        resolution: "downward",
        parameter: "--model",
      });
      expect(metadata["ignored_settings"]).toEqual([
        expect.stringContaining("effort=max: downward; submitted=xhigh"),
      ]);
      const stream = readFileSync(join(dir, "raw-normalized-stream.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { effort_resolution?: unknown; type: string });
      expect(stream.filter((event) => event.effort_resolution)).toHaveLength(1);
      // Requested vs observed stay distinct facts on the route proof.
      expect(result.routeProofs[0]).toMatchObject({
        requested: { model_hint: "grok-4.7-high" },
        observed: { model_id: "grok-4.7-xhigh" },
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});
