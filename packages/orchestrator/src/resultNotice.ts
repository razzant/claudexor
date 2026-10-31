import { captureInventoryLines } from "@claudexor/schema";
import type {
  CaptureChangeInventory,
  GitObjectResult,
  PatchViewUnavailable,
} from "@claudexor/schema";

/**
 * What review and synthesis read for an object result WITHOUT a patch view
 * (#535): an explicit, bounded notice — never "(empty diff)" — naming the
 * largest changed files; the changed files themselves are read in a copy taken
 * from the saved objects. Comment lines carry no diff records.
 */
export function unrenderedResultNotice(run: {
  result?: GitObjectResult;
  patchViewUnavailable?: PatchViewUnavailable;
  inventory?: CaptureChangeInventory;
  changedPaths?: string[];
}): string {
  const view = run.patchViewUnavailable;
  return [
    view?.reason === "render_failed"
      ? `# Claudexor: the patch view of this result could not be rendered (estimated ${view.estimatedBytes ?? "unknown"} bytes; view limit ${view.limitBytes}).`
      : `# Claudexor: this result is too large to render as one patch (estimated ${view?.estimatedBytes ?? "unknown"} bytes; view limit ${view?.limitBytes ?? "unknown"}).`,
    `# It is kept exactly as Git objects (${run.result?.digest ?? "unknown digest"}); read the changed files in the copy taken from those objects.`,
    `# Changed paths: ${run.changedPaths?.length ?? run.inventory?.changedFiles ?? "unknown"}.`,
    // Changed paths are working content (INV-146): exact, never masked.
    ...(run.inventory ? captureInventoryLines(run.inventory).map((line) => `# ${line}`) : []),
    "",
  ].join("\n");
}
