/**
 * Crash GC (T3.1#5): a daemon crash leaves three kinds of debris behind —
 * workspace envelopes (worktree + scoped home WITH SEEDED CREDENTIALS),
 * per-attempt `claudexor/<task>/<attempt>` branches, and `claudexor-ro-*`
 * read-only tmp homes. The sweep runs at daemon startup BEFORE any new work
 * is accepted, when nothing can own an envelope (running jobs were flipped
 * to interrupted, queued jobs have not materialized task ids), so every
 * found envelope under a daemon-known project root is an orphan.
 *
 * Reach is honest: only roots recorded in jobs.json (plus their thread
 * trees) are sweepable — a project never run through this daemon is not.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager, git, processStartTime } from "@claudexor/workspace";

const RO_HOME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface SweepInput {
  jobsPath: string;
  threadsPath: string;
}

export async function sweepOrphanWorkspaces(input: SweepInput): Promise<string[]> {
  const actions: string[] = [];
  const roots = knownProjectRoots(input.jobsPath);
  const liveThreadIds = knownThreadIds(input.threadsPath);

  for (const root of roots) {
    const trees = [root, ...threadTreesUnder(root)];
    for (const tree of trees) {
      actions.push(...(await sweepEnvelopesUnder(tree)));
      actions.push(...(await sweepAttemptBranches(tree, liveThreadIds)));
    }
  }
  actions.push(...sweepReadOnlyHomes());
  return actions;
}

/** Project roots this daemon has ever run against (jobs.json scope roots). */
function knownProjectRoots(jobsPath: string): string[] {
  const roots = new Set<string>();
  try {
    const records = JSON.parse(readFileSync(jobsPath, "utf8")) as Array<{ params?: unknown }>;
    if (!Array.isArray(records)) return [];
    for (const rec of records) {
      const scope = (rec?.params as { scope?: { kind?: unknown; root?: unknown } } | undefined)?.scope;
      if (scope && scope.kind === "project" && typeof scope.root === "string" && existsSync(scope.root)) {
        roots.add(scope.root);
      }
    }
  } catch {
    return [];
  }
  return [...roots];
}

function knownThreadIds(threadsPath: string): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(threadsPath, "utf8")) as { threads?: Array<{ id?: unknown }> };
    return new Set(
      (raw.threads ?? []).map((t) => t?.id).filter((id): id is string => typeof id === "string"),
    );
  } catch {
    return new Set();
  }
}

/** Isolated-thread worktrees nest their own envelopes: <root>/.claudexor/threads/<tid>/tree. */
function threadTreesUnder(root: string): string[] {
  const threadsDir = join(root, ".claudexor", "threads");
  if (!existsSync(threadsDir)) return [];
  try {
    return readdirSync(threadsDir)
      .map((tid) => join(threadsDir, tid, "tree"))
      .filter((tree) => existsSync(tree));
  } catch {
    return [];
  }
}

async function sweepEnvelopesUnder(execRoot: string): Promise<string[]> {
  const actions: string[] = [];
  const workspacesDir = join(execRoot, ".claudexor", "workspaces");
  if (!existsSync(workspacesDir)) return actions;
  const wsm = new WorkspaceManager(execRoot);
  for (const taskId of safeReaddir(workspacesDir)) {
    const taskDir = join(workspacesDir, taskId);
    for (const attemptId of safeReaddir(taskDir)) {
      // LIVE-OWNER GUARD: an envelope created by a still-running process
      // (in-process CLI run, MCP/ACP serve, another daemon) is NOT an orphan.
      // The startup premise "nothing can own an envelope" only covers
      // daemon-tracked jobs; owner.json (pid + command, recycling-guarded)
      // covers everyone else. Fail-safe: a live-looking owner means KEEP.
      const owner = envelopeOwner(join(taskDir, attemptId));
      if (owner) {
        actions.push(`kept envelope ${taskId}/${attemptId} under ${execRoot}: live owner pid ${owner}`);
        continue;
      }
      try {
        await wsm.disposeOrphan(taskId, attemptId);
        actions.push(`disposed orphan envelope ${taskId}/${attemptId} under ${execRoot}`);
      } catch (err) {
        actions.push(
          `FAILED to dispose orphan envelope ${taskId}/${attemptId} under ${execRoot}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return actions;
}

/** The live owner pid recorded in the envelope's owner.json, or null when the
 * marker is missing, the pid is dead, or the pid was RECYCLED (the live
 * process's kernel start time no longer matches the recorded one — command
 * names/titles mutate, start times never do). FAIL-SAFE: when start-time
 * evidence is unavailable on either side (`ps` missing/sandboxed), a LIVE pid
 * alone keeps the envelope — the guard errs toward keeping possibly-live
 * work, never toward deleting it. */
function envelopeOwner(envelopeBase: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(join(envelopeBase, "owner.json"), "utf8")) as {
      pid?: unknown;
      started?: unknown;
    };
    if (typeof raw.pid !== "number") return null;
    process.kill(raw.pid, 0); // throws when the pid is dead -> swept
    const recorded = typeof raw.started === "string" ? raw.started : null;
    const live = processStartTime(raw.pid);
    // Recycling proof requires BOTH sides; with both present they must match.
    if (recorded !== null && live !== null && live !== recorded) return null;
    return raw.pid;
  } catch {
    return null;
  }
}

/**
 * Per-attempt branches whose envelope is gone are debris (disposeOrphan
 * removes its own branch; this catches branches whose envelope dir was
 * deleted out-of-band). Thread branches (`claudexor/thread-<tid>`) are
 * PERSISTENT for live threads and only deleted when the thread is gone from
 * the store.
 */
async function sweepAttemptBranches(execRoot: string, liveThreadIds: Set<string>): Promise<string[]> {
  const actions: string[] = [];
  const branches = await git(execRoot, ["branch", "--list", "claudexor/*", "--format=%(refname:short)"]);
  if (branches.code !== 0) return actions;
  for (const branch of branches.stdout.split("\n").map((b) => b.trim()).filter(Boolean)) {
    const rest = branch.slice("claudexor/".length);
    if (rest.startsWith("verify-")) {
      // FinalVerifier branches leak only when a crash hit mid-verify (the
      // verifier deletes them in its finally). git refuses to delete a branch
      // a live verify worktree still has checked out, so this is safe.
      const del = await git(execRoot, ["branch", "-D", branch]);
      if (del.code === 0) actions.push(`deleted leaked verify branch ${branch} under ${execRoot}`);
      continue;
    }
    if (rest.startsWith("thread-")) {
      const tid = rest.slice("thread-".length);
      if (liveThreadIds.has(tid)) continue;
      // Dead thread branch: its worktree dir decides — an existing tree means
      // the thread store lost the record but the work is still there; keep it
      // (evidence beats cleanup) and only note it.
      const threadTree = join(execRoot, ".claudexor", "threads", tid, "tree");
      if (existsSync(threadTree)) {
        actions.push(`kept branch ${branch}: thread tree still on disk (store record missing)`);
        continue;
      }
      const del = await git(execRoot, ["branch", "-D", branch]);
      if (del.code === 0) actions.push(`deleted dead thread branch ${branch} under ${execRoot}`);
      continue;
    }
    const [taskId, attemptId] = rest.split("/");
    if (!taskId || !attemptId) continue;
    const envelopeBase = join(execRoot, ".claudexor", "workspaces", taskId, attemptId);
    if (existsSync(envelopeBase)) continue; // still owned (sweep order: envelopes first)
    const del = await git(execRoot, ["branch", "-D", branch]);
    if (del.code === 0) actions.push(`deleted orphan attempt branch ${branch} under ${execRoot}`);
  }
  return actions;
}

/** Read-only scoped homes and verify worktree dirs leak on crash; ro homes can hold seeded credentials. */
function sweepReadOnlyHomes(): string[] {
  const actions: string[] = [];
  const tmp = tmpdir();
  for (const entry of safeReaddir(tmp)) {
    if (!entry.startsWith("claudexor-ro-") && !entry.startsWith("claudexor-verify-")) continue;
    const full = join(tmp, entry);
    try {
      if (Date.now() - statSync(full).mtimeMs < RO_HOME_MAX_AGE_MS) continue;
      rmSync(full, { recursive: true, force: true });
      actions.push(`deleted stale tmp dir ${entry}`);
    } catch {
      /* best-effort */
    }
  }
  return actions;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
