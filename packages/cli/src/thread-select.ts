import type { ControlThread } from "@claudexor/schema";

/**
 * The thread `--resume` continues: the most recently UPDATED ACTIVE thread.
 * Trashed/archived threads are never resumed; `updatedAt` is the DTO's camelCase
 * field (a `updated_at` typo silently sorts undefined and throws). Pure so the
 * selection is unit-testable without a live daemon.
 */
export function pickResumableThread(threads: ControlThread[]): ControlThread | undefined {
  return [...threads]
    .filter((t) => t.state === "active")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}
