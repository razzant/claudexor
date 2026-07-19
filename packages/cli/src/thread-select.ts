import type { ControlThread } from "@claudexor/schema";

/**
 * The thread `--resume` continues: the most recently UPDATED ACTIVE thread
 * ANCHORED TO THE CURRENT PROJECT (D28). `GET /threads` lists every project's
 * threads globally, so `--resume` MUST scope to `projectRoot` (the cwd's
 * project) — otherwise it silently resumes a thread from an unrelated project.
 * A thread with no repoRoot (project-less) is never a project resume target.
 * Trashed/archived threads are never resumed; `updatedAt` is the DTO's camelCase
 * field (a `updated_at` typo silently sorts undefined and throws). Pure so the
 * selection is unit-testable without a live daemon.
 */
export function pickResumableThread(
  threads: ControlThread[],
  projectRoot: string,
): ControlThread | undefined {
  return [...threads]
    .filter((t) => t.state === "active" && t.repoRoot === projectRoot)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}
