import { z } from "zod/v3";
import { WorkspaceScopePath } from "./files-manifest.js";

const Count = z.number().int().nonnegative();

/**
 * Typed payload of `workspace.prepared`: what an isolated directory copy held
 * when it was created, read from its own selected-input baseline. A selected
 * path that was not found may be a future output; it is reported, not refused.
 */
export const WorkspacePreparedPayload = z
  .object({
    attempt_id: z.string().min(1).describe("Attempt that first runs in the prepared copy."),
    source_root: z.string().min(1).describe("Folder the selected paths were resolved against."),
    scope_paths: z
      .array(WorkspaceScopePath)
      .describe("Selected input paths exactly as requested; empty when none were selected."),
    copied: z
      .object({ files: Count, directories: Count, symlinks: Count })
      .strict()
      .describe(
        "Entries copied into the isolated copy; symbolic links are copied as links, not followed.",
      ),
    missing_paths: z
      .array(WorkspaceScopePath)
      .describe("Selected paths that did not exist under source_root when the copy was prepared."),
  })
  .strict()
  .describe("Validated payload of a workspace.prepared run event (isolated directory copy).");
export type WorkspacePreparedPayload = z.infer<typeof WorkspacePreparedPayload>;

/** Every path, JSON-quoted: the selection is the caller's own and no other
 * record names absent ones, so nothing is clipped; quoting keeps a newline,
 * quote or control character inside one path from breaking the line. */
function pathList(paths: readonly string[]): string {
  return paths.map((path) => JSON.stringify(path)).join(", ");
}

function plural(count: number, noun: string): string | null {
  return count === 0 ? null : `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** THE text of a prepared copy (timeline, CLI, the executor's prompt) and
 * whether it warrants attention: nothing was copied or a selected path was
 * not found. A copied empty directory or symbolic link is present, not missing. */
export function workspacePreparationSummary(payload: WorkspacePreparedPayload): {
  warning: boolean;
  text: string;
} {
  const { copied, missing_paths: missing, scope_paths: scope } = payload;
  const counts = [
    plural(copied.files, "file"),
    copied.directories === 0
      ? null
      : `${copied.directories} ${copied.directories === 1 ? "directory" : "directories"}`,
    plural(copied.symlinks, "symbolic link"),
  ].filter((part): part is string => part !== null);
  const from = scope.length === 0 ? "(no input paths were selected)" : `from ${pathList(scope)}`;
  return {
    warning: counts.length === 0 || missing.length > 0,
    text:
      `Isolated copy prepared from ${payload.source_root}: ` +
      `${counts.length === 0 ? "nothing" : counts.join(", ")} copied ${from}.` +
      (missing.length > 0
        ? ` Not found there when the copy was prepared: ${pathList(missing)}` +
          " (absent in the copy; may be created as new output)."
        : "") +
      (copied.symlinks > 0 ? " Symbolic links were copied as links, not followed." : ""),
  };
}
