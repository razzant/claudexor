import { lstat, mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  type HarnessEvent,
  type RunOutcomeFacts,
  type WorkspaceEnvelope,
  type WorkspaceFilesManifest,
  WorkProduct,
  WorkspacePreparedPayload,
  workspacePreparationSummary,
  workStateVetoes,
  deliveryEffectsStatement,
} from "@claudexor/schema";
import {
  type WorkspaceManager,
  type CapturedWorkspaceFiles,
  type RunContentIndex,
  directoryPreparation,
  fileSpaceFailure,
  materializeWorkspaceFile,
  sameWorkspaceFile,
  shareImmutableFile,
  workspaceFilePath,
} from "@claudexor/workspace";
import { type ArtifactStore, type RunPaths } from "@claudexor/artifact-store";
import { type EventLog } from "@claudexor/event-log";
import { filesDeliveryHeldPaths } from "@claudexor/delivery";
import { newId, sha256 } from "@claudexor/util";
import {
  CAPTURE_REFUSED_REASON,
  directoryCaptureRefusal,
  directoryPublicationRefusal,
  DirectoryStabilityError,
  type CaptureRefusal,
} from "./captureRefusal.js";
import { terminalOutcomeFacts } from "./terminalOutcome.js";
import type { CandidateRun } from "./candidateEvidence.js";

export interface DirectoryCandidate extends CapturedWorkspaceFiles {
  artifactRoot: string;
  /** The run's immutable bytes (its manager's): publication and review link them. */
  contentIndex?: RunContentIndex;
}

/** A rejected recursive fs.rm can leave sibling deletes in flight. These paths
 * are reused by later captures, so finish each async operation before returning
 * or throwing; never follow a symlink and never block the event loop with rmSync. */
async function removeCaptureTree(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory()) {
      await rm(path, { force: true });
      return;
    }
    let failure: { error: unknown } | undefined;
    for (const name of await readdir(path)) {
      try {
        await removeCaptureTree(join(path, name));
      } catch (error) {
        failure ??= { error };
      }
    }
    // Still remove every writable sibling; report the first real failure only
    // after all operations have settled, leaving its named path in place.
    if (failure) throw failure.error;
    await rmdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
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
  /** `false` hashes without keeping bytes (a comparison, never a result). */
  retainContent?: boolean;
}): Promise<{ files?: DirectoryCandidate; refusal?: CaptureRefusal }> {
  if (
    input.envelope.policy_profile === "readonly" &&
    input.envelope.worktree_path === input.envelope.repo_root
  )
    return {};
  try {
    const files = await input.manager.captureFiles(input.envelope, input.artifactRoot, {
      observedPaths: input.observedPaths,
      retainContent: input.retainContent,
    });
    const { contentIndex } = input.manager;
    return { files: { ...files, artifactRoot: input.artifactRoot, contentIndex } };
  } catch (error) {
    // The partial payload is no result and goes (a comparison wrote none). One
    // that cannot be removed stays, never in place of the capture's own cause:
    // the refusal names it beside that.
    try {
      if (input.retainContent !== false)
        await removeCaptureTree(join(input.artifactRoot, "final/files"));
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

/** A requested review sees a frozen selected candidate, never a later live edit.
 * The evidence packet is the engine's own immutable record, so it shares the
 * captured blobs; the candidate tree gets independent (disposable) copies. A
 * preparation that cannot hold them throws its typed cause (no room included),
 * and leaves no partial candidate tree. */
export async function prepareDirectoryReview(
  files: DirectoryCandidate,
  evidenceDir: string,
): Promise<{ cwd: string; paths: string[]; dispose(): Promise<void> }> {
  const cwd = join(files.artifactRoot, "directory-review");
  const dispose = () => removeCaptureTree(cwd);
  const paths: string[] = [];
  try {
    await mkdir(cwd, { recursive: true });
    await removeCaptureTree(join(evidenceDir, "final/files"));
    const shared = new Set<string>();
    for (const entry of files.manifest.entries) {
      for (const state of [entry.before, entry.after]) {
        if (
          state === "unknown" ||
          state?.kind !== "file" ||
          !state.artifactPath ||
          shared.has(state.artifactPath)
        )
          continue;
        await shareImmutableFile(
          await workspaceFilePath(files.artifactRoot, state.artifactPath),
          await workspaceFilePath(evidenceDir, state.artifactPath),
          state,
          files.contentIndex,
        );
        shared.add(state.artifactPath);
      }
      if (!entry.after) continue;
      await materializeWorkspaceFile(
        await workspaceFilePath(cwd, entry.path),
        entry.after,
        entry.after.kind === "file"
          ? await workspaceFilePath(files.artifactRoot, entry.after.artifactPath!)
          : undefined,
        false,
      );
      paths.push(entry.path);
    }
    await writeFile(join(evidenceDir, "FILES.json"), JSON.stringify(files.manifest) + "\n");
  } catch (error) {
    // Never in place of the preparation's own cause.
    await dispose().catch(() => undefined);
    throw fileSpaceFailure(error, "review preparation");
  }
  return { cwd, paths, dispose };
}

/** Recheck the same captured footprint after review by hashing it, writing
 * nothing. False means the result changed, including a file that changed while
 * it was being read; a check that could not read it throws
 * `DirectoryStabilityError`. */
export async function directoryCandidateStable(
  manager: WorkspaceManager,
  envelope: WorkspaceEnvelope,
  files: DirectoryCandidate,
): Promise<boolean> {
  const current = await captureDirectoryCandidate({
    manager,
    envelope,
    artifactRoot: join(files.artifactRoot, "review-verification"),
    observedPaths: files.manifest.entries.map((entry) => entry.path),
    retainContent: false,
  });
  if (current.refusal?.failure?.causeCode === "file_changed") return false;
  if (current.refusal) throw new DirectoryStabilityError(current.refusal);
  return current.files?.manifestSha256 === files.manifestSha256;
}

interface DirectoryPublication {
  files: DirectoryCandidate;
  store: ArtifactStore;
  paths: RunPaths;
  taskId: string;
  attemptId: string;
  harnessId: string;
  facts: RunOutcomeFacts;
  log: EventLog;
  /** The run's automatic delivery receipt, when it made one. */
  delivery?: Parameters<typeof deliveryEffectsStatement>[0] & {
    appliedPaths: string[];
    alreadyApplied?: boolean;
  };
}

/**
 * Publish a captured result as the run's final files, naming the captured blobs
 * a second time instead of writing them again. A publication that cannot be
 * completed never throws over the terminal's own cause: it takes back what this
 * call created, records no work product, and returns the typed refusal.
 */
export async function publishDirectoryCandidate(
  input: DirectoryPublication,
): Promise<CaptureRefusal | null> {
  const created: string[] = [];
  const productPath = join(input.paths.finalDir, "work_product.yaml");
  // Set by the ready event's own write, before its durable sink accepts it.
  const ready = { written: false };
  try {
    await writeDirectoryResult(input, created, ready);
    return null;
  } catch (error) {
    // The ready line reached the run's event file and only the journal after it
    // failed: that file still replays it, so the manifest and the bytes it names
    // stay; the work product alone is taken back. Otherwise every leftover is.
    const readinessWritten = ready.written;
    for (const path of created.reverse())
      if (!readinessWritten || path === productPath)
        await rm(path, { force: true }).catch(() => undefined);
    return directoryPublicationRefusal(fileSpaceFailure(error, "file publication"), {
      artifactRoot: input.files.artifactRoot,
      delivered: input.delivery !== undefined,
      ...(readinessWritten ? { readiness: join(input.paths.root, input.files.manifestPath) } : {}),
    });
  }
}

/**
 * Publish a candidate run's result. A refused publication is recorded on the run
 * as its capture refusal, and a clean success it would have claimed becomes a
 * failed `capture_refused`; a failed, cancelled or blocked terminal keeps its own
 * cause. Answers the facts the run's terminal states.
 */
export async function publishRunDirectoryCandidate(
  run: CandidateRun,
  input: Omit<DirectoryPublication, "files" | "attemptId" | "harnessId">,
): Promise<RunOutcomeFacts> {
  const refusal = await publishDirectoryCandidate({
    ...input,
    files: run.files!,
    attemptId: run.attemptId,
    harnessId: run.harnessId,
  });
  if (!refusal) return input.facts;
  run.captureRefusal = refusal;
  // INV-116: only a CLEAN success fails over a refused publication. A cancelled or
  // failed terminal, and a succeeded one awaiting a decision (review blocked,
  // checks failed, work state vetoing), keep their own cause with the refusal beside.
  const { facts: prior } = input;
  const decided =
    prior.lifecycle === "succeeded" && prior.review !== "blocked" && prior.checks !== "failed";
  if (decided && workStateVetoes(prior)) {
    // The run's own report stays its cause; its written decision stops recommending apply.
    await demoteWrittenDecision(input.store, input.paths, prior, refusal.detail).catch(
      () => undefined,
    );
    return prior;
  }
  if (!decided) return prior;
  const facts = terminalOutcomeFacts(input.facts, "failed", CAPTURE_REFUSED_REASON);
  await demoteWrittenDecision(input.store, input.paths, facts, refusal.detail).catch(
    () => undefined,
  );
  return facts;
}

/** A decision already written for this result must not keep claiming success. */
async function demoteWrittenDecision(
  store: ArtifactStore,
  paths: RunPaths,
  facts: RunOutcomeFacts,
  detail: string,
): Promise<void> {
  const path = join(paths.arbitrationDir, "decision.yaml");
  const current = store.readYaml<{ evidence_facts?: string[] }>(path);
  if (!current) return;
  await store.writeYamlAsync(path, {
    ...current,
    facts,
    apply_recommendation: "inspect",
    evidence_facts: [...(current.evidence_facts ?? []), detail],
  });
}

async function writeDirectoryResult(
  input: DirectoryPublication,
  created: string[],
  ready: { written: boolean },
): Promise<void> {
  const { files, paths, store } = input;
  const published = new Set<string>();
  for (const entry of files.manifest.entries)
    for (const state of [entry.before, entry.after]) {
      if (state === "unknown" || state?.kind !== "file" || !state.artifactPath) continue;
      if (published.has(state.artifactPath)) continue;
      const source = await workspaceFilePath(files.artifactRoot, state.artifactPath);
      const target = await workspaceFilePath(paths.root, state.artifactPath);
      if (await shareImmutableFile(source, target, state, files.contentIndex)) created.push(target);
      published.add(state.artifactPath);
    }
  const text = await readFile(join(files.artifactRoot, files.manifestPath), "utf8");
  if (sha256(text) !== files.manifestSha256)
    throw new Error("Captured directory manifest changed before publication");
  const write = async (path: string, content: string) => {
    const existed = await lstat(path).then(
      () => true,
      () => false,
    );
    await store.writeTextAsync(path, content);
    if (!existed) created.push(path);
  };
  await write(join(paths.root, files.manifestPath), text);
  await write(join(paths.finalDir, "files/preview.txt"), directoryPreview(files));
  const direct = files.manifest.isolation === "live";
  const listing = directoryChangedEntries(files.manifest).map((entry) => {
    const label = entry.path.replace(/[\\\[\]]/g, "\\$&");
    return entry.after?.kind === "file"
      ? `- [${label}](${entry.after.artifactPath}) (${entry.after.sizeBytes} bytes)`
      : `- ${label}${entry.after === null ? " (removed)" : ""}`;
  });
  await write(
    join(paths.finalDir, "files/result.md"),
    `${direct ? (files.changedPaths.length > 0 ? `${files.noChanges === false ? "Files updated" : "Files observed"} in ${files.manifest.executionRoot}.` : files.noChanges === null ? `Operation finished in ${files.manifest.executionRoot}. A complete file comparison was not recorded.` : "No file changes were found in the selected scope.") : "Files captured from a separate copy. Inspect the captured files; application is subject to the run's outcome and a delivery check."}${input.delivery && !input.delivery.applied ? `\n\nAutomatic delivery did not apply: ${deliveryEffectsStatement(input.delivery) ?? "refused"}` : ""}\n\n${listing.join("\n")}\n`,
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
      // An automatic delivery's coverage of this manifest: its writes and the changes
      // it found the target already holding (its receipt keeps only the writes).
      applied_paths: input.delivery
        ? [...input.delivery.appliedPaths, ...filesDeliveryHeldPaths(input.delivery)]
        : direct
          ? files.changedPaths
          : [],
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
  // The commit point: the work product and the ready event come last, and a
  // failure of either (the event not durably landed included) takes the
  // product back with the files it names.
  const productPath = join(paths.finalDir, "work_product.yaml");
  const productExisted = await lstat(productPath).then(
    () => true,
    () => false,
  );
  await store.writeYamlAsync(productPath, product);
  if (!productExisted) created.push(productPath);
  await input.log.emitLanded(
    "output.ready",
    { kind: "artifact", path: files.manifestPath },
    true,
    () => (ready.written = true),
  );
}
