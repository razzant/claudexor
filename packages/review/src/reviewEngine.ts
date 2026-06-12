import type { HarnessAdapter } from "@claudexor/core";
import type { EffortHint, HarnessEvent, ProviderFamily, ReviewFinding, RouteProof } from "@claudexor/schema";
import { HarnessRunSpec, ReviewFinding as ReviewFindingSchema } from "@claudexor/schema";
import { join } from "node:path";
import { appendLine, ensureDir, newId, nowIso, redactSecrets, sha256, writeJson, writeText } from "@claudexor/util";
import { dedupeFindings, extractJsonBlocks, parseFindingsDetailed, type ReviewerInfo } from "./findings.js";
import { buildRouteProof, classifyDiversity } from "./route.js";

export interface ReviewerSpec {
  adapter: HarnessAdapter;
  providerFamily: ProviderFamily;
  requestedModel?: string | null;
  requestedEffort?: EffortHint | null;
}

export interface ReviewCandidateInput {
  /** Anonymized label (e.g. "Candidate A") — never reveal which model produced it. */
  candidateLabel: string;
  diff: string;
  evidenceDir: string;
  /** Persistent local artifact directory for raw reviewer telemetry. Defaults under evidenceDir for tests. */
  artifactsDir?: string;
  cwd: string;
  reviewers: ReviewerSpec[];
  reviewerTimeoutMs?: number;
  onReviewerEvent?: (event: ReviewerProgressEvent) => void;
}

export interface ReviewCandidateResult {
  findings: ReviewFinding[];
  routeProofs: RouteProof[];
  reviewerRequests: { harness_id: string; provider_family: ProviderFamily; requested_model: string | null; requested_effort: string | null }[];
  /** True only when >=2 distinct provider families returned parseable JSON. Not a route-proof claim. */
  crossFamilyHealthy: boolean;
  healthyProviders: ProviderFamily[];
  /** True only when >=2 distinct provider families have verified route proofs. */
  crossFamilyVerified: boolean;
  distinctProviders: ProviderFamily[];
  /** Observed reviewer panel spend (budget truth: reviewers are paid work). */
  reviewSpendUsd: number;
  reviewSpendEstimated: boolean;
}

const DEFAULT_REVIEWER_TIMEOUT_MS = 5 * 60_000;

export interface ReviewerProgressEvent {
  type: "reviewer.started" | "reviewer.first_event" | "reviewer.completed" | "reviewer.timed_out" | "reviewer.failed";
  harness_id: string;
  provider_family: ProviderFamily;
  requested_model: string | null;
  requested_effort: EffortHint | null;
  observed_model?: string | null;
  observed_source?: RouteProof["observed"]["evidence_source"];
  route_proof_status?: RouteProof["status"];
  artifact_dir: string;
  at: string;
  duration_ms?: number;
  message?: string;
}

interface ReviewerOutput {
  text: string;
  observedModel?: string;
  observedSource: RouteProof["observed"]["evidence_source"];
  artifactDir: string;
  costUsd: number;
  costEstimated: boolean;
}

interface ReviewerArtifactContext {
  dir: string;
  progressPath: string;
  metadataPath: string;
  eventsPath: string;
  transcriptPath: string;
  promptPath: string;
  parsedPath: string;
  parseErrorPath: string;
  metadata: Record<string, unknown>;
}

interface ReviewPatchEvidence {
  diffPath: string;
  summaryPath: string;
  diffSha256: string;
  summary: string;
}

function reviewPrompt(label: string, evidenceDir: string, patch: ReviewPatchEvidence): string {
  return [
    "You are an adversarial code reviewer.",
    `First read the evidence packet in ${evidenceDir} (USER_INTENT.md, FORBIDDEN_FINDINGS.md, PLAN_ACCEPTED.md, DECIDED_TRADEOFFS.md, TESTS.txt, DIFF.patch, DIFF_SUMMARY.md). If a mandatory file is missing, return INSUFFICIENT_EVIDENCE.`,
    `Review ${label}'s change from the file-backed patch artifact, not from this prompt. Full patch: ${patch.diffPath}. Summary: ${patch.summaryPath}. Patch digest: ${patch.diffSha256}.`,
    "Output ONLY a JSON array of findings.",
    `Each finding: {"severity":"BLOCK|FIX_FIRST|WARN|NIT|OUT_OF_SCOPE|INSUFFICIENT_EVIDENCE|NEEDS_HUMAN","category":"correctness|regression|security|performance|maintainability|test_gap|spec_gap|deploy|architecture|ux","claim":"...","evidence":{"files":[{"path":"...","lines":"..."}]},"proposed_fix":"..."}.`,
    "Rules: no evidence => do NOT use BLOCK. Do not relitigate FORBIDDEN_FINDINGS or DECIDED_TRADEOFFS.",
    "",
    "Patch summary (not a replacement for reading DIFF.patch):",
    patch.summary,
  ].join("\n");
}

/**
 * Cross-family review of one anonymized candidate. Each reviewer runs its review
 * intent and emits JSON findings; we attach route proofs and verify the
 * reviewers span >= 2 distinct provider families.
 */
export async function reviewCandidate(input: ReviewCandidateInput): Promise<ReviewCandidateResult> {
  const all: ReviewFinding[] = [];
  const routeProofs: RouteProof[] = [];
  const reviewerRequests: ReviewCandidateResult["reviewerRequests"] = [];
  const healthyFamilies = new Set<ProviderFamily>();
  let reviewSpendUsd = 0;
  let reviewSpendEstimated = false;
  const reviewerTimeoutMs = input.reviewerTimeoutMs ?? DEFAULT_REVIEWER_TIMEOUT_MS;
  const patch = writePatchEvidence(input.evidenceDir, input.diff);
  const artifactsBaseDir = input.artifactsDir ?? join(input.evidenceDir, "reviewer-artifacts");
  ensureDir(artifactsBaseDir);
  const persistentEvidenceDir = join(artifactsBaseDir, "evidence");
  const persistentPatch = writePatchEvidence(persistentEvidenceDir, input.diff);
  writeJson(join(persistentEvidenceDir, "metadata.json"), {
    source_evidence_dir: input.evidenceDir,
    persistent_evidence_dir: persistentEvidenceDir,
    diff_path: persistentPatch.diffPath,
    summary_path: persistentPatch.summaryPath,
    diff_sha256: persistentPatch.diffSha256,
  });
  const artifactByHarness = new Map<string, ReviewerArtifactContext>();

  for (const [index, reviewer] of input.reviewers.entries()) {
    reviewerRequests.push({
      harness_id: reviewer.adapter.id,
      provider_family: reviewer.providerFamily,
      requested_model: reviewer.requestedModel ?? null,
      requested_effort: reviewer.requestedEffort ?? null,
    });
    const artifact = createReviewerArtifactContext(artifactsBaseDir, index, reviewer);
    updateReviewerMetadata(artifact, {
      candidate_evidence_dir: input.evidenceDir,
      persistent_evidence_dir: persistentEvidenceDir,
      persistent_diff_path: persistentPatch.diffPath,
      persistent_summary_path: persistentPatch.summaryPath,
      diff_sha256: persistentPatch.diffSha256,
    });
    artifactByHarness.set(reviewer.adapter.id, artifact);
    const runtimePrompt = reviewPrompt(input.candidateLabel, input.evidenceDir, patch);
    const spec = HarnessRunSpec.parse({
      session_id: newId("rev"),
      intent: "review",
      prompt: runtimePrompt,
      cwd: input.cwd,
      access: "readonly",
      model_hint: reviewer.requestedModel ?? null,
      effort_hint: reviewer.requestedEffort ?? null,
    });
    writeText(
      artifact.promptPath,
      redactSecrets(`Persistent local replay evidence:
- evidence_dir: ${persistentEvidenceDir}
- diff_path: ${persistentPatch.diffPath}
- diff_sha256: ${persistentPatch.diffSha256}

Runtime prompt used during review follows. Its candidate-tree evidence paths may be transient after orchestrator cleanup; use the durable replay paths above for audit/replay.

${runtimePrompt}
`),
    );

    let text = "";
    let observedModel: string | undefined;
    let observedSource: RouteProof["observed"]["evidence_source"] = "unavailable";
    let reviewerError: string | null = null;
    try {
      const out = await collectReviewerOutput(reviewer, spec, reviewerTimeoutMs, artifact, input.onReviewerEvent);
      text = out.text;
      observedModel = out.observedModel;
      observedSource = out.observedSource;
      reviewSpendUsd += out.costUsd;
      if (out.costEstimated) reviewSpendEstimated = true;
      // accepted_model_arg semantics: when WE passed an explicit model argument
      // and the native CLI completed without rejecting it, the accepted argv is
      // metadata-level route evidence (weaker than stream-observed, stronger
      // than nothing). Some CLIs (codex exec --json) never echo the model.
      if (!observedModel && reviewer.requestedModel) {
        observedModel = reviewer.requestedModel;
        observedSource = "metadata";
      }
    } catch (err) {
      reviewerError = redactSecrets(err instanceof Error ? err.message : String(err));
      // Budget truth: a reviewer that streamed paid tokens then timed out/failed
      // still spent money. Fold the partial cost into the ledger (the success
      // path adds out.costUsd above; these paths are mutually exclusive).
      const partial = err as { partialCostUsd?: number; partialCostEstimated?: boolean };
      if (partial && typeof partial.partialCostUsd === "number" && partial.partialCostUsd > 0) {
        reviewSpendUsd += partial.partialCostUsd;
        if (partial.partialCostEstimated) reviewSpendEstimated = true;
      }
      writeParseError(artifact, { error: reviewerError });
    }

    const proof = buildRouteProof(
      {
        harness_id: reviewer.adapter.id,
        provider_family: reviewer.providerFamily,
        model_hint: reviewer.requestedModel ?? null,
      },
      {
        provider: reviewer.providerFamily,
        model_id: observedModel ?? null,
        evidence_source: observedModel ? observedSource : "unavailable",
      },
    );
    routeProofs.push(proof);

    const info: ReviewerInfo = {
      harness_id: reviewer.adapter.id,
      requested_model: reviewer.requestedModel ?? null,
      requested_effort: reviewer.requestedEffort ?? null,
      observed_model: observedModel ?? null,
      route_proof_status: proof.status,
    };
    if (reviewerError) {
      all.push(insufficientEvidenceFinding(info, `Reviewer failed: ${reviewerError}`));
      continue;
    }
    const jsonBlocks = extractJsonBlocks(text);
    writeJson(artifact.parsedPath, redactValue(jsonBlocks));
    if (text.trim() === "" || jsonBlocks.length === 0) {
      writeParseError(artifact, { error: "no_parseable_json", text_sha256: sha256(text) });
      all.push(insufficientEvidenceFinding(info, "Reviewer produced no parseable JSON findings."));
      continue;
    }
    const parsed = parseFindingsDetailed(text, info);
    if (parsed.malformed > 0) {
      writeParseError(artifact, { error: "malformed_findings", malformed: parsed.malformed, text_sha256: sha256(text) });
      all.push(insufficientEvidenceFinding(info, `Reviewer produced ${parsed.malformed} malformed finding item(s).`));
      continue;
    }
    if (reviewer.providerFamily !== "unknown") healthyFamilies.add(reviewer.providerFamily);
    all.push(...parsed.findings);
  }

  const classifiedProofs = classifyDiversity(routeProofs);
  for (const proof of classifiedProofs) {
    const artifact = artifactByHarness.get(proof.requested.harness_id);
    if (artifact) {
      updateReviewerMetadata(artifact, {
        route_proof_status: proof.status,
        route_proof: proof,
      });
    }
  }
  const proofStatusByHarness = new Map(classifiedProofs.map((p) => [p.requested.harness_id, p.status]));
  const findings = all.map((f) => {
    const status = proofStatusByHarness.get(f.reviewer.harness_id);
    if (!status || f.reviewer.route_proof_status === status) return f;
    return ReviewFindingSchema.parse({
      ...f,
      reviewer: { ...f.reviewer, route_proof_status: status },
    });
  });
  const healthyProviders = [...healthyFamilies];
  const verifiedFamilies = [
    ...new Set(
      classifiedProofs
        .filter((p) => p.status === "verified" || p.status === "accepted_model_arg")
        .map((p) => p.requested.provider_family)
        .filter((f) => f !== "unknown"),
    ),
  ];
  return {
    findings: dedupeFindings(findings),
    routeProofs: classifiedProofs,
    reviewerRequests,
    crossFamilyHealthy: healthyProviders.length >= 2,
    healthyProviders,
    crossFamilyVerified: verifiedFamilies.length >= 2,
    distinctProviders: verifiedFamilies,
    reviewSpendUsd,
    reviewSpendEstimated,
  };
}

async function collectReviewerOutput(
  reviewer: ReviewerSpec,
  spec: ReturnType<typeof HarnessRunSpec.parse>,
  timeoutMs: number,
  artifact: ReviewerArtifactContext,
  onReviewerEvent: ReviewCandidateInput["onReviewerEvent"],
): Promise<ReviewerOutput> {
  const controller = new AbortController();
  spec.extra["abortSignal"] = controller.signal;
  const startMs = Date.now();
  const startTime = nowIso();
  updateReviewerMetadata(artifact, {
    status: "started",
    start_time: startTime,
    requested_model: reviewer.requestedModel ?? null,
    requested_effort: reviewer.requestedEffort ?? null,
    provider_family: reviewer.providerFamily,
    harness_id: reviewer.adapter.id,
    prompt_path: artifact.promptPath,
  });
  emitReviewerProgress(artifact, reviewer, onReviewerEvent, {
    type: "reviewer.started",
    at: startTime,
  });
  const iter = (reviewer.adapter.review ?? reviewer.adapter.run).call(reviewer.adapter, spec);
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let timedOut = false;
  let firstEventTime: string | null = null;
  // Reviewer spend tracked at function scope so a timed-out/failed reviewer still
  // contributes its PARTIAL cost to the ledger (budget truth). It is attached to
  // the thrown error so the caller can fold it in.
  let costUsd = 0;
  let costEstimated = false;

  const consume = (async (): Promise<ReviewerOutput> => {
    let text = "";
    let observedModel: string | undefined;
    let observedSource: RouteProof["observed"]["evidence_source"] = "unavailable";
    for await (const ev of iter) {
      const eventTime = nowIso();
      appendLine(artifact.eventsPath, JSON.stringify(redactValue(ev)));
      if (!firstEventTime) {
        firstEventTime = eventTime;
        updateReviewerMetadata(artifact, { first_event_time: firstEventTime });
        emitReviewerProgress(artifact, reviewer, onReviewerEvent, {
          type: "reviewer.first_event",
          at: firstEventTime,
        });
      }
      if (ev.type === "usage" && ev.usage?.cost_usd) {
        costUsd += ev.usage.cost_usd;
        if (ev.usage.estimated) costEstimated = true;
        updateReviewerMetadata(artifact, { cost_usd: costUsd, cost_estimated: costEstimated });
      }
      if (ev.type === "message" && ev.text) {
        const safeText = redactSecrets(ev.text);
        text += safeText + "\n";
        appendLine(artifact.transcriptPath, safeText);
      }
      if (ev.observed_model) {
        observedModel = ev.observed_model;
        const source = ev.payload?.["observed_model_source"];
        observedSource = source === "metadata" || source === "model_catalog" || source === "transcript" ? source : "stream_event";
        updateReviewerMetadata(artifact, {
          observed_model: observedModel,
          observed_source: observedSource,
        });
      }
    }
    if (!timedOut) {
      const completedTime = nowIso();
      const durationMs = Date.now() - startMs;
      updateReviewerMetadata(artifact, {
        status: "completed",
        completion_time: completedTime,
        duration_ms: durationMs,
        observed_model: observedModel ?? null,
        observed_source: observedSource,
        raw_normalized_stream_path: artifact.eventsPath,
        transcript_path: artifact.transcriptPath,
      });
      emitReviewerProgress(artifact, reviewer, onReviewerEvent, {
        type: "reviewer.completed",
        at: completedTime,
        duration_ms: durationMs,
        observed_model: observedModel ?? null,
        observed_source: observedSource,
      });
    }
    return { text, observedModel, observedSource, artifactDir: artifact.dir, costUsd, costEstimated };
  })();

  const timed = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      const timedOutAt = nowIso();
      const durationMs = Date.now() - startMs;
      controller.abort();
      void (iter as unknown as AsyncIterator<unknown>).return?.();
      updateReviewerMetadata(artifact, {
        status: "timed_out",
        timeout_time: timedOutAt,
        duration_ms: durationMs,
        raw_normalized_stream_path: artifact.eventsPath,
        transcript_path: artifact.transcriptPath,
      });
      emitReviewerProgress(artifact, reviewer, onReviewerEvent, {
        type: "reviewer.timed_out",
        at: timedOutAt,
        duration_ms: durationMs,
        message: `Reviewer timed out after ${timeoutMs}ms`,
      });
      reject(
        Object.assign(new Error(`Reviewer timed out after ${timeoutMs}ms`), {
          partialCostUsd: costUsd,
          partialCostEstimated: costEstimated,
        }),
      );
    }, Math.max(1, timeoutMs));
  });

  try {
    return await Promise.race([consume, timed]);
  } catch (err) {
    if (!timedOut) {
      const failedAt = nowIso();
      const durationMs = Date.now() - startMs;
      const message = err instanceof Error ? err.message : String(err);
      updateReviewerMetadata(artifact, {
        status: "failed",
        failure_time: failedAt,
        duration_ms: durationMs,
        error: redactSecrets(message),
        raw_normalized_stream_path: artifact.eventsPath,
        transcript_path: artifact.transcriptPath,
      });
      emitReviewerProgress(artifact, reviewer, onReviewerEvent, {
        type: "reviewer.failed",
        at: failedAt,
        duration_ms: durationMs,
        message,
      });
    }
    if (err && typeof err === "object") {
      Object.assign(err as Record<string, unknown>, {
        partialCostUsd: costUsd,
        partialCostEstimated: costEstimated,
      });
    }
    throw err;
  } finally {
    settled = true;
    if (timeout) clearTimeout(timeout);
    consume.catch(() => {
      /* timeout path: consume may reject after the race already returned */
    });
  }
}

function writePatchEvidence(evidenceDir: string, diff: string): ReviewPatchEvidence {
  ensureDir(evidenceDir);
  const redactedDiff = redactSecrets(diff || "(empty diff)\n");
  const diffPath = join(evidenceDir, "DIFF.patch");
  const summaryPath = join(evidenceDir, "DIFF_SUMMARY.md");
  const diffSha256 = sha256(redactedDiff);
  const summary = summarizeDiff(redactedDiff);
  writeText(diffPath, redactedDiff.endsWith("\n") ? redactedDiff : `${redactedDiff}\n`);
  writeText(summaryPath, `# Diff Summary\n\nDigest: ${diffSha256}\n\n${summary}\n`);
  writeText(join(evidenceDir, "DIFF_SHA256.txt"), `${diffSha256}\n`);
  return { diffPath, summaryPath, diffSha256, summary };
}

function summarizeDiff(diff: string): string {
  const lines = diff.split(/\r?\n/);
  const files = lines
    .filter((line) => line.startsWith("diff --git "))
    .map((line) => line.replace(/^diff --git a\//, "").replace(/ b\//, " -> "))
    .slice(0, 80);
  const hunks = lines.filter((line) => line.startsWith("@@")).length;
  const additions = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const deletions = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  const fallbackHeaders = lines
    .filter((line) => /^#{1,6}\s+\S/.test(line) || line.startsWith("### ") || line.startsWith("## "))
    .slice(0, 40);
  const body = [
    `- Patch bytes: ${Buffer.byteLength(diff, "utf8")}`,
    `- Patch lines: ${lines.length}`,
    `- Files: ${files.length}`,
    `- Hunks: ${hunks}`,
    `- Additions: ${additions}`,
    `- Deletions: ${deletions}`,
  ];
  if (files.length) {
    body.push("", "Files:", ...files.map((file) => `- ${file}`));
  } else if (fallbackHeaders.length) {
    body.push("", "Text sections:", ...fallbackHeaders.map((line) => `- ${line.replace(/^#+\s*/, "")}`));
  } else {
    body.push("", "- No unified diff headers detected. Read DIFF.patch for the candidate content.");
  }
  return body.join("\n");
}

function createReviewerArtifactContext(baseDir: string, index: number, reviewer: ReviewerSpec): ReviewerArtifactContext {
  const dir = join(baseDir, `${String(index + 1).padStart(2, "0")}-${safeFilePart(reviewer.adapter.id)}`);
  ensureDir(dir);
  const progressPath = join(baseDir, "reviewer-progress.jsonl");
  const metadata = {
    harness_id: reviewer.adapter.id,
    provider_family: reviewer.providerFamily,
    requested_model: reviewer.requestedModel ?? null,
    requested_effort: reviewer.requestedEffort ?? null,
    artifact_dir: dir,
  };
  const ctx: ReviewerArtifactContext = {
    dir,
    progressPath,
    metadataPath: join(dir, "metadata.json"),
    eventsPath: join(dir, "raw-normalized-stream.jsonl"),
    transcriptPath: join(dir, "transcript.md"),
    promptPath: join(dir, "prompt.md"),
    parsedPath: join(dir, "parsed-json-blocks.json"),
    parseErrorPath: join(dir, "parse-error.json"),
    metadata,
  };
  writeJson(ctx.metadataPath, metadata);
  writeText(ctx.eventsPath, "");
  writeText(ctx.transcriptPath, "");
  return ctx;
}

function safeFilePart(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "reviewer";
}

function emitReviewerProgress(
  artifact: ReviewerArtifactContext,
  reviewer: ReviewerSpec,
  onReviewerEvent: ReviewCandidateInput["onReviewerEvent"],
  patch: Omit<ReviewerProgressEvent, "harness_id" | "provider_family" | "requested_model" | "requested_effort" | "artifact_dir">,
): void {
  const event: ReviewerProgressEvent = {
    harness_id: reviewer.adapter.id,
    provider_family: reviewer.providerFamily,
    requested_model: reviewer.requestedModel ?? null,
    requested_effort: reviewer.requestedEffort ?? null,
    artifact_dir: artifact.dir,
    ...patch,
  };
  const redacted = redactValue(event);
  appendLine(artifact.progressPath, JSON.stringify(redacted));
  try {
    onReviewerEvent?.(redacted);
  } catch {
    /* progress observers must never affect review state */
  }
}

function updateReviewerMetadata(artifact: ReviewerArtifactContext, patch: Record<string, unknown>): void {
  artifact.metadata = { ...artifact.metadata, ...redactValue(patch) };
  writeJson(artifact.metadataPath, artifact.metadata);
}

function writeParseError(artifact: ReviewerArtifactContext, value: Record<string, unknown>): void {
  writeJson(artifact.parseErrorPath, redactValue(value));
}

function redactValue<T>(value: T): T {
  try {
    return JSON.parse(redactSecrets(JSON.stringify(value))) as T;
  } catch {
    return value;
  }
}

function insufficientEvidenceFinding(reviewer: ReviewerInfo, claim: string): ReviewFinding {
  return ReviewFindingSchema.parse({
    id: newId("f"),
    severity: "INSUFFICIENT_EVIDENCE",
    category: "test_gap",
    claim,
    evidence: {},
    proposed_fix: "Treat this review as inconclusive and rerun with a healthy reviewer.",
    reviewer: {
      harness_id: reviewer.harness_id,
      requested_model: reviewer.requested_model ?? null,
      requested_effort: reviewer.requested_effort ?? null,
      observed_model: reviewer.observed_model ?? null,
      route_proof_status: reviewer.route_proof_status ?? "unverified",
    },
    status: "insufficient_evidence",
  });
}

export interface MatrixCandidate {
  attemptId: string;
  label: string;
  diff: string;
  evidenceDir: string;
  cwd: string;
}

export interface CandidateReview {
  attemptId: string;
  label: string;
  result: ReviewCandidateResult;
}

export interface ReviewMatrixOptions {
  artifactsDir?: string;
  reviewerTimeoutMs?: number;
  onReviewerEvent?: (event: ReviewerProgressEvent) => void;
}

/** Cross-review matrix: review every candidate with the same panel of reviewers. */
export async function reviewMatrix(
  candidates: MatrixCandidate[],
  reviewers: ReviewerSpec[],
  options: ReviewMatrixOptions = {},
): Promise<CandidateReview[]> {
  const out: CandidateReview[] = [];
  for (const c of candidates) {
    const result = await reviewCandidate({
      candidateLabel: c.label,
      diff: c.diff,
      evidenceDir: c.evidenceDir,
      cwd: c.cwd,
      reviewers,
      artifactsDir: options.artifactsDir ? join(options.artifactsDir, c.attemptId) : undefined,
      reviewerTimeoutMs: options.reviewerTimeoutMs,
      onReviewerEvent: options.onReviewerEvent,
    });
    out.push({ attemptId: c.attemptId, label: c.label, result });
  }
  return out;
}
