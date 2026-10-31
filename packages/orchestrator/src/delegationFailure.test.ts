import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { EventLog } from "@claudexor/event-log";
import { projectRuntimeDir, sha256 } from "@claudexor/util";
import type { CandidateRun } from "./candidateEvidence.js";
import { createAttemptTelemetry } from "./attemptTelemetry.js";
import { persistFailedInPlaceWorkProduct } from "./delegationFailure.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("uncaptured in-place receipt", () => {
  it("records manual cleanup without a patch, anchor, or false revertability", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claudexor-capture-receipt-"));
    dirs.push(repo);
    const store = new ArtifactStore(repo, { claudexorDir: join(repo, "runtime") });
    const paths = store.createRun("run-capture-refusal");
    const log = new EventLog(paths.eventsPath, "run-capture-refusal", "task-capture-refusal");
    const run = {
      attemptId: "a01",
      harnessId: "claude",
      label: "Candidate A",
      diff: "",
      gates: [],
      cost: 0,
      errored: true,
      costEstimated: false,
      errors: ["candidate output could not be captured as a complete patch"],
      telemetry: createAttemptTelemetry("auto", false),
      captureRefusal: {
        disposition: "manual_cleanup",
        detail: "candidate output could not be captured as a complete patch",
      },
    } satisfies CandidateRun;

    await persistFailedInPlaceWorkProduct({
      live: true,
      run,
      store,
      log,
      paths,
      execRoot: repo,
      projectRoot: repo,
      preTurnSha: "a".repeat(40),
      taskId: "task-capture-refusal",
      mode: "agent",
      kind: "patch",
    });

    const receipt = readFileSync(join(paths.finalDir, "work_product.yaml"), "utf8");
    expect(receipt).toContain("capture_refused: true");
    expect(receipt).toContain("capture_recovery: manual_cleanup");
    expect(receipt).not.toContain("secret_");
    expect(receipt).toContain("adopted: true");
    expect(receipt).toContain("apply_state: applied_review_blocked");
    expect(receipt).toContain("revert_anchor_id: null");
    expect(existsSync(join(paths.finalDir, "patch.diff"))).toBe(false);
    expect(readFileSync(paths.eventsPath, "utf8")).toContain('"manual_cleanup_required":true');
  });

  it("publishes a failed live candidate's credential-shaped patch exactly, never a refusal (INV-146)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "claudexor-failed-live-secretlike-"));
    dirs.push(repo, projectRuntimeDir(repo));
    const store = new ArtifactStore(repo, { claudexorDir: join(repo, "runtime") });
    const paths = store.createRun("run-failed-live");
    const log = new EventLog(paths.eventsPath, "run-failed-live", "task-failed-live");
    // Assembled at runtime so no secret-shaped literal lives in this file.
    const token = ["sk", "w".repeat(24)].join("-");
    const diff =
      "diff --git a/LEAK.txt b/LEAK.txt\nnew file mode 100644\n--- /dev/null\n+++ b/LEAK.txt\n" +
      `@@ -0,0 +1 @@\n+${token}\n`;
    const run = {
      attemptId: "a01",
      harnessId: "claude",
      label: "Candidate A",
      diff,
      gates: [],
      cost: 0,
      errored: true,
      costEstimated: false,
      errors: ["delegation belt tool failed after injection"],
      telemetry: createAttemptTelemetry("auto", false),
    } satisfies CandidateRun;

    await persistFailedInPlaceWorkProduct({
      live: true,
      run,
      store,
      log,
      paths,
      execRoot: repo,
      projectRoot: repo,
      preTurnSha: null,
      postTurnSha: null,
      taskId: "task-failed-live",
      mode: "agent",
      kind: "patch",
    });

    expect(readFileSync(join(paths.finalDir, "patch.diff"), "utf8")).toBe(diff);
    const receipt = readFileSync(join(paths.finalDir, "work_product.yaml"), "utf8");
    expect(receipt).not.toContain("persisted_patch");
    expect(receipt).not.toContain("exact_patch_object");
    expect(receipt).toContain(`patch_sha256: ${sha256(diff)}`);
    expect(receipt).toContain("apply_state: applied_review_blocked");
  });
});
