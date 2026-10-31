import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { PatchViewUnavailable } from "@claudexor/schema";
import { isVanishedErrno } from "./artifact-paths.js";

const ATTEMPT_PATCH = /^attempts\/([A-Za-z0-9._-]+)\/patch\.diff$/;

/** `read` of a path, or null only when it is not there (ENOENT, ENOTDIR). Any other
 * failure (an I/O error, a directory that cannot be searched) is thrown: it says
 * nothing about a view, and the 404 it used to become reads as "no changes". */
function unlessAbsent<T>(read: () => T): T | null {
  try {
    return read();
  } catch (error) {
    if (isVanishedErrno(error)) return null;
    throw error;
  }
}

/**
 * F (#535): the patch is a view of an object result. When a result has no
 * rendered view, a request for its patch artifact is answered typed (413, as an
 * over-limit artifact is today) with the reason and the bounded inventory,
 * never as "no such artifact" (which clients read as "no changes").
 */
export function unrenderedPatchView(
  runRoot: string | null | undefined,
  relative: string,
): Record<string, unknown> | null {
  if (!runRoot) return null;
  const attempt = ATTEMPT_PATCH.exec(relative)?.[1];
  const record =
    relative === "final/patch.diff"
      ? join(runRoot, "final", "work_product.yaml")
      : attempt
        ? join(runRoot, "attempts", attempt, "attempt.yaml")
        : null;
  if (!record || unlessAbsent(() => lstatSync(join(runRoot, relative)))) return null;
  if (!unlessAbsent(() => lstatSync(record))?.isFile()) return null;
  const text = unlessAbsent(() => readFileSync(record, "utf8"));
  if (text === null) return null;
  try {
    const doc = parse(text) as Record<string, unknown> | null;
    const holder =
      relative === "final/patch.diff" ? (doc?.["meta"] as Record<string, unknown>) : doc;
    const view = holder?.["patch_view"] as { available?: unknown } | undefined;
    if (view?.available !== false) return null;
    const parsed = PatchViewUnavailable.safeParse(view);
    if (!parsed.success) return null;
    return {
      error: `${
        parsed.data.reason === "render_failed"
          ? "this result's patch view could not be rendered"
          : "this result is too large to render as one patch"
      }; it is kept exactly as Git objects and can still be applied, verified and reverted`,
      code: "patch_view_unavailable",
      ...parsed.data,
      ...(holder?.["change_inventory"] ? { inventory: holder["change_inventory"] } : {}),
    };
  } catch {
    // A record that does not parse names no view.
    return null;
  }
}
