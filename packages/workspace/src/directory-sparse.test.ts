import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceFileState } from "@claudexor/schema";
import { captureFailureEvidence } from "./capture-failure.js";
import { fileCopyHost } from "./file-copy.js";
import { applyWorkspaceFiles, verifyWorkspaceFiles } from "./files-apply.js";
import { WorkspaceManager } from "./manager.js";

const MiB = 1024 * 1024;
const posix = process.platform !== "win32";
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** 1 MiB with 4 KiB of 'A' at the start, 4 KiB of 'B' at the end, zeros between. */
const IMAGE_SHA = "sha256:7cf9af8fdc8813ecc2f115e0bc2b71a695941824651f0f08070ea93cdd200ff4";
async function image(path: string) {
  const handle = await open(path, "wx", 0o640);
  try {
    await handle.truncate(MiB);
    await handle.write(Buffer.alloc(4096, "A"), 0, 4096, 0);
    await handle.write(Buffer.alloc(4096, "B"), 0, 4096, MiB - 4096);
  } finally {
    await handle.close();
  }
}

async function fixture(inPlace: boolean) {
  const root = await mkdtemp(join(tmpdir(), "claudexor-directory-sparse-"));
  roots.push(root);
  const source = join(root, "source");
  const run = join(root, "run");
  await mkdir(source);
  await image(join(source, "disk.img"));
  await writeFile(join(source, "note.txt"), "before\n");
  await writeFile(join(source, "empty"), "");
  const manager = new WorkspaceManager(source, { runtimeRoot: join(root, "runtime") });
  const env = await manager.create({
    taskId: "t",
    attemptId: "a",
    workspaceKind: "directory",
    scopePaths: ["."],
    inPlace,
  });
  return { root, source, run, manager, env, content: join(run, "final/files/content") };
}

const fileOf = (state: WorkspaceFileState | null | "unknown" | undefined) => {
  if (!state || state === "unknown" || state.kind !== "file") throw new Error("expected a file");
  return state;
};
const digest = async (path: string) =>
  `sha256:${createHash("sha256")
    .update(await readFile(path))
    .digest("hex")}`;

describe.each([
  ["this host's copy", false],
  ["the stream (no clone here)", true],
])("sparse files in a directory result: %s", (_name, noClone) => {
  const withhold = () => {
    if (noClone) vi.spyOn(fileCopyHost, "clone").mockResolvedValue(false);
  };

  it.each([true, false])(
    "in place %s: one private blob per content, exact bytes, independent delivery",
    async (inPlace) => {
      withhold();
      const f = await fixture(inPlace);
      const tree = f.env.worktree_path;
      expect(await digest(join(tree, "disk.img"))).toBe(IMAGE_SHA);
      await writeFile(join(tree, "note.txt"), "after\n");

      const captured = await f.manager.captureFiles(f.env, f.run);

      const entry = captured.manifest.entries.find((item) => item.path === "disk.img")!;
      const after = fileOf(entry.after);
      const mode = (await lstat(join(tree, "disk.img"))).mode & 0o777;
      expect(after).toMatchObject({ sha256: IMAGE_SHA, sizeBytes: MiB, mode });
      const blob = join(f.run, after.artifactPath!);
      expect(await digest(blob)).toBe(IMAGE_SHA);
      // Unchanged input and output are one blob; nothing half-written stays.
      const names = await readdir(f.content);
      expect(names.every((name) => /^[0-9a-f]{64}$/.test(name))).toBe(true);
      // disk.img, the empty file, the new note and (isolated only) its old bytes.
      expect(names).toHaveLength(inPlace ? 3 : 4);
      if (!inPlace) expect(fileOf(entry.before).artifactPath).toBe(after.artifactPath);
      if (posix) {
        const saved = await lstat(blob);
        expect(saved.mode & 0o777).toBe(0o600);
        // The saved payload is never the writable file it was read from.
        expect(saved.ino).not.toBe((await lstat(join(tree, "disk.img"))).ino);
        // An isolated copy's unchanged file is the run's own saved baseline blob,
        // linked (never written twice); live work has no baseline blob.
        expect(saved.nlink).toBe(inPlace ? 1 : 2);
      }
      await verifyWorkspaceFiles(captured.manifest, f.run);
      await truncate(join(tree, "disk.img"), 1);
      expect(await digest(blob)).toBe(IMAGE_SHA);
      if (inPlace) return;

      // Delivery: the original gets the captured output as its own file.
      await truncate(join(tree, "disk.img"), 0);
      await image(join(f.root, "changed.img"));
      const handle = await open(join(f.root, "changed.img"), "r+");
      await handle.write(Buffer.from("C"), 0, 1, MiB / 2);
      await handle.close();
      await rm(join(tree, "disk.img"));
      await writeFile(join(tree, "disk.img"), await readFile(join(f.root, "changed.img")));
      const changed = await f.manager.captureFiles(f.env, join(f.root, "run2"));
      const applied = await applyWorkspaceFiles(f.source, changed.manifest, join(f.root, "run2"));
      expect(applied).toMatchObject({ applied: true });
      const delivered = join(f.source, "disk.img");
      const next = fileOf(changed.manifest.entries.find((item) => item.path === "disk.img")!.after);
      expect(await digest(delivered)).toBe(next.sha256);
      const savedNext = join(f.root, "run2", next.artifactPath!);
      if (posix) expect((await lstat(delivered)).ino).not.toBe((await lstat(savedNext)).ino);
      await writeFile(delivered, "user edit");
      expect(await digest(savedNext)).toBe(next.sha256);
    },
  );

  it("hash-only comparison writes nothing and still sees new and removed paths", async () => {
    withhold();
    const f = await fixture(false);
    const kept = await f.manager.captureFiles(f.env, f.run);
    const probe = join(f.root, "probe");
    const observedPaths = kept.manifest.entries.map((entry) => entry.path);
    const compare = () =>
      f.manager.captureFiles(f.env, probe, { observedPaths, retainContent: false });

    expect((await compare()).manifestSha256).toBe(kept.manifestSha256);
    await writeFile(join(f.env.worktree_path, "new.txt"), "new");
    const added = await compare();
    expect(added.manifestSha256).not.toBe(kept.manifestSha256);
    expect(added.changedPaths).toContain("new.txt");
    await rm(join(f.env.worktree_path, "new.txt"));
    await rm(join(f.env.worktree_path, "note.txt"));
    expect((await compare()).changedPaths).toEqual(["note.txt"]);
    await expect(lstat(probe)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a changed saved baseline is still refused", async () => {
    withhold();
    const f = await fixture(false);
    const state = (await f.manager.captureFiles(f.env, f.run)).manifest.entries.find(
      (entry) => entry.path === "note.txt",
    )!;
    const saved = fileOf(state.before).sha256.slice(7);
    await writeFile(join(f.root, "runtime/workspaces/t/a/baseline/content", saved), "tampered");
    for (const retainContent of [true, false])
      await expect(
        f.manager.captureFiles(f.env, join(f.root, "run2"), { retainContent }),
      ).rejects.toThrow("Baseline bytes no longer match: note.txt");
  });
});

describe("a directory capture that cannot fit", () => {
  it("is a typed refusal with no manifest when free space is too little", async () => {
    const f = await fixture(true);
    vi.spyOn(fileCopyHost, "clone").mockResolvedValue(false);
    vi.spyOn(fileCopyHost, "availableBytes").mockReturnValue(0);
    const error = await f.manager.captureFiles(f.env, f.run).catch((caught: unknown) => caught);
    expect(captureFailureEvidence(error as Error)).toMatchObject({
      code: "capture_space_insufficient",
      requiredBytes: MiB + 64 * MiB,
    });
    await expect(lstat(join(f.run, "final/files/manifest.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await readdir(f.content)).filter((name) => name.startsWith("pending"))).toEqual([]);
    expect(await digest(join(f.source, "disk.img"))).toBe(IMAGE_SHA);
  });

  it("is a typed refusal when free space is unknown and the file exceeds the margin", async () => {
    const f = await fixture(true);
    await truncate(join(f.env.worktree_path, "disk.img"), 65 * MiB);
    vi.spyOn(fileCopyHost, "clone").mockResolvedValue(false);
    vi.spyOn(fileCopyHost, "availableBytes").mockReturnValue(null);
    const error = await f.manager.captureFiles(f.env, f.run).catch((caught: unknown) => caught);
    expect(captureFailureEvidence(error as Error)).toMatchObject({
      code: "capture_space_insufficient",
    });
    await expect(lstat(join(f.run, "final/files/manifest.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps a copy's lack of room as its own cause, never a changed baseline", async () => {
    const f = await fixture(false);
    // The output is small; the large saved preimage must join it in the capture.
    await writeFile(join(f.env.worktree_path, "disk.img"), "shrunk");
    // No hard links here: the saved baseline's bytes must be copied, and cannot fit.
    vi.spyOn(fileCopyHost, "link").mockRejectedValue(
      Object.assign(new Error("EXDEV: cross-device link"), { code: "EXDEV" }),
    );
    vi.spyOn(fileCopyHost, "clone").mockResolvedValue(false);
    vi.spyOn(fileCopyHost, "availableBytes").mockReturnValue(0);
    const error = await f.manager.captureFiles(f.env, f.run).catch((caught: unknown) => caught);
    expect((error as Error).message).not.toContain("Baseline bytes no longer match");
    expect(captureFailureEvidence(error as Error)).toMatchObject({
      code: "capture_space_insufficient",
    });
  });

  it("captures a small result when free space is unknown", async () => {
    const f = await fixture(true);
    vi.spyOn(fileCopyHost, "clone").mockResolvedValue(false);
    vi.spyOn(fileCopyHost, "availableBytes").mockReturnValue(null);
    const captured = await f.manager.captureFiles(f.env, f.run);
    expect(fileOf(captured.manifest.entries.find((e) => e.path === "disk.img")!.after).sha256).toBe(
      IMAGE_SHA,
    );
  });
});

describe("one copy per digest within a run", () => {
  it("writes the same bytes at two paths once", async () => {
    const f = await fixture(true);
    await copyFile(join(f.env.worktree_path, "disk.img"), join(f.env.worktree_path, "twin.img"));
    const copies = vi.spyOn(fileCopyHost, "isSparse");
    const captured = await f.manager.captureFiles(f.env, f.run);
    const paths = ["disk.img", "twin.img"].map((name) =>
      fileOf(captured.manifest.entries.find((entry) => entry.path === name)!.after),
    );
    expect(paths[0]!.artifactPath).toBe(paths[1]!.artifactPath);
    // One stream of the large bytes: the second path's were already held.
    expect(copies.mock.calls.filter(([info]) => info.size >= MiB)).toHaveLength(1);
    expect((await readdir(f.content)).filter((name) => name.startsWith("pending"))).toEqual([]);
  });

  it.skipIf(!posix)("links an earlier attempt's blob instead of storing it again", async () => {
    const f = await fixture(false);
    const first = await f.manager.captureFiles(f.env, join(f.root, "attempt-a"));
    const second = await f.manager.captureFiles(f.env, join(f.root, "attempt-b"));
    const name = fileOf(
      first.manifest.entries.find((entry) => entry.path === "disk.img")!.after,
    ).artifactPath!;
    expect(second.manifestSha256).toBe(first.manifestSha256);
    const a = await lstat(join(f.root, "attempt-a", name));
    const b = await lstat(join(f.root, "attempt-b", name));
    expect(b.ino).toBe(a.ino);
    expect(await digest(join(f.root, "attempt-b", name))).toBe(IMAGE_SHA);
  });

  it("refuses when the shared baseline blob no longer holds its bytes", async () => {
    const f = await fixture(false);
    const first = await f.manager.captureFiles(f.env, join(f.root, "attempt-a"));
    const name = fileOf(
      first.manifest.entries.find((entry) => entry.path === "disk.img")!.after,
    ).artifactPath!;
    await writeFile(join(f.root, "attempt-a", name), "tampered");
    // The attempt's blob is the saved baseline's inode: the baseline changed too.
    await expect(f.manager.captureFiles(f.env, join(f.root, "attempt-b"))).rejects.toThrow(
      "Baseline bytes no longer match: disk.img",
    );
  });
});
