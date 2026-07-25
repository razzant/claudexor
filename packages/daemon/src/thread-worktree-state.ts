import type { Session, Thread } from "@claudexor/schema";
import { Thread as ThreadSchema } from "@claudexor/schema";
import { nowIso } from "@claudexor/util";
import { staleSession } from "./thread-lane-checkpoints.js";
import type { ThreadMutation } from "./thread-store-support.js";

/** Build the single journal mutation that owns thread-worktree state. */
export function threadWorktreeMutation(
  thread: Thread,
  sessions: readonly Session[],
  worktreePath: string,
  baseSha: string,
  deliveredThroughRunId?: string,
): ThreadMutation {
  const promoting = thread.workspace.mode === "in_place";
  const next = ThreadSchema.parse({
    ...thread,
    workspace: {
      ...thread.workspace,
      ...(promoting ? { mode: "isolated" as const } : {}),
      worktree_path: worktreePath,
      base_sha: baseSha,
      ...(deliveredThroughRunId !== undefined
        ? { delivered_through_run_id: deliveredThroughRunId }
        : {}),
    },
    updated_at: nowIso(),
  });
  const staleSessions = promoting
    ? sessions
        .filter((session) => session.thread_id === thread.id && session.state === "live")
        .map(staleSession)
    : [];
  return {
    threads: [next],
    ...(staleSessions.length > 0 ? { sessions: staleSessions } : {}),
  };
}
