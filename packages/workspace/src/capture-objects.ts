import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { gitObserved } from "./git-observed.js";
import { repositoryObjectFormat, storeBoundaryCommit, treeOf } from "./git-result.js";
import {
  assertProjectObjectFormat,
  objectStorePath,
  repositoryEndpoint,
  retainInObjectStore,
  writeRootRecord,
} from "./object-store.js";
import { assertSpaceFor } from "./object-transfer.js";
import { parseRawRecords } from "./object-compose.js";

/**
 * Estimate of the rendered patch view of B..C from blob sizes alone (no blob is
 * read): every changed path contributes its old and new size plus a fixed header
 * allowance (a mode-only change, the allowance alone). Text hunks hold at most both sides' lines; a `--binary` payload is
 * base85 of deflated data (5/4 of at most the raw size) per side. It decides
 * whether a render is attempted. It is NOT an upper bound: per-line prefixes and
 * per-hunk headers are not counted, so many short changed lines render larger.
 * The render is bounded separately by its own buffer, and one that overflows is
 * the same typed absence.
 */
export async function estimatePatchViewBytes(
  repo: string,
  base: string,
  candidate: string,
  env: Record<string, string>,
): Promise<{ bytes: number; paths: string[]; existingPaths: string[] }> {
  const listed = await gitObserved(
    repo,
    ["diff-tree", "-r", "--raw", "-z", "--no-renames", "--no-abbrev", base, candidate],
    { env, label: "diff-tree --raw (estimate)" },
  );
  const records = parseRawRecords(listed.stdout);
  const zero = /^0+$/;
  const oids = [
    ...new Set(
      records.flatMap((record) => [record.oldOid, record.newOid]).filter((oid) => !zero.test(oid)),
    ),
  ];
  const sizes = new Map<string, number>();
  if (oids.length > 0) {
    const checked = await gitObserved(
      repo,
      ["cat-file", "--batch-check=%(objectname) %(objectsize)"],
      {
        env,
        input: `${oids.join("\n")}\n`,
        label: "cat-file --batch-check (estimate)",
      },
    );
    for (const line of checked.stdout.split("\n")) {
      const [oid, size] = line.split(" ");
      if (oid && size && /^\d+$/.test(size)) sizes.set(oid, Number(size));
    }
  }
  let bytes = 0;
  for (const record of records) {
    // A mode-only change renders its header and reads no blob.
    const sides =
      record.oldOid === record.newOid
        ? []
        : [record.oldOid, record.newOid].filter((oid) => !zero.test(oid));
    bytes += 1024 + sides.reduce((sum, oid) => sum + Math.ceil(((sizes.get(oid) ?? 0) * 5) / 4), 0);
  }
  return {
    bytes,
    paths: records.map((record) => record.src),
    // No renames are detected here: an old side exists for M, T and D records.
    existingPaths: records.filter((record) => record.status !== "A").map((record) => record.src),
  };
}

/** Cheap object-growth evidence for the stall watchdog of a writing Git child. */
export function objectDirectoryProgress(objectsDir: string): () => number {
  return () => {
    let total = 0;
    try {
      const pack = join(objectsDir, "pack");
      if (existsSync(pack))
        for (const name of readdirSync(pack)) total += statSync(join(pack, name)).size;
      for (const fan of readdirSync(objectsDir))
        if (fan.length === 2) total += readdirSync(join(objectsDir, fan)).length;
    } catch {
      // A directory being created or removed is not a stall.
    }
    return total;
  };
}

/**
 * Free-space preflight BEFORE a capture writes anything (owner decision
 * 29.10 17:10): the scratch object directory will hold at most the bytes of the
 * worktree's changed and untracked files, so refuse with exact numbers when the
 * filesystem cannot hold them; nothing has been written at that point.
 */
export async function preflightCaptureSpace(
  repo: string,
  scratchDir: string,
  env: Record<string, string>,
): Promise<number> {
  const status = await gitObserved(
    repo,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
    { env, label: "status (space preflight)", allowFailure: true },
  );
  if (status.code !== 0) return 0;
  const top = (
    await gitObserved(repo, ["rev-parse", "--show-toplevel"], {
      env,
      label: "rev-parse --show-toplevel",
    })
  ).stdout.trim();
  let bytes = 0;
  for (const entry of status.stdout.split("\0")) {
    if (entry.length < 4 || entry[1] === "D" || entry[0] === "D") continue;
    try {
      const stat = lstatSync(join(top, entry.slice(3)));
      if (stat.isFile()) bytes += stat.size;
    } catch {
      // Vanished meanwhile: it adds nothing to write.
    }
  }
  assertSpaceFor(scratchDir, bytes, "capture");
  return bytes;
}

/**
 * D2 for an isolated envelope: when its base is a Claudexor dirty snapshot (no
 * user ref keeps it), retain the snapshot's own closure beyond its parent in
 * the project store before the clone exists. Returns the store's object
 * directory for the clone's second alternate.
 */
export async function isolatedBaseCustody(
  repo: string,
  projectRoot: string,
  baseSha: string,
  owners: [string, ...string[]],
): Promise<string | undefined> {
  // One project keeps one object format: its store never becomes a foreign clone's alternate.
  if (projectRoot !== repo)
    await assertProjectObjectFormat(projectRoot, await repositoryObjectFormat(repo));
  const boundary = await storeBoundaryCommit(repo, baseSha);
  if (boundary && boundary !== baseSha) {
    const retained = await retainInObjectStore({
      projectRoot,
      source: await repositoryEndpoint(repo),
      roots: [baseSha],
      boundary: { commit: boundary, tree: await treeOf(repo, boundary) },
      objectFormat: await repositoryObjectFormat(repo),
      owner: owners[0],
    });
    // Live while ANY owner exists: the holder run, or the envelope itself.
    for (const owner of owners.slice(1)) writeRootRecord(retained.store, owner, [baseSha]);
  }
  const objects = join(objectStorePath(projectRoot), "objects");
  return existsSync(objects) ? objects : undefined;
}
