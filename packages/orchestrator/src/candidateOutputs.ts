import { copyFileSync, existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import type { ArtifactStore } from "@claudexor/artifact-store";
import { summarizeDiffPaths } from "@claudexor/core";

const RASTER_OUTPUT_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/** Stage large synthesis evidence in the envelope, returning an idempotent
 * cleanup that callers run before any diff/gate/review. */
export function stageFileBackedContext(worktreePath: string, content?: string): () => void {
  if (content === undefined) return () => {};
  const path = join(worktreePath, ".claudexor-synthesis-input.md");
  writeFileSync(path, content, { mode: 0o600 });
  return () => rmSync(path, { force: true });
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

export function writeCandidateAttemptArtifacts(input: {
  store: ArtifactStore;
  attemptDir: string;
  worktreePath: string;
  diff: string;
  record: Record<string, unknown>;
}): string[] {
  input.store.writeText(join(input.attemptDir, "patch.diff"), input.diff);
  const stats = summarizeDiffPaths(input.diff);
  const produced = persistCandidateOutputs({
    worktreePath: input.worktreePath,
    attemptDir: input.attemptDir,
    changedPaths: stats.paths,
  });
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
