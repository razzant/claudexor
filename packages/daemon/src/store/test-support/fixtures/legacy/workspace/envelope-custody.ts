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
import { dirname, join } from "node:path";
import { EnvelopeCustody, type ResumableCause, type WorkspaceEnvelope } from "../schema/index.js";
import { nowIso } from "../util/index.js";
import { git } from "./git.js";

const CUSTODY_FILE = "continuation-custody.json";

/** The envelope base of a Git envelope: its scoped HOME's parent, the one
 * directory `dispose()` removes. */
export function envelopeBaseOf(env: Pick<WorkspaceEnvelope, "home_dir">): string {
  return dirname(env.home_dir);
}

/** The envelope's custody record, or null when none was written (or it is torn). */
export function readEnvelopeCustody(base: string): EnvelopeCustody | null {
  try {
    return EnvelopeCustody.parse(JSON.parse(readFileSync(join(base, CUSTODY_FILE), "utf8")));
  } catch {
    return null;
  }
}

/** Atomic write: a reader sees the previous record or the new one, never a torn file. */
export function writeEnvelopeCustody(base: string, custody: EnvelopeCustody): void {
  const path = join(base, CUSTODY_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(EnvelopeCustody.parse(custody), null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(tmp, path);
}

/** End custody (adoption hand-over or disposition); the envelope becomes ordinary. */
export function releaseEnvelopeCustody(base: string): void {
  rmSync(join(base, CUSTODY_FILE), { force: true });
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
  const codexHome = env.harness_config_dirs["codex_home"] ?? join(env.home_dir, ".codex");
  const codexAuth = join(codexHome, "auth.json");
  if (existsSync(codexAuth)) {
    rmSync(codexAuth, { force: true });
    removed.push(codexAuth);
  }
  const bridge = join(env.home_dir, ".claudexor-claude-native", "Library", "Keychains");
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

/** Retain `env` for continuation: auth stripped, custody `retained` (durable
 * before the run's terminal is reported). Returns the record written. */
export function retainEnvelopeCustody(
  env: WorkspaceEnvelope,
  holder: { runId: string; runDir: string },
  cause: ResumableCause | null,
): EnvelopeCustody {
  stripRouteScopedAuth(env);
  const custody: EnvelopeCustody = {
    ...liveEnvelopeCustody(env, holder),
    state: "retained",
    cause,
    retained_at: nowIso(),
    bytes: envelopeDiskBytes(envelopeBaseOf(env)),
  };
  writeEnvelopeCustody(envelopeBaseOf(env), custody);
  return custody;
}

/** Whether the envelope's tree differs from its base (uncommitted or
 * untracked changes, or commits past the base); null when Git cannot tell. */
export async function envelopeTreeChanged(env: WorkspaceEnvelope): Promise<boolean | null> {
  if (!existsSync(env.worktree_path)) return null;
  const status = await git(env.worktree_path, ["status", "--porcelain", "--untracked-files=all"]);
  if (status.code !== 0) return null;
  if (status.stdout.trim().length > 0) return true;
  if (!env.base_sha) return false;
  const head = await git(env.worktree_path, ["rev-parse", "HEAD"]);
  return head.code === 0 ? head.stdout.trim() !== env.base_sha : null;
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
