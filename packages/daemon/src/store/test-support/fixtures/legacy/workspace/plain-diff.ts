import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { parseUnifiedDiff } from "../core/index.js";
import { containsSecretLikeToken } from "../util/index.js";

const MAX_BINARY_SECRET_SCAN_BYTES = 32 * 1024 * 1024;

/** Legacy live convergence capture only. Explicit directory workspaces use a selected footprint. */
export function snapshotLegacyDirectoryBaseline(repoRoot: string, base: string): void {
  const baseline = join(base, "baseline");
  const skip = new Set([".git", "node_modules", "__pycache__", ".venv", "venv"]);
  try {
    mkdirSync(baseline, { recursive: true });
    for (const entry of readdirSync(repoRoot)) {
      if (!skip.has(entry))
        cpSync(join(repoRoot, entry), join(baseline, entry), { recursive: true });
    }
  } catch {
    /* Existing captureDiff reports unavailable legacy capture. */
  }
}

/** Rewrite only structural GNU/BSD `diff -ruN` headers to git-style paths.
 * Missing-side headers become `/dev/null`, making added/deleted files exactly
 * reversible with `git apply --no-index`; hunk content is never rewritten. */
export function relativizePlainDiffHeaders(
  text: string,
  baselineRoot: string,
  liveRoot: string,
): string {
  const base = baselineRoot.endsWith("/") ? baselineRoot : `${baselineRoot}/`;
  const live = liveRoot.endsWith("/") ? liveRoot : `${liveRoot}/`;
  const swap = (line: string): string => line.split(base).join("a/").split(live).join("b/");
  const lines = text.split("\n");
  const headerWitness = (line: string | undefined): boolean =>
    line !== undefined && (line.includes("\t") || line.slice(4).trim() === "/dev/null");
  const isFileHeaderTriple = (index: number, midHunk: boolean): boolean => {
    const triple =
      (lines[index]?.startsWith("--- ") ?? false) &&
      (lines[index + 1]?.startsWith("+++ ") ?? false) &&
      (lines[index + 2]?.startsWith("@@") ?? false);
    if (!triple) return false;
    return midHunk ? headerWitness(lines[index]) && headerWitness(lines[index + 1]) : true;
  };
  const canonicalHeader = (line: string): string => {
    const path = line.slice(4).split("\t", 1)[0] as string;
    return path !== "/dev/null" && !existsSync(path) ? `${line.slice(0, 4)}/dev/null` : swap(line);
  };
  let inHunk = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.startsWith("diff ")) {
      inHunk = false;
      lines[index] = swap(line);
      continue;
    }
    if (isFileHeaderTriple(index, inHunk)) {
      lines[index] = canonicalHeader(line);
      lines[index + 1] = canonicalHeader(lines[index + 1] as string);
      inHunk = false;
      index += 1;
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    // A bare `Binary files … differ` record is structural wherever it stands:
    // hunk content always carries a ' '/'+'/'-' prefix, so it cannot forge
    // this line. GNU diff 3.8 emits it right after the previous file's hunks
    // with no `diff …` command echo in between (#252), so the previous hunk
    // must not hide it from relativization — an unrelativized absolute path
    // would escape the exact-prefix exclusion and repo-relative policy globs.
    if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
      lines[index] = swap(line);
      inHunk = false;
    }
  }
  return lines.join("\n");
}

/** Remove only GNU/BSD diff file-blocks below one exact repo-relative prefix.
 * `diff -x <basename>` is deliberately insufficient: its pattern matches at
 * every depth and would hide unrelated user files that happen to share an
 * engine-generated envelope basename. Ambiguous/unparsed blocks stay captured. */
export function excludePlainDiffPathPrefix(text: string, relativeDir: string): string {
  const normalized = relativeDir.split("\\").join("/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return text;
  }
  const ownedPrefix = `${normalized}/`;
  const pathsAreOwned = (paths: string[]): boolean =>
    paths.length > 0 && paths.every((path) => path === normalized || path.startsWith(ownedPrefix));
  // GNU may emit a bare `Binary files … differ` record with no `diff …`
  // delimiter. Treat both structural forms as file-record boundaries so an
  // owned text record cannot absorb a following unrelated binary record (or
  // vice versa). Hunk content cannot match: it always has a ' '/'+'/'-' prefix.
  const starts = [...text.matchAll(/^(?:diff .+|Binary files .+ differ)$/gm)]
    .map((match) => match.index)
    .filter((index): index is number => index !== undefined);
  if (starts.length === 0) return text;
  let filtered = text.slice(0, starts[0]);
  for (let index = 0; index < starts.length; index += 1) {
    const block = text.slice(starts[index], starts[index + 1] ?? text.length);
    const paths = parseUnifiedDiff(block)
      .files.flatMap((file) => [file.oldPath, file.newPath])
      .filter(Boolean) as string[];
    if (!pathsAreOwned(paths)) filtered += block;
  }
  return filtered;
}

/** `diff -ruN` carries no binary payload, so inspect each live binary
 * postimage directly and name the ones a persisted copy must disclose.
 * Oversized, non-regular, or unreadable bytes are unprovable and are named too. */
export function plainDiffFlaggedBinaries(text: string, liveRoot: string): string[] {
  const root = resolve(liveRoot);
  const flagged: string[] = [];
  for (const file of parseUnifiedDiff(text).files) {
    if (!file.binaryStub || file.deleted || !file.newPath) continue;
    const source = resolve(root, file.newPath);
    if (source !== root && !source.startsWith(root + sep)) {
      flagged.push(file.newPath);
      continue;
    }
    let fd: number;
    try {
      fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") flagged.push(file.newPath);
      continue;
    }
    try {
      const stat = fstatSync(fd);
      const bytes =
        stat.isFile() && stat.size <= MAX_BINARY_SECRET_SCAN_BYTES ? readFileSync(fd) : null;
      if (
        bytes === null ||
        bytes.length > MAX_BINARY_SECRET_SCAN_BYTES ||
        containsSecretLikeToken(bytes.toString("latin1"))
      )
        flagged.push(file.newPath);
    } catch {
      flagged.push(file.newPath);
    } finally {
      closeSync(fd);
    }
  }
  return flagged;
}
