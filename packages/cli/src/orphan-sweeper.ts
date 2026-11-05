/**
 * Crash GC: a daemon crash leaves three kinds of debris behind —
 * workspace envelopes (worktree + scoped home WITH SEEDED CREDENTIALS),
 * per-attempt `claudexor/<task>/<attempt>` branches, and `claudexor-ro-*`
 * read-only tmp homes. The sweep runs at daemon startup BEFORE any new work
 * is accepted, when nothing can own an envelope (running jobs were flipped
 * to interrupted, queued jobs have not materialized task ids), so every
 * found envelope under a daemon-known project root is an orphan.
 *
 * Reach is honest: only roots recorded in the command journal (plus their thread
 * trees) and the one-shot namespace are sweepable — a project never run through
 * this daemon is not. Each envelope is disposed against the execution root its
 * owner record names (#503); a legacy record belongs to its namespace's own root,
 * and an envelope with neither is kept: cleanup never moves to another tree. Below
 * the config root, which may itself be a link, the sweep follows none: what a link
 * leads to may be another store's, so it stays, with the branches it hides the owner of.
 *
 * LIVE-OWNER GUARD: envelopes carry owner.json (pid + kernel start time);
 * a live owner's envelopes survive the sweep. When start-time recycling
 * proof is unavailable on either side (ps-less/sandboxed env, legacy
 * marker), a live pid keeps the envelope only while its working dirs are
 * FRESH (24h window over the newest of base/tree/home/owner.json mtimes) —
 * a declared tradeoff: brief proof-less windows never kill in-flight work,
 * while a recycled pid cannot pin a seeded-credential home forever.
 *
 * CONTINUATION CUSTODY: an envelope retained for `continueFrom` is never an
 * orphan — it is kept (route-scoped auth stripped again) until adoption or
 * discard; an envelope whose holder run died mid-attempt with changed files is
 * kept the same way (`host_restart`), so the interrupted run can be continued.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceManager,
  git,
  processStartTime,
  readEnvelopeCustody,
  readEnvelopeRecoveryRecord,
  recoverOrphanCustody,
} from "@claudexor/workspace";
import { oneShotRuntimeDir, ownedProjectRuntimeDir, projectRuntimeDir } from "@claudexor/util";

const RO_HOME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface SweepInput {
  /** Project roots this daemon has run against, read from the ALREADY
   * PREPARED global command projection (the stage-2 replay) — never a second
   * `DurableJournal.prepare()` over the same file. */
  knownProjectRoots: () => readonly string[];
  /** Caller-owned execution roots recorded by delegated commands. Only
   * Claudexor's envelope scratch under their runtime namespace is swept; the
   * caller's tree and Git refs are never Claudexor's to collect. */
  knownExecutionRoots?: () => readonly string[];
}

export async function sweepOrphanWorkspaces(input: SweepInput): Promise<string[]> {
  const actions: string[] = [];
  const roots = knownProjectRoots(input.knownProjectRoots);

  for (const root of roots) {
    const project = projectRuntimeDir(root);
    for (const tree of [root, ...threadTreesUnder(root, actions)]) {
      const swept = await sweepTreeNamespace(tree, actions);
      // A current envelope of an isolated thread lives in its project's namespace. One
      // that cannot be walked hides which branches are owned, so they all stay.
      if (swept && !runtimeLink(root, "workspaces"))
        actions.push(...(await sweepAttemptBranches(tree, [projectRuntimeDir(tree), project])));
    }
  }
  const executionRoots = knownProjectRoots(input.knownExecutionRoots ?? (() => []));
  for (const root of executionRoots.filter((candidate) => !roots.includes(candidate))) {
    await sweepTreeNamespace(root, actions);
  }
  // Explicitly ephemeral runs keep their envelopes in the one-shot namespace (#503).
  // Like retention, this never follows a linked store: it may hold another one's envelopes.
  const oneShot = oneShotRuntimeDir();
  const linked = [oneShot, join(oneShot, "workspaces")].find(presentButNotPlainDirectory);
  if (linked) actions.push(`kept namespace ${linked}: not a plain directory`);
  else actions.push(...(await sweepEnvelopeNamespace(oneShot, null)));
  actions.push(...sweepReadOnlyHomes());
  return actions;
}

/** The refusal to walk these segments of a tree's namespace: a link below the config root.
 * Only a check: every path stays as recorded, so a linked config root keeps its spelling. */
function runtimeLink(tree: string, ...segments: string[]): string | null {
  try {
    ownedProjectRuntimeDir(tree, ...segments);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function sweepTreeNamespace(tree: string, actions: string[]): Promise<boolean> {
  const runtime = projectRuntimeDir(tree);
  const link = runtimeLink(tree, "workspaces");
  if (link) {
    actions.push(`kept namespace ${runtime}: ${link}`);
    return false;
  }
  actions.push(...(await sweepEnvelopeNamespace(runtime, tree)));
  return true;
}

function presentButNotPlainDirectory(path: string): boolean {
  try {
    return !lstatSync(path).isDirectory();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** Project roots this daemon has ever run against (command journal scope roots).
 *
 * STRICTLY READ-ONLY: crash-GC runs inside the two-stage startup BETWEEN the
 * read-only preparation and the prepared activation, so this scan must never
 * create or open-for-write anything under the journal tree. (Opening a writer
 * here used to create journal.bin on a clean root, which failed activation's
 * revalidation and trapped every FRESH root on the recovery plane.) The roots
 * come from the prepared in-memory command projection, so the journal file is
 * not read a second time; an unreadable projection means no sweep. */
function knownProjectRoots(read: () => readonly string[]): string[] {
  try {
    return [...new Set(read().filter((root) => existsSync(root)))];
  } catch {
    return [];
  }
}

/** Isolated-thread worktrees live in the external per-project runtime namespace. */
function threadTreesUnder(root: string, actions: string[]): string[] {
  const threadsDir = join(projectRuntimeDir(root), "threads");
  if (!existsSync(threadsDir)) return [];
  const link = runtimeLink(root, "threads");
  if (link) {
    actions.push(`kept thread trees of ${root}: ${link}`);
    return [];
  }
  try {
    return readdirSync(threadsDir).flatMap((tid) => {
      const treeLink = runtimeLink(root, "threads", tid, "tree");
      if (treeLink) actions.push(`kept thread tree ${tid} of ${root}: ${treeLink}`);
      const tree = join(threadsDir, tid, "tree");
      return !treeLink && existsSync(tree) ? [tree] : [];
    });
  } catch {
    return [];
  }
}

/** Envelopes of one engine runtime namespace; `legacyRoot` is the tree a record
 * without `execution_root` was created for (null: none can be assumed). */
async function sweepEnvelopeNamespace(
  runtimeRoot: string,
  legacyRoot: string | null,
): Promise<string[]> {
  const actions: string[] = [];
  const workspacesDir = join(runtimeRoot, "workspaces");
  if (!existsSync(workspacesDir)) return actions;
  for (const taskId of safeReaddir(workspacesDir)) {
    const taskDir = join(workspacesDir, taskId);
    // Every path below this one is read, recovered or removed, so a link here would
    // carry all of that into whatever it reaches (#503). Checked before anything is.
    if (presentButNotPlainDirectory(taskDir)) {
      actions.push(`kept envelope ${taskId} under ${runtimeRoot}: not a plain directory`);
      continue;
    }
    for (const attemptId of safeReaddir(taskDir)) {
      if (presentButNotPlainDirectory(join(taskDir, attemptId))) {
        actions.push(
          `kept envelope ${taskId}/${attemptId} under ${runtimeRoot}: not a plain directory`,
        );
        continue;
      }
      const execRoot =
        readEnvelopeRecoveryRecord(join(taskDir, attemptId))?.executionRoot ?? legacyRoot;
      const where = execRoot ?? runtimeRoot;
      // LIVE-OWNER GUARD: an envelope created by a still-running process
      // (in-process CLI run, MCP/ACP serve, another daemon) is NOT an orphan.
      // The startup premise "nothing can own an envelope" only covers
      // daemon-tracked jobs; owner.json (pid + command, recycling-guarded)
      // covers everyone else. Fail-safe: a live-looking owner means KEEP.
      const owner = envelopeOwner(join(taskDir, attemptId));
      if (owner) {
        actions.push(
          `kept envelope ${taskId}/${attemptId} under ${where}: live owner pid ${owner}`,
        );
        continue;
      }
      const held = await recoverOrphanCustody(join(taskDir, attemptId));
      if (held) {
        // A capture-refused source is kept for inspection only, not continuation.
        const purpose =
          readEnvelopeCustody(join(taskDir, attemptId))?.continuation_eligible === false
            ? "for inspection"
            : "for continueFrom";
        actions.push(
          `${held === "kept" ? "kept retained" : "retained interrupted"} envelope ${taskId}/${attemptId} under ${where} ${purpose}`,
        );
        continue;
      }
      if (!execRoot) {
        actions.push(`kept envelope ${taskId}/${attemptId} under ${where}: no execution root`);
        continue;
      }
      try {
        await new WorkspaceManager(execRoot, { runtimeRoot }).disposeOrphan(taskId, attemptId);
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

/** How long an envelope may be KEPT on live-pid evidence alone when
 * start-time recycling proof is unavailable on either side. Bounds scoped
 * auth/scratch retention: a recycled pid cannot pin a route-scoped home forever. */
const OWNERLESS_PROOF_KEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The live owner pid recorded in the envelope's owner.json, or null when the
 * marker is missing, the pid is dead, or the pid was RECYCLED (the live
 * process's kernel start time no longer matches the recorded one — command
 * names/titles mutate, start times never do). FAIL-SAFE, bounded: when
 * start-time evidence is unavailable on either side (`ps` missing/sandboxed,
 * legacy marker), a LIVE pid keeps the envelope only while it is FRESH —
 * in-flight work survives, but a recycled pid cannot retain route-scoped
 * homes indefinitely. A pid alive under another uid (EPERM) counts as alive. */
function envelopeOwner(envelopeBase: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(join(envelopeBase, "owner.json"), "utf8")) as {
      pid?: unknown;
      started?: unknown;
    };
    if (typeof raw.pid !== "number" || !Number.isInteger(raw.pid) || raw.pid <= 0) return null;
    let alive = false;
    try {
      process.kill(raw.pid, 0);
      alive = true;
    } catch (err) {
      // EPERM = the pid EXISTS but belongs to another security boundary —
      // that is a live process, not a dead one.
      alive = (err as NodeJS.ErrnoException)?.code === "EPERM";
    }
    if (!alive) return null;
    const recorded = typeof raw.started === "string" ? raw.started : null;
    const live = processStartTime(raw.pid);
    // Recycling proof requires BOTH sides; with both present they must match.
    if (recorded !== null && live !== null) return live === recorded ? raw.pid : null;
    // No recycling proof available: bounded keep on freshness. Freshness is
    // the NEWEST mtime across the envelope base, owner.json, and a BOUNDED
    // recursive walk of the working dirs — editing an EXISTING file bumps
    // only the file's mtime, not its parent directory's, so directory stats
    // alone would sweep a live owner that edits in place. A live long-running
    // owner keeps extending its own window; a recycled pid cannot pin a
    // route-scoped home forever.
    const newestMtime = Math.max(
      safeMtime(envelopeBase),
      safeMtime(join(envelopeBase, "owner.json")),
      newestMtimeUnder(join(envelopeBase, "tree")),
      newestMtimeUnder(join(envelopeBase, "home")),
    );
    return Date.now() - newestMtime < OWNERLESS_PROOF_KEEP_MAX_AGE_MS ? raw.pid : null;
  } catch {
    return null;
  }
}

/**
 * Per-attempt branches whose envelope is gone are debris (disposeOrphan
 * removes its own branch; this catches branches whose envelope dir was
 * deleted out-of-band). Persistent thread branches are lifecycle-owned and
 * are removed only by explicit purge, never by this generic debris sweep.
 */
async function sweepAttemptBranches(execRoot: string, namespaces: string[]): Promise<string[]> {
  const actions: string[] = [];
  const branches = await git(execRoot, [
    "branch",
    "--list",
    "claudexor/*",
    "--format=%(refname:short)",
  ]);
  if (branches.code !== 0) return actions;
  for (const branch of branches.stdout
    .split("\n")
    .map((b) => b.trim())
    .filter(Boolean)) {
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
      continue;
    }
    const [taskId, attemptId] = rest.split("/");
    if (!taskId || !attemptId) continue;
    // A kept link can be dangling: it hides ownership, it does not prove absence.
    if (
      namespaces.some((runtime) => {
        const task = join(runtime, "workspaces", taskId);
        const attempt = join(task, attemptId);
        return (
          presentButNotPlainDirectory(task) ||
          presentButNotPlainDirectory(attempt) ||
          existsSync(attempt)
        );
      })
    )
      continue;
    const del = await git(execRoot, ["branch", "-D", branch]);
    if (del.code === 0) actions.push(`deleted orphan attempt branch ${branch} under ${execRoot}`);
  }
  return actions;
}

/** Read-only scoped homes and verify worktree dirs leak on crash; ro homes can hold injected API-route material. */
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

function safeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Newest mtime under a dir via a BOUNDED walk (freshness evidence, not an
 * exhaustive index): caps visited entries so a huge worktree cannot stall the
 * startup sweep; the newest-first ordering is not needed — any fresh entry
 * proves liveness. */
function newestMtimeUnder(root: string, maxEntries = 512): number {
  let newest = safeMtime(root);
  let visited = 0;
  const stack = [root];
  while (stack.length > 0 && visited < maxEntries) {
    const dir = stack.pop()!;
    for (const entry of safeReaddir(dir)) {
      if (visited >= maxEntries) break;
      visited += 1;
      const full = join(dir, entry);
      try {
        const st = statSync(full);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
        if (st.isDirectory()) stack.push(full);
      } catch {
        /* raced deletion — skip */
      }
    }
  }
  return newest;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
