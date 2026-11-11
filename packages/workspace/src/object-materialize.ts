import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readlinkSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitResultRefusal } from "@claudexor/schema";
import {
  classifyGitFailure,
  diskProgress,
  gitObserved,
  GitOperationError,
  proofStallMs,
  type GitOperationFailureCode,
} from "./git-observed.js";
import { withDisposableScratch, type HeldScratch } from "./cleanup-fault.js";
import { lstatPresent } from "./fs-presence.js";
import { SCRATCH_INDEX_CONFIG, STAT_TRUST_OFF } from "./git-run.js";
import { markedEntries } from "./git-snapshot.js";
import { parseRawRecords, type RawRecord } from "./object-compose.js";
import { aliasJudge, byFold, foldsOnto, occupiedPaths } from "./object-occupied.js";
import { sparseCheckoutRefusal } from "./object-sparse.js";
import { assertSpaceFor } from "./object-transfer.js";

export interface MaterializeInput {
  /** Top-level directory of the worktree to update. */
  worktree: string;
  /** Tree the worktree holds now (the delivery's T, a revert's S). */
  from: string;
  /** Tree to write (the delivery's M, a revert's R). */
  to: string;
  /** `temporary`: the user's index stays untouched (apply-only, revert);
   * `real`: index and worktree move together (commit-class delivery). */
  index: "temporary" | "real";
}

export type MaterializeResult =
  | { ok: true; changed: number; treeMutated: boolean }
  | {
      ok: false;
      refusal: GitResultRefusal;
      /** The target no longer holds `from`, whatever part of `to` reached it. */
      treeMutated: boolean;
      /** Written paths whose content proof failed or could not run. */
      unproven?: string[];
    };

const GIT_FAULT_REFUSAL: Partial<Record<GitOperationFailureCode, GitResultRefusal["code"]>> = {
  capture_space_insufficient: "space_insufficient",
  capture_git_stalled: "git_stalled",
  capture_git_signal: "git_signal",
};

/** The typed refusal of a Git child's failure on an object path. */
export function gitFaultRefusalCode(code: GitOperationFailureCode): GitResultRefusal["code"] {
  return GIT_FAULT_REFUSAL[code] ?? "git_failed";
}

/** A Git child's typed failure, or a filesystem fault as one (its scratch: a full disk). */
function gitOrFilesystemFault(error: unknown): GitOperationError | null {
  if (error instanceof GitOperationError) return error;
  const errno = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof errno !== "string") return null;
  return new GitOperationError(
    errno === "ENOSPC" || errno === "EDQUOT" ? "capture_space_insufficient" : "capture_failed",
    (error as Error).message,
  );
}

export { proofStallMs } from "./git-observed.js";

/** How `read-tree -m -u` refuses before its first write (its checks run first;
 * object-path Git speaks the C locale). It only names the refusal: whether the
 * checkout wrote anything is measured (`wroteAny`), since a path name in a
 * partial checkout's message can read like a refusal. */
const REFUSED_BEFORE_WRITE =
  /not uptodate|would be overwritten|would be removed|would lose untracked|Cannot merge|index\.lock|failed to unpack tree|Refusing to remove/i;

/** What lstat sees at `path` (a checkout replaces a file it writes, so its
 * identity changes; nothing is re-hashed through a filter). */
function stamp(worktree: string, path: string): string {
  try {
    const stat = lstatSync(join(worktree, path), { bigint: true, throwIfNoEntry: false });
    return stat
      ? `${stat.mode}:${stat.size}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`
      : "absent";
  } catch (error) {
    return `error:${(error as NodeJS.ErrnoException).code ?? "unknown"}`;
  }
}

/** A Git child of one checkout, in its scratch index (when it has one). */
type ScopedGit = (
  args: string[],
  label: string,
  extra?: { allowFailure?: boolean; input?: string; stallMs?: number },
) => ReturnType<typeof gitObserved>;

/** What lstat sees at `paths` in bytes (what a refresh reads at most). */
function diskBytes(worktree: string, paths: readonly string[]): number {
  let bytes = 0;
  for (const path of paths) {
    try {
      bytes += lstatSync(join(worktree, path), { throwIfNoEntry: false })?.size ?? 0;
    } catch {
      // Unreadable here: Git will say so when it gets there.
    }
  }
  return bytes;
}

/**
 * Refuse a checkout that cannot fit, before its first write: it would stop partway,
 * and its take-back needs space too. A replaced file makes room just before its
 * new content is written, so each path needs only what it grows by; a filter can
 * change sizes, which the margin of `assertSpaceFor` covers. Returns the new bytes.
 */
async function assertWriteFits(
  worktree: string,
  records: readonly RawRecord[],
  git: ScopedGit,
): Promise<number> {
  const written = records.filter((record) => /^(?:100|120)/.test(record.newMode));
  if (written.length === 0) return 0;
  const listed = await git(
    ["cat-file", "--batch-check=%(objectname) %(objectsize)"],
    "cat-file --batch-check (checkout)",
    { input: `${[...new Set(written.map((record) => record.newOid))].join("\n")}\n` },
  );
  const sizes = new Map(
    listed.stdout
      .split("\n")
      .map((line) => line.split(" "))
      .filter(([, size]) => size && /^\d+$/.test(size))
      .map(([oid, size]) => [oid!, Number(size)]),
  );
  let total = 0;
  let growth = 0;
  for (const record of written) {
    const size = sizes.get(record.newOid) ?? 0;
    total += size;
    growth += Math.max(0, size - diskBytes(worktree, [record.src]));
  }
  assertSpaceFor(worktree, growth, "the checkout");
  return total;
}

function refusal(code: GitResultRefusal["code"], message: string, paths: string[] = []) {
  const sorted = [...new Set(paths)].sort();
  return {
    code,
    message: message.slice(0, 4_000),
    paths: sorted.slice(0, 200),
    pathCount: sorted.length,
  };
}

/** The refusal of a write over what Git does not track, naming it. */
function occupiedRefusal(worktree: string, records: readonly RawRecord[]): GitResultRefusal | null {
  const occupied = occupiedPaths(worktree, records);
  return occupied.length === 0
    ? null
    : refusal(
        "delivery_path_occupied",
        `a path this operation writes holds what Git does not track (an ignored file, for one), and writing would destroy it; nothing was written: ${occupied.slice(0, 20).join(", ")}`,
        occupied,
      );
}

/** The same refusals for a dry run: what a checkout from `from` to `to` would answer
 * here before writing (a path holding what Git does not track, or one outside the
 * sparse-checkout patterns). */
export async function occupiedByWrite(
  worktree: string,
  from: string,
  to: string,
  env: Record<string, string> = {},
): Promise<GitResultRefusal | null> {
  const listed = await gitObserved(
    worktree,
    ["diff-tree", "-r", "--raw", "-z", "--no-renames", "--no-abbrev", from, to],
    { env, label: "diff-tree --raw (dry run)" },
  );
  const records = parseRawRecords(listed.stdout);
  return (
    occupiedRefusal(worktree, records) ??
    (await sparseCheckoutRefusal(
      worktree,
      records.map((record) => record.src),
      "delivery",
      env,
    ))
  );
}

/**
 * Write `to` over a worktree that holds `from` (rev 11 C): a two-tree
 * `read-tree -m -u` that refuses "not uptodate" when a path it must change no
 * longer holds `from` (a live preimage recheck) and streams big blobs to disk.
 * It runs with the sparse-checkout patterns off: with them on, Git reapplies them
 * to every entry and deletes a clean file outside them that holds no skip-worktree
 * mark (a conflict resolved there), a path this write never addressed. Off, only
 * the paths `from` and `to` differ in move; every other entry keeps its file, and its
 * mark unless Git itself clears it (Git clears the skip-worktree mark of a present
 * file when it reads a sparse checkout's index). What Git does not track is refused
 * first: a file at a path `to` adds (ignored, so outside `from`) would be
 * overwritten, and no revert could bring it back. So is an addressed path outside
 * the patterns: a snapshot's `add -A` skips it, so neither a take-back nor a revert
 * could tell what it holds. A write that cannot fit refuses too, with nothing
 * written. Afterwards every written path is proven by content, the way `git status`
 * compares it (Git's clean conversion through an index), not by a stat refresh.
 * Its temporary index's scratch goes last, never replacing the outcome.
 */
export function materializeTree(input: MaterializeInput): Promise<MaterializeResult> {
  return withDisposableScratch((held) => writeTree(input, held));
}

async function writeTree(input: MaterializeInput, held: HeldScratch): Promise<MaterializeResult> {
  const env: Record<string, string> = { GIT_OPTIONAL_LOCKS: "0" };
  // A checkout writes files without stdout: disk activity is its progress.
  const progress = diskProgress(input.worktree);
  // The real index keeps the user's form, but no stat shortcut decides for it either.
  const git: ScopedGit = (args, label, extra = {}) =>
    gitObserved(input.worktree, [...(held.dir ? SCRATCH_INDEX_CONFIG : STAT_TRUST_OFF), ...args], {
      env,
      label,
      progress,
      ...extra,
    });
  let records: RawRecord[];
  let paths: string[];
  let writtenBytes: number;
  const before = new Map<string, string>();
  try {
    if (input.index === "temporary")
      held.dir = mkdtempSync(join(tmpdir(), "claudexor-materialize-"));
    records = parseRawRecords(
      (
        await git(
          ["diff-tree", "-r", "--raw", "-z", "--no-renames", "--no-abbrev", input.from, input.to],
          "diff-tree --raw",
        )
      ).stdout,
    );
    if (records.length === 0) return { ok: true, changed: 0, treeMutated: false };
    paths = records.map((record) => record.src);
    const blocked =
      occupiedRefusal(input.worktree, records) ??
      (await sparseCheckoutRefusal(input.worktree, paths, "delivery", env));
    if (blocked) return { ok: false, treeMutated: false, refusal: blocked };
    writtenBytes = await assertWriteFits(input.worktree, records, git);
    if (held.dir) await seedScratchIndex(input, held.dir, records, env, git);
    // The real index keeps the user's assume-unchanged marks, so its refresh
    // compares an entry whose stat moved by content, mark or not (the checkout
    // stat-checks a marked entry it replaces): an unchanged file is not "not uptodate".
    // Git drops the mark of an entry whose file changed, a local edit the user keeps
    // out of commits: those marks are put back. A marked name stdin cannot carry
    // back keeps the plain refresh, where a stale mark refuses before writing.
    const marks = held.dir ? null : await markedEntries(input.worktree, env);
    const refresh = marks && marks.unnamed === 0 ? "--really-refresh" : "--refresh";
    await git(["update-index", "-q", refresh], `update-index ${refresh}`, {
      allowFailure: true,
      stallMs: proofStallMs(diskBytes(input.worktree, paths)),
    });
    if (refresh === "--really-refresh" && marks && marks.assumed.length > 0)
      await git(
        ["update-index", "--assume-unchanged", "-z", "--stdin"],
        "update-index --assume-unchanged",
        { input: marks.assumed.map((path) => `${path}\0`).join("") },
      );
    for (const path of paths) before.set(path, stamp(input.worktree, path));
  } catch (error) {
    const fault = gitOrFilesystemFault(error);
    if (!fault) throw error;
    // Nothing has been written yet: the fault is the whole answer.
    return {
      ok: false,
      treeMutated: false,
      refusal: refusal(gitFaultRefusalCode(fault.code), fault.message),
    };
  }
  let moved: Awaited<ReturnType<typeof git>>;
  try {
    moved = await git(
      ["read-tree", "--no-sparse-checkout", "-m", "-u", input.from, input.to],
      "read-tree -m -u",
      { allowFailure: true, stallMs: proofStallMs(writtenBytes) },
    );
  } catch (error) {
    if (!(error instanceof GitOperationError)) throw error;
    // A stalled or killed checkout: part of `to` may have reached the target.
    return {
      ok: false,
      treeMutated: true,
      refusal: refusal(gitFaultRefusalCode(error.code), error.message, paths),
    };
  }
  if (moved.code !== 0) {
    const stderr = moved.stderr.trim();
    const wrote = await wroteAny(input, before, env);
    if (!wrote && REFUSED_BEFORE_WRITE.test(stderr))
      return {
        ok: false,
        treeMutated: false,
        refusal: refusal(
          "delivery_target_changed",
          `the target changed under paths this operation writes: ${stderr}`,
          paths,
        ),
      };
    return {
      ok: false,
      treeMutated: wrote,
      refusal: refusal(
        gitFaultRefusalCode(classifyGitFailure(stderr)),
        `${wrote ? "the checkout stopped partway" : "the checkout failed before writing"}: ${stderr}`,
        paths,
      ),
    };
  }
  let mismatched: string[];
  try {
    mismatched = await contentMismatches(input.worktree, records, env);
  } catch (error) {
    const fault = gitOrFilesystemFault(error);
    if (!fault) throw error;
    return {
      ok: false,
      treeMutated: true,
      unproven: paths,
      refusal: refusal(
        gitFaultRefusalCode(fault.code),
        `the written paths could not be proven: ${fault.message}`,
        paths,
      ),
    };
  }
  if (mismatched.length > 0) {
    return {
      ok: false,
      treeMutated: true,
      unproven: mismatched,
      refusal: refusal(
        "delivery_content_mismatch",
        "written paths do not hold the delivered content after checkout conversion",
        mismatched,
      ),
    };
  }
  return { ok: true, changed: records.length, treeMutated: true };
}

/**
 * Point `GIT_INDEX_FILE` at a scratch index holding `from` that keeps the stat
 * cache of the user's index, so the refresh before the checkout costs what
 * `git status` costs instead of re-hashing every tracked file. The user's
 * index path is resolved first (`--git-path index` honours `GIT_INDEX_FILE`);
 * only that file is read, never its lock, and it is copied whole under a
 * private name before use. A user's index that cannot seed (none yet,
 * unmerged, unreadable) leaves a plain read of `from`. The paths this checkout
 * replaces or removes are then re-added without stat data, so the refresh
 * compares exactly those by content through the target's own conversion, as
 * an index without any stat cache did: a path that does not hold `from` stays
 * "not uptodate" and the checkout refuses before writing. A re-added entry carries
 * none of the user's assume-unchanged or skip-worktree marks, and the scratch
 * trusts no stat shortcut (`SCRATCH_INDEX_CONFIG`): with `core.ignoreStat` every
 * re-added entry would be assume-valid, its content never compared.
 */
async function seedScratchIndex(
  input: MaterializeInput,
  scratch: string,
  records: RawRecord[],
  env: Record<string, string>,
  git: ScopedGit,
): Promise<void> {
  const located = await git(
    ["rev-parse", "--path-format=absolute", "--git-path", "index"],
    "rev-parse index",
    { allowFailure: true },
  );
  const userIndex = located.code === 0 ? located.stdout.trim() : "";
  const scratchIndex = join(scratch, "index");
  env["GIT_INDEX_FILE"] = scratchIndex;
  let seeded = false;
  if (userIndex && existsSync(userIndex)) {
    try {
      copyFileSync(userIndex, `${scratchIndex}.copy`);
      renameSync(`${scratchIndex}.copy`, scratchIndex);
      seeded =
        (await git(["read-tree", "-m", input.from], "read-tree -m (seed)", { allowFailure: true }))
          .code === 0;
    } catch {
      seeded = false;
    }
  }
  if (!seeded) {
    rmSync(scratchIndex, { force: true });
    await git(["read-tree", input.from], "read-tree (seed)");
  }
  const replaced = records.filter((record) => record.oldMode !== "000000");
  if (replaced.length > 0)
    await git(["update-index", "-z", "--index-info"], "update-index --index-info", {
      input: replaced
        .map((record) => `${record.oldMode} ${record.oldOid}\t${record.src}\0`)
        .join(""),
    });
}

/**
 * After a failed checkout: did it write anything? Every path it would write
 * must be as lstat saw it just before (type, mode, size, inode, times), and a
 * real index must still be `from`. Nothing is re-hashed: a filter that does not
 * round-trip would make an untouched file look written. A measurement that
 * cannot run counts as written.
 */
async function wroteAny(
  input: MaterializeInput,
  before: Map<string, string>,
  env: Record<string, string>,
): Promise<boolean> {
  try {
    for (const [path, was] of before) if (stamp(input.worktree, path) !== was) return true;
    if (input.index === "temporary") return false;
    const index = await gitObserved(input.worktree, ["write-tree"], { env, label: "write-tree" });
    return index.stdout.trim() !== input.from;
  } catch {
    return true;
  }
}

/**
 * Written paths whose content differs from their entries, compared as `git status`
 * compares them: with the blob in the index, so a committed CRLF blob keeps its CR
 * (`hash-object` loads no index and would call it changed). A private copy of the
 * index the checkout just moved keeps every other path's stat cache; the written
 * paths are re-added without stat data or the user's marks, so the refresh reads
 * exactly those, whatever `core.ignoreStat` or a filesystem monitor would answer
 * (`SCRATCH_INDEX_CONFIG`). A filter that does not round-trip still reads as different.
 */
async function indexProofMismatches(
  worktree: string,
  records: readonly RawRecord[],
  env: Record<string, string>,
  bytes: number,
): Promise<string[]> {
  if (records.length === 0) return [];
  const located = await gitObserved(
    worktree,
    ["rev-parse", "--path-format=absolute", "--git-path", "index"],
    { env, label: "rev-parse index (proof)", allowFailure: true },
  );
  const moved = located.code === 0 ? located.stdout.trim() : "";
  const scratch = mkdtempSync(join(tmpdir(), "claudexor-proof-"));
  const proofEnv = { ...env, GIT_INDEX_FILE: join(scratch, "index") };
  const git = (args: string[], label: string, extra: { input?: string; stallMs?: number } = {}) =>
    gitObserved(worktree, [...SCRATCH_INDEX_CONFIG, ...args], {
      env: proofEnv,
      label,
      ...extra,
    });
  try {
    if (moved && existsSync(moved)) copyFileSync(moved, proofEnv.GIT_INDEX_FILE);
    await git(
      ["update-index", "--add", "-z", "--index-info"],
      "update-index --index-info (proof)",
      {
        input: records
          .map((record) => `${record.newMode} ${record.newOid}\t${record.src}\0`)
          .join(""),
      },
    );
    await git(["update-index", "-q", "--refresh"], "update-index --refresh (proof)", {
      stallMs: proofStallMs(bytes),
    });
    const listed = await git(["diff-files", "--name-only", "-z"], "diff-files (proof)");
    const different = new Set(listed.stdout.split("\0").filter(Boolean));
    return records.filter((record) => different.has(record.src)).map((record) => record.src);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * One `--stdin-paths` line naming `path` exactly. Git reads a line that starts
 * with `"` as a C-quoted name and strips a trailing CR, so such names (and any
 * with control characters) are quoted the way Git's unquote_c_style reads them;
 * every other name, backslashes included, is taken verbatim.
 */
function stdinPathLine(path: string): string {
  if (!/^"|[\x00-\x1f\x7f]/.test(path)) return path;
  const escapes: Record<string, string> = {
    '"': '\\"',
    "\\": "\\\\",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
  };
  let quoted = '"';
  for (const char of path) {
    if (escapes[char]) quoted += escapes[char];
    else if (/[\x00-\x1f\x7f]/.test(char))
      quoted += `\\${char.charCodeAt(0).toString(8).padStart(3, "0")}`;
    else quoted += char;
  }
  return `${quoted}"`;
}

/** Paths whose worktree content or mode differs from the tree just written; a path
 * that cannot be looked at throws, and its caller refuses the write as unproven. */
async function contentMismatches(
  worktree: string,
  records: RawRecord[],
  env: Record<string, string>,
): Promise<string[]> {
  const mismatched: string[] = [];
  const hashed: RawRecord[] = [];
  let hashedBytes = 0;
  // Symlinks checked out as plain files holding their target (core.symlinks=false).
  const linkFiles: RawRecord[] = [];
  // On a filesystem that folds case, a removed path can read as the file written
  // under its other spelling: one entry, not a survivor (a hard link is no alias).
  const removedThere: string[] = [];
  const boolConfig = async (key: string) =>
    (
      await gitObserved(worktree, ["config", "--bool", key], {
        env,
        label: `config ${key}`,
        allowFailure: true,
      })
    ).stdout.trim() !== "false";
  const fileMode = await boolConfig("core.fileMode");
  const symlinks = await boolConfig("core.symlinks");
  for (const record of records) {
    const path = join(worktree, record.src);
    // Only ENOENT and ENOTDIR say a path is gone: any other error (an I/O error, a
    // parent that can no longer be searched) leaves the write unproven, never a
    // removal proven by not looking.
    const stat = lstatPresent(path);
    if (record.status === "D") {
      if (stat && !stat.isDirectory()) removedThere.push(record.src);
      continue;
    }
    if (record.newMode === "160000") continue; // a gitlink is another repository's commit
    if (!stat) {
      mismatched.push(record.src);
      continue;
    }
    if (record.newMode === "120000") {
      if (!symlinks) {
        // Git writes the link target's exact bytes, unconverted, as a plain file.
        if (stat.isFile()) linkFiles.push(record);
        else mismatched.push(record.src);
        continue;
      }
      const blob = await gitObserved(worktree, ["cat-file", "blob", record.newOid], {
        env,
        label: "cat-file blob",
      });
      if (!stat.isSymbolicLink() || readlinkSync(path) !== blob.stdout) mismatched.push(record.src);
      continue;
    }
    if (!stat.isFile()) {
      mismatched.push(record.src);
      continue;
    }
    if (fileMode && ((stat.mode & 0o100) !== 0) !== (record.newMode === "100755")) {
      mismatched.push(record.src);
      continue;
    }
    hashed.push(record);
    hashedBytes += stat.size;
  }
  if (removedThere.length > 0) {
    const judge = aliasJudge(worktree);
    const written = byFold(records.filter((record) => record.status !== "D").map((r) => r.src));
    for (const path of removedThere) if (!foldsOnto(judge, written, path)) mismatched.push(path);
  }
  mismatched.push(...(await indexProofMismatches(worktree, hashed, env, hashedBytes)));
  // Link files hold their target's exact bytes, unconverted, one line each on stdin.
  for (let index = 0; index < linkFiles.length; index += 500) {
    const chunk = linkFiles.slice(index, index + 500);
    const out = await gitObserved(worktree, ["hash-object", "--no-filters", "--stdin-paths"], {
      env,
      label: "hash-object --stdin-paths",
      input: `${chunk.map((record) => stdinPathLine(record.src)).join("\n")}\n`,
    });
    const oids = out.stdout.trim().split("\n");
    chunk.forEach((record, at) => {
      if (oids[at] !== record.newOid) mismatched.push(record.src);
    });
  }
  return mismatched;
}
