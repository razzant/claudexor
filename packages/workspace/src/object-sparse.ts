import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceError } from "@claudexor/core";
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

/** The base of a capture, as its scratch index (`GIT_INDEX_FILE`) was read from it: the
 * `treeish`, the pathspec the capture covers where it runs (`scope`), and the boundary
 * commit of a base that is a dirty snapshot (null when it is none). */
export interface SparseCaptureBase {
  treeish: string;
  scope: readonly string[];
  boundary: string | null;
}

/** The files the capture's base added to its own boundary commit, within the capture's
 * pathspec, as their bytes: what an earlier dirty snapshot took in. The scratch index
 * holds the base here, and a commit link is never listed. */
async function addedByBase(
  cwd: string,
  env: Record<string, string>,
  boundary: string,
  scope: readonly string[],
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
      boundary,
      "--",
      ...scope,
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

/** Each NUL-terminated record of a streamed `-z` listing, as its bytes. */
function nulRecords(take: (record: Buffer) => void) {
  let carry = Buffer.alloc(0);
  return {
    write(chunk: Buffer) {
      const data = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
      let start = 0;
      for (let end = data.indexOf(0); end !== -1; end = data.indexOf(0, start)) {
        take(data.subarray(start, end));
        start = end + 1;
      }
      carry = Buffer.from(data.subarray(start));
    },
    end: () => "",
  };
}

/** A listing by the checkout's own Git: at the top, on its own index (the scratch one
 * lacks the `.gitignore` files the patterns leave out), trusting no stat shortcut, given
 * no pathspec. Asking for names cannot be made literal: `check-ignore` and `ls-files` read
 * a name as a pathspec (a glob stands for its tracked neighbour, and the walk begins at the
 * paths' common prefix, below a `.gitignore` above it), and the backslash that escapes a
 * glob character is part of the string the ignore rules then match. So the whole listing is
 * streamed and each name is looked up as bytes. */
const CHECKOUT_LISTING = [...STAT_TRUST_OFF, "-c", "core.untrackedCache=false", "ls-files", "-z"];

/**
 * The names (bytes, as {@link listedNames} gives them) of the files the checkout's own Git
 * lists as untracked and not ignored: one `ls-files -z --others --exclude-standard`. Git
 * walks the worktree as `status` does, skips ignored directories, reads every `.gitignore`
 * on the way (one the patterns leave out from that index) and prints each untracked name its
 * rules do not ignore; another repository is a directory entry, left out.
 */
async function checkoutUntracked(
  top: string,
  env: Record<string, string>,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const names = new Set<string>();
  await gitObserved(top, [...CHECKOUT_LISTING, "--others", "--exclude-standard"], {
    env: checkoutEnv(env),
    label: "ls-files --others (checkout)",
    signal,
    stdout: nulRecords((record) => {
      if (record.length > 0 && record[record.length - 1] !== 0x2f)
        names.add(record.toString("latin1"));
    }),
  });
  return names;
}

/** An entry of the checkout's own index: its `ls-files -t` tag (`S` where the index marks
 * it skip-worktree) and, for a merged entry that is no commit link, its mode and blob as
 * `update-index --index-info` reads them. */
interface CheckoutEntry {
  tag: string;
  info?: string;
}

/** The entries of the checkout's own index for `names` (bytes), from one streamed
 * `ls-files -t -s -z --cached`. */
async function checkoutEntries(
  top: string,
  names: ReadonlySet<string>,
  env: Record<string, string>,
  signal?: AbortSignal,
): Promise<Map<string, CheckoutEntry>> {
  const entries = new Map<string, CheckoutEntry>();
  await gitObserved(top, [...CHECKOUT_LISTING, "-t", "-s", "--cached"], {
    env: checkoutEnv(env),
    label: "ls-files -t -s (checkout)",
    signal,
    stdout: nulRecords((record) => {
      // "<tag> <mode> <oid> <stage>\t<name>", a tag being one character.
      const tab = record.indexOf(0x09);
      if (tab < 2) return;
      const name = record.subarray(tab + 1).toString("latin1");
      if (!names.has(name)) return;
      const [mode, oid, stage] = record.subarray(2, tab).toString("latin1").split(" ");
      entries.set(name, {
        tag: String.fromCharCode(record[0] ?? 0),
        ...(stage === "0" && mode !== "160000" ? { info: `${mode} ${oid}` } : {}),
      });
    }),
  });
  return entries;
}

/**
 * Of `names` (bytes), those the capture's own pathspec selects that its base does not hold,
 * as Git decides both: one `update-index --index-info` writes them, each with the empty
 * blob's name (no object is written or read), into an index of their own beside the scratch
 * one, and one `diff-index --cached --diff-filter=A` against the base, run where the capture
 * runs, lists those the pathspec selects and the base lacks.
 */
async function addedWithinScope(
  cwd: string,
  env: Record<string, string>,
  names: readonly string[],
  base: SparseCaptureBase,
  signal?: AbortSignal,
): Promise<string[]> {
  const scratch = env["GIT_INDEX_FILE"];
  if (!scratch) throw new WorkspaceError("a sparse capture needs its scratch index");
  const empty = (
    await gitObserved(cwd, ["hash-object", "--stdin"], {
      env,
      input: "",
      label: "hash-object (empty blob)",
      signal,
    })
  ).stdout.replace(/\n$/, "");
  const own = { ...env, GIT_INDEX_FILE: `${scratch}.visible` };
  try {
    await gitObserved(cwd, [...SCRATCH_INDEX_CONFIG, "update-index", "--index-info"], {
      env: own,
      label: "update-index --index-info (names in scope)",
      input: names.map((name) => `100644 ${empty}\t${quotedNames([name])}`).join(""),
      signal,
    });
    const listed = await gitObserved(
      cwd,
      [
        ...SCRATCH_INDEX_CONFIG,
        ...QUOTED_NAMES,
        "diff-index",
        "--cached",
        "--name-only",
        "--no-renames",
        "--diff-filter=A",
        base.treeish,
        "--",
        ...base.scope,
      ],
      { env: own, label: "diff-index (names in scope)", signal },
    );
    return listedNames(listed.stdout);
  } finally {
    rmSync(own.GIT_INDEX_FILE, { force: true });
  }
}

/** The bytes of `name` (as {@link listedNames} gives them) below `top`: a path for a
 * file-system call, one whose name is not UTF-8 included. */
function namePath(top: string, name: string): string | Buffer {
  const text = nameText(name);
  return text === null
    ? Buffer.concat([Buffer.from(`${top}/`), Buffer.from(name, "latin1")])
    : join(top, text);
}

/**
 * Before a capture's own `add -A`, take into its scratch index (`env`) the new files that
 * `add -A` cannot take as the checkout's own Git sees them (#734), and what an earlier dirty
 * snapshot took in out there. A checkout that is not sparse costs one `git config`, and one
 * whose Git cannot evaluate the patterns (older than 2.41) keeps `add -A`'s answer.
 *
 * - The `untracked` files the capture listed against that index (their bytes) that the
 *   sparse-checkout patterns leave out: `add -A` refuses each, failing the capture.
 * - The files the checkout's own Git lists as new where that index's Git ignores them, inside
 *   the patterns or out, within the capture's pathspec and absent from its base (`base`): a
 *   `.gitignore` the patterns leave out un-ignores them, which only the checkout's own index
 *   reads, and `add -A` skips them.
 * - The files `base` added to its own boundary commit, within the capture's pathspec, that the
 *   patterns leave out: a file an earlier snapshot took in, whose edit or removal `add -A`
 *   would skip. One the worktree lacks while the checkout's own index marks it skip-worktree
 *   is that index's entry, mode and blob, as the clean check of a snapshot reads it: the
 *   checkout leaves it out, nobody removed it (a worktree made on the snapshot is a sparse
 *   checkout too and leaves every file outside its patterns absent), and its content is what
 *   that index holds, a commit made since included. One absent without that mark is a removal.
 *
 * Nothing else out there is read, wherever HEAD is by now: every other tracked path stays as
 * `add -A` leaves it, the base's, absent as a sparse checkout leaves it or present (`add
 * --sparse -A` would record each absent one as deleted). One `update-index --add --remove`
 * reads the files as Git reads any file, conversion included, under the stall bound of the
 * caller's `add -A` (`watch`), and one `update-index --index-info` sets the entries the
 * checkout's own index holds. The new names go first, so they replace no entry: a new file
 * where the base holds a directory, or below a path the base holds as a file, fails the
 * capture. Names travel as Git's own quoted lines, byte for byte, and absence is read by the
 * bytes of a name. A new file is not taken, and so still fails the capture, when the
 * checkout's own Git ignores it (it lists the file nowhere) or when its name is not UTF-8.
 * Nor is one below a directory that became another repository where the base has files, and
 * a file the base took in below one stays as the base has it: those repositories are
 * returned, for the caller to leave out of its `add -A` and to name (a base file whose name
 * is not UTF-8 cannot be looked up, and is followed as before). A base file is followed
 * whatever the checkout's Git ignores by now, as `add -A` follows a tracked one. A commit
 * link is never taken.
 *
 * `space`: the capture's free-space preflight, asked before anything is written to count
 * also the files this step takes, among them one the user's Git ignores by now, which the
 * `git status` it estimated from does not list.
 */
export async function addOutsideSparseCheckout(
  cwd: string,
  env: Record<string, string>,
  untracked: readonly string[],
  base: SparseCaptureBase,
  watch: { progress: () => Promise<number>; stallMs: number },
  signal?: AbortSignal,
  space?: { alsoReading(paths: readonly string[]): void },
): Promise<string[]> {
  if (!(await sparsePatternsApply(cwd, env, signal))) return [];
  const later = base.boundary ? await addedByBase(cwd, env, base.boundary, base.scope, signal) : [];
  // Names are top-relative; `--show-cdup` is only `../` steps, so no path is parsed.
  // The physical directory, as Git's own `-C` resolves it: `link/..` is the link target's parent.
  const cdup = await gitObserved(cwd, ["rev-parse", "--show-cdup"], {
    env,
    label: "rev-parse --show-cdup",
    signal,
  });
  const top = join(realpathSync.native(cwd), cdup.stdout.trim());
  // What the checkout's own Git lists as new that the capture did not list against its base.
  const visible = await checkoutUntracked(top, env, signal);
  const listed = new Set([...untracked, ...later]);
  const unseen = [...visible].filter((name) => !listed.has(name));
  const unignored = unseen.length > 0 ? await addedWithinScope(cwd, env, unseen, base, signal) : [];
  if (untracked.length + later.length + unignored.length === 0) return [];
  const kept = checkRulesOutput(
    await gitObserved(top, [...QUOTED_NAMES, "sparse-checkout", "check-rules"], {
      env,
      label: "sparse-checkout check-rules",
      input: quotedNames([...untracked, ...later, ...unignored]),
      allowFailure: true,
      signal,
    }),
  );
  if (kept === null) return [];
  const inside = new Set(listedNames(kept));
  const texts = (names: readonly string[]) =>
    names.flatMap((name) => {
      const text = nameText(name);
      return text === null ? [] : [{ name, text }];
    });
  const fresh = [...texts(untracked.filter((name) => !inside.has(name))), ...texts(unignored)];
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
  const absent = new Set(
    followed
      .filter(({ name }) => lstatPresent(namePath(top, name)) === undefined)
      .map(({ name }) => name),
  );
  // A new file Git does not list as untracked is one the user staged, or one Git ignores.
  const asked = new Set([
    ...candidates.filter(({ name }) => !visible.has(name)).map(({ name }) => name),
    ...absent,
  ]);
  const entries =
    asked.size > 0
      ? await checkoutEntries(top, asked, env, signal)
      : new Map<string, CheckoutEntry>();
  const leftOut = (name: string) => absent.has(name) && entries.get(name)?.tag === "S";
  const taking = [
    // Git lists what it tracks and what it does not ignore: a name it lists nowhere is ignored.
    ...candidates.filter(({ name }) => visible.has(name) || entries.has(name)),
    // Absent, and marked skip-worktree: that checkout leaves the file out, nobody removed it,
    // and `--remove` would record a deletion.
    ...followed.filter(({ name }) => !leftOut(name)),
  ];
  const carried = followed.flatMap(({ name }) => {
    const info = leftOut(name) ? entries.get(name)?.info : undefined;
    return info ? [`${info}\t${quotedNames([name])}`] : [];
  });
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
  if (carried.length > 0)
    await gitObserved(top, [...SCRATCH_INDEX_CONFIG, "update-index", "--index-info"], {
      env,
      label: "update-index --index-info (left out by the checkout)",
      input: carried.join(""),
      signal,
    });
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
