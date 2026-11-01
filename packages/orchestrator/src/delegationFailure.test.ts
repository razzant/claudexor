import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { EventLog } from "@claudexor/event-log";
import { projectRuntimeDir, sha256 } from "@claudexor/util";
import type { CandidateRun } from "./candidateEvidence.js";
import { createAttemptTelemetry } from "./attemptTelemetry.js";
import {
  dominantRaceCandidateFailure,
  persistFailedInPlaceWorkProduct,
  raceSummaryDisclosure,
} from "./delegationFailure.js";

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

// #563 owner decision A: in a directory race, a candidate whose isolated copy
// could not be retained durably is excluded, never fatal for a healthy sibling.
// Every other dominant failure keeps its precedence.
describe("race precedence of a capture refusal", () => {
  const candidate = (
    attemptId: string,
    captureRefusal?: CandidateRun["captureRefusal"],
    telemetry = createAttemptTelemetry("auto", false),
  ) =>
    ({
      attemptId,
      harnessId: `h-${attemptId}`,
      label: `Candidate ${attemptId}`,
      diff: "",
      gates: [],
      cost: 0,
      errored: captureRefusal !== undefined,
      costEstimated: false,
      errors: captureRefusal ? [captureRefusal.detail] : [],
      telemetry,
      ...(captureRefusal ? { captureRefusal } : {}),
    }) satisfies CandidateRun;
  const retentionFailed = {
    disposition: "manual_cleanup" as const,
    phase: "artifact_security" as const,
    sourceRoot: "/runtime/workspaces/task/a01/tree",
    detail:
      "Directory output capture failed … held by this process only (durable retention could not be recorded).",
    retentionFailure: { code: "capture_failed" as const, message: "ENOTEMPTY: rename" },
  };
  const healthy = candidate("a02");

  it("excludes a directory copy whose retention failed instead of failing the race", () => {
    expect(
      dominantRaceCandidateFailure([candidate("a01", retentionFailed), healthy], {
        workspaceKind: "directory",
      }),
    ).toBeUndefined();
  });

  it("keeps a Git source whose retention failed race-fatal (unchanged)", () => {
    const git = candidate("a01", { ...retentionFailed, phase: "workspace" });
    expect(dominantRaceCandidateFailure([git, healthy], { workspaceKind: "git" })).toBe(git);
    expect(dominantRaceCandidateFailure([git, healthy], {})).toBe(git);
  });

  it("keeps an in-place directory refusal race-fatal (unchanged)", () => {
    const live = candidate("a01", {
      disposition: "manual_cleanup",
      phase: "artifact_security",
      detail: "Directory output capture failed … Direct effects require inspection.",
    });
    expect(dominantRaceCandidateFailure([live, healthy], { workspaceKind: "directory" })).toBe(
      live,
    );
  });

  it("lets an injected Delegate belt failure lead over every capture refusal (unchanged)", () => {
    const telemetry = createAttemptTelemetry("auto", false);
    telemetry.delegationBelt.requested = true;
    telemetry.delegationBelt.failed = true;
    const belt = candidate("a03", undefined, telemetry);
    expect(
      dominantRaceCandidateFailure([candidate("a01", retentionFailed), healthy, belt], {
        workspaceKind: "directory",
      }),
    ).toBe(belt);
  });

  it("names every excluded sibling's exact receipt beside the winner in the summary", () => {
    const refused = candidate("a01", retentionFailed);
    expect(raceSummaryDisclosure(healthy, [refused, healthy])).toBe(
      `- Excluded Candidate a01 (a01, h-a01): ${retentionFailed.detail}`,
    );
    expect(raceSummaryDisclosure(healthy, [healthy])).toBeNull();
  });
});
