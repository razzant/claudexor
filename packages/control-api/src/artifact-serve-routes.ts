/**
 * Run-artifact serving routes (list/fetch for run trees and produced project
 * outputs), extracted from the daemon-server shell. One owner of artifact
 * MIME/caps/redaction policy and of the honest post-GC answer: a
 * retention-reclaimed run serves a typed 410 tombstone, never a mysterious
 * 404 (W3.6).
 */
import type { ServerResponse } from "node:http";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import {
  ControlArtifactListResponse,
  ControlProjectOutputsResponse,
  type ControlArtifactInfo,
} from "@claudexor/schema";
import { containsSecretLikeToken, redactSecrets } from "@claudexor/util";
import { safeArtifactPath, safeArtifactRoot } from "./artifact-paths.js";
import { readRunTombstone } from "./retention.js";
import type { DaemonRunRecord } from "./daemon-server.js";

const MAX_ARTIFACT_FETCH_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACT_BINARY_FETCH_BYTES = 32 * 1024 * 1024;

/** Server-owned workspace facts for a thread, taken from its journal record:
 *  the mode and, for an isolated thread, the persistent worktree path (pinned by
 *  the `claudexor/thread-*` branch) where its turns actually executed. */
export interface ResolvedThreadWorkspace {
  mode: "in_place" | "isolated";
  /** The isolated thread's persistent worktree; null once purged (or before the
   *  first write turn materializes it). */
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
    ctx.json(
      res,
      200,
      ControlProjectOutputsResponse.parse({
        projectId,
        artifacts: listArtifacts(join(root, "artifacts")),
      }),
    );
    return true;
  }

  const projectOutputsFetchMatch = /^\/projects\/([^/]+)\/outputs\/(.+)$/.exec(path);
  if (method === "GET" && projectOutputsFetchMatch) {
    const projectId = decodeURIComponent(projectOutputsFetchMatch[1] as string);
    const root = ctx.resolveProjectRoot ? await ctx.resolveProjectRoot(projectId) : null;
    if (!root) return (ctx.json(res, 404, { error: "no such project" }), true);
    const target = safeArtifactPath(
      join(root, "artifacts"),
      decodeURIComponent(projectOutputsFetchMatch[2] as string),
    );
    serveArtifactFile(ctx, res, target);
    return true;
  }

  const artifactsRootMatch = /^\/runs\/([^/]+)\/artifacts$/.exec(path);
  if (method === "GET" && artifactsRootMatch) {
    const rec = await ctx.findRun(decodeURIComponent(artifactsRootMatch[1] as string));
    if (!rec?.runDir) return (ctx.json(res, 404, { error: "no such run" }), true);
    const tombstone = readRunTombstone(rec.runDir);
    if (tombstone) return (ctx.json(res, 410, expiredRunBody(tombstone)), true);
    ctx.json(
      res,
      200,
      ControlArtifactListResponse.parse({
        runId: rec.runId ?? rec.id,
        artifacts: listArtifacts(rec.runDir),
      }),
    );
    return true;
  }

  const artifactFetchMatch = /^\/runs\/([^/]+)\/artifacts\/(.+)$/.exec(path);
  if (method === "GET" && artifactFetchMatch) {
    const rec = await ctx.findRun(decodeURIComponent(artifactFetchMatch[1] as string));
    if (!rec?.runDir) return (ctx.json(res, 404, { error: "no such run" }), true);
    const tombstone = readRunTombstone(rec.runDir);
    if (tombstone) return (ctx.json(res, 410, expiredRunBody(tombstone)), true);
    const target = safeArtifactPath(
      rec.runDir,
      decodeURIComponent(artifactFetchMatch[2] as string),
    );
    serveArtifactFile(ctx, res, target);
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
    const artifacts =
      resolved.kind === "root" ? listArtifacts(join(resolved.root, "artifacts")) : [];
    ctx.json(
      res,
      200,
      ControlArtifactListResponse.parse({ runId: rec.runId ?? rec.id, artifacts }),
    );
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
    const target = safeArtifactPath(
      join(resolved.root, "artifacts"),
      decodeURIComponent(producedFetchMatch[2] as string),
    );
    serveArtifactFile(ctx, res, target);
    return true;
  }

  return false;
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

/** Shared artifact-file body: caps, patch secret fence, text redaction. */
function serveArtifactFile(
  ctx: ArtifactServeContext,
  res: ServerResponse,
  target: string | null,
): void {
  if (!target || !existsSync(target) || lstatSync(target).isDirectory())
    return ctx.json(res, 404, { error: "no such artifact" });
  const stats = lstatSync(target);
  const cap = isTextArtifact(target) ? MAX_ARTIFACT_FETCH_BYTES : MAX_ARTIFACT_BINARY_FETCH_BYTES;
  if (stats.size > cap) {
    return ctx.json(res, 413, {
      error: `artifact is ${stats.size} bytes (limit ${cap}); read it from disk at ${target}`,
      bytes: stats.size,
    });
  }
  let data = readFileSync(target);
  if (isPatchArtifact(target) && containsSecretLikeToken(data.toString("utf8"))) {
    return ctx.json(res, 409, {
      error: "artifact contains secret-like token; refusing to serve patch",
    });
  }
  if (isTextArtifact(target)) data = Buffer.from(redactSecrets(data.toString("utf8")), "utf8");
  res.writeHead(200, { "content-type": contentType(target), "content-length": data.length });
  res.end(data);
}

/** The honest post-GC answer (W3.6): the run existed, retention reclaimed its
 * artifacts — a typed 410, never a mysterious 404. */
function expiredRunBody(tombstone: { run_id: string; deleted_at: string }): {
  error: string;
  code: string;
  deleted_at: string;
} {
  return {
    error: `run artifacts were reclaimed by retention on ${tombstone.deleted_at}`,
    code: "run_expired_by_retention",
    deleted_at: tombstone.deleted_at,
  };
}

export function listArtifacts(root: string): ControlArtifactInfo[] {
  const safeRoot = safeArtifactRoot(root);
  if (!safeRoot) return [];
  const out: ControlArtifactInfo[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      const rel = relative(safeRoot, abs).split(sep).join("/");
      out.push({
        path: rel,
        kind: st.isDirectory() ? "directory" : "file",
        bytes: st.isDirectory() ? undefined : st.size,
        mime: st.isDirectory() ? undefined : artifactMime(rel),
      });
      if (st.isDirectory()) walk(abs);
    }
  };
  walk(safeRoot);
  return out.sort((a, b) => a.path.localeCompare(b.path));
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
  | { kind: "worktree_unavailable"; threadId: string; reason: WorktreeUnavailableReason };

type WorktreeUnavailableReason =
  "worktree_not_retained" | "worktree_missing" | "authority_unavailable";

export async function resolveProducedRoot(
  rec: DaemonRunRecord,
  resolveThreadWorkspace?: ArtifactServeContext["resolveThreadWorkspace"],
): Promise<ProducedRootResolution> {
  const projectRoot = producedRepoRoot(rec);
  if (!projectRoot) return { kind: "no_project" };
  const threadId = producedThreadId(rec);
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
    if (workspace?.mode === "isolated") {
      const worktree = workspace.worktreePath;
      // Purge nulls worktree_path (and removes the tree); a never-written
      // isolated thread also has none. Either way there is no run-owned tree to
      // serve — answer typed, do not leak the live project.
      if (!worktree)
        return { kind: "worktree_unavailable", threadId, reason: "worktree_not_retained" };
      if (!existsSync(worktree))
        return { kind: "worktree_unavailable", threadId, reason: "worktree_missing" };
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
  threadId: string;
  reason: WorktreeUnavailableReason;
}): { error: string; code: string; reason: string; thread_id: string } {
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
      : "its isolated worktree directory is no longer on disk";
  return {
    error: `isolated thread ${resolved.threadId} has no retained worktree for produced outputs (${detail})`,
    code: "isolated_worktree_unavailable",
    reason: resolved.reason,
    thread_id: resolved.threadId,
  };
}

/** A gone worktree is permanent (410); an unavailable thread authority is a
 *  transient store failure (503). Both fail CLOSED — never the live root. */
function worktreeUnavailableStatus(reason: WorktreeUnavailableReason): 410 | 503 {
  return reason === "authority_unavailable" ? 503 : 410;
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".json":
      return "application/json; charset=utf-8";
    case ".md":
    case ".txt":
    case ".jsonl":
    case ".log":
    case ".diff":
    case ".patch":
    case ".yaml":
    case ".yml":
      return "text/plain; charset=utf-8";
    case ".html":
    case ".htm":
      return "text/html; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

/** Clean MIME (no charset) for the artifact listing DTO. */
function artifactMime(path: string): string {
  return contentType(path).split(";")[0] as string;
}

function isPatchArtifact(path: string): boolean {
  const ext = extname(path);
  return ext === ".diff" || ext === ".patch";
}

/**
 * Extensions whose bytes are semantic TEXT even when their MIME is not `text/*`
 * or JSON — SVG is served as `image/svg+xml` but is XML text, and `.csv`/`.xml`/
 * `.markdown`/`.text` currently fall through `contentType` to
 * `application/octet-stream`. Without this set those files took the 32MiB BINARY
 * cap and skipped `redactSecrets`, so a secret-like token inside a served
 * artifact leaked raw (QA-067). Listing them here routes them through the text
 * path: the smaller text cap AND secret redaction.
 */
const SEMANTIC_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".csv",
  ".xml",
  ".svg",
  ".markdown",
  ".text",
]);

function isTextArtifact(path: string): boolean {
  const type = contentType(path);
  if (type.startsWith("text/") || type.startsWith("application/json")) return true;
  return SEMANTIC_TEXT_EXTENSIONS.has(extname(path).toLowerCase());
}
