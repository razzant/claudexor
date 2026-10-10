import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { continuationRefusal } from "@claudexor/schema";
import {
  WorkspaceManager,
  retainForContinuation,
  retainedEnvelopeOfRun,
} from "@claudexor/workspace";
import { discardRunResult } from "../../control-api/src/run-discard.js";
import { prunableCommandIds } from "./store/test-support/fixtures/legacy/daemon/command-retention.js";
import type { JobRecord } from "./server.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const now = Date.parse("2026-10-06T00:00:00.000Z");
const record = (id: string, over: Partial<JobRecord> = {}): JobRecord => ({
  id,
  runId: id,
  state: "failed",
  params: { prompt: "carry this work" },
  createdAt: "2026-07-01T00:00:00.000Z",
  finishedAt: "2026-07-01T01:00:00.000Z",
  ...over,
});
function prune(records: JobRecord[]) {
  const removed = prunableCommandIds(records, 0, 0, now, 0);
  return records.filter((entry) => !removed.includes(entry.id));
}

describe("command retention of continuation identities", () => {
  it("keeps a retained holder admissible and discardable under age and byte pressure", async () => {
    const repo = mkdtempSync(join(tmpdir(), "cx-command-custody-"));
    const runDir = mkdtempSync(join(tmpdir(), "cx-command-run-"));
    dirs.push(repo, runDir);
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "file.txt"), "base\n");
    execFileSync("git", ["-C", repo, "add", "file.txt"]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "base",
    ]);
    const env = await new WorkspaceManager(repo).create({
      taskId: "task-a",
      attemptId: "a01",
      baseRef: "HEAD",
      custody: { runId: "run-a", runDir },
    });
    writeFileSync(join(env.worktree_path, "file.txt"), "retained\n");
    retainForContinuation(env, { runId: "run-a", runDir }, "cancelled");
    const kept = prune([record("run-a", { runDir })]);
    expect(continuationRefusal({ continueFrom: "run-a" }, kept)).toBeNull();
    expect(retainedEnvelopeOfRun(runDir, "run-a")).not.toBeNull();
    expect(await discardRunResult(kept[0]!)).toMatchObject({ accepted: true, status: "discarded" });
    expect(existsSync(env.worktree_path)).toBe(false);
    expect(prune(kept)).toEqual([]);
  });

  it.each(["age", "bytes"] as const)(
    "preserves the successor claim of a kept needs-decision parent under %s pruning",
    (pressure) => {
      const parent = record("run-parent", {
        state: "succeeded",
        result: { facts: { review: "blocked" } },
      });
      const successor = record("run-successor", {
        params: { continueFrom: parent.runId, prompt: "continue" },
      });
      const records = [parent, successor];
      const removed = prunableCommandIds(
        records,
        pressure === "age" ? 0 : 500,
        0,
        now,
        pressure === "bytes" ? 0 : 1024,
      );
      const kept = records.filter((entry) => !removed.includes(entry.id));
      expect(continuationRefusal({ continueFrom: parent.runId }, kept)).toMatchObject({
        code: "continuation_superseded",
        context: { head: successor.runId },
      });
    },
  );
});
