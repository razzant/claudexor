/**
 * Durable custody of isolated envelopes kept for continuation (A9).
 *
 * ONE record per envelope, in the envelope base: `live` while its holder run's
 * attempt uses it (written at creation, so a crash leaves the envelope
 * attributable to its run), `retained` once the holder stopped with unfinished
 * work. A retained envelope (tree + scoped home, route-scoped auth removed)
 * survives `dispose()` and the crash sweeper until an explicit disposition:
 * adoption by a `continueFrom` successor, or the run's discard decision.
 * Nothing removes it automatically; its disk use is reported with the run.
 * The in-memory `retainEnvelope` set of the manager is a separate, process-
 * local reason (exact patch bytes) and is not custody.
 */
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { lstat, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EnvelopeCustody, type ResumableCause, type WorkspaceEnvelope } from "@claudexor/schema";
import { nowIso, withPoolWriteSlot } from "@claudexor/util";
import { reachableFile } from "./fs-presence.js";
import { git } from "./git.js";
import { rawIgnoredAcceptedPaths } from "./raw-patch.js";

export const ENVELOPE_CUSTODY_FILE = "continuation-custody.json";

/** The envelope base of a Git envelope: its scoped HOME's parent, the one
 * directory `dispose()` removes. */
export function envelopeBaseOf(env: Pick<WorkspaceEnvelope, "home_dir">): string {
  return dirname(env.home_dir);
}

/** A path that is simply not there (never written, released, or its parent
 * directory gone): the one read failure that legitimately means "absent". */
export function absentPath(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The custody record read strictly: absent is a legitimate state (never
 * written, or released by an explicit disposition) and reads as null; any
 * other read failure, or a record this engine cannot parse, is thrown, so a
 * destructive owner (retention, pruning, discard) holds and reports it
 * instead of reading it as released. */
export function readEnvelopeCustodyStrict(base: string): EnvelopeCustody | null {
  const path = join(base, ENVELOPE_CUSTODY_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (absentPath(error)) return null;
    throw error;
  }
  try {
    return EnvelopeCustody.parse(JSON.parse(text));
  } catch (error) {
    throw new Error(
      `invalid envelope custody record at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** The envelope's custody record, or null when none was written (or it is
 * torn or unreadable): the observational reader for projections and adoption. */
export function readEnvelopeCustody(base: string): EnvelopeCustody | null {
  try {
    return readEnvelopeCustodyStrict(base);
  } catch {
    return null;
  }
}

function custodyWrite(base: string, custody: EnvelopeCustody) {
  const path = join(base, ENVELOPE_CUSTODY_FILE);
  return {
    path,
    tmp: `${path}.${process.pid}.tmp`,
    text: JSON.stringify(EnvelopeCustody.parse(custody), null, 2) + "\n",
  };
}

/** Atomic write: a reader sees the previous record or the new one, never a torn file. */
export function writeEnvelopeCustody(base: string, custody: EnvelopeCustody): void {
  const { path, tmp, text } = custodyWrite(base, custody);
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

/** The same atomic write at lane start (`live` custody), without waiting on the main
 * thread; each call holds one pool write slot. */
export async function writeEnvelopeCustodyAsync(
  base: string,
  custody: EnvelopeCustody,
): Promise<void> {
  const { path, tmp, text } = custodyWrite(base, custody);
  await withPoolWriteSlot(undefined, () => writeFile(tmp, text, { mode: 0o600 }));
  await withPoolWriteSlot(undefined, () => rename(tmp, path));
}

/** End custody (adoption hand-over or disposition); the envelope becomes ordinary. */
export function releaseEnvelopeCustody(base: string): void {
  rmSync(join(base, ENVELOPE_CUSTODY_FILE), { force: true });
}

/** True when `env` is held for continuation and must survive `dispose()`. */
export function isRetainedEnvelope(env: WorkspaceEnvelope): boolean {
  const custody = readEnvelopeCustody(envelopeBaseOf(env));
  return custody?.state === "retained" && custody.envelope.id === env.id;
}

/** `live` custody of a freshly created envelope (written before any harness runs). */
export function liveEnvelopeCustody(
  env: WorkspaceEnvelope,
  holder: { runId: string; runDir: string },
): EnvelopeCustody {
  return {
    version: 1,
    state: "live",
    holder_run_id: holder.runId,
    holder_run_dir: holder.runDir,
    envelope: env,
    cause: null,
    retained_at: null,
    bytes: null,
  };
}

/**
 * Route-scoped auth material Claudexor itself places in an envelope's scoped
 * home, removed when the envelope is retained and re-created by the adapters
 * on the next spawn: the Codex API-key `auth.json` (written only when absent,
 * `harness-codex` `ensureCodexApiAuth`) and the Claude Keychain bridge link
 * (`harness-claude` `claudeNativeHomeEnv`, re-created when missing). Subscription
 * sessions live in the registry profile stores, never here.
 */
export function stripRouteScopedAuth(env: WorkspaceEnvelope): string[] {
  const removed: string[] = [];
  const { codexAuth, bridge } = routeScopedAuth(env);
  if (existsSync(codexAuth)) {
    rmSync(codexAuth, { force: true });
    removed.push(codexAuth);
  }
  try {
    if (lstatSync(bridge).isSymbolicLink()) {
      rmSync(bridge, { force: true });
      removed.push(bridge);
    }
  } catch {
    // No bridge was created for this envelope.
  }
  return removed;
}

/** Where Claudexor places route-scoped auth in an envelope's scoped home. */
function routeScopedAuth(env: WorkspaceEnvelope): { codexAuth: string; bridge: string } {
  const codexHome = env.harness_config_dirs["codex_home"] ?? join(env.home_dir, ".codex");
  return {
    codexAuth: join(codexHome, "auth.json"),
    bridge: join(env.home_dir, ".claudexor-claude-native", "Library", "Keychains"),
  };
}

/** `stripRouteScopedAuth` without waiting on the main thread (#704); each
 * removal holds one pool write slot. */
async function stripRouteScopedAuthAsync(env: WorkspaceEnvelope): Promise<void> {
  const { codexAuth, bridge } = routeScopedAuth(env);
  await withPoolWriteSlot(undefined, () => rm(codexAuth, { force: true }));
  if ((await lstat(bridge).catch(() => null))?.isSymbolicLink())
    await withPoolWriteSlot(undefined, () => rm(bridge, { force: true }));
}

function retainedCustody(
  env: WorkspaceEnvelope,
  holder: { runId: string; runDir: string },
  cause: ResumableCause | null,
  continuationEligible: boolean,
  bytes: number | null,
): EnvelopeCustody {
  return {
    ...liveEnvelopeCustody(env, holder),
    state: "retained",
    ...(continuationEligible ? {} : { continuation_eligible: false }),
    cause,
    retained_at: nowIso(),
    bytes,
  };
}

/** Retain `env` for continuation: auth stripped, custody `retained` (durable
 * before the run's terminal is reported). Returns the record written. */
export function retainEnvelopeCustody(
  env: WorkspaceEnvelope,
  holder: { runId: string; runDir: string },
  cause: ResumableCause | null,
  continuationEligible = true,
): EnvelopeCustody {
  stripRouteScopedAuth(env);
  const base = envelopeBaseOf(env);
  const custody = retainedCustody(
    env,
    holder,
    cause,
    continuationEligible,
    envelopeDiskBytes(base),
  );
  writeEnvelopeCustody(base, custody);
  return custody;
}

/** `retainEnvelopeCustody` for a run end, which is async: the disk-use walk
 * and every write are awaited, never held on the main thread (#704). */
export async function retainEnvelopeCustodyAsync(
  env: WorkspaceEnvelope,
  holder: { runId: string; runDir: string },
  cause: ResumableCause | null,
): Promise<EnvelopeCustody> {
  await stripRouteScopedAuthAsync(env);
  const base = envelopeBaseOf(env);
  const custody = retainedCustody(env, holder, cause, true, await envelopeDiskBytesAsync(base));
  await writeEnvelopeCustodyAsync(base, custody);
  return custody;
}

/** Whether the envelope's tree differs from its base (uncommitted or
 * untracked changes, a file an accepted raw patch wrote that the ignore rules hide
 * from status, or commits past the base); null when Git cannot tell. A raw patch
 * record that cannot be read counts as a change: it may name files status cannot see. */
export async function envelopeTreeChanged(env: WorkspaceEnvelope): Promise<boolean | null> {
  if (!existsSync(env.worktree_path)) return null;
  const status = await git(env.worktree_path, ["status", "--porcelain", "--untracked-files=all"]);
  if (status.code !== 0) return null;
  if (status.stdout.trim().length > 0) return true;
  try {
    // Status is clean, so only an accepted path that is still an untracked file
    // here is an ignored addition. A tracked path can remain in the membership
    // record after Apply; treating every reachable accepted name as dirty keeps
    // clean old→new→old work alive forever.
    const accepted = await rawIgnoredAcceptedPaths(env.worktree_path, env.base_sha ?? "HEAD");
    if (accepted.some((path) => reachableFile(env.worktree_path, path))) return true;
  } catch {
    return true;
  }
  if (!env.base_sha) return false;
  const head = await git(env.worktree_path, ["rev-parse", "HEAD"]);
  return head.code === 0 ? head.stdout.trim() !== env.base_sha : null;
}

/** `envelopeDiskBytes` awaited one directory listing or entry at a time, so the
 * walk never holds the main thread (#704). */
export async function envelopeDiskBytesAsync(
  base: string,
  maxEntries = 200_000,
): Promise<number | null> {
  let bytes = 0;
  let visited = 0;
  const stack = [base];
  try {
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const name of await readdir(dir)) {
        if ((visited += 1) > maxEntries) return null;
        const path = join(dir, name);
        const stat = await lstat(path);
        if (stat.isDirectory()) stack.push(path);
        else bytes += stat.size;
      }
    }
  } catch {
    return null;
  }
  return bytes;
}

/** Disk use of an envelope base by a bounded walk; null when the bound was
 * hit or the base is unreadable (unknown is never reported as a size). */
export function envelopeDiskBytes(base: string, maxEntries = 200_000): number | null {
  let bytes = 0;
  let visited = 0;
  const stack = [base];
  try {
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const name of readdirSync(dir)) {
        if ((visited += 1) > maxEntries) return null;
        const path = join(dir, name);
        const stat = lstatSync(path);
        if (stat.isDirectory()) stack.push(path);
        else bytes += stat.size;
      }
    }
  } catch {
    return null;
  }
  return bytes;
}
