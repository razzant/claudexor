import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { dirname, extname, join, relative as pathRelative, resolve, sep } from "node:path";
import type { ArtifactStore } from "@claudexor/artifact-store";
import { CLAUDEXOR_ARTIFACT_DIR, summarizeDiffPaths } from "@claudexor/core";

const RASTER_OUTPUT_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function writeNoFollow(path: string, data: string | Buffer, mode: number, replace: boolean): void {
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_NOFOLLOW |
    (replace ? constants.O_TRUNC : constants.O_EXCL);
  const fd = openSync(path, flags, mode);
  try {
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/** Stage large synthesis evidence in the envelope, returning an idempotent
 * cleanup that callers run before any diff/gate/review. */
export function stageFileBackedContext(worktreePath: string, content?: string): () => void {
  if (content === undefined) return () => {};
  const path = join(worktreePath, ".claudexor-synthesis-input.md");
  let original: { bytes: Buffer; mode: number } | null = null;
  const existing = lstatIfPresent(path);
  if (existing) {
    const stat = existing;
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("synthesis input path already exists and is not a regular file");
    }
    original = { bytes: readFileSync(path), mode: stat.mode & 0o777 };
  }
  writeNoFollow(path, content, 0o600, existing !== null);
  return () => {
    rmSync(path, { recursive: true, force: true });
    if (original) {
      writeNoFollow(path, original.bytes, original.mode, false);
      chmodSync(path, original.mode);
    }
  };
}

export function buildFileBackedSynthesisInput(input: {
  instructions: string;
  findings: readonly string[];
  candidates: readonly { label: string; attemptId: string; diff: string }[];
}): { prompt: string; content: string } {
  const diffs = input.candidates
    .map((candidate) => `### ${candidate.label} (${candidate.attemptId})\n${candidate.diff}`)
    .join("\n\n");
  return {
    prompt:
      `${input.instructions}\n\n` +
      "Read `.claudexor-synthesis-input.md` completely before editing. " +
      "It contains the findings and candidate diffs. Do not modify that temporary file.",
    content:
      `# Findings to fix\n\n${input.findings.map((finding) => `- ${finding}`).join("\n") || "(none)"}` +
      `\n\n# Candidate diffs\n\n${diffs}`,
  };
}

/**
 * Preserve candidate-generated raster outputs before its disposable envelope
 * is removed. Text/source truth remains in patch.diff; this is specifically
 * the produced-output plane needed by chat markdown screenshots.
 */
export function persistCandidateOutputs(input: {
  worktreePath: string;
  attemptDir: string;
  changedPaths: readonly string[];
}): string[] {
  const root = resolve(input.worktreePath);
  let total = 0;
  const preserved: string[] = [];

  for (const raw of input.changedPaths) {
    const relative = raw.split("\\").join("/");
    if (!RASTER_OUTPUT_EXTENSIONS.has(extname(relative).toLowerCase())) continue;
    const source = resolve(root, relative);
    if (source !== root && !source.startsWith(root + sep)) continue;
    if (!existsSync(source)) continue;
    // lstat (not stat): a candidate-created symlink must never make output
    // preservation copy a host file outside the envelope.
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.size > MAX_OUTPUT_BYTES || total + stat.size > MAX_TOTAL_BYTES)
      continue;
    const target = join(input.attemptDir, "produced", relative);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(source, target);
    total += stat.size;
    preserved.push(relative);
  }
  return preserved;
}

/**
 * Collect media the harness saved for the USER into the claudexor-owned
 * artifact dir (F4). These files are EXCLUDED from the candidate diff
 * (so a screenshot-only run reads as noChanges), so they never appear in the
 * diff's changed paths — this walk is how they reach the Evidence gallery.
 * Returns worktree-relative paths (retaining the `.claudexor-artifacts/`
 * prefix) preserved under the attempt's `produced/` plane. Symlink-safe and
 * byte-bounded exactly like `persistCandidateOutputs`.
 */
export function collectArtifactDirMedia(input: {
  worktreePath: string;
  attemptDir: string;
}): string[] {
  const root = resolve(input.worktreePath);
  const artifactRoot = join(root, CLAUDEXOR_ARTIFACT_DIR);
  if (!existsSync(artifactRoot)) return [];
  let total = 0;
  const preserved: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const abs = join(dir, name);
      const stat = lstatIfPresent(abs);
      // lstat: a symlink inside the artifact dir must never copy a host file.
      if (!stat || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!stat.isFile()) continue;
      if (!RASTER_OUTPUT_EXTENSIONS.has(extname(name).toLowerCase())) continue;
      if (stat.size > MAX_OUTPUT_BYTES || total + stat.size > MAX_TOTAL_BYTES) continue;
      const rel = pathRelative(root, abs).split("\\").join("/");
      const target = join(input.attemptDir, "produced", rel);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(abs, target);
      total += stat.size;
      preserved.push(rel);
    }
  };
  walk(artifactRoot);
  return preserved;
}

export function rasterLinksInMarkdown(markdown: string): string[] {
  const paths: string[] = [];
  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const raw = match[1];
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("#")) continue;
    try {
      paths.push(decodeURIComponent(raw).replace(/^\.\//, ""));
    } catch {
      // Invalid URL escapes are not a usable file target.
    }
  }
  return [...new Set(paths)];
}

export function writeCandidateAttemptArtifacts(input: {
  store: ArtifactStore;
  attemptDir: string;
  worktreePath: string;
  diff: string;
  answerText?: string;
  record: Record<string, unknown>;
}): string[] {
  input.store.writeText(join(input.attemptDir, "patch.diff"), input.diff);
  const stats = summarizeDiffPaths(input.diff);
  const produced = [
    ...new Set([
      ...persistCandidateOutputs({
        worktreePath: input.worktreePath,
        attemptDir: input.attemptDir,
        changedPaths: [
          ...new Set([...stats.paths, ...rasterLinksInMarkdown(input.answerText ?? "")]),
        ],
      }),
      // F4: media in the claudexor-owned artifact dir is excluded from the diff,
      // so it is never in `stats.paths` — collect it into the gallery here.
      ...collectArtifactDirMedia({
        worktreePath: input.worktreePath,
        attemptDir: input.attemptDir,
      }),
    ]),
  ];
  input.store.writeYaml(join(input.attemptDir, "attempt.yaml"), {
    ...input.record,
    diffstat: {
      files: stats.paths.length,
      additions: stats.additions,
      deletions: stats.deletions,
    },
    produced_files: produced,
  });
  return produced;
}

/** Copy preserved winner outputs into the run root so relative markdown links
 * resolve under the UI's runDir scope after the envelope is gone. */
export function materializeWinnerOutputs(input: {
  attemptDir: string;
  runRoot: string;
  paths: readonly string[];
}): string[] {
  const copied: string[] = [];
  for (const relative of input.paths) {
    const source = join(input.attemptDir, "produced", relative);
    if (!existsSync(source)) continue;
    const target = join(input.runRoot, relative);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(source, target);
    copied.push(relative);
  }
  return copied;
}
