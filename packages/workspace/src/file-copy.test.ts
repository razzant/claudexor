import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, constants, type Stats } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimImmutableFile,
  fileCopyHost,
  FileSpaceError,
  shareImmutableFile,
  writeIndependentCopy,
  allocatedBytes,
} from "./file-copy.js";
import { captureFailureEvidence } from "./capture-failure.js";

const MiB = 1024 * 1024;
const posix = process.platform !== "win32";
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function temp() {
  const root = await mkdtemp(join(tmpdir(), "claudexor-file-copy-"));
  roots.push(root);
  return root;
}
const digestOf = (bytes: Buffer) => ({
  sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  sizeBytes: bytes.length,
});

/** A small file written sparsely: only `data` ranges are written, the rest is holes
 * wherever the filesystem keeps them at this size. */
async function sparse(path: string, size: number, data: Array<[number, string]> = []) {
  const handle = await open(path, "wx", 0o640);
  try {
    await handle.truncate(size);
    for (const [at, letter] of data) await handle.write(Buffer.alloc(4096, letter), 0, 4096, at);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return path;
}

const fixtures: Array<[string, (path: string) => Promise<unknown>]> = [
  ["an ordinary small file", (path) => writeFile(path, "ordinary bytes\r\n")],
  [
    "data at both ends around a hole",
    (path) =>
      sparse(path, MiB, [
        [0, "A"],
        [MiB - 4096, "B"],
      ]),
  ],
  ["data before a trailing hole", (path) => sparse(path, MiB, [[0, "A"]])],
  ["unaligned data across a chunk boundary", (path) => sparse(path, MiB + 777, [[MiB - 100, "C"]])],
  ["only zeros", (path) => sparse(path, MiB)],
  ["nothing", (path) => writeFile(path, "")],
];

const blocks = async (path: string) => (await lstat(path)).blocks ?? 0;

describe.each([
  ["this host's copy", false],
  ["the stream (no clone here)", true],
])("independent file copy: %s", (_name, noClone) => {
  const withhold = () => {
    if (noClone) vi.spyOn(fileCopyHost, "clone").mockResolvedValue(false);
  };

  it.each(fixtures)("%s keeps exact bytes, length, mode and independence", async (_f, make) => {
    withhold();
    const root = await temp();
    const source = join(root, "source");
    const target = join(root, "target");
    await make(source);
    const bytes = await readFile(source);

    const digest = await writeIndependentCopy(source, target, {
      expected: digestOf(bytes),
      mode: 0o600,
    });

    expect(digest).toEqual(digestOf(bytes));
    expect((await readFile(target)).equals(bytes)).toBe(true);
    const [from, to] = [await lstat(source), await lstat(target)];
    expect(to.size).toBe(bytes.length);
    if (posix) {
      expect(to.ino).not.toBe(from.ino);
      expect(to.nlink).toBe(1);
      expect(to.mode & 0o777).toBe(0o600);
      // A clone keeps the layout; the stream leaves zero blocks unwritten. APFS
      // allocates small gaps of a written file itself, so only the clone and
      // other filesystems promise no growth over a sparse source.
      const allocatesGaps = noClone && process.platform === "darwin";
      if (!allocatesGaps || bytes.every((byte) => byte === 0))
        expect(await blocks(target)).toBeLessThanOrEqual(await blocks(source));
    }
    // Editing the copy never reaches the source.
    await writeFile(target, "edited");
    expect((await readFile(source)).equals(bytes)).toBe(true);
    expect((await readdir(root)).sort()).toEqual(["source", "target"]);
  });

  it("applies a read-only mode to the finished copy", async () => {
    withhold();
    const root = await temp();
    const source = await sparse(join(root, "source"), MiB, [[0, "A"]]);
    await writeIndependentCopy(source, join(root, "target"), { mode: 0o400 });
    if (posix) expect((await lstat(join(root, "target"))).mode & 0o777).toBe(0o400);
    expect((await readFile(join(root, "target"))).equals(await readFile(source))).toBe(true);
  });

  it("never touches an existing target", async () => {
    withhold();
    const root = await temp();
    const source = await sparse(join(root, "source"), MiB, [[0, "A"]]);
    const target = join(root, "target");
    await writeFile(target, "already here");
    await expect(writeIndependentCopy(source, target)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(target, "utf8")).toBe("already here");
    expect((await readdir(root)).sort()).toEqual(["source", "target"]);
  });

  it("leaves nothing behind when the bytes are not the expected ones", async () => {
    withhold();
    const root = await temp();
    const source = await sparse(join(root, "source"), MiB, [[0, "A"]]);
    await expect(
      writeIndependentCopy(source, join(root, "target"), {
        expected: digestOf(Buffer.from("other")),
      }),
    ).rejects.toThrow("does not match its recorded hash and size");
    expect(await readdir(root)).toEqual(["source"]);
  });
});

describe("a copy that writes bytes", () => {
  const stream = () => vi.spyOn(fileCopyHost, "clone").mockResolvedValue(false);

  async function oneMiB() {
    const root = await temp();
    const source = await sparse(join(root, "source"), MiB, [
      [0, "A"],
      [MiB - 4096, "B"],
    ]);
    return { root, source, target: join(root, "target") };
  }

  async function handlePrototype(path: string): Promise<FileHandle> {
    const handle = await open(path, "r");
    await handle.close();
    return Object.getPrototypeOf(handle) as FileHandle;
  }

  // APFS allocates a file this small even when written sparsely, so a test of
  // the sparse path states that its source is one.
  const sparseSource = () => vi.spyOn(fileCopyHost, "isSparse").mockReturnValue(true);

  it("writes only the blocks of a sparse source that hold data", async () => {
    stream();
    sparseSource();
    const { source, target } = await oneMiB();
    const prototype = await handlePrototype(source);
    const write = vi.spyOn(prototype, "write");
    await writeIndependentCopy(source, target);
    const written = write.mock.calls.map((call) => ({
      length: (call as unknown[])[2],
      position: (call as unknown[])[3],
    }));
    expect(written).toEqual([
      { length: 4096, position: 0 },
      { length: 4096, position: MiB - 4096 },
    ]);
  });

  it("checks, sets the mode of and flushes the copy on the handle that wrote it", async () => {
    stream();
    const { source, target } = await oneMiB();
    const prototype = await handlePrototype(source);
    const seen = { write: new Set<unknown>(), chmod: new Set<unknown>(), sync: new Set<unknown>() };
    for (const name of ["write", "chmod", "sync"] as const) {
      const real = prototype[name] as (...args: unknown[]) => unknown;
      vi.spyOn(prototype, name).mockImplementation(function (this: unknown, ...args: unknown[]) {
        seen[name].add(this);
        return real.apply(this, args);
      } as never);
    }
    await writeIndependentCopy(source, target, { mode: 0o640 });
    expect(seen.write.size).toBe(1);
    expect(seen.chmod).toEqual(seen.write);
    expect(seen.sync).toEqual(seen.write);
    expect((await readFile(target)).equals(await readFile(source))).toBe(true);
  });

  it("reads a block count as allocation only where it is evidence (modeled platforms)", () => {
    const on = <T>(platform: NodeJS.Platform, read: () => T): T => {
      const real = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { ...real, value: platform });
      try {
        return read();
      } finally {
        Object.defineProperty(process, "platform", real);
      }
    };
    const stats = (size: number, blocks?: number) => ({ size, blocks }) as unknown as Stats;
    // POSIX st_blocks is the allocation: a hole-only file really holds nothing.
    expect(on("linux", () => allocatedBytes(stats(MiB, 0)))).toBe(0);
    expect(on("darwin", () => fileCopyHost.isSparse(stats(MiB, 0)))).toBe(true);
    // libuv on Windows: AllocationSize >> 9, zero also for MFT-resident data.
    expect(on("win32", () => allocatedBytes(stats(MiB, 0)))).toBeNull();
    expect(on("win32", () => fileCopyHost.isSparse(stats(MiB, 0)))).toBe(false);
    expect(on("win32", () => allocatedBytes(stats(MiB, 8)))).toBe(4096);
    expect(on("win32", () => allocatedBytes(stats(0, 0)))).toBe(0);
    expect(allocatedBytes(stats(MiB))).toBeNull();
  });

  it("treats a block count the platform does not report as no evidence of holes", () => {
    const info = { size: MiB, blocks: undefined } as unknown as Stats;
    expect(fileCopyHost.isSparse(info)).toBe(false);
    expect(fileCopyHost.isSparse({ size: MiB, blocks: 8 } as unknown as Stats)).toBe(true);
  });

  it.skipIf(!posix)("does not thin a file whose zeros are allocated", async () => {
    stream();
    const root = await temp();
    const source = join(root, "source");
    await writeFile(source, Buffer.alloc(MiB));
    const allocated = await blocks(source);
    // A compressing filesystem may report an allocated zero file as sparse.
    if (allocated * 512 < MiB) return;
    await writeIndependentCopy(source, join(root, "target"));
    expect(await blocks(join(root, "target"))).toBeGreaterThanOrEqual(allocated);
  });

  it("refuses a copy that does not reach the source's length", async () => {
    stream();
    sparseSource();
    const root = await temp();
    const source = await sparse(join(root, "source"), MiB, [[0, "A"]]);
    const prototype = await handlePrototype(source);
    // Without the final length the trailing hole is simply missing.
    vi.spyOn(prototype, "truncate").mockResolvedValue(undefined);
    await expect(writeIndependentCopy(source, join(root, "target"))).rejects.toThrow(
      "does not hold the source's exact length",
    );
    expect(await readdir(root)).toEqual(["source"]);
  });

  it("names a destination file-size limit apart from space", async () => {
    stream();
    const { root, source, target } = await oneMiB();
    const prototype = await handlePrototype(source);
    vi.spyOn(prototype, "write").mockRejectedValue(
      Object.assign(new Error("EFBIG: file too large, write"), { code: "EFBIG" }),
    );
    const error = await writeIndependentCopy(source, target).catch((caught: unknown) => caught);
    expect(captureFailureEvidence(error as Error)).toMatchObject({
      code: "capture_failed",
      causeCode: "EFBIG",
    });
    expect(await readdir(root)).toEqual(["source"]);
  });

  it("continues a short write at its position", async () => {
    stream();
    const { source, target } = await oneMiB();
    const prototype = await handlePrototype(source);
    type Write = (
      this: FileHandle,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => Promise<unknown>;
    const real = prototype.write as unknown as Write;
    vi.spyOn(prototype, "write").mockImplementation(function (
      this: FileHandle,
      ...args: unknown[]
    ) {
      const [buffer, offset, length, position] = args as [Buffer, number, number, number];
      return real.call(this, buffer, offset, Math.min(length, 1000), position) as never;
    });
    await writeIndependentCopy(source, target);
    expect((await readFile(target)).equals(await readFile(source))).toBe(true);
  });

  it("refuses before writing when destination space is too little", async () => {
    stream();
    vi.spyOn(fileCopyHost, "availableBytes").mockReturnValue(4096);
    const { root, source, target } = await oneMiB();
    const error = await writeIndependentCopy(source, target).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FileSpaceError);
    // The bound is the whole length: allocated blocks of the source promise nothing.
    expect(captureFailureEvidence(error as Error)).toMatchObject({
      code: "capture_space_insufficient",
      requiredBytes: MiB + 64 * MiB,
      availableBytes: 4096,
    });
    expect(await readdir(root)).toEqual(["source"]);
  });

  it("lets a copy smaller than the margin proceed when free space cannot be read", async () => {
    stream();
    vi.spyOn(fileCopyHost, "availableBytes").mockReturnValue(null);
    const { source, target } = await oneMiB();
    await expect(writeIndependentCopy(source, target)).resolves.toMatchObject({ sizeBytes: MiB });
    expect((await lstat(target)).size).toBe(MiB);
  });

  it("refuses a copy larger than the margin when free space cannot be read", async () => {
    stream();
    vi.spyOn(fileCopyHost, "availableBytes").mockReturnValue(null);
    const root = await temp();
    const source = await sparse(join(root, "source"), 65 * MiB, [[0, "A"]]);
    const error = await writeIndependentCopy(source, join(root, "target")).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(FileSpaceError);
    expect((error as FileSpaceError).availableBytes).toBeUndefined();
    expect((error as Error).message).toContain("unknown");
    expect(await readdir(root)).toEqual(["source"]);
  });

  it("refuses a source that grows after its room was checked, writing no more than checked", async () => {
    stream();
    const { root, source, target } = await oneMiB();
    // The check passes for the length seen at the start; the file grows right after it.
    vi.spyOn(fileCopyHost, "availableBytes").mockImplementation(() => {
      appendFileSync(source, Buffer.alloc(2 * MiB, "G"));
      return 1024 * MiB;
    });
    const written = vi.spyOn(await handlePrototype(source), "write");
    const error = await writeIndependentCopy(source, target).catch((caught: unknown) => caught);
    expect((error as Error).message).toContain("File changed while being captured");
    const bytes = written.mock.calls.reduce(
      (sum, call) => sum + ((call as unknown[])[2] as number),
      0,
    );
    expect(bytes).toBeLessThanOrEqual(MiB);
    expect(await readdir(root)).toEqual(["source"]);
  });

  it("refuses a clone of a source that grew after it was seen", async () => {
    const { root, source, target } = await oneMiB();
    vi.spyOn(fileCopyHost, "clone").mockImplementation(async (from, to) => {
      appendFileSync(from, Buffer.alloc(MiB, "G"));
      await copyFile(from, to, constants.COPYFILE_EXCL);
      return true;
    });
    const error = await writeIndependentCopy(source, target, { immutableSource: true }).catch(
      (caught: unknown) => caught,
    );
    expect((error as Error).message).toContain("File changed while being captured");
    expect(await readdir(root)).toEqual(["source"]);
  });

  it.skipIf(process.platform !== "darwin")(
    "a macOS copy carries none of its source's extended attributes",
    async () => {
      const root = await temp();
      const source = await sparse(join(root, "source"), 32 * MiB, [[0, "A"]]);
      const target = join(root, "target");
      const run = (args: string[]) => execFileSync("/usr/bin/xattr", args, { encoding: "utf8" });
      run(["-w", "com.example.label", "red", source]);
      let fork = true;
      try {
        run(["-w", "com.apple.ResourceFork", "fork", source]);
      } catch {
        fork = false;
      }
      const digest = await writeIndependentCopy(source, target);
      expect(digest.sizeBytes).toBe(32 * MiB);
      const names = run([target])
        .split("\n")
        .map((line) => line.trim())
        .filter((name) => name && name !== "com.apple.provenance");
      expect(names).toEqual([]);
      expect(run([source])).toContain("com.example.label");
      if (fork) expect(run([source])).toContain("com.apple.ResourceFork");
      expect((await readFile(target)).equals(await readFile(source))).toBe(true);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "never writes an unchecked byte copy on macOS when room is short",
    async () => {
      const space = vi.spyOn(fileCopyHost, "availableBytes").mockReturnValue(0);
      const { root, source, target } = await oneMiB();
      const error = await writeIndependentCopy(source, target).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(FileSpaceError);
      expect((error as Error).message).toContain("full length");
      expect(space).toHaveBeenCalled();
      expect(await readdir(root)).toEqual(["source"]);
    },
  );

  it("needs no room for a clone", async () => {
    vi.spyOn(fileCopyHost, "clone").mockImplementation(async (from, to) => {
      await copyFile(from, to);
      return true;
    });
    const space = vi.spyOn(fileCopyHost, "availableBytes").mockReturnValue(0);
    const { source, target } = await oneMiB();
    await writeIndependentCopy(source, target, { immutableSource: true });
    expect(space).not.toHaveBeenCalled();
  });

  it.each(["ENOSPC", "EDQUOT"])("types a mid-write %s and removes its own file", async (code) => {
    stream();
    const { root, source, target } = await oneMiB();
    const prototype = await handlePrototype(source);
    vi.spyOn(prototype, "write").mockRejectedValue(
      Object.assign(new Error(`${code}: full`), { code }),
    );
    const error = await writeIndependentCopy(source, target).catch((caught: unknown) => caught);
    expect(captureFailureEvidence(error as Error)).toMatchObject({
      code: "capture_space_insufficient",
    });
    expect(await readdir(root)).toEqual(["source"]);
  });
});

describe("immutable file names", () => {
  async function blob() {
    const root = await temp();
    const source = await sparse(join(root, "blob"), MiB, [[0, "A"]]);
    return { root, source, digest: digestOf(await readFile(source)) };
  }

  it("shares one inode, once, without changing its mode", async () => {
    const { root, source, digest } = await blob();
    await chmod(source, 0o600);
    const target = join(root, "final/blob");
    expect(await shareImmutableFile(source, target, digest)).toBe(true);
    expect(await shareImmutableFile(source, target, digest)).toBe(false);
    const [from, to] = [await lstat(source), await lstat(target)];
    expect(to.ino).toBe(from.ino);
    if (posix) {
      expect(to.nlink).toBe(2);
      expect(to.mode & 0o777).toBe(0o600);
    }
    // Removing the first name leaves the published bytes.
    await rm(source);
    expect(digestOf(await readFile(target))).toEqual(digest);
  });

  it("refuses other bytes at either name and leaves them alone", async () => {
    const { root, source, digest } = await blob();
    const target = join(root, "occupied");
    await writeFile(target, "unrelated");
    await expect(shareImmutableFile(source, target, digest)).rejects.toThrow(
      "do not match their immutable file reference",
    );
    expect(await readFile(target, "utf8")).toBe("unrelated");
    await truncate(source, 10);
    await expect(shareImmutableFile(source, join(root, "new"), digest)).rejects.toThrow(
      "do not match their immutable file reference",
    );
    await expect(
      shareImmutableFile(join(root, "absent"), join(root, "new"), digest),
    ).rejects.toThrow("Immutable file is missing");
    expect((await readdir(root)).sort()).toEqual(["blob", "occupied"]);
  });

  it.skipIf(!posix)("takes only regular files, never what a link points at", async () => {
    const { root, source, digest } = await blob();
    await symlink(source, join(root, "alias"));
    await expect(
      shareImmutableFile(join(root, "alias"), join(root, "new"), digest),
    ).rejects.toThrow("do not match their immutable file reference");
    await expect(shareImmutableFile(source, join(root, "alias"), digest)).rejects.toThrow(
      "do not match their immutable file reference",
    );
    expect((await readdir(root)).sort()).toEqual(["alias", "blob"]);
  });

  it.each(["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP", "EMLINK", "ENOSYS"])(
    "falls back to an independent copy when linking answers %s",
    async (code) => {
      vi.spyOn(fileCopyHost, "link").mockRejectedValue(
        Object.assign(new Error(`${code}: no link`), { code }),
      );
      const { root, source, digest } = await blob();
      expect(await shareImmutableFile(source, join(root, "copy"), digest)).toBe(true);
      expect((await lstat(join(root, "copy"))).ino).not.toBe((await lstat(source)).ino);
      expect((await readdir(root)).sort()).toEqual(["blob", "copy"]);
    },
  );

  it("never leaves a fragment under the immutable name", async () => {
    vi.spyOn(fileCopyHost, "clone").mockResolvedValue(false);
    vi.spyOn(fileCopyHost, "link").mockRejectedValue(
      Object.assign(new Error("ENOTSUP: no hard links"), { code: "ENOTSUP" }),
    );
    const { root, source, digest } = await blob();
    const target = join(root, "copy");
    const handle = await open(source, "r");
    const prototype = Object.getPrototypeOf(handle) as FileHandle;
    await handle.close();
    const failing = vi.spyOn(prototype, "write").mockImplementation(async () => {
      // While the copy is being written the immutable name does not exist.
      expect(await readdir(root)).not.toContain("copy");
      throw Object.assign(new Error("ENOSPC: full"), { code: "ENOSPC" });
    });
    await expect(shareImmutableFile(source, target, digest)).rejects.toMatchObject({
      code: "capture_space_insufficient",
    });
    expect(await readdir(root)).toEqual(["blob"]);
    failing.mockRestore();
    // A later publication starts clean.
    expect(await shareImmutableFile(source, target, digest)).toBe(true);
    expect(digestOf(await readFile(target))).toEqual(digest);
  });

  it("copies independently where the filesystem has no hard links", async () => {
    vi.spyOn(fileCopyHost, "clone").mockResolvedValue(false);
    vi.spyOn(fileCopyHost, "link").mockRejectedValue(
      Object.assign(new Error("ENOTSUP: no hard links"), { code: "ENOTSUP" }),
    );
    const { root, source, digest } = await blob();
    const target = join(root, "copy");
    expect(await shareImmutableFile(source, target, digest)).toBe(true);
    expect((await lstat(target)).ino).not.toBe((await lstat(source)).ino);
    expect(digestOf(await readFile(target))).toEqual(digest);

    const staged = await sparse(join(root, "staged"), MiB, [[0, "A"]]);
    await claimImmutableFile(staged, join(root, "claimed"), digest);
    expect(digestOf(await readFile(join(root, "claimed")))).toEqual(digest);
    expect((await readdir(root)).sort()).toEqual(["blob", "claimed", "copy"]);
  });
});
