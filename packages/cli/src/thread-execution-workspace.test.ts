import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, Thread as ThreadSchema, type Thread } from "@claudexor/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveThreadExecutionWorkspace,
  threadExecutionRequiresWorktree,
  threadRunStartRequiresGit,
  type ThreadWorkspaceAuthority,
} from "./thread-execution-workspace.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function thread(
  mode: "in_place" | "isolated" = "in_place",
  worktreePath: string | null = null,
): Thread {
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
      worktree_path: worktreePath,
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
      ).resolves.toEqual({ executionRoot: "/repo", inPlace: true, promoted: false });
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

  it.each(["ask", "plan"] as const)(
    "reads the stable repo for an isolated %s turn that has no materialized worktree",
    async (mode) => {
      const threads = authority(thread("isolated"));
      const ensureWorktree = vi.fn();
      await expect(
        resolveThreadExecutionWorkspace({
          threadId: "th-test",
          repoRoot: "/repo",
          mode,
          requestedInPlace: false,
          protectedPaths: [],
          threads,
          ensureWorktree,
        }),
      ).resolves.toEqual({
        executionRoot: "/repo",
        inPlace: true,
        promoted: false,
      });
      expect(ensureWorktree).not.toHaveBeenCalled();
    },
  );

  it("uses an existing isolated worktree directly for readonly without Git materialization", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-readonly-thread-"));
    roots.push(root);
    const existing = join(root, "existing-worktree");
    mkdirSync(existing);
    const threads = authority(thread("isolated", existing));
    const ensureWorktree = vi.fn();

    await expect(
      resolveThreadExecutionWorkspace({
        threadId: "th-test",
        repoRoot: "/repo",
        mode: "agent",
        access: "readonly",
        requestedInPlace: false,
        protectedPaths: ["protected/**"],
        threads,
        ensureWorktree,
      }),
    ).resolves.toEqual({ executionRoot: existing, inPlace: true, promoted: false });
    expect(ensureWorktree).not.toHaveBeenCalled();
    expect(threads.setThreadWorktree).not.toHaveBeenCalled();
  });

  it.each(["missing", "file"] as const)(
    "refuses a readonly isolated thread whose recorded worktree is %s without recreating it",
    async (kind) => {
      const root = mkdtempSync(join(tmpdir(), "claudexor-stale-thread-"));
      roots.push(root);
      const recorded = join(root, kind);
      if (kind === "file") writeFileSync(recorded, "not a directory\n", "utf8");
      const threads = authority(thread("isolated", recorded));
      const ensureWorktree = vi.fn();

      await expect(
        resolveThreadExecutionWorkspace({
          threadId: "th-test",
          repoRoot: "/repo",
          mode: "ask",
          requestedInPlace: false,
          protectedPaths: [],
          threads,
          ensureWorktree,
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: "isolated_worktree_unavailable",
        retryable: false,
      });
      expect(ensureWorktree).not.toHaveBeenCalled();
      expect(threads.setThreadWorktree).not.toHaveBeenCalled();
    },
  );
});

describe("thread workspace Git admission", () => {
  const liveConvergence = {
    prompt: "repair",
    mode: "agent" as const,
    scope: { kind: "project" as const, root: "/repo", context: "auto" as const, ephemeral: false },
    untilClean: true,
    execution: { isolation: "live" as const, delegated: false },
  };

  it("uses the same worktree predicate for isolated and protected-path turns", () => {
    const isolated = thread("isolated");
    const inPlace = thread("in_place");
    expect(
      threadExecutionRequiresWorktree({
        thread: isolated,
        mode: "agent",
        protectedPaths: [],
      }),
    ).toBe(true);
    expect(threadRunStartRequiresGit(liveConvergence, isolated, [])).toBe(true);

    expect(
      threadExecutionRequiresWorktree({
        thread: inPlace,
        mode: "agent",
        protectedPaths: ["protected/**"],
      }),
    ).toBe(true);
    expect(threadRunStartRequiresGit(liveConvergence, inPlace, ["protected/**"])).toBe(true);
  });

  it("preserves the implemented non-Git live convergence path", () => {
    const inPlace = thread("in_place");
    expect(
      threadExecutionRequiresWorktree({
        thread: inPlace,
        mode: "agent",
        protectedPaths: [],
      }),
    ).toBe(false);
    expect(threadRunStartRequiresGit(liveConvergence, inPlace, [])).toBe(false);
  });

  it("never promotes a read-only turn solely because protected paths exist", () => {
    const inPlace = thread("in_place");
    expect(
      threadExecutionRequiresWorktree({
        thread: inPlace,
        mode: "plan",
        protectedPaths: ["protected/**"],
      }),
    ).toBe(false);
  });

  it.each(["ask", "plan"] as const)("does not require Git for an isolated %s turn", (mode) => {
    const isolated = thread("isolated");
    const request = {
      prompt: "read",
      mode,
      scope: {
        kind: "project" as const,
        root: "/repo",
        context: "auto" as const,
        ephemeral: false,
      },
      execution: { isolation: "envelope" as const, delegated: false },
    };
    expect(threadExecutionRequiresWorktree({ thread: isolated, mode, protectedPaths: [] })).toBe(
      false,
    );
    expect(threadRunStartRequiresGit(request, isolated, [])).toBe(false);
  });

  it("does not promote an explicit readonly agent turn for protected paths", async () => {
    const inPlace = thread("in_place");
    const threads = authority(inPlace);
    const ensureWorktree = vi.fn();
    const request = { ...liveConvergence, untilClean: undefined, access: "readonly" as const };

    expect(threadRunStartRequiresGit(request, inPlace, ["protected/**"])).toBe(false);
    await expect(
      resolveThreadExecutionWorkspace({
        threadId: inPlace.id,
        repoRoot: "/repo",
        mode: "agent",
        access: "readonly",
        requestedInPlace: true,
        protectedPaths: ["protected/**"],
        threads,
        ensureWorktree,
      }),
    ).resolves.toEqual({ executionRoot: "/repo", inPlace: true, promoted: false });
    expect(ensureWorktree).not.toHaveBeenCalled();
  });

  it("uses the repo access default when deciding Git admission", () => {
    const isolated = thread("isolated");
    const request = {
      prompt: "read",
      mode: "agent" as const,
      scope: {
        kind: "project" as const,
        root: "/repo",
        context: "auto" as const,
        ephemeral: false,
      },
      execution: { isolation: "envelope" as const, delegated: false },
    };
    expect(threadRunStartRequiresGit(request, isolated, [], "readonly")).toBe(false);
    expect(threadRunStartRequiresGit(request, isolated, [], "workspace_write")).toBe(true);
  });
});
