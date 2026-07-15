import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RawContextPacket, RawGitPatchEnvelope } from "@claudexor/schema";
import { sha256 } from "@claudexor/util";
import { consumeRawPatchEnvelope, RawPatchRefusalError } from "./raw-patch.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "raw-patch-repo-"));
  git(repo, "init");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "a.txt"), "old\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-m", "base");
  const baseCommitSha = git(repo, "rev-parse", "HEAD");
  const baseTreeSha = git(repo, "rev-parse", "HEAD^{tree}");
  const blobOid = git(repo, "rev-parse", "HEAD:a.txt");
  const worktreePath = mkdtempSync(join(tmpdir(), "raw-patch-tree-"));
  execFileSync("git", ["-C", repo, "worktree", "add", "--detach", worktreePath, baseCommitSha]);
  const context = RawContextPacket.parse({
    schema_version: 1,
    packet_hash: "sha256:packet",
    base_commit_sha: baseCommitSha,
    base_tree_sha: baseTreeSha,
    readable_files: [
      {
        path: "a.txt",
        mode: "100644",
        blob_oid: blobOid,
        content_hash: sha256("old\n"),
        content: "old\n",
      },
    ],
    editable_paths: ["a.txt"],
    file_manifest: [{ path: "a.txt", disposition: "full", bytes: 4, hash: sha256("old\n") }],
    omissions: [],
    evidence_refs: [`git:${baseTreeSha}:a.txt:${blobOid}`],
  });
  const patch = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");
  const envelope = RawGitPatchEnvelope.parse({
    schema_version: 1,
    context_packet_hash: context.packet_hash,
    base_tree_sha: baseTreeSha,
    patch,
    patch_hash: sha256(patch),
    touched_paths: [{ path: "a.txt", expected_blob_oid: blobOid }],
  });
  return { repo, worktreePath, baseCommitSha, context, envelope, blobOid };
}

async function refusalCode(input: ReturnType<typeof fixture>): Promise<string | undefined> {
  try {
    await consumeRawPatchEnvelope({
      repoRoot: input.repo,
      worktreePath: input.worktreePath,
      baseCommitSha: input.baseCommitSha,
      context: input.context,
      envelope: input.envelope,
    });
  } catch (error) {
    return error instanceof RawPatchRefusalError ? error.code : undefined;
  }
  return undefined;
}

describe("raw patch envelope consumer", () => {
  it("checks against the exact base and materializes only in the isolated worktree", async () => {
    const input = fixture();
    const result = await consumeRawPatchEnvelope({
      repoRoot: input.repo,
      worktreePath: input.worktreePath,
      baseCommitSha: input.baseCommitSha,
      context: input.context,
      envelope: input.envelope,
    });
    expect(result.materializedTreeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(join(input.worktreePath, "a.txt"), "utf8")).toBe("new\n");
    expect(readFileSync(join(input.repo, "a.txt"), "utf8")).toBe("old\n");
  });

  it("refuses stale, missing, outside-scope, traversal, binary, truncated, and live-tree patches", async () => {
    const stale = fixture();
    stale.envelope = {
      ...stale.envelope,
      touched_paths: [{ path: "a.txt", expected_blob_oid: "bad" }],
    };
    expect(await refusalCode(stale)).toBe("raw_patch_stale_preimage");

    const missing = fixture();
    missing.envelope = { ...missing.envelope, touched_paths: [] };
    expect(await refusalCode(missing)).toBe("raw_patch_missing_evidence");

    const outside = fixture();
    outside.context = { ...outside.context, editable_paths: [] };
    expect(await refusalCode(outside)).toBe("raw_patch_outside_scope");

    const traversal = fixture();
    traversal.envelope = {
      ...traversal.envelope,
      touched_paths: [{ path: "../a.txt", expected_blob_oid: traversal.blobOid }],
    };
    expect(await refusalCode(traversal)).toBe("raw_patch_path_traversal");

    const binary = fixture();
    const binaryPatch = "diff --git a/a.txt b/a.txt\nBinary files a/a.txt and b/a.txt differ\n";
    binary.envelope = {
      ...binary.envelope,
      patch: binaryPatch,
      patch_hash: sha256(binaryPatch),
    };
    expect(await refusalCode(binary)).toBe("raw_patch_binary_unsupported");

    const truncated = fixture();
    truncated.envelope = {
      ...truncated.envelope,
      patch: "not a diff",
      patch_hash: sha256("not a diff"),
    };
    expect(await refusalCode(truncated)).toBe("raw_patch_truncated");

    const live = fixture();
    live.worktreePath = live.repo;
    expect(await refusalCode(live)).toBe("raw_patch_requires_isolation");
  });
});
