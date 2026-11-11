import { gitObserved } from "./git-observed.js";
import { STAT_TRUST_OFF } from "./git-run.js";

/**
 * What a private clone (`isolatedCloneAdd`) lacks, said in the refusal that stops the
 * run or the verify before it starts (#501): file content its checkout left absent, or
 * content Git's copy of a shallow source must read. Everything here only reads, and
 * never fetches: a partial clone's missing objects stay missing.
 */

export interface AbsentFile {
  path: string;
  /** No object directory of the clone (its own, its source's, the store's) holds the content. */
  noContent: boolean;
}

const NEVER_FETCHED = "(a partial clone never fetched it, or a sparse checkout left it out)";
const WAYS =
  "make that content present there (a complete clone, or `git sparse-checkout disable` in " +
  "a sparse checkout), or run in place in that folder (`--in-place`, or an in-place thread)";
const REMEDIES = `Claudexor fetches nothing itself: ${WAYS}`;

function fileList(paths: string[]): string {
  const named = paths.slice(0, 20);
  const more = paths.length > named.length ? ` and ${paths.length - named.length} more` : "";
  return `${paths.length} file(s): ${named.join(", ")}${more}`;
}

/** Files a fresh checkout left absent. Their content is looked up without fetching:
 * the clone has no promisor remote. */
export async function absentAfterCheckout(clone: string): Promise<AbsentFile[]> {
  const list = (flag: string) =>
    gitObserved(clone, [...STAT_TRUST_OFF, "ls-files", flag, "-z"], {
      label: `ls-files ${flag} (isolated clone)`,
    }).then((listed) => listed.stdout.split("\0").filter(Boolean));
  const deleted = new Set(await list("--deleted"));
  if (deleted.size === 0) return [];
  const absent = new Map<string, string>(); // path -> its blob in the index
  for (const record of await list("--stage")) {
    const path = record.slice(record.indexOf("\t") + 1);
    if (deleted.has(path)) absent.set(path, record.split(" ")[1] ?? "");
  }
  const checked = await gitObserved(clone, ["cat-file", "--batch-check=%(objectname)"], {
    input: `${[...new Set(absent.values())].join("\n")}\n`,
    label: "cat-file --batch-check (isolated clone)",
  });
  const lacking = new Set(
    checked.stdout
      .split("\n")
      .filter((line) => line.endsWith(" missing"))
      .map((line) => line.slice(0, -" missing".length)),
  );
  return [...absent].map(([path, blob]) => ({ path, noContent: lacking.has(blob) }));
}

/** The refusal of a clone whose checkout left files absent. */
export function incompleteCloneMessage(
  repo: string,
  commit: string,
  absent: AbsentFile[],
  checkoutStderr: string,
): string {
  const files = fileList(absent.map((file) => file.path));
  if (!absent.every((file) => file.noContent))
    return `isolated clone checkout of ${commit} left ${files} absent: ${checkoutStderr.trim() || "Git reported no error"}`;
  return (
    `isolated clone of ${commit} is incomplete: neither ${repo} nor Claudexor's project store ` +
    `holds the content of ${files} ${NEVER_FETCHED}. ${REMEDIES}`
  );
}

/**
 * The refusal of a failed `git clone`: Git's full report, always first. Git copies a
 * shallow source through its transport, which must read every object HEAD, the branches
 * and the tags reach down to the shallow boundary, and a partial clone never fetched some
 * of them. When a shallow source lacks such objects, the refusal adds them (the files of
 * `commit` among them, else how many) as an observation: it does not prove the cause, since
 * the same copy can fail first on an occupied or unwritable destination, or Git may have
 * copied a linked worktree locally. A source that is not shallow, or lacks nothing, keeps
 * Git's report alone. The walk, unlike the store's no-walk inspection, also reads the
 * history between the tips and the boundary, which the copy must send as well.
 */
export async function cloneFailureMessage(
  repo: string,
  commit: string,
  stderr: string,
): Promise<string> {
  const reported = stderr.trim();
  const lacking = await lackedByShallowCopy(repo, commit).catch(() => null);
  return lacking
    ? `isolated clone of ${commit} failed; Git reported: ${reported}. Also observed, not ` +
        `proven as the cause: ${repo} ${lacking}. Claudexor fetches nothing itself; if this ` +
        `is the cause, ${WAYS}`
    : `isolated clone failed: ${reported}`;
}

async function lackedByShallowCopy(repo: string, commit: string): Promise<string | null> {
  const env = { GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" };
  const read = (args: string[], label: string) =>
    gitObserved(repo, args, { env, label, allowFailure: true });
  const shallow = await read(["rev-parse", "--is-shallow-repository"], "rev-parse shallow");
  if (shallow.stdout.trim() !== "true") return null;
  // `--missing=print` never fetches; HEAD, branches and tags are what the copy sends.
  const walked = await read(
    [
      "rev-list",
      "--objects",
      "--missing=print",
      "--no-object-names",
      "HEAD",
      "--branches",
      "--tags",
    ],
    "rev-list --missing=print (shallow copy)",
  );
  if (walked.code !== 0) return null;
  const missing = new Set(
    walked.stdout
      .split("\n")
      .filter((line) => line.startsWith("?"))
      .map((line) => line.slice(1).trim()),
  );
  if (missing.size === 0) return null;
  const listed = await read(
    ["ls-tree", "-r", "-z", "--full-tree", commit],
    "ls-tree (shallow copy)",
  );
  const paths =
    listed.code !== 0
      ? []
      : listed.stdout.split("\0").flatMap((entry) => {
          const tab = entry.indexOf("\t");
          const blob = entry.slice(0, tab).split(" ")[2] ?? "";
          return tab > 0 && missing.has(blob) ? [entry.slice(tab + 1)] : [];
        });
  const copy = "which Git's transport copy of a shallow source must read";
  if (paths.length > 0)
    return `does not hold the content of ${fileList(paths)} ${NEVER_FETCHED}, ${copy}`;
  const [first] = missing;
  return `does not hold ${missing.size} object(s) its branches and tags reach (first ${first}; a partial clone never fetched them), ${copy}`;
}
