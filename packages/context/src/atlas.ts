import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import type { ContextFileRef, OmissionEntry, ScopeAtlasEntry } from "@claudexor/schema";
import { runCapture } from "@claudexor/core";
import { sha256 } from "@claudexor/util";
import { matchAny } from "./glob.js";

const SENSITIVE = [
  "**/.env",
  "**/.env.*",
  ".env",
  ".env.*",
  "**/secrets/**",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/*.p12",
  "**/credentials*.json",
];
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
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tar",
  ".tgz", ".zst", ".woff", ".woff2", ".ttf", ".eot", ".mp4", ".mov", ".mp3", ".wav",
  ".bin", ".so", ".dylib", ".dll", ".node", ".class", ".jar", ".wasm", ".o", ".a",
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
      const files = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      if (files.length > 0) return files;
    }
  } catch {
    /* not a git repo or git missing — fall back to walk */
  }
  return walk(repoRoot, repoRoot);
}

function walk(root: string, dir: string): string[] {
  const skip = new Set([".git", "node_modules", "dist", ".turbo", ".claudexor", "coverage"]);
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const full = join(dir, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) out.push(...walk(root, full));
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
export async function buildScopeAtlas(repoRoot: string, opts: AtlasOptions = {}): Promise<AtlasResult> {
  const exclude = opts.exclude ?? [];
  const include = opts.include ?? [];
  const mandatorySet = new Set(opts.mandatory ?? []);
  const maxFileBytes = opts.maxFileBytes ?? 256 * 1024;
  const tokenLimit = opts.tokenLimit ?? 200_000;

  const files = new Set(await listFiles(repoRoot));
  const atlas: ScopeAtlasEntry[] = [];
  const candidates: { rel: string; bytes: number; mandatory: boolean }[] = [];

  for (const rel of files) {
    let bytes = 0;
    try {
      bytes = statSync(join(repoRoot, rel)).size;
    } catch {
      atlas.push({ path: rel, disposition: "read_error", reason: "stat failed" });
      continue;
    }
    const mandatory = mandatorySet.has(rel);
    if (!mandatory) {
      if (matchAny(rel, SENSITIVE)) {
        atlas.push({ path: rel, disposition: "sensitive", bytes });
        continue;
      }
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
        atlas.push({ path: rel, disposition: "oversized", bytes, reason: `> ${maxFileBytes} bytes` });
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
  const missingMandatory: string[] = [];

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
  return { atlas, mandatory, included, omitted, estimatedTokens: used, tokenLimit, missingMandatory };
}
