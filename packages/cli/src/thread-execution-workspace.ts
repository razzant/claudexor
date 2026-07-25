import type { ModeKind, Thread } from "@claudexor/schema";
import { ensureThreadWorktree, type ThreadWorktreeResult } from "@claudexor/workspace";

export interface ThreadWorkspaceAuthority {
  getThread(id: string): Thread | undefined;
  setThreadWorktree(id: string, path: string, baseSha: string): void;
}

export interface ThreadExecutionWorkspace {
  executionRoot?: string;
  inPlace: boolean;
  promoted: boolean;
}

/** Resolve the effective execution tree before any adapter can start. */
export async function resolveThreadExecutionWorkspace(input: {
  threadId?: string;
  repoRoot: string;
  mode: ModeKind;
  requestedInPlace: boolean;
  protectedPaths: readonly string[];
  threads: ThreadWorkspaceAuthority;
  ensureWorktree?: (repoRoot: string, threadId: string) => Promise<ThreadWorktreeResult>;
}): Promise<ThreadExecutionWorkspace> {
  const thread = input.threadId ? input.threads.getThread(input.threadId) : undefined;
  if (!thread || !input.threadId) {
    return { inPlace: input.requestedInPlace, promoted: false };
  }
  const promote =
    thread.workspace.mode === "in_place" &&
    input.mode === "agent" &&
    input.protectedPaths.length > 0;
  if (thread.workspace.mode !== "isolated" && !promote) {
    return { inPlace: input.requestedInPlace, promoted: false };
  }

  const ensure = input.ensureWorktree ?? ensureThreadWorktree;
  const worktree = await ensure(input.repoRoot, input.threadId);
  if (promote || worktree.created) {
    input.threads.setThreadWorktree(input.threadId, worktree.path, worktree.baseSha);
  }
  return { executionRoot: worktree.path, inPlace: true, promoted: promote };
}
