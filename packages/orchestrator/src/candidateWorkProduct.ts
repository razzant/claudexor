import { join } from "node:path";
import type { ArtifactStore, RunPaths } from "@claudexor/artifact-store";
import type { EventLog } from "@claudexor/event-log";
import type { ModeKind, RunOutcomeFacts } from "@claudexor/schema";
import { newId } from "@claudexor/util";
import { createRevertAnchorOrNull } from "@claudexor/workspace";
import { hasCandidateChanges, type CandidateRun } from "./candidateEvidence.js";
import { persistFinalPatch } from "./secretDiff.js";

/** Publish captured Git work without accepting it or performing another mutation. */
export async function publishUnverifiedGitCandidate(input: {
  run: CandidateRun;
  store: ArtifactStore;
  paths: RunPaths;
  log: EventLog;
  taskId: string;
  mode: ModeKind;
  kind: "patch" | "new_repo";
  facts: RunOutcomeFacts;
  live: boolean;
  execRoot: string;
  projectRoot: string;
  preTurnSha: string | null;
  postTurnSha: string | null;
  attempts?: number;
}): Promise<void> {
  if (!hasCandidateChanges(input.run) || input.run.captureRefusal) return;
  const revertAnchorId = input.live
    ? await createRevertAnchorOrNull(
        input.execRoot,
        input.preTurnSha,
        input.postTurnSha,
        input.projectRoot,
      )
    : null;
  const applyState = input.live ? "applied_review_blocked" : "not_applied";
  const saved = persistFinalPatch(input.store, input.paths.finalDir, input.run);
  input.store.writeYaml(join(input.paths.finalDir, "work_product.yaml"), {
    id: newId("wp"),
    kind: input.kind,
    source_task_id: input.taskId,
    producer_attempt_id: input.run.attemptId,
    meta: {
      harness_id: input.run.harnessId,
      result_kind: "patch",
      mode: input.mode,
      ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
      lifecycle: input.facts.lifecycle,
      outcome_facts: input.facts,
      review_verified: false,
      patch_sha256: saved.patchSha256,
      ...saved.meta,
      adopted: input.live,
      apply_state: applyState,
      pre_turn_sha: input.live ? input.preTurnSha : null,
      post_turn_sha: input.live ? input.postTurnSha : null,
      revert_anchor_id: revertAnchorId,
      execution_root: input.live ? input.execRoot : null,
    },
  });
  input.log.emit("work_product.emitted", {
    producer_attempt_id: input.run.attemptId,
    apply_state: applyState,
  });
  // An unrendered object result (#535) has no patch.diff: its work product is the artifact.
  const path = saved.meta["patch_view"] ? "final/work_product.yaml" : "final/patch.diff";
  input.log.emit("output.ready", { kind: "patch", path, state: "diagnostic" });
}
