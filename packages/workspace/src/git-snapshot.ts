import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceError } from "@claudexor/core";
import { lstatPresent } from "./fs-presence.js";
import {
  nestedRepositoryExcludes,
  untrackedNestedRepositories,
} from "./git-nested-repositories.js";
import { diskProgress, gitObserved, proofStallMs, treeBlobBytes } from "./git-observed.js";
import { git, gitEnv, revParse, SCRATCH_INDEX_CONFIG } from "./git-run.js";
import { outsideSparseCheckout } from "./object-sparse.js";

type GitEnv = Record<string, string>;

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Entries of an index the user marked so that Git skips their bytes: assume-unchanged
 * (a lowercase `ls-files -v` tag) and skip-worktree (`S`). A name stdin cannot carry
 * back to Git (not valid UTF-8) is only counted. */
export interface MarkedEntries {
  assumed: string[];
  skipped: string[];
  unnamed: number;
  /** Merged (stage 0) entries of the wanted paths, as `--index-info` lines. */
  held: { path: string; info: string }[];
}

/** The marked entries of the index `env` names, read as a stream (only marked ones are
 * kept), and the entries of `wanted` paths in the same pass. */
export async function markedEntries(
  top: string,
  env: GitEnv,
  wanted: ReadonlySet<string> = new Set(),
): Promise<MarkedEntries> {
  const marked: MarkedEntries = { assumed: [], skipped: [], unnamed: 0, held: [] };
  const staged = wanted.size > 0; // `-s`: "<tag> <mode> <oid> <stage>\t<path>"
  const take = (record: Buffer) => {
    const tag = record[0] ?? 0;
    const assumed = tag >= 0x61 && tag <= 0x7a; // a lowercase tag
    const skipped = tag === 0x53 || tag === 0x73; // S or s
    const tab = staged ? record.indexOf(0x09) : 1;
    if ((!assumed && !skipped && !staged) || record.length < 3 || tab < 1) return;
    let path: string;
    try {
      path = STRICT_UTF8.decode(record.subarray(tab + 1));
    } catch {
      if (assumed || skipped) marked.unnamed += 1;
      return;
    }
    if (assumed) marked.assumed.push(path);
    if (skipped) marked.skipped.push(path);
    if (staged && wanted.has(path)) {
      const [mode, oid, stage] = record.subarray(2, tab).toString("latin1").split(" ");
      if (stage === "0") marked.held.push({ path, info: `${mode} ${oid}\t${path}` });
    }
  };
  let carry = Buffer.alloc(0);
  await gitObserved(
    top,
    [...SCRATCH_INDEX_CONFIG, "ls-files", "-v", ...(staged ? ["-s"] : []), "-z"],
    {
      env,
      label: "ls-files -v (snapshot)",
      stdout: {
        write(chunk) {
          const data = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
          let start = 0;
          for (let end = data.indexOf(0); end !== -1; end = data.indexOf(0, start)) {
            take(data.subarray(start, end));
            start = end + 1;
          }
          carry = Buffer.from(data.subarray(start));
        },
        end: () => "",
      },
    },
  );
  return marked;
}

/**
 * The snapshot's clean check: `git status`. No stat shortcut of the user's
 * configuration applies (`STAT_TRUST_OFF`, no untracked cache), and an entry the
 * user marked assume-unchanged or skip-worktree is compared like any other in a
 * private copy of the index, so the check answers what the snapshot's `add -A`
 * would record. Only an absent skip-worktree file the sparse-checkout patterns
 * leave out stays as the index has it: a sparse checkout leaves such a file absent
 * on purpose, and `add -A` skips it too. A marked file that is gone otherwise is a
 * deletion (a clean check that trusted the mark held HEAD's blob where a dirty
 * worktree's snapshot held the deletion). `git status` still trusts the index's stat
 * cache for every other file, as the user's own does: an edit that kept a file's
 * size and times (with `core.checkStat=minimal` and `core.trustctime=false`, a
 * restored mtime is enough) reads as unchanged. So the `exact` paths, the ones the
 * caller decides on, are re-added to the private copy without stat data, and the
 * check reads exactly those files (bar the out-of-pattern absences above) by
 * content. The copy keeps the user's index time, so an entry Git would compare as
 * racily clean is still compared. The user's own index is never written. Null: the
 * comparison could not be set up (or this Git cannot evaluate the sparse
 * patterns), so the caller reads every file instead.
 */
async function snapshotStatus(
  repo: string,
  objects: GitEnv,
  scratchDir: string,
  exact: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string } | null> {
  const env: GitEnv = { ...objects, GIT_OPTIONAL_LOCKS: "0" };
  const top = await gitEnv(repo, ["rev-parse", "--show-toplevel"], env);
  if (top.code !== 0) throw new WorkspaceError(`snapshot top level failed: ${top.stderr.trim()}`);
  const root = top.stdout.trim();
  const marked = await markedEntries(root, env, new Set(exact));
  // A parent that became a file (ENOTDIR) means the marked file is not there.
  const compared: string[] = [];
  const absent: string[] = [];
  for (const path of marked.skipped)
    (lstatPresent(join(root, path)) === undefined ? absent : compared).push(path);
  let kept = new Set<string>();
  if (absent.length > 0) {
    const excluded = await outsideSparseCheckout(root, absent, env);
    if (excluded === null) return null;
    kept = new Set(excluded);
    compared.push(...absent.filter((path) => !kept.has(path)));
  }
  const reread = marked.held.filter(({ path }) => !kept.has(path));
  if (marked.assumed.length > 0 || compared.length > 0 || marked.unnamed > 0 || reread.length > 0) {
    if (marked.unnamed > 0) return null;
    const located = await gitEnv(
      root,
      ["rev-parse", "--path-format=absolute", "--git-path", "index"],
      env,
    );
    const userIndex = located.code === 0 ? located.stdout.trim() : "";
    if (!userIndex || !existsSync(userIndex)) return null;
    const copy = join(scratchDir, "status-index");
    const { atimeMs, mtimeMs } = statSync(userIndex);
    copyFileSync(userIndex, `${copy}.copy`);
    // Git compares an entry's times to its index file's own: never later than the user's.
    utimesSync(`${copy}.copy`, atimeMs / 1000, Math.floor(mtimeMs) / 1000);
    renameSync(`${copy}.copy`, copy);
    env["GIT_INDEX_FILE"] = copy;
    for (const [flag, paths] of [
      ["--no-assume-unchanged", marked.assumed],
      ["--no-skip-worktree", compared],
    ] as const) {
      if (paths.length === 0) continue;
      const cleared = await gitEnv(
        root,
        [...SCRATCH_INDEX_CONFIG, "update-index", flag, "-z", "--stdin"],
        env,
        `${paths.join("\0")}\0`,
      );
      if (cleared.code !== 0) return null;
    }
    if (reread.length > 0) {
      const unstated = await gitEnv(
        root,
        [...SCRATCH_INDEX_CONFIG, "update-index", "-z", "--index-info"],
        env,
        reread.map(({ info }) => `${info}\0`).join(""),
      );
      if (unstated.code !== 0) return null;
    }
  }
  return gitEnv(
    repo,
    [...SCRATCH_INDEX_CONFIG, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    env,
  );
}

/**
 * Capture the full dirty working tree (tracked AND untracked) as a dangling
 * commit; null if clean. Plain `git stash create` captures only TRACKED
 * changes, silently dropping the user's new-but-unstaged files from the run's
 * base. We instead seed a scratch index from HEAD, `add -A` into it (which
 * respects .gitignore, so run artifacts stay out), and commit-tree the result.
 * `objects`: where the snapshot's objects go instead (a dry run's scratch).
 * `exact`: paths the caller decides on, which a clean answer has read by content
 * ({@link snapshotStatus}); a dirty snapshot reads every file anyway.
 */
export async function stashCreate(
  repo: string,
  objects: GitEnv = {},
  exact: readonly string[] = [],
): Promise<string | null> {
  // Unique per call: concurrent envelope creates (a best_of_n wave) must never
  // collide on the scratch index (same pid + same millisecond is real). It lives
  // in the OS temp dir, NOT under `<repo>/.git` — in a linked worktree `.git` is
  // a FILE (gitdir pointer), so a scratch path there fails (review #8).
  const scratchDir = mkdtempSync(join(tmpdir(), "claudexor-snapshot-index-"));
  const tmpIndex = join(scratchDir, "index");
  const env: Record<string, string> = {
    ...objects,
    GIT_INDEX_FILE: tmpIndex,
    GIT_AUTHOR_NAME: "Claudexor",
    GIT_AUTHOR_EMAIL: "noreply@claudexor.local",
    GIT_COMMITTER_NAME: "Claudexor",
    GIT_COMMITTER_EMAIL: "noreply@claudexor.local",
  };
  try {
    // NUL form is filename-faithful (newlines, quotes and whitespace are legal
    // path bytes). Runtime is external, so every reported path is user state.
    const status = await snapshotStatus(repo, objects, scratchDir, exact);
    if (status && status.code !== 0)
      throw new WorkspaceError(`snapshot status failed: ${status.stderr.trim()}`);
    if (status && status.stdout.length === 0) return null;
    const head = await git(repo, ["rev-parse", "HEAD"]);
    if (head.code !== 0)
      throw new WorkspaceError(`snapshot rev-parse HEAD failed: ${head.stderr.trim()}`);
    const headSha = head.stdout.trim();
    const read = await gitEnv(repo, [...SCRATCH_INDEX_CONFIG, "read-tree", "HEAD"], env);
    if (read.code !== 0)
      throw new WorkspaceError(`snapshot read-tree failed: ${read.stderr.trim()}`);
    // Bare add runs only against the scratch index. It respects the project's
    // own ignore policy without changing the live index. `.claudexor/` is not a
    // runtime exception in v2: tracked or untracked project config is user state.
    // An undeclared nested repository stays out, as in the candidate capture:
    // `add` refuses one without a commit and would freeze one with a commit as
    // a commit link (`:/` keeps the whole-tree scope of the bare add).
    const nested = await untrackedNestedRepositories(repo, env, [":/"], "snapshot");
    const add = await gitObserved(
      repo,
      [
        ...SCRATCH_INDEX_CONFIG,
        "add",
        "-A",
        ...(nested.length ? ["--", ":/", ...nestedRepositoryExcludes(nested)] : []),
      ],
      {
        env,
        label: "add -A (snapshot)",
        progress: diskProgress(repo),
        allowFailure: true,
        // Re-hashing HEAD's files reads silently: bounded by their bytes, not a flat ten minutes.
        stallMs: proofStallMs(await treeBlobBytes(repo, headSha, env)),
      },
    );
    if (add.code !== 0) throw new WorkspaceError(`snapshot add -A failed: ${add.stderr.trim()}`);
    const writeTree = await gitEnv(repo, [...SCRATCH_INDEX_CONFIG, "write-tree"], env);
    if (writeTree.code !== 0)
      throw new WorkspaceError(`snapshot write-tree failed: ${writeTree.stderr.trim()}`);
    const tree = writeTree.stdout.trim();
    // Read without the clean check: a tree equal to HEAD's is no change either.
    if (!status && tree === (await revParse(repo, "HEAD^{tree}"))) return null;
    const commit = await gitEnv(
      repo,
      [
        "commit-tree",
        tree,
        "-p",
        headSha,
        "-m",
        "claudexor: dirty worktree snapshot (incl. untracked)",
      ],
      env,
    );
    if (commit.code !== 0)
      throw new WorkspaceError(`snapshot commit-tree failed: ${commit.stderr.trim()}`);
    const sha = commit.stdout.trim();
    return sha.length > 0 ? sha : null;
  } finally {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      /* scratch index cleanup is best-effort */
    }
  }
}

/**
 * Capture the CURRENT working-tree state (tracked + untracked, minus `.claudexor`)
 * as a commit sha — always returns one. Dirty trees become a dangling snapshot
 * commit (via `stashCreate`); a clean tree resolves to HEAD. This is the per-turn
 * diff base for in-place threads: snapshot at turn start, snapshot at turn end,
 * `diffTrees(base, end)` yields exactly that turn's net change (pre-existing dirty
 * state is folded into `base`, so the reviewer never sees prior turns' edits).
 * `exact`: as for {@link stashCreate}.
 */
export async function snapshotTree(repo: string, exact: readonly string[] = []): Promise<string> {
  const snap = await stashCreate(repo, {}, exact);
  return snap ?? (await revParse(repo, "HEAD"));
}
