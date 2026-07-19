import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { WorkspaceError } from "@claudexor/core";
import { ensureDir, projectRuntimeDir } from "@claudexor/util";

/**
 * DURABLE per-lane read-only homes (INV-034). A "lane" is a
 * (thread, harness, profile) triple: a read-only THREAD turn (ask/plan)
 * records its harness's native CLI session into a PERSISTENT
 * scoped HOME under the project runtime namespace, and the NEXT read-only turn
 * of the same lane reuses that home so `codex exec resume` / `claude --resume`
 * actually reaches the earlier session. This is the read-only counterpart of
 * the in-place write turn's native environment: unlike the disposable
 * `readOnlyHomeEnv`, a lane home is never deleted with the run — only the three
 * lifecycle owners (thread purge, credential-profile deletion, orphan
 * retention GC) remove it. INV-063 confinement: every lane home lives OUTSIDE
 * every worktree, under `projectRuntimeDir/lanes/...`.
 */

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function assertSafeSegment(label: string, value: string): void {
  if (!SAFE_SEGMENT.test(value) || value === "." || value === "..") {
    throw new WorkspaceError(`${label} '${value}' is not a safe path segment`);
  }
}

/** Profile segment for a lane dir: the null engine default is its OWN lane. */
function laneProfileSegment(profileId: string | null): string {
  return profileId ?? "default";
}

/** `<runtimeRoot>/lanes` — the per-project lanes root (sibling of `workspaces`). */
function lanesRootDir(runtimeRoot: string): string {
  return join(runtimeRoot, "lanes");
}

/**
 * The durable home dir for one lane: `<runtimeRoot>/lanes/<threadId>/
 * <harness>-<profileOrDefault>/home`. The ids MUST be path-safe segments and
 * the resolved dir MUST stay inside the lanes root (a crafted `../` id could
 * otherwise redirect a lifecycle rmSync outside the owned tree).
 */
export function laneHomeDir(
  runtimeRoot: string,
  threadId: string,
  harnessId: string,
  profileId: string | null,
): string {
  assertSafeSegment("threadId", threadId);
  const laneSeg = `${harnessId}-${laneProfileSegment(profileId)}`;
  assertSafeSegment("lane", laneSeg);
  const root = lanesRootDir(runtimeRoot);
  const home = join(root, threadId, laneSeg, "home");
  if (!home.startsWith(root + sep)) {
    throw new WorkspaceError(`lane home escapes the lanes dir: ${home}`);
  }
  return home;
}

export interface LaneHomeEnv {
  /** Scoped env the read-only attempt spawns with (HOME + per-harness config dirs). */
  env: Record<string, string>;
  /** The lane's persistent HOME dir. */
  homeDir: string;
}

/**
 * Ensure and return the durable scoped env for a lane. Same env shape as
 * `WorkspaceManager.envFor`/`readOnlyHomeEnv`, but the base is PERSISTENT: the
 * next read-only turn of the same (thread, harness, profile) reuses the exact
 * same dirs, so the harness's recorded native session is reachable for resume.
 */
export function ensureLaneHomeEnv(
  runtimeRoot: string,
  threadId: string,
  harnessId: string,
  profileId: string | null,
): LaneHomeEnv {
  const homeDir = laneHomeDir(runtimeRoot, threadId, harnessId, profileId);
  const codexHome = join(homeDir, ".codex");
  const claudeConfig = join(homeDir, ".claude");
  const cursorConfig = join(homeDir, ".cursor");
  const opencodeConfig = join(homeDir, ".config", "opencode");
  for (const d of [homeDir, codexHome, claudeConfig, cursorConfig, opencodeConfig]) ensureDir(d);
  return {
    homeDir,
    env: {
      HOME: homeDir,
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: claudeConfig,
      XDG_CONFIG_HOME: join(homeDir, ".config"),
    },
  };
}

/**
 * Thread-level continuation-summary cache (INV-137, V9c). Keyed by
 * (threadId, upToTurnId) — the collapse-boundary turn — and stored under the
 * thread's OWN lanes dir (`<lanesRoot>/<threadId>/summaries/<upToTurnId>.md`) so
 * the three lane lifecycle owners already sweep it: a purged / profile-deleted /
 * orphaned thread drops its summaries with the rest of `<threadId>`. A new head
 * turn advances the collapse boundary → a new key → old entries are harmless
 * leftover files. The turn id must be a safe path segment (crafted `../` ids
 * could otherwise escape the summaries dir).
 */
function threadSummaryPath(runtimeRoot: string, threadId: string, upToTurnId: string): string {
  assertSafeSegment("threadId", threadId);
  assertSafeSegment("upToTurnId", upToTurnId);
  const root = lanesRootDir(runtimeRoot);
  const path = join(root, threadId, "summaries", `${upToTurnId}.md`);
  if (!path.startsWith(root + sep)) {
    throw new WorkspaceError(`summary path escapes the lanes dir: ${path}`);
  }
  return path;
}

/** Read a cached continuation summary, or null on a miss / unsafe key / I/O error. */
export function readThreadSummary(
  projectRoot: string,
  threadId: string,
  upToTurnId: string,
): string | null {
  let path: string;
  try {
    path = threadSummaryPath(projectRuntimeDir(projectRoot), threadId, upToTurnId);
  } catch {
    return null;
  }
  try {
    const text = readFileSync(path, "utf8");
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/** Persist a continuation summary for later reuse until the boundary advances. */
export function writeThreadSummary(
  projectRoot: string,
  threadId: string,
  upToTurnId: string,
  text: string,
): void {
  const path = threadSummaryPath(projectRuntimeDir(projectRoot), threadId, upToTurnId);
  ensureDir(join(path, ".."));
  writeFileSync(path, text, { mode: 0o600 });
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Lifecycle owner (a): remove every lane home of one thread. Called on thread
 * PURGE (mirrors `purgeThreadWorktree`) so a purged conversation leaves no
 * durable scoped home behind.
 */
export function purgeThreadLanes(projectRoot: string, threadId: string): void {
  assertSafeSegment("threadId", threadId);
  const root = lanesRootDir(projectRuntimeDir(projectRoot));
  const threadDir = join(root, threadId);
  if (!threadDir.startsWith(root + sep)) return;
  rmSync(threadDir, { recursive: true, force: true });
}

/**
 * Lifecycle owner (b): invalidate a credential profile's lane homes. Called
 * from credential-profile deletion so a deleted account's durable read-only
 * sessions cannot be resumed. The lane dir name is exactly
 * `<harnessId>-<profileId>`, so the match is exact (never a prefix collision).
 */
export function purgeProfileLanes(
  projectRoot: string,
  harnessId: string,
  profileId: string,
): number {
  const laneSeg = `${harnessId}-${profileId}`;
  const root = lanesRootDir(projectRuntimeDir(projectRoot));
  let removed = 0;
  for (const threadId of safeReaddir(root)) {
    const laneDir = join(root, threadId, laneSeg);
    if (laneDir.startsWith(root + sep) && existsSync(laneDir)) {
      rmSync(laneDir, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

/**
 * Lifecycle owner (c): orphan retention GC. Remove lane dirs whose thread no
 * longer exists (trashed-then-purged, or lost out-of-band). Bounded to the
 * project's own lanes root; the live-thread set is the caller's fail-closed
 * truth (a quarantined partition contributes no ids, so its lanes are left
 * alone by the caller, never swept as orphans).
 */
export function sweepOrphanLanes(projectRoot: string, liveThreadIds: Set<string>): string[] {
  const actions: string[] = [];
  const root = lanesRootDir(projectRuntimeDir(projectRoot));
  for (const threadId of safeReaddir(root)) {
    if (liveThreadIds.has(threadId)) continue;
    const threadDir = join(root, threadId);
    if (!threadDir.startsWith(root + sep)) continue;
    try {
      rmSync(threadDir, { recursive: true, force: true });
      actions.push(`removed orphan lane dir ${threadId} under ${projectRoot}`);
    } catch {
      /* best-effort: a leftover lane dir is harmless and re-sweepable */
    }
  }
  return actions;
}
