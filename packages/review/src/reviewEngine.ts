import { runCapture, type HarnessAdapter } from "@claudexor/core";
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
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import {
  appendLine,
  containsSecretLikeToken,
  ensureDir,
  newId,
  nowIso,
  redactSecrets,
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
  /** Anonymized label (e.g. "Candidate A") — never reveal which model produced it. */
  candidateLabel: string;
  diff: string;
  evidenceDir: string;
  /** Persistent local artifact directory for raw reviewer telemetry. Defaults under evidenceDir for tests. */
  artifactsDir?: string;
  cwd: string;
  reviewers: ReviewerSpec[];
  reviewerTimeoutMs?: number;
  transientRetryPolicy?: TransientRetryPolicy;
  /** Child-env composition for the reviewer harnesses (defaults to mirror_native).
   * Reviewer runs are paid harness children too, so they must honor the configured
   * env isolation (clean) the same way candidate runs do. */
  envInheritance?: "mirror_native" | "clean";
  /** Scoped harness HOME/config-dir env (HOME, CODEX_HOME, CLAUDE_CONFIG_DIR, …)
   * for the reviewer children, so a reviewer's native state (codex session
   * rollouts, claude config) is contained in a per-review scoped home instead of
   * the operator's real ~/.codex / ~/.claude (CLAUDEXOR_BIBLE §6). The codex
   * route-proof transcript is read from this same CODEX_HOME, so B9 still
   * verifies. Adapters seed auth into these dirs. */
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

type ReviewPatchEvidence = DiffEvidence;

interface ReviewerWorkspace {
  root: string;
  evidenceDir: string;
}

function reviewPrompt(
  label: string,
  candidateRoot: string,
  evidenceDir: string,
  patch: ReviewPatchEvidence,
): string {
  return [
    "You are an adversarial code reviewer.",
    `Candidate root: ${candidateRoot}.`,
    `First read the evidence packet in ${evidenceDir} (USER_INTENT.md, FORBIDDEN_FINDINGS.md, PLAN_ACCEPTED.md, DECIDED_TRADEOFFS.md, TESTS.txt, DIFF.patch, DIFF_SUMMARY.md). If a mandatory file is missing, return INSUFFICIENT_EVIDENCE.`,
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

/**
 * Cross-family review of one anonymized candidate. Each reviewer runs its review
 * intent and emits JSON findings; we attach route proofs and verify the
 * reviewers span >= 2 distinct provider families.
 */
export async function reviewCandidate(input: ReviewCandidateInput): Promise<ReviewCandidateResult> {
  const findingsByReviewer: ReviewFinding[][] = input.reviewers.map(() => []);
  const routeProofs: RouteProof[] = [];
  const reviewerRequests: ReviewCandidateResult["reviewerRequests"] = [];
  const healthyFamilies = new Set<ProviderFamily>();
  const healthyReviewerIndexes = new Set<number>();
  let reviewSpendUsd = 0;
  let reviewSpendEstimated = false;
  const reviewerTimeoutMs = input.reviewerTimeoutMs ?? DEFAULT_REVIEWER_TIMEOUT_MS;
  if (containsSecretLikeToken(input.diff || "(empty diff)\n")) {
    throw new Error(
      "diff evidence contains a secret-like token; refusing to persist raw DIFF.patch",
    );
  }
  writeDiffEvidence(input.evidenceDir, input.diff);
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
  await copyReviewEvidencePacket(input.evidenceDir, persistentEvidenceDir);
  const persistentPatch = writeDiffEvidence(persistentEvidenceDir, input.diff);
  writeJson(join(persistentEvidenceDir, "metadata.json"), {
    source_evidence_dir: input.evidenceDir,
    candidate_root: input.cwd,
    persistent_evidence_dir: persistentEvidenceDir,
    diff_path: persistentPatch.diffPath,
    summary_path: persistentPatch.summaryPath,
    diff_sha256: persistentPatch.diffSha256,
  });
  const artifacts: ReviewerArtifactContext[] = [];
  const reviewerFamilies = input.reviewers.map((r) => r.providerFamily);
  const preservePaths = extractDiffTouchedPaths(input.diff);
  const reviewerWorkspaceBaseDir = selectReviewerWorkspaceBaseDir(
    input.cwd,
    artifactsBaseDir,
    input.evidenceDir,
  );

  try {
    for (const [index, reviewer] of input.reviewers.entries()) {
      if (input.signal?.aborted) break;
      reviewerRequests.push({
        harness_id: reviewer.adapter.id,
        provider_family: reviewer.providerFamily,
        requested_model: reviewer.requestedModel ?? null,
        requested_effort: reviewer.requestedEffort ?? null,
      });
      const artifact = createReviewerArtifactContext(artifactsBaseDir, index, reviewer);
      artifacts.push(artifact);
      let reviewerWorkspace: ReviewerWorkspace | null = null;
      let spec: HarnessRunSpec | null = null;
      try {
        reviewerWorkspace = await prepareReviewerWorkspace({
          sourceRoot: input.cwd,
          sourceEvidenceDir: input.evidenceDir,
          workspaceBaseDir: reviewerWorkspaceBaseDir,
          reviewerDirName: `${String(index + 1).padStart(2, "0")}-${safeFilePart(reviewer.adapter.id)}`,
          excludeRoots: [artifactsBaseDir],
          preservePaths,
        });
        const reviewerPatch = writeDiffEvidence(reviewerWorkspace.evidenceDir, input.diff);
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
        });
        const runtimePrompt = reviewPrompt(
          input.candidateLabel,
          reviewerWorkspace.root,
          reviewerWorkspace.evidenceDir,
          reviewerPatch,
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
        const proof = buildRouteProof(
          {
            harness_id: reviewer.adapter.id,
            provider_family: reviewer.providerFamily,
            model_hint: reviewer.requestedModel ?? null,
          },
          {
            provider: reviewer.providerFamily,
            model_id: null,
            evidence_source: "unavailable",
          },
          reviewerFamilies,
        );
        routeProofs.push(proof);
        findingsByReviewer[index]?.push(
          insufficientEvidenceFinding(
            {
              harness_id: reviewer.adapter.id,
              requested_model: reviewer.requestedModel ?? null,
              requested_effort: reviewer.requestedEffort ?? null,
              observed_model: null,
              route_proof_status: proof.status,
            },
            `Reviewer setup failed: ${message}`,
          ),
        );
        continue;
      }
      if (!reviewerWorkspace || !spec) continue;

      let text = "";
      // Stream-observed model: ONLY a model the native CLI actually emitted in its
      // stream (stream_event/transcript/model_catalog). This is the honest
      // `observed_model` for findings — an accepted argv echo is NOT an observation.
      let streamObservedModel: string | undefined;
      // Route-proof model: stream-observed when present, else the accepted argv arg
      // (metadata tier). Drives RouteProof.observed.model_id + status.
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
        reviewSpendUsd += out.costUsd;
        if (out.costEstimated) reviewSpendEstimated = true;
        // accepted_model_arg semantics: when WE passed an explicit model argument
        // and the native CLI completed without rejecting it, the accepted argv is
        // metadata-level route evidence (weaker than stream-observed, stronger
        // than nothing). Some CLIs (codex exec --json) never echo the model. This
        // populates ONLY the route proof — never streamObservedModel, so the
        // finding's observed_model stays null (an argv echo is not an observation).
        if (!routeModel && reviewer.requestedModel) {
          routeModel = reviewer.requestedModel;
          routeSource = "metadata";
        }
      } catch (err) {
        reviewerError = redactSecrets(err instanceof Error ? err.message : String(err));
        // Budget truth: a reviewer that streamed paid tokens then timed out/failed
        // still spent money. Fold the partial cost into the ledger (the success
        // path adds out.costUsd above; these paths are mutually exclusive).
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
          reviewSpendUsd += partial.partialCostUsd;
          if (partial.partialCostEstimated) reviewSpendEstimated = true;
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

      const proof = buildRouteProof(
        {
          harness_id: reviewer.adapter.id,
          provider_family: reviewer.providerFamily,
          model_hint: reviewer.requestedModel ?? null,
        },
        {
          provider: reviewer.providerFamily,
          model_id: routeModel ?? null,
          evidence_source: routeModel ? routeSource : "unavailable",
        },
        // The other reviewers' families this route is meant to be diverse against
        // (mirrors the implementer route proof; reviewer diversity is otherwise
        // enforced via classifyDiversity's same_model_fallback status below).
        reviewerFamilies.filter((_, i) => i !== index),
      );
      routeProofs.push(proof);

      const info: ReviewerInfo = {
        harness_id: reviewer.adapter.id,
        requested_model: reviewer.requestedModel ?? null,
        requested_effort: reviewer.requestedEffort ?? null,
        // Honest observation only: a finding's observed_model is the STREAM-observed
        // model or null. An accepted argv arg lives in the route proof's model_id,
        // not here — it must not masquerade as an observed model.
        observed_model: streamObservedModel ?? null,
        route_proof_status: proof.status,
      };
      const jsonBlocks = extractJsonBlocks(text);
      writeJson(artifact.parsedPath, redactValue(jsonBlocks));
      if (reviewerError && (text.trim() === "" || jsonBlocks.length === 0)) {
        findingsByReviewer[index]?.push(
          insufficientEvidenceFinding(info, `Reviewer failed: ${reviewerError}`),
        );
        continue;
      }
      if (text.trim() === "" || jsonBlocks.length === 0) {
        writeParseError(artifact, { error: "no_parseable_json", text_sha256: sha256(text) });
        findingsByReviewer[index]?.push(
          insufficientEvidenceFinding(info, "Reviewer produced no parseable JSON findings."),
        );
        continue;
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
        continue;
      }
      if (reviewer.providerFamily !== "unknown") healthyFamilies.add(reviewer.providerFamily);
      healthyReviewerIndexes.add(index);
      findingsByReviewer[index]?.push(...parsed.findings);
    }

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
    const healthyProviders = [...healthyFamilies];
    // RR1 two-tier route proof: crossFamilyVerified — the strong tier that unblocks
    // apply — requires the model to have been OBSERVED in the reviewer stream
    // (status "verified"). An argv/metadata echo ("accepted_model_arg") is a weaker
    // tier: it proves we PASSED a model arg, not that the CLI ran it, so it must
    // NOT unblock apply on unobserved proof. same_model_fallback never counts.
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
      reviewSpendUsd,
      reviewSpendEstimated,
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
  // Reviewer spend tracked at function scope so a timed-out/failed reviewer still
  // contributes its PARTIAL cost to the ledger (budget truth). It is attached to
  // the thrown error so the caller can fold it in.
  let costUsd = 0;
  let costEstimated = false;
  let partialText = "";
  const isCancelled = () => cancelledBySignal || signal?.aborted === true || controller.signal.aborted;

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
      artifactDir: artifact.dir,
      costUsd,
      costEstimated,
    };
  };
  const consume = consumeOnce(0);

  const removeExternalAbortListeners: Array<() => void> = [];
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
    removeExternalAbortListeners.push(() => signal.removeEventListener("abort", onAbort));
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
    for (const removeExternalAbortListener of removeExternalAbortListeners) {
      removeExternalAbortListener();
    }
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
      await rm(evidenceDir, { recursive: true, force: true });
      await cp(sourceEvidenceDir, evidenceDir, {
        recursive: true,
        dereference: false,
        filter: (sourcePath) =>
          shouldCopyReviewerPath(
            sourceEvidenceDir,
            resolvedSourceEvidenceDir,
            sourcePath,
            excludeRoots,
          ),
      });
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
): Promise<void> {
  const source = resolve(sourceEvidenceDir);
  const target = resolve(persistentEvidenceDir);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true, mode: 0o700 });
  if (!existsSync(source)) {
    return;
  }
  const resolvedSource = realpathSync(source);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    if (!shouldCopyEvidencePacketPath(source, resolvedSource, sourcePath, target)) {
      continue;
    }
    await cp(sourcePath, join(target, entry.name), {
      recursive: true,
      dereference: false,
      filter: (nestedSourcePath) =>
        shouldCopyEvidencePacketPath(source, resolvedSource, nestedSourcePath, target),
    });
  }
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
  return shouldCopyReviewerPath(sourceEvidenceDir, resolvedSourceEvidenceDir, resolvedSourcePath, [
    targetEvidenceDir,
  ]);
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
  if (parts.some(isReviewerSecretLikePathPart)) {
    return false;
  }
  if (parts[0] === ".claudexor") {
    return isCopyableReviewerClaudexorPath(rel, parts, preservePaths);
  }
  if (
    parts.some((part) =>
      [
        ".git",
        ".adversarial-review",
        ".turbo",
        "node_modules",
      ].includes(part),
    )
  ) {
    return false;
  }
  if (
    parts.some((part) => [".next", ".cache", "coverage", "dist"].includes(part)) &&
    !isPreservedReviewerPath(rel, preservePaths)
  ) {
    return false;
  }
  return !rel.endsWith(".tsbuildinfo");
}

function isReviewerSecretLikePathPart(part: string): boolean {
  const lower = part.toLowerCase();
  if (lower.startsWith(".env") && !isSafeEnvTemplateName(lower)) return true;
  if (
    [
      ".npmrc",
      ".netrc",
      ".pypirc",
      ".git-credentials",
      ".ssh",
      ".aws",
      ".azure",
      ".gcloud",
      ".cursor",
      ".codex",
      ".claude",
      ".anthropic",
      ".openai",
    ].includes(lower)
  ) {
    return true;
  }
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(lower)) return true;
  if (lower.endsWith(".pem") || lower.endsWith(".p12") || lower.endsWith(".pfx")) return true;
  return false;
}

function isSafeEnvTemplateName(lower: string): boolean {
  return [".env.example", ".env.sample", ".env.template"].includes(lower);
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
  if (
    runtimeRoot &&
    [
      "auth",
      "cache",
      "daemon",
      "home",
      "homes",
      "logs",
      "runs",
      "secrets",
      "state",
      "tmp",
      "workspaces",
    ].includes(runtimeRoot)
  ) {
    return false;
  }
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

function extractDiffTouchedPaths(diff: string): Set<string> {
  const paths = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      for (const path of parseDiffGitHeaderPaths(line)) {
        addReviewerPreservePath(paths, path);
      }
    } else if (line.startsWith("rename from ")) {
      addReviewerPreservePath(paths, line.slice("rename from ".length).trim());
    } else if (line.startsWith("rename to ")) {
      addReviewerPreservePath(paths, line.slice("rename to ".length).trim());
    }
  }
  return paths;
}

function parseDiffGitHeaderPaths(line: string): string[] {
  const rest = line.slice("diff --git ".length);
  const tokens: string[] = [];
  let i = 0;
  while (i < rest.length && tokens.length < 2) {
    while (rest[i] === " ") i += 1;
    if (i >= rest.length) break;
    if (rest[i] === '"') {
      i += 1;
      let token = "";
      while (i < rest.length) {
        const ch = rest[i] ?? "";
        if (ch === '"') {
          i += 1;
          break;
        }
        if (ch === "\\" && i + 1 < rest.length) {
          token += rest[i + 1] ?? "";
          i += 2;
          continue;
        }
        token += ch;
        i += 1;
      }
      tokens.push(token);
    } else {
      const start = i;
      while (i < rest.length && rest[i] !== " ") i += 1;
      tokens.push(rest.slice(start, i));
    }
  }
  return tokens.map((token) => token.replace(/^[ab]\//, ""));
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
  try {
    linkTarget = readlinkSync(sourcePath);
    resolvedTarget = realpathSync(sourcePath);
  } catch {
    return false;
  }
  if (isAbsolute(linkTarget)) return false;
  if (!isSameOrInside(resolvedSourceRoot, resolvedTarget)) return false;
  if (excludeRoots.some((root) => isSameOrInside(root, resolvedTarget))) return false;

  const sourceParentRel = relative(sourceRoot, dirname(sourcePath));
  if (sourceParentRel.split(/[\\/]+/)[0] === ".." || isAbsolute(sourceParentRel)) return false;

  const relocatedTargetRel = normalize(join(sourceParentRel, linkTarget));
  const relocatedFirstPart = relocatedTargetRel.split(/[\\/]+/)[0];
  if (relocatedFirstPart === ".." || isAbsolute(relocatedTargetRel)) return false;

  const relocatedTargetPath = resolve(sourceRoot, relocatedTargetRel);
  if (!isSameOrInside(sourceRoot, relocatedTargetPath)) return false;
  return !excludeRoots.some((root) => isSameOrInside(root, relocatedTargetPath));
}

async function initializeReviewerWorkspaceGit(root: string): Promise<void> {
  await runGitOrThrow("init", root, [
    "-c",
    "init.templateDir=",
    "-c",
    "core.hooksPath=/dev/null",
    "init",
  ]);
  await runGitOrThrow("config user.email", root, [
    "-c",
    "core.hooksPath=/dev/null",
    "config",
    "user.email",
    "claudexor-review@example.invalid",
  ]);
  await runGitOrThrow("config user.name", root, [
    "-c",
    "core.hooksPath=/dev/null",
    "config",
    "user.name",
    "Claudexor Review",
  ]);
  await runGitOrThrow("add", root, ["-c", "core.hooksPath=/dev/null", "add", "-A", "--force"]);
  await runGitOrThrow("commit", root, [
    "-c",
    "core.hooksPath=/dev/null",
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
  /** Scoped harness HOME/config-dir env for the reviewer children (HOME,
   * CODEX_HOME, CLAUDE_CONFIG_DIR, …). REQUIRED for any caller that runs real
   * paid harnesses, so reviewer native state stays contained outside the
   * operator's real home (CLAUDEXOR_BIBLE §6) — mirror the orchestrator's
   * `reviewScoped` funnel. (No in-repo caller today; threaded for correctness if
   * one is added.) */
  env?: Record<string, string>;
}

/**
 * Cross-review matrix: review every candidate with the same panel of reviewers.
 * NOTE: any caller must pass `options.env` (a scoped harness home) — see §6.
 */
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
      ...(options.env ? { env: options.env } : {}),
      onReviewerEvent: options.onReviewerEvent,
    });
    out.push({ attemptId: c.attemptId, label: c.label, result });
  }
  return out;
}
