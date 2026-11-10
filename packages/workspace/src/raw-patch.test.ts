import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  RAW_ACCEPTED_REF,
  RAW_PENDING_REF,
  RAW_PENDING_RESULT_REF,
  rawAcceptedPaths,
  rawCandidateTree,
  rawIgnoredAcceptedPaths,
  rawPatchRefusalIsModelCorrectable,
  transferRawRecords,
  RawPatchRefusalError,
} from "./raw-patch.js";
import { snapshotTree } from "./git-snapshot.js";
import { captureWorkingTreeTransient } from "./git-transient-capture.js";
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
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

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

describe("the paths an accepted patch wrote stay whatever the ignore rules say (#594)", () => {
  /** A project that ignores `*.log` and `out/`, and an isolated worktree at its base. */
  function ignoring() {
    const repo = reapMk(join(tmpdir(), "raw-patch-ignored-"));
    git(repo, "init");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    writeFileSync(join(repo, ".gitignore"), "*.log\nout/\n");
    writeFileSync(join(repo, "a.txt"), "old\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base");
    const baseCommitSha = git(repo, "rev-parse", "HEAD");
    const worktreePath = reapMk(join(tmpdir(), "raw-patch-ignored-tree-"));
    execFileSync("git", ["-C", repo, "worktree", "add", "--detach", worktreePath, baseCommitSha]);
    const paths = (tree: string) =>
      git(worktreePath, "ls-tree", "-r", "--name-only", tree).split("\n").filter(Boolean).sort();
    return { repo, worktreePath, baseCommitSha, paths };
  }
  /** The packet of one exact tree, as the engine builds it: every file readable and editable. */
  function packetOf(worktreePath: string, baseCommitSha: string, tree: string) {
    const files = git(worktreePath, "ls-tree", "-r", tree)
      .split("\n")
      .map((line) => {
        const [meta, path] = line.split("\t") as [string, string];
        const [mode, , oid] = meta.split(" ") as [string, string, string];
        const content = execFileSync("git", ["-C", worktreePath, "cat-file", "blob", oid], {
          encoding: "utf8",
        });
        return { path, mode, blob_oid: oid, content_hash: sha256(content), content };
      });
    return RawContextPacket.parse({
      schema_version: 1,
      packet_hash: `sha256:${tree}`,
      base_commit_sha: baseCommitSha,
      base_tree_sha: tree,
      readable_files: files,
      editable_paths: files.map((file) => file.path),
      creatable_roots: ["."],
      file_manifest: files.map((file) => ({
        path: file.path,
        disposition: "full",
        bytes: Buffer.byteLength(file.content),
        hash: file.content_hash,
      })),
      omissions: [],
      evidence_refs: files.map((file) => `git:${tree}:${file.path}:${file.blob_oid}`),
    });
  }
  const proposal = (packet: RawContextPacket, patch: string, paths: string[]) =>
    RawGitPatchEnvelope.parse({
      schema_version: 1,
      context_packet_hash: packet.packet_hash,
      base_tree_sha: packet.base_tree_sha,
      patch,
      patch_hash: sha256(patch),
      touched_paths: paths.map((path) => ({
        path,
        expected_blob_oid:
          packet.readable_files.find((file) => file.path === path)?.blob_oid ?? null,
      })),
    });
  const create = (path: string, line: string) =>
    `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${line}\n`;
  const edit = (path: string, from: string, to: string) =>
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${from}\n+${to}\n`;
  const remove = (path: string, line: string) =>
    `diff --git a/${path} b/${path}\ndeleted file mode 100644\n--- a/${path}\n+++ /dev/null\n@@ -1 +0,0 @@\n-${line}\n`;

  it("the next round reads, edits and deletes the ignored file a round created; nothing else ignored enters", async () => {
    const f = ignoring();
    const consume = (packet: RawContextPacket, patch: string, paths: string[]) =>
      consumeRawPatchEnvelope({
        repoRoot: f.repo,
        worktreePath: f.worktreePath,
        baseCommitSha: f.baseCommitSha,
        context: packet,
        envelope: proposal(packet, patch, paths),
      });
    const record = () => git(f.worktreePath, "rev-parse", RAW_ACCEPTED_REF);
    const first = packetOf(f.worktreePath, f.baseCommitSha, await rawCandidateTree(f.worktreePath));
    const one = await consume(
      first,
      create("debug.log", "proposed") + edit("a.txt", "old", "new"),
      ["debug.log", "a.txt"],
    );
    // The worktree records the paths the patch wrote; what they add beyond the base is
    // what the ignore rules may hide.
    expect(f.paths(record())).toEqual(["a.txt", "debug.log"]);
    expect((await rawAcceptedPaths(f.worktreePath, f.baseCommitSha)).sort()).toEqual([
      "a.txt",
      "debug.log",
    ]);
    writeFileSync(join(f.worktreePath, "gate.log"), "what a gate leaves\n");
    // A plain snapshot (native capture, turn snapshots) still follows Git's ignore rules.
    expect(f.paths(await snapshotTree(f.worktreePath))).toEqual([".gitignore", "a.txt"]);
    // The raw candidate is exactly the accepted proposal, and nothing else.
    const tree = await rawCandidateTree(f.worktreePath);
    expect(tree).toBe(one.materializedTreeSha);
    expect(f.paths(tree)).toEqual([".gitignore", "a.txt", "debug.log"]);

    const second = packetOf(f.worktreePath, f.baseCommitSha, tree);
    expect(second.editable_paths).toContain("debug.log");
    const edited = edit("debug.log", "proposed", "edited");
    const kept = record();
    // The record is what makes the worktree hold the packet's tree: without it the
    // ignore rules hide the file again and the round is refused as stale.
    git(f.worktreePath, "update-ref", "-d", RAW_ACCEPTED_REF);
    await expect(consume(second, edited, ["debug.log"])).rejects.toMatchObject({
      code: "raw_patch_base_mismatch",
    });
    git(f.worktreePath, "update-ref", RAW_ACCEPTED_REF, kept);
    const two = await consume(second, edited, ["debug.log"]);
    expect(f.paths(record())).toEqual(["a.txt", "debug.log"]);
    expect(readFileSync(join(f.worktreePath, "debug.log"), "utf8")).toBe("edited\n");
    expect(await rawCandidateTree(f.worktreePath)).toBe(two.materializedTreeSha);

    const third = packetOf(f.worktreePath, f.baseCommitSha, two.materializedTreeSha);
    const three = await consume(third, remove("debug.log", "edited"), ["debug.log"]);
    expect(existsSync(join(f.worktreePath, "debug.log"))).toBe(false);
    expect(await rawAcceptedPaths(f.worktreePath, f.baseCommitSha)).toEqual(["a.txt"]);
    expect(await rawCandidateTree(f.worktreePath)).toBe(three.materializedTreeSha);
    expect(f.paths(three.materializedTreeSha)).toEqual([".gitignore", "a.txt"]);
    // The worktree's index, HEAD and the source repository were never involved.
    expect(git(f.worktreePath, "ls-files")).toBe(".gitignore\na.txt");
    expect(git(f.worktreePath, "rev-parse", "HEAD")).toBe(f.baseCommitSha);
    expect(existsSync(join(f.repo, "debug.log"))).toBe(false);
  });

  it("the record is the worktree's own: the source repository and a sibling worktree have none", async () => {
    const f = ignoring();
    const first = packetOf(f.worktreePath, f.baseCommitSha, await rawCandidateTree(f.worktreePath));
    await consumeRawPatchEnvelope({
      repoRoot: f.repo,
      worktreePath: f.worktreePath,
      baseCommitSha: f.baseCommitSha,
      context: first,
      envelope: proposal(first, create("debug.log", "proposed"), ["debug.log"]),
    });
    const sibling = reapMk(join(tmpdir(), "raw-patch-sibling-"));
    execFileSync("git", ["-C", f.repo, "worktree", "add", "--detach", sibling, f.baseCommitSha]);
    writeFileSync(join(sibling, "debug.log"), "the sibling's own log\n");
    expect(await rawAcceptedPaths(sibling, f.baseCommitSha)).toEqual([]);
    expect(f.paths(await rawCandidateTree(sibling))).toEqual([".gitignore", "a.txt"]);
    expect(git(f.repo, "for-each-ref")).not.toContain("claudexor");
    expect(await rawAcceptedPaths(f.worktreePath, f.baseCommitSha)).toEqual(["debug.log"]);
  });

  it("transfers accepted membership to the adopted worktree without sharing the source ref", async () => {
    const f = ignoring();
    const first = packetOf(f.worktreePath, f.baseCommitSha, await rawCandidateTree(f.worktreePath));
    await consumeRawPatchEnvelope({
      repoRoot: f.repo,
      worktreePath: f.worktreePath,
      baseCommitSha: f.baseCommitSha,
      context: first,
      envelope: proposal(first, create("debug.log", "proposed"), ["debug.log"]),
    });
    const adopted = reapMk(join(tmpdir(), "raw-patch-adopted-"));
    execFileSync("git", ["-C", f.repo, "worktree", "add", "--detach", adopted, f.baseCommitSha]);
    await transferRawRecords(f.worktreePath, adopted);
    expect(await rawAcceptedPaths(adopted, f.baseCommitSha)).toEqual(["debug.log"]);
    // Record transfer follows the already-delivered bytes; it does not copy files.
    writeFileSync(join(adopted, "debug.log"), "proposed\n");
    expect(f.paths(await rawCandidateTree(adopted))).toContain("debug.log");
    git(adopted, "add", "-f", "debug.log");
    expect(await rawIgnoredAcceptedPaths(adopted, f.baseCommitSha)).toEqual([]);
    expect(await rawAcceptedPaths(f.repo, f.baseCommitSha)).toEqual([]);
  });

  it("a file no raw patch wrote stays out when a later patch makes the ignore rules hide it", async () => {
    const f = ignoring();
    const consume = async (patch: string, paths: string[]) => {
      const packet = packetOf(
        f.worktreePath,
        f.baseCommitSha,
        await rawCandidateTree(f.worktreePath),
      );
      return consumeRawPatchEnvelope({
        repoRoot: f.repo,
        worktreePath: f.worktreePath,
        baseCommitSha: f.baseCommitSha,
        context: packet,
        envelope: proposal(packet, patch, paths),
      });
    };
    await consume(create("debug.log", "proposed"), ["debug.log"]);
    // A gate leaves a file the ignore rules do not match yet, so the next packet holds it.
    writeFileSync(join(f.worktreePath, "gate.tmp"), "what a gate leaves\n");
    const ignoreGate =
      "diff --git a/.gitignore b/.gitignore\n--- a/.gitignore\n+++ b/.gitignore\n" +
      "@@ -1,2 +1,3 @@\n *.log\n out/\n+gate.tmp\n";
    await consume(ignoreGate, [".gitignore"]);
    expect((await rawAcceptedPaths(f.worktreePath, f.baseCommitSha)).sort()).toEqual([
      ".gitignore",
      "debug.log",
    ]);
    expect(f.paths(await rawCandidateTree(f.worktreePath))).toEqual([
      ".gitignore",
      "a.txt",
      "debug.log",
    ]);
    const captured = await captureWorkingTreeTransient(f.worktreePath, f.baseCommitSha, [], {
      projectRoot: f.repo,
      keep: await rawAcceptedPaths(f.worktreePath, f.baseCommitSha),
    });
    expect(captured.captureIncomplete, captured.captureFailure?.message).toBe(false);
    expect(captured.patch).toContain("b/debug.log");
    expect(captured.patch).toContain("+gate.tmp");
    expect(captured.patch).not.toContain("b/gate.tmp");
  });

  it("a same-path Raw edit explicitly accepts a native file before a later ignore rule hides it", async () => {
    const f = ignoring();
    writeFileSync(join(f.worktreePath, "native.txt"), "native\n");
    const packet = packetOf(
      f.worktreePath,
      f.baseCommitSha,
      await rawCandidateTree(f.worktreePath),
    );
    await consumeRawPatchEnvelope({
      repoRoot: f.repo,
      worktreePath: f.worktreePath,
      baseCommitSha: f.baseCommitSha,
      context: packet,
      envelope: proposal(packet, edit("native.txt", "native", "raw-edited"), ["native.txt"]),
    });
    const ignore =
      "diff --git a/.gitignore b/.gitignore\n--- a/.gitignore\n+++ b/.gitignore\n" +
      "@@ -1,2 +1,3 @@\n *.log\n out/\n+native.txt\n";
    const next = packetOf(f.worktreePath, f.baseCommitSha, await rawCandidateTree(f.worktreePath));
    await consumeRawPatchEnvelope({
      repoRoot: f.repo,
      worktreePath: f.worktreePath,
      baseCommitSha: f.baseCommitSha,
      context: next,
      envelope: proposal(next, ignore, [".gitignore"]),
    });
    expect(await rawAcceptedPaths(f.worktreePath, f.baseCommitSha)).toContain("native.txt");
    const captured = await captureWorkingTreeTransient(f.worktreePath, f.baseCommitSha, [], {
      projectRoot: f.repo,
      keep: await rawAcceptedPaths(f.worktreePath, f.baseCommitSha),
    });
    expect(captured.captureIncomplete, captured.captureFailure?.message).toBe(false);
    expect(captured.patch).toContain("b/native.txt");
    expect(captured.patch).toContain("+raw-edited");
  });

  it("a copy preserves an accepted source and carries membership to its destination", async () => {
    const f = ignoring();
    const consume = async (patch: string, paths: string[]) => {
      const packet = packetOf(
        f.worktreePath,
        f.baseCommitSha,
        await rawCandidateTree(f.worktreePath),
      );
      return consumeRawPatchEnvelope({
        repoRoot: f.repo,
        worktreePath: f.worktreePath,
        baseCommitSha: f.baseCommitSha,
        context: packet,
        envelope: proposal(packet, patch, paths),
      });
    };
    await consume(create("debug.log", "proposed"), ["debug.log"]);
    const copy =
      "diff --git a/debug.log b/copied.log\n" +
      "similarity index 100%\n" +
      "copy from debug.log\n" +
      "copy to copied.log\n";
    await round(f, copy, ["debug.log", "copied.log"]);
    expect((await rawAcceptedPaths(f.worktreePath, f.baseCommitSha)).sort()).toEqual([
      "copied.log",
      "debug.log",
    ]);
    expect(f.paths(await rawCandidateTree(f.worktreePath))).toEqual([
      ".gitignore",
      "a.txt",
      "copied.log",
      "debug.log",
    ]);
    const trackedCopy =
      "diff --git a/a.txt b/tracked-copy.log\n" +
      "similarity index 100%\n" +
      "copy from a.txt\n" +
      "copy to tracked-copy.log\n";
    await round(f, trackedCopy, ["a.txt", "tracked-copy.log"]);
    expect(await rawAcceptedPaths(f.worktreePath, f.baseCommitSha)).toContain("tracked-copy.log");
    expect(f.paths(await rawCandidateTree(f.worktreePath))).toContain("tracked-copy.log");
  });

  /** One raw round on the fixture: what a lane does with the packet of the tree it holds. */
  const round = async (f: ReturnType<typeof ignoring>, patch: string, paths: string[]) => {
    const packet = packetOf(
      f.worktreePath,
      f.baseCommitSha,
      await rawCandidateTree(f.worktreePath),
    );
    return consumeRawPatchEnvelope({
      repoRoot: f.repo,
      worktreePath: f.worktreePath,
      baseCommitSha: f.baseCommitSha,
      context: packet,
      envelope: proposal(packet, patch, paths),
    });
  };
  /** Put `what` where the record's refs live (a fault of the envelope's own Git store). */
  const block = (f: ReturnType<typeof ignoring>, at: string, what: "file" | "folder") => {
    const target = join(git(f.worktreePath, "rev-parse", "--absolute-git-dir"), at);
    mkdirSync(what === "file" ? join(target, "..") : target, { recursive: true });
    writeFileSync(what === "file" ? target : join(target, "inner"), "in the record's way\n");
  };

  it("a record that cannot be written refuses the patch before any byte lands", async () => {
    const f = ignoring();
    block(f, RAW_PENDING_REF, "folder");
    await expect(round(f, create("debug.log", "proposed"), ["debug.log"])).rejects.toMatchObject({
      code: "raw_patch_requires_isolation",
      category: "internal",
      message: expect.stringContaining("nothing was applied"),
    });
    expect(rawPatchRefusalIsModelCorrectable("raw_patch_requires_isolation")).toBe(false);
    expect(existsSync(join(f.worktreePath, "debug.log"))).toBe(false);
    expect(await rawAcceptedPaths(f.worktreePath, f.baseCommitSha)).toEqual([]);
  });

  it("a record Git cannot look up is refused before anything lands, never read as nothing accepted", async () => {
    const f = ignoring();
    // The fault arrives between the packet's dispatch and its answer.
    const packet = packetOf(
      f.worktreePath,
      f.baseCommitSha,
      await rawCandidateTree(f.worktreePath),
    );
    block(f, "refs/worktree/claudexor", "file");
    const consumed = consumeRawPatchEnvelope({
      repoRoot: f.repo,
      worktreePath: f.worktreePath,
      baseCommitSha: f.baseCommitSha,
      context: packet,
      envelope: proposal(packet, create("debug.log", "proposed"), ["debug.log"]),
    });
    await expect(consumed).rejects.toMatchObject({ code: "raw_patch_requires_isolation" });
    expect(existsSync(join(f.worktreePath, "debug.log"))).toBe(false);
    // Git 2.43 tells a failed lookup from a missing ref (`show-ref --exists`); older Git cannot.
    const tells = (() => {
      try {
        execFileSync("git", ["-C", f.repo, "show-ref", "--exists", "refs/heads/none"], {
          stdio: "pipe",
        });
        return true;
      } catch (error) {
        return (error as { status?: number }).status === 2;
      }
    })();
    if (tells)
      await expect(rawAcceptedPaths(f.worktreePath, f.baseCommitSha)).rejects.toThrow(
        /could not be read/,
      );
  });

  it("a record that fails after the patch landed loses nothing, and the next patch is refused before it writes", async () => {
    const f = ignoring();
    block(f, RAW_ACCEPTED_REF, "folder");
    const applied = await round(f, create("debug.log", "proposed"), ["debug.log"]);
    // The patch applied; its pending record still names what it wrote.
    expect(readFileSync(join(f.worktreePath, "debug.log"), "utf8")).toBe("proposed\n");
    expect(git(f.worktreePath, "rev-parse", RAW_PENDING_RESULT_REF)).toBe(
      applied.materializedTreeSha,
    );
    expect(await rawAcceptedPaths(f.worktreePath, f.baseCommitSha)).toEqual(["debug.log"]);
    expect(await rawCandidateTree(f.worktreePath)).toBe(applied.materializedTreeSha);
    await expect(round(f, edit("a.txt", "old", "new"), ["a.txt"])).rejects.toMatchObject({
      code: "raw_patch_requires_isolation",
      message: expect.stringContaining("never completed"),
    });
    expect(readFileSync(join(f.worktreePath, "a.txt"), "utf8")).toBe("old\n");
  });

  it("a patch that applied whole but missed its promotion is promoted by the next patch, which then applies", async () => {
    const f = ignoring();
    block(f, RAW_ACCEPTED_REF, "folder");
    const first = await round(f, create("debug.log", "proposed"), ["debug.log"]);
    expect(git(f.worktreePath, "rev-parse", RAW_PENDING_RESULT_REF)).toBe(
      first.materializedTreeSha,
    );
    // The fault clears; the worktree still holds exactly the pending tree.
    rmSync(join(git(f.worktreePath, "rev-parse", "--absolute-git-dir"), RAW_ACCEPTED_REF), {
      recursive: true,
    });
    const second = await round(f, edit("debug.log", "proposed", "edited"), ["debug.log"]);
    expect(readFileSync(join(f.worktreePath, "debug.log"), "utf8")).toBe("edited\n");
    expect(f.paths(git(f.worktreePath, "rev-parse", RAW_ACCEPTED_REF))).toEqual(["debug.log"]);
    expect(await rawCandidateTree(f.worktreePath)).toBe(second.materializedTreeSha);
    expect(git(f.worktreePath, "for-each-ref", "refs/worktree/")).not.toContain("raw-pending");
    expect(await rawAcceptedPaths(f.worktreePath, f.baseCommitSha)).toEqual(["debug.log"]);
  });

  it("a pending record the worktree no longer matches stays refused", async () => {
    const f = ignoring();
    block(f, RAW_ACCEPTED_REF, "folder");
    await round(f, create("debug.log", "proposed"), ["debug.log"]);
    rmSync(join(git(f.worktreePath, "rev-parse", "--absolute-git-dir"), RAW_ACCEPTED_REF), {
      recursive: true,
    });
    // Something other than the pending patch changed the candidate since.
    writeFileSync(join(f.worktreePath, "a.txt"), "changed elsewhere\n");
    await expect(
      round(f, edit("a.txt", "changed elsewhere", "new"), ["a.txt"]),
    ).rejects.toMatchObject({
      code: "raw_patch_requires_isolation",
      message: expect.stringContaining("never completed"),
    });
    expect(readFileSync(join(f.worktreePath, "a.txt"), "utf8")).toBe("changed elsewhere\n");
    expect(git(f.worktreePath, "for-each-ref", "refs/worktree/")).toContain("raw-pending");
  });

  it("a record that exists but names no readable tree is thrown, never read as nothing accepted", async () => {
    const f = ignoring();
    expect(await rawAcceptedPaths(f.worktreePath, f.baseCommitSha)).toEqual([]);
    git(
      f.worktreePath,
      "update-ref",
      RAW_ACCEPTED_REF,
      git(f.worktreePath, "rev-parse", "HEAD:a.txt"),
    );
    await expect(rawAcceptedPaths(f.worktreePath, f.baseCommitSha)).rejects.toThrow(
      /names no readable tree/,
    );
    // A tree only another object directory held, gone with it.
    const store = reapMk(join(tmpdir(), "raw-patch-gone-"));
    execFileSync("git", ["init", "-q", "--bare", store]);
    const blob = execFileSync("git", ["--git-dir", store, "hash-object", "-w", "--stdin"], {
      input: "gone\n",
      encoding: "utf8",
    }).trim();
    const gone = execFileSync("git", ["--git-dir", store, "mktree"], {
      input: `100644 blob ${blob}\tgone.log\n`,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["-C", f.worktreePath, "update-ref", RAW_ACCEPTED_REF, gone], {
      env: { ...process.env, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(store, "objects") },
    });
    await expect(rawAcceptedPaths(f.worktreePath, f.baseCommitSha)).rejects.toThrow(
      /names no readable tree/,
    );
  });

  it("each Git view takes an accepted path only as a file Git can reach, and its own exclusions win", async () => {
    const f = ignoring();
    const wt = f.worktreePath;
    const view = async (keep: string[]) => f.paths(await snapshotTree(wt, [], keep));
    writeFileSync(join(wt, "debug.log"), "accepted\n");
    // Git status shows nothing here, so the view must not stop at that answer.
    expect(await view([])).toEqual([".gitignore", "a.txt"]);
    expect(await view(["debug.log"])).toEqual([".gitignore", "a.txt", "debug.log"]);
    mkdirSync(join(wt, "out"));
    writeFileSync(join(wt, "out", "report.txt"), "accepted under an ignored folder\n");
    mkdirSync(join(wt, "dir.log")); // a path that has become an ignored folder
    writeFileSync(join(wt, "dir.log", "inner.txt"), "never swept in\n");
    mkdirSync(join(wt, "real"));
    writeFileSync(join(wt, "real", "x.log"), "behind a symlinked parent\n");
    symlinkSync("real", join(wt, "link.log"));
    mkdirSync(join(wt, "nested"));
    git(join(wt, "nested"), "init");
    writeFileSync(join(wt, "nested", "n.log"), "inside a nested repository\n");
    git(join(wt, "nested"), "add", "-f", "n.log");
    git(join(wt, "nested"), "-c", "user.email=t@e.x", "-c", "user.name=t", "commit", "-m", "n");
    const keep = [
      "debug.log",
      "out/report.txt",
      "gone.log",
      "dir.log",
      "link.log/x.log",
      "nested/n.log",
    ];

    expect(await view(keep)).toEqual([".gitignore", "a.txt", "debug.log", "out/report.txt"]);
    // The views' exclusions differ only where they always did: the next round's tree
    // shows an untracked generated CLAUDE.md bridge like any untracked file, while the
    // capture's own exact exclusion of that bridge still wins over an accepted path.
    writeFileSync(join(wt, "CLAUDE.md"), "generated bridge\n");
    expect(await view([...keep, "CLAUDE.md"])).toEqual([
      ".gitignore",
      "CLAUDE.md",
      "a.txt",
      "debug.log",
      "out/report.txt",
    ]);
    const viewPaths = (patch: string) =>
      [...patch.matchAll(/^diff --git a\/(\S+) b\//gm)].map((match) => match[1]).sort();
    const capture = (options: { keep?: string[] }) =>
      captureWorkingTreeTransient(wt, f.baseCommitSha, [":(exclude,top)CLAUDE.md"], {
        projectRoot: f.repo,
        ...options,
      });
    const without = await capture({});
    expect(without.captureIncomplete, without.captureFailure?.message).toBe(false);
    expect(without.patch).toBe("");
    const captured = await capture({ keep: [...keep, "CLAUDE.md"] });
    expect(captured.captureIncomplete, captured.captureFailure?.message).toBe(false);
    expect(viewPaths(captured.patch)).toEqual(["debug.log", "out/report.txt"]);
    expect(captured.excludedNestedRepositories).toEqual(["nested"]);
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
