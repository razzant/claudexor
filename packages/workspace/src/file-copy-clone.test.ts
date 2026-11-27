import { copyFile, lstat, mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileCopyHost, writeIndependentCopy } from "./file-copy.js";

const MiB = 1024 * 1024;
const SIZE = 48 * MiB;
const posix = process.platform !== "win32";

/** Allocated bytes, or null where the host does not report them (Windows):
 * an unknown count is no evidence of holes, never zero. */
async function allocated(path: string): Promise<number | null> {
  const blocks = (await lstat(path)).blocks;
  return posix && blocks !== undefined ? blocks * 512 : null;
}
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** 48 MiB with 4 KiB of data at each end: a hole longer than APFS fills itself (~16 MiB). */
async function sparseSource() {
  const root = await mkdtemp(join(tmpdir(), "claudexor-clone-route-"));
  roots.push(root);
  const source = join(root, "source");
  const handle = await open(source, "wx", 0o640);
  try {
    await handle.truncate(SIZE);
    await handle.write(Buffer.alloc(4096, "A"), 0, 4096, 0);
    await handle.write(Buffer.alloc(4096, "B"), 0, 4096, SIZE - 4096);
  } finally {
    await handle.close();
  }
  return { root, source, target: join(root, "target") };
}

describe("which copies may be clones", () => {
  it("streams a mutable source from its own handle, never through the clone route", async () => {
    const clone = vi.spyOn(fileCopyHost, "clone");
    const { source, target } = await sparseSource();
    const digest = await writeIndependentCopy(source, target);
    expect(clone).not.toHaveBeenCalled();
    expect(digest.sizeBytes).toBe(SIZE);
    expect((await readFile(target)).equals(await readFile(source))).toBe(true);
    // Where the source demonstrably holds holes, the stream leaves the long zero
    // range unwritten; elsewhere only bytes and independence are claimed.
    const [from, to] = [await allocated(source), await allocated(target)];
    if (from !== null && from < SIZE / 2) expect(to).toBeLessThan(SIZE / 2);
    // An independent file: editing it never reaches the source.
    const before = await readFile(source);
    await writeFile(target, "edited");
    expect((await readFile(source)).equals(before)).toBe(true);
  });

  it("offers only an engine-owned immutable source to the clone route", async () => {
    const clone = vi
      .spyOn(fileCopyHost, "clone")
      .mockImplementation(async (from, to) => (await copyFile(from, to), true));
    const { source, target } = await sparseSource();
    await writeIndependentCopy(source, target, { immutableSource: true, mode: 0o640 });
    expect(clone).toHaveBeenCalledWith(source, target);
    if (posix) expect((await lstat(target)).mode & 0o777).toBe(0o640);
    expect((await readFile(target)).equals(await readFile(source))).toBe(true);
  });

  it.skipIf(process.platform !== "darwin")(
    "on macOS an immutable source takes the checked sparse stream (no clone primitive)",
    async () => {
      const { root, source, target } = await sparseSource();
      const space = vi.spyOn(fileCopyHost, "availableBytes");
      const digest = await writeIndependentCopy(source, target, { immutableSource: true });
      expect(digest.sizeBytes).toBe(SIZE);
      expect(space).toHaveBeenCalled();
      expect((await readdir(root)).sort()).toEqual(["source", "target"]);
    },
  );
});
