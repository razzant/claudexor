import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { WorkspaceScopePath, type WorkspaceFileState } from "@claudexor/schema";
import { newId } from "@claudexor/util";

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

/** One streaming reader supplies both the digest and optional immutable bytes. */
export async function readWorkspaceFile(
  path: string,
  contentDir?: string,
): Promise<WorkspaceFileState | null> {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  });
  if (!stat) return null;
  if (stat.isSymbolicLink()) return { kind: "symlink", target: await readlink(path) };
  if (stat.isDirectory()) return { kind: "directory", mode: stat.mode & 0o777 };
  if (!stat.isFile()) throw new Error(`Unsupported filesystem entry: ${path}`);
  if (contentDir) await mkdir(contentDir, { recursive: true });
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const temp = contentDir ? join(contentDir, newId("pending")) : null;
  let output: Awaited<ReturnType<typeof open>> | null = null;
  const hash = createHash("sha256");
  let sizeBytes = 0;
  try {
    output = temp ? await open(temp, "wx", 0o600) : null;
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      sizeBytes += chunk.length;
      if (output) await output.writeFile(chunk);
    }
    const after = await lstat(path);
    if (
      stat.dev !== after.dev ||
      stat.ino !== after.ino ||
      stat.size !== sizeBytes ||
      stat.mtimeMs !== after.mtimeMs ||
      stat.ctimeMs !== after.ctimeMs
    )
      throw new Error(`File changed while being captured: ${path}`);
    const digest = hash.digest("hex");
    if (output && temp && contentDir) {
      await output.sync();
      await output.close();
      await rename(temp, join(contentDir, digest));
    }
    return { kind: "file", sha256: `sha256:${digest}`, sizeBytes, mode: stat.mode & 0o777 };
  } finally {
    await input.close();
    await output?.close().catch(() => undefined);
    if (temp) await rm(temp, { force: true });
  }
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

export async function directoryInventory(
  root: string,
  paths: readonly string[],
  contentDir?: string,
  excluded: readonly string[] = [],
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
    const path = await workspaceFilePath(root, relative);
    const state = await readWorkspaceFile(path, contentDir);
    if (!state) return;
    if (relative !== ".") entries.set(relative, state);
    if (state.kind === "directory") {
      for (const name of (await readdir(path)).sort())
        await walk(relative === "." ? name : `${relative}/${name}`);
    }
  };
  for (const relative of paths) {
    WorkspaceScopePath.parse(relative);
    const parts = relative.split("/");
    for (let count = 1; count < parts.length; count += 1) {
      const parent = parts.slice(0, count).join("/");
      const state = await readWorkspaceFile(await workspaceFilePath(root, parent));
      if (state?.kind === "directory") entries.set(parent, state);
    }
    await walk(relative);
  }
  return entries;
}

/** Materialize exactly one immutable state; callers own target preimage checks. */
export async function materializeWorkspaceFile(
  path: string,
  state: WorkspaceFileState,
  contentPath?: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (state.kind === "directory") {
    await mkdir(path, { recursive: true, mode: state.mode });
    await chmod(path, state.mode);
  } else if (state.kind === "symlink") {
    await symlink(state.target, path);
  } else {
    if (!contentPath) throw new Error("File state has no immutable content");
    const source = await open(contentPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let target: Awaited<ReturnType<typeof open>> | null = null;
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      target = await open(path, "wx", state.mode);
      for await (const chunk of source.createReadStream({ autoClose: false })) {
        hash.update(chunk);
        bytes += chunk.length;
        await target.writeFile(chunk);
      }
      if (`sha256:${hash.digest("hex")}` !== state.sha256 || bytes !== state.sizeBytes)
        throw new Error("File artifact does not match its recorded hash and size");
      await target.chmod(state.mode);
      await target.sync();
    } finally {
      await source.close();
      await target?.close();
    }
  }
}
