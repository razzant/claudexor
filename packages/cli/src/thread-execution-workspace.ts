import { statSync } from "node:fs";
import type { ScopeReapOutcome } from "@claudexor/core";
import type { AccessProfile, ModeKind, Thread } from "@claudexor/schema";
import {
  resolveRunAccess,
  runStartRequiresGit,
  type ControlRunStartRequest,
} from "@claudexor/schema";
import {
  assertThreadTreeReady,
  ensureThreadWorktree,
  type PreparationQuietRead,
  type ThreadWorktreeResult,
} from "@claudexor/workspace";

export interface ThreadWorkspaceAuthority {
  getThread(id: string): Thread | undefined;
  setThreadWorktree(id: string, path: string, baseSha: string): void;
}

export interface ThreadExecutionWorkspace {
  executionRoot?: string;
  inPlace: boolean;
  promoted: boolean;
  projectGitInitialization?: ThreadWorktreeResult["projectGitInitialization"];
}

/**
 * Whether the durable thread/project context requires a Git worktree to be
 * materialized before this turn. Read-only may reuse an existing worktree but
 * never requires one. This is the shared decision used by both preflight and
 * the actual resolver; keeping it pure prevents admission from drifting from
 * workspace preparation after a new promotion rule is added.
 */
export function threadExecutionRequiresWorktree(input: {
  thread?: Pick<Thread, "workspace">;
  mode: ModeKind;
  access?: AccessProfile;
  accessDefault?: AccessProfile;
  protectedPaths: readonly string[];
}): boolean {
  if (!input.thread) return false;
  if (
    resolveRunAccess(
      { mode: input.mode, access: input.access },
      input.accessDefault ?? "workspace_write",
    ).effective === "readonly"
  ) {
    return false;
  }
  return (
    input.thread.workspace.mode === "isolated" ||
    (input.thread.workspace.mode === "in_place" &&
      input.mode === "agent" &&
      input.protectedPaths.length > 0)
  );
}

/** Canonical Git admission decision after thread/project context is resolved. */
export function threadRunStartRequiresGit(
  request: ControlRunStartRequest,
  thread: Pick<Thread, "workspace"> | undefined,
  protectedPaths: readonly string[],
  accessDefault: AccessProfile = "workspace_write",
): boolean {
  const mode = request.mode ?? "agent";
  const effectiveAccess = resolveRunAccess(request, accessDefault).effective;
  return runStartRequiresGit(request, {
    effectiveAccess,
    effectiveWorkspaceRequiresGit: threadExecutionRequiresWorktree({
      thread,
      mode,
      access: request.access,
      accessDefault,
      protectedPaths,
    }),
  });
}

function isolatedWorktreeUnavailable(path: string, detail: string): Error {
  return Object.assign(new Error(`isolated thread worktree is unavailable at ${path}: ${detail}`), {
    status: 409,
    code: "isolated_worktree_unavailable",
    retryable: false,
  });
}

function assertExistingIsolatedWorktree(path: string): void {
  try {
    if (!statSync(path).isDirectory()) {
      throw isolatedWorktreeUnavailable(path, "the recorded path is not a directory");
    }
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "isolated_worktree_unavailable"
    ) {
      throw error;
    }
    const code =
      error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : "unreadable";
    throw isolatedWorktreeUnavailable(path, code);
  }
}

function threadExecutionMismatch(message: string): Error {
  return Object.assign(new Error(message), {
    status: 409,
    code: "thread_execution_mismatch",
    retryable: false,
  });
}

/**
 * Fail-loud agreement between a thread-bound run and its thread, enforced at
 * the runner so the raw daemon socket cannot forge what the HTTP turn route
 * derives: the run's project is the thread's project, a delegated thread's run
 * carries exactly its immutable caller-owned root under delegated authority,
 * and an ordinary thread's run carries neither.
 */
export function assertThreadExecutionBinding(
  thread: Pick<Thread, "id" | "repo" | "workspace"> | undefined,
  request: Pick<ControlRunStartRequest, "scope" | "execution">,
): void {
  if (!thread) return;
  const scopeRoot = request.scope.kind === "project" ? request.scope.root : null;
  if (scopeRoot !== (thread.repo?.root ?? null)) {
    throw threadExecutionMismatch(
      `run project ${scopeRoot ?? "(none)"} is not thread ${thread.id}'s project ${thread.repo?.root ?? "(none)"}`,
    );
  }
  const { delegated, workspaceRoot } = request.execution;
  if (thread.workspace.mode === "delegated") {
    if (delegated !== true || workspaceRoot !== thread.workspace.workspace_root) {
      throw threadExecutionMismatch(
        `delegated thread ${thread.id} runs only in its bound workspace ${thread.workspace.workspace_root ?? "(missing)"} under delegated authority`,
      );
    }
  } else if (delegated === true || workspaceRoot !== undefined) {
    throw threadExecutionMismatch(
      `thread ${thread.id} is ${thread.workspace.mode}; its turns carry no delegated execution root`,
    );
  }
}

/** A missing caller-owned root is a durable, retryable refusal on the turn:
 * restoring the directory and retrying replays the same recorded request. */
function assertDelegatedWorkspaceAvailable(root: string): void {
  let detail = "the bound path is not a directory";
  try {
    if (statSync(root).isDirectory()) return;
  } catch (error) {
    detail =
      error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : "unreadable";
  }
  throw Object.assign(
    new Error(`delegated thread workspace is unavailable at ${root}: ${detail}`),
    {
      status: 409,
      code: "delegated_workspace_unavailable",
      retryable: true,
      requiredActions: [
        "Restore the caller-owned workspace bound to this thread, then retry the turn.",
      ],
    },
  );
}

/** Resolve the effective execution tree before any adapter can start. */
export async function resolveThreadExecutionWorkspace(input: {
  threadId?: string;
  repoRoot: string;
  mode: ModeKind;
  access?: AccessProfile;
  accessDefault?: AccessProfile;
  requestedInPlace: boolean;
  workspaceKind?: "git" | "directory";
  protectedPaths: readonly string[];
  threads: ThreadWorkspaceAuthority;
  ensureWorktree?: (
    repoRoot: string,
    threadId: string,
    options: {
      signal?: AbortSignal;
      openScope?: () => Promise<{ marker: string }>;
      settleScope?: () => Promise<ScopeReapOutcome | null>;
      quiet?: PreparationQuietRead;
    },
  ) => Promise<ThreadWorktreeResult>;
  /** The accepted job's stop: its thread worktree preparation honours it. */
  signal?: AbortSignal;
  /** The preparation's own process scope and release criterion (the runner's). */
  preparation?: {
    openScope: () => Promise<{ marker: string }>;
    settleScope: () => Promise<ScopeReapOutcome | null>;
    quiet: PreparationQuietRead;
  };
}): Promise<ThreadExecutionWorkspace> {
  const thread = input.threadId ? input.threads.getThread(input.threadId) : undefined;
  // The caller-owned binding wins before every managed-workspace rule: no
  // thread worktree, promotion, or project-root read for any mode or access.
  const delegatedRoot =
    thread?.workspace.mode === "delegated" ? thread.workspace.workspace_root : null;
  if (delegatedRoot) {
    assertDelegatedWorkspaceAvailable(delegatedRoot);
    return {
      executionRoot: delegatedRoot,
      inPlace: input.workspaceKind === "directory" ? input.requestedInPlace : true,
      promoted: false,
    };
  }
  if (input.workspaceKind === "directory")
    return { inPlace: input.requestedInPlace, promoted: false };
  if (!thread || !input.threadId) {
    return { inPlace: input.requestedInPlace, promoted: false };
  }
  const effectiveAccess = resolveRunAccess(
    { mode: input.mode, access: input.access },
    input.accessDefault ?? "workspace_write",
  ).effective;
  if (effectiveAccess === "readonly") {
    const existingPath =
      thread.workspace.mode === "isolated" ? thread.workspace.worktree_path : null;
    if (existingPath) {
      assertExistingIsolatedWorktree(existingPath);
      // Read-only work never runs in a tree whose preparation is not complete.
      assertThreadTreeReady(existingPath);
      return { executionRoot: existingPath, inPlace: true, promoted: false };
    }
    return { executionRoot: input.repoRoot, inPlace: true, promoted: false };
  }
  const needsWorktree = threadExecutionRequiresWorktree({
    thread,
    mode: input.mode,
    access: input.access,
    accessDefault: input.accessDefault,
    protectedPaths: input.protectedPaths,
  });
  const promote = thread.workspace.mode === "in_place" && needsWorktree;
  if (!needsWorktree) {
    return { inPlace: input.requestedInPlace, promoted: false };
  }

  const ensure = input.ensureWorktree ?? ensureThreadWorktree;
  const worktree = await ensure(input.repoRoot, input.threadId, {
    signal: input.signal,
    ...(input.preparation ?? {}),
  });
  // The thread records the tree it runs in: a new one, and a ready one its record
  // does not name. A stop (or a crash) between a tree's hand-over and this write
  // leaves it unrecorded, and Apply, the produced files and read-only turns go by
  // the record: the next turn that gets the tree records it.
  if (promote || worktree.created || thread.workspace.worktree_path !== worktree.path) {
    input.threads.setThreadWorktree(input.threadId, worktree.path, worktree.baseSha);
  }
  return {
    executionRoot: worktree.path,
    inPlace: true,
    promoted: promote,
    projectGitInitialization: worktree.projectGitInitialization,
  };
}
