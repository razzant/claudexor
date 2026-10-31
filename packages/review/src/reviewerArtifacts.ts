import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewFinding } from "@claudexor/schema";
import { ReviewFinding as ReviewFindingSchema } from "@claudexor/schema";
import { appendLine, ensureDir, newId, redactSecrets, writeJson, writeText } from "@claudexor/util";
import type { ReviewerSpec, ReviewCandidateInput, TransientRetryPolicy } from "./reviewEngine.js";
import type {
  ReviewerArtifactContext,
  ReviewerInventoryMode,
  ReviewerProgressEvent,
  ReviewerWorkspace,
  UninspectableReviewerFile,
} from "./reviewRuntimeTypes.js";
import type { ReviewerInfo } from "./findings.js";
import { describeUninspectableFiles } from "./reviewPrompt.js";

export async function cleanupReviewerWorkspace(
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

export function createReviewerArtifactContext(
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
    ...(reviewer.credentialProfile !== undefined
      ? { credential_profile_id: reviewer.credentialProfile?.profile_id ?? null }
      : {}),
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

export function safeFilePart(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+/, "");
  let end = safe.length;
  while (end > 0 && safe[end - 1] === "-") end -= 1;
  return safe.slice(0, end) || "reviewer";
}

export function emitReviewerProgress(
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
    ...(reviewer.credentialProfile !== undefined
      ? { credential_profile_id: reviewer.credentialProfile?.profile_id ?? null }
      : {}),
    artifact_dir: artifact.dir,
    ...(typeof artifact.metadata["review_wave_id"] === "string"
      ? { review_wave_id: artifact.metadata["review_wave_id"] }
      : {}),
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

export function transientRetryDelayMs(policy: TransientRetryPolicy, retryIndex: number): number {
  return Math.min(policy.initialDelayMs * 2 ** retryIndex, policy.maxDelayMs);
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function updateReviewerMetadata(
  artifact: ReviewerArtifactContext,
  patch: Record<string, unknown>,
): void {
  artifact.metadata = { ...artifact.metadata, ...redactValue(patch) };
  writeJson(artifact.metadataPath, artifact.metadata);
}

export function tryUpdateReviewerMetadata(
  artifact: ReviewerArtifactContext,
  patch: Record<string, unknown>,
): void {
  try {
    updateReviewerMetadata(artifact, patch);
  } catch {
    // Cleanup telemetry must never hide the review result or original error.
  }
}

export function writeParseError(
  artifact: ReviewerArtifactContext,
  value: Record<string, unknown>,
): void {
  writeJson(artifact.parseErrorPath, redactValue(value));
}

export function redactValue<T>(value: T): T {
  try {
    return JSON.parse(redactSecrets(JSON.stringify(value))) as T;
  } catch {
    return value;
  }
}

export function insufficientEvidenceFinding(
  reviewer: ReviewerInfo,
  claim: string,
  proposedFix = "Treat this review as inconclusive and rerun with a healthy reviewer.",
): ReviewFinding {
  return ReviewFindingSchema.parse({
    id: newId("f"),
    severity: "INSUFFICIENT_EVIDENCE",
    category: "test_gap",
    claim,
    evidence: {},
    proposed_fix: proposedFix,
    reviewer: {
      harness_id: reviewer.harness_id,
      requested_model: reviewer.requested_model ?? null,
      requested_effort: reviewer.requested_effort ?? null,
      ...(reviewer.credential_profile_id !== undefined
        ? { credential_profile_id: reviewer.credential_profile_id ?? null }
        : {}),
      observed_model: reviewer.observed_model ?? null,
      ...(reviewer.observed_credential_profile_id !== undefined
        ? { observed_credential_profile_id: reviewer.observed_credential_profile_id ?? null }
        : {}),
      route_proof_status: reviewer.route_proof_status ?? "unverified",
    },
    status: "insufficient_evidence",
  });
}

/** An explicit manifest or path list is all its review sees (no patch shows the
 * change), so a listed file the reviewer copy could not inspect leaves that review
 * incomplete (#535); other inventories still show the change in their patch. */
export function uninspectedManifestFindings(
  reviewer: ReviewerInfo,
  mode: ReviewerInventoryMode,
  files: readonly UninspectableReviewerFile[],
): ReviewFinding[] {
  if ((mode !== "explicit_manifest" && mode !== "explicit_paths") || files.length === 0) return [];
  return [
    insufficientEvidenceFinding(
      reviewer,
      `Review is incomplete: ${describeUninspectableFiles(files)}; no reviewer saw their content.`,
      "Make those files readable, then review this result again.",
    ),
  ];
}
