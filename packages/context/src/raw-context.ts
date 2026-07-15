import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runCapture } from "@claudexor/core";
import {
  RawContextPacket,
  type ImplementationTransport,
  type OmissionEntry,
  type RawContextFile,
  type WorkspaceEnvelope,
} from "@claudexor/schema";
import { hashJson, sha256 } from "@claudexor/util";
import { buildScopeAtlas, type AtlasOptions } from "./atlas.js";

interface GitEntry {
  mode: string;
  oid: string;
}

export async function rawContextForEnvelope(
  transport: ImplementationTransport,
  envelope: WorkspaceEnvelope,
): Promise<RawContextPacket | null> {
  if (transport !== "git_patch_envelope") return null;
  if (envelope.worktree_path === envelope.repo_root)
    throw new Error(
      "raw_patch_requires_isolation: raw patch producers require an isolated envelope",
    );
  return buildRawContextPacket(envelope.worktree_path, envelope.base_sha ?? "HEAD");
}

async function gitOutput(repo: string, args: string[]): Promise<string> {
  const result = await runCapture("git", ["-C", repo, ...args], { timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

async function baseEntries(repo: string, baseCommitSha: string): Promise<Map<string, GitEntry>> {
  const output = await gitOutput(repo, ["ls-tree", "-r", "-z", baseCommitSha]);
  const entries = new Map<string, GitEntry>();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (mode && type === "blob" && oid && path) entries.set(path, { mode, oid });
  }
  return entries;
}

/** Build the complete, bounded text packet consumed by raw patch producers. */
export async function buildRawContextPacket(
  repoRoot: string,
  baseCommitSha: string,
  options: AtlasOptions = {},
): Promise<RawContextPacket> {
  const [atlas, treeSha, entries] = await Promise.all([
    buildScopeAtlas(repoRoot, options),
    gitOutput(repoRoot, ["rev-parse", `${baseCommitSha}^{tree}`]).then((value) => value.trim()),
    baseEntries(repoRoot, baseCommitSha),
  ]);
  const readableFiles: RawContextFile[] = [];
  const omissions: OmissionEntry[] = [...atlas.omitted];
  const omittedPaths = new Set(omissions.map((item) => item.path));

  for (const entry of atlas.atlas) {
    if (entry.disposition !== "full") {
      if (!omittedPaths.has(entry.path)) {
        omissions.push({
          path: entry.path,
          reason: entry.reason ?? entry.disposition,
          replacement: "index",
          ...(entry.hash ? { hash: entry.hash } : {}),
        });
      }
      continue;
    }
    const gitEntry = entries.get(entry.path);
    if (!gitEntry || (gitEntry.mode !== "100644" && gitEntry.mode !== "100755")) {
      omissions.push({
        path: entry.path,
        reason: gitEntry ? `unsupported git mode ${gitEntry.mode}` : "missing base-tree evidence",
        replacement: "index",
      });
      continue;
    }
    const content = readFileSync(join(repoRoot, entry.path), "utf8");
    readableFiles.push({
      path: entry.path,
      mode: gitEntry.mode,
      blob_oid: gitEntry.oid,
      content_hash: sha256(content),
      content,
    });
  }

  readableFiles.sort((a, b) => a.path.localeCompare(b.path));
  omissions.sort((a, b) => a.path.localeCompare(b.path));
  const body = {
    schema_version: 1 as const,
    base_commit_sha: baseCommitSha,
    base_tree_sha: treeSha,
    readable_files: readableFiles,
    editable_paths: readableFiles.map((file) => file.path),
    creatable_roots: ["."],
    file_manifest: atlas.atlas,
    omissions,
    evidence_refs: readableFiles.map((file) => `git:${treeSha}:${file.path}:${file.blob_oid}`),
  };
  return RawContextPacket.parse({ ...body, packet_hash: hashJson(body) });
}
