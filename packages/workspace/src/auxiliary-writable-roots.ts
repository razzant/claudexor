/**
 * Admission of `execution.auxiliaryWritableRoots`: exact caller-created service
 * directories (download caches, outside-Git scratch) a writable Agent lane may
 * also write. One owner for the filesystem rules, shared by the HTTP boundary
 * (cheap shape/existence checks) and the engine's run admission (the complete
 * canonical grant). Nothing here creates, cleans, or inventories directories.
 */
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalProjectRoot, claudexorOwnedRoot, userHomeDir } from "@claudexor/util";

export type AuxiliaryWritableRootRejection =
  | "filesystem_root"
  | "home"
  | "engine_state"
  | "execution_tree"
  | "source_project"
  | "git_metadata";

const REJECTION_TEXT: Record<AuxiliaryWritableRootRejection, string> = {
  filesystem_root: "is a filesystem root",
  home: "is the user home directory or one of its ancestors",
  engine_state: "overlaps Claudexor's own control or credential state",
  execution_tree: "overlaps the execution tree",
  source_project: "overlaps the source project",
  git_metadata: "overlaps Git metadata of the project or execution tree",
};

export interface AuxiliaryWritableRootsContext {
  /** Stable project (source) root. */
  repoRoot: string;
  /** Tree the harness executes in; the project root for envelope runs at admission time. */
  executionRoot: string;
  /** Configured credential-profile homes the engine owns (isolation locators). */
  credentialHomes?: readonly string[];
}

/** Missing future state directories have no identity yet; other read failures stay visible. */
function directoryIdentity(path: string): string | null {
  try {
    const stat = statSync(path, { bigint: true });
    return stat.isDirectory() && stat.ino !== 0n ? `${stat.dev}:${stat.ino}` : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw invalid(path, `cannot inspect directory identity (${code ?? "unreadable"})`, true);
  }
}

/** `inner` is `outer` or lies below it, including aliases realpath leaves distinct. */
function within(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  if (rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))) return true;
  // macOS firmlinks preserve two realpath spellings for the same directory.
  // Compare only this ancestry's identities, never scan directory contents.
  const id = directoryIdentity(outer);
  if (id === null) return false;
  for (let parent = inner; ; parent = dirname(parent)) {
    if (directoryIdentity(parent) === id) return true;
    if (dirname(parent) === parent) return false;
  }
}

function overlaps(a: string, b: string): boolean {
  return within(a, b) || within(b, a);
}

function invalid(root: string, detail: string, retryable: boolean): Error {
  return Object.assign(
    new Error(`execution.auxiliaryWritableRoots entry ${JSON.stringify(root)} ${detail}`),
    {
      status: 400,
      code: "auxiliary_writable_root_invalid",
      retryable,
      requiredActions: [
        "Create the directory yourself and pass its absolute path (the engine never provisions it), or remove the grant. For continueFrom, POST /v2/runs with a complete replacement execution group and auxiliaryWritableRoots: []; claudexor_run_continue inherits execution, so use HTTP or start a new run.",
      ],
      context: { root },
    },
  );
}

/** Spelling-only admission for a boundary that defers the mutable existence fact. */
export function assertAuxiliaryWritableRootSpelling(root: string): void {
  if (!isAbsolute(root)) throw invalid(root, "is not an absolute path", false);
}

function canonicalDirectory(root: string): string {
  assertAuxiliaryWritableRootSpelling(root);
  let real: string;
  try {
    real = realpathSync.native(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unreadable";
    throw invalid(
      root,
      code === "ENOENT" ? "does not exist" : `cannot be resolved (${code})`,
      true,
    );
  }
  let directory = false;
  try {
    directory = statSync(real).isDirectory();
  } catch {
    // Raced away or unreadable: refused below like any non-directory.
  }
  if (!directory) throw invalid(root, "is not a directory", true);
  return real;
}

function assertUsable(root: string, real: string): void {
  try {
    accessSync(real, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    throw invalid(root, "is not readable and writable by the engine user", true);
  }
}

/** The canonical (realpath) directory a caller-spelled root names, or a typed refusal. */
export function auxiliaryWritableRootDirectory(root: string): string {
  const real = canonicalDirectory(root);
  assertUsable(root, real);
  return real;
}

/** Git metadata a tree's `.git` names: the directory itself, or a worktree's gitdir and common dir. */
function gitMetadataDirs(tree: string): string[] {
  const dotGit = join(tree, ".git");
  try {
    const stat = statSync(dotGit);
    if (stat.isDirectory()) return [canonicalProjectRoot(dotGit)];
    if (!stat.isFile()) return [];
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
    if (!pointer) return [];
    const gitDir = canonicalProjectRoot(resolve(tree, pointer));
    try {
      const common = readFileSync(join(gitDir, "commondir"), "utf8").trim();
      return common ? [gitDir, canonicalProjectRoot(resolve(gitDir, common))] : [gitDir];
    } catch {
      return [gitDir];
    }
  } catch {
    return [];
  }
}

function rejection(
  real: string,
  ctx: AuxiliaryWritableRootsContext,
): AuxiliaryWritableRootRejection | null {
  if (dirname(real) === real) return "filesystem_root";
  if (within(real, canonicalProjectRoot(userHomeDir()))) return "home";
  const engineHomes = [claudexorOwnedRoot(), ...(ctx.credentialHomes ?? [])];
  if (engineHomes.some((home) => overlaps(real, canonicalProjectRoot(home)))) return "engine_state";
  const executionRoot = canonicalProjectRoot(ctx.executionRoot);
  const projectRoot = canonicalProjectRoot(ctx.repoRoot);
  // Service side effects must not enter the project's capture/apply footprint,
  // even when a descendant already happens to be writable in a live run.
  if (overlaps(real, executionRoot)) return "execution_tree";
  if (overlaps(real, projectRoot)) return "source_project";
  const gitDirs = [...gitMetadataDirs(executionRoot), ...gitMetadataDirs(projectRoot)];
  if (gitDirs.some((gitDir) => overlaps(real, gitDir))) return "git_metadata";
  return null;
}

/**
 * The run's canonical auxiliary grant: every caller-spelled root resolved to
 * an existing directory, deduplicated, and refused when it would widen access
 * to the filesystem root, HOME itself, Claudexor's own state, the execution
 * tree or the source project, or their Git metadata. Omission and [] grant
 * nothing.
 */
export function admitAuxiliaryWritableRoots(
  roots: readonly string[] | undefined,
  ctx: AuxiliaryWritableRootsContext,
): string[] {
  const granted: string[] = [];
  for (const root of roots ?? []) {
    const real = canonicalDirectory(root);
    const reason = rejection(real, ctx);
    if (reason) {
      throw Object.assign(
        new Error(
          `execution.auxiliaryWritableRoots entry ${JSON.stringify(root)} (${real}) ${REJECTION_TEXT[reason]}`,
        ),
        {
          status: 400,
          code: "auxiliary_writable_root_unsafe",
          retryable: false,
          requiredActions: [
            "Grant a dedicated service directory outside the project, the execution tree, their Git metadata, HOME itself, and Claudexor's own state. For continueFrom, replace the complete execution group through POST /v2/runs (auxiliaryWritableRoots: [] clears it), or start a new run; claudexor_run_continue inherits execution.",
          ],
          context: { root, canonicalRoot: real, reason },
        },
      );
    }
    assertUsable(root, real);
    if (!granted.includes(real)) granted.push(real);
  }
  return granted;
}
