import { chmod, lstat, mkdir, readlink, readdir, symlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { WorkspaceScopePath, type WorkspaceFileState } from "@claudexor/schema";
import { keepFileContent, type RunContentIndex } from "./content-index.js";
import { writeIndependentCopy } from "./file-copy.js";
import { throwIfCancelled } from "./git-run.js";

/** Resolve relative entries without following an ancestor link into another tree. */
export async function workspaceFilePath(
  root: string,
  relative: string,
  readingPreimage = false,
): Promise<string> {
  WorkspaceScopePath.parse(relative);
  const base = resolve(root);
  const path = resolve(base, relative);
  if (path !== base && !path.startsWith(base + sep)) throw new Error("File path escapes its root");
  let current = base;
  for (const part of relative.split("/").slice(0, -1)) {
    current = join(current, part);
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || (readingPreimage && error.code === "ENOTDIR")) return null;
      throw error;
    });
    if (stat && (stat.isSymbolicLink() || (!stat.isDirectory() && !readingPreimage)))
      throw new Error(`File ancestor is not a directory: ${current}`);
  }
  return path;
}

/** One reader supplies both the digest and, with `contentDir`, the immutable
 * bytes under their content name: the digest is of the bytes kept. Bytes the
 * run's `index` already holds are linked, not written a second time. A file
 * that changed while it was read is `FileChangedError`. */
export async function readWorkspaceFile(
  path: string,
  contentDir?: string,
  index?: RunContentIndex,
): Promise<WorkspaceFileState | null> {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  });
  if (!stat) return null;
  if (stat.isSymbolicLink()) return { kind: "symlink", target: await readlink(path) };
  if (stat.isDirectory()) return { kind: "directory", mode: stat.mode & 0o777 };
  if (!stat.isFile()) throw new Error(`Unsupported filesystem entry: ${path}`);
  const digest = await keepFileContent(path, stat, contentDir, index);
  return { kind: "file", ...digest, mode: stat.mode & 0o777 };
}

export function sameWorkspaceFile(
  a: WorkspaceFileState | null | "unknown",
  b: WorkspaceFileState | null,
): boolean {
  if (a === "unknown") return false;
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "file" && b.kind === "file")
    return a.sha256 === b.sha256 && a.sizeBytes === b.sizeBytes && a.mode === b.mode;
  if (a.kind === "directory" && b.kind === "directory") return a.mode === b.mode;
  return a.kind === "symlink" && b.kind === "symlink" && a.target === b.target;
}

/** `signal`: a preparation's stop, checked before every entry and listing; an entry
 * already being read finishes first (no IO is abandoned). Capture passes none.
 * `index`: the run's engine-owned immutable bytes (see `RunContentIndex`). */
export async function directoryInventory(
  root: string,
  paths: readonly string[],
  contentDir?: string,
  excluded: readonly string[] = [],
  signal?: AbortSignal,
  index?: RunContentIndex,
): Promise<Map<string, WorkspaceFileState>> {
  const entries = new Map<string, WorkspaceFileState>();
  const visited = new Set<string>();
  const walk = async (relative: string): Promise<void> => {
    if (
      visited.has(relative) ||
      excluded.some((prefix) => relative === prefix || relative.startsWith(prefix + "/"))
    )
      return;
    visited.add(relative);
    throwIfCancelled(signal);
    const path = await workspaceFilePath(root, relative);
    const state = await readWorkspaceFile(path, contentDir, index);
    if (!state) return;
    if (relative !== ".") entries.set(relative, state);
    if (state.kind === "directory") {
      throwIfCancelled(signal);
      for (const name of (await readdir(path)).sort())
        await walk(relative === "." ? name : `${relative}/${name}`);
    }
  };
  for (const relative of paths) {
    WorkspaceScopePath.parse(relative);
    const parts = relative.split("/");
    for (let count = 1; count < parts.length; count += 1) {
      const parent = parts.slice(0, count).join("/");
      throwIfCancelled(signal);
      const state = await readWorkspaceFile(await workspaceFilePath(root, parent));
      if (state?.kind === "directory") entries.set(parent, state);
    }
    await walk(relative);
  }
  return entries;
}

/** Materialize exactly one immutable state; callers own target preimage checks.
 * `durable: false` for a disposable tree (a copy for review or verification). */
export async function materializeWorkspaceFile(
  path: string,
  state: WorkspaceFileState,
  contentPath?: string,
  durable = true,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (state.kind === "directory") {
    await mkdir(path, { recursive: true, mode: state.mode });
    await chmod(path, state.mode);
  } else if (state.kind === "symlink") {
    await symlink(state.target, path);
  } else {
    if (!contentPath) throw new Error("File state has no immutable content");
    // Always an independent file: what receives it may be edited.
    await writeIndependentCopy(contentPath, path, {
      expected: state,
      mode: state.mode,
      durable,
      immutableSource: true,
    });
  }
}
