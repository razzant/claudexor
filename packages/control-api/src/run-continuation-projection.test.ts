import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlRunSummary } from "@claudexor/schema";
import {
  WorkspaceManager,
  adoptRetainedEnvelope,
  readContinuationEvidence,
  retainForContinuation,
  writeContinuationSources,
} from "@claudexor/workspace";
import { stringify as stringifyYaml } from "yaml";
import { afterAll, describe, expect, it } from "vitest";
import { continuationSummary } from "./run-continuation-projection.js";
import type { DaemonRunRecord } from "./run-record.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function temp(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `claudexor-chain-proj-${name}-`)));
  dirs.push(dir);
  return dir;
}

function runDir(): string {
  const dir = temp("run");
  mkdirSync(join(dir, "final"), { recursive: true });
  return dir;
}

function capsule(dir: string, attempt: string, sid: string, mtimeMs: number): void {
  mkdirSync(join(dir, "attempts", attempt), { recursive: true });
  writeFileSync(
    join(dir, "attempts", attempt, "session-capsule.json"),
    JSON.stringify({
      harness: "claude",
      nativeSessionId: sid,
      holderProfileId: "claude-a",
      file: `/store/${sid}.jsonl`,
      mtimeMs,
      sidecars: [],
      cwd: "/work",
      requestedModel: null,
    }),
  );
}

function harness(
  seq: number,
  attempt: string,
  session: string,
  type: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    seq,
    id: `ev-${seq}`,
    ts: "2026-10-29T02:00:00.000Z",
    run_id: "run-r",
    task_id: "task-r",
    type: "harness.event",
    payload: { attempt_id: attempt, session_id: session, type, ...extra },
  };
}

function events(dir: string, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  writeFileSync(
    join(dir, "events.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  return rows;
}

const written = {
  cause: "pool_exhausted",
  resetsAt: "2026-10-06T21:00:00.000Z",
  limitWindow: "five_hour",
  limitEvidence: "window",
  carriers: ["native", "native_moved", "packet"],
  limitCode: "credential_pool_exhausted",
  session: { harness: "claude", nativeSessionId: "sid-A", holderProfileId: "claude-a" },
  workspace: { kind: "none", root: null },
};

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

describe("continuationSummary (run-status projection of the continueFrom chain)", () => {
  it.each(["custody", "capsule", "evidence"] as const)(
    "derives a failed head's restart cause from ancestor %s without resumable.yaml",
    async (source) => {
      const ancestor = runDir();
      const head = runDir();
      writeContinuationSources(head, [{ runId: "run-a", runDir: ancestor, state: "interrupted" }]);
      if (source === "evidence") {
        writeFileSync(join(ancestor, "final", "retained-output.md"), "Keep the existing work.");
      } else {
        capsule(ancestor, "a01", "sid-A", 1);
      }
      if (source === "custody") {
        const env = await new WorkspaceManager(initRepo()).create({
          taskId: "task-a",
          attemptId: "a01",
          baseRef: "HEAD",
          custody: { runId: "run-a", runDir: ancestor },
        });
        retainForContinuation(env, { runId: "run-a", runDir: ancestor }, "host_restart");
      }
      const projected = continuationSummary({
        id: "run-b",
        runId: "run-b",
        runDir: head,
        state: "failed",
        params: { continueFrom: "run-a" },
      });
      expect(projected.resumable).toMatchObject({
        cause: "host_restart",
        carriers: source === "evidence" ? ["packet"] : ["native", "packet"],
        workspace: { kind: source === "custody" ? "retained_envelope" : "none" },
      });
    },
  );

  it("projects the engine's terminal block, the predecessor link and the receipts (detail only)", () => {
    const dir = runDir();
    writeFileSync(join(dir, "final", "resumable.yaml"), stringifyYaml(written));
    const rec: DaemonRunRecord = {
      id: "job-s",
      runId: "run-s",
      state: "failed",
      runDir: dir,
      params: { continueFrom: "run-p" },
    };
    const receipt = {
      tryIndex: 0,
      attemptId: "a01",
      carrier: "native",
      cause: "pool_exhausted",
      from: { runId: "run-p", attemptId: "a01", profileId: "claude-a" },
      to: { profileId: "claude-a" },
      workspace: "same_root",
      memory: "full",
      instructions: "as_sent",
      reingestedTokens: 1200,
      observedModel: "claude-opus-5-5",
      modelMismatch: false,
      identityCheck: "matched_before_effects",
      inputDelivery: "confirmed",
    };
    // #411(c): a moved session's retirement fact rides the same receipt verbatim.
    const moved = {
      ...receipt,
      tryIndex: 1,
      carrier: "native_moved",
      sourceRetirement: "not_confirmed",
    };
    const events = [
      { type: "harness.event", payload: {} },
      { type: "run.continuity", payload: { harness_id: "claude", receipt } },
      { type: "run.continuity", payload: { harness_id: "claude", receipt: moved } },
    ];
    const detail = continuationSummary(rec, events);
    expect(detail).toMatchObject({
      continueFrom: "run-p",
      resumable: written,
      continuity: [receipt, moved],
    });
    expect(detail.continuity?.[0]).not.toHaveProperty("sourceRetirement");
    // List rows never read the event log: absent is not "no receipts".
    expect(continuationSummary(rec)).not.toHaveProperty("continuity");
    // The fields fit the published summary shape.
    expect(() =>
      ControlRunSummary.parse({ jobId: "job-s", runId: "run-s", state: "failed", ...detail }),
    ).not.toThrow();
    // Non-terminal runs carry no terminal facts.
    expect(continuationSummary({ ...rec, state: "running" })).toMatchObject({
      resumable: null,
      retainedEnvelope: null,
    });
  });

  it("overlays the CURRENT workspace: a kept envelope, then none once a successor adopted it", async () => {
    const repo = initRepo();
    const dir = runDir();
    writeFileSync(join(dir, "final", "resumable.yaml"), stringifyYaml(written));
    const env = await new WorkspaceManager(repo).create({
      taskId: "task-k",
      attemptId: "a01",
      baseRef: "HEAD",
      custody: { runId: "run-k", runDir: dir },
    });
    writeFileSync(join(env.worktree_path, "a.txt"), "edited\n");
    const custody = retainForContinuation(env, { runId: "run-k", runDir: dir }, "pool_exhausted");
    const rec: DaemonRunRecord = { id: "job-k", runId: "run-k", state: "failed", runDir: dir };
    expect(continuationSummary(rec)).toMatchObject({
      resumable: { workspace: { kind: "retained_envelope", root: env.worktree_path } },
      retainedEnvelope: { root: env.worktree_path, cause: "pool_exhausted" },
    });
    expect(continuationSummary(rec).retainedEnvelope?.bytes).toBeGreaterThan(0);
    adoptRetainedEnvelope(custody, { runId: "run-next", runDir: runDir() });
    expect(continuationSummary(rec)).toMatchObject({
      resumable: { workspace: { kind: "none", root: null } },
      retainedEnvelope: null,
    });
  });

  it("derives the block of a run the daemon found running at its restart (host_restart)", () => {
    const dir = runDir();
    capsule(dir, "a01", "sid-old", 1);
    capsule(dir, "a01c", "sid-new", 2);
    events(dir, [
      harness(1, "a01", "process-1", "started", { payload: { native_session_id: "sid-old" } }),
      harness(2, "a01c", "process-2", "started", { payload: { native_session_id: "sid-new" } }),
    ]);
    const rec: DaemonRunRecord = {
      id: "job-r",
      runId: "run-r",
      state: "interrupted",
      runDir: dir,
      params: {
        scope: { kind: "project", root: "/project" },
        execution: { isolation: "live", workspaceRoot: "/snapshot" },
      },
    };
    expect(continuationSummary(rec).resumable).toEqual({
      cause: "host_restart",
      resetsAt: null,
      limitWindow: null,
      limitEvidence: null,
      carriers: ["native", "packet"],
      limitCode: null,
      session: { harness: "claude", nativeSessionId: "sid-new", holderProfileId: "claude-a" },
      workspace: { kind: "in_place", root: "/snapshot" },
    });
    // An engine-terminal interrupted run (it committed RunFacts) is not a restart.
    writeFileSync(join(dir, "final", "run_facts.yaml"), "schema_version: 1\n");
    expect(continuationSummary(rec).resumable).toBeNull();
    // Finished work has no block at all.
    expect(continuationSummary({ ...rec, state: "succeeded" }).resumable).toBeNull();
  });

  /* Astra r1 `source-consumers-review.mjs` scenario: worked a01, a later idle
   * fallback, then a host crash. The status block names the session the
   * successor planner resumes, from the detail's event snapshot or (a list
   * row) from the run's own record, never the newest capsule by mtime. */
  it("a host-restart block names the planner's carrier, not the newest capsule", () => {
    const dir = runDir();
    capsule(dir, "a01", "sid-work", 1);
    capsule(dir, "a01-fallback", "sid-idle", 2);
    const rows = events(dir, [
      harness(1, "a01", "process-1", "started", { payload: { native_session_id: "sid-work" } }),
      harness(2, "a01", "process-1", "tool_call", {
        tool: { name: "read", kind: "file", target: "a.ts" },
      }),
      harness(3, "a01-fallback", "process-2", "started", {
        payload: { native_session_id: "sid-idle" },
      }),
    ]);
    const rec: DaemonRunRecord = {
      id: "job-b",
      runId: "run-b",
      runDir: dir,
      state: "interrupted",
      params: { mode: "ask" },
    };
    const planned = readContinuationEvidence(dir);
    expect(planned.held?.capsule.nativeSessionId).toBe("sid-work");
    expect(continuationSummary(rec, rows).resumable?.session?.nativeSessionId).toBe("sid-work");
    expect(continuationSummary(rec).resumable?.session?.nativeSessionId).toBe("sid-work");
  });
});
