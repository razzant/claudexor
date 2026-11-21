import { join } from "node:path";
import { WorkspaceError } from "@claudexor/core";
import { lstatPresent } from "./fs-presence.js";
import { gitEnv, SCRATCH_INDEX_CONFIG } from "./git-run.js";

/** Makes Git print every name of a listing in ASCII: without `-z` it C-quotes a name
 * a line cannot carry, and with this each byte outside ASCII as well. */
export const QUOTED_NAMES = ["-c", "core.quotePath=true"];

const ESCAPED: Record<string, string> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

/**
 * The names of a listing Git printed under {@link QUOTED_NAMES}, each as its bytes,
 * one char per byte. A name read this way is exactly what Git holds: decoding a `-z`
 * listing as text would turn a byte that is not UTF-8 into U+FFFD, and that name,
 * handed back, addresses another file.
 */
export function listedNames(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) =>
      line.startsWith('"')
        ? line
            .slice(1, -1)
            .replace(/\\([0-3][0-7]{2}|.)/g, (_, code: string) =>
              code.length === 3 ? String.fromCharCode(parseInt(code, 8)) : (ESCAPED[code] ?? code),
            )
        : line,
    );
}

/** `names` (bytes, as {@link listedNames} gives them) as the lines a Git `--stdin`
 * reads without `-z`: each C-quoted, so the text is ASCII whatever the bytes. */
export function quotedNames(names: readonly string[]): string {
  const octal = (byte: string) => `\\${byte.charCodeAt(0).toString(8).padStart(3, "0")}`;
  return names.map((name) => `"${name.replace(/[^ !#-[\]-~]/g, octal)}"\n`).join("");
}

/** A listed name as text, or null when its bytes are not UTF-8: no argument and no
 * file-system call can name that file. */
export function nameText(name: string): string | null {
  const bytes = Buffer.from(name, "latin1");
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : null;
}

/** Submodule paths the working tree's own `.gitmodules` declares, relative to
 * the worktree top (where the file lives, whatever directory the capture runs
 * in): a submodule the candidate added on purpose is captured as its commit
 * link, as before. No file, or no declared path, declares nothing. The file is
 * named relative to the capture directory (`--show-cdup` is only `../`
 * steps), so no worktree path, whatever its spelling, is parsed here. */
async function declaredSubmodulePaths(
  repo: string,
  env: Record<string, string>,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const cdup = await gitEnv(repo, ["rev-parse", "--show-cdup"], env, undefined, signal);
  if (cdup.code !== 0) return new Set();
  const listed = await gitEnv(
    repo,
    [
      "config",
      "--file",
      `${cdup.stdout.trim()}.gitmodules`,
      "--null",
      "--get-regexp",
      "^submodule\\..*\\.path$",
    ],
    env,
    undefined,
    signal,
  );
  if (listed.code !== 0) return new Set();
  // --null: each entry is "key\nvalue\0", so a path keeps its spaces and newlines.
  return new Set(
    listed.stdout
      .split("\0")
      .filter((entry) => entry.includes("\n"))
      .map((entry) => entry.slice(entry.indexOf("\n") + 1))
      .filter((path) => path.length > 0),
  );
}

/**
 * Untracked nested repositories that no `.gitmodules` entry declares, as
 * worktree-top-relative paths: `git ls-files --others` names each one with a
 * trailing slash because Git never descends into another repository, and
 * `--full-name` keeps the names top-relative when the capture runs in a
 * subdirectory, matching both the patch paths and the `:(top)` exclusions.
 * Read against the caller's scratch index (`env`), so the set is "not in the
 * base tree", never the user's staging state.
 *
 * A patch cannot carry another repository (Git records a commit link, or
 * refuses a repository without a commit outright), so callers leave these out
 * of their `git add` with `nestedRepositoryExcludes` instead of failing.
 * `files`: every other name of the same listing, the untracked files themselves,
 * as their bytes ({@link listedNames}).
 */
export async function untrackedPaths(
  repo: string,
  env: Record<string, string>,
  pathspec: string[],
  label: string,
  signal?: AbortSignal,
): Promise<{ nested: string[]; files: string[] }> {
  const listed = await gitEnv(
    repo,
    [
      ...SCRATCH_INDEX_CONFIG,
      ...QUOTED_NAMES,
      "ls-files",
      "--others",
      "--exclude-standard",
      "--full-name",
      "--",
      ...pathspec,
    ],
    env,
    undefined,
    signal,
  );
  if (listed.code !== 0) {
    throw new WorkspaceError(`${label} could not list untracked files: ${listed.stderr.trim()}`);
  }
  const entries = listedNames(listed.stdout);
  const files = entries.filter((entry) => !entry.endsWith("/"));
  const nested = entries
    .filter((entry) => entry.endsWith("/"))
    .map((entry) => Buffer.from(entry.slice(0, -1), "latin1").toString("utf8"));
  if (nested.length === 0) return { nested, files };
  const declared = await declaredSubmodulePaths(repo, env, signal);
  return { nested: nested.filter((path) => !declared.has(path)), files };
}

/**
 * The repositories {@link untrackedPaths} cannot name. Git descends into a directory
 * its index has entries under, whatever that directory holds now, and lists the files
 * of a repository made there as plain untracked files. For such `files` (text, relative
 * to the worktree `top`): `inside`, those below a directory that is another
 * repository's top level, and `nested`, those directories that no `.gitmodules` entry
 * declares, as {@link untrackedPaths} names its own. Git decides, once per directory
 * and only where a `.git` entry is: `rev-parse --show-cdup` run there answers an
 * empty line at a repository's own top level alone. So an empty `.git` directory or
 * a gitfile that names no repository makes none, and neither does a repository Git
 * refuses to enter (one another user owns).
 */
export async function repositoriesAbove(
  top: string,
  files: readonly string[],
  env: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ nested: string[]; inside: Set<string> }> {
  const parent = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), 0));
  const known = new Map<string, string | null>([["", null]]);
  /** The outermost repository at or above the directory `dir`, below `top`. */
  const repositoryOf = async (dir: string): Promise<string | null> => {
    const answered = known.get(dir);
    if (answered !== undefined) return answered;
    let repository = await repositoryOf(parent(dir));
    if (repository === null && lstatPresent(join(top, dir, ".git")) !== undefined) {
      const own = await gitEnv(
        join(top, dir),
        ["rev-parse", "--show-cdup"],
        env,
        undefined,
        signal,
      );
      if (own.code === 0 && own.stdout.trim() === "") repository = dir;
    }
    known.set(dir, repository);
    return repository;
  };
  const inside = new Set<string>();
  const found = new Set<string>();
  for (const file of files) {
    const repository = await repositoryOf(parent(file));
    if (repository === null) continue;
    inside.add(file);
    found.add(repository);
  }
  if (found.size === 0) return { nested: [], inside };
  const declared = await declaredSubmodulePaths(top, env, signal);
  return { nested: [...found].filter((path) => !declared.has(path)).sort(), inside };
}

/** Exclusion pathspecs for the nested repositories of `untrackedPaths`: top-relative
 * and literal, so a name with glob characters never swallows a sibling. */
export function nestedRepositoryExcludes(paths: string[]): string[] {
  return paths.map((path) => `:(exclude,top,literal)${path}`);
}
