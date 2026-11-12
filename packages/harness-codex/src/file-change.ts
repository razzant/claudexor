/**
 * Codex file edits: one normalized `file_change` per edited path, typed with
 * the native lifecycle frame (`item.started` / `item.completed`).
 * `codex exec --json` lists the paths in `item.changes[]`; the app-server
 * mapper has already split that list into one item per `item.path`, so an
 * item that names its path is never enumerated a second time. The outcome
 * comes only from the completed item's native status: completion is not
 * success, and an unknown status stays absent. Each event carries its own
 * change and the item's other facts, never the whole list again, so the
 * journal grows linearly with the paths; `payload.path` stays the complete
 * path (identity), `tool.target` its bounded display.
 */
import type { HarnessEvent, ToolRef } from "@claudexor/schema";

type Json = any;

const COMPLETED_OUTCOME: Record<string, ToolRef["status"]> = {
  completed: "ok",
  failed: "error",
  declined: "denied",
};

export function codexFileChangeEvents(
  item: Json,
  phase: "started" | "completed",
  sessionId: string,
  ts: string,
): HarnessEvent[] {
  const paths: (string | undefined)[] =
    typeof item.path === "string"
      ? [item.path]
      : Array.isArray(item.changes)
        ? item.changes
            .map((change: Json) => change?.path)
            .filter((path: unknown): path is string => typeof path === "string" && path !== "")
        : [];
  const status = phase === "completed" ? COMPLETED_OUTCOME[String(item.status)] : undefined;
  const useId = typeof item.id === "string" && item.id ? item.id : undefined;
  const changes: Json[] | null = Array.isArray(item.changes) ? item.changes : null;
  const facts = changes
    ? Object.fromEntries(Object.entries(item).filter(([key]) => key !== "changes"))
    : item;
  return (paths.length > 0 ? paths : [undefined]).map((path) => ({
    type: "file_change" as const,
    session_id: sessionId,
    ts,
    tool: {
      name: "apply_patch",
      kind: "file" as const,
      ...(useId ? { use_id: useId } : {}),
      // The changed file's own path (INV-146): bounded for display, never masked.
      ...(path?.trim() ? { target: path.slice(0, 500) } : {}),
      phase,
      ...(status ? { status } : {}),
    },
    payload:
      phase === "started"
        ? { path, status: item.status ?? "item.started", item_id: item.id }
        : changes
          ? { path, change: changes.find((change) => change?.path === path) ?? null, item: facts }
          : { path, item },
  }));
}
