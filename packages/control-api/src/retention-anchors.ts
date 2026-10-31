import { lstatSync, readFileSync, unlinkSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setImmediate as yieldToAdmission } from "node:timers/promises";
import { parse } from "yaml";
import type { RetentionProject } from "./retention.js";

const ID = /^sha256:[0-9a-f]{64}$/;

function plainDirectory(path: string): boolean {
  try {
    if (lstatSync(path).isDirectory()) return true;
    throw new Error(`${path} is not a plain directory`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function document(path: string): Record<string, unknown> | null {
  try {
    if (!lstatSync(path).isFile()) throw new Error(`${path} is not a plain file`);
    const doc: unknown = parse(readFileSync(path, "utf8"));
    if (!doc || typeof doc !== "object" || Array.isArray(doc))
      throw new Error(`${path} is not a mapping`);
    return doc as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** References are install-wide: an exact object may live in a different namespace.
 * Absence is ordinary for answer-only/unfinished runs; unreadable evidence is not. */
export async function survivingAnchorIds(
  projects: readonly RetentionProject[],
  deleted: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const ids = new Set<string>();
  const add = (id: unknown, source: string) => {
    if (id === undefined || id === null) return;
    if (typeof id !== "string" || !ID.test(id)) throw new Error(`invalid anchor id in ${source}`);
    ids.add(id);
  };
  for (const project of projects) {
    if (!plainDirectory(dirname(project.runsDir)) || !plainDirectory(project.runsDir)) continue;
    for (const entry of await readdir(project.runsDir, { withFileTypes: true })) {
      await yieldToAdmission();
      signal?.throwIfAborted();
      if (entry.name === ".retiring") continue;
      const root = join(project.runsDir, entry.name);
      if (deleted.has(root)) continue;
      if (entry.isSymbolicLink()) throw new Error(`linked run ${root}`);
      if (!entry.isDirectory() || !plainDirectory(root)) continue;
      if (document(join(root, "tombstone.yaml"))) continue;
      const final = join(root, "final");
      if (!plainDirectory(final)) continue;
      const work = document(join(final, "work_product.yaml"));
      const meta = work?.meta;
      if (meta !== undefined && (meta === null || typeof meta !== "object" || Array.isArray(meta)))
        throw new Error(`unreadable work-product meta in ${root}`);
      const fields = meta as Record<string, unknown> | undefined;
      add(fields?.revert_anchor_id, root);
      add(fields?.exact_patch_object, root);
      add(document(join(final, "delivery_state.yaml"))?.revertAnchorId, root);
    }
  }
  return ids;
}

/** Unnamed run-owned anchors share the run age window. No await may separate
 * the fresh mtime/link-count check from unlink (publication touches on reuse too). */
export async function pruneRunAnchors(input: {
  runtime: string;
  named: ReadonlySet<string>;
  cutoff: number;
  dryRun: boolean;
  planned: Map<string, number>;
  current: () => boolean;
  signal?: AbortSignal;
}): Promise<number> {
  const anchors = join(input.runtime, "anchors");
  const objects = join(anchors, "objects");
  if (![input.runtime, anchors, objects].every(plainDirectory)) return 0;
  const parents = [input.runtime, anchors, objects].map((path) => ({
    path,
    stat: lstatSync(path),
  }));
  let bytes = 0;
  for (const entry of await readdir(objects, { withFileTypes: true })) {
    // Patch anchors and object-pair anchors (#535) share one id space and age window.
    const anchor = /^([0-9a-f]{64})\.(?:patch|pair)$/.exec(entry.name);
    if (!entry.isFile() || !anchor) continue;
    if (input.named.has(`sha256:${anchor[1]}`)) continue;
    await yieldToAdmission();
    if (input.signal?.aborted || !input.current()) break;
    for (const parent of parents) {
      const current = lstatSync(parent.path);
      if (
        !current.isDirectory() ||
        current.dev !== parent.stat.dev ||
        current.ino !== parent.stat.ino
      )
        throw new Error(`anchor directory changed: ${parent.path}`);
    }
    const path = join(objects, entry.name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.mtimeMs >= input.cutoff) continue;
    const key = `${stat.dev}:${stat.ino}`;
    const unlinks = input.dryRun ? (input.planned.get(key) ?? 0) : 0;
    if (!input.dryRun) unlinkSync(path);
    else input.planned.set(key, unlinks + 1);
    if (stat.nlink === unlinks + 1) bytes += stat.size;
  }
  return bytes;
}
