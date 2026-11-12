import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { GitResultRefusal } from "@claudexor/schema";
import { diskProgress, fileSink, gitObserved } from "./git-observed.js";
import { SCRATCH_INDEX_CONFIG } from "./git-run.js";

/**
 * Settings pinned on every diff Claudexor generates for delivery (rev 13): only
 * what makes a patch unapplicable or misaddressed. Pairing (diff.renames,
 * diff.renameLimit) and hunk shape (diff.algorithm, diff.context, ...) stay
 * inherited from the repository, exactly as today's capture-time diff.
 */
export const PINNED_DIFF_CONFIG = [
  "-c",
  "diff.relative=false",
  "-c",
  "diff.suppressBlankEmpty=false",
];
export const PINNED_DIFF_FLAGS = [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--submodule=short",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

/** One `--raw -z` record. Pairing records (R/C) carry a source and a destination. */
export interface RawRecord {
  status: string;
  score: number | null;
  src: string;
  dst: string | null;
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
}

export function parseRawRecords(stdout: string): RawRecord[] {
  const fields = stdout.split("\0");
  const records: RawRecord[] = [];
  for (let index = 0; index < fields.length;) {
    const meta = fields[index];
    if (!meta) {
      index += 1;
      continue;
    }
    if (!meta.startsWith(":")) throw new Error(`unexpected raw diff record: ${meta.slice(0, 80)}`);
    const [oldMode = "", newMode = "", oldOid = "", newOid = "", statusField = ""] = meta
      .slice(1)
      .split(" ");
    const status = statusField.charAt(0);
    const score = statusField.length > 1 ? Number(statusField.slice(1)) : null;
    const pairing = status === "R" || status === "C";
    const src = fields[index + 1] ?? "";
    const dst = pairing ? (fields[index + 2] ?? "") : null;
    records.push({ status, score, src, dst, oldMode, newMode, oldOid, newOid });
    index += pairing ? 3 : 2;
  }
  return records;
}

export interface ComposeInput {
  /** Repository whose object database holds B, T and C (imported first). */
  repo: string;
  base: string;
  target: string;
  candidate: string;
  /** Extra environment (object directory overrides for tests are NOT used for user repos). */
  env?: Record<string, string>;
}

export interface ComposeStats {
  unmerged: number;
  discovery: boolean;
  closure: number;
  components: number;
  records: number;
}

export type ComposeResult =
  | { ok: true; tree: string; stats: ComposeStats }
  | { ok: false; refusal: GitResultRefusal; stats: ComposeStats };

function literal(path: string): string {
  return `:(literal,top)${path}`;
}

/** Pathspecs per Git command line: bounded by count AND by total characters, so
 * a batch stays well inside the ~32K-character Windows command line (Git, -C,
 * the repository path and the pinned flags take the rest). */
const PATH_BATCH = 200;
const PATH_BATCH_CHARS = 16_384;

/** Literal pathspecs for `paths`, in command-line-sized batches. */
export function pathspecBatches(paths: readonly string[]): string[][] {
  const out: string[][] = [];
  let batch: string[] = [];
  let chars = 0;
  for (const path of paths) {
    const spec = literal(path);
    if (
      batch.length >= PATH_BATCH ||
      (batch.length > 0 && chars + spec.length >= PATH_BATCH_CHARS)
    ) {
      out.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(spec);
    chars += spec.length + 1;
  }
  if (batch.length > 0) out.push(batch);
  return out;
}

function refusal(
  code: GitResultRefusal["code"],
  message: string,
  paths: readonly string[],
): GitResultRefusal {
  const sorted = [...new Set(paths)].sort();
  return {
    code,
    message: message.slice(0, 4_000),
    paths: sorted.slice(0, 200),
    pathCount: sorted.length,
  };
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/** The paths `to` changed from `from`, with what it holds for each (mode and blob; a
 * deletion's are zero), and those whose name is not valid UTF-8: Git's output is
 * read as UTF-8 and a pathspec is written as UTF-8, so such a name, read back with
 * U+FFFD, would reach the filesystem under another name. Each name's own bytes are
 * decoded strictly, so a name that really holds U+FFFD is valid like any other. */
async function changedPaths(
  repo: string,
  from: string,
  to: string,
  env: Record<string, string>,
): Promise<{ entries: Map<string, string>; undecodable: Set<string> }> {
  const chunks: Buffer[] = [];
  await gitObserved(
    repo,
    ["diff-tree", "-r", "--raw", "-z", "--no-renames", "--no-abbrev", from, to],
    {
      env,
      label: "diff-tree --raw",
      stdout: { write: (chunk) => void chunks.push(Buffer.from(chunk)), end: () => "" },
    },
  );
  const raw = Buffer.concat(chunks);
  // Without pairing every record is two fields, ":<modes> <oids> <status>" and its path.
  const undecodable = new Set<string>();
  for (let start = 0, field = 0; start < raw.length; field += 1) {
    const found = raw.indexOf(0, start);
    const end = found === -1 ? raw.length : found;
    if (field % 2 === 1) {
      const name = raw.subarray(start, end);
      try {
        STRICT_UTF8.decode(name);
      } catch {
        undecodable.add(name.toString("utf8"));
      }
    }
    start = end + 1;
  }
  const entries = new Map(
    parseRawRecords(raw.toString("utf8")).map((record) => [
      record.src,
      `${record.newMode} ${record.newOid}`,
    ]),
  );
  return { entries, undecodable };
}

/** Whether a directory prefix of `path` is in `paths`. */
function underAny(path: string, paths: ReadonlySet<string>): boolean {
  for (let cut = path.lastIndexOf("/"); cut > 0; cut = path.lastIndexOf("/", cut - 1))
    if (paths.has(path.slice(0, cut))) return true;
  return false;
}

/**
 * A tree holding exactly the entries of `paths` in `tree`. `paths` are read through
 * bounded pathspec batches and written from stdin, so a diff of two such trees is
 * limited to them by no command-line argument and without a pathspec's prefix
 * match, which also takes in every path below a name that is a directory on the
 * other side.
 */
async function reducedTree(
  tree: string,
  paths: readonly string[],
  scratch: string,
  run: (
    args: string[],
    label: string,
    extra?: { input?: string; index?: string },
  ) => Promise<{
    stdout: string;
  }>,
): Promise<string> {
  const wanted = new Set(paths);
  let info = "";
  for (const chunk of pathspecBatches(paths)) {
    const listing = await run(["ls-tree", "-r", "-z", tree, "--", ...chunk], "ls-tree (reduced)");
    for (const entry of listing.stdout.split("\0").filter(Boolean))
      if (wanted.has(entry.slice(entry.indexOf("\t") + 1))) info += `${entry}\0`;
  }
  const index = join(scratch, `reduced-${randomUUID()}`);
  await run(["update-index", "--add", "-z", "--index-info"], "update-index (reduced)", {
    input: info,
    index,
  });
  return (await run(["write-tree"], "write-tree (reduced)", { index })).stdout.trim();
}

/**
 * Compose candidate C (relative to base B) onto target T without Git merge
 * machinery (rev 14 A). Trivial paths come from a three-way read into a
 * temporary index; paths both sides changed, plus rename/copy endpoints the
 * target changed, get today's exact records applied with `git apply --cached`
 * onto T's entries. Rename/copy discovery runs only behind the gate. All
 * patch bytes flow through a file, never a JS string. The worktree is untouched.
 */
export async function composeOnTarget(input: ComposeInput): Promise<ComposeResult> {
  const scratch = mkdtempSync(join(tmpdir(), "claudexor-compose-"));
  const env = { ...input.env, GIT_INDEX_FILE: join(scratch, "index"), GIT_OPTIONAL_LOCKS: "0" };
  const stats: ComposeStats = {
    unmerged: 0,
    discovery: false,
    closure: 0,
    components: 0,
    records: 0,
  };
  // Index and object writes (read-tree, update-index, apply, write-tree) show as disk activity.
  const progress = diskProgress(input.repo);
  const git = (
    args: string[],
    label: string,
    extra: { allowFailure?: boolean; input?: string } = {},
  ) =>
    gitObserved(input.repo, [...SCRATCH_INDEX_CONFIG, ...args], { env, label, progress, ...extra });
  const reduced = (tree: string, paths: readonly string[]) =>
    reducedTree(tree, paths, scratch, (args, label, extra = {}) =>
      gitObserved(input.repo, [...SCRATCH_INDEX_CONFIG, ...args], {
        env: extra.index ? { ...env, GIT_INDEX_FILE: extra.index } : env,
        label,
        progress,
        ...(extra.input === undefined ? {} : { input: extra.input }),
      }),
    );
  try {
    const read = await git(
      ["read-tree", "-m", "-i", "--aggressive", input.base, input.target, input.candidate],
      "read-tree -m (three-way)",
      { allowFailure: true },
    );
    if (read.code !== 0) {
      return {
        ok: false,
        stats,
        refusal: refusal("delivery_conflict", `three-way read refused: ${read.stderr.trim()}`, []),
      };
    }
    const unmergedListing = await git(["ls-files", "-u", "-z"], "ls-files -u");
    const unmerged = new Set(
      unmergedListing.stdout
        .split("\0")
        .filter(Boolean)
        .map((entry) => entry.slice(entry.indexOf("\t") + 1)),
    );
    stats.unmerged = unmerged.size;
    // Step 2: the gate. Two tree comparisons; no blob is read.
    const targetListed = await changedPaths(input.repo, input.base, input.target, env);
    const candidateListed = await changedPaths(input.repo, input.base, input.candidate, env);
    const targetChanged = targetListed.entries;
    const candidateChanged = candidateListed.entries;
    // Only a name this operation addresses must be valid UTF-8: one the result changed,
    // or (below) one the closure takes in. Every other target entry stays byte-opaque,
    // moved only by Git's own tree reads.
    const undecodable = new Set([...targetListed.undecodable, ...candidateListed.undecodable]);
    const encodingRefusal = (addressed: Iterable<string>): ComposeResult | null => {
      const named = [...new Set(addressed)].filter((path) => undecodable.has(path));
      return named.length === 0
        ? null
        : {
            ok: false,
            stats,
            refusal: refusal(
              "result_path_encoding",
              "a path the result changes, or one this operation must address with it, has a name that is not valid UTF-8, so Claudexor cannot address it on the filesystem; nothing was written",
              named,
            ),
          };
    };
    const candidateRefusal = encodingRefusal(candidateChanged.keys());
    if (candidateRefusal) return candidateRefusal;
    const shared = [...targetChanged.keys()].some((path) => candidateChanged.has(path));
    if (!shared && unmerged.size === 0) {
      const tree = (await git(["write-tree"], "write-tree")).stdout.trim();
      return { ok: true, tree, stats };
    }
    stats.discovery = true;
    // Today's full record listing under the repository's own pairing config.
    const listed = await git(
      [
        ...PINNED_DIFF_CONFIG,
        "diff",
        "--raw",
        "-z",
        "--no-abbrev",
        ...PINNED_DIFF_FLAGS,
        input.base,
        input.candidate,
      ],
      "diff --raw (discovery)",
    );
    const records = parseRawRecords(listed.stdout);
    const pairing = records.filter((record) => record.dst !== null);
    // Step 3: closure over pairing records with an endpoint T changed or already in U,
    // and over everything either side changed below a path in U (a directory that
    // became a file travels with the deletions under it). A path both sides changed
    // alike stays out: T already holds its outcome.
    const u = new Set(unmerged);
    const changed = [...new Set([...targetChanged.keys(), ...candidateChanged.keys()])];
    for (let moved = true; moved;) {
      moved = false;
      for (const record of pairing) {
        const ends = [record.src, record.dst!];
        if (ends.some((path) => targetChanged.has(path) || u.has(path))) {
          for (const path of ends) {
            if (!u.has(path)) {
              u.add(path);
              moved = true;
            }
          }
        }
      }
      for (const path of changed) {
        if (u.has(path) || !underAny(path, u)) continue;
        if (targetChanged.get(path) === candidateChanged.get(path)) continue;
        u.add(path);
        moved = true;
      }
    }
    stats.closure = u.size;
    // The closure holds every pairing endpoint the patch addresses.
    const closureRefusal = encodingRefusal(u);
    if (closureRefusal) return closureRefusal;
    const patchFile = join(scratch, "u.patch");
    writeFileSync(patchFile, "");
    const append = async (args: string[], label: string) => {
      const part = join(scratch, `part-${stats.records}.patch`);
      const sink = fileSink(part);
      try {
        await gitObserved(input.repo, args, { env, label, stdout: sink, progress });
      } finally {
        sink.end();
      }
      stats.records += 1;
      appendPart(patchFile, part);
    };
    // Step 4: pairing components, regenerated record-exact and set-checked.
    const inU = pairing.filter((record) => u.has(record.src) && u.has(record.dst!));
    for (const component of pairingComponents(inU)) {
      stats.components += 1;
      const copies = component.some((record) => record.status === "C");
      const lowest = Math.min(...component.map((record) => record.score ?? 100));
      const pairingFlags = copies
        ? [`--find-copies=${lowest}%`, "--find-copies-harder"]
        : [`--find-renames=${lowest}%`];
      const kinds = [...new Set(component.map((record) => record.status))].sort().join("");
      const paths = [...new Set(component.flatMap((record) => [record.src, record.dst!]))];
      // A component cannot be split (its destinations would lose their sources), so
      // one too long for a command line is limited by two trees holding exactly
      // its paths, which show a diff the same file pairs.
      const limit = async (): Promise<string[]> =>
        pathspecBatches(paths).length <= 1
          ? [input.base, input.candidate, "--", ...paths.map(literal)]
          : [await reduced(input.base, paths), await reduced(input.candidate, paths)];
      const limited = await limit();
      const regenerated = parseRawRecords(
        (
          await git(
            [
              ...PINNED_DIFF_CONFIG,
              "diff",
              "--raw",
              "-z",
              "--no-abbrev",
              ...PINNED_DIFF_FLAGS,
              ...pairingFlags,
              `--diff-filter=${kinds}`,
              ...limited,
            ],
            "diff --raw (component)",
          )
        ).stdout,
      );
      const key = (record: RawRecord) =>
        `${record.status}${record.score}\0${record.src}\0${record.dst}`;
      const expected = new Set(component.map(key));
      const actual = new Set(regenerated.map(key));
      if (expected.size !== actual.size || [...expected].some((entry) => !actual.has(entry))) {
        return {
          ok: false,
          stats,
          refusal: refusal(
            "delivery_pairing_mismatch",
            "a path-limited regeneration of the result's rename/copy records did not reproduce them exactly",
            paths,
          ),
        };
      }
      await append(
        [
          ...PINNED_DIFF_CONFIG,
          "diff",
          "--binary",
          ...PINNED_DIFF_FLAGS,
          ...pairingFlags,
          `--diff-filter=${kinds}`,
          ...limited,
        ],
        "diff --binary (component)",
      );
    }
    // Step 5: non-pairing records over U minus rename endpoints minus copy destinations.
    const excluded = new Set<string>();
    for (const record of inU) {
      if (record.status === "R") excluded.add(record.src);
      excluded.add(record.dst!);
    }
    const plain = [...u].filter((path) => !excluded.has(path) && candidateChanged.has(path)).sort();
    if (plain.length > 0) {
      // Two trees of exactly these paths: each record once, none a prefix drags in.
      await append(
        [
          ...PINNED_DIFF_CONFIG,
          "diff",
          "--binary",
          "--no-renames",
          ...PINNED_DIFF_FLAGS,
          await reduced(input.base, plain),
          await reduced(input.candidate, plain),
        ],
        "diff --binary (records)",
      );
    }
    // Step 6: reset U to T's entries, then one all-or-nothing apply from the file.
    const zero = "0".repeat(input.base.length);
    let info = "";
    for (const path of u) info += `0 ${zero}\t${path}\0`;
    for (const chunk of pathspecBatches([...u])) {
      const listing = await git(
        ["ls-tree", "-r", "-z", input.target, "--", ...chunk],
        "ls-tree (target entries)",
      );
      for (const entry of listing.stdout.split("\0").filter(Boolean)) {
        const path = entry.slice(entry.indexOf("\t") + 1);
        if (u.has(path)) info += `${entry}\0`;
      }
    }
    await git(["update-index", "-z", "--index-info"], "update-index --index-info", { input: info });
    if (statSync(patchFile).size > 0) {
      const applied = await git(
        ["apply", "--cached", "--whitespace=nowarn", patchFile],
        "apply --cached",
        { allowFailure: true },
      );
      if (applied.code !== 0) {
        return {
          ok: false,
          stats,
          refusal: refusal(
            "delivery_conflict",
            `the result does not apply onto the current target by git apply rules: ${applied.stderr.trim()}`,
            [...u],
          ),
        };
      }
    }
    const remaining = await git(["ls-files", "-u", "-z"], "ls-files -u");
    if (remaining.stdout.length > 0) {
      const paths = remaining.stdout
        .split("\0")
        .filter(Boolean)
        .map((entry) => entry.slice(entry.indexOf("\t") + 1));
      return {
        ok: false,
        stats,
        refusal: refusal("delivery_conflict", "paths stayed unmerged after composition", paths),
      };
    }
    const tree = (await git(["write-tree"], "write-tree")).stdout.trim();
    return { ok: true, tree, stats };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Stream one patch part onto the composed patch file (bounded chunks, no string). */
function appendPart(target: string, part: string): void {
  if (!existsSync(part)) return;
  const size = statSync(part).size;
  if (size === 0) return;
  const fd = openSync(part, "r");
  try {
    const chunk = Buffer.alloc(1 << 20);
    for (let offset = 0; offset < size;) {
      const read = readSync(fd, chunk, 0, chunk.length, offset);
      if (read <= 0) break;
      appendFileSync(target, chunk.subarray(0, read));
      offset += read;
    }
  } finally {
    closeSync(fd);
  }
}

/** Group pairing records into components by shared endpoints (union-find on paths). */
function pairingComponents(records: readonly RawRecord[]): RawRecord[][] {
  const parent = new Map<string, string>();
  const find = (path: string): string => {
    let root = path;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    parent.set(path, root);
    return root;
  };
  for (const record of records) {
    for (const path of [record.src, record.dst!]) if (!parent.has(path)) parent.set(path, path);
    const a = find(record.src);
    const b = find(record.dst!);
    if (a !== b) parent.set(a, b);
  }
  const groups = new Map<string, RawRecord[]>();
  for (const record of records) {
    const root = find(record.src);
    groups.set(root, [...(groups.get(root) ?? []), record]);
  }
  return [...groups.values()];
}
