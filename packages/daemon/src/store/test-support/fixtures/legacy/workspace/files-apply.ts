import { chmod, lstat, mkdir, readFile, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  WorkspaceFilesManifest,
  type WorkspaceFileChange,
  type WorkspaceFileState,
} from "../schema/index.js";
import { newId, sha256 } from "../util/index.js";
import {
  materializeWorkspaceFile,
  readWorkspaceFile,
  sameWorkspaceFile,
  workspaceFilePath,
} from "./files-io.js";

export async function readWorkspaceFilesManifest(
  runRoot: string,
  path: string,
  expectedSha256: string,
): Promise<WorkspaceFilesManifest> {
  const text = await readFile(await workspaceFilePath(runRoot, path), "utf8");
  if (sha256(text) !== expectedSha256)
    throw new Error("Files manifest digest does not match the work product");
  return WorkspaceFilesManifest.parse(JSON.parse(text));
}

export async function verifyWorkspaceFiles(
  manifest: WorkspaceFilesManifest,
  artifactRoot: string,
): Promise<void> {
  WorkspaceFilesManifest.parse(manifest);
  for (const entry of manifest.entries) {
    for (const state of [entry.before, entry.after]) {
      if (state === "unknown" || state?.kind !== "file" || !state.artifactPath) continue;
      const actual = await readWorkspaceFile(
        await workspaceFilePath(artifactRoot, state.artifactPath),
      );
      if (
        actual?.kind !== "file" ||
        actual.sha256 !== state.sha256 ||
        actual.sizeBytes !== state.sizeBytes
      )
        throw new Error(`Artifact bytes do not match the manifest: ${entry.path}`);
    }
  }
}

export function selectedWorkspaceChanges(
  manifest: WorkspaceFilesManifest,
  paths?: readonly string[],
): WorkspaceFileChange[] {
  const changed = manifest.entries.filter((entry) => !sameWorkspaceFile(entry.before, entry.after));
  if (paths === undefined) return changed;
  for (const path of paths) {
    if (!changed.some((entry) => entry.path === path || entry.path.startsWith(path + "/")))
      throw new Error(`Selected path has no recorded change: ${path}`);
  }
  return changed.filter((entry) =>
    paths.some((path) => entry.path === path || entry.path.startsWith(path + "/")),
  );
}

export function deliverableWorkspaceChanges(
  manifest: WorkspaceFilesManifest,
  paths?: readonly string[],
): WorkspaceFileChange[] {
  return selectedWorkspaceChanges(manifest, paths).filter((entry) => entry.before !== "unknown");
}

export async function materializeWorkspaceBaseline(
  root: string,
  manifest: WorkspaceFilesManifest,
  artifactRoot: string,
): Promise<void> {
  for (const entry of manifest.entries) {
    if (entry.before === "unknown") continue;
    if (entry.before === null) continue;
    await materializeWorkspaceFile(
      await workspaceFilePath(root, entry.path),
      entry.before,
      entry.before.kind === "file" && entry.before.artifactPath
        ? await workspaceFilePath(artifactRoot, entry.before.artifactPath)
        : undefined,
    );
  }
}

export interface ApplyWorkspaceFilesResult {
  applied: boolean;
  alreadyApplied: boolean;
  treeMutated: boolean;
  appliedPaths: string[];
  detail?: string;
}

async function ensureTargetParents(
  root: string,
  relative: string,
  mutated: () => void,
): Promise<void> {
  const parts = relative.split("/").slice(0, -1);
  for (let count = 1; count <= parts.length; count += 1) {
    const path = await workspaceFilePath(root, parts.slice(0, count).join("/"));
    const state = await readWorkspaceFile(path);
    if (state === null) {
      await mkdir(path);
      mutated();
    } else if (state.kind !== "directory") throw new Error(`Target parent changed: ${path}`);
  }
}

/** Caller supplies the shared delivery mutation lease. Never reverse unrelated edits. */
export async function applyWorkspaceFiles(
  targetRoot: string,
  manifest: WorkspaceFilesManifest,
  artifactRoot: string,
  paths?: readonly string[],
): Promise<ApplyWorkspaceFilesResult> {
  const result: ApplyWorkspaceFilesResult = {
    applied: false,
    alreadyApplied: false,
    treeMutated: false,
    appliedPaths: [],
  };
  if (manifest.isolation === "live")
    return {
      ...result,
      detail: "Direct results are already in place; no separate apply is available",
    };
  try {
    await verifyWorkspaceFiles(manifest, artifactRoot);
    // Entries with an unknown preimage are retained as custody/disclosure
    // facts, but can never authorize overwriting an existing target. They are
    // therefore excluded from the mutation set while safe selected entries
    // remain deliverable.
    const selected = selectedWorkspaceChanges(manifest, paths);
    const refusedUnknown = selected.filter((entry) => entry.before === "unknown");
    const entries = selected.filter((entry) => entry.before !== "unknown");
    const current = new Map<string, WorkspaceFileState | null>();
    for (const entry of entries)
      current.set(
        entry.path,
        await readWorkspaceFile(await workspaceFilePath(targetRoot, entry.path, true)),
      );
    const pendingEntries = entries.filter(
      (entry) => !sameWorkspaceFile(entry.after, current.get(entry.path) ?? null),
    );
    if (pendingEntries.length === 0) {
      const detail =
        refusedUnknown.length > 0
          ? `Unknown preimage retains custody: ${refusedUnknown.map((entry) => entry.path).join(", ")}`
          : undefined;
      return entries.length === 0 && refusedUnknown.length > 0
        ? { ...result, detail }
        : { ...result, applied: true, alreadyApplied: true, detail };
    }
    for (const entry of pendingEntries) {
      if (!sameWorkspaceFile(entry.before, current.get(entry.path) ?? null))
        return { ...result, detail: `Target preimage changed: ${entry.path}` };
    }
    // Child removals precede directory replacement; creations establish parents first.
    const ordered = [
      ...pendingEntries
        .filter((entry) => entry.after === null)
        .sort((a, b) => b.path.split("/").length - a.path.split("/").length),
      ...pendingEntries
        .filter((entry) => entry.after !== null)
        .sort((a, b) => a.path.split("/").length - b.path.split("/").length),
    ];
    for (const entry of ordered) {
      const target = await workspaceFilePath(targetRoot, entry.path);
      if (!sameWorkspaceFile(entry.before, await readWorkspaceFile(target)))
        return { ...result, detail: `Target changed during delivery: ${entry.path}` };
      const after = entry.after;
      if (after === null) {
        if (entry.before !== "unknown" && entry.before?.kind === "directory") await rmdir(target);
        else await rm(target);
      } else if (after.kind === "directory") {
        if (
          entry.before !== null &&
          entry.before !== "unknown" &&
          entry.before.kind !== "directory"
        ) {
          await rm(target);
          result.treeMutated = true;
        }
        await ensureTargetParents(targetRoot, entry.path, () => {
          result.treeMutated = true;
        });
        await mkdir(target, { recursive: true, mode: after.mode });
        if (entry.before === null) result.treeMutated = true;
        await chmod(target, after.mode);
      } else {
        await ensureTargetParents(targetRoot, entry.path, () => {
          result.treeMutated = true;
        });
        const temp = join(dirname(target), `.${newId("claudexor-file")}`);
        try {
          await materializeWorkspaceFile(
            temp,
            after,
            after.kind === "file" && after.artifactPath
              ? await workspaceFilePath(artifactRoot, after.artifactPath)
              : undefined,
          );
          if (!sameWorkspaceFile(entry.before, await readWorkspaceFile(target)))
            return { ...result, detail: `Target changed while output was prepared: ${entry.path}` };
          const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if (existing?.isDirectory()) {
            await rmdir(target);
            result.treeMutated = true;
          }
          await rename(temp, target);
        } finally {
          await rm(temp, { force: true });
        }
      }
      result.treeMutated = true;
      result.appliedPaths.push(entry.path);
    }
    return {
      ...result,
      applied: true,
      ...(refusedUnknown.length > 0
        ? {
            detail: `Unknown preimage retains custody: ${refusedUnknown.map((entry) => entry.path).join(", ")}`,
          }
        : {}),
    };
  } catch (error) {
    return { ...result, detail: error instanceof Error ? error.message : String(error) };
  }
}
