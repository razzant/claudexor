import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceEnvelope, WorkspaceFileState } from "@claudexor/schema";
import * as fileCopy from "./file-copy.js";
import { RunContentIndex } from "./content-index.js";
import { WorkspaceManager } from "./manager.js";

const MiB = 1024 * 1024;
const posix = process.platform !== "win32";
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A small sparse image: 4 KiB of `letter` at each end of 2 MiB, holes between. */
async function image(path: string, letter = "A") {
  const handle = await open(path, "wx", 0o640);
  try {
    await handle.truncate(2 * MiB);
    await handle.write(Buffer.alloc(4096, letter), 0, 4096, 0);
    await handle.write(Buffer.alloc(4096, letter), 0, 4096, 2 * MiB - 4096);
  } finally {
    await handle.close();
  }
}

async function project() {
  const root = await mkdtemp(join(tmpdir(), "claudexor-content-index-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(source);
  await image(join(source, "disk.img"));
  await image(join(source, "twin.img"));
  await writeFile(join(source, "a.txt"), "same small bytes\n");
  await writeFile(join(source, "b.txt"), "same small bytes\n");
  return { root, source };
}

const run = (root: string, source: string, name: string) =>
  new WorkspaceManager(source, { runtimeRoot: join(root, name) });
const directory = (manager: WorkspaceManager, attemptId: string) =>
  manager.create({ taskId: "t", attemptId, workspaceKind: "directory", scopePaths: ["."] });

const blobOf = (state: WorkspaceFileState | null | "unknown" | undefined) => {
  if (!state || state === "unknown" || state.kind !== "file") throw new Error("expected a file");
  return state;
};
const sha = async (path: string) =>
  `sha256:${createHash("sha256")
    .update(await readFile(path))
    .digest("hex")}`;
const baselineBlob = (root: string, runtime: string, attempt: string, state: { sha256: string }) =>
  join(root, runtime, "workspaces/t", attempt, "baseline/content", state.sha256.slice(7));

describe.skipIf(!posix)("one verified payload per digest within a run", () => {
  it("simultaneous attempts, identical files and isolated baselines share one inode", async () => {
    const { root, source } = await project();
    const manager = run(root, source, "run-1");
    const envelopes: WorkspaceEnvelope[] = await Promise.all([
      directory(manager, "a"),
      directory(manager, "b"),
    ]);
    const captured = await Promise.all(
      envelopes.map((env, at) => manager.captureFiles(env, join(root, `attempt-${at}`))),
    );
    for (const [name, twin] of [
      ["disk.img", "twin.img"],
      ["a.txt", "b.txt"],
    ] as const) {
      const entry = captured[0]!.manifest.entries.find((item) => item.path === name)!;
      const state = blobOf(entry.after);
      const twinState = blobOf(
        captured[0]!.manifest.entries.find((item) => item.path === twin)!.after,
      );
      expect(twinState.artifactPath).toBe(state.artifactPath);
      const names = [
        join(root, "attempt-0", state.artifactPath!),
        join(root, "attempt-1", state.artifactPath!),
        baselineBlob(root, "run-1", "a", state),
        baselineBlob(root, "run-1", "b", state),
      ];
      const inodes = await Promise.all(names.map(async (path) => (await lstat(path)).ino));
      expect(new Set(inodes).size).toBe(1);
      expect(await sha(names[1]!)).toBe(state.sha256);
      // A writable tree never holds a stored payload's inode.
      for (const env of envelopes)
        expect((await lstat(join(env.worktree_path, name))).ino).not.toBe(inodes[0]);
    }
    for (const at of [0, 1])
      expect(
        (await readdir(join(root, `attempt-${at}`, "final/files/content"))).filter(
          (name) => !/^[0-9a-f]{64}$/.test(name),
        ),
      ).toEqual([]);
  });

  it("verifies a stored payload once per inode, not on every further name", async () => {
    const { root, source } = await project();
    const manager = run(root, source, "run-1");
    const env = await directory(manager, "a");
    await manager.captureFiles(env, join(root, "attempt-0"));
    const reads = vi.spyOn(fileCopy, "fileDigest");
    await manager.captureFiles(env, join(root, "attempt-1"));
    // Each large source is hashed to learn its digest; the held payload, already
    // verified by this run and unchanged, is not hashed again.
    const paths = reads.mock.calls.map(([path]) => String(path));
    expect(paths.filter((path) => path.startsWith(env.worktree_path))).toHaveLength(2);
    expect(paths.filter((path) => path.includes("/content/"))).toEqual([]);
  });

  it("never shares a payload with another run", async () => {
    const { root, source } = await project();
    const first = run(root, source, "run-1");
    const second = run(root, source, "run-2");
    const a = await first.captureFiles(await directory(first, "a"), join(root, "one"));
    await second.captureFiles(await directory(second, "a"), join(root, "two"));
    const state = blobOf(a.manifest.entries.find((item) => item.path === "disk.img")!.after);
    const [one, two] = await Promise.all(
      ["one", "two"].map(async (dir) => lstat(join(root, dir, state.artifactPath!))),
    );
    expect(two!.ino).not.toBe(one!.ino);
  });

  it("never links a held name whose bytes changed, and keeps exact bytes of its own", async () => {
    const { root, source } = await project();
    const manager = run(root, source, "run-1");
    // Live work: no saved baseline shares the tampered inode.
    const env = await manager.create({
      taskId: "t",
      attemptId: "a",
      workspaceKind: "directory",
      scopePaths: ["."],
      inPlace: true,
    });
    const first = await manager.captureFiles(env, join(root, "attempt-0"));
    const state = blobOf(first.manifest.entries.find((item) => item.path === "a.txt")!.after);
    // The run's earlier name of these bytes no longer holds them.
    await writeFile(join(root, "attempt-0", state.artifactPath!), "tampered\n");
    await rm(env.worktree_path + "/b.txt");
    const second = await manager.captureFiles(env, join(root, "attempt-1"));
    const kept = join(root, "attempt-1", state.artifactPath!);
    expect(blobOf(second.manifest.entries.find((item) => item.path === "a.txt")!.after)).toEqual(
      state,
    );
    expect(await sha(kept)).toBe(state.sha256);
    expect((await lstat(kept)).ino).not.toBe(
      (await lstat(join(root, "attempt-0", state.artifactPath!))).ino,
    );
  });

  const inPlace = (manager: WorkspaceManager) =>
    manager.create({
      taskId: "t",
      attemptId: "a",
      workspaceKind: "directory",
      scopePaths: ["."],
      inPlace: true,
    });

  it("stores from its own source when a held name goes away before the link", async () => {
    const { root, source } = await project();
    const manager = run(root, source, "run-1");
    const env = await inPlace(manager);
    const first = await manager.captureFiles(env, join(root, "attempt-0"));
    const state = blobOf(first.manifest.entries.find((item) => item.path === "disk.img")!.after);
    const held = join(root, "attempt-0", state.artifactPath!);
    const real = fileCopy.fileCopyHost.link;
    vi.spyOn(fileCopy.fileCopyHost, "link").mockImplementation(async (from, to) => {
      if (String(from) === held) await rm(held);
      return real(from, to);
    });
    const second = await manager.captureFiles(env, join(root, "attempt-1"));
    const kept = join(root, "attempt-1", state.artifactPath!);
    expect(blobOf(second.manifest.entries.find((item) => item.path === "disk.img")!.after)).toEqual(
      state,
    );
    expect(await sha(kept)).toBe(state.sha256);
  });

  it("does not swallow a refused link of a held name that is still there", async () => {
    const { root, source } = await project();
    const manager = run(root, source, "run-1");
    const env = await inPlace(manager);
    await manager.captureFiles(env, join(root, "attempt-0"));
    vi.spyOn(fileCopy.fileCopyHost, "link").mockRejectedValue(
      Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
    );
    await expect(manager.captureFiles(env, join(root, "attempt-1"))).rejects.toMatchObject({
      code: "EACCES",
    });
  });
});

describe("per-digest claims", () => {
  it("never make a keeper of one digest wait for another digest", async () => {
    const index = new RunContentIndex();
    let release!: () => void;
    const slow = index.exclusive("sha256:a", () => new Promise<void>((done) => (release = done)));
    const order: string[] = [];
    await index.exclusive("sha256:b", async () => void order.push("b"));
    const same = index.exclusive("sha256:a", async () => void order.push("a again"));
    expect(order).toEqual(["b"]);
    release();
    await Promise.all([slow, same]);
    expect(order).toEqual(["b", "a again"]);
  });
});
