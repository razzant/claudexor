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

export interface ArtifactServeContext {
  findRun(id: string): Promise<DaemonRunRecord | null | undefined>;
  /** Resolve a registered project id to its canonical repo root (null when the
   *  project is unknown or the build has no project registry). */
  resolveProjectRoot?(id: string): Promise<string | null>;
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
    const repoRoot = producedRepoRoot(rec);
    const artifacts = repoRoot ? listArtifacts(join(repoRoot, "artifacts")) : [];
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
    const repoRoot = producedRepoRoot(rec);
    if (!repoRoot) return (ctx.json(res, 404, { error: "no project root for run" }), true);
    const target = safeArtifactPath(
      join(repoRoot, "artifacts"),
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
 *  `~/artifacts` (review-flagged). Null for scope `none` ⇒ no produced outputs. */
export function producedRepoRoot(rec: DaemonRunRecord): string | null {
  const scope = (rec.params as { scope?: { kind?: string; root?: string } } | undefined)?.scope;
  return scope?.kind === "project" && typeof scope.root === "string" && scope.root.trim()
    ? scope.root
    : null;
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

function isTextArtifact(path: string): boolean {
  const type = contentType(path);
  return type.startsWith("text/") || type.startsWith("application/json");
}
