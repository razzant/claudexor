import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  WorkspaceFilesManifest,
  WorkspaceEnvelope,
  type AccessProfile,
  type WorkspaceFileState,
  type WorkspaceFileChange,
} from "../schema/index.js";
import { containsSecretLikeToken, nowIso, sha256 } from "../util/index.js";
import {
  directoryInventory,
  materializeWorkspaceFile,
  readWorkspaceFile,
  sameWorkspaceFile,
  workspaceFilePath,
} from "./files-io.js";

interface DirectoryBaseline {
  sourceRoot: string;
  scopePaths: string[];
  isolation: "live" | "envelope";
  entries: Array<{ path: string; state: WorkspaceFileState }>;
}

export async function createDirectoryEnvelope(input: {
  sourceRoot: string;
  envelopeRoot: string;
  envelopeId: string;
  homeDir: string;
  harnessConfigDirs: Record<string, string>;
  taskId: string;
  attemptId: string;
  scopePaths?: string[];
  inPlace?: boolean;
  accessProfile?: AccessProfile;
}): Promise<WorkspaceEnvelope> {
  const executionRoot = input.inPlace ? input.sourceRoot : join(input.envelopeRoot, "tree");
  const scopePaths = input.scopePaths ?? [];
  await prepareDirectoryWorkspace({
    ...input,
    executionRoot,
    scopePaths,
    inPlace: input.inPlace === true,
  });
  return WorkspaceEnvelope.parse({
    id: input.envelopeId,
    task_id: input.taskId,
    attempt_id: input.attemptId,
    repo_root: input.sourceRoot,
    worktree_path: executionRoot,
    base_ref: null,
    base_sha: null,
    branch_name: null,
    workspace_kind: "directory",
    scope_paths: scopePaths,
    home_dir: input.homeDir,
    harness_config_dirs: input.harnessConfigDirs,
    policy_profile: input.accessProfile ?? "workspace_write",
    dirty_policy: "snapshot",
    created_at: nowIso(),
  });
}

/** Uses the existing envelope's baseline/tree directories, never another store. */
export async function prepareDirectoryWorkspace(input: {
  sourceRoot: string;
  executionRoot: string;
  envelopeRoot: string;
  scopePaths: string[];
  inPlace: boolean;
}): Promise<void> {
  const { sourceRoot, executionRoot, envelopeRoot, scopePaths, inPlace } = input;
  const content = join(envelopeRoot, "baseline", "content");
  const entries = await directoryInventory(sourceRoot, scopePaths, inPlace ? undefined : content);
  if (!inPlace) {
    await mkdir(executionRoot, { recursive: true });
    for (const [path, state] of entries) {
      await materializeWorkspaceFile(
        await workspaceFilePath(executionRoot, path),
        state,
        state.kind === "file" ? join(content, state.sha256.slice(7)) : undefined,
      );
    }
    const current = await directoryInventory(sourceRoot, scopePaths);
    if (
      current.size !== entries.size ||
      [...entries].some(([path, state]) => !sameWorkspaceFile(state, current.get(path) ?? null))
    )
      throw new Error("Selected source footprint changed while the directory copy was prepared");
  }
  const baseline: DirectoryBaseline = {
    sourceRoot,
    scopePaths,
    isolation: inPlace ? "live" : "envelope",
    entries: [...entries].map(([path, state]) => ({ path, state })),
  };
  await writeFile(join(envelopeRoot, "directory-baseline.json"), JSON.stringify(baseline) + "\n");
}

export interface CapturedWorkspaceFiles {
  manifest: WorkspaceFilesManifest;
  manifestPath: string;
  manifestSha256: string;
  changedPaths: string[];
  noChanges: boolean | null;
}

/** Complete bytes live under the run artifact tree; a preview is never apply input.
 * The manifest's source is the tree its baseline was read from (a delegated
 * run's bound execution root), never a caller-supplied identity. */
export async function captureDirectoryWorkspace(input: {
  executionRoot: string;
  envelopeRoot: string;
  runRoot: string;
  observedPaths?: string[];
  excludedPaths?: string[];
}): Promise<CapturedWorkspaceFiles> {
  const baseline = JSON.parse(
    await readFile(join(input.envelopeRoot, "directory-baseline.json"), "utf8"),
  ) as DirectoryBaseline;
  const before = new Map(baseline.entries.map(({ path, state }) => [path, state]));
  const contentPrefix = "final/files/content";
  const content = join(input.runRoot, contentPrefix);
  const paths =
    baseline.isolation === "envelope"
      ? ["."]
      : [...baseline.scopePaths, ...(input.observedPaths ?? [])];
  const after = await directoryInventory(input.executionRoot, paths, content, input.excludedPaths);
  const entries: WorkspaceFileChange[] = [];
  const excluded = (path: string) =>
    (input.excludedPaths ?? []).some((prefix) => path === prefix || path.startsWith(prefix + "/"));
  const observed = (input.observedPaths ?? []).filter((path) => path !== ".");
  for (const path of [...new Set([...before.keys(), ...after.keys(), ...observed])].sort()) {
    if (excluded(path)) continue;
    const old = before.get(path);
    if (old?.kind === "file" && baseline.isolation === "envelope") {
      const saved = await readWorkspaceFile(
        join(input.envelopeRoot, "baseline", "content", old.sha256.slice(7)),
        content,
      );
      if (
        saved?.kind !== "file" ||
        saved.sha256 !== old.sha256 ||
        saved.sizeBytes !== old.sizeBytes
      )
        throw new Error(`Baseline bytes no longer match: ${path}`);
    }
    const withRef = (
      state: WorkspaceFileState | null,
      retained: boolean,
    ): WorkspaceFileState | null =>
      state?.kind === "file" && retained
        ? { ...state, artifactPath: `${contentPrefix}/${state.sha256.slice(7)}` }
        : state;
    let knownAbsent = baseline.scopePaths.some(
      (scope) => scope === "." || path === scope || path.startsWith(scope + "/"),
    );
    // New output outside the input footprint may add an absent target, but
    // an existing unselected file is not a captured baseline to overwrite.
    if (!old && !knownAbsent && baseline.isolation === "envelope")
      knownAbsent =
        (await readWorkspaceFile(await workspaceFilePath(baseline.sourceRoot, path, true))) ===
        null;
    entries.push({
      path,
      before: old
        ? withRef(old, baseline.isolation === "envelope")
        : knownAbsent
          ? null
          : "unknown",
      after: withRef(after.get(path) ?? null, true),
    });
  }
  const manifest = WorkspaceFilesManifest.parse({
    version: 1,
    sourceRoot: baseline.sourceRoot,
    executionRoot: input.executionRoot,
    isolation: baseline.isolation,
    scopePaths: baseline.scopePaths,
    complete: true,
    entries,
  });
  const manifestPath = "final/files/manifest.json";
  await mkdir(join(input.runRoot, "final/files"), { recursive: true });
  const text = JSON.stringify(manifest) + "\n";
  if (containsSecretLikeToken(text))
    throw new Error("Manifest contains credential material; no result was published");
  const path = join(input.runRoot, manifestPath);
  await writeFile(`${path}.pending`, text);
  await rename(`${path}.pending`, path);
  const changedPaths = entries
    .filter((entry) => !sameWorkspaceFile(entry.before, entry.after))
    .map((entry) => entry.path);
  return {
    manifest,
    manifestPath,
    manifestSha256: sha256(text),
    changedPaths,
    noChanges: entries.some(
      (entry) => entry.before !== "unknown" && !sameWorkspaceFile(entry.before, entry.after),
    )
      ? false
      : changedPaths.length > 0
        ? null
        : baseline.isolation === "envelope" || baseline.scopePaths.includes(".")
          ? true
          : null,
  };
}
