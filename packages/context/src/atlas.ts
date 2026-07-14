import {
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { extname, join, relative } from "node:path";
import type { ContextFileRef, OmissionEntry, ScopeAtlasEntry } from "@claudexor/schema";
import { runCapture } from "@claudexor/core";
import { sensitiveResourcePolicy, sha256, type SymlinkTargetKind } from "@claudexor/util";
import { matchAny } from "./glob.js";

const MANIFEST_ONLY = [
  "**/pnpm-lock.yaml",
  "pnpm-lock.yaml",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/Cargo.lock",
  "**/poetry.lock",
  "**/go.sum",
];
const VENDORED = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/vendor/**",
  "**/.turbo/**",
  "**/coverage/**",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
];
const BINARY_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".tgz",
  ".zst",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp4",
  ".mov",
  ".mp3",
  ".wav",
  ".bin",
  ".so",
  ".dylib",
  ".dll",
  ".node",
  ".class",
  ".jar",
  ".wasm",
  ".o",
  ".a",
]);

export interface AtlasOptions {
  include?: string[];
  exclude?: string[];
  mandatory?: string[];
  maxFileBytes?: number;
  tokenLimit?: number;
}

export interface AtlasResult {
  atlas: ScopeAtlasEntry[];
  mandatory: ContextFileRef[];
  included: ContextFileRef[];
  omitted: OmissionEntry[];
  estimatedTokens: number;
  tokenLimit: number;
  missingMandatory: string[];
}

async function listFiles(repoRoot: string): Promise<string[]> {
  try {
    const r = await runCapture(
      "git",
      ["-C", repoRoot, "ls-files", "--cached", "--others", "--exclude-standard"],
      { timeoutMs: 30_000 },
    );
    if (r.code === 0) {
      const files = r.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (files.length > 0) return files;
    }
  } catch {
    /* not a git repo or git missing — fall back to walk */
  }
  return walk(repoRoot, repoRoot);
}

function walk(root: string, dir: string, seenDirs: Set<string> = new Set()): string[] {
  const skip = new Set([".git", "node_modules", "dist", ".turbo", ".claudexor", "coverage"]);
  const out: string[] = [];
  // Symlink cycle guard: `ln -s . loop` used to recurse until stack
  // overflow, and a symlink to / walked the filesystem into the ContextPack.
  // Directory SYMLINKS are skipped entirely (the fallback walker only maps
  // the real tree); real dirs are deduped by their resolved identity.
  let realDir: string;
  try {
    realDir = realpathSync(dir);
  } catch {
    return out;
  }
  if (seenDirs.has(realDir)) return out;
  seenDirs.add(realDir);
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const full = join(dir, name);
    let l;
    try {
      l = lstatSync(full);
    } catch {
      continue;
    }
    if (l.isSymbolicLink()) {
      // A symlinked DIR is skipped (cycle or out-of-tree). A symlinked FILE
      // maps ONLY when its resolved target stays INSIDE the mapped tree —
      // `ln -s ~/.ssh/id_rsa leak.txt` must never pull host files into the
      // ContextPack (context collection is scoped to the target tree).
      let resolved: string;
      let rootReal: string;
      let linkTarget: string;
      try {
        rootReal = realpathSync(root);
        resolved = realpathSync(full);
        linkTarget = readlinkSync(full);
      } catch {
        continue;
      }
      let s: ReturnType<typeof statSync>;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      const targetKind = statKind(s);
      const decision = sensitiveResourcePolicy.assessSymlink({
        sourceRoot: root,
        canonicalSourceRoot: rootReal,
        sourcePath: full,
        linkTarget,
        resolvedTargetPath: resolved,
        targetKind,
        allowedTargetKinds: ["file"],
      });
      if (!decision.allowed) continue;
      out.push(relative(root, full));
      continue;
    }
    if (l.isDirectory()) out.push(...walk(root, full, seenDirs));
    else out.push(relative(root, full));
  }
  return out;
}

/** estimate tokens from byte/char length (~4 chars/token). */
function estTokens(n: number): number {
  return Math.ceil(n / 4);
}

/**
 * Account for EVERY tracked path with a disposition (no silent truncation).
 * Source files are inlined ("full") until the token budget is reached; the rest
 * are recorded as omitted with a reason, plus an explicit OMISSIONS list.
 */
export async function buildScopeAtlas(
  repoRoot: string,
  opts: AtlasOptions = {},
): Promise<AtlasResult> {
  const exclude = opts.exclude ?? [];
  const include = opts.include ?? [];
  const mandatorySet = new Set(opts.mandatory ?? []);
  const maxFileBytes = opts.maxFileBytes ?? 256 * 1024;
  const tokenLimit = opts.tokenLimit ?? 200_000;

  const files = new Set(await listFiles(repoRoot));
  const atlas: ScopeAtlasEntry[] = [];
  const candidates: { rel: string; bytes: number; mandatory: boolean }[] = [];
  const missingMandatory: string[] = [];

  // Symlink containment at the READ point (not just the fallback walker):
  // `git ls-files` happily lists a TRACKED symlink like `leak.txt ->
  // ~/.ssh/id_rsa`, and stat/readFile would follow it OUT of the tree.
  // Context collection is scoped to the target tree — an out-of-tree
  // symlink is accounted as excluded, never silently read.
  let repoRootReal: string;
  try {
    repoRootReal = realpathSync(repoRoot);
  } catch {
    repoRootReal = repoRoot;
  }
  for (const rel of files) {
    const symlinkReason = contextSymlinkDenyReason(repoRoot, repoRootReal, rel);
    if (symlinkReason) {
      atlas.push({ path: rel, disposition: "excluded", reason: symlinkReason });
      continue;
    }
    let bytes = 0;
    try {
      bytes = statSync(join(repoRoot, rel)).size;
    } catch {
      atlas.push({ path: rel, disposition: "read_error", reason: "stat failed" });
      continue;
    }
    const mandatory = mandatorySet.has(rel);
    const sensitive = sensitiveResourcePolicy.classifyPath(rel);
    if (sensitive.sensitive) {
      atlas.push({
        path: rel,
        disposition: "sensitive",
        bytes,
        reason: sensitive.reason ?? undefined,
      });
      if (mandatory) missingMandatory.push(rel);
      continue;
    }
    if (!mandatory) {
      if (BINARY_EXT.has(extname(rel).toLowerCase())) {
        atlas.push({ path: rel, disposition: "binary", bytes });
        continue;
      }
      if (matchAny(rel, MANIFEST_ONLY)) {
        atlas.push({ path: rel, disposition: "manifest_only", bytes });
        continue;
      }
      if (matchAny(rel, VENDORED)) {
        atlas.push({ path: rel, disposition: "vendored", bytes });
        continue;
      }
      if (exclude.length > 0 && matchAny(rel, exclude)) {
        atlas.push({ path: rel, disposition: "excluded", bytes });
        continue;
      }
      if (include.length > 0 && !matchAny(rel, include)) {
        atlas.push({ path: rel, disposition: "excluded", bytes, reason: "not in include set" });
        continue;
      }
      if (bytes > maxFileBytes) {
        atlas.push({
          path: rel,
          disposition: "oversized",
          bytes,
          reason: `> ${maxFileBytes} bytes`,
        });
        continue;
      }
    }
    candidates.push({ rel, bytes, mandatory });
  }

  candidates.sort((a, b) =>
    a.mandatory === b.mandatory ? a.rel.localeCompare(b.rel) : a.mandatory ? -1 : 1,
  );

  let used = 0;
  const mandatory: ContextFileRef[] = [];
  const included: ContextFileRef[] = [];
  const omitted: OmissionEntry[] = [];

  for (const c of candidates) {
    if (!c.mandatory && used + estTokens(c.bytes) > tokenLimit) {
      atlas.push({ path: c.rel, disposition: "omitted", bytes: c.bytes, reason: "token_budget" });
      omitted.push({ path: c.rel, reason: "token budget exceeded", replacement: "index" });
      continue;
    }
    let content: string;
    try {
      content = readFileSync(join(repoRoot, c.rel), "utf8");
    } catch {
      atlas.push({ path: c.rel, disposition: "read_error", bytes: c.bytes, reason: "read failed" });
      if (c.mandatory) missingMandatory.push(c.rel);
      continue;
    }
    const contentDecision = sensitiveResourcePolicy.inspectContent(content, "reject");
    if (contentDecision.containsSensitiveContent) {
      atlas.push({
        path: c.rel,
        disposition: "sensitive",
        bytes: c.bytes,
        reason: `content signatures: ${contentDecision.signatures.join(", ")}`,
      });
      if (c.mandatory) missingMandatory.push(c.rel);
      continue;
    }
    const hash = sha256(content);
    used += estTokens(content.length);
    atlas.push({ path: c.rel, disposition: "full", bytes: c.bytes, hash });
    (c.mandatory ? mandatory : included).push({ path: c.rel, hash });
  }

  // mandatory files that were not found at all
  for (const m of mandatorySet) {
    if (!files.has(m)) missingMandatory.push(m);
  }

  atlas.sort((a, b) => a.path.localeCompare(b.path));
  return {
    atlas,
    mandatory,
    included,
    omitted,
    estimatedTokens: used,
    tokenLimit,
    missingMandatory,
  };
}

function statKind(stat: Stats): SymlinkTargetKind {
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  return "other";
}

/** Filesystem adapter for the shared pure symlink policy. */
export function contextSymlinkDenyReason(
  repoRoot: string,
  canonicalRepoRoot: string,
  rel: string,
): string | null {
  const full = join(repoRoot, rel);
  try {
    if (!lstatSync(full).isSymbolicLink()) return null;
    const resolved = realpathSync(full);
    const stat = statSync(full);
    const decision = sensitiveResourcePolicy.assessSymlink({
      sourceRoot: repoRoot,
      canonicalSourceRoot: canonicalRepoRoot,
      sourcePath: full,
      linkTarget: readlinkSync(full),
      resolvedTargetPath: resolved,
      targetKind: statKind(stat),
      allowedTargetKinds: ["file"],
    });
    return decision.allowed
      ? null
      : (decision.detail ?? "symlink target denied by sensitive-resource policy");
  } catch {
    return "symlink target cannot be resolved";
  }
}
