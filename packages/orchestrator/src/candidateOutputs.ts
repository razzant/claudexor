import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
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

/** Why a produced raster was not kept, by size and file shape only (never by
 * what its bytes look like). Recorded beside `produced_files` so a reader sees
 * every image the run linked or wrote but did not save. */
export type ProducedOmissionReason =
  | "over_file_cap"
  | "over_total_cap"
  | "unreadable"
  | "not_regular_file"
  | "symlink"
  | "unsafe_path";

export interface ProducedOmission {
  path: string;
  reason: ProducedOmissionReason;
  /** Size observed before the decision; null when it could not be read. */
  bytes: number | null;
}

type RasterRead =
  | { ok: true; bytes: Buffer; mode: number }
  | { ok: false; reason: ProducedOmissionReason; bytes: number | null };

function rasterBytes(source: string, maxBytes = MAX_OUTPUT_BYTES, totalCapped = false): RasterRead {
  let fd: number | null = null;
  let size: number | null = null;
  const tooLarge = (): RasterRead => ({
    ok: false,
    reason: totalCapped ? "over_total_cap" : "over_file_cap",
    bytes: size,
  });
  try {
    fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    size = stat.size;
    if (!stat.isFile()) return { ok: false, reason: "not_regular_file", bytes: null };
    if (stat.size > maxBytes) return tooLarge();
    const bytes = readFileSync(fd);
    size = bytes.length;
    if (bytes.length > maxBytes) return tooLarge();
    return { ok: true, bytes, mode: stat.mode & 0o777 };
  } catch {
    // An unreadable or raced raster is skipped and disclosed; a filesystem
    // race never turns into an untyped attempt crash.
    return { ok: false, reason: "unreadable", bytes: size };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // The bytes are already bounded in memory or the read failed closed.
      }
    }
  }
}

function copyRaster(
  source: string,
  target: string,
  maxBytes: number,
  totalCapped: boolean,
):
  | { ok: true; bytes: number }
  | { ok: false; reason: ProducedOmissionReason; bytes: number | null } {
  const read = rasterBytes(source, maxBytes, totalCapped);
  if (!read.ok) return read;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeNoFollow(target, read.bytes, read.mode, false);
  return { ok: true, bytes: read.bytes.length };
}

/** The per-file cap, shrunk to what is left of the combined budget. */
function rasterBudget(total: number): { maxBytes: number; totalCapped: boolean } {
  const left = MAX_TOTAL_BYTES - total;
  return { maxBytes: Math.min(MAX_OUTPUT_BYTES, left), totalCapped: left < MAX_OUTPUT_BYTES };
}

type CandidatePathStatus =
  { kind: "safe"; path: string; stat: Stats } | { kind: "missing" | "symlink" | "unsafe" };

/** Lexically contain a path and reject symlinks or unreadable/non-directory
 * intermediate components before any candidate output is inspected. */
function candidatePathStatus(root: string, raw: string): CandidatePathStatus {
  const target = resolve(root, raw);
  if (target === root || !target.startsWith(root + sep)) return { kind: "unsafe" };
  const parts = pathRelative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!);
    let stat: Stats | null;
    try {
      stat = lstatIfPresent(current);
    } catch {
      return { kind: "unsafe" };
    }
    if (!stat) return { kind: "missing" };
    if (stat.isSymbolicLink()) {
      return { kind: index === parts.length - 1 ? "symlink" : "unsafe" };
    }
    if (index < parts.length - 1 && !stat.isDirectory()) return { kind: "unsafe" };
    if (index === parts.length - 1) return { kind: "safe", path: target, stat };
  }
  return { kind: "unsafe" };
}

function artifactMediaPaths(
  root: string,
  artifactRelativeDir: string | null,
): { paths: string[]; unsafe: boolean } {
  if (artifactRelativeDir === null) return { paths: [], unsafe: false };
  const normalized = artifactRelativeDir.split("\\").join("/");
  const prefix = `${CLAUDEXOR_ARTIFACT_DIR}/`;
  const envelopeId = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : "";
  if (!/^[A-Za-z0-9._-]+$/.test(envelopeId) || envelopeId.includes("/")) {
    return { paths: [], unsafe: true };
  }
  const artifactRoot = join(root, artifactRelativeDir);
  const rootStatus = candidatePathStatus(root, artifactRoot);
  if (rootStatus.kind === "missing") return { paths: [], unsafe: false };
  if (rootStatus.kind !== "safe" || !rootStatus.stat.isDirectory()) {
    return { paths: [], unsafe: true };
  }
  const paths: string[] = [];
  let unsafe = false;
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      unsafe = true;
      return;
    }
    for (const name of entries.sort()) {
      const status = candidatePathStatus(root, join(dir, name));
      if (status.kind === "missing") continue;
      // A leaf symlink is never followed or persisted, but its presence beside
      // ordinary owned media does not make the whole candidate suspicious.
      if (status.kind === "symlink") continue;
      if (status.kind !== "safe") {
        unsafe = true;
        continue;
      }
      if (status.stat.isDirectory()) {
        walk(status.path);
        continue;
      }
      if (!RASTER_OUTPUT_EXTENSIONS.has(extname(name).toLowerCase())) continue;
      if (!status.stat.isFile()) {
        unsafe = true;
        continue;
      }
      paths.push(pathRelative(root, status.path).split("\\").join("/"));
    }
  };
  walk(artifactRoot);
  return { paths, unsafe };
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
  candidates: readonly {
    label: string;
    attemptId: string;
    diff: string;
    files?: {
      manifestPath: string;
      manifestSha256: string;
      artifactRoot: string;
      manifest: unknown;
    };
  }[];
}): { prompt: string; content: string } {
  const diffs = input.candidates
    .map((candidate) => {
      const files = candidate.files
        ? `\n\nComplete directory candidate files are retained at ${candidate.files.artifactRoot}; read the manifest at ${candidate.files.manifestPath} (sha256 ${candidate.files.manifestSha256}) and inspect every referenced postimage before editing.\n${JSON.stringify(candidate.files.manifest)}`
        : "";
      return `### ${candidate.label} (${candidate.attemptId})\n${candidate.diff}${files}`;
    })
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
}): { preserved: string[]; omitted: ProducedOmission[] } {
  const root = resolve(input.worktreePath);
  let total = 0;
  const preserved: string[] = [];
  const omitted: ProducedOmission[] = [];
  const omittedPaths = new Set<string>();
  const omit = (path: string, reason: ProducedOmissionReason, bytes: number | null) => {
    if (omittedPaths.has(path)) return;
    omittedPaths.add(path);
    omitted.push({ path, reason, bytes });
  };
  const candidates = new Map<string, { relative: string; source: string }>();

  for (const raw of input.changedPaths) {
    if (!RASTER_OUTPUT_EXTENSIONS.has(extname(raw).toLowerCase())) continue;
    const status = candidatePathStatus(root, raw);
    // A link to a file that does not exist names nothing the run produced.
    if (status.kind === "missing") continue;
    if (status.kind !== "safe") {
      omit(raw, status.kind === "symlink" ? "symlink" : "unsafe_path", null);
      continue;
    }
    const relative = pathRelative(root, status.path).split("\\").join("/");
    if (!status.stat.isFile()) {
      omit(relative, "not_regular_file", null);
      continue;
    }
    let identity: string;
    try {
      // realpath returns the filesystem's canonical spelling, so case and
      // Unicode-normalization aliases on macOS collapse before any O_EXCL
      // destination write. The already-verified lexical path remains the
      // source used by the no-follow copy fence.
      identity = realpathSync.native(status.path);
    } catch {
      omit(relative, "unreadable", null);
      continue;
    }
    if (!candidates.has(identity)) {
      candidates.set(identity, { relative, source: status.path });
    }
  }

  for (const { relative, source } of candidates.values()) {
    const target = join(input.attemptDir, "produced", relative);
    const budget = rasterBudget(total);
    const copied = copyRaster(source, target, budget.maxBytes, budget.totalCapped);
    if (!copied.ok) {
      omit(relative, copied.reason, copied.bytes);
      continue;
    }
    total += copied.bytes;
    preserved.push(relative);
  }
  return { preserved, omitted };
}

/**
 * Collect media the harness saved for the USER into this envelope's
 * marker-bound artifact child (F4). These files are EXCLUDED from the candidate diff
 * (so a screenshot-only run reads as noChanges), so they never appear in the
 * diff's changed paths — this walk is how they reach the Evidence gallery.
 * Returns worktree-relative paths (retaining the `.claudexor-artifacts/`
 * prefix) preserved under the attempt's `produced/` plane. Symlink-safe and
 * byte-bounded exactly like `persistCandidateOutputs`.
 */
export function collectArtifactDirMedia(input: {
  worktreePath: string;
  attemptDir: string;
  artifactRelativeDir: string | null;
}): string[] {
  const root = resolve(input.worktreePath);
  let total = 0;
  const preserved: string[] = [];
  for (const rel of artifactMediaPaths(root, input.artifactRelativeDir).paths) {
    const status = candidatePathStatus(root, rel);
    if (status.kind !== "safe" || !status.stat.isFile()) continue;
    const target = join(input.attemptDir, "produced", rel);
    const budget = rasterBudget(total);
    const copied = copyRaster(status.path, target, budget.maxBytes, budget.totalCapped);
    if (!copied.ok) continue;
    total += copied.bytes;
    preserved.push(rel);
  }
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
  artifactRelativeDir: string | null;
  /** The EXACT candidate diff: diffstat and changed paths are computed on it. */
  diff: string;
  /** False when no candidate patch may be retained (readonly or uncaptured):
   * even an empty patch.diff would falsely imply an inspectable patch exists. */
  persistPatch?: boolean;
  /** False for an uncaptured candidate: no answer-adjacent or artifact-dir
   * media is retained. */
  persistProducedMedia?: boolean;
  answerText?: string;
  record: Record<string, unknown>;
}): { produced: string[]; omitted: ProducedOmission[] } {
  // A capture refusal must not strand the completed answer only in memory or
  // the stream transcript. Persist the exact selected answer per attempt.
  if (input.answerText) {
    input.store.writeText(join(input.attemptDir, "answer.md"), input.answerText);
  }
  const persistPatch = input.persistPatch !== false;
  if (persistPatch) {
    input.store.writePatch(join(input.attemptDir, "patch.diff"), input.diff);
  }
  const stats = summarizeDiffPaths(input.diff);
  // Build one candidate path set before the first filesystem write. A raster
  // may be both linked from markdown and discovered under the owned artifact
  // directory; copying each source in a separate pass would race itself on the
  // O_EXCL destination and would incorrectly grant each pass its own byte cap.
  const { preserved: produced, omitted } =
    input.persistProducedMedia === false
      ? { preserved: [], omitted: [] }
      : persistCandidateOutputs({
          worktreePath: input.worktreePath,
          attemptDir: input.attemptDir,
          changedPaths: [
            ...stats.paths,
            ...rasterLinksInMarkdown(input.answerText ?? ""),
            ...artifactMediaPaths(resolve(input.worktreePath), input.artifactRelativeDir).paths,
          ],
        });
  input.store.writeYaml(join(input.attemptDir, "attempt.yaml"), {
    ...input.record,
    ...(persistPatch
      ? {
          diffstat: {
            files: stats.paths.length,
            additions: stats.additions,
            deletions: stats.deletions,
          },
        }
      : {}),
    produced_files: produced,
    ...(omitted.length ? { produced_omitted: omitted } : {}),
  });
  return { produced, omitted };
}

/** `\n`-prefixed omission line for a summary template; "" when nothing was left out. */
export function producedOmissionDisclosure(
  omitted: readonly ProducedOmission[] | undefined,
): string {
  const line = producedOmissionSummaryLine(omitted);
  return line ? `\n${line}` : "";
}

/** One `summary.md` line naming every produced image that was not saved, with
 * its size and reason; null when nothing was left out. */
export function producedOmissionSummaryLine(
  omitted: readonly ProducedOmission[] | undefined,
): string | null {
  if (!omitted?.length) return null;
  const reasons: Record<ProducedOmissionReason, string> = {
    over_file_cap: `over the ${MAX_OUTPUT_BYTES / 1024 / 1024} MiB per-image cap`,
    over_total_cap: `over the ${MAX_TOTAL_BYTES / 1024 / 1024} MiB combined image budget`,
    unreadable: "unreadable",
    not_regular_file: "not a regular file",
    symlink: "a symbolic link",
    unsafe_path: "outside the workspace or behind a link",
  };
  const named = omitted
    .slice(0, 5)
    .map((o) => `${o.path}: ${reasons[o.reason]}${o.bytes === null ? "" : `, ${o.bytes} bytes`}`);
  if (omitted.length > 5) named.push(`+${omitted.length - 5} more`);
  return `- Images not saved: ${omitted.length} (${named.join("; ")})`;
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
