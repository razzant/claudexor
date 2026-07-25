import { SCHEMA_VERSION, Thread as ThreadSchema, type Thread } from "@claudexor/schema";
import { describe, expect, it, vi } from "vitest";
import {
  resolveThreadExecutionWorkspace,
  type ThreadWorkspaceAuthority,
} from "./thread-execution-workspace.js";

function thread(mode: "in_place" | "isolated" = "in_place"): Thread {
  return ThreadSchema.parse({
    schema_version: SCHEMA_VERSION,
    id: "th-test",
    created_at: "2026-07-25T00:00:00.000Z",
    updated_at: "2026-07-25T00:00:00.000Z",
    repo: { root: "/repo", base_ref: "HEAD" },
    title: null,
    mode: "agent",
    workspace: {
      mode,
      worktree_path: null,
      base_sha: null,
      delivered_through_run_id: null,
    },
    auth_preference: "auto",
    credential_profile_id: null,
    access: null,
    primary_harness: null,
    eligible_harnesses: [],
    state: "active",
    head_run_id: null,
    run_ids: [],
  });
}

function authority(value: Thread): ThreadWorkspaceAuthority & {
  setThreadWorktree: ReturnType<typeof vi.fn<(id: string, path: string, baseSha: string) => void>>;
} {
  return {
    getThread: () => value,
    setThreadWorktree: vi.fn<(id: string, path: string, baseSha: string) => void>(),
  };
}

describe("resolveThreadExecutionWorkspace", () => {
  it("promotes a mutating live thread before execution when protected paths exist", async () => {
    const threads = authority(thread());
    const ensureWorktree = vi.fn(async () => ({
      path: "/runtime/thread/tree",
      baseSha: "base-1",
      created: true,
    }));
    await expect(
      resolveThreadExecutionWorkspace({
        threadId: "th-test",
        repoRoot: "/repo",
        mode: "agent",
        requestedInPlace: true,
        protectedPaths: ["protected/**"],
        threads,
        ensureWorktree,
      }),
    ).resolves.toEqual({
      executionRoot: "/runtime/thread/tree",
      inPlace: true,
      promoted: true,
    });
    expect(threads.setThreadWorktree).toHaveBeenCalledWith(
      "th-test",
      "/runtime/thread/tree",
      "base-1",
    );
  });

  it.each(["ask", "plan"] as const)(
    "keeps a %s turn in the declared live workspace",
    async (mode) => {
      const threads = authority(thread());
      const ensureWorktree = vi.fn();
      await expect(
        resolveThreadExecutionWorkspace({
          threadId: "th-test",
          repoRoot: "/repo",
          mode,
          requestedInPlace: true,
          protectedPaths: ["protected/**"],
          threads,
          ensureWorktree,
        }),
      ).resolves.toEqual({ inPlace: true, promoted: false });
      expect(ensureWorktree).not.toHaveBeenCalled();
    },
  );

  it("keeps an ordinary live agent turn when the project has no protected paths", async () => {
    const threads = authority(thread());
    const ensureWorktree = vi.fn();
    await expect(
      resolveThreadExecutionWorkspace({
        threadId: "th-test",
        repoRoot: "/repo",
        mode: "agent",
        requestedInPlace: true,
        protectedPaths: [],
        threads,
        ensureWorktree,
      }),
    ).resolves.toEqual({ inPlace: true, promoted: false });
    expect(ensureWorktree).not.toHaveBeenCalled();
  });

  it("does not promote or spawn when isolated-worktree creation fails", async () => {
    const threads = authority(thread());
    const ensureWorktree = vi.fn(async () => {
      throw new Error("worktree creation failed");
    });
    await expect(
      resolveThreadExecutionWorkspace({
        threadId: "th-test",
        repoRoot: "/repo",
        mode: "agent",
        requestedInPlace: true,
        protectedPaths: ["protected/**"],
        threads,
        ensureWorktree,
      }),
    ).rejects.toThrow("worktree creation failed");
    expect(threads.setThreadWorktree).not.toHaveBeenCalled();
  });

  it("reuses the existing isolated-thread path without re-promoting", async () => {
    const threads = authority(thread("isolated"));
    const ensureWorktree = vi.fn(async () => ({
      path: "/runtime/thread/tree",
      baseSha: "base-1",
      created: false,
    }));
    await expect(
      resolveThreadExecutionWorkspace({
        threadId: "th-test",
        repoRoot: "/repo",
        mode: "agent",
        requestedInPlace: false,
        protectedPaths: ["protected/**"],
        threads,
        ensureWorktree,
      }),
    ).resolves.toEqual({
      executionRoot: "/runtime/thread/tree",
      inPlace: true,
      promoted: false,
    });
    expect(threads.setThreadWorktree).not.toHaveBeenCalled();
  });
});
