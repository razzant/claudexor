/**
 * The lane tree and the digests of what is on disk now, by the consumer's own
 * formula: at acceptance over every exported byte. They agree with a consumer
 * only if those bytes are the same. Before deletion, each remaining lane entry is
 * checked against the entries acceptance read.
 */
import { setImmediate as yieldToAdmission } from "node:timers/promises";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readlinkSync, type Dirent, type Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  threadExportDigest,
  threadExportItemId,
  threadExportLinkIdentity,
  type ThreadExportDigestEntry,
} from "@claudexor/schema";
import {
  bundleSegment,
  digestDecoded,
  digestIdentified,
  itemChanged,
  walkTree,
  type WalkedEntry,
} from "./thread-export-walk.js";
import type { Inventory, ThreadExportDeps } from "./thread-export-inventory.js";

export const laneBundlePrefix = (threadId: string): string => `lanes/${bundleSegment(threadId)}`;

/** What of a lane is exported: never the exact credential stores it declares, and
 * nothing at all of a lane whose harness declares none. */
export async function readLaneTree(
  root: string,
  credentialStoresOf: ThreadExportDeps["laneCredentialStores"],
  signal?: AbortSignal,
): Promise<{
  entries: WalkedEntry[];
  credentialStores: string[];
  undeclared: string[];
  problems: { rel: string; message: string }[];
}> {
  const result = {
    entries: [] as WalkedEntry[],
    credentialStores: [] as string[],
    undeclared: [] as string[],
    problems: [] as { rel: string; message: string }[],
  };
  const stat = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return result;
  if (!stat.isDirectory()) {
    result.problems.push({ rel: ".", message: `${root} is not a plain directory` });
    return result;
  }
  const walked = await walkTree(root, "", signal);
  result.problems.push(...walked.problems);
  for (const entry of walked.entries) {
    const lane = entry.rel.split("/")[0]!;
    if (lane !== "summaries" && entry.rel.includes("/")) {
      const stores = credentialStoresOf(lane);
      if (!stores) {
        if (!result.undeclared.includes(lane)) result.undeclared.push(lane);
        continue;
      }
      if (stores.some((store) => entry.rel === `${lane}/home/${store}`)) {
        result.credentialStores.push(entry.rel);
        continue;
      }
    }
    result.entries.push(entry);
  }
  return result;
}

type Verified =
  | { kind: "file"; dev: number; ino: number; sizeBytes: number; mtimeMs: number }
  | { kind: "symlink"; linkTarget: string }
  | { kind: "special" };

function laneChanged(rel: string, detail: string): Error {
  return Object.assign(
    new Error(`lane entry ${rel} ${detail}; its bytes are not in the accepted export`),
    { code: "thread_lane_changed" },
  );
}

/**
 * Before a retirement's cleanup deletes the lane, on its first attempt and on
 * every retry: each lane entry still on disk must be an entry acceptance re-read,
 * with identical bytes. An accepted entry already gone is expected, because a
 * deletion may have stopped part way; a changed or new one is refused, so only
 * exported bytes are ever deleted. A FIFO or socket holds no bytes. Resolves to a
 * synchronous recheck the caller runs with no await before deleting: it names the
 * first entry that changed since it was hashed, or returns null.
 */
export async function verifyLaneRemoval(
  threadId: string,
  root: string,
  credentialStoresOf: ThreadExportDeps["laneCredentialStores"],
  accepted: readonly ThreadExportDigestEntry[],
  signal?: AbortSignal,
): Promise<() => string | null> {
  const lane = await readLaneTree(root, credentialStoresOf, signal);
  const first = lane.problems[0];
  if (first) throw new Error(`lane ${first.rel}: ${first.message}`);
  if (lane.undeclared.length > 0)
    throw new Error(`lane ${lane.undeclared[0]} declares no credential stores`);
  const expected = new Map(accepted.map((entry) => [entry.itemId, entry]));
  const prefix = laneBundlePrefix(threadId);
  const verified = new Map<string, Verified>();
  for (const entry of lane.entries) {
    signal?.throwIfAborted();
    if (entry.kind === "special") {
      verified.set(entry.rel, { kind: "special" });
      continue;
    }
    const want = expected.get(threadExportItemId("lane", `${prefix}/${entry.rel}`));
    if (!want) throw laneChanged(entry.rel, "arrived after acceptance");
    let have: { sha256: string; sizeBytes: number };
    if (entry.kind === "symlink") have = threadExportLinkIdentity(entry.linkTarget);
    else
      try {
        have = await digestIdentified(entry.file, signal);
      } catch (error) {
        if ((error as { code?: string }).code === "thread_export_item_changed")
          throw laneChanged(entry.rel, "changed while it was read");
        throw error;
      }
    if (have.sha256 !== want.sha256 || have.sizeBytes !== want.sizeBytes)
      throw laneChanged(entry.rel, "changed after acceptance");
    verified.set(
      entry.rel,
      entry.kind === "symlink"
        ? { kind: "symlink", linkTarget: entry.linkTarget }
        : { kind: "file", ...entry.file },
    );
  }
  return () => laneChangedSince(root, verified, credentialStoresOf);
}

/** One synchronous pass with the same classification as `readLaneTree`, no hashing. */
function laneChangedSince(
  root: string,
  verified: ReadonlyMap<string, Verified>,
  credentialStoresOf: ThreadExportDeps["laneCredentialStores"],
): string | null {
  const visit = (dir: string, rel: string): string | null => {
    // What vanished was accepted or holds nothing; only what cannot be read is unknown.
    const gone = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
    let names: Dirent[];
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      return gone(error) ? null : rel || ".";
    }
    for (const name of names) {
      const childRel = rel ? `${rel}/${name.name}` : name.name;
      const path = join(dir, name.name);
      let stat: Stats;
      try {
        stat = lstatSync(path);
      } catch (error) {
        if (gone(error)) continue;
        return childRel;
      }
      if (stat.isDirectory()) {
        const changed = visit(path, childRel);
        if (changed) return changed;
        continue;
      }
      const lane = childRel.split("/")[0]!;
      if (lane !== "summaries" && childRel.includes("/")) {
        const stores = credentialStoresOf(lane);
        if (!stores) return childRel;
        if (stores.some((store) => childRel === `${lane}/home/${store}`)) continue;
      }
      const want = verified.get(childRel);
      if (stat.isSymbolicLink()) {
        if (want?.kind !== "symlink") return childRel;
        let target: string;
        try {
          target = readlinkSync(path);
        } catch (error) {
          if (gone(error)) continue;
          return childRel;
        }
        if (target !== want.linkTarget) return childRel;
      } else if (stat.isFile()) {
        if (
          want?.kind !== "file" ||
          stat.dev !== want.dev ||
          stat.ino !== want.ino ||
          stat.size !== want.sizeBytes ||
          stat.mtimeMs !== want.mtimeMs
        )
          return childRel;
      }
    }
    return null;
  };
  return visit(root, "");
}

/** The digest of what is on disk now, by the consumer's own formula. */
export async function currentDigests(
  deps: ThreadExportDeps,
  inventory: Inventory,
  signal?: AbortSignal,
): Promise<{ content: string; lane: string; laneEntries: ThreadExportDigestEntry[] }> {
  const all: (ThreadExportDigestEntry & { plane: string })[] = [];
  for (const item of inventory.manifest.items) {
    signal?.throwIfAborted();
    if (item.kind === "symlink") {
      all.push({
        itemId: item.itemId,
        sha256: item.sha256!,
        sizeBytes: item.sizeBytes!,
        plane: item.plane,
      });
      continue;
    }
    if (item.kind !== "file") continue;
    const source = inventory.sources.get(item.itemId);
    if (!source) throw itemChanged(item.path);
    const observed =
      source.type === "document"
        ? await documentDigest(deps, inventory.manifest.threadId, source.key, signal)
        : source.type === "file"
          ? await digestIdentified(source.file, signal)
          : await digestDecoded(source.file, signal);
    all.push({ itemId: item.itemId, ...observed, plane: item.plane });
  }
  const laneEntries = all
    .filter((entry) => entry.plane === "lane")
    .map(({ itemId, sha256, sizeBytes }) => ({ itemId, sha256, sizeBytes }));
  return { content: threadExportDigest(all), lane: threadExportDigest(laneEntries), laneEntries };
}

async function documentDigest(
  deps: ThreadExportDeps,
  threadId: string,
  key: string,
  signal?: AbortSignal,
) {
  await yieldToAdmission();
  // Stop may arrive while admission runs; the record is not read after it.
  signal?.throwIfAborted();
  const bytes = deps.document(threadId, key);
  if (!bytes) throw itemChanged(key);
  return {
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    sizeBytes: bytes.length,
  };
}
