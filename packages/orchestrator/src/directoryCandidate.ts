import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  type HarnessEvent,
  type RunOutcomeFacts,
  type WorkspaceEnvelope,
  type WorkspaceFilesManifest,
  WorkProduct,
  WorkspacePreparedPayload,
  workspacePreparationSummary,
} from "@claudexor/schema";
import {
  type WorkspaceManager,
  type CapturedWorkspaceFiles,
  directoryPreparation,
  materializeWorkspaceFile,
  readWorkspaceFile,
  sameWorkspaceFile,
  workspaceFilePath,
} from "@claudexor/workspace";
import { type ArtifactStore, type RunPaths } from "@claudexor/artifact-store";
import { type EventLog } from "@claudexor/event-log";
import { newId, sha256 } from "@claudexor/util";
import { directoryCaptureRefusal, type CaptureRefusal } from "./captureRefusal.js";

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

const announcedPreparations = new WeakSet<WorkspaceEnvelope>();

/** An isolated copy's preparation fact, announced once per copy before its
 * first executor starts, and the same fact as that executor's prompt notice.
 * Worded for the copy's creation: a later round's copy also holds that round's work. */
export async function directoryPreparationNotice(
  envelope: WorkspaceEnvelope,
  attemptId: string,
  log: EventLog | undefined,
): Promise<string | undefined> {
  const prepared = await directoryPreparation(envelope);
  if (!prepared) return undefined;
  const payload = WorkspacePreparedPayload.parse({ attempt_id: attemptId, ...prepared });
  if (!announcedPreparations.has(envelope)) {
    announcedPreparations.add(envelope);
    log?.emit("workspace.prepared", payload);
  }
  return `When this workspace was created: ${workspacePreparationSummary(payload).text}`;
}

/** Only the run's final capture passes `holder`: its refusal keeps the isolated
 * copy for inspection. Per-try and stability captures are superseded, never kept. */
export async function captureDirectoryCandidate(input: {
  manager: WorkspaceManager;
  envelope: WorkspaceEnvelope;
  artifactRoot: string;
  observedPaths: string[];
  holder?: { runId: string; runDir: string };
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
  } catch (error) {
    // The partial payload is no result and goes. One that cannot be removed stays,
    // never in place of the capture's own cause: the refusal names it beside that.
    try {
      await rm(join(input.artifactRoot, "final/files"), { recursive: true, force: true });
    } catch (cleanupError) {
      if (error instanceof Error && Object.isExtensible(error) && !("cleanupError" in error))
        Object.defineProperty(error, "cleanupError", { value: cleanupError, enumerable: false });
    }
    const inPlace = input.envelope.worktree_path === input.envelope.repo_root;
    const { manager: wsm, envelope, holder } = input;
    return {
      refusal: directoryCaptureRefusal(error, inPlace, holder && { wsm, envelope, holder }),
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
    `${direct ? (files.changedPaths.length > 0 ? `${files.noChanges === false ? "Files updated" : "Files observed"} in ${files.manifest.executionRoot}.` : files.noChanges === null ? `Operation finished in ${files.manifest.executionRoot}. A complete file comparison was not recorded.` : "No file changes were found in the selected scope.") : "Files captured from a separate copy. Inspect the captured files; application is subject to the run's outcome and a delivery check."}\n\n${listing.join("\n")}\n`,
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
