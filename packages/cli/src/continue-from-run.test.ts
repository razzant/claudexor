import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlRunStartRequest } from "@claudexor/schema";
import { WorkspaceManager, retainForContinuation } from "@claudexor/workspace";
import { afterAll, describe, expect, it } from "vitest";
import { continuationForRun } from "./continue-from-run.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `claudexor-continue-run-${name}-`)));
  dirs.push(dir);
  return dir;
}

function initRepo(): string {
  const dir = temp("repo");
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "a\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);
  return dir;
}

const commandsWith = (
  records: Array<{ runId?: string; runDir?: string; state: string; params: unknown }>,
) => ({
  getByRunId: (id: string) => records.find((record) => record.runId === id),
});

describe("continuationForRun (daemon runner)", () => {
  it("keeps stopped work for daemon runs, never for Delegate belt children", () => {
    const base = { prompt: "x", scope: { kind: "project", root: "/p" } };
    expect(continuationForRun(ControlRunStartRequest.parse(base), commandsWith([]))).toEqual({
      retain: true,
    });
    const child = ControlRunStartRequest.parse({
      ...base,
      parentRunId: "run-parent",
      delegatedFromRunId: "run-parent",
    });
    expect(continuationForRun(child, commandsWith([]))).toEqual({ retain: false });
  });

  it("hands the successor the chain's work order, root first", () => {
    const commands = commandsWith([
      { runId: "run-a", runDir: "/r/a", state: "failed", params: { prompt: "build it" } },
      {
        runId: "run-b",
        runDir: "/r/b",
        state: "failed",
        params: { prompt: "", continueFrom: "run-a" },
      },
      {
        runId: "run-c",
        runDir: temp("source-c"),
        state: "cancelled",
        params: { prompt: "now the tests", continueFrom: "run-b" },
      },
    ]);
    const next = continuationForRun(
      ControlRunStartRequest.parse({ prompt: "", continueFrom: "run-c" }),
      commands,
    );
    expect(next.from?.workOrder).toBe("build it\n\nnow the tests");
  });

  it("names the predecessor and adopts its kept envelope only in the same project and isolation", async () => {
    const repo = initRepo();
    const runDir = temp("run");
    const env = await new WorkspaceManager(repo).create({
      taskId: "task-p",
      attemptId: "a01",
      baseRef: "HEAD",
      custody: { runId: "run-p", runDir },
    });
    writeFileSync(join(env.worktree_path, "a.txt"), "edited\n");
    retainForContinuation(env, { runId: "run-p", runDir }, "cancelled");
    const commands = commandsWith([
      { runId: "run-p", runDir, state: "cancelled", params: { prompt: "build it" } },
    ]);
    const request = (extra: Record<string, unknown>) =>
      ControlRunStartRequest.parse({
        prompt: "",
        continueFrom: "run-p",
        scope: { kind: "project", root: repo },
        ...extra,
      });
    const same = continuationForRun(request({ continueCarrier: "packet" }), commands);
    expect(same.adopt?.envelope.id).toBe(env.id);
    expect(same.from).toEqual({
      runId: "run-p",
      runDir,
      state: "cancelled",
      workOrder: "build it",
      preference: "packet",
      ancestors: [],
      inheritModel: true,
    });
    // A live successor and another project run elsewhere: the tree stays kept.
    expect(continuationForRun(request({ execution: { isolation: "live" } }), commands).adopt).toBe(
      null,
    );
    const other = continuationForRun(
      request({ scope: { kind: "project", root: temp("other") } }),
      commands,
    );
    expect(other.adopt).toBeNull();
    expect(other.from?.preference).toBe("auto");
  });
});
