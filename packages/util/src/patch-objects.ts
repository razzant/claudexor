import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { setImmediate as yieldToAdmission } from "node:timers/promises";
import { dirname, join } from "node:path";
import { ensureDir, fsyncDirectory, sha256 } from "./index.js";

const LINK_UNAVAILABLE = new Set(["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EMLINK"]);

/** Publish a new directory entry, never truncate an inode shared by other patches. */
function publishLink(source: string, target: string, durable: boolean): void {
  ensureDir(dirname(target));
  const temp = `${target}.tmp-${crypto.randomUUID()}`;
  try {
    try {
      linkSync(source, temp);
    } catch (error) {
      if (!LINK_UNAVAILABLE.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
      copyFileSync(source, temp);
      if (durable) {
        const fd = openSync(temp, "r+");
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
    }
    renameSync(temp, target);
    if (durable) fsyncDirectory(dirname(target));
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

/** Shared by display copies and private anchors. Different bytes never share an object. */
export function writePatchObject(
  runtimeDir: string,
  target: string,
  patch: string,
  options: { durable?: boolean } = {},
): void {
  const durable = options.durable ?? true;
  const id = sha256(patch).slice(7);
  const object = join(runtimeDir, "patches", `${id}.patch`);
  ensureDir(dirname(object));
  if (!lstatSync(dirname(object)).isDirectory())
    throw new Error(`patch cache ${dirname(object)} is not a plain directory; publication refused`);
  const reusable =
    existsSync(object) &&
    lstatSync(object).isFile() &&
    sha256(readFileSync(object, "utf8")) === `sha256:${id}`;
  // The cache pathname is advisory. Replace a damaged inode; never mutate it
  // in place or link a later publication to its mismatching bytes.
  if (!reusable) {
    const temp = `${object}.tmp-${crypto.randomUUID()}`;
    try {
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeFileSync(fd, patch, "utf8");
      } finally {
        closeSync(fd);
      }
      renameSync(temp, object);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
  // Ordinary run copies retain writeText's durability contract. An anchor
  // promotes the shared inode before publishing its durable authoritative link;
  // the cache pathname itself has no authority and can be recreated after a crash.
  if (durable) {
    const fd = openSync(object, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  publishLink(object, target, durable);
  // A filesystem without hard links keeps the published copy, not an extra cache copy.
  if (lstatSync(object).nlink === 1) unlinkSync(object);
}

/** Cache entries have no authority of their own. Anchors and run paths own their lifetime. */
export async function prunePatchObjects(
  runtimeDir: string,
  dryRun: boolean,
  plannedUnlinks: ReadonlyMap<string, number> = new Map(),
  signal?: AbortSignal,
): Promise<number> {
  const directory = join(runtimeDir, "patches");
  const directoryStat = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!directoryStat) return 0;
  if (!directoryStat.isDirectory())
    throw new Error(`patch cache ${directory} is not a plain directory; objects kept`);
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[0-9a-f]{64}\.patch$/.test(entry.name)) continue;
    await yieldToAdmission();
    if (signal?.aborted) break;
    const currentDirectory = lstatSync(directory);
    if (
      !currentDirectory.isDirectory() ||
      currentDirectory.dev !== directoryStat.dev ||
      currentDirectory.ino !== directoryStat.ino
    )
      throw new Error(`patch cache ${directory} changed during inventory; objects kept`);
    const path = join(directory, entry.name);
    const stat = lstatSync(path);
    if (!stat.isFile()) continue;
    if (stat.nlink !== 1 + (dryRun ? (plannedUnlinks.get(`${stat.dev}:${stat.ino}`) ?? 0) : 0))
      continue;
    bytes += stat.size;
    if (!dryRun) unlinkSync(path);
  }
  return bytes;
}
