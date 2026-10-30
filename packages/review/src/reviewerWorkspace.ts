import { parseUnifiedDiff, runCapture, runCaptureRaw } from "@claudexor/core";
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { newId, redactSecrets, sensitiveResourcePolicy, writeJson } from "@claudexor/util";
import type { ReviewerWorkspace } from "./reviewRuntimeTypes.js";

const BLOCKED_REVIEWER_RUNTIME_ROOTS = new Set(
  "auth cache daemon home homes logs runs secrets state tmp workspaces".split(" "),
);

export function selectReviewerWorkspaceBaseDir(
  sourceRoot: string,
  artifactsBaseDir: string,
  sourceEvidenceDir: string,
): string {
  const durableBase = join(artifactsBaseDir, "workspaces");
  if (!isSameOrInside(sourceRoot, durableBase) && !isSameOrInside(sourceEvidenceDir, durableBase)) {
    return durableBase;
  }
  return join(tmpdir(), `claudexor-review-workspaces-${newId("ws")}`);
}

function isTemporaryReviewerWorkspaceBaseDir(baseDir: string): boolean {
  const resolved = resolve(baseDir);
  const rel = relative(tmpdir(), resolved);
  return (
    isSameOrInside(tmpdir(), resolved) &&
    rel.split(sep)[0]?.startsWith("claudexor-review-workspaces-") === true
  );
}

export async function prepareReviewerWorkspace(input: {
  sourceRoot: string;
  sourceEvidenceDir: string;
  workspaceBaseDir: string;
  reviewerDirName: string;
  excludeRoots: string[];
  postimagePaths?: Set<string>;
  candidateCopyPaths: Set<string>;
  preserveEvidenceBytes?: boolean;
}): Promise<ReviewerWorkspace> {
  const sourceRoot = resolve(input.sourceRoot);
  const workspaceBaseDir = resolve(input.workspaceBaseDir);
  const root = join(workspaceBaseDir, input.reviewerDirName);
  if (!existsSync(sourceRoot)) {
    throw new Error(`candidate root does not exist: ${sourceRoot}`);
  }
  if (isSameOrInside(sourceRoot, root)) {
    throw new Error(`reviewer workspace must be outside candidate root: ${root}`);
  }

  try {
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true, mode: 0o700 });
    const excludeRoots = input.excludeRoots.map((p) => resolve(p));
    const resolvedSourceRoot = realpathSync(sourceRoot);
    await cp(sourceRoot, root, {
      recursive: true,
      dereference: false,
      filter: (sourcePath) =>
        shouldCopyReviewerPath(
          sourceRoot,
          resolvedSourceRoot,
          sourcePath,
          excludeRoots,
          input.postimagePaths,
          input.candidateCopyPaths,
        ),
    });

    const sourceEvidenceDir = resolve(input.sourceEvidenceDir);
    const evidenceDir = join(root, ".claudexor-review-evidence");
    if (existsSync(sourceEvidenceDir)) {
      const resolvedSourceEvidenceDir = realpathSync(sourceEvidenceDir);
      const evidenceExcludeRoots = excludeRoots.filter(
        (root) => !isSameOrInside(root, sourceEvidenceDir),
      );
      await rm(evidenceDir, { recursive: true, force: true });
      await cp(
        sourceEvidenceDir,
        evidenceDir,
        input.preserveEvidenceBytes
          ? { recursive: true, dereference: false }
          : {
              recursive: true,
              dereference: false,
              filter: (sourcePath) =>
                shouldCopyReviewerPath(
                  sourceEvidenceDir,
                  resolvedSourceEvidenceDir,
                  sourcePath,
                  evidenceExcludeRoots,
                ),
            },
      );
    }
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });

    await initializeReviewerWorkspaceGit(root);
    return { root, evidenceDir };
  } catch (err) {
    await rm(root, { recursive: true, force: true });
    throw err;
  }
}

export async function copyReviewEvidencePacket(
  sourceEvidenceDir: string,
  persistentEvidenceDir: string,
  preserveBytes = false,
): Promise<void> {
  const source = resolve(sourceEvidenceDir);
  const target = resolve(persistentEvidenceDir);
  await rm(target, { recursive: true, force: true });
  if (!existsSync(source)) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    return;
  }
  if (preserveBytes) {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await cp(source, target, { recursive: true, dereference: false });
    return;
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  const resolvedSource = realpathSync(source);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    if (!shouldCopyEvidencePacketPath(source, resolvedSource, sourcePath, target)) {
      continue;
    }
    await copyReviewEvidenceEntry(
      source,
      resolvedSource,
      sourcePath,
      join(target, entry.name),
      target,
    );
  }
}

async function copyReviewEvidenceEntry(
  sourceEvidenceDir: string,
  resolvedSourceEvidenceDir: string,
  sourcePath: string,
  targetPath: string,
  targetEvidenceDir: string,
): Promise<void> {
  const stat = lstatSync(sourcePath);
  if (stat.isDirectory()) {
    await mkdir(targetPath, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(sourcePath, { withFileTypes: true })) {
      const childSource = join(sourcePath, entry.name);
      if (
        !shouldCopyEvidencePacketPath(
          sourceEvidenceDir,
          resolvedSourceEvidenceDir,
          childSource,
          targetEvidenceDir,
        )
      ) {
        continue;
      }
      await copyReviewEvidenceEntry(
        sourceEvidenceDir,
        resolvedSourceEvidenceDir,
        childSource,
        join(targetPath, entry.name),
        targetEvidenceDir,
      );
    }
    return;
  }
  await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
  await cp(sourcePath, targetPath, { recursive: false, dereference: false });
}

function shouldCopyEvidencePacketPath(
  sourceEvidenceDir: string,
  resolvedSourceEvidenceDir: string,
  sourcePath: string,
  targetEvidenceDir: string,
): boolean {
  const resolvedSourcePath = resolve(sourcePath);
  if (isSameOrInside(resolvedSourcePath, targetEvidenceDir)) return false;
  if (isSameOrInside(targetEvidenceDir, resolvedSourcePath)) return false;
  return shouldCopyReviewerPath(sourceEvidenceDir, resolvedSourceEvidenceDir, resolvedSourcePath, [
    targetEvidenceDir,
  ]);
}

export async function cleanupTemporaryReviewerWorkspaceBaseDir(
  workspaceBaseDir: string,
  artifactsBaseDir: string,
): Promise<void> {
  if (!isTemporaryReviewerWorkspaceBaseDir(workspaceBaseDir)) return;
  try {
    await rm(workspaceBaseDir, { recursive: true, force: true });
  } catch (err) {
    try {
      writeJson(join(artifactsBaseDir, "reviewer-workspace-base-cleanup-error.json"), {
        reviewer_workspace_base_cleanup: "failed",
        workspace_base_dir: workspaceBaseDir,
        error: redactSecrets(err instanceof Error ? err.message : String(err)),
      });
    } catch {
      // Do not let cleanup telemetry hide the review result or the original error.
    }
  }
}

function shouldCopyReviewerPath(
  sourceRoot: string,
  resolvedSourceRoot: string,
  sourcePath: string,
  excludeRoots: string[],
  postimagePaths = new Set<string>(),
  candidateCopyPaths?: Set<string>,
): boolean {
  const resolvedSourcePath = resolve(sourcePath);
  const rel = relative(sourceRoot, resolvedSourcePath);
  if (rel && candidateCopyPaths) {
    const normalized = normalizeReviewerRelativePath(rel);
    if (!normalized || !candidateCopyPaths.has(normalized)) return false;
  }
  if (
    !isCopyableReviewerSymlink(sourceRoot, resolvedSourceRoot, resolvedSourcePath, excludeRoots)
  ) {
    return false;
  }
  if (excludeRoots.some((root) => isSameOrInside(root, resolvedSourcePath))) return false;
  if (!rel) return true;
  const normalizedRel = normalizeReviewerRelativePath(rel);
  if (!normalizedRel) return false;
  const parts = normalizedRel.split("/");
  if (parts[0] === ".claudexor") return isCopyableReviewerClaudexorPath(rel, parts, postimagePaths);
  if (
    parts.some((part) => [".git", ".adversarial-review", ".turbo", "node_modules"].includes(part))
  ) {
    return false;
  }
  if (
    parts.some((part) => [".next", ".cache", "coverage", "dist"].includes(part)) &&
    !isReviewerPostimagePath(rel, postimagePaths)
  ) {
    return false;
  }
  return !rel.endsWith(".tsbuildinfo");
}

function isCopyableReviewerClaudexorPath(
  rel: string,
  parts: string[],
  postimagePaths: Set<string>,
): boolean {
  if (parts.length === 1) {
    return true;
  }
  if (parts.length === 2 && parts[1] === "config.yaml") {
    return true;
  }
  const runtimeRoot = parts[1]?.toLowerCase();
  if (runtimeRoot && BLOCKED_REVIEWER_RUNTIME_ROOTS.has(runtimeRoot)) return false;
  return isReviewerPostimagePath(rel, postimagePaths);
}

function isReviewerPostimagePath(rel: string, postimagePaths: Set<string>): boolean {
  const normalized = normalizeReviewerRelativePath(rel);
  if (!normalized) return false;
  if (postimagePaths.has(normalized)) return true;
  const prefix = `${normalized}/`;
  for (const postimage of postimagePaths) {
    if (postimage.startsWith(prefix)) return true;
  }
  return false;
}

export function extractDiffPostimagePaths(diff: string): Set<string> {
  const paths = new Set<string>();
  for (const file of parseUnifiedDiff(diff).files) {
    // Reviewer workspaces represent the candidate postimage. Old rename and
    // deletion paths live in DIFF.patch; re-reading them from the live source
    // could pick up an unrelated ignored file recreated at the retired path.
    if (!file.deleted && file.newPath) addReviewerPreservePath(paths, file.newPath);
  }
  return paths;
}

function addReviewerPreservePath(paths: Set<string>, value: string): void {
  const normalized = normalizeReviewerRelativePath(value);
  if (normalized) paths.add(normalized);
}

function normalizeReviewerRelativePath(value: string): string | null {
  if (!value || value === "/dev/null" || isAbsolute(value)) return null;
  const platformPath = normalize(value);
  // Git paths are slash-delimited, but on POSIX a backslash is a literal file
  // name byte. Convert it only where the host path implementation treats it as
  // a separator; otherwise `safe\\file` must not authorize `safe/file`.
  const normalized = sep === "\\" ? platformPath.replace(/\\/g, "/") : platformPath;
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    return null;
  }
  return normalized;
}

interface ReviewerCandidateInventory {
  mode: "git_visible" | "diff_only" | "explicit_manifest";
  reason: string | null;
  copyPaths: Set<string>;
}

export async function buildReviewerCandidateInventory(
  sourceRoot: string,
  postimagePaths: Set<string>,
  requireGit: boolean,
  candidatePaths?: string[],
): Promise<ReviewerCandidateInventory> {
  if (candidatePaths)
    return {
      mode: "explicit_manifest",
      reason: null,
      copyPaths: reviewerCopyPathClosure(candidatePaths),
    };
  const result = await runCaptureRaw(
    "git",
    ["-C", sourceRoot, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--"],
    { env: reviewerGitEnv(), timeoutMs: 30_000, windowsConsole: "none" },
  );
  if (result.code !== 0) {
    const detail = redactSecrets(
      (result.stderr || result.stdout || `exit ${String(result.code)}`).trim(),
    );
    if (requireGit) {
      throw new Error(`failed to inventory frozen reviewer candidate: ${detail}`);
    }
    return {
      mode: "diff_only",
      reason: detail || "Git inventory unavailable",
      copyPaths: reviewerCopyPathClosure(postimagePaths),
    };
  }

  const visiblePaths = result.stdout.split("\0").filter(Boolean);
  return {
    mode: "git_visible",
    reason: null,
    copyPaths: reviewerCopyPathClosure([...visiblePaths, ...postimagePaths]),
  };
}

function reviewerCopyPathClosure(paths: Iterable<string>): Set<string> {
  const closure = new Set<string>();
  for (const value of paths) {
    const normalized = normalizeReviewerRelativePath(value);
    if (!normalized) continue;
    const parts = normalized.split("/");
    for (let length = 1; length <= parts.length; length += 1) {
      closure.add(parts.slice(0, length).join("/"));
    }
  }
  return closure;
}

function isCopyableReviewerSymlink(
  sourceRoot: string,
  resolvedSourceRoot: string,
  sourcePath: string,
  excludeRoots: string[],
): boolean {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(sourcePath);
  } catch {
    return false;
  }
  if (!stat.isSymbolicLink()) return true;
  let linkTarget = "";
  let resolvedTarget = "";
  let targetKind: "directory" | "file" | "other" = "other";
  try {
    linkTarget = readlinkSync(sourcePath);
    resolvedTarget = realpathSync(sourcePath);
    const targetStat = statSync(sourcePath);
    targetKind = targetStat.isDirectory() ? "directory" : targetStat.isFile() ? "file" : "other";
  } catch {
    return false;
  }
  return sensitiveResourcePolicy.assessSymlink({
    sourceRoot,
    canonicalSourceRoot: resolvedSourceRoot,
    sourcePath,
    linkTarget,
    resolvedTargetPath: resolvedTarget,
    targetKind,
    allowedTargetKinds: ["file", "directory"],
    excludedRoots: excludeRoots,
    relocationRoot: sourceRoot,
  }).allowed;
}

async function initializeReviewerWorkspaceGit(root: string): Promise<void> {
  const noHooks = ["-c", "core.hooksPath=/dev/null"];
  await runGitOrThrow("init", root, ["-c", "init.templateDir=", ...noHooks, "init"]);
  for (const [key, value] of [
    ["user.email", "claudexor-review@example.invalid"],
    ["user.name", "Claudexor Review"],
  ]) {
    await runGitOrThrow(`config ${key}`, root, [...noHooks, "config", key, value]);
  }
  await runGitOrThrow("add", root, [...noHooks, "add", "-A", "--force"]);
  await runGitOrThrow("commit", root, [
    ...noHooks,
    "commit",
    "--allow-empty",
    "--no-verify",
    "--no-gpg-sign",
    "-m",
    "review baseline",
  ]);
}

async function runGitOrThrow(label: string, cwd: string, args: string[]): Promise<void> {
  const result = await runCapture("git", args, {
    cwd,
    env: reviewerGitEnv(),
    timeoutMs: 60_000,
    windowsConsole: "none",
  });
  if (result.code === 0) return;
  const detail = redactSecrets((result.stderr || result.stdout || `exit ${result.code}`).trim());
  throw new Error(`failed to prepare reviewer workspace (${label}): ${detail}`);
}

function reviewerGitEnv(): Record<string, string | null> {
  const gitEnv: Record<string, string | null> = Object.fromEntries(
    Object.keys(process.env)
      .filter((key) => key.startsWith("GIT_"))
      .map((key) => [key, null]),
  );
  gitEnv.GIT_CONFIG_NOSYSTEM = "1";
  return gitEnv;
}

export function isSameOrInside(parent: string, target: string): boolean {
  const rel = relative(resolve(parent), resolve(target));
  return rel === "" || (!!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
