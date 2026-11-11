import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as yieldToAdmission } from "node:timers/promises";
import { collectNativeRunSessions } from "./native-run-sessions.js";
import { globalRunStores, userConfigDir } from "@claudexor/util";
import { RETIRING } from "./retention-removal.js";

async function optionalStat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function directories(path: string): Promise<string[]> {
  const stat = await optionalStat(path);
  if (!stat) return [];
  if (!stat.isDirectory()) throw new Error(`native references require a plain directory: ${path}`);
  return (await readdir(path, { withFileTypes: true })).flatMap((entry) => {
    if (entry.isSymbolicLink())
      throw new Error(`native references cannot follow ${join(path, entry.name)}`);
    return entry.isDirectory() ? [entry.name] : [];
  });
}
/** Every retained run can be a continuation source. A corrupt or unreadable
 * capsule/resumable record aborts the entire native pass BEFORE any unlink. */
export async function retainedNativeSessions(
  sessions: Map<string, Set<string>>,
  ignoredRunIds: ReadonlySet<string> = new Set(),
  signal?: AbortSignal,
  runDirs: ReadonlySet<string> = new Set(),
  seen = new Set<string>(),
): Promise<Map<string, Set<string>>> {
  const read = async (run: string) => {
    await yieldToAdmission();
    signal?.throwIfAborted();
    if (!seen.has(run)) collectNativeRunSessions(run, sessions, seen, ignoredRunIds, signal);
  };
  const projects = join(userConfigDir(), "projects");
  const runStores: string[] = [];
  for (const hash of await directories(projects)) {
    signal?.throwIfAborted();
    if (/^[0-9a-f]{64}$/.test(hash)) runStores.push(join(projects, hash, "runs"));
  }
  // The folderless Ask and one-shot stores hold retained runs too (#503).
  runStores.push(...globalRunStores().map((store) => store.runsDir));
  for (const runs of runStores) {
    for (const id of await directories(runs)) {
      signal?.throwIfAborted();
      if (id === RETIRING || ignoredRunIds.has(id)) continue;
      await read(join(runs, id));
    }
  }
  for (const run of runDirs) await read(run);
  return sessions;
}
