import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RawContextPacket,
  RawGitPatchEnvelope,
  type HarnessEvent,
  type RawPatchRefusalCode,
} from "@claudexor/schema";
import { sha256 } from "@claudexor/util";
import {
  captureRawPatchEnvelope,
  consumeRawPatchEnvelope,
  rawCandidateTree,
  rawPatchRefusalIsModelCorrectable,
  RawPatchRefusalError,
} from "./raw-patch.js";
import { rmSync as __rmSyncReap } from "node:fs";
import { afterAll as __afterAllReap } from "vitest";

// W-h: reap every temp dir this suite creates so the gate stops leaking tmpdirs.
const __reapDirs: string[] = [];
function reapMk(...args: Parameters<typeof mkdtempSync>): string {
  const dir = mkdtempSync(...args);
  __reapDirs.push(dir);
  return dir;
}
__afterAllReap(() => {
  for (const dir of __reapDirs.splice(0)) __rmSyncReap(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function fixture() {
  const repo = reapMk(join(tmpdir(), "raw-patch-repo-"));
  git(repo, "init");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "a.txt"), "old\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-m", "base");
  const baseCommitSha = git(repo, "rev-parse", "HEAD");
  const baseTreeSha = git(repo, "rev-parse", "HEAD^{tree}");
  const blobOid = git(repo, "rev-parse", "HEAD:a.txt");
  const worktreePath = reapMk(join(tmpdir(), "raw-patch-tree-"));
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
    creatable_roots: ["."],
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

const refusalCases: Array<{
  name: string;
  expected: RawPatchRefusalCode;
  mutate(input: ReturnType<typeof fixture>): void;
}> = [
  {
    name: "stale preimage",
    expected: "raw_patch_stale_preimage",
    mutate: (input) => {
      input.envelope = {
        ...input.envelope,
        touched_paths: [{ path: "a.txt", expected_blob_oid: "bad" }],
      };
    },
  },
  {
    name: "missing evidence",
    expected: "raw_patch_missing_evidence",
    mutate: (input) => {
      input.envelope = { ...input.envelope, touched_paths: [] };
    },
  },
  {
    name: "outside-scope",
    expected: "raw_patch_outside_scope",
    mutate: (input) => {
      input.context = { ...input.context, editable_paths: [] };
    },
  },
  {
    name: "path traversal",
    expected: "raw_patch_path_traversal",
    mutate: (input) => {
      input.envelope = {
        ...input.envelope,
        touched_paths: [{ path: "../a.txt", expected_blob_oid: input.blobOid }],
      };
    },
  },
  {
    name: "binary",
    expected: "raw_patch_binary_unsupported",
    mutate: (input) => {
      const patch = "diff --git a/a.txt b/a.txt\nBinary files a/a.txt and b/a.txt differ\n";
      input.envelope = { ...input.envelope, patch, patch_hash: sha256(patch) };
    },
  },
  {
    name: "truncated",
    expected: "raw_patch_truncated",
    mutate: (input) => {
      input.envelope = {
        ...input.envelope,
        patch: "not a diff",
        patch_hash: sha256("not a diff"),
      };
    },
  },
  {
    name: "live-tree",
    expected: "raw_patch_requires_isolation",
    mutate: (input) => {
      input.worktreePath = input.repo;
    },
  },
];

describe("raw patch envelope capture (INV-062)", () => {
  // Assembled at runtime so no secret-shaped literal lives in this file.
  const tokenLike = ["ghp", "y".repeat(24)].join("_");
  const patch = `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+${tokenLike}\n`;
  const event = (): HarnessEvent =>
    ({
      type: "patch_produced",
      session_id: "s",
      ts: "t",
      patch_envelope: {
        schema_version: 1,
        context_packet_hash: "sha256:packet",
        base_tree_sha: "tree",
        patch,
        patch_hash: sha256(patch),
        touched_paths: [{ path: "a.txt", expected_blob_oid: "blob" }],
      },
    }) as HarnessEvent;

  it("keeps an envelope whose patch holds secret-like content instead of refusing it early", () => {
    const captured = captureRawPatchEnvelope(true, null, event());
    expect(captured?.patch).toBe(patch);
    expect(captured?.patch_hash).toBe(sha256(patch));
  });

  it("still refuses a disabled lane, a second envelope and a missing envelope", () => {
    const refusal = (run: () => unknown) => {
      try {
        run();
        return null;
      } catch (error) {
        return error instanceof RawPatchRefusalError ? error.code : String(error);
      }
    };
    expect(refusal(() => captureRawPatchEnvelope(false, null, event()))).toBe(
      "raw_patch_missing_evidence",
    );
    const first = captureRawPatchEnvelope(true, null, event());
    expect(refusal(() => captureRawPatchEnvelope(true, first, event()))).toBe(
      "raw_patch_missing_evidence",
    );
    expect(
      refusal(() => captureRawPatchEnvelope(true, null, { ...event(), patch_envelope: undefined })),
    ).toBe("raw_patch_missing_evidence");
    // Non-patch events pass the previous value through untouched.
    expect(
      captureRawPatchEnvelope(true, first, { type: "message", session_id: "s", ts: "t" }),
    ).toBe(first);
  });
});

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

  it("binds create, delete, and rename operations to absent/present base evidence", async () => {
    const created = fixture();
    const createPatch = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1 @@",
      "+new",
      "",
    ].join("\n");
    created.envelope = RawGitPatchEnvelope.parse({
      ...created.envelope,
      patch: createPatch,
      patch_hash: sha256(createPatch),
      touched_paths: [{ path: "new.txt", expected_blob_oid: null }],
    });
    await consumeRawPatchEnvelope({
      repoRoot: created.repo,
      worktreePath: created.worktreePath,
      baseCommitSha: created.baseCommitSha,
      context: created.context,
      envelope: created.envelope,
    });
    expect(readFileSync(join(created.worktreePath, "new.txt"), "utf8")).toBe("new\n");

    const deleted = fixture();
    const deletePatch = [
      "diff --git a/a.txt b/a.txt",
      "deleted file mode 100644",
      "--- a/a.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-old",
      "",
    ].join("\n");
    deleted.envelope = RawGitPatchEnvelope.parse({
      ...deleted.envelope,
      patch: deletePatch,
      patch_hash: sha256(deletePatch),
      touched_paths: [{ path: "a.txt", expected_blob_oid: deleted.blobOid }],
    });
    await consumeRawPatchEnvelope({
      repoRoot: deleted.repo,
      worktreePath: deleted.worktreePath,
      baseCommitSha: deleted.baseCommitSha,
      context: deleted.context,
      envelope: deleted.envelope,
    });
    expect(existsSync(join(deleted.worktreePath, "a.txt"))).toBe(false);

    const renamed = fixture();
    const renamePatch = [
      "diff --git a/a.txt b/b.txt",
      "similarity index 100%",
      "rename from a.txt",
      "rename to b.txt",
      "",
    ].join("\n");
    renamed.envelope = RawGitPatchEnvelope.parse({
      ...renamed.envelope,
      patch: renamePatch,
      patch_hash: sha256(renamePatch),
      touched_paths: [
        { path: "a.txt", expected_blob_oid: renamed.blobOid },
        { path: "b.txt", expected_blob_oid: null },
      ],
    });
    await consumeRawPatchEnvelope({
      repoRoot: renamed.repo,
      worktreePath: renamed.worktreePath,
      baseCommitSha: renamed.baseCommitSha,
      context: renamed.context,
      envelope: renamed.envelope,
    });
    expect(existsSync(join(renamed.worktreePath, "a.txt"))).toBe(false);
    expect(readFileSync(join(renamed.worktreePath, "b.txt"), "utf8")).toBe("old\n");
  });

  it.each(refusalCases)(
    "refuses $name patches",
    async ({ expected, mutate }) => {
      const input = fixture();
      mutate(input);
      expect(await refusalCode(input)).toBe(expected);
    },
    15_000,
  );

  it("refuses a wrong-base or dirty isolated worktree before applying", async () => {
    const wrongBase = fixture();
    writeFileSync(join(wrongBase.worktreePath, "a.txt"), "other\n");
    git(wrongBase.worktreePath, "add", "a.txt");
    git(
      wrongBase.worktreePath,
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "commit",
      "-m",
      "other base",
    );
    expect(await refusalCode(wrongBase)).toBe("raw_patch_base_mismatch");
    expect(readFileSync(join(wrongBase.worktreePath, "a.txt"), "utf8")).toBe("other\n");

    // A tree the packet does not describe: stale since it was sent, whatever changed.
    const dirty = fixture();
    writeFileSync(join(dirty.worktreePath, "local.txt"), "uncommitted\n");
    expect(await refusalCode(dirty)).toBe("raw_patch_base_mismatch");
    expect(readFileSync(join(dirty.worktreePath, "a.txt"), "utf8")).toBe("old\n");

    // A patch bound to another tree, and a packet naming another delivery base.
    const otherTree = fixture();
    otherTree.envelope = { ...otherTree.envelope, base_tree_sha: "0".repeat(40) };
    expect(await refusalCode(otherTree)).toBe("raw_patch_base_mismatch");
    const otherBase = fixture();
    otherBase.context = { ...otherBase.context, base_commit_sha: "0".repeat(40) };
    expect(await refusalCode(otherBase)).toBe("raw_patch_base_mismatch");
  });

  it("applies a later revision against the exact tree the earlier one left (#551)", async () => {
    const input = fixture();
    const consume = (context: RawContextPacket, envelope: RawGitPatchEnvelope) =>
      consumeRawPatchEnvelope({
        repoRoot: input.repo,
        worktreePath: input.worktreePath,
        baseCommitSha: input.baseCommitSha,
        context,
        envelope,
      });
    const createPatch = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1 @@",
      "+first",
      "",
    ].join("\n");
    await consume(
      input.context,
      RawGitPatchEnvelope.parse({
        ...input.envelope,
        patch: createPatch,
        patch_hash: sha256(createPatch),
        touched_paths: [{ path: "new.txt", expected_blob_oid: null }],
      }),
    );
    // The candidate moved; HEAD and the delivery base did not.
    expect(git(input.worktreePath, "rev-parse", "HEAD")).toBe(input.baseCommitSha);
    const tree = await rawCandidateTree(input.worktreePath);
    expect(tree).not.toBe(input.context.base_tree_sha);
    const blob = git(input.worktreePath, "rev-parse", `${tree}:new.txt`);
    const editPatch = [
      "diff --git a/new.txt b/new.txt",
      "--- a/new.txt",
      "+++ b/new.txt",
      "@@ -1 +1 @@",
      "-first",
      "+second",
      "",
    ].join("\n");
    const second = RawContextPacket.parse({
      ...input.context,
      base_tree_sha: tree,
      readable_files: [
        ...input.context.readable_files,
        {
          path: "new.txt",
          mode: "100644",
          blob_oid: blob,
          content_hash: sha256("first\n"),
          content: "first\n",
        },
      ],
      editable_paths: ["a.txt", "new.txt"],
    });
    const edited = {
      schema_version: 1 as const,
      context_packet_hash: second.packet_hash,
      base_tree_sha: tree,
      patch: editPatch,
      patch_hash: sha256(editPatch),
      touched_paths: [{ path: "new.txt", expected_blob_oid: blob }],
    };
    // The packet of the round before is stale now, and so is a patch bound to it.
    await expect(consume(input.context, input.envelope)).rejects.toMatchObject({
      code: "raw_patch_base_mismatch",
    });
    const { materializedTreeSha } = await consume(second, edited);
    expect(readFileSync(join(input.worktreePath, "new.txt"), "utf8")).toBe("second\n");
    expect(await rawCandidateTree(input.worktreePath)).toBe(materializedTreeSha);
    // The worktree's index and the source repository were never involved.
    expect(git(input.worktreePath, "ls-files")).toBe("a.txt");
    expect(existsSync(join(input.repo, "new.txt"))).toBe(false);
  });
});

describe("what a raw patch refusal says about its repair (#551)", () => {
  it("a patch the model wrote badly is its own to correct; a broken state is not", () => {
    for (const code of [
      "raw_patch_path_traversal",
      "raw_patch_outside_scope",
      "raw_patch_stale_preimage",
      "raw_patch_binary_unsupported",
      "raw_patch_truncated",
      "raw_patch_apply_failed",
    ] as const) {
      expect(rawPatchRefusalIsModelCorrectable(code), code).toBe(true);
      expect(new RawPatchRefusalError(code, code).category, code).toBe("harness_error");
    }
    for (const code of [
      "raw_patch_requires_isolation",
      "raw_patch_missing_evidence",
      "raw_patch_digest_mismatch",
      "raw_patch_base_mismatch",
    ] as const) {
      expect(rawPatchRefusalIsModelCorrectable(code), code).toBe(false);
      expect(new RawPatchRefusalError(code, code).category, code).toBe("internal");
    }
    expect(new RawPatchRefusalError("raw_context_exceeds_window", "x").category).toBe("validation");
  });
});
