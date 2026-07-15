import type { Thread } from "@claudexor/schema";
import { Thread as ThreadSchema } from "@claudexor/schema";
import { nowIso } from "@claudexor/util";

export type ThreadLifecycleAction = "trash" | "restore" | "purge";

/** Pure lifecycle reducer; ThreadStore remains the sole journal writer. */
export function reduceThreadLifecycle(thread: Thread, action: ThreadLifecycleAction): Thread {
  if (thread.state === "purged") {
    if (action === "purge") return thread;
    throw Object.assign(new Error(`thread ${thread.id} was purged`), {
      status: 410,
      code: "thread_purged",
    });
  }
  if (action === "trash") {
    if (thread.state === "trashed") return thread;
    const at = nowIso();
    return ThreadSchema.parse({
      ...thread,
      state: "trashed",
      trashed_at: at,
      purge_after: new Date(Date.parse(at) + 30 * 24 * 60 * 60 * 1_000).toISOString(),
      pre_trash_state: thread.state,
      updated_at: at,
    });
  }
  if (action === "restore") {
    if (thread.state !== "trashed") return thread;
    if (!thread.purge_after || Date.parse(thread.purge_after) <= Date.now()) {
      throw Object.assign(new Error(`thread ${thread.id} trash retention expired`), {
        status: 410,
        code: "thread_trash_expired",
      });
    }
    return ThreadSchema.parse({
      ...thread,
      state: thread.pre_trash_state ?? "active",
      trashed_at: null,
      purge_after: null,
      pre_trash_state: null,
      updated_at: nowIso(),
    });
  }
  if (thread.state !== "trashed") {
    throw Object.assign(new Error(`thread ${thread.id} must be trashed before purge`), {
      status: 409,
      code: "thread_not_trashed",
    });
  }
  return ThreadSchema.parse({
    ...thread,
    state: "purged",
    workspace: { ...thread.workspace, worktree_path: null },
    updated_at: nowIso(),
  });
}
