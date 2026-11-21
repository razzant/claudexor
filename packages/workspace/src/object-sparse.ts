import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { GitResultRefusal } from "@claudexor/schema";
import { lstatPresent } from "./fs-presence.js";
import {
  listedNames,
  nameText,
  QUOTED_NAMES,
  quotedNames,
  repositoriesAbove,
} from "./git-nested-repositories.js";
import {
  classifyGitFailure,
  gitObserved,
  GitOperationError,
  type ObservedGitResult,
} from "./git-observed.js";
import { SCRATCH_INDEX_CONFIG, STAT_TRUST_OFF } from "./git-run.js";

/** `git sparse-checkout check-rules` arrived in Git 2.41; an older Git answers its
 * usage error (exit 129: an unknown subcommand) instead. */
const CHECK_RULES_UNKNOWN = 129;

/** What `check-rules` printed, or null from a Git that has no such subcommand. */
function checkRulesOutput(kept: ObservedGitResult): string | null {
  if (kept.code === CHECK_RULES_UNKNOWN) return null;
  if (kept.code !== 0)
    throw new GitOperationError(
      classifyGitFailure(kept.stderr),
      `git sparse-checkout check-rules failed: ${kept.stderr.trim().slice(0, 2_000)}`,
    );
  return kept.stdout;
}

/** Whether the worktree is a sparse checkout whose patterns leave anything out: one
 * `git config`, and one `rev-parse` only where `core.sparseCheckout` is set. */
async function sparsePatternsApply(
  worktree: string,
  env: Record<string, string>,
  signal?: AbortSignal,
): Promise<boolean> {
  const sparse = await gitObserved(
    worktree,
    ["config", "--type=bool", "--get", "core.sparseCheckout"],
    { env, label: "config core.sparseCheckout", allowFailure: true, signal },
  );
  if (sparse.stdout.trim() !== "true") return false;
  const patterns = await gitObserved(
    worktree,
    ["rev-parse", "--path-format=absolute", "--git-path", "info/sparse-checkout"],
    { env, label: "rev-parse --git-path info/sparse-checkout", signal },
  );
  return lstatPresent(patterns.stdout.trim()) !== undefined;
}

/**
 * The paths among `paths` that the worktree's sparse-checkout patterns leave out
 * (none when it is not a sparse checkout), from one `check-rules` call, or null when
 * this Git cannot evaluate the patterns (older than 2.41). A snapshot's `add -A`
 * skips such a path, a tracked one keeping HEAD's blob whether its file is absent,
 * as a sparse checkout usually leaves it, or present, so an operation that addresses
 * one could not tell what it holds before or after writing. With
 * `core.sparseCheckout` set but no patterns file, Git checks out everything, and so
 * nothing is left out here either. A worktree that is not sparse costs one
 * `git config` and never asks `check-rules`.
 */
export async function outsideSparseCheckout(
  worktree: string,
  paths: readonly string[],
  env: Record<string, string>,
  signal?: AbortSignal,
): Promise<string[] | null> {
  if (paths.length === 0 || !(await sparsePatternsApply(worktree, env, signal))) return [];
  const kept = checkRulesOutput(
    await gitObserved(worktree, ["sparse-checkout", "check-rules", "-z"], {
      env,
      label: "sparse-checkout check-rules",
      input: paths.map((path) => `${path}\0`).join(""),
      allowFailure: true,
      signal,
    }),
  );
  if (kept === null) return null;
  const inside = new Set(kept.split("\0"));
  return paths.filter((path) => !inside.has(path));
}

/** The files the capture's base added to its own boundary commit, within the capture's
 * pathspec, as their bytes: what an earlier dirty snapshot took in. The scratch index
 * holds the base here, and a commit link is never listed. */
async function addedByBase(
  cwd: string,
  env: Record<string, string>,
  taken: { boundary: string; scope: readonly string[] },
  signal?: AbortSignal,
): Promise<string[]> {
  const listed = await gitObserved(
    cwd,
    [
      ...SCRATCH_INDEX_CONFIG,
      ...QUOTED_NAMES,
      "diff-index",
      "--cached",
      "--name-only",
      "--no-renames",
      "--ignore-submodules=all",
      "--diff-filter=A",
      taken.boundary,
      "--",
      ...taken.scope,
    ],
    { env, label: "diff-index (added by the base)", signal },
  );
  return listedNames(listed.stdout);
}

/** `env` for a Git that reads the checkout's own index: the scratch one is dropped. */
function checkoutEnv(env: Record<string, string>): Record<string, string> {
  const { GIT_INDEX_FILE: _scratch, ...checkout } = env;
  return checkout;
}

/**
 * What the checkout's own Git says of `names` (bytes, as {@link listedNames} gives them):
 * one `ls-files -t -z --cached`, with `--others --exclude-standard` when `untracked`, run
 * at the top on the checkout's own index (the scratch one lacks the `.gitignore` files the
 * patterns leave out) and given no pathspec. Git walks the worktree as `status` does, skips
 * ignored directories, reads every `.gitignore` on the way (one the patterns leave out from
 * that index) and prints each tracked name, tagged `S` where the index marks it
 * skip-worktree, and each untracked name its rules do not ignore, tagged `?`. The listing is
 * streamed and a name is looked up as bytes, so an ignored name simply has no tag. Asking
 * for the names cannot be made literal: `check-ignore` and `ls-files` read a name as a
 * pathspec (a glob stands for its tracked neighbour, and the walk begins at the paths'
 * common prefix, below a `.gitignore` above it), and the backslash that escapes a glob
 * character is part of the string the ignore rules then match.
 */
async function checkoutTags(
  top: string,
  names: ReadonlySet<string>,
  untracked: boolean,
  env: Record<string, string>,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const tags = new Map<string, string>();
  const take = (record: Buffer) => {
    // "<tag> <name>", a tag being one character.
    const name = record.subarray(2).toString("latin1");
    if (names.has(name)) tags.set(name, String.fromCharCode(record[0] ?? 0));
  };
  let carry = Buffer.alloc(0);
  await gitObserved(
    top,
    [
      ...STAT_TRUST_OFF,
      "-c",
      "core.untrackedCache=false",
      "ls-files",
      "-t",
      "-z",
      "--cached",
      ...(untracked ? ["--others", "--exclude-standard"] : []),
    ],
    {
      env: checkoutEnv(env),
      label: "ls-files -t (outside sparse patterns)",
      signal,
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
  return tags;
}

/**
 * Before a capture's own `add -A`, take into its scratch index (`env`) the files
 * outside the sparse-checkout patterns that the sparse checkout did not leave out
 * itself (#734): the `untracked` files the capture listed against that index (their
 * bytes), each of which `add -A` refuses, failing the capture, and the files its base
 * added to that base's own boundary commit (`taken`, with the capture's pathspec; null
 * when the base is no dirty snapshot): a file an earlier snapshot took in, whose edit
 * or removal `add -A` would skip. Nothing else out there is read, wherever HEAD is by
 * now: every other tracked path stays as `add -A` leaves it, the base's, absent as a
 * sparse checkout leaves it or present (`add --sparse -A` would record each absent
 * one as deleted).
 *
 * One `update-index --add --remove` reads them as Git reads any file, conversion
 * included, under the stall bound of the caller's `add -A` (`watch`). The new names
 * go first, so it replaces no entry: a new file where the base holds a directory, or
 * below a path the base holds as a file, fails the capture. Names travel as Git's own
 * quoted lines, byte for byte. A new file is not taken, and so still fails the capture,
 * when the checkout's own Git ignores it (it lists the file nowhere: {@link checkoutTags},
 * the one reader of a `.gitignore` the patterns leave out) or when its name is not
 * UTF-8. Nor is one below a directory that became another repository where the base has
 * files, and a file the base took in below one stays as the base has it: those
 * repositories are returned, for the caller to leave out of its `add -A` and to name (a
 * base file whose name is not UTF-8 cannot be looked up, and is followed as before). A
 * base file is followed whatever the checkout's Git ignores by now, as `add -A` follows a
 * tracked one; but one that is absent from the worktree while the checkout's own index
 * marks it skip-worktree stays as the base has it, as the clean check of a snapshot leaves
 * such a file: a worktree made on the snapshot is a sparse checkout too and leaves every
 * file outside its patterns absent, so its removal there is nobody's deletion. One absent
 * without that mark is a removal. A commit link is never taken. A checkout that is not
 * sparse costs one `git config`, and one whose Git cannot evaluate the patterns (older
 * than 2.41) keeps `add -A`'s answer.
 *
 * `space`: the capture's free-space preflight, asked before anything is written to count
 * also the files this step takes, among them one the user's Git ignores by now, which
 * the `git status` it estimated from does not list.
 */
export async function addOutsideSparseCheckout(
  cwd: string,
  env: Record<string, string>,
  untracked: readonly string[],
  taken: { boundary: string; scope: readonly string[] } | null,
  watch: { progress: () => Promise<number>; stallMs: number },
  signal?: AbortSignal,
  space?: { alsoReading(paths: readonly string[]): void },
): Promise<string[]> {
  if (untracked.length === 0 && !taken) return [];
  if (!(await sparsePatternsApply(cwd, env, signal))) return [];
  const later = taken ? await addedByBase(cwd, env, taken, signal) : [];
  if (untracked.length === 0 && later.length === 0) return [];
  // Names are top-relative; `--show-cdup` is only `../` steps, so no path is parsed.
  // The physical directory, as Git's own `-C` resolves it: `link/..` is the link target's parent.
  const cdup = await gitObserved(cwd, ["rev-parse", "--show-cdup"], {
    env,
    label: "rev-parse --show-cdup",
    signal,
  });
  const top = join(realpathSync.native(cwd), cdup.stdout.trim());
  const kept = checkRulesOutput(
    await gitObserved(top, [...QUOTED_NAMES, "sparse-checkout", "check-rules"], {
      env,
      label: "sparse-checkout check-rules",
      input: quotedNames([...untracked, ...later]),
      allowFailure: true,
      signal,
    }),
  );
  if (kept === null) return [];
  const inside = new Set(listedNames(kept));
  const fresh = untracked.flatMap((name) => {
    const text = inside.has(name) ? null : nameText(name);
    return text === null ? [] : [{ name, text }];
  });
  // The base's own files out there are followed like tracked ones, whatever Git ignores by
  // now, but not below a directory that became another repository since: Git lists no
  // repository there (the base's entries make it descend), so it is found through them.
  // A name that is not UTF-8 cannot be looked up in a directory, and is followed.
  const held = later
    .filter((name) => !inside.has(name))
    .map((name) => ({ name, text: nameText(name) }));
  const repositories = await repositoriesAbove(
    top,
    [...fresh, ...held].flatMap(({ text }) => (text === null ? [] : [text])),
    env,
    signal,
  );
  const candidates = fresh.filter(({ text }) => !repositories.inside.has(text));
  const followed = held.filter(({ text }) => text === null || !repositories.inside.has(text));
  // A base file the worktree lacks: whether its absence is the checkout's own doing (the
  // patterns leave it out), or a removal, is in the checkout's own index.
  const absent = followed.filter(
    ({ text }) => text !== null && lstatPresent(join(top, text)) === undefined,
  );
  const tags =
    candidates.length + absent.length > 0
      ? await checkoutTags(
          top,
          new Set([...candidates, ...absent].map(({ name }) => name)),
          candidates.length > 0,
          env,
          signal,
        )
      : new Map<string, string>();
  const taking = [
    // Git lists what it tracks and what it does not ignore: a name it lists nowhere is ignored.
    ...candidates.filter(({ name }) => tags.has(name)),
    // Absent, and marked skip-worktree: that checkout leaves the file out, nobody removed it,
    // and `--remove` would record a deletion. (Only absent names are asked for.)
    ...followed.filter(({ name }) => tags.get(name) !== "S"),
  ];
  if (taking.length > 0) {
    space?.alsoReading(taking.flatMap(({ text }) => (text === null ? [] : [text])));
    await gitObserved(
      top,
      [...SCRATCH_INDEX_CONFIG, "update-index", "--add", "--remove", "--stdin"],
      {
        env,
        label: "update-index (outside sparse patterns)",
        input: quotedNames(taking.map(({ name }) => name)),
        ...watch,
        signal,
      },
    );
  }
  return repositories.nested;
}

/**
 * The refusal of an operation that must write or remove a path outside the
 * sparse-checkout patterns, naming those paths, or of any operation in a sparse
 * checkout whose Git cannot evaluate its patterns; nothing is written. Widening the
 * sparse checkout (`git sparse-checkout add`) lets the same operation run. Paths it
 * does not address keep their files: the checkout runs with the patterns off.
 */
export async function sparseCheckoutRefusal(
  worktree: string,
  paths: readonly string[],
  operation: "delivery" | "revert",
  env: Record<string, string> = {},
): Promise<GitResultRefusal | null> {
  const found = await outsideSparseCheckout(worktree, paths, env);
  if (found === null) {
    const version = await gitObserved(worktree, ["version"], {
      env,
      label: "version",
      allowFailure: true,
    });
    return {
      code: "git_failed",
      message: `this checkout is sparse, and its Git (${version.stdout.trim() || "version unknown"}) cannot evaluate the sparse-checkout patterns: Claudexor asks \`git sparse-checkout check-rules\`, which Git 2.41 added, which of the paths this ${operation} changes are inside them; nothing was written. Use Git 2.41 or newer, or turn the sparse checkout off (git sparse-checkout disable), and try again`,
      paths: [],
      pathCount: 0,
    };
  }
  const outside = [...new Set(found)].sort();
  if (outside.length === 0) return null;
  const what = operation === "delivery" ? "this result changes" : "this revert must change";
  return {
    code: "delivery_outside_sparse_checkout",
    message:
      `${outside.length} path(s) ${what} are outside this checkout's sparse-checkout patterns, so nothing was written; widen the sparse checkout (git sparse-checkout add) to include them and try again: ${outside.slice(0, 20).join(", ")}`.slice(
        0,
        4_000,
      ),
    paths: outside.slice(0, 200),
    pathCount: outside.length,
  };
}
