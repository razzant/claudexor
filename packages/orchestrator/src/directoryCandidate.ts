import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  type HarnessEvent,
  type RunOutcomeFacts,
  type WorkspaceEnvelope,
  type WorkspaceFilesManifest,
  WorkProduct,
} from "@claudexor/schema";
import {
  type WorkspaceManager,
  type CapturedWorkspaceFiles,
  materializeWorkspaceFile,
  readWorkspaceFile,
  sameWorkspaceFile,
  workspaceFilePath,
} from "@claudexor/workspace";
import { type ArtifactStore, type RunPaths } from "@claudexor/artifact-store";
import { type EventLog } from "@claudexor/event-log";
import { newId, sha256 } from "@claudexor/util";
import type { CaptureRefusal } from "./secretDiff.js";

export interface DirectoryCandidate extends CapturedWorkspaceFiles {
  artifactRoot: string;
}

/** File-change paths are adapter facts; command/prose text never invents writes. */
export function observeDirectoryPaths(paths: Set<string>, event: HarnessEvent, cwd: string): void {
  if (event.type !== "file_change") return;
  const item = event.payload?.item as { changes?: Array<{ path?: unknown }> } | undefined;
  const values = [
    event.payload?.path,
    ...(Array.isArray(item?.changes) ? item.changes : []).map((change) => change?.path),
  ];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const path = relative(resolve(cwd), isAbsolute(value) ? value : resolve(cwd, value))
      .split("\\")
      .join("/");
    if (path && path !== ".." && !path.startsWith("../") && !isAbsolute(path)) paths.add(path);
  }
}

export async function captureDirectoryCandidate(input: {
  manager: WorkspaceManager;
  envelope: WorkspaceEnvelope;
  artifactRoot: string;
  observedPaths: string[];
}): Promise<{ files?: DirectoryCandidate; refusal?: CaptureRefusal }> {
  if (
    input.envelope.policy_profile === "readonly" &&
    input.envelope.worktree_path === input.envelope.repo_root
  )
    return {};
  try {
    const files = await input.manager.captureFiles(input.envelope, input.artifactRoot, {
      observedPaths: input.observedPaths,
    });
    return { files: { ...files, artifactRoot: input.artifactRoot } };
  } catch {
    await rm(join(input.artifactRoot, "final/files"), { recursive: true, force: true });
    return {
      refusal: {
        disposition:
          input.envelope.worktree_path === input.envelope.repo_root
            ? "manual_cleanup"
            : "discarded",
        detail:
          "Directory output capture failed (containment, read or size); no file payload was published. Direct effects require inspection, not a fabricated rollback.",
        // A capture that could not prove containment or read its files fails
        // closed; content is never a cause (INV-146). The typed phase is kept.
        phase: "artifact_security",
      },
    };
  }
}

export function directoryChangedEntries(manifest: WorkspaceFilesManifest) {
  return manifest.entries.filter(
    (entry) =>
      !(entry.before === "unknown" && entry.after === null) &&
      !sameWorkspaceFile(entry.before, entry.after),
  );
}

export function directoryHasOutput(files?: DirectoryCandidate): boolean {
  return files !== undefined && directoryChangedEntries(files.manifest).length > 0;
}

export function directoryPreview(files: DirectoryCandidate): string {
  return (
    `Directory work product. Full bytes and baseline: ${files.manifestPath}\n` +
    directoryChangedEntries(files.manifest)
      .map(
        (entry) =>
          `${JSON.stringify(entry.path)}: ${entry.before === "unknown" ? "unknown preimage" : (entry.before?.kind ?? "absent")} -> ${entry.after?.kind ?? "absent"}${entry.after?.kind === "file" ? ` (${entry.after.sizeBytes} bytes, ${entry.after.sha256})` : ""}`,
      )
      .join("\n") +
    "\n"
  );
}

/** A requested review sees a frozen selected candidate, never a later live edit. */
export async function prepareDirectoryReview(
  files: DirectoryCandidate,
  evidenceDir: string,
): Promise<{ cwd: string; paths: string[]; dispose(): Promise<void> }> {
  const cwd = join(files.artifactRoot, "directory-review");
  await mkdir(cwd, { recursive: true });
  await rm(join(evidenceDir, "final/files"), { recursive: true, force: true });
  const copied = new Set<string>();
  const paths: string[] = [];
  for (const entry of files.manifest.entries) {
    for (const state of [entry.before, entry.after]) {
      if (
        state === "unknown" ||
        state?.kind !== "file" ||
        !state.artifactPath ||
        copied.has(state.artifactPath)
      )
        continue;
      await materializeWorkspaceFile(
        await workspaceFilePath(evidenceDir, state.artifactPath),
        state,
        await workspaceFilePath(files.artifactRoot, state.artifactPath),
      );
      copied.add(state.artifactPath);
    }
    if (!entry.after) continue;
    await materializeWorkspaceFile(
      await workspaceFilePath(cwd, entry.path),
      entry.after,
      entry.after.kind === "file"
        ? await workspaceFilePath(files.artifactRoot, entry.after.artifactPath!)
        : undefined,
    );
    paths.push(entry.path);
  }
  await writeFile(join(evidenceDir, "FILES.json"), JSON.stringify(files.manifest) + "\n");
  return { cwd, paths, dispose: () => rm(cwd, { recursive: true, force: true }) };
}

/** Recheck the same captured footprint after review, keeping its sealed bytes intact. */
export async function directoryCandidateStable(
  manager: WorkspaceManager,
  envelope: WorkspaceEnvelope,
  files: DirectoryCandidate,
): Promise<boolean> {
  const artifactRoot = join(files.artifactRoot, "review-verification");
  try {
    const current = await captureDirectoryCandidate({
      manager,
      envelope,
      artifactRoot,
      observedPaths: files.manifest.entries.map((entry) => entry.path),
    });
    return current.files?.manifestSha256 === files.manifestSha256;
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
}

export async function publishDirectoryCandidate(input: {
  files: DirectoryCandidate;
  store: ArtifactStore;
  paths: RunPaths;
  taskId: string;
  attemptId: string;
  harnessId: string;
  facts: RunOutcomeFacts;
  log: EventLog;
  delivery?: { applied: boolean; appliedPaths: string[]; alreadyApplied?: boolean };
}): Promise<void> {
  const { files, paths, store } = input;
  for (const entry of files.manifest.entries)
    for (const state of [entry.before, entry.after]) {
      if (state === "unknown" || state?.kind !== "file" || !state.artifactPath) continue;
      const source = await workspaceFilePath(files.artifactRoot, state.artifactPath);
      const target = await workspaceFilePath(paths.root, state.artifactPath);
      await mkdir(join(paths.finalDir, "files/content"), { recursive: true });
      // Identical hashes share bytes between baseline and postimage.
      try {
        await materializeWorkspaceFile(target, state, source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await readWorkspaceFile(target);
        if (
          existing?.kind !== "file" ||
          existing.sha256 !== state.sha256 ||
          existing.sizeBytes !== state.sizeBytes
        )
          throw new Error("Existing result bytes do not match their immutable file reference");
      }
    }
  const text = await readFile(join(files.artifactRoot, files.manifestPath), "utf8");
  if (sha256(text) !== files.manifestSha256)
    throw new Error("Captured directory manifest changed before publication");
  store.writeText(join(paths.root, files.manifestPath), text);
  store.writeText(join(paths.finalDir, "files/preview.txt"), directoryPreview(files));
  const direct = files.manifest.isolation === "live";
  const listing = directoryChangedEntries(files.manifest).map((entry) => {
    const label = entry.path.replace(/[\\\[\]]/g, "\\$&");
    return entry.after?.kind === "file"
      ? `- [${label}](${entry.after.artifactPath}) (${entry.after.sizeBytes} bytes)`
      : `- ${label}${entry.after === null ? " (removed)" : ""}`;
  });
  store.writeText(
    join(paths.finalDir, "files/result.md"),
    `${direct ? (files.changedPaths.length > 0 ? `${files.noChanges === false ? "Files updated" : "Files observed"} in ${files.manifest.executionRoot}.` : files.noChanges === null ? `Operation finished in ${files.manifest.executionRoot}. A complete file comparison was not recorded.` : "No file changes were found in the selected scope.") : "Files prepared in a separate copy. The original folder is unchanged; the result is ready to inspect and apply."}\n\n${listing.join("\n")}\n`,
  );
  const product = WorkProduct.parse({
    id: newId("wp"),
    kind: "files",
    source_task_id: input.taskId,
    producer_attempt_id: input.attemptId,
    files: {
      manifest: files.manifestPath,
      ...(input.delivery ? { delivery_receipt: "final/delivery_receipt.yaml" } : {}),
    },
    meta: {
      manifest_sha256: files.manifestSha256,
      result_kind: "files",
      lifecycle: input.facts.lifecycle,
      outcome_facts: input.facts,
      harness_id: input.harnessId,
      source_root: files.manifest.sourceRoot,
      execution_root: files.manifest.executionRoot,
      no_changes: files.noChanges,
      applied_paths: input.delivery?.appliedPaths ?? (direct ? files.changedPaths : []),
      adopted:
        (direct ||
          !files.manifest.entries.some(
            (entry) => entry.before === "unknown" && entry.after !== null,
          )) &&
        (input.delivery?.applied ?? direct),
      apply_state:
        (direct ||
          !files.manifest.entries.some(
            (entry) => entry.before === "unknown" && entry.after !== null,
          )) &&
        (input.delivery?.applied || direct)
          ? "applied"
          : "not_applied",
    },
  });
  store.writeYaml(join(paths.finalDir, "work_product.yaml"), product);
  input.log.emit("output.ready", { kind: "artifact", path: files.manifestPath });
}
