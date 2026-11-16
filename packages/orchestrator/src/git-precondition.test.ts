import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "@claudexor/artifact-store";
import type { CaptureResult } from "@claudexor/core";
import { EventLog } from "@claudexor/event-log";
import { GitBoundaryRootRefusedError, GitInitializationError } from "@claudexor/workspace";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureWriteModeGitBoundary } from "./git-precondition.js";

/** One intercepted Git capture (#694 V16); every other call is the real one. */
let intercept: ((args: string[]) => Promise<CaptureResult> | undefined) | null = null;
vi.mock("@claudexor/core", async (original) => {
  const core = await original<typeof import("@claudexor/core")>();
  return {
    ...core,
    runCaptureRaw: (cmd: string, args: string[], opts: Parameters<typeof core.runCaptureRaw>[2]) =>
      intercept?.(args) ?? core.runCaptureRaw(cmd, args, opts),
  };
});

describe("write-mode Git precondition", () => {
  const roots: string[] = [];

  afterEach(async () => {
    intercept = null;
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("classifies a repository initialization failure as workspace unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "claudexor-git-precondition-"));
    roots.push(root);
    const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") });
    const paths = store.createRun("run-git-precondition");
    const log = new EventLog(paths.eventsPath, "run-git-precondition", "task-git-precondition");

    try {
      const failure = await ensureWriteModeGitBoundary(
        root,
        log,
        store,
        paths,
        "run-git-precondition",
        "agent",
        undefined,
        async () => {
          throw new Error("git init failed: permission denied");
        },
      );

      expect(failure).toEqual({
        message: "git init failed: permission denied",
        reason: "workspace_unavailable",
      });
      expect(readFileSync(join(paths.finalDir, "failure.yaml"), "utf8")).toContain(
        "phase: workspace",
      );
      const terminal = JSON.parse(
        readFileSync(paths.eventsPath, "utf8").trim().split("\n").at(-1)!,
      ) as {
        type: string;
        payload: { reason?: string };
      };
      expect(terminal.type).toBe("run.failed");
      expect(terminal.payload.reason).toBe("workspace_unavailable");
    } finally {
      log.dispose();
    }
  });

  it("forwards a typed boundary-root refusal's own remediations as next actions", async () => {
    const root = await mkdtemp(join(tmpdir(), "claudexor-git-precondition-"));
    roots.push(root);
    const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") });
    const paths = store.createRun("run-root-refusal");
    const log = new EventLog(paths.eventsPath, "run-root-refusal", "task-root-refusal");

    try {
      const refusal = new GitBoundaryRootRefusedError(
        "refusing to initialize a git repository over the user home directory /home/tester",
        "/home/tester",
        "user_home",
        ["Choose a project subfolder as the project root instead.", "Self-init with a commit."],
      );
      const failure = await ensureWriteModeGitBoundary(
        root,
        log,
        store,
        paths,
        "run-root-refusal",
        "agent",
        undefined,
        async () => {
          throw refusal;
        },
      );

      // The reason is UNCHANGED (workspace_unavailable, no RunReason schema
      // change); the refusal's message and its own requiredActions surface.
      expect(failure).toEqual({ message: refusal.message, reason: "workspace_unavailable" });
      const failureYaml = readFileSync(join(paths.finalDir, "failure.yaml"), "utf8");
      expect(failureYaml).toContain("Choose a project subfolder as the project root instead.");
      expect(failureYaml).toContain("Self-init with a commit.");
      expect(failureYaml).not.toContain("Check the project folder permissions");
      // No partial-mutation event: the refusal happened before any mutation.
      const events = readFileSync(paths.eventsPath, "utf8").trim().split("\n");
      expect(events.some((line) => line.includes("project.git.initialized"))).toBe(false);
    } finally {
      log.dispose();
    }
  });

  it("emits partial Git initialization evidence before the workspace failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "claudexor-git-precondition-"));
    roots.push(root);
    const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") });
    const paths = store.createRun("run-partial-init");
    const log = new EventLog(paths.eventsPath, "run-partial-init", "task-partial-init");

    try {
      await ensureWriteModeGitBoundary(
        root,
        log,
        store,
        paths,
        "run-partial-init",
        "agent",
        undefined,
        async () => {
          throw new GitInitializationError("git add failed", {
            initialized: true,
            baselineCommitted: false,
            gitignoreSeeded: false,
            headSha: null,
            failedStage: "add",
          });
        },
      );
      const events = readFileSync(paths.eventsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
      expect(events[0]).toMatchObject({
        type: "project.git.initialized",
        payload: { initialized: true, partial: true, failed_stage: "add" },
      });
      expect(events.at(-1)?.type).toBe("run.failed");
    } finally {
      log.dispose();
    }
  });

  // #694 V16: the real initialization, its `add` cut by the 60 s bound with its end
  // unproven and no stop taken. The run's boundary reports the partial progress
  // before its failure, and the failure says the end is unconfirmed.
  it("reports a first initialization cut at its time bound with an unproven end as partial", async () => {
    const root = await mkdtemp(join(tmpdir(), "claudexor-git-precondition-"));
    roots.push(root);
    const project = join(root, "project");
    mkdirSync(project);
    writeFileSync(join(project, "a.txt"), "a\n");
    const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") });
    const paths = store.createRun("run-bound-init");
    const log = new EventLog(paths.eventsPath, "run-bound-init", "task-bound-init");
    intercept = (args) =>
      args.includes("add")
        ? Promise.resolve({
            code: null,
            signal: "SIGKILL",
            stdout: "",
            stderr: "",
            drain: "truncated",
            termination: {
              status: "unconfirmed",
              reason: "output_held",
              rootPid: 4242,
              groups: [4242],
              directExited: true,
              directExitObservedAt: Date.now(),
              directExit: Promise.resolve(),
            },
          })
        : undefined;
    try {
      const failure = await ensureWriteModeGitBoundary(
        project,
        log,
        store,
        paths,
        "run-bound-init",
        "agent",
      );
      expect(existsSync(join(project, ".git"))).toBe(true);
      const events = readFileSync(paths.eventsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
      expect(events[0]).toMatchObject({
        type: "project.git.initialized",
        payload: {
          repo_root: project,
          initialized: true,
          baseline_committed: false,
          head_sha: null,
          partial: true,
          failed_stage: "add",
        },
      });
      expect(events.at(-1)).toMatchObject({
        type: "run.failed",
        payload: { reason: "workspace_unavailable", phase: "workspace" },
      });
      expect(failure).toMatchObject({ reason: "workspace_unavailable" });
      expect(failure?.message).toMatch(
        /^Git repository initialization was cut at its time bound during add;.*its end is unconfirmed/,
      );
    } finally {
      log.dispose();
    }
  });
});
