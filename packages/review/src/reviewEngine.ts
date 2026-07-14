import { parseUnifiedDiff, runCapture, type HarnessAdapter } from "@claudexor/core";
import { preflightEvidence, type DiffEvidence, writeDiffEvidence } from "@claudexor/context";
import type {
  AuthPreference,
  EffortHint,
  HarnessEvent,
  ProviderFamily,
  ReviewFinding,
  RouteProof,
} from "@claudexor/schema";
import {
  FallbackReason,
  HarnessRunSpec,
  ReviewFinding as ReviewFindingSchema,
} from "@claudexor/schema";
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync, type Stats } from "node:fs";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import {
  appendLine,
  containsSecretLikeToken,
  ensureDir,
  newId,
  nowIso,
  readTextSafe,
  redactSecrets,
  sensitiveResourcePolicy,
  sha256,
  writeJson,
  writeText,
} from "@claudexor/util";
import {
  dedupeFindings,
  extractJsonBlocks,
  parseFindingsDetailed,
  type ReviewerInfo,
} from "./findings.js";
import { buildRouteProof, classifyDiversity } from "./route.js";

export interface ReviewerSpec {
  adapter: HarnessAdapter;
  providerFamily: ProviderFamily;
  requestedModel?: string | null;
  requestedEffort?: EffortHint | null;
  authPreference?: AuthPreference | null;
}

export interface ReviewCandidateInput {
  candidateLabel: string;
  diff: string;
  evidenceDir: string;
  artifactsDir?: string;
  evidenceReadOnly?: boolean;
  frozenIdentity?: {
    candidateSha: string;
    candidateTree: string;
    packetManifestSha256: string;
  };
  cwd: string;
  reviewers: ReviewerSpec[];
  reviewerTimeoutMs?: number;
  transientRetryPolicy?: TransientRetryPolicy;
  envInheritance?: "mirror_native" | "clean";
  env?: Record<string, string>;
  signal?: AbortSignal;
  onReviewerEvent?: (event: ReviewerProgressEvent) => void;
}

export interface ReviewCandidateResult {
  findings: ReviewFinding[];
  routeProofs: RouteProof[];
  reviewerRequests: {
    harness_id: string;
    provider_family: ProviderFamily;
    requested_model: string | null;
    requested_effort: string | null;
  }[];
  crossFamilyHealthy: boolean;
  healthyProviders: ProviderFamily[];
  crossFamilyVerified: boolean;
  distinctProviders: ProviderFamily[];
  reviewSpendUsd: number;
  reviewSpendEstimated: boolean;
}

const DEFAULT_REVIEWER_TIMEOUT_MS = 10 * 60_000;
export interface TransientRetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
}
const DEFAULT_REVIEWER_TRANSIENT_RETRY_POLICY: TransientRetryPolicy = {
  maxRetries: 2,
  initialDelayMs: 1_000,
  maxDelayMs: 10_000,
};
const BLOCKED_REVIEWER_RUNTIME_ROOTS = new Set(
  "auth cache daemon home homes logs runs secrets state tmp workspaces".split(" "),
);
const TEXT_EVIDENCE_SUFFIXES = [".md", ".txt", ".json", ".yaml", ".yml", ".patch"];

export interface ReviewerProgressEvent {
  type:
    | "reviewer.started"
    | "reviewer.first_event"
    | "reviewer.auth_switched"
    | "reviewer.completed"
    | "reviewer.timed_out"
    | "reviewer.failed";
  harness_id: string;
  provider_family: ProviderFamily;
  requested_model: string | null;
  requested_effort: EffortHint | null;
  observed_model?: string | null;
  observed_source?: RouteProof["observed"]["evidence_source"];
  route_proof_status?: RouteProof["status"];
  from_auth_mode?: string;
  to_auth_mode?: string;
  reason?: FallbackReason;
  artifact_dir: string;
  at: string;
  duration_ms?: number;
  message?: string;
}

interface ReviewerOutput {
  text: string;
  observedModel?: string;
  observedSource: RouteProof["observed"]["evidence_source"];
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

interface ReviewerWorkspace {
  root: string;
  evidenceDir: string;
}

function readExistingDiffEvidence(dir: string, diff: string): DiffEvidence {
  const diffText = diff.endsWith("\n") ? diff : `${diff}\n`;
  const summaryPath = join(dir, "DIFF_SUMMARY.md");
  const summary = readTextSafe(summaryPath);
  if (summary === null) throw new Error("sealed review packet is missing DIFF_SUMMARY.md");
  return {
    diffPath: join(dir, "DIFF.patch"),
    summaryPath,
    diffSha256: sha256(diffText),
    summary,
  };
}

function reviewerRouteProof(
  reviewer: ReviewerSpec,
  modelId: string | null,
  source: RouteProof["observed"]["evidence_source"],
  peerFamilies: ProviderFamily[],
): RouteProof {
  return buildRouteProof(
    {
      harness_id: reviewer.adapter.id,
      provider_family: reviewer.providerFamily,
      model_hint: reviewer.requestedModel ?? null,
    },
    {
      provider: reviewer.providerFamily,
      model_id: modelId,
      evidence_source: modelId ? source : "unavailable",
    },
    peerFamilies,
  );
}

function reviewerInfo(
  reviewer: ReviewerSpec,
  routeProofStatus: RouteProof["status"],
  observedModel: string | null = null,
): ReviewerInfo {
  return {
    harness_id: reviewer.adapter.id,
    requested_model: reviewer.requestedModel ?? null,
    requested_effort: reviewer.requestedEffort ?? null,
    observed_model: observedModel,
    route_proof_status: routeProofStatus,
  };
}

function reviewPrompt(
  label: string,
  candidateRoot: string,
  evidenceDir: string,
  patch: DiffEvidence,
  sealed = false,
): string {
  return [
    "You are an adversarial code reviewer.",
    `Candidate root: ${candidateRoot}.`,
    sealed
      ? `First verify MANIFEST.sha256 and read every file it seals in ${evidenceDir}, including FREEZE.json and DECIDED_TRADEOFFS.md. If the manifest or a sealed file is missing, return INSUFFICIENT_EVIDENCE.`
      : `First read the evidence packet in ${evidenceDir} (USER_INTENT.md, FORBIDDEN_FINDINGS.md, PLAN_ACCEPTED.md, DECIDED_TRADEOFFS.md, TESTS.txt, DIFF.patch, DIFF_SUMMARY.md). If a mandatory file is missing, return INSUFFICIENT_EVIDENCE.`,
    `Review ${label}'s change from the file-backed patch artifact, not from this prompt. Full patch: ${patch.diffPath}. Summary: ${patch.summaryPath}. Patch digest: ${patch.diffSha256}.`,
    "All code/file evidence must come from Candidate root or the evidence packet. Do not inspect or cite sibling/base repository paths outside Candidate root; if required evidence is unavailable there, return INSUFFICIENT_EVIDENCE.",
    "Treat TESTS.txt as the gate evidence. Do not rerun full build/test gates from the review; run only small targeted commands when needed to verify a concrete finding.",
    "In finding evidence, cite candidate files with paths relative to Candidate root. Cite evidence packet files by their evidence filename (for example DIFF.patch or TESTS.txt). Do not cite absolute Candidate root, reviewer workspace, or evidenceDir paths; those are disposable transport paths and will be rejected as evidence.",
    "Output ONLY a JSON array of findings.",
    `Each finding: {"severity":"BLOCK|FIX_FIRST|WARN|NIT|OUT_OF_SCOPE|INSUFFICIENT_EVIDENCE|NEEDS_HUMAN","category":"correctness|regression|security|performance|maintainability|test_gap|spec_gap|deploy|architecture|ux","claim":"...","evidence":{"files":[{"path":"...","lines":"..."}]},"proposed_fix":"..."}.`,
    "Rules: no evidence => do NOT use BLOCK. Do not relitigate FORBIDDEN_FINDINGS or DECIDED_TRADEOFFS.",
    "",
    "Patch summary (not a replacement for reading DIFF.patch):",
    patch.summary,
  ].join("\n");
}

export async function reviewCandidate(input: ReviewCandidateInput): Promise<ReviewCandidateResult> {
  const findingsByReviewer: ReviewFinding[][] = input.reviewers.map(() => []);
  const reviewerFamilies = input.reviewers.map((reviewer) => reviewer.providerFamily);
  const routeProofs: RouteProof[] = input.reviewers.map((reviewer, index) =>
    reviewerRouteProof(
      reviewer,
      null,
      "unavailable",
      reviewerFamilies.filter((_, otherIndex) => otherIndex !== index),
    ),
  );
  const reviewerRequests: ReviewCandidateResult["reviewerRequests"] = input.reviewers.map(
    (reviewer) => ({
      harness_id: reviewer.adapter.id,
      provider_family: reviewer.providerFamily,
      requested_model: reviewer.requestedModel ?? null,
      requested_effort: reviewer.requestedEffort ?? null,
    }),
  );
  const healthyReviewerIndexes = new Set<number>();
  const reviewSpendByReviewer = input.reviewers.map(() => 0);
  const reviewSpendEstimatedByReviewer = input.reviewers.map(() => false);
  const reviewerTimeoutMs = input.reviewerTimeoutMs ?? DEFAULT_REVIEWER_TIMEOUT_MS;
  const frozenMetadata = input.frozenIdentity
    ? {
        candidate_sha: input.frozenIdentity.candidateSha,
        candidate_tree: input.frozenIdentity.candidateTree,
        packet_manifest_sha256: input.frozenIdentity.packetManifestSha256,
      }
    : {};
  if (containsSecretLikeToken(input.diff || "(empty diff)\n")) {
    throw new Error(
      "diff evidence contains a secret-like token; refusing to persist raw DIFF.patch",
    );
  }
  if (input.evidenceReadOnly) {
    const packetDiff = readTextSafe(join(input.evidenceDir, "DIFF.patch"));
    const normalizedDiff = input.diff.endsWith("\n") ? input.diff : `${input.diff}\n`;
    if (packetDiff === null || packetDiff !== normalizedDiff) {
      throw new Error("sealed review packet DIFF.patch does not match the verified review diff");
    }
  } else {
    writeDiffEvidence(input.evidenceDir, input.diff);
  }
  const preflight = preflightEvidence(input.evidenceDir);
  if (!preflight.ok) {
    const parts = [
      preflight.missing.length > 0 ? `missing: ${preflight.missing.join(", ")}` : "",
      preflight.empty.length > 0 ? `empty: ${preflight.empty.join(", ")}` : "",
    ].filter(Boolean);
    throw new Error(`mandatory evidence preflight failed (${parts.join("; ")})`);
  }
  const artifactsBaseDir = input.artifactsDir ?? join(input.evidenceDir, "reviewer-artifacts");
  ensureDir(artifactsBaseDir);
  const persistentEvidenceDir = join(artifactsBaseDir, "evidence");
  await copyReviewEvidencePacket(
    input.evidenceDir,
    persistentEvidenceDir,
    input.evidenceReadOnly === true,
  );
  const persistentPatch = input.evidenceReadOnly
    ? readExistingDiffEvidence(persistentEvidenceDir, input.diff)
    : writeDiffEvidence(persistentEvidenceDir, input.diff);
  writeJson(
    input.evidenceReadOnly
      ? join(artifactsBaseDir, "evidence-metadata.json")
      : join(persistentEvidenceDir, "metadata.json"),
    {
      source_evidence_dir: input.evidenceDir,
      candidate_root: input.cwd,
      persistent_evidence_dir: persistentEvidenceDir,
      diff_path: persistentPatch.diffPath,
      summary_path: persistentPatch.summaryPath,
      diff_sha256: persistentPatch.diffSha256,
      ...frozenMetadata,
    },
  );
  const artifacts: (ReviewerArtifactContext | undefined)[] = input.reviewers.map(() => undefined);
  const preservePaths = extractDiffTouchedPaths(input.diff);
  const reviewerWorkspaceBaseDir = selectReviewerWorkspaceBaseDir(
    input.cwd,
    artifactsBaseDir,
    input.evidenceDir,
  );

  const runReviewer = async (reviewer: ReviewerSpec, index: number): Promise<void> => {
    if (input.signal?.aborted) return;
    const artifact = createReviewerArtifactContext(artifactsBaseDir, index, reviewer);
    artifacts[index] = artifact;
    let reviewerWorkspace: ReviewerWorkspace | null = null;
    let spec: HarnessRunSpec | null = null;
    try {
      reviewerWorkspace = await prepareReviewerWorkspace({
        sourceRoot: input.cwd,
        sourceEvidenceDir: persistentEvidenceDir,
        workspaceBaseDir: reviewerWorkspaceBaseDir,
        reviewerDirName: `${String(index + 1).padStart(2, "0")}-${safeFilePart(reviewer.adapter.id)}`,
        excludeRoots: [artifactsBaseDir],
        preservePaths,
        preserveEvidenceBytes: input.evidenceReadOnly === true,
      });
      const reviewerPatch = input.evidenceReadOnly
        ? readExistingDiffEvidence(reviewerWorkspace.evidenceDir, input.diff)
        : writeDiffEvidence(reviewerWorkspace.evidenceDir, input.diff);
      updateReviewerMetadata(artifact, {
        candidate_evidence_dir: reviewerWorkspace.evidenceDir,
        candidate_root: reviewerWorkspace.root,
        source_candidate_evidence_dir: input.evidenceDir,
        source_candidate_root: input.cwd,
        reviewer_workspace_root: reviewerWorkspace.root,
        persistent_evidence_dir: persistentEvidenceDir,
        persistent_diff_path: persistentPatch.diffPath,
        persistent_summary_path: persistentPatch.summaryPath,
        diff_sha256: persistentPatch.diffSha256,
        ...frozenMetadata,
      });
      const runtimePrompt = reviewPrompt(
        input.candidateLabel,
        reviewerWorkspace.root,
        reviewerWorkspace.evidenceDir,
        reviewerPatch,
        input.evidenceReadOnly === true,
      );
      spec = HarnessRunSpec.parse({
        session_id: newId("rev"),
        intent: "review",
        prompt: runtimePrompt,
        cwd: reviewerWorkspace.root,
        access: "readonly",
        model_hint: reviewer.requestedModel ?? null,
        effort_hint: reviewer.requestedEffort ?? null,
        auth_preference: reviewer.authPreference ?? "auto",
        env_inheritance: input.envInheritance ?? "mirror_native",
        ...(input.env ? { env: input.env } : {}),
      });
      writeText(
        artifact.promptPath,
        redactSecrets(`Persistent local replay evidence:
- evidence_dir: ${persistentEvidenceDir}
- candidate_root: ${reviewerWorkspace.root}
- source_candidate_root: ${input.cwd}
- source_candidate_evidence_dir: ${input.evidenceDir}
- diff_path: ${persistentPatch.diffPath}
- diff_sha256: ${persistentPatch.diffSha256}

Runtime prompt used during review follows. Its candidate-tree paths may be transient after orchestrator cleanup; use the durable replay paths above for audit/replay.

${runtimePrompt}
`),
      );
    } catch (err) {
      const failedAt = nowIso();
      const message = redactSecrets(err instanceof Error ? err.message : String(err));
      updateReviewerMetadata(artifact, {
        status: "failed",
        failure_time: failedAt,
        error: `reviewer setup failed: ${message}`,
      });
      writeParseError(artifact, { error: `reviewer setup failed: ${message}` });
      emitReviewerProgress(artifact, reviewer, input.onReviewerEvent, {
        type: "reviewer.failed",
        at: failedAt,
        duration_ms: 0,
        message: `Reviewer setup failed: ${message}`,
      });
      if (reviewerWorkspace) await cleanupReviewerWorkspace(reviewerWorkspace, artifact);
      const proof = reviewerRouteProof(reviewer, null, "unavailable", reviewerFamilies);
      routeProofs[index] = proof;
      findingsByReviewer[index]?.push(
        insufficientEvidenceFinding(
          reviewerInfo(reviewer, proof.status),
          `Reviewer setup failed: ${message}`,
        ),
      );
      return;
    }
    if (!reviewerWorkspace || !spec) return;

    let text = "";
    let streamObservedModel: string | undefined;
    let routeModel: string | undefined;
    let routeSource: RouteProof["observed"]["evidence_source"] = "unavailable";
    let reviewerError: string | null = null;
    try {
      const out = await collectReviewerOutput(
        reviewer,
        spec,
        reviewerTimeoutMs,
        input.transientRetryPolicy ?? DEFAULT_REVIEWER_TRANSIENT_RETRY_POLICY,
        artifact,
        input.onReviewerEvent,
        input.signal,
      );
      text = out.text;
      streamObservedModel = out.observedModel;
      routeModel = out.observedModel;
      routeSource = out.observedSource;
      reviewSpendByReviewer[index] = out.costUsd;
      reviewSpendEstimatedByReviewer[index] = out.costEstimated;
      if (!routeModel && reviewer.requestedModel) {
        routeModel = reviewer.requestedModel;
        routeSource = "metadata";
      }
    } catch (err) {
      reviewerError = redactSecrets(err instanceof Error ? err.message : String(err));
      const partial = err as {
        partialCostUsd?: number;
        partialCostEstimated?: boolean;
        partialObservedModel?: string;
        partialObservedSource?: RouteProof["observed"]["evidence_source"];
        partialText?: string;
      };
      if (typeof partial?.partialText === "string" && partial.partialText.trim() !== "") {
        text = partial.partialText;
      }
      if (partial && typeof partial.partialCostUsd === "number" && partial.partialCostUsd > 0) {
        reviewSpendByReviewer[index] = partial.partialCostUsd;
        reviewSpendEstimatedByReviewer[index] = partial.partialCostEstimated === true;
      }
      if (partial?.partialObservedModel) {
        streamObservedModel = partial.partialObservedModel;
        routeModel = partial.partialObservedModel;
        routeSource = partial.partialObservedSource ?? "stream_event";
      }
      writeParseError(artifact, { error: reviewerError });
    } finally {
      await cleanupReviewerWorkspace(reviewerWorkspace, artifact);
    }

    const proof = reviewerRouteProof(
      reviewer,
      routeModel ?? null,
      routeSource,
      reviewerFamilies.filter((_, i) => i !== index),
    );
    routeProofs[index] = proof;

    const info = reviewerInfo(reviewer, proof.status, streamObservedModel ?? null);
    const jsonBlocks = extractJsonBlocks(text);
    writeJson(artifact.parsedPath, redactValue(jsonBlocks));
    if (reviewerError && (text.trim() === "" || jsonBlocks.length === 0)) {
      findingsByReviewer[index]?.push(
        insufficientEvidenceFinding(info, `Reviewer failed: ${reviewerError}`),
      );
      return;
    }
    if (text.trim() === "" || jsonBlocks.length === 0) {
      writeParseError(artifact, { error: "no_parseable_json", text_sha256: sha256(text) });
      findingsByReviewer[index]?.push(
        insufficientEvidenceFinding(info, "Reviewer produced no parseable JSON findings."),
      );
      return;
    }
    const parsed = parseFindingsDetailed(text, info);
    const parseError: Record<string, unknown> = {};
    let parsedFindingsRecorded = false;
    const recordParsedFindings = () => {
      if (parsedFindingsRecorded) return;
      findingsByReviewer[index]?.push(...parsed.findings);
      parsedFindingsRecorded = true;
    };
    if (parsed.malformed > 0) {
      Object.assign(parseError, {
        error: "malformed_findings",
        malformed: parsed.malformed,
        text_sha256: sha256(text),
      });
      recordParsedFindings();
      findingsByReviewer[index]?.push(
        insufficientEvidenceFinding(
          info,
          `Reviewer produced ${parsed.malformed} malformed finding item(s).`,
        ),
      );
    }
    if (reviewerError) {
      Object.assign(parseError, {
        error: reviewerError,
        recovered_json_blocks: jsonBlocks.length,
        text_sha256: sha256(text),
      });
      recordParsedFindings();
      findingsByReviewer[index]?.push(
        insufficientEvidenceFinding(
          info,
          parsed.findings.length === 0
            ? `Reviewer failed after parseable JSON with no findings: ${reviewerError}`
            : `Reviewer failed after parseable JSON output: ${reviewerError}`,
        ),
      );
    }
    if (Object.keys(parseError).length > 0) {
      writeParseError(artifact, parseError);
      return;
    }
    healthyReviewerIndexes.add(index);
    findingsByReviewer[index]?.push(...parsed.findings);
  };

  try {
    const reviewerRuns = await Promise.allSettled(
      input.reviewers.map((reviewer, index) => runReviewer(reviewer, index)),
    );
    const failedRun = reviewerRuns.find(
      (run): run is PromiseRejectedResult => run.status === "rejected",
    );
    if (failedRun) throw failedRun.reason;
    const classifiedProofs = classifyDiversity(routeProofs);
    for (const [index, proof] of classifiedProofs.entries()) {
      const artifact = artifacts[index];
      if (artifact) {
        updateReviewerMetadata(artifact, {
          route_proof_status: proof.status,
          route_proof: proof,
        });
      }
    }
    const findings = findingsByReviewer.flatMap((items, index) => {
      const status = classifiedProofs[index]?.status;
      return items.map((f) => {
        if (!status || f.reviewer.route_proof_status === status) return f;
        return ReviewFindingSchema.parse({
          ...f,
          reviewer: { ...f.reviewer, route_proof_status: status },
        });
      });
    });
    const healthyProviders = [
      ...new Set(
        input.reviewers
          .filter((_, index) => healthyReviewerIndexes.has(index))
          .map((reviewer) => reviewer.providerFamily)
          .filter((family) => family !== "unknown"),
      ),
    ];
    const observedFamilies = [
      ...new Set(
        classifiedProofs
          .filter((p, index) => p.status === "verified" && healthyReviewerIndexes.has(index))
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
      crossFamilyVerified: observedFamilies.length >= 2,
      distinctProviders: observedFamilies,
      reviewSpendUsd: reviewSpendByReviewer.reduce((sum, spend) => sum + spend, 0),
      reviewSpendEstimated: reviewSpendEstimatedByReviewer.some(Boolean),
    };
  } finally {
    await cleanupTemporaryReviewerWorkspaceBaseDir(reviewerWorkspaceBaseDir, artifactsBaseDir);
  }
}

async function collectReviewerOutput(
  reviewer: ReviewerSpec,
  spec: ReturnType<typeof HarnessRunSpec.parse>,
  timeoutMs: number,
  transientRetryPolicy: TransientRetryPolicy,
  artifact: ReviewerArtifactContext,
  onReviewerEvent: ReviewCandidateInput["onReviewerEvent"],
  signal?: AbortSignal,
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
  let runSpec = spec;
  let currentIter: AsyncIterable<HarnessEvent> | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let timedOut = false;
  let cancelledBySignal = false;
  let firstEventTime: string | null = null;
  let observedModel: string | undefined;
  let observedSource: RouteProof["observed"]["evidence_source"] = "unavailable";
  let costUsd = 0;
  let costEstimated = false;
  let partialText = "";
  const isCancelled = () =>
    cancelledBySignal || signal?.aborted === true || controller.signal.aborted;

  const consumeOnce = async (nativeTry: number): Promise<ReviewerOutput> => {
    const iter = (reviewer.adapter.review ?? reviewer.adapter.run).call(reviewer.adapter, runSpec);
    currentIter = iter;
    let text = "";
    let sawTransient = false;
    let sawError = false;
    let lastError: string | null = null;
    let attemptObservedModel: string | undefined;
    let attemptObservedSource: RouteProof["observed"]["evidence_source"] = "unavailable";
    for await (const ev of iter) {
      const eventTime = nowIso();
      appendLine(artifact.eventsPath, JSON.stringify(redactValue(ev)));
      if (ev.transient) sawTransient = true;
      if (ev.type === "error") {
        sawError = true;
        lastError = redactSecrets(ev.error ?? ev.text ?? "reviewer emitted an error event");
      }
      if (ev.type === "message" && ev.payload?.["auth_switched"] === true) {
        const authSwitch = reviewerAuthSwitchFromEvent(ev);
        updateReviewerMetadata(artifact, { auth_switch: authSwitch });
        emitReviewerProgress(artifact, reviewer, onReviewerEvent, {
          type: "reviewer.auth_switched",
          at: eventTime,
          ...authSwitch,
        });
      }
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
      if (ev.type === "message" && ev.text && ev.payload?.["auth_switched"] !== true) {
        const safeText = redactSecrets(ev.text);
        text += safeText + "\n";
        partialText += safeText + "\n";
        appendLine(artifact.transcriptPath, safeText);
      }
      if (ev.observed_model) {
        observedModel = ev.observed_model;
        const source = ev.payload?.["observed_model_source"];
        observedSource =
          source === "metadata" || source === "model_catalog" || source === "transcript"
            ? source
            : "stream_event";
        attemptObservedModel = observedModel;
        attemptObservedSource = observedSource;
        updateReviewerMetadata(artifact, {
          observed_model: observedModel,
          observed_source: observedSource,
        });
      }
    }
    if (isCancelled()) {
      throw new Error("Reviewer cancelled");
    }
    if (
      sawTransient &&
      text.trim() === "" &&
      nativeTry < transientRetryPolicy.maxRetries &&
      !timedOut &&
      !isCancelled()
    ) {
      const retryAt = nowIso();
      const delayMs = transientRetryDelayMs(transientRetryPolicy, nativeTry);
      updateReviewerMetadata(artifact, { transient_retry: nativeTry + 1 });
      emitReviewerProgress(artifact, reviewer, onReviewerEvent, {
        type: "reviewer.failed",
        at: retryAt,
        duration_ms: Date.now() - startMs,
        observed_model: attemptObservedModel ?? null,
        observed_source: attemptObservedSource,
        message: `Reviewer transient failure produced no output; retrying (${nativeTry + 1}/${transientRetryPolicy.maxRetries})`,
      });
      const remaining = Math.max(1, timeoutMs - (Date.now() - startMs));
      await sleep(Math.min(delayMs, remaining));
      if (timedOut) {
        throw new Error(`Reviewer timed out after ${timeoutMs}ms`);
      }
      if (isCancelled()) {
        throw new Error("Reviewer cancelled");
      }
      runSpec = HarnessRunSpec.parse({
        ...runSpec,
        session_id: newId("ses"),
        extra: { ...runSpec.extra, abortSignal: controller.signal },
      });
      return consumeOnce(nativeTry + 1);
    }
    if (sawError && !timedOut) {
      throw new Error(`Reviewer emitted error event: ${lastError ?? "unknown error"}`);
    }
    if (!timedOut && !isCancelled()) {
      const completedTime = nowIso();
      const durationMs = Date.now() - startMs;
      updateReviewerMetadata(artifact, {
        status: "completed",
        completion_time: completedTime,
        duration_ms: durationMs,
        observed_model: attemptObservedModel ?? null,
        observed_source: attemptObservedSource,
        raw_normalized_stream_path: artifact.eventsPath,
        transcript_path: artifact.transcriptPath,
      });
      emitReviewerProgress(artifact, reviewer, onReviewerEvent, {
        type: "reviewer.completed",
        at: completedTime,
        duration_ms: durationMs,
        observed_model: attemptObservedModel ?? null,
        observed_source: attemptObservedSource,
      });
    }
    return {
      text,
      observedModel: attemptObservedModel,
      observedSource: attemptObservedSource,
      costUsd,
      costEstimated,
    };
  };
  const consume = consumeOnce(0);

  let removeExternalAbortListener = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    if (!signal) return;
    const onAbort = () => {
      if (settled) return;
      cancelledBySignal = true;
      controller.abort();
      void (currentIter as unknown as AsyncIterator<unknown> | null)?.return?.();
      reject(
        Object.assign(new Error("Reviewer cancelled"), {
          partialCostUsd: costUsd,
          partialCostEstimated: costEstimated,
          partialObservedModel: observedModel,
          partialObservedSource: observedSource,
          partialText,
        }),
      );
    };
    if (signal.aborted) queueMicrotask(onAbort);
    else signal.addEventListener("abort", onAbort, { once: true });
    removeExternalAbortListener = () => signal.removeEventListener("abort", onAbort);
  });

  const timed = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => {
        if (settled) return;
        timedOut = true;
        const timedOutAt = nowIso();
        const durationMs = Date.now() - startMs;
        controller.abort();
        void (currentIter as unknown as AsyncIterator<unknown> | null)?.return?.();
        updateReviewerMetadata(artifact, {
          status: "timed_out",
          timeout_time: timedOutAt,
          duration_ms: durationMs,
          observed_model: observedModel ?? null,
          observed_source: observedSource,
          raw_normalized_stream_path: artifact.eventsPath,
          transcript_path: artifact.transcriptPath,
        });
        emitReviewerProgress(artifact, reviewer, onReviewerEvent, {
          type: "reviewer.timed_out",
          at: timedOutAt,
          duration_ms: durationMs,
          observed_model: observedModel ?? null,
          observed_source: observedSource,
          message: `Reviewer timed out after ${timeoutMs}ms`,
        });
        reject(
          Object.assign(new Error(`Reviewer timed out after ${timeoutMs}ms`), {
            partialCostUsd: costUsd,
            partialCostEstimated: costEstimated,
            partialObservedModel: observedModel,
            partialObservedSource: observedSource,
            partialText,
          }),
        );
      },
      Math.max(1, timeoutMs),
    );
  });

  try {
    return await Promise.race([consume, timed, cancelled]);
  } catch (err) {
    if (!timedOut) {
      const failedAt = nowIso();
      const durationMs = Date.now() - startMs;
      const rawMessage = err instanceof Error ? err.message : String(err);
      const message = cancelledBySignal ? "Reviewer cancelled" : rawMessage;
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
        partialObservedModel: observedModel,
        partialObservedSource: observedSource,
        partialText,
      });
    }
    throw err;
  } finally {
    settled = true;
    if (timeout) clearTimeout(timeout);
    removeExternalAbortListener();
    consume.catch(() => {
      /* timeout path: consume may reject after the race already returned */
    });
  }
}

function reviewerAuthSwitchFromEvent(ev: HarnessEvent): {
  from_auth_mode: string;
  to_auth_mode: string;
  reason: FallbackReason;
} {
  const reason = FallbackReason.safeParse(ev.payload?.["reason"]);
  return {
    from_auth_mode:
      typeof ev.payload?.["from_auth_mode"] === "string" ? ev.payload["from_auth_mode"] : "unknown",
    to_auth_mode:
      typeof ev.payload?.["to_auth_mode"] === "string" ? ev.payload["to_auth_mode"] : "unknown",
    reason: reason.success ? reason.data : "auth_unavailable",
  };
}

function selectReviewerWorkspaceBaseDir(
  sourceRoot: string,
  artifactsBaseDir: string,
  sourceEvidenceDir: string,
): string {
  const durableBase = join(artifactsBaseDir, "workspaces");
  if (!isSameOrInside(sourceRoot, durableBase) && !isSameOrInside(sourceEvidenceDir, durableBase)) {
    return durableBase;
  }
  return join(tmpdir(), `claudexor-review-workspaces-${newId("ws")}`);
}

function isTemporaryReviewerWorkspaceBaseDir(baseDir: string): boolean {
  const resolved = resolve(baseDir);
  const rel = relative(tmpdir(), resolved);
  return (
    isSameOrInside(tmpdir(), resolved) &&
    rel.split(/[\\/]+/)[0]?.startsWith("claudexor-review-workspaces-") === true
  );
}

async function prepareReviewerWorkspace(input: {
  sourceRoot: string;
  sourceEvidenceDir: string;
  workspaceBaseDir: string;
  reviewerDirName: string;
  excludeRoots: string[];
  preservePaths?: Set<string>;
  preserveEvidenceBytes?: boolean;
}): Promise<ReviewerWorkspace> {
  const sourceRoot = resolve(input.sourceRoot);
  const workspaceBaseDir = resolve(input.workspaceBaseDir);
  const root = join(workspaceBaseDir, input.reviewerDirName);
  if (!existsSync(sourceRoot)) {
    throw new Error(`candidate root does not exist: ${sourceRoot}`);
  }
  if (isSameOrInside(sourceRoot, root)) {
    throw new Error(`reviewer workspace must be outside candidate root: ${root}`);
  }

  try {
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true, mode: 0o700 });
    const excludeRoots = input.excludeRoots.map((p) => resolve(p));
    const resolvedSourceRoot = realpathSync(sourceRoot);
    await cp(sourceRoot, root, {
      recursive: true,
      dereference: false,
      filter: (sourcePath) =>
        shouldCopyReviewerPath(
          sourceRoot,
          resolvedSourceRoot,
          sourcePath,
          excludeRoots,
          input.preservePaths,
        ),
    });

    const sourceEvidenceDir = resolve(input.sourceEvidenceDir);
    const evidenceDir = join(root, ".claudexor-review-evidence");
    if (existsSync(sourceEvidenceDir)) {
      const resolvedSourceEvidenceDir = realpathSync(sourceEvidenceDir);
      const evidenceExcludeRoots = excludeRoots.filter(
        (root) => !isSameOrInside(root, sourceEvidenceDir),
      );
      await rm(evidenceDir, { recursive: true, force: true });
      await cp(
        sourceEvidenceDir,
        evidenceDir,
        input.preserveEvidenceBytes
          ? { recursive: true, dereference: false }
          : {
              recursive: true,
              dereference: false,
              filter: (sourcePath) =>
                shouldCopyReviewerPath(
                  sourceEvidenceDir,
                  resolvedSourceEvidenceDir,
                  sourcePath,
                  evidenceExcludeRoots,
                ),
            },
      );
    }
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });

    await initializeReviewerWorkspaceGit(root);
    return { root, evidenceDir };
  } catch (err) {
    await rm(root, { recursive: true, force: true });
    throw err;
  }
}

async function copyReviewEvidencePacket(
  sourceEvidenceDir: string,
  persistentEvidenceDir: string,
  preserveBytes = false,
): Promise<void> {
  const source = resolve(sourceEvidenceDir);
  const target = resolve(persistentEvidenceDir);
  await rm(target, { recursive: true, force: true });
  if (!existsSync(source)) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    return;
  }
  if (preserveBytes) {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await cp(source, target, { recursive: true, dereference: false });
    return;
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  const resolvedSource = realpathSync(source);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    if (!shouldCopyEvidencePacketPath(source, resolvedSource, sourcePath, target)) {
      continue;
    }
    await copyReviewEvidenceEntry(
      source,
      resolvedSource,
      sourcePath,
      join(target, entry.name),
      target,
    );
  }
}

async function copyReviewEvidenceEntry(
  sourceEvidenceDir: string,
  resolvedSourceEvidenceDir: string,
  sourcePath: string,
  targetPath: string,
  targetEvidenceDir: string,
): Promise<void> {
  const stat = lstatSync(sourcePath);
  if (stat.isDirectory()) {
    await mkdir(targetPath, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(sourcePath, { withFileTypes: true })) {
      const childSource = join(sourcePath, entry.name);
      if (
        !shouldCopyEvidencePacketPath(
          sourceEvidenceDir,
          resolvedSourceEvidenceDir,
          childSource,
          targetEvidenceDir,
        )
      ) {
        continue;
      }
      await copyReviewEvidenceEntry(
        sourceEvidenceDir,
        resolvedSourceEvidenceDir,
        childSource,
        join(targetPath, entry.name),
        targetEvidenceDir,
      );
    }
    return;
  }
  if (stat.isFile() && shouldTextSanitizeEvidenceFile(sourcePath)) {
    const raw = readTextSafe(sourcePath);
    if (raw === null) throw new Error(`could not read review evidence file: ${sourcePath}`);
    const text = shouldFailClosedEvidenceFile(sourcePath) ? raw : redactSecrets(raw);
    if (containsSecretLikeToken(text)) {
      throw new Error(
        `review evidence file contains a secret-like token: ${relative(sourceEvidenceDir, sourcePath)}`,
      );
    }
    writeText(targetPath, text);
    return;
  }
  await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
  await cp(sourcePath, targetPath, { recursive: false, dereference: false });
}

function shouldTextSanitizeEvidenceFile(path: string): boolean {
  return TEXT_EVIDENCE_SUFFIXES.some((extension) => path.toLowerCase().endsWith(extension));
}

function shouldFailClosedEvidenceFile(path: string): boolean {
  return path.toLowerCase().endsWith(".patch");
}

function shouldCopyEvidencePacketPath(
  sourceEvidenceDir: string,
  resolvedSourceEvidenceDir: string,
  sourcePath: string,
  targetEvidenceDir: string,
): boolean {
  const resolvedSourcePath = resolve(sourcePath);
  if (isSameOrInside(resolvedSourcePath, targetEvidenceDir)) return false;
  if (isSameOrInside(targetEvidenceDir, resolvedSourcePath)) return false;
  return shouldCopyReviewerPath(
    sourceEvidenceDir,
    resolvedSourceEvidenceDir,
    resolvedSourcePath,
    [targetEvidenceDir],
    new Set(),
    false,
  );
}

async function cleanupReviewerWorkspace(
  workspace: ReviewerWorkspace,
  artifact: ReviewerArtifactContext,
): Promise<void> {
  try {
    await rm(workspace.root, { recursive: true, force: true });
    tryUpdateReviewerMetadata(artifact, { reviewer_workspace_cleanup: "removed" });
  } catch (err) {
    tryUpdateReviewerMetadata(artifact, {
      reviewer_workspace_cleanup: "failed",
      reviewer_workspace_cleanup_error: redactSecrets(
        err instanceof Error ? err.message : String(err),
      ),
    });
  }
}

async function cleanupTemporaryReviewerWorkspaceBaseDir(
  workspaceBaseDir: string,
  artifactsBaseDir: string,
): Promise<void> {
  if (!isTemporaryReviewerWorkspaceBaseDir(workspaceBaseDir)) return;
  try {
    await rm(workspaceBaseDir, { recursive: true, force: true });
  } catch (err) {
    try {
      writeJson(join(artifactsBaseDir, "reviewer-workspace-base-cleanup-error.json"), {
        reviewer_workspace_base_cleanup: "failed",
        workspace_base_dir: workspaceBaseDir,
        error: redactSecrets(err instanceof Error ? err.message : String(err)),
      });
    } catch {
      // Do not let cleanup telemetry hide the review result or the original error.
    }
  }
}

function shouldCopyReviewerPath(
  sourceRoot: string,
  resolvedSourceRoot: string,
  sourcePath: string,
  excludeRoots: string[],
  preservePaths = new Set<string>(),
  enforceContentPolicy = true,
): boolean {
  const resolvedSourcePath = resolve(sourcePath);
  if (
    !isCopyableReviewerSymlink(sourceRoot, resolvedSourceRoot, resolvedSourcePath, excludeRoots)
  ) {
    return false;
  }
  if (excludeRoots.some((root) => isSameOrInside(root, resolvedSourcePath))) return false;
  const rel = relative(sourceRoot, resolvedSourcePath);
  if (!rel) return true;
  const parts = rel.split(/[\\/]+/);
  if (sensitiveResourcePolicy.classifyPath(rel).sensitive) {
    return false;
  }
  if (parts[0] === ".claudexor") {
    return (
      isCopyableReviewerClaudexorPath(rel, parts, preservePaths) &&
      (!enforceContentPolicy || reviewerFileContentAllowed(resolvedSourcePath))
    );
  }
  if (
    parts.some((part) => [".git", ".adversarial-review", ".turbo", "node_modules"].includes(part))
  ) {
    return false;
  }
  if (
    parts.some((part) => [".next", ".cache", "coverage", "dist"].includes(part)) &&
    !isPreservedReviewerPath(rel, preservePaths)
  ) {
    return false;
  }
  return (
    !rel.endsWith(".tsbuildinfo") &&
    (!enforceContentPolicy || reviewerFileContentAllowed(resolvedSourcePath))
  );
}

function reviewerFileContentAllowed(path: string): boolean {
  let targetStat: Stats;
  try {
    targetStat = statSync(path);
  } catch {
    return false;
  }
  if (!targetStat.isFile()) return true;
  const content = readTextSafe(path);
  return content !== null && !sensitiveResourcePolicy.containsSensitiveContent(content);
}

function isCopyableReviewerClaudexorPath(
  rel: string,
  parts: string[],
  preservePaths: Set<string>,
): boolean {
  if (parts.length === 1) {
    return true;
  }
  if (parts.length === 2 && parts[1] === "config.yaml") {
    return true;
  }
  const runtimeRoot = parts[1]?.toLowerCase();
  if (runtimeRoot && BLOCKED_REVIEWER_RUNTIME_ROOTS.has(runtimeRoot)) return false;
  return isPreservedReviewerPath(rel, preservePaths);
}

function isPreservedReviewerPath(rel: string, preservePaths: Set<string>): boolean {
  const normalized = normalizeReviewerRelativePath(rel);
  if (!normalized) return false;
  if (preservePaths.has(normalized)) return true;
  const prefix = `${normalized}/`;
  for (const preserved of preservePaths) {
    if (preserved.startsWith(prefix)) return true;
  }
  return false;
}

export function __testExtractDiffTouchedPaths(diff: string): Set<string> {
  return extractDiffTouchedPaths(diff);
}

function extractDiffTouchedPaths(diff: string): Set<string> {
  const paths = new Set<string>();
  for (const file of parseUnifiedDiff(diff).files) {
    if (file.oldPath) addReviewerPreservePath(paths, file.oldPath);
    if (file.newPath) addReviewerPreservePath(paths, file.newPath);
  }
  return paths;
}

function addReviewerPreservePath(paths: Set<string>, value: string): void {
  const normalized = normalizeReviewerRelativePath(value);
  if (normalized) paths.add(normalized);
}

function normalizeReviewerRelativePath(value: string): string | null {
  if (!value || value === "/dev/null" || isAbsolute(value)) return null;
  const normalized = normalize(value).replace(/\\/g, "/");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    return null;
  }
  return normalized;
}

function isCopyableReviewerSymlink(
  sourceRoot: string,
  resolvedSourceRoot: string,
  sourcePath: string,
  excludeRoots: string[],
): boolean {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(sourcePath);
  } catch {
    return false;
  }
  if (!stat.isSymbolicLink()) return true;
  let linkTarget = "";
  let resolvedTarget = "";
  let targetKind: "directory" | "file" | "other" = "other";
  try {
    linkTarget = readlinkSync(sourcePath);
    resolvedTarget = realpathSync(sourcePath);
    const targetStat = statSync(sourcePath);
    targetKind = targetStat.isDirectory() ? "directory" : targetStat.isFile() ? "file" : "other";
  } catch {
    return false;
  }
  return sensitiveResourcePolicy.assessSymlink({
    sourceRoot,
    canonicalSourceRoot: resolvedSourceRoot,
    sourcePath,
    linkTarget,
    resolvedTargetPath: resolvedTarget,
    targetKind,
    allowedTargetKinds: ["file", "directory"],
    excludedRoots: excludeRoots,
    relocationRoot: sourceRoot,
  }).allowed;
}

async function initializeReviewerWorkspaceGit(root: string): Promise<void> {
  const noHooks = ["-c", "core.hooksPath=/dev/null"];
  await runGitOrThrow("init", root, ["-c", "init.templateDir=", ...noHooks, "init"]);
  for (const [key, value] of [
    ["user.email", "claudexor-review@example.invalid"],
    ["user.name", "Claudexor Review"],
  ]) {
    await runGitOrThrow(`config ${key}`, root, [...noHooks, "config", key, value]);
  }
  await runGitOrThrow("add", root, [...noHooks, "add", "-A", "--force"]);
  await runGitOrThrow("commit", root, [
    ...noHooks,
    "commit",
    "--allow-empty",
    "--no-verify",
    "--no-gpg-sign",
    "-m",
    "review baseline",
  ]);
}

async function runGitOrThrow(label: string, cwd: string, args: string[]): Promise<void> {
  const gitEnv: Record<string, string | null> = Object.fromEntries(
    Object.keys(process.env)
      .filter((key) => key.startsWith("GIT_"))
      .map((key) => [key, null]),
  );
  gitEnv.GIT_CONFIG_NOSYSTEM = "1";
  const result = await runCapture("git", args, { cwd, env: gitEnv, timeoutMs: 60_000 });
  if (result.code === 0) return;
  const detail = redactSecrets((result.stderr || result.stdout || `exit ${result.code}`).trim());
  throw new Error(`failed to prepare reviewer workspace (${label}): ${detail}`);
}

function isSameOrInside(parent: string, target: string): boolean {
  const rel = relative(resolve(parent), resolve(target));
  const firstPart = rel.split(/[\\/]+/)[0];
  return rel === "" || (!!rel && firstPart !== ".." && !isAbsolute(rel));
}

function createReviewerArtifactContext(
  baseDir: string,
  index: number,
  reviewer: ReviewerSpec,
): ReviewerArtifactContext {
  const dir = join(
    baseDir,
    `${String(index + 1).padStart(2, "0")}-${safeFilePart(reviewer.adapter.id)}`,
  );
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
  patch: Omit<
    ReviewerProgressEvent,
    "harness_id" | "provider_family" | "requested_model" | "requested_effort" | "artifact_dir"
  >,
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

function transientRetryDelayMs(policy: TransientRetryPolicy, retryIndex: number): number {
  return Math.min(policy.initialDelayMs * 2 ** retryIndex, policy.maxDelayMs);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function updateReviewerMetadata(
  artifact: ReviewerArtifactContext,
  patch: Record<string, unknown>,
): void {
  artifact.metadata = { ...artifact.metadata, ...redactValue(patch) };
  writeJson(artifact.metadataPath, artifact.metadata);
}

function tryUpdateReviewerMetadata(
  artifact: ReviewerArtifactContext,
  patch: Record<string, unknown>,
): void {
  try {
    updateReviewerMetadata(artifact, patch);
  } catch {
    // Cleanup telemetry must never hide the review result or original error.
  }
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
