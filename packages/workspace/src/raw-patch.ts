import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseUnifiedDiff, WorkspaceError } from "@claudexor/core";
import type {
  HarnessEvent,
  RawContextPacket,
  RawGitPatchEnvelope,
  RawPatchRefusalCode,
} from "@claudexor/schema";
import { sha256 } from "@claudexor/util";
import { gitObserved } from "./git-observed.js";
import { gitEnv, SCRATCH_INDEX_CONFIG } from "./git-run.js";
import { transferObjects, type ObjectEndpoint } from "./object-transfer.js";
import { applyPatchProtected, git, materializePatchTree, revParse, snapshotTree } from "./git.js";

/**
 * The record of an envelope's accepted raw patches (#594), as per-worktree refs of the
 * envelope's own repository: the source repository and other worktrees never see them,
 * and they go with the envelope (a kept one, its successor's adoption and host-restart
 * recovery included). `RAW_ACCEPTED_REF` names a tree of exactly the paths accepted patches
 * wrote, as last written, never anything else the candidate held (a gate's output, a native
 * round's file). Before a patch's first byte reaches the worktree, one transaction writes
 * `RAW_PENDING_REF`, that tree with this patch's paths, and `RAW_PENDING_RESULT_REF`, the
 * exact tree the worktree holds once the patch applied whole; another then makes the pending
 * tree accepted. What either record tree names stays the candidate's, so no failure of the
 * record leaves written bytes unnamed.
 */
export const RAW_ACCEPTED_REF = "refs/worktree/claudexor/raw-accepted";
export const RAW_PENDING_REF = "refs/worktree/claudexor/raw-pending";
export const RAW_PENDING_RESULT_REF = "refs/worktree/claudexor/raw-pending-result";

/** The tree a record ref names, or null when there is none. One that exists but names no
 * readable tree, or that Git fails to look up, is thrown: never read as nothing accepted.
 * Git before 2.43 has no `show-ref --exists`, and there a failed lookup reads as absence. */
async function recordTree(worktreePath: string, ref: string): Promise<string | null> {
  let found = await git(worktreePath, ["show-ref", "--exists", ref]);
  if (found.code === 129) {
    const legacy = await git(worktreePath, ["rev-parse", "--verify", "--quiet", ref]);
    found = { ...legacy, code: legacy.code === 1 ? 2 : legacy.code };
  }
  if (found.code === 2) return null;
  if (found.code !== 0)
    throw new WorkspaceError(
      `accepted raw record ${ref} could not be read: ${found.stderr.trim()}`,
    );
  const tree = await git(worktreePath, ["rev-parse", "--verify", "--quiet", `${ref}^{tree}`]);
  if (tree.code !== 0)
    throw new WorkspaceError(`accepted raw record ${ref} names no readable tree`);
  return tree.stdout.trim();
}

/**
 * The exact paths explicitly written by accepted raw patches (#594), which later rounds,
 * envelope captures, Apply and Revert take by exact path while each is a reachable file,
 * regardless of the base tree or ignore rules. Named from the worktree's top level, whatever
 * subdirectory is asked. Empty when no raw patch wrote in this worktree;
 * a record that cannot be read is thrown, never read as empty.
 */
export async function rawAcceptedPaths(worktreePath: string, _base: string): Promise<string[]> {
  const paths = new Set<string>();
  for (const ref of [RAW_ACCEPTED_REF, RAW_PENDING_REF]) {
    const tree = await recordTree(worktreePath, ref);
    if (!tree) continue;
    const listed = await gitObserved(
      worktreePath,
      ["ls-tree", "--full-tree", "-r", "-z", "--name-only", tree],
      {
        label: "ls-tree (accepted raw paths)",
      },
    );
    for (const path of listed.stdout.split("\0")) if (path) paths.add(path);
  }
  return [...paths];
}

/** A worktree's raw membership records, each ref's tree or null when it has none. */
export type RawRecords = ReadonlyArray<readonly [ref: string, tree: string | null]>;

/**
 * Read a worktree's membership records and copy their complete tree closure into
 * `destination`'s object store. No ref changes: the objects stay unreachable there
 * until {@link publishRawRecords}, so a candidate that is never adopted changes nothing.
 * Candidates are disposed before the winner's adoption, hence the two steps.
 */
export async function exportRawRecords(source: string, destination: string): Promise<RawRecords> {
  const records: Array<readonly [string, string | null]> = [];
  for (const ref of [RAW_ACCEPTED_REF, RAW_PENDING_REF, RAW_PENDING_RESULT_REF])
    records.push([ref, await recordTree(source, ref)]);
  const trees = records.flatMap(([, tree]) => (tree ? [tree] : []));
  if (trees.length === 0) return records;
  // An isolated candidate may use a private object store/alternate. A ref to a
  // tree that the persistent worktree cannot read is worse than no record.
  const objectIds = new Set<string>();
  for (const tree of trees) {
    const listed = await git(source, ["rev-list", "--objects", tree]);
    if (listed.code !== 0)
      throw new WorkspaceError(`accepted raw tree could not be exported: ${listed.stderr.trim()}`);
    for (const line of listed.stdout.split("\n")) {
      const oid = line.trim().split(/\s+/, 1)[0];
      if (oid) objectIds.add(oid);
    }
  }
  const endpoint = async (cwd: string): Promise<ObjectEndpoint> => {
    const objects = await git(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "objects",
    ]);
    if (objects.code !== 0 || !objects.stdout.trim())
      throw new WorkspaceError(
        `accepted raw object store could not be resolved: ${objects.stderr.trim()}`,
      );
    return { cwd, env: { GIT_OPTIONAL_LOCKS: "0" }, objectsDir: objects.stdout.trim() };
  };
  await transferObjects(
    await endpoint(source),
    await endpoint(destination),
    [...objectIds],
    trees[0]!.length === 64 ? 32 : 20,
  );
  return records;
}

/** Make `records` this worktree's membership in one transaction; the export is
 * authoritative, including a ref it lacks (which removes stale membership here). */
export async function publishRawRecords(destination: string, records: RawRecords): Promise<void> {
  const updates = records.map(([ref, tree]) => (tree ? `update ${ref} ${tree}` : `delete ${ref}`));
  const moved = await git(destination, ["update-ref", "--stdin"], `${updates.join("\n")}\n`);
  if (moved.code !== 0)
    throw new WorkspaceError(
      `accepted raw records could not be transferred: ${moved.stderr.trim()}`,
    );
}

/**
 * Copy the per-worktree membership records (Git keeps `refs/worktree/*` private
 * to each worktree) from `source` to `destination`, objects first.
 */
export async function transferRawRecords(source: string, destination: string): Promise<void> {
  if (resolve(source) === resolve(destination)) return;
  await publishRawRecords(destination, await exportRawRecords(source, destination));
}

/**
 * Accepted paths that Git does not track in the current worktree index. A
 * tracked path may remain in the membership tree after Apply, but a reachable
 * untracked path is still an ignored raw addition and must keep its envelope.
 */
export async function rawIgnoredAcceptedPaths(
  worktreePath: string,
  base: string,
): Promise<string[]> {
  const accepted = await rawAcceptedPaths(worktreePath, base);
  if (accepted.length === 0) return [];
  const tracked = await git(worktreePath, [
    "--literal-pathspecs",
    "ls-files",
    "-z",
    "--",
    ...accepted,
  ]);
  if (tracked.code !== 0)
    throw new WorkspaceError(`accepted raw tracked-path check failed: ${tracked.stderr.trim()}`);
  const trackedPaths = new Set(tracked.stdout.split("\0").filter(Boolean));
  return accepted.filter((path) => !trackedPaths.has(path));
}

/**
 * The record tree after a patch: `prior` (what earlier accepted patches wrote) with each path
 * in `kept` as `result` holds it and each in `removed` dropped. Built in a scratch index,
 * so neither the worktree's index nor HEAD moves; a written path `result` lacks is thrown.
 */
async function acceptedTreeAfter(
  worktreePath: string,
  prior: string | null,
  result: string,
  kept: readonly string[],
  removed: readonly string[],
): Promise<string> {
  const scratchDir = mkdtempSync(join(tmpdir(), "claudexor-raw-record-"));
  const env = { GIT_INDEX_FILE: join(scratchDir, "index"), GIT_OPTIONAL_LOCKS: "0" };
  const run = async (args: string[], input?: string) => {
    const r = await gitEnv(worktreePath, [...SCRATCH_INDEX_CONFIG, ...args], env, input);
    if (r.code !== 0) throw new WorkspaceError(`raw record ${args[0]} failed: ${r.stderr.trim()}`);
    return r.stdout;
  };
  try {
    await run(prior ? ["read-tree", prior] : ["read-tree", "--empty"]);
    if (removed.length > 0)
      await run(["update-index", "-z", "--force-remove", "--stdin"], removed.join("\0") + "\0");
    if (kept.length > 0) {
      const entries = (
        await run(["--literal-pathspecs", "ls-tree", "-z", "--full-tree", result, "--", ...kept])
      )
        .split("\0")
        .filter(Boolean);
      const found = new Set(entries.map((entry) => entry.slice(entry.indexOf("\t") + 1)));
      const missing = kept.filter((path) => !found.has(path));
      if (missing.length > 0)
        throw new WorkspaceError(`raw record: the patch's tree lacks ${missing.join(", ")}`);
      await run(["update-index", "-z", "--index-info"], entries.join("\0") + "\0");
    }
    return (await run(["write-tree"])).trim();
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

/** What the model's own patch got wrong, so a later round can correct it. Every
 * other refusal is an impossible state, isolation or digest fact no round repairs. */
const MODEL_CORRECTABLE: ReadonlySet<string> = new Set<RawPatchRefusalCode>([
  "raw_patch_path_traversal",
  "raw_patch_outside_scope",
  "raw_patch_stale_preimage",
  "raw_patch_binary_unsupported",
  "raw_patch_truncated",
  "raw_patch_apply_failed",
]);

/** Whether another convergence round can repair a failure with this code. */
export function rawPatchRefusalIsModelCorrectable(code: string): boolean {
  return MODEL_CORRECTABLE.has(code);
}

/** A raw patch, or the evidence it needs, the engine refused: the attempt's own
 * typed failure, never a crashed process. This module throws it only for an
 * answer already received; the code says what is wrong, and whether a request
 * was sent is the attempt's usage evidence, never read from the code. */
export class RawPatchRefusalError extends Error {
  readonly category: "harness_error" | "internal" | "validation";
  constructor(
    public readonly code: RawPatchRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "RawPatchRefusalError";
    this.category = MODEL_CORRECTABLE.has(code)
      ? "harness_error"
      : code === "raw_context_exceeds_window"
        ? "validation"
        : "internal";
  }
}

function refuse(code: RawPatchRefusalCode, detail: string): never {
  throw new RawPatchRefusalError(code, `${code}: ${detail}`);
}

function validatePath(path: string): void {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => part === ".." || part === "" || part === ".")
  ) {
    refuse("raw_patch_path_traversal", `invalid repo-relative path ${JSON.stringify(path)}`);
  }
}

function rootAllows(path: string, root: string): boolean {
  if (root === ".") return true;
  validatePath(root);
  return path === root || path.startsWith(`${root}/`);
}

export function captureRawPatchEnvelope(
  enabled: boolean,
  previous: RawGitPatchEnvelope | null,
  event: HarnessEvent,
): RawGitPatchEnvelope | null {
  if (event.type !== "patch_produced") return previous;
  if (!enabled || !event.patch_envelope || previous)
    refuse("raw_patch_missing_evidence", "expected exactly one enabled patch envelope");
  // Credential-shaped CONTENT is no refusal. The envelope is memory-only; it
  // materializes in the isolated candidate tree and reaches saved artifacts
  // through the shared exact capture. Scope, preimage and digest evidence are
  // still enforced by consumeRawPatchEnvelope.
  return event.patch_envelope;
}

/** The exact tree a raw round starts from (#551): what this worktree (its top level)
 * holds now, as capture would record it (tracked and untracked, without ignored files
 * except the accepted paths, {@link rawAcceptedPaths}), read through a scratch index so
 * neither the worktree's index nor HEAD moves. It equals the run's base tree until a
 * round changes something. */
export async function rawCandidateTree(worktreePath: string): Promise<string> {
  return revParse(worktreePath, `${await rawAwareSnapshot(worktreePath)}^{tree}`);
}

/** The per-turn snapshot of a tree that may hold accepted paths the ignore rules hide. */
export async function rawAwareSnapshot(worktreePath: string): Promise<string> {
  return snapshotTree(worktreePath, [], await rawAcceptedPaths(worktreePath, "HEAD"));
}

/**
 * Validate and materialize a raw patch only inside its isolated candidate tree.
 * `baseCommitSha` is the run's delivery base, which never moves. The patch applies
 * to the packet's exact tree, and that tree must be what the worktree holds now:
 * a candidate changed since the packet was sent, a tree the packet does not name
 * or a commit that is not the run's base is refused before anything is written, and
 * so is a patch the worktree refuses (`git apply --check`). The patch's record is written
 * ahead ({@link RAW_PENDING_REF}): one that cannot be written, or an earlier one never
 * completed (unless the worktree holds exactly its tree: that promotion is finished
 * first), is the state-integrity refusal `raw_patch_requires_isolation` (INV-047),
 * again with nothing written. A patch that fails past its check is refused the same way,
 * and its pending record keeps naming whatever it wrote.
 */
export async function consumeRawPatchEnvelope(input: {
  repoRoot: string;
  worktreePath: string;
  baseCommitSha: string;
  context: RawContextPacket | null;
  envelope: RawGitPatchEnvelope | null;
}): Promise<{ materializedTreeSha: string }> {
  const { repoRoot, worktreePath, baseCommitSha, context, envelope } = input;
  if (!context || !envelope)
    refuse("raw_patch_missing_evidence", "raw producer returned no patch envelope");
  if (resolve(repoRoot) === resolve(worktreePath)) {
    refuse("raw_patch_requires_isolation", "raw patches cannot materialize in the live tree");
  }
  if (envelope.context_packet_hash !== context.packet_hash) {
    refuse("raw_patch_missing_evidence", "response does not bind the supplied context packet");
  }
  if (
    context.base_commit_sha !== baseCommitSha ||
    envelope.base_tree_sha !== context.base_tree_sha
  ) {
    refuse("raw_patch_base_mismatch", "patch and context do not bind the run's base and one tree");
  }
  let worktreeTree: string;
  let accepted: string | null;
  let unfinished: string | null;
  let unfinishedResult: string | null;
  try {
    worktreeTree = await rawCandidateTree(worktreePath);
    accepted = await recordTree(worktreePath, RAW_ACCEPTED_REF);
    unfinished = await recordTree(worktreePath, RAW_PENDING_REF);
    unfinishedResult = unfinished ? await recordTree(worktreePath, RAW_PENDING_RESULT_REF) : null;
  } catch (error) {
    refuse(
      "raw_patch_requires_isolation",
      `isolated worktree tree could not be verified: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // A patch that applied whole but whose promotion failed left the worktree holding exactly
  // its pending result: finishing that promotion names nothing new. A worktree holding anything
  // else (a patch that failed part-way, a later change) stays refused before this one writes.
  if (unfinished) {
    if (unfinishedResult !== worktreeTree || !(await promoteRawRecord(worktreePath, unfinished)))
      refuse("raw_patch_requires_isolation", "an earlier raw patch's record was never completed");
    accepted = unfinished;
  }
  if (worktreeTree !== context.base_tree_sha) {
    refuse("raw_patch_base_mismatch", "isolated worktree no longer holds the packet's exact tree");
  }
  if (sha256(envelope.patch) !== envelope.patch_hash) {
    refuse("raw_patch_digest_mismatch", "patch_hash does not match the exact patch bytes");
  }

  const parsed = parseUnifiedDiff(envelope.patch);
  if (parsed.files.length === 0) refuse("raw_patch_truncated", "patch has no complete file record");
  if (parsed.files.some((file) => file.binary)) {
    refuse("raw_patch_binary_unsupported", "binary patch payloads are not accepted by raw API");
  }
  const actualPaths = new Set<string>();
  const expectedPresence = new Map<string, "present" | "absent">();
  for (const file of parsed.files) {
    if (file.oldPath) {
      validatePath(file.oldPath);
      actualPaths.add(file.oldPath);
      expectedPresence.set(file.oldPath, "present");
    }
    if (file.newPath) {
      validatePath(file.newPath);
      actualPaths.add(file.newPath);
      const expected = file.oldPath === file.newPath ? "present" : "absent";
      const prior = expectedPresence.get(file.newPath);
      if (prior && prior !== expected) {
        refuse(
          "raw_patch_missing_evidence",
          `conflicting base-tree operations for ${file.newPath}`,
        );
      }
      expectedPresence.set(file.newPath, expected);
    }
  }

  const editable = new Map(context.readable_files.map((file) => [file.path, file]));
  const declared = new Map<string, string | null>();
  for (const item of envelope.touched_paths) {
    validatePath(item.path);
    if (declared.has(item.path)) {
      refuse("raw_patch_missing_evidence", `duplicate evidence for ${item.path}`);
    }
    declared.set(item.path, item.expected_blob_oid);
  }
  for (const path of actualPaths) {
    const presence = expectedPresence.get(path);
    const file = editable.get(path);
    const expected = declared.get(path);
    if (expected === undefined || !presence) {
      refuse("raw_patch_missing_evidence", `missing preimage evidence for ${path}`);
    }
    if (presence === "present") {
      if (!context.editable_paths.includes(path) || !file) {
        refuse("raw_patch_outside_scope", `${path} is outside the packet's exact editable scope`);
      }
      if (file.blob_oid !== expected) {
        refuse("raw_patch_stale_preimage", `preimage oid for ${path} does not match the packet`);
      }
      continue;
    }
    if (!context.creatable_roots.some((root) => rootAllows(path, root))) {
      refuse("raw_patch_outside_scope", `${path} is outside the packet's exact create scope`);
    }
    if (file || expected !== null) {
      refuse("raw_patch_stale_preimage", `preimage oid for ${path} does not match the packet`);
    }
  }
  if (
    declared.size !== actualPaths.size ||
    [...declared].some(([path]) => !actualPaths.has(path))
  ) {
    refuse("raw_patch_missing_evidence", "declared touched paths differ from the Git patch");
  }

  let materializedTreeSha: string;
  try {
    materializedTreeSha = await materializePatchTree(
      worktreePath,
      context.base_tree_sha,
      envelope.patch,
    );
  } catch (error) {
    refuse("raw_patch_apply_failed", error instanceof Error ? error.message : String(error));
  }
  const checked = await git(
    worktreePath,
    ["apply", "--whitespace=nowarn", "--check", "-"],
    envelope.patch,
  );
  if (checked.code !== 0)
    refuse("raw_patch_apply_failed", `apply --check refused: ${checked.stderr.trim()}`);
  // Written ahead (#594): the record names what this patch may write before any of it lands:
  // the paths it writes (renamed or deleted ones leave), never what else the candidate holds.
  const priorPaths = new Set(accepted ? await rawAcceptedPaths(worktreePath, baseCommitSha) : []);
  const kept: string[] = [];
  const removed: string[] = [];
  for (const file of parsed.files) {
    const oldKept = file.oldPath !== null && priorPaths.has(file.oldPath);
    if (file.deleted) {
      if (oldKept && file.oldPath) removed.push(file.oldPath);
      continue;
    }
    if (file.renamed) {
      if (oldKept && file.oldPath) removed.push(file.oldPath);
      // A rename destination is a path the accepted raw patch wrote, regardless of
      // whether its source was already in the accepted set.
      if (file.newPath) kept.push(file.newPath);
      continue;
    }
    if (file.added) {
      if (file.newPath) kept.push(file.newPath);
      continue;
    }
    // A copy has two paths but is not marked renamed: preserve an accepted source and
    // carry that membership to the surviving destination. Ordinary edits preserve only
    // already accepted paths.
    if (file.oldPath && file.newPath === file.oldPath) {
      // A same-path Raw API edit is explicit acceptance even when an earlier native
      // round created the file; preserve it if a later ignore rule hides it.
      kept.push(file.oldPath);
    } else if (file.oldPath && oldKept) kept.push(file.oldPath);
    if (file.newPath && file.newPath !== file.oldPath) {
      // A Git copy writes a new destination even when its source was an ordinary
      // tracked file; retain that destination so an ignored copy is not lost.
      kept.push(file.newPath);
    }
  }
  let pendingTree: string;
  try {
    pendingTree = await acceptedTreeAfter(
      worktreePath,
      accepted,
      materializedTreeSha,
      kept,
      removed,
    );
  } catch (error) {
    refuse(
      "raw_patch_requires_isolation",
      `the patch's record could not be built, so nothing was applied: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const pending = await git(
    worktreePath,
    ["update-ref", "--stdin"],
    `update ${RAW_PENDING_REF} ${pendingTree}\nupdate ${RAW_PENDING_RESULT_REF} ${materializedTreeSha}\n`,
  );
  if (pending.code !== 0)
    refuse(
      "raw_patch_requires_isolation",
      `the patch's record could not be written, so nothing was applied: ${pending.stderr.trim()}`,
    );
  const applied = await applyPatchProtected(worktreePath, envelope.patch);
  if (!applied.ok)
    refuse(
      "raw_patch_requires_isolation",
      `the patch failed past its check; its record keeps naming what it wrote: ${applied.detail ?? "git apply failed"}`,
    );
  // If the promotion fails, the pending record still names these bytes, and the next patch
  // here finishes it first, or is refused before it writes.
  await promoteRawRecord(worktreePath, pendingTree);
  return { materializedTreeSha };
}

/** One transaction makes `tree`, the pending record of a patch applied whole, the accepted
 * one and drops both pending refs; false when Git refused it, with every ref as it was. */
async function promoteRawRecord(worktreePath: string, tree: string): Promise<boolean> {
  const promoted = await git(
    worktreePath,
    ["update-ref", "--stdin"],
    `update ${RAW_ACCEPTED_REF} ${tree}\ndelete ${RAW_PENDING_REF}\ndelete ${RAW_PENDING_RESULT_REF}\n`,
  );
  return promoted.code === 0;
}
