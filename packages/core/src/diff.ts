/**
 * The ONE quote-aware unified-diff header parser (T3.2#2). Three divergent
 * parsers used to read patches: a regex in the orchestrator's diffStats that
 * missed git-quoted headers (non-ASCII/spaces → protected-path and
 * NEEDS_HUMAN gates silently skipped those files), a line-scan in the
 * delivery gate that read `--- `-prefixed CONTENT lines as paths (SQL
 * comments → false apply refusals), and a header tokenizer in
 * context/evidence that never decoded octal escapes. All three rebase here.
 *
 * Structural rules, not regex governance: file metadata (`---`/`+++`,
 * `rename from/to`, `new/deleted file mode`, binary markers) is honored only
 * in HEADER position — between a `diff --git` line and that file's first
 * `@@` hunk — so patch CONTENT can never masquerade as structure.
 */

export interface DiffFileEntry {
  /** Pre-image path (null when the file is newly added). */
  oldPath: string | null;
  /** Post-image path (null when the file is deleted). */
  newPath: string | null;
  added: boolean;
  deleted: boolean;
  renamed: boolean;
  /** Binary change (GIT binary patch payload or a bare "Binary files" stub). */
  binary: boolean;
  /** True when the binary change carries NO applyable payload (stub). */
  binaryStub: boolean;
}

export interface UnifiedDiffSummary {
  files: DiffFileEntry[];
  additions: number;
  deletions: number;
  hunks: number;
}

/**
 * Decode one git C-quoted path token: strips surrounding quotes and decodes
 * `\ooo` octal byte escapes plus the standard single-char escapes, yielding
 * the real on-disk path (utf8).
 */
export function cUnquoteGitPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"') || trimmed.length < 2) return trimmed;
  const inner = trimmed.slice(1, -1);
  const bytes: number[] = [];
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i] as string;
    if (ch !== "\\") {
      const encoded = Buffer.from(ch, "utf8");
      for (const b of encoded) bytes.push(b);
      i += 1;
      continue;
    }
    const next = inner[i + 1] ?? "";
    if (/[0-7]/.test(next)) {
      let oct = "";
      let j = i + 1;
      while (j < inner.length && oct.length < 3 && /[0-7]/.test(inner[j] as string)) {
        oct += inner[j];
        j += 1;
      }
      bytes.push(parseInt(oct, 8));
      i = j;
      continue;
    }
    const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", a: "\x07", b: "\b", f: "\f", v: "\v" };
    bytes.push(...Buffer.from(simple[next] ?? next, "utf8"));
    i += 2;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Split a `diff --git a/x b/x` remainder into its two path tokens (quote-aware). */
function splitHeaderPaths(rest: string): [string, string] | null {
  const tokens: string[] = [];
  let i = 0;
  while (i < rest.length && tokens.length < 2) {
    while (rest[i] === " ") i += 1;
    if (i >= rest.length) break;
    if (rest[i] === '"') {
      let j = i + 1;
      while (j < rest.length) {
        if (rest[j] === "\\") {
          j += 2;
          continue;
        }
        if (rest[j] === '"') break;
        j += 1;
      }
      tokens.push(cUnquoteGitPath(rest.slice(i, j + 1)));
      i = j + 1;
    } else if (tokens.length === 0) {
      // Unquoted a-path: paths may CONTAIN spaces without quoting when git
      // can still tokenize them; the reliable boundary is the ` b/` splitter.
      const bIdx = rest.indexOf(" b/", i);
      if (bIdx < 0) {
        const start = i;
        while (i < rest.length && rest[i] !== " ") i += 1;
        tokens.push(rest.slice(start, i));
      } else {
        tokens.push(rest.slice(i, bIdx));
        i = bIdx + 1;
      }
    } else {
      tokens.push(rest.slice(i).trim());
      i = rest.length;
    }
  }
  const [a, b] = tokens;
  return a && b ? [a, b] : null;
}

const stripPrefix = (value: string, prefix: string): string =>
  value.startsWith(prefix) ? value.slice(prefix.length) : value;

export function parseUnifiedDiff(diff: string): UnifiedDiffSummary {
  const files: DiffFileEntry[] = [];
  let current: DiffFileEntry | null = null;
  let inHunk = false;
  let sawGitPayload = false;
  let sawBinaryStub = false;
  let additions = 0;
  let deletions = 0;
  let hunks = 0;

  const flush = (): void => {
    if (!current) return;
    if (current.binary) current.binaryStub = sawBinaryStub && !sawGitPayload;
    files.push(current);
    current = null;
    sawGitPayload = false;
    sawBinaryStub = false;
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      inHunk = false;
      const paths = splitHeaderPaths(line.slice("diff --git ".length));
      current = {
        oldPath: paths ? stripPrefix(paths[0], "a/") : null,
        newPath: paths ? stripPrefix(paths[1], "b/") : null,
        added: false,
        deleted: false,
        renamed: false,
        binary: false,
        binaryStub: false,
      };
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      hunks += 1;
      continue;
    }
    if (current && !inHunk) {
      // HEADER position only: content lines can never reach these branches.
      if (line.startsWith("new file mode ")) current.added = true;
      else if (line.startsWith("deleted file mode ")) current.deleted = true;
      else if (line.startsWith("rename from ")) {
        current.renamed = true;
        current.oldPath = cUnquoteGitPath(line.slice("rename from ".length));
      } else if (line.startsWith("rename to ")) {
        current.renamed = true;
        current.newPath = cUnquoteGitPath(line.slice("rename to ".length));
      } else if (line.startsWith("--- ")) {
        const raw = cUnquoteGitPath(line.slice(4));
        if (raw === "/dev/null") {
          current.added = true;
          current.oldPath = null;
        } else {
          current.oldPath = stripPrefix(raw, "a/");
        }
      } else if (line.startsWith("+++ ")) {
        const raw = cUnquoteGitPath(line.slice(4));
        if (raw === "/dev/null") {
          current.deleted = true;
          current.newPath = null;
        } else {
          current.newPath = stripPrefix(raw, "b/");
        }
      } else if (line.startsWith("GIT binary patch")) {
        current.binary = true;
        sawGitPayload = true;
      } else if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
        current.binary = true;
        sawBinaryStub = true;
      }
      continue;
    }
    if (inHunk) {
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
  }
  flush();
  return { files, additions, deletions, hunks };
}

export interface DiffPathSummary {
  paths: string[];
  addedPaths: string[];
  modifiedPaths: string[];
  existingPaths: string[];
  additions: number;
  deletions: number;
}

/**
 * Path-oriented projection of a unified diff for policy/risk gating and
 * diffstat honesty: which files the patch touches, which are NEW vs
 * pre-existing, and the +/- counts. Quote-aware via parseUnifiedDiff — a
 * git-quoted header (non-ASCII, spaces) must never silently DROP a file
 * from protected-path/NEEDS_HUMAN classification.
 */
export function summarizeDiffPaths(diff: string): DiffPathSummary {
  const parsed = parseUnifiedDiff(diff);
  const paths: string[] = [];
  const addedPaths: string[] = [];
  const modifiedPaths: string[] = [];
  const existingPaths: string[] = [];
  for (const f of parsed.files) {
    const path = f.newPath ?? f.oldPath;
    if (!path) continue;
    paths.push(path);
    if (f.added) {
      addedPaths.push(path);
    } else {
      modifiedPaths.push(path);
      if (f.oldPath) existingPaths.push(f.oldPath);
      existingPaths.push(path);
    }
  }
  return {
    paths,
    addedPaths,
    modifiedPaths,
    existingPaths: [...new Set(existingPaths)],
    additions: parsed.additions,
    deletions: parsed.deletions,
  };
}
