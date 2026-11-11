/**
 * A thread export bundle on this volume: where a received item's bytes go, what
 * the bundle still holds, and what is durable before those bytes may stand in for
 * the originals. An item's manifest path is its complete name and its identity; a
 * volume that cannot name that path keeps the bytes under the item's id, and the
 * receipt records the place.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ThreadExportManifest,
  threadExportDigest,
  type ThreadExportReceipt,
} from "@claudexor/schema";
import { CliError } from "./cli-error.js";

export const THREAD_EXPORT_RECEIPT_FILE = "receipt.json";
export const THREAD_EXPORT_MANIFEST_FILE = "manifest.json";
/** Holds, by item id, each item whose own path this volume cannot name. */
const RELOCATED_DIR = "relocated";

type Item = ThreadExportManifest["items"][number];
interface HeldBytes {
  sha256: string;
  sizeBytes: number;
}

export function confinedPath(root: string, path: string): string {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || isAbsolute(path) || rel.startsWith(`..${sep}`) || rel === "..")
    throw new CliError("operational", `manifest path escapes the bundle: ${path}`, {
      code: "invalid_service_response",
    });
  return target;
}

/** Windows flushes only a handle open for writing. */
export const flushableOpen = (): "r" | "r+" => (process.platform === "win32" ? "r+" : "r");

/** Create a file exclusively, write and sync it; with nothing to write, sync a
 * directory's entries (Windows cannot open a directory to sync it). */
export function synced(path: string, write?: string): void {
  if (write === undefined && process.platform === "win32") return;
  const fd = openSync(path, write === undefined ? "r" : "wx", 0o600);
  try {
    if (write !== undefined) writeFileSync(fd, write);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The bytes a bundle path holds now: a regular file's digest, or null. With `sync`
 * the same open handle is flushed after its one read, and `unsynced` names a failure. */
async function heldDigest(
  path: string,
  sync = false,
): Promise<(HeldBytes & { unsynced?: unknown }) | null> {
  let fd: number;
  try {
    if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) return null;
    fd = openSync(path, sync ? flushableOpen() : "r");
  } catch {
    return null;
  }
  try {
    const hash = createHash("sha256");
    let sizeBytes = 0;
    try {
      for await (const chunk of createReadStream(path, { fd, autoClose: false })) {
        hash.update(chunk as Buffer);
        sizeBytes += (chunk as Buffer).length;
      }
    } catch {
      return null;
    }
    const held: HeldBytes = { sha256: `sha256:${hash.digest("hex")}`, sizeBytes };
    if (sync)
      try {
        fsyncSync(fd);
      } catch (unsynced) {
        return { ...held, unsynced };
      }
    return held;
  } finally {
    closeSync(fd);
  }
}

const relocatedPath = (item: Item): string =>
  `${RELOCATED_DIR}/${item.itemId}${/\.[0-9A-Za-z]{1,16}$/.exec(item.path)?.[0] ?? ""}`;

/**
 * Move verified bytes to their place and return it: the item's own path or, when
 * this volume cannot name that, its id under RELOCATED_DIR. Each name is claimed
 * exclusively before the bytes are renamed onto that claim, so no item of this
 * export replaces another: a name the bundle already holds, exactly or as the
 * destination reads it (letter case on a case-insensitive volume), keeps its bytes;
 * the same bytes serve both items, others refuse. The claim fences this export's
 * own items only: a writer outside it that replaces the claim before the rename is
 * not seen.
 */
export async function placeVerified(
  root: string,
  item: Item,
  partial: string,
  received: HeldBytes,
  place: string = item.path,
): Promise<string> {
  const target = confinedPath(root, place);
  try {
    mkdirSync(dirname(target), { recursive: true });
    closeSync(openSync(target, "wx", 0o600));
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ENAMETOOLONG" && place === item.path)
      return placeVerified(root, item, partial, received, relocatedPath(item));
    if (code !== "EEXIST" && code !== "ENOTDIR") throw error;
    const held = await heldDigest(target);
    if (held?.sha256 === received.sha256 && held.sizeBytes === received.sizeBytes) return place;
    throw new CliError(
      "operational",
      `${item.path} names a file this bundle already holds with other bytes; nothing was replaced, and this destination cannot hold both`,
      { code: "thread_export_path_collision", retryable: false },
    );
  }
  renameSync(partial, target);
  return place;
}

export type DigestEntry = { itemId: string; sha256: string; sizeBytes: number; plane: string };
export const linkEntry = (item: Item): DigestEntry => ({
  itemId: item.itemId,
  sha256: item.sha256!,
  sizeBytes: item.sizeBytes!,
  plane: item.plane,
});
/** The published digests of a transfer: over every entry, and over its lane plane. */
export const bundleDigests = (entries: readonly DigestEntry[]) => ({
  contentDigest: threadExportDigest(entries),
  laneDigest: threadExportDigest(entries.filter((entry) => entry.plane === "lane")),
});

/** Why these bytes cannot stand in for the originals yet, and what would change that. */
export interface BundleDamage {
  code: "thread_export_bundle_changed" | "thread_export_bundle_unsynced";
  reason: string;
  remedy: string;
}
const changed = (what: string): BundleDamage => ({
  code: "thread_export_bundle_changed",
  reason: `no longer holds what it received: ${what}`,
  remedy: "restore the bundle and repeat",
});
export const unsynced = (path: string, error: unknown): BundleDamage => ({
  code: "thread_export_bundle_unsynced",
  reason: `could not make ${path} durable: ${(error as NodeJS.ErrnoException).code ?? String(error)}`,
  remedy: "restore access to it or move the bundle to a volume that can sync it, then repeat",
});

/**
 * Every directory above `root` on its volume, nearest first. A recursive `--out` makes
 * an entry for the bundle and each missing parent, the topmost in the first directory
 * that already existed, and each is only as durable as the directory holding it. No
 * record says which those were, so all are asked: more than it needs, and none of its
 * entries can be above the top of the volume. The path is the one given, so a link on
 * it stands for the directory it names. Windows cannot open a directory to sync it.
 */
function directoriesAbove(root: string): string[] {
  if (process.platform === "win32") return [];
  const { dev } = statSync(root);
  const above: string[] = [];
  for (let at = dirname(root); statSync(at).dev === dev; at = dirname(at)) {
    above.push(at);
    if (at === dirname(at)) break;
  }
  return above;
}

/**
 * What of the receipt's transfer this bundle no longer holds or cannot make durable,
 * or null when every transferred byte is still there, yields the receipt's digests
 * and has been flushed. One pass over the bundle: each file's own read flushes it
 * through that handle, then the manifest, the receipt, every directory that holds
 * them and every directory above the bundle on its volume. One this user may not open
 * is a failed sync like any other. Changed bytes outrank a failed sync. On Windows a
 * directory cannot be synced, so there only file contents are. This asks the volume for
 * durability and proves no power-loss outcome.
 */
export async function bundleDamage(
  dir: string,
  receipt: ThreadExportReceipt,
): Promise<BundleDamage | null> {
  const root = resolve(dir);
  let firstUnsynced: BundleDamage | null = null;
  const flush = (path: string, once: () => void) => {
    try {
      once();
    } catch (error) {
      firstUnsynced ??= unsynced(path, error);
    }
  };
  const manifestPath = join(root, THREAD_EXPORT_MANIFEST_FILE);
  let manifest: ThreadExportManifest;
  try {
    const fd = openSync(manifestPath, flushableOpen());
    try {
      manifest = ThreadExportManifest.parse(JSON.parse(readFileSync(fd, "utf8")));
      flush(manifestPath, () => fsyncSync(fd));
    } finally {
      closeSync(fd);
    }
  } catch {
    return changed(`${THREAD_EXPORT_MANIFEST_FILE} is unreadable`);
  }
  if (manifest.exportId !== receipt.exportId || manifest.threadId !== receipt.threadId)
    return changed(`${THREAD_EXPORT_MANIFEST_FILE} names another export`);
  const received = new Map(receipt.transferred.map((entry) => [entry.itemId, entry]));
  const directories = new Set([root]);
  const entries: DigestEntry[] = [];
  for (const item of manifest.items) {
    if (item.kind === "symlink") entries.push(linkEntry(item));
    if (item.kind !== "file") continue;
    const entry = received.get(item.itemId);
    if (entry?.path !== item.path) return changed(`${item.path} is not in its receipt`);
    const place = confinedPath(root, entry.placedAt ?? item.path);
    const held = await heldDigest(place, true);
    if (held?.sha256 !== entry.sha256 || held.sizeBytes !== entry.sizeBytes)
      return changed(`${item.path} no longer holds the bytes it received`);
    if (held.unsynced) firstUnsynced ??= unsynced(place, held.unsynced);
    for (let at = dirname(place); at !== root && !directories.has(at); at = dirname(at))
      directories.add(at);
    entries.push({
      itemId: item.itemId,
      sha256: held.sha256,
      sizeBytes: held.sizeBytes,
      plane: item.plane,
    });
  }
  const digests = bundleDigests(entries);
  if (digests.contentDigest !== receipt.contentDigest || digests.laneDigest !== receipt.laneDigest)
    return changed("its receipt's digests are not those of its bytes");
  const receiptPath = join(root, THREAD_EXPORT_RECEIPT_FILE);
  flush(receiptPath, () => {
    const fd = openSync(receiptPath, flushableOpen());
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  });
  for (const directory of [...directories, ...directoriesAbove(root)])
    flush(directory, () => synced(directory));
  return firstUnsynced;
}
