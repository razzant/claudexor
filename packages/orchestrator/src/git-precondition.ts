import { join } from "node:path";
import type { ArtifactStore } from "@claudexor/artifact-store";
import type { EventLog } from "@claudexor/event-log";
import { makeOutcomeFacts, type ModeKind, type RunReason } from "@claudexor/schema";
import { noProjectRepoRoot } from "@claudexor/util";
import {
  ensureGitRepository,
  GitBoundaryRootRefusedError,
  GitCapabilityError,
  GitInitializationError,
  type EnsureGitRepositoryResult,
} from "@claudexor/workspace";
import { writeFailure } from "./runTerminalResults.js";
import { safeErrorMessage } from "./runSupport.js";

export interface GitPreconditionFailure {
  message: string;
  reason: RunReason;
}

const NO_PROJECT_ROOT = noProjectRepoRoot();

/** Establish the write-mode Git boundary and own its typed terminal failure. */
export async function ensureWriteModeGitBoundary(
  repoRoot: string,
  log: EventLog,
  store: ArtifactStore,
  paths: ReturnType<ArtifactStore["runPaths"]>,
  runId: string,
  mode: ModeKind,
  ensureRepository: (repoRoot: string) => Promise<EnsureGitRepositoryResult> = ensureGitRepository,
): Promise<GitPreconditionFailure | null> {
  if (repoRoot === NO_PROJECT_ROOT) return null;
  try {
    const result = await ensureRepository(repoRoot);
    if (result.initialized || result.baselineCommitted) {
      log.emit("project.git.initialized", {
        repo_root: repoRoot,
        initialized: result.initialized,
        baseline_committed: result.baselineCommitted,
        gitignore_seeded: result.gitignoreSeeded,
        head_sha: result.headSha,
      });
    }
    return null;
  } catch (error) {
    const message = safeErrorMessage(error);
    const prerequisite = error instanceof GitCapabilityError;
    if (error instanceof GitInitializationError) {
      log.emit("project.git.initialized", {
        repo_root: repoRoot,
        initialized: error.progress.initialized,
        baseline_committed: error.progress.baselineCommitted,
        gitignore_seeded: error.progress.gitignoreSeeded,
        head_sha: error.progress.headSha,
        partial: true,
        failed_stage: error.progress.failedStage,
      });
    }
    // This boundary runs before a harness is admitted. Capability, filesystem,
    // and repository-initialization failures are all workspace failures; none
    // is evidence that a provider process failed. A typed boundary-root
    // refusal (home/filesystem root, INV-075) names its own remediations —
    // forward them instead of the generic advice; the reason stays unchanged.
    const refusal = error instanceof GitBoundaryRootRefusedError ? error : null;
    const reason: RunReason = "workspace_unavailable";
    writeFailure(store, paths, {
      phase: "workspace",
      category: "project",
      safeMessage: message,
      runDir: paths.root,
      nextActions: refusal
        ? refusal.requiredActions
        : prerequisite
          ? [error.capability.remediation ?? "Install Git and retry", "Retry the run"]
          : [
              "Check the project folder permissions",
              "Initialize git manually (git init)",
              "Retry the run",
            ],
    });
    store.writeText(
      join(paths.finalDir, "summary.md"),
      `# Run ${runId} (${mode})\n\n- Lifecycle: failed\n- Phase: workspace\n\n${message}\n`,
    );
    log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
    log.emit("run.failed", {
      lifecycle: "failed",
      facts: makeOutcomeFacts("failed", { reason }),
      reason,
      phase: "workspace",
      error: message,
      failure_ref: "final/failure.yaml",
    });
    return { message, reason };
  }
}
