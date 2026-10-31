/** Finite, read-only artifact operations shared by the bulk executor and run
 * projection. No daemon, response, registry, or open stream crosses this API. */
import { unrenderedPatchView } from "./patch-view.js";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { isMarkedAsUntransferable } from "node:worker_threads";
import {
  ControlArtifactListResponse,
  ControlProjectOutputsResponse,
  type ControlArtifactInfo,
} from "@claudexor/schema";
import { RETAINED_OUTPUT_PATH } from "@claudexor/event-log";
import { isVanishedErrno, safeArtifactPath, safeArtifactRoot } from "./artifact-paths.js";
import { readRunTombstone } from "./retention.js";
import { locateFilesArtifact, type FilesArtifactTransfer } from "./files-artifact-stream.js";

const MAX_ARTIFACT_FETCH_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACT_BINARY_FETCH_BYTES = 32 * 1024 * 1024;

export type ArtifactReadRequest =
  | {
      kind: "list";
      root: string | null;
      owner: { kind: "run"; id: string } | { kind: "project"; id: string };
      runArtifact?: boolean;
    }
  | {
      kind: "fetch";
      root: string;
      relative: string;
      runArtifact?: boolean;
    };

export type ArtifactReadResult =
  | { kind: "body"; contentType: string; body: Uint8Array }
  | { kind: "error"; status: number; body: Record<string, unknown> }
  | { kind: "files"; transfer: FilesArtifactTransfer };

/** Listing validation/serialization finish off-loop. Exact
 * immutable files return only their verified manifest address; their potentially
 * unbounded transfer remains an asynchronous, backpressured main-side stream. */
export function readArtifact(request: ArtifactReadRequest): ArtifactReadResult {
  if (request.runArtifact && request.root) {
    const tombstone = readRunTombstone(request.root);
    if (tombstone) return { kind: "error", status: 410, body: expiredRunBody(tombstone) };
  }
  if (request.kind === "list") {
    const artifacts = request.root ? listArtifacts(request.root) : [];
    const body =
      request.owner.kind === "run"
        ? ControlArtifactListResponse.parse({ runId: request.owner.id, artifacts })
        : ControlProjectOutputsResponse.parse({ projectId: request.owner.id, artifacts });
    return {
      kind: "body",
      contentType: "application/json",
      body: transferableBytes(Buffer.from(JSON.stringify(body), "utf8")),
    };
  }
  if (request.runArtifact) {
    const transfer = locateFilesArtifact(request.root, request.relative);
    if (transfer) return { kind: "files", transfer };
    const unrendered = unrenderedPatchView(request.root, request.relative);
    if (unrendered) return { kind: "error", status: 413, body: unrendered };
  }
  return readArtifactFile(
    safeArtifactPath(request.root, request.relative),
    request.runArtifact === true && request.relative === RETAINED_OUTPUT_PATH,
  );
}

/** Shared artifact-file body: path checks and size caps, then the exact bytes
 * (one funnel for run artifacts, outputs and produced). */
function readArtifactFile(target: string | null, fullRetainedOutput = false): ArtifactReadResult {
  if (!target || !existsSync(target) || lstatSync(target).isDirectory())
    return { kind: "error", status: 404, body: { error: "no such artifact" } };
  const stats = lstatSync(target);
  // This generated document is a full-result transfer, not a log preview. It
  // still passes the same path checks below.
  const cap = fullRetainedOutput
    ? Infinity
    : isTextArtifact(target)
      ? MAX_ARTIFACT_FETCH_BYTES
      : MAX_ARTIFACT_BINARY_FETCH_BYTES;
  if (stats.size > cap) {
    return {
      kind: "error",
      status: 413,
      body: {
        error: `artifact is ${stats.size} bytes (limit ${cap}); read it from disk at ${target}`,
        bytes: stats.size,
      },
    };
  }
  const data = readFileSync(target);
  return { kind: "body", contentType: contentType(target), body: transferableBytes(data) };
}

/** Large reads already own their complete allocation. Small Buffer pool slices
 * must be copied before transfer, so detaching one response cannot detach other
 * pooled values or clone an unrelated pool alongside the served bytes. */
function transferableBytes(data: Buffer): Uint8Array {
  return data.byteOffset === 0 &&
    data.byteLength === data.buffer.byteLength &&
    !isMarkedAsUntransferable(data.buffer)
    ? data
    : new Uint8Array(data);
}

/** The honest post-GC answer (W3.6): the run existed, retention reclaimed its
 * artifacts — a typed 410, never a mysterious 404. */
export function expiredRunBody(tombstone: { run_id: string; deleted_at: string }): {
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

/**
 * Enumerate an artifact tree as a point-in-time SNAPSHOT that tolerates
 * concurrent mutation (GH #128): an entry that vanishes between readdir and
 * lstat (git's atomic tmp-object renames in reviewer workspaces, workspace
 * cleanup, retention deletion) is skipped and a directory that vanishes
 * mid-walk lists as empty — a partial snapshot, never a 500. Only vanish
 * errnos (ENOENT/ENOTDIR) are tolerated; anything else stays loud. `.git`
 * entries are never enumerated (engine-owned churn — the reviewer-workspace
 * baseline repo lives inside the run tree) but remain fetchable by explicit
 * path. Symlinks are likewise skipped from the listing (pinned behavior).
 */
export function listArtifacts(root: string): ControlArtifactInfo[] {
  const safeRoot = safeArtifactRoot(root);
  if (!safeRoot) return [];
  const out: ControlArtifactInfo[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (err) {
      if (isVanishedErrno(err)) return; // directory vanished mid-walk → empty subtree
      throw err;
    }
    for (const name of names) {
      if (name === ".git") continue;
      const abs = join(dir, name);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(abs);
      } catch (err) {
        if (isVanishedErrno(err)) continue; // entry vanished between readdir and lstat
        throw err;
      }
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

/**
 * Extensions whose bytes are semantic TEXT even when their MIME is not `text/*`
 * or JSON, so `contentType` classifies them as `application/octet-stream`.
 * They take the smaller text fetch cap instead of the 32MiB binary cap. Truly
 * binary types (images, PDFs, archives) stay on the binary cap.
 */
const SEMANTIC_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  // structured data / markup
  ".csv",
  ".xml",
  ".svg",
  ".markdown",
  ".text",
  ".json5",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".css",
  // source code
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".sh",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".sql",
]);

function isTextArtifact(path: string): boolean {
  const type = contentType(path);
  if (type.startsWith("text/") || type.startsWith("application/json")) return true;
  return SEMANTIC_TEXT_EXTENSIONS.has(extname(path).toLowerCase());
}
