import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { GIT_OBJECTS_V1, type GitObjectResult } from "@claudexor/schema";
import { gitResultDigest } from "@claudexor/workspace";
import { projectHistoryRun } from "./thread-history-run.js";

// #535 R14 O3: a thread's history row of a run whose result record is there but
// cannot be read loses its apply coverage, typed ("unavailable", unknown, never "no
// change"), instead of failing the whole history read or claiming nothing to apply.
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(join(dir, "final/work_product.yaml"), 0o600);
    } catch {
      /* not there */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function run(readable: boolean) {
  const runDir = mkdtempSync(join(tmpdir(), "cx-history-unreadable-"));
  dirs.push(runDir);
  mkdirSync(join(runDir, "final"));
  const result: GitObjectResult = {
    schema: GIT_OBJECTS_V1,
    object_format: "sha1",
    base_tree: "1".repeat(40),
    candidate_tree: "2".repeat(40),
    base_commit: null,
    store_boundary_commit: null,
    digest: "",
  };
  result.digest = gitResultDigest(result);
  const record = join(runDir, "final/work_product.yaml");
  writeFileSync(
    record,
    stringify({
      id: "wp",
      kind: "patch",
      source_task_id: "task-1",
      producer_attempt_id: "a01",
      meta: {
        result_kind: "patch",
        apply_state: "not_applied",
        adopted: false,
        patch_sha256: null,
        git_result: result,
        patch_view: {
          available: false,
          reason: "exceeds_view_limit",
          limitBytes: 1,
          estimatedBytes: 2,
        },
      },
    }),
  );
  if (!readable) chmodSync(record, 0o000);
  return {
    id: "job-1",
    runId: "run-1",
    taskId: "task-1",
    runDir,
    state: "succeeded",
    params: { mode: "agent", scope: { kind: "project", root: runDir, context: "auto" } },
  };
}

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "a thread history row whose result record cannot be read",
  () => {
    it("keeps the row and marks its apply coverage unavailable", () => {
      const row = projectHistoryRun(run(false) as never, {
        waitingOnUser: false,
        operator: null,
        childRunIds: [],
      });

      expect(row.run.applyEligibilityCoverage).toBe("unavailable");
    });

    it("a readable one keeps complete coverage (control)", () => {
      const row = projectHistoryRun(run(true) as never, {
        waitingOnUser: false,
        operator: null,
        childRunIds: [],
      });

      expect(row.run.applyEligibilityCoverage).toBe("complete");
    });
  },
);
