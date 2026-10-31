import {
  appendHarnessEvent,
  observeCredentialExecution,
  bindCredentialExecutionObserverFactory,
  type CredentialExecutionObserverFactory,
  admitPreparedProcessing,
  stampCredentialProfileSelection,
  harnessHostFactsEnv,
} from "@claudexor/core";
import { prepareReviewerRunSpec, recordPreparedEffort } from "./reviewerPreparation.js";
import { preflightEvidence, type DiffEvidence, writeDiffEvidence } from "@claudexor/context";
import type { HarnessEvent, ProviderFamily, ReviewFinding, RouteProof } from "@claudexor/schema";
import { HarnessRunSpec, ReviewFinding as ReviewFindingSchema } from "@claudexor/schema";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  appendLine,
  engineBuildIdentity,
  ensureDir,
  newId,
  nowIso,
  readTextSafe,
  redactSecrets,
  sha256,
  writeJson,
  writeText,
} from "@claudexor/util";
import {
  dedupeFindings,
  extractJsonBlocks,
  parseFindingsDetailed,
  parseSealedReviewEnvelopeDetailed,
  sealedReviewTranscriptChunk,
  type ReviewerInfo,
} from "./findings.js";
import {
  buildReviewPrompt,
  CHANGED_PATHS_FILE,
  SEALED_REVIEW_OUTPUT_SCHEMA,
} from "./reviewPrompt.js";
import { sealedReviewTranscriptFromEvents } from "./sealedReviewEnvelope.js";
import {
  buildReviewerCandidateInventory,
  cleanupTemporaryReviewerWorkspaceBaseDir,
  copyReviewEvidencePacket,
  extractDiffPostimagePaths,
  isSameOrInside,
  prepareReviewerWorkspace,
  selectReviewerWorkspaceBaseDir,
  uninspectableFacts,
} from "./reviewerWorkspace.js";
export { extractDiffPostimagePaths as __testExtractDiffPostimagePaths } from "./reviewerWorkspace.js";
import { buildRouteProof, classifyDiversity } from "./route.js";
import type {
  ReviewerArtifactContext,
  ReviewCandidateResult,
  ReviewerOutput,
  ReviewerProgressEvent,
  ReviewerSpec,
  ReviewerWorkspace,
} from "./reviewRuntimeTypes.js";
export type {
  ReviewCandidateResult,
  ReviewerProgressEvent,
  ReviewerSpec,
} from "./reviewRuntimeTypes.js";
import { reviewerAuthMode, reviewerAuthSwitchFromEvent } from "./reviewRuntimeTypes.js";
import { ReviewerCostKnowledge } from "./reviewerCostKnowledge.js";
import { ReviewerSpendAccumulator, type PartialReviewerSpend } from "./reviewerSpendAccumulator.js";
import { WorkspaceManager } from "@claudexor/workspace";
import {
  cleanupReviewerWorkspace,
  createReviewerArtifactContext,
  emitReviewerProgress,
  insufficientEvidenceFinding,
  safeFilePart,
  sleep,
  transientRetryDelayMs,
  uninspectedManifestFindings,
  updateReviewerMetadata,
  writeParseError,
} from "./reviewerArtifacts.js";

export interface ReviewCandidateInput {
  candidateLabel: string;
  diff: string;
  /** Exactly the changed paths a reviewer copy holds, where no patch shows the change. */
  candidatePaths?: string[];
  /** Those paths come with a FILES.json the caller wrote to the evidence packet (a
   * directory result). Without it, the review writes the list as CHANGED_PATHS.json. */
  candidatePathsHaveManifest?: boolean;
  /** `cwd` is a copy of a result's saved files; one that failed is never read (see
   * prepareReviewerWorkspace). What it names is a review fact whatever each reviewer does. */
  savedCopy?: { unavailable: readonly { path: string; reason: string }[]; failed?: boolean };
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
  /** Cumulative panel cash plus amounts of unknown meaning on potentially paid routes. */
  onUsageCost?: (panelPaidOrUnknownUsd: number) => boolean;
  onBeforeDispatch?: (reviewerIndex: number, spec: HarnessRunSpec) => void | Promise<void>;
  credentialObserverFactory?: CredentialExecutionObserverFactory;
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
const REVIEW_WAVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  credentialProfileId: string | null | undefined,
  source: RouteProof["observed"]["evidence_source"],
  peerFamilies: ProviderFamily[],
): RouteProof {
  return buildRouteProof(
    {
      harness_id: reviewer.adapter.id,
      provider_family: reviewer.providerFamily,
      model_hint: reviewer.requestedModel ?? null,
      ...(reviewer.credentialProfile !== undefined
        ? { credential_profile_id: reviewer.credentialProfile?.profile_id ?? null }
        : {}),
    },
    {
      provider: reviewer.providerFamily,
      model_id: modelId,
      ...(credentialProfileId !== undefined ? { credential_profile_id: credentialProfileId } : {}),
      evidence_source: modelId ? source : "unavailable",
    },
    peerFamilies,
  );
}

function reviewerInfo(
  reviewer: ReviewerSpec,
  routeProofStatus: RouteProof["status"],
  observedModel: string | null = null,
  observedCredentialProfileId: string | null | undefined = undefined,
): ReviewerInfo {
  return {
    harness_id: reviewer.adapter.id,
    requested_model: reviewer.requestedModel ?? null,
    requested_effort: reviewer.requestedEffort ?? null,
    ...(reviewer.credentialProfile !== undefined
      ? { credential_profile_id: reviewer.credentialProfile?.profile_id ?? null }
      : {}),
    observed_model: observedModel,
    ...(observedCredentialProfileId !== undefined
      ? { observed_credential_profile_id: observedCredentialProfileId }
      : {}),
    route_proof_status: routeProofStatus,
  };
}

export async function reviewCandidate(input: ReviewCandidateInput): Promise<ReviewCandidateResult> {
  const sourceRoot = resolve(input.cwd);
  const sourceExists = existsSync(sourceRoot);
  const canonicalSourceRoot = sourceExists ? realpathSync(sourceRoot) : sourceRoot;
  const sourceEvidencePath = resolve(input.evidenceDir);
  const sourceEvidenceRoot = existsSync(input.evidenceDir)
    ? realpathSync(input.evidenceDir)
    : sourceEvidencePath;
  if (sourceExists && isSameOrInside(sourceEvidenceRoot, canonicalSourceRoot)) {
    throw new Error("review evidence directory must not contain the candidate root");
  }
  const evidenceInsideLexicalSource =
    sourceExists && isSameOrInside(sourceRoot, sourceEvidencePath);
  const evidenceInsideCanonicalSource =
    sourceExists && isSameOrInside(canonicalSourceRoot, sourceEvidenceRoot);
  const evidencePathInSourceNamespace = evidenceInsideCanonicalSource
    ? resolve(sourceRoot, relative(canonicalSourceRoot, sourceEvidenceRoot))
    : null;
  const candidateEvidenceExcludeRoots =
    evidenceInsideLexicalSource || evidenceInsideCanonicalSource
      ? [
          ...new Set(
            [sourceEvidencePath, sourceEvidenceRoot, evidencePathInSourceNamespace].filter(
              (path): path is string => path !== null,
            ),
          ),
        ]
      : [];
  const findingsByReviewer: ReviewFinding[][] = input.reviewers.map(() => []);
  const reviewerFamilies = input.reviewers.map((reviewer) => reviewer.providerFamily);
  const routeProofs: RouteProof[] = input.reviewers.map((reviewer, index) =>
    reviewerRouteProof(
      reviewer,
      null,
      undefined,
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
      ...(reviewer.credentialProfile !== undefined
        ? { credential_profile_id: reviewer.credentialProfile?.profile_id ?? null }
        : {}),
    }),
  );
  const healthyReviewerIndexes = new Set<number>();
  const uninspectable = [...(input.savedCopy?.unavailable ?? [])];
  const reviewerSpend = new ReviewerSpendAccumulator(input.reviewers.length);
  const streamedPaid = Array<number>(input.reviewers.length).fill(0);
  const budgetAbort = new AbortController();
  const reviewerSignal = input.signal
    ? AbortSignal.any([input.signal, budgetAbort.signal])
    : budgetAbort.signal;
  const reviewerTimeoutMs = input.reviewerTimeoutMs ?? DEFAULT_REVIEWER_TIMEOUT_MS;
  const reviewWaveId =
    input.env?.["CLAUDEXOR_REVIEW_WAVE_ID"] ?? process.env["CLAUDEXOR_REVIEW_WAVE_ID"] ?? null;
  if (input.evidenceReadOnly && input.frozenIdentity && !REVIEW_WAVE_ID.test(reviewWaveId ?? "")) {
    throw new Error("sealed release review requires CLAUDEXOR_REVIEW_WAVE_ID UUID");
  }
  const frozenMetadata = input.frozenIdentity
    ? (() => {
        const runtime = engineBuildIdentity();
        const runtimeEntry = realpathSync(runtime.entry);
        const runtimeEntryStat = lstatSync(runtimeEntry);
        if (!runtimeEntryStat.isFile() || runtimeEntryStat.isSymbolicLink()) {
          throw new Error("sealed release review runtime entry is not a regular file");
        }
        return {
          candidate_sha: input.frozenIdentity.candidateSha,
          candidate_tree: input.frozenIdentity.candidateTree,
          packet_manifest_sha256: input.frozenIdentity.packetManifestSha256,
          review_runtime_version: runtime.version,
          review_runtime_build_sha: runtime.sha,
          review_runtime_entry: runtimeEntry,
          review_runtime_entry_sha256: createHash("sha256")
            .update(readFileSync(runtimeEntry))
            .digest("hex"),
          ...(reviewWaveId ? { review_wave_id: reviewWaveId } : {}),
        };
      })()
    : {};
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
  const postimagePaths = input.candidatePaths
    ? new Set(input.candidatePaths)
    : extractDiffPostimagePaths(input.diff);
  const candidateInventory = await buildReviewerCandidateInventory(
    input.cwd,
    postimagePaths,
    input.evidenceReadOnly === true,
    input.candidatePaths,
    input.candidatePathsHaveManifest,
  );
  const artifactsBaseDir = input.artifactsDir ?? join(input.evidenceDir, "reviewer-artifacts");
  if (
    input.evidenceReadOnly &&
    input.frozenIdentity &&
    existsSync(artifactsBaseDir) &&
    readdirSync(artifactsBaseDir).length > 0
  ) {
    throw new Error("sealed release review requires a fresh empty artifacts directory");
  }
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
  if (candidateInventory.mode === "explicit_paths")
    writeJson(join(persistentEvidenceDir, CHANGED_PATHS_FILE), input.candidatePaths);
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
      candidate_inventory_mode: candidateInventory.mode,
      candidate_inventory_reason: candidateInventory.reason,
      ...frozenMetadata,
    },
  );
  const artifacts: (ReviewerArtifactContext | undefined)[] = input.reviewers.map(() => undefined);
  const reviewerWorkspaceBaseDir = selectReviewerWorkspaceBaseDir(
    input.cwd,
    artifactsBaseDir,
    input.evidenceDir,
  );

  const runReviewer = async (reviewer: ReviewerSpec, index: number): Promise<void> => {
    if (input.signal?.aborted) return;
    const artifact = createReviewerArtifactContext(artifactsBaseDir, index, reviewer);
    artifacts[index] = artifact;
    // Scratch state is per reviewer; the credential store stays adapter-owned.
    const reviewerScratch = new WorkspaceManager(input.cwd).readOnlyHomeEnv();
    // Scratch HOME last (it is the reviewer's scoped native-state home), then
    // the host facts that scoped home owes the child (operator home, Playwright
    // cache); the caller's env carries the run's process-scope marker.
    // Facts are computed over the MERGED patch so an explicit value already in
    // the caller's env (a per-package Playwright `0`) is seen and left alone.
    const reviewerPatch = { ...(input.env ?? {}), ...reviewerScratch.env };
    const reviewerEnv = { ...reviewerPatch, ...harnessHostFactsEnv(reviewerPatch) };
    let reviewerWorkspace: ReviewerWorkspace | null = null;
    let spec: HarnessRunSpec | null = null;
    try {
      reviewerWorkspace = await prepareReviewerWorkspace({
        sourceRoot: input.cwd,
        sourceEvidenceDir: persistentEvidenceDir,
        workspaceBaseDir: reviewerWorkspaceBaseDir,
        reviewerDirName: `${String(index + 1).padStart(2, "0")}-${safeFilePart(reviewer.adapter.id)}`,
        excludeRoots: [artifactsBaseDir, ...candidateEvidenceExcludeRoots],
        postimagePaths,
        candidateCopyPaths: candidateInventory.copyPaths,
        candidatePaths: input.candidatePaths,
        savedCopy: input.savedCopy,
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
        candidate_inventory_mode: candidateInventory.mode,
        candidate_inventory_reason: candidateInventory.reason,
        uninspectable_files: reviewerWorkspace.uninspectable,
        ...frozenMetadata,
      });
      const runtimePrompt = buildReviewPrompt(
        input.candidateLabel,
        reviewerWorkspace.root,
        reviewerWorkspace.evidenceDir,
        reviewerPatch,
        {
          sealed: input.evidenceReadOnly === true,
          candidateInventoryMode: candidateInventory.mode,
          uninspectableFiles: reviewerWorkspace.uninspectable,
        },
      );
      spec = HarnessRunSpec.parse({
        session_id: newId("rev"),
        intent: "review",
        prompt: runtimePrompt,
        cwd: reviewerWorkspace.root,
        access: "readonly",
        ...(input.evidenceReadOnly && input.frozenIdentity
          ? {
              external_context_policy: "live",
              tool_permission_policy: { web: "live", allow: [], deny: [] },
            }
          : {}),
        model_hint: reviewer.requestedModel ?? null,
        effort_hint: reviewer.requestedEffort ?? null,
        processing_preference: reviewer.processingPreference,
        processing: reviewer.processing?.receipt,
        processing_cost_basis: reviewer.processing?.costBasis,
        processing_allow_paid: reviewer.processingAllowPaid,
        prompt_cache_ttl: reviewer.promptCacheTtl,
        auth_preference: reviewer.authPreference ?? "auto",
        credential_profile: reviewer.credentialProfile ?? null,
        env_inheritance: input.envInheritance ?? "mirror_native",
        ...(input.evidenceReadOnly && input.frozenIdentity
          ? { output_schema: SEALED_REVIEW_OUTPUT_SCHEMA }
          : {}),
        env: reviewerEnv,
      });
      stampCredentialProfileSelection(spec, { pinned: reviewer.profilePinned !== false });
      bindCredentialExecutionObserverFactory(spec, input.credentialObserverFactory);
      if (input.onBeforeDispatch)
        spec.extra["processingAdmission"] = async (actual: HarnessRunSpec) => {
          // Billing follows the prepared route, including profile rotation.
          actual.extra["routeBillingKnowledge"] = (resolved: HarnessRunSpec) => {
            const profileKind = resolved.credential_profile?.credential_kind;
            return profileKind === "api_key"
              ? "metered"
              : profileKind
                ? "subscription_entitlement"
                : resolved.auth_preference === "api_key"
                  ? "metered"
                  : resolved.auth_preference === "subscription"
                    ? "subscription_entitlement"
                    : "unknown";
          };
          await input.onBeforeDispatch!(index, actual);
        };
      writeText(artifact.promptPath, spec.prompt);
      updateReviewerMetadata(artifact, {
        session_id: spec.session_id,
        external_context_policy: spec.external_context_policy,
        tool_web_policy: spec.tool_permission_policy.web,
        submitted_prompt_sha256: createHash("sha256").update(spec.prompt).digest("hex"),
      });
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
      reviewerScratch.dispose();
      const proof = reviewerRouteProof(reviewer, null, undefined, "unavailable", reviewerFamilies);
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
    let streamObservedCredentialProfileId: string | undefined;
    let routeModel: string | undefined;
    let routeSource: RouteProof["observed"]["evidence_source"] = "unavailable";
    let reviewerError: string | null = null;
    let sealedProjectionError: string | null = null;
    try {
      const out = await collectReviewerOutput(
        reviewer,
        spec,
        reviewerTimeoutMs,
        input.evidenceReadOnly && input.frozenIdentity
          ? { maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0 }
          : (input.transientRetryPolicy ?? DEFAULT_REVIEWER_TRANSIENT_RETRY_POLICY),
        artifact,
        input.onReviewerEvent,
        reviewerSignal,
        input.evidenceReadOnly === true,
        (amount) => {
          streamedPaid[index] = amount;
          try {
            if (input.onUsageCost?.(streamedPaid.reduce((sum, value) => sum + value, 0))) {
              budgetAbort.abort("review_budget_cap");
              return true;
            }
            return false;
          } catch (error) {
            budgetAbort.abort("review_budget_observer_failed");
            throw error;
          }
        },
      );
      text = out.text;
      sealedProjectionError = out.sealedProjectionError ?? null;
      streamObservedModel = out.observedModel;
      streamObservedCredentialProfileId = out.observedCredentialProfileId;
      routeModel = out.observedModel;
      routeSource = out.observedSource;
      reviewerSpend.record(index, out);
      if (!routeModel && reviewer.requestedModel) {
        routeModel = reviewer.requestedModel;
        routeSource = "metadata";
      }
    } catch (err) {
      reviewerError = redactSecrets(err instanceof Error ? err.message : String(err));
      const partial = err as PartialReviewerSpend & {
        partialObservedModel?: string;
        partialObservedCredentialProfileId?: string;
        partialObservedSource?: RouteProof["observed"]["evidence_source"];
        partialSealedProjectionError?: string;
        partialText?: string;
      };
      if (typeof partial?.partialText === "string" && partial.partialText.trim() !== "") {
        text = partial.partialText;
      }
      if (typeof partial?.partialSealedProjectionError === "string") {
        sealedProjectionError = partial.partialSealedProjectionError;
      }
      reviewerSpend.recordPartial(index, partial);
      if (partial?.partialObservedModel) {
        streamObservedModel = partial.partialObservedModel;
        routeModel = partial.partialObservedModel;
        routeSource = partial.partialObservedSource ?? "stream_event";
      }
      if (partial?.partialObservedCredentialProfileId) {
        streamObservedCredentialProfileId = partial.partialObservedCredentialProfileId;
      }
      writeParseError(artifact, { error: reviewerError });
    } finally {
      await cleanupReviewerWorkspace(reviewerWorkspace, artifact);
      reviewerScratch.dispose();
    }

    const proof = reviewerRouteProof(
      reviewer,
      routeModel ?? null,
      streamObservedCredentialProfileId,
      routeSource,
      reviewerFamilies.filter((_, i) => i !== index),
    );
    routeProofs[index] = proof;

    const info = reviewerInfo(
      reviewer,
      proof.status,
      streamObservedModel ?? null,
      streamObservedCredentialProfileId,
    );
    const missed = reviewerWorkspace.uninspectable;
    uninspectable.push(...missed);
    findingsByReviewer[index]?.push(
      ...uninspectedManifestFindings(info, candidateInventory.mode, missed),
    );
    const sealedParse = input.evidenceReadOnly
      ? parseSealedReviewEnvelopeDetailed(text, info)
      : null;
    const jsonBlocks = sealedParse?.blocks ?? extractJsonBlocks(text);
    // The reviewer's parsed findings are its work product, kept exact (INV-146).
    writeJson(artifact.parsedPath, jsonBlocks);
    if (sealedParse && (sealedProjectionError || sealedParse.error)) {
      const detail = sealedProjectionError ?? sealedParse.error ?? "invalid sealed review output";
      writeParseError(artifact, {
        error: "invalid_sealed_review_envelope",
        detail,
        malformed: sealedParse.malformed,
        text_sha256: sha256(text),
        ...(reviewerError ? { reviewer_error: reviewerError } : {}),
      });
      findingsByReviewer[index]?.push(...sealedParse.findings);
      findingsByReviewer[index]?.push(
        insufficientEvidenceFinding(info, `Invalid sealed review envelope: ${detail}.`),
      );
      return;
    }
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
    const parsed = sealedParse ?? parseFindingsDetailed(text, info);
    const parseError: Record<string, unknown> = {};
    let parsedFindingsRecorded = false;
    const recordParsedFindings = () => {
      if (parsedFindingsRecorded) return;
      findingsByReviewer[index]?.push(...parsed.findings);
      parsedFindingsRecorded = true;
    };
    if (parsed.malformed > 0 && !sealedParse?.error) {
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
      ...reviewerSpend.summary(),
      ...uninspectableFacts(uninspectable),
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
  sealed = false,
  onUsageCost?: (paidOrUnknownUsd: number) => boolean,
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
  let observedCredentialProfileId: string | undefined;
  let observedSource: RouteProof["observed"]["evidence_source"] = "unavailable";
  let observedAuthMode: "local_session" | "api_key" | null = null;
  let currentAuthMode: "local_session" | "api_key" | null = null;
  const observedAuthModes = new Set<"local_session" | "api_key">();
  const ignoredSettings = new Set<string>();
  let costUsd = 0;
  let costEstimated = false;
  let cashUsd = 0;
  let valuationUsd = 0;
  let unknownUsd = 0;
  const costKnowledge = new ReviewerCostKnowledge();
  let partialText = "";
  const isCancelled = () =>
    cancelledBySignal || signal?.aborted === true || controller.signal.aborted;

  const consumeOnce = async (nativeTry: number): Promise<ReviewerOutput> => {
    if (isCancelled()) throw new Error("Reviewer cancelled before dispatch");
    const prepared = await prepareReviewerRunSpec(reviewer.adapter, runSpec, reviewer.catalog);
    runSpec = prepared.spec;
    recordPreparedEffort(artifact, runSpec.session_id, prepared.effort, ignoredSettings, runSpec);
    if (isCancelled()) throw new Error("Reviewer cancelled before dispatch");
    await admitPreparedProcessing(runSpec);
    const markPhysicalDispatchStarted = runSpec.extra["markPhysicalDispatchStarted"];
    if (typeof markPhysicalDispatchStarted === "function")
      (markPhysicalDispatchStarted as () => void)();
    if (isCancelled()) throw new Error("Reviewer cancelled before dispatch");
    currentAuthMode = null;
    costKnowledge.startAttempt(runSpec);
    const iter = observeCredentialExecution(
      reviewer.adapter.id,
      runSpec,
      (reviewer.adapter.review ?? reviewer.adapter.run).call(reviewer.adapter, runSpec),
    );
    currentIter = iter;
    let text = "";
    let sawTransient = false;
    let sawError = false;
    let lastError: string | null = null;
    let attemptObservedModel: string | undefined;
    let attemptObservedCredentialProfileId: string | undefined;
    let attemptObservedSource: RouteProof["observed"]["evidence_source"] = "unavailable";
    const sealedMessageEvents: unknown[] = [];
    for await (const ev of iter) {
      const eventTime = nowIso();
      // Reviewer text is kept exact; diagnostics are masked by the shared seam.
      const persistedEvent = appendHarnessEvent(artifact.eventsPath, ev);
      const ignored = ev.payload?.["ignored_settings"];
      if (Array.isArray(ignored)) {
        for (const item of ignored) if (typeof item === "string") ignoredSettings.add(item);
        if (ignoredSettings.size > 0) {
          updateReviewerMetadata(artifact, { ignored_settings: [...ignoredSettings] });
        }
      }
      if (ev.effort_resolution)
        updateReviewerMetadata(artifact, { effort_resolution: ev.effort_resolution });
      if (ev.transient) sawTransient = true;
      if (ev.type === "error") {
        sawError = true;
        lastError = redactSecrets(ev.error ?? ev.text ?? "reviewer emitted an error event");
      }
      if (ev.type === "message" && ev.payload?.["auth_switched"] === true) {
        const authSwitch = reviewerAuthSwitchFromEvent(ev);
        if (authSwitch.to_auth_mode === "subscription") currentAuthMode = "local_session";
        if (authSwitch.to_auth_mode === "api_key") currentAuthMode = "api_key";
        updateReviewerMetadata(artifact, { auth_switch: authSwitch });
        emitReviewerProgress(artifact, reviewer, onReviewerEvent, {
          type: "reviewer.auth_switched",
          at: eventTime,
          ...authSwitch,
        });
      }
      const disclosedAuthMode = reviewerAuthMode(ev.credential_route);
      if (disclosedAuthMode) {
        currentAuthMode = disclosedAuthMode;
        observedAuthModes.add(disclosedAuthMode);
        updateReviewerMetadata(artifact, { auth_modes: [...observedAuthModes] });
      }
      costKnowledge.observeEvent(currentAuthMode, ev);
      if (!observedAuthMode) {
        observedAuthMode = disclosedAuthMode;
        if (observedAuthMode) updateReviewerMetadata(artifact, { auth_mode: observedAuthMode });
      }
      if (!firstEventTime) {
        firstEventTime = eventTime;
        updateReviewerMetadata(artifact, { first_event_time: firstEventTime });
        emitReviewerProgress(artifact, reviewer, onReviewerEvent, {
          type: "reviewer.first_event",
          at: eventTime,
        });
      }
      if (
        ev.type === "usage" &&
        typeof ev.usage?.cost_usd === "number" &&
        Number.isFinite(ev.usage.cost_usd) &&
        ev.usage.cost_usd >= 0
      ) {
        costUsd += ev.usage.cost_usd;
        if (ev.usage.estimated) costEstimated = true;
        costKnowledge.observeUsage(
          currentAuthMode,
          ev.usage.cost_usd,
          ev.usage.estimated === true,
          ev,
        );
        cashUsd = costKnowledge.totals.cashUsd;
        valuationUsd = costKnowledge.totals.valuationUsd;
        unknownUsd = costKnowledge.totals.unknownUsd;
        updateReviewerMetadata(artifact, {
          cost_usd: costUsd,
          cost_estimated: costEstimated,
          cash_usd: cashUsd,
          valuation_usd: valuationUsd,
          unknown_usd: unknownUsd,
        });
        const paidOrUnknown = cashUsd + costKnowledge.unknownPaidUsd;
        if (paidOrUnknown > 0 && onUsageCost?.(paidOrUnknown)) {
          throw new Error("Reviewer stopped at the existing paid budget cap");
        }
      }
      if (sealed && ev.type === "message" && ev.final === true) {
        sealedMessageEvents.push(persistedEvent);
      }
      if (ev.type === "message" && ev.text && ev.payload?.["auth_switched"] !== true) {
        const safeText = sealedReviewTranscriptChunk(persistedEvent);
        if (safeText !== null) {
          if (sealed) {
            // Keep the long-running transcript visibly active for monitors. A
            // clean completion replaces these progress bytes with the exact
            // typed-final projection used by the sealed parser and sealer.
            appendLine(artifact.transcriptPath, safeText);
          } else {
            text += safeText;
            partialText += safeText;
            appendLine(artifact.transcriptPath, safeText);
          }
        }
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
      if (typeof ev.credential_profile_id === "string" && ev.credential_profile_id.length > 0) {
        observedCredentialProfileId = ev.credential_profile_id;
        attemptObservedCredentialProfileId = ev.credential_profile_id;
        updateReviewerMetadata(artifact, {
          observed_credential_profile_id: ev.credential_profile_id,
        });
      }
    }
    if (isCancelled()) {
      throw new Error("Reviewer cancelled");
    }
    let sealedProjectionError: string | undefined;
    if (sealed) {
      try {
        text = sealedReviewTranscriptFromEvents(sealedMessageEvents);
        partialText = text;
        writeText(artifact.transcriptPath, text);
      } catch (error) {
        sealedProjectionError = error instanceof Error ? error.message : String(error);
      }
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
        ...(attemptObservedCredentialProfileId !== undefined
          ? { observed_credential_profile_id: attemptObservedCredentialProfileId }
          : {}),
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
      costKnowledge.finishAttempt();
      return consumeOnce(nativeTry + 1);
    }
    if (sawError && !timedOut) {
      throw Object.assign(
        new Error(`Reviewer emitted error event: ${lastError ?? "unknown error"}`),
        {
          ...(sealedProjectionError ? { partialSealedProjectionError: sealedProjectionError } : {}),
        },
      );
    }
    if (!timedOut && !isCancelled()) {
      const completedTime = nowIso();
      const durationMs = Date.now() - startMs;
      updateReviewerMetadata(artifact, {
        status: "completed",
        completion_time: completedTime,
        duration_ms: durationMs,
        observed_model: attemptObservedModel ?? null,
        ...(attemptObservedCredentialProfileId !== undefined
          ? { observed_credential_profile_id: attemptObservedCredentialProfileId }
          : {}),
        observed_source: attemptObservedSource,
        raw_normalized_stream_path: artifact.eventsPath,
        transcript_path: artifact.transcriptPath,
      });
      emitReviewerProgress(artifact, reviewer, onReviewerEvent, {
        type: "reviewer.completed",
        at: completedTime,
        duration_ms: durationMs,
        observed_model: attemptObservedModel ?? null,
        ...(attemptObservedCredentialProfileId !== undefined
          ? { observed_credential_profile_id: attemptObservedCredentialProfileId }
          : {}),
        observed_source: attemptObservedSource,
      });
    }
    const knowledge = costKnowledge.snapshot();
    costKnowledge.finishAttempt();
    return {
      text,
      ...(sealedProjectionError ? { sealedProjectionError } : {}),
      observedModel: attemptObservedModel,
      ...((attemptObservedCredentialProfileId ?? observedCredentialProfileId)
        ? {
            observedCredentialProfileId:
              attemptObservedCredentialProfileId ?? observedCredentialProfileId,
          }
        : {}),
      observedSource: attemptObservedSource,
      costUsd,
      costEstimated,
      cashUsd,
      valuationUsd,
      unknownUsd,
      ...knowledge,
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
      const knowledge = costKnowledge.snapshot();
      reject(
        Object.assign(new Error("Reviewer cancelled"), {
          partialCostUsd: costUsd,
          partialCostEstimated: costEstimated,
          partialCashUsd: cashUsd,
          partialValuationUsd: valuationUsd,
          partialUnknownUsd: unknownUsd,
          partialCashKnowledge: knowledge.cashKnowledge,
          partialAllowanceDebitUnobserved: knowledge.allowanceDebitUnobserved,
          partialValuationKnowledge: knowledge.valuationKnowledge,
          partialObservedModel: observedModel,
          partialObservedCredentialProfileId: observedCredentialProfileId,
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
          ...(observedCredentialProfileId !== undefined
            ? { observed_credential_profile_id: observedCredentialProfileId }
            : {}),
          observed_source: observedSource,
          raw_normalized_stream_path: artifact.eventsPath,
          transcript_path: artifact.transcriptPath,
        });
        emitReviewerProgress(artifact, reviewer, onReviewerEvent, {
          type: "reviewer.timed_out",
          at: timedOutAt,
          duration_ms: durationMs,
          observed_model: observedModel ?? null,
          ...(observedCredentialProfileId !== undefined
            ? { observed_credential_profile_id: observedCredentialProfileId }
            : {}),
          observed_source: observedSource,
          message: `Reviewer timed out after ${timeoutMs}ms`,
        });
        const knowledge = costKnowledge.snapshot();
        reject(
          Object.assign(new Error(`Reviewer timed out after ${timeoutMs}ms`), {
            partialCostUsd: costUsd,
            partialCostEstimated: costEstimated,
            partialCashUsd: cashUsd,
            partialValuationUsd: valuationUsd,
            partialUnknownUsd: unknownUsd,
            partialCashKnowledge: knowledge.cashKnowledge,
            partialAllowanceDebitUnobserved: knowledge.allowanceDebitUnobserved,
            partialValuationKnowledge: knowledge.valuationKnowledge,
            partialObservedModel: observedModel,
            partialObservedCredentialProfileId: observedCredentialProfileId,
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
      const knowledge = costKnowledge.snapshot();
      Object.assign(err as Record<string, unknown>, {
        partialCostUsd: costUsd,
        partialCostEstimated: costEstimated,
        partialCashUsd: cashUsd,
        partialValuationUsd: valuationUsd,
        partialUnknownUsd: unknownUsd,
        partialCashKnowledge: knowledge.cashKnowledge,
        partialAllowanceDebitUnobserved: knowledge.allowanceDebitUnobserved,
        partialValuationKnowledge: knowledge.valuationKnowledge,
        partialObservedModel: observedModel,
        partialObservedCredentialProfileId: observedCredentialProfileId,
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
