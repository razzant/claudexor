/**
 * Run-artifact serving routes (list/fetch for run trees and produced project
 * outputs), extracted from the daemon-server shell. One owner of artifact
 * MIME/caps policy (bytes are served exactly, INV-146) and of the honest
 * post-GC answer: a retention-reclaimed run serves a typed 410 tombstone,
 * never a mysterious 404 (W3.6).
 */
import type { ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactReadRequest, ArtifactReadResult } from "./artifact-read.js";
export { expiredRunBody, listArtifacts } from "./artifact-read.js";
import type { DaemonRunRecord } from "./daemon-server.js";
import { streamFilesArtifact } from "./files-artifact-stream.js";
import { runExecutionWorkspaceRoot } from "./run-execution-root.js";

/** Server-owned workspace facts for a thread, taken from its journal record:
 *  the mode and, for an isolated thread, the persistent worktree path (pinned by
 *  the `claudexor/thread-*` branch) where its turns actually executed. */
export interface ResolvedThreadWorkspace {
  mode: "in_place" | "isolated" | "delegated";
  /** The isolated thread's persistent worktree (null once purged or before the
   *  first write turn materializes it), or a delegated thread's caller-owned
   *  root, which purge keeps as the historical binding. */
  worktreePath: string | null;
}

export interface ArtifactServeContext {
  findRun(id: string): Promise<DaemonRunRecord | null | undefined>;
  /** Resolve a registered project id to its canonical repo root (null when the
   *  project is unknown or the build has no project registry). */
  resolveProjectRoot?(id: string): Promise<string | null>;
  /** Resolve a thread id to its workspace record (mode + isolated worktree
   *  path). Absent when the build has no thread store; null when the thread
   *  record cannot be found. Feeds the QA-038 isolated-produced fix. */
  resolveThreadWorkspace?(id: string): Promise<ResolvedThreadWorkspace | null>;
  /** One server-owned bulk executor, also used by run detail and SSE reads. */
  readArtifact(input: ArtifactReadRequest, signal?: AbortSignal): Promise<ArtifactReadResult>;
  json(res: ServerResponse, status: number, body: unknown): void;
}

export async function handleArtifactServeRoute(
  ctx: ArtifactServeContext,
  method: string,
  path: string,
  res: ServerResponse,
): Promise<boolean> {
  // Project-scoped durable outputs (D15/Block B): the same store the run-scoped
  // /produced route serves (<projectRoot>/artifacts), keyed by the durable
  // project id instead of a run id. Server-owned + path-traversal-safe.
  const projectOutputsRootMatch = /^\/projects\/([^/]+)\/outputs$/.exec(path);
  if (method === "GET" && projectOutputsRootMatch) {
    const projectId = decodeURIComponent(projectOutputsRootMatch[1] as string);
    const root = ctx.resolveProjectRoot ? await ctx.resolveProjectRoot(projectId) : null;
    if (!root) return (ctx.json(res, 404, { error: "no such project" }), true);
    await serveArtifactRead(ctx, res, {
      kind: "list",
      root: join(root, "artifacts"),
      owner: { kind: "project", id: projectId },
    });
    return true;
  }

  const projectOutputsFetchMatch = /^\/projects\/([^/]+)\/outputs\/(.+)$/.exec(path);
  if (method === "GET" && projectOutputsFetchMatch) {
    const projectId = decodeURIComponent(projectOutputsFetchMatch[1] as string);
    const root = ctx.resolveProjectRoot ? await ctx.resolveProjectRoot(projectId) : null;
    if (!root) return (ctx.json(res, 404, { error: "no such project" }), true);
    await serveArtifactRead(ctx, res, {
      kind: "fetch",
      root: join(root, "artifacts"),
      relative: decodeURIComponent(projectOutputsFetchMatch[2] as string),
    });
    return true;
  }

  const artifactsRootMatch = /^\/runs\/([^/]+)\/artifacts$/.exec(path);
  if (method === "GET" && artifactsRootMatch) {
    const rec = await ctx.findRun(decodeURIComponent(artifactsRootMatch[1] as string));
    if (!rec?.runDir) return (ctx.json(res, 404, { error: "no such run" }), true);
    await serveArtifactRead(ctx, res, {
      kind: "list",
      root: rec.runDir,
      owner: { kind: "run", id: rec.runId ?? rec.id },
      runArtifact: true,
    });
    return true;
  }

  const artifactFetchMatch = /^\/runs\/([^/]+)\/artifacts\/(.+)$/.exec(path);
  if (method === "GET" && artifactFetchMatch) {
    const rec = await ctx.findRun(decodeURIComponent(artifactFetchMatch[1] as string));
    if (!rec?.runDir) return (ctx.json(res, 404, { error: "no such run" }), true);
    await serveArtifactRead(ctx, res, {
      kind: "fetch",
      root: rec.runDir,
      relative: decodeURIComponent(artifactFetchMatch[2] as string),
      runArtifact: true,
    });
    return true;
  }

  const producedRootMatch = /^\/runs\/([^/]+)\/produced$/.exec(path);
  if (method === "GET" && producedRootMatch) {
    const rec = await ctx.findRun(decodeURIComponent(producedRootMatch[1] as string));
    if (!rec?.runDir) return (ctx.json(res, 404, { error: "no such run" }), true);
    const resolved = await resolveProducedRoot(rec, ctx.resolveThreadWorkspace);
    if (resolved.kind === "worktree_unavailable")
      return (
        ctx.json(
          res,
          worktreeUnavailableStatus(resolved.reason),
          isolatedWorktreeUnavailableBody(resolved),
        ),
        true
      );
    await serveArtifactRead(ctx, res, {
      kind: "list",
      root: resolved.kind === "root" ? join(resolved.root, "artifacts") : null,
      owner: { kind: "run", id: rec.runId ?? rec.id },
    });
    return true;
  }

  const producedFetchMatch = /^\/runs\/([^/]+)\/produced\/(.+)$/.exec(path);
  if (method === "GET" && producedFetchMatch) {
    const rec = await ctx.findRun(decodeURIComponent(producedFetchMatch[1] as string));
    if (!rec?.runDir) return (ctx.json(res, 404, { error: "no such run" }), true);
    const resolved = await resolveProducedRoot(rec, ctx.resolveThreadWorkspace);
    if (resolved.kind === "worktree_unavailable")
      return (
        ctx.json(
          res,
          worktreeUnavailableStatus(resolved.reason),
          isolatedWorktreeUnavailableBody(resolved),
        ),
        true
      );
    if (resolved.kind !== "root")
      return (ctx.json(res, 404, { error: "no project root for run" }), true);
    await serveArtifactRead(ctx, res, {
      kind: "fetch",
      root: join(resolved.root, "artifacts"),
      relative: decodeURIComponent(producedFetchMatch[2] as string),
    });
    return true;
  }

  return false;
}

/** A disconnected reader drops its queued work and never starts a response.
 * The executor owns daemon Stop; no independent worker or retry lives here. */
async function serveArtifactRead(
  ctx: ArtifactServeContext,
  res: ServerResponse,
  request: ArtifactReadRequest,
): Promise<void> {
  if (res.destroyed) return;
  const abort = new AbortController();
  const disconnected = () => abort.abort();
  res.once("close", disconnected);
  try {
    const result = await ctx.readArtifact(request, abort.signal);
    if (res.destroyed || abort.signal.aborted) return;
    if (result.kind === "error") {
      ctx.json(res, result.status, result.body);
    } else if (result.kind === "files") {
      await streamFilesArtifact(result.transfer, res, abort.signal);
    } else {
      res.writeHead(200, {
        "content-type": result.contentType,
        "content-length": result.body.byteLength,
      });
      res.end(result.body);
    }
  } catch (error) {
    if (!res.destroyed && !abort.signal.aborted) throw error;
  } finally {
    res.off("close", disconnected);
  }
}

/** Resolve a registered project id to its canonical repo root via the durable
 *  project registry (the same handle listProjects exposes). Null when unknown or
 *  the build has no project service — feeds the project-scoped Outputs routes
 *  (D15/Block B). An unavailable registry answers "no such project", never 500. */
export async function resolveProjectRoot(
  listProjects: (() => Promise<{ projects: unknown[] }>) | undefined,
  id: string,
): Promise<string | null> {
  if (!listProjects) return null;
  try {
    const { projects } = await listProjects();
    for (const raw of projects) {
      const project = raw as Record<string, unknown>;
      if (project["id"] === id && typeof project["root"] === "string" && project["root"].trim())
        return project["root"];
    }
  } catch {
    /* an unavailable registry answers "no such project", never a 500 */
  }
  return null;
}

/** A run's project root, taken from its TYPED scope — NOT by path-slicing the
 *  runDir. Slicing on `.claudexor` would resolve a no-project run (whose run dir
 *  is `~/.claudexor/v3/runs/<id>`) to the user's HOME and let /produced list
 *  `~/artifacts` (review-flagged). Null for scope `none` ⇒ no produced outputs.
 *
 *  This is the LIVE PROJECT root — correct for an in-place run, but NOT the tree
 *  an ISOLATED-thread run actually mutated. Route resolution goes through
 *  `resolveProducedRoot`, which redirects an isolated run to its own worktree. */
export function producedRepoRoot(rec: DaemonRunRecord): string | null {
  const scope = (rec.params as { scope?: { kind?: string; root?: string } } | undefined)?.scope;
  return scope?.kind === "project" && typeof scope.root === "string" && scope.root.trim()
    ? scope.root
    : null;
}

/** The thread this run was bound to, from its typed request params (never a
 *  caller-suppliable execution root). Null for a non-thread one-shot. */
function producedThreadId(rec: DaemonRunRecord): string | null {
  const threadId = (rec.params as { threadId?: unknown } | undefined)?.threadId;
  return typeof threadId === "string" && threadId.trim() ? threadId : null;
}

/**
 * Where a run's produced `artifacts/` outputs actually live (QA-038).
 *
 * An ISOLATED-thread run executes in a persistent per-thread git worktree
 * (pinned by the `claudexor/thread-*` branch), NOT in the live project — the
 * project stays untouched until an explicit thread apply. So its produced
 * outputs must be read from that worktree. Reading the live project instead
 * attributes pre-existing/future project files to the run and 404s the file the
 * run actually created.
 *
 * An in-place run and a non-thread one-shot keep the live project root (correct
 * today). An isolated thread whose worktree was purged/trashed (or never
 * materialized) resolves to `worktree_unavailable` — a typed answer naming the
 * reason, NEVER a silent fallback to the live project.
 */
export type ProducedRootResolution =
  | { kind: "root"; root: string }
  | { kind: "no_project" }
  | {
      kind: "worktree_unavailable";
      threadId: string | null;
      reason: WorktreeUnavailableReason;
      /** The missing tree is a caller-owned delegated workspace, not a managed worktree. */
      callerOwned?: boolean;
    };

type WorktreeUnavailableReason =
  "worktree_not_retained" | "worktree_missing" | "authority_unavailable";

export async function resolveProducedRoot(
  rec: DaemonRunRecord,
  resolveThreadWorkspace?: ArtifactServeContext["resolveThreadWorkspace"],
): Promise<ProducedRootResolution> {
  const projectRoot = producedRepoRoot(rec);
  if (!projectRoot) return { kind: "no_project" };
  const threadId = producedThreadId(rec);
  // A delegated run recorded its caller-owned execution address: its outputs
  // live there or nowhere — never under the stable project identity.
  const executionRoot = runExecutionWorkspaceRoot(rec);
  if (executionRoot) {
    return existsSync(executionRoot)
      ? { kind: "root", root: executionRoot }
      : { kind: "worktree_unavailable", threadId, reason: "worktree_missing", callerOwned: true };
  }
  if (threadId && resolveThreadWorkspace) {
    let workspace: ResolvedThreadWorkspace | null;
    try {
      workspace = await resolveThreadWorkspace(threadId);
    } catch {
      // The thread store could not answer for a run BOUND to a thread. We cannot
      // prove this run executed in the live project, so serving the live root
      // would re-open the QA-038 fail-open leak. Answer typed authority-
      // unavailable (a transient 503), never the live project root.
      return { kind: "worktree_unavailable", threadId, reason: "authority_unavailable" };
    }
    if (workspace?.mode === "isolated" || workspace?.mode === "delegated") {
      const worktree = workspace.worktreePath;
      const owner = workspace.mode === "delegated" ? { callerOwned: true } : {};
      // Purge nulls worktree_path (and removes the tree); a never-written
      // isolated thread also has none. Either way there is no run-owned tree to
      // serve — answer typed, do not leak the live project.
      if (!worktree)
        return {
          kind: "worktree_unavailable",
          threadId,
          reason: "worktree_not_retained",
          ...owner,
        };
      if (!existsSync(worktree))
        return { kind: "worktree_unavailable", threadId, reason: "worktree_missing", ...owner };
      return { kind: "root", root: worktree };
    }
  }
  return { kind: "root", root: projectRoot };
}

/** The honest answer when an isolated run's produced tree cannot be served: the
 *  run existed and ran, but its execution tree is gone (410) or the thread
 *  authority that would locate it could not answer (503) — never a fresh
 *  live-project snapshot under this run id (QA-038). */
function isolatedWorktreeUnavailableBody(resolved: {
  threadId: string | null;
  reason: WorktreeUnavailableReason;
  callerOwned?: boolean;
}): { error: string; code: string; reason: string; thread_id: string | null } {
  if (resolved.reason === "authority_unavailable") {
    return {
      error: `thread ${resolved.threadId} workspace could not be resolved to serve produced outputs (thread authority unavailable)`,
      code: "thread_authority_unavailable",
      reason: resolved.reason,
      thread_id: resolved.threadId,
    };
  }
  const detail =
    resolved.reason === "worktree_not_retained"
      ? "its isolated worktree was purged or never materialized"
      : "its execution tree is no longer on disk";
  return {
    error: `${resolved.threadId ? `thread ${resolved.threadId}` : "this run"} has no retained execution tree for produced outputs (${detail})`,
    code: resolved.callerOwned
      ? "execution_workspace_unavailable"
      : "isolated_worktree_unavailable",
    reason: resolved.reason,
    thread_id: resolved.threadId,
  };
}

/** A gone worktree is permanent (410); an unavailable thread authority is a
 *  transient store failure (503). Both fail CLOSED — never the live root. */
function worktreeUnavailableStatus(reason: WorktreeUnavailableReason): 410 | 503 {
  return reason === "authority_unavailable" ? 503 : 410;
}
