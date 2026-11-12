import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every synchronous call the synchronous writer makes is observed; the awaited
// twin must make none of them (#688).
const SYNC = vi.hoisted(
  () =>
    [
      "closeSync",
      "copyFileSync",
      "existsSync",
      "fsyncSync",
      "linkSync",
      "lstatSync",
      "mkdirSync",
      "openSync",
      "readFileSync",
      "renameSync",
      "unlinkSync",
      "writeFileSync",
    ] as const,
);
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  const wrapped = Object.fromEntries(SYNC.map((name) => [name, vi.fn(actual[name] as never)]));
  return { ...actual, ...wrapped, default: { ...actual, ...wrapped } };
});
/** Paths the awaited writer touched, and one object rename a test may hold. */
const io = vi.hoisted(() => ({
  touched: [] as string[],
  holdObjectRename: null as null | { object: string; reached: () => void; release: Promise<void> },
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fsp>();
  const link = vi.fn(actual.link);
  const lstat = ((path: string, ...rest: unknown[]) => {
    io.touched.push(String(path));
    return (actual.lstat as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.lstat;
  const rename = (async (from: string, to: string) => {
    io.touched.push(String(to));
    const hold = io.holdObjectRename;
    if (hold && String(to) === hold.object) {
      io.holdObjectRename = null;
      hold.reached();
      await hold.release;
    }
    return actual.rename(from, to);
  }) as typeof actual.rename;
  const patched = { link, lstat, rename };
  return { ...actual, ...patched, default: { ...actual, ...patched } };
});
const { writePatchObject, writePatchObjectAsync } = await import("./patch-objects.js");
const { sha256 } = await import("./index.js");

const roots: string[] = [];
const root = () => {
  const path = fs.mkdtempSync(join(tmpdir(), "patch-objects-async-"));
  roots.push(path);
  return path;
};
const clearSync = () => {
  for (const name of SYNC) vi.mocked(fs[name] as (...args: never[]) => unknown).mockClear();
};
const syncCalls = () =>
  SYNC.filter((name) => vi.mocked(fs[name] as (...args: never[]) => unknown).mock.calls.length);
afterEach(() => {
  vi.mocked(fsp.link).mockReset();
  for (const path of roots.splice(0)) fs.rmSync(path, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

describe("awaited run-patch publication (#688)", () => {
  it("makes no synchronous call and shares the synchronous writer's object for identical bytes", async () => {
    const dir = root();
    const patch = "diff --git a/a b/a\n+" + "ordinary bytes\r\n".repeat(10_000);
    const attempt = join(dir, "runs", "r", "attempts", "a01", "patch.diff");
    const final = join(dir, "runs", "r", "final", "patch.diff");
    writePatchObject(dir, attempt, patch, { durable: false });
    clearSync();
    await writePatchObjectAsync(dir, final, patch);
    // Direction 1: the main thread never waited on the disk.
    expect(syncCalls()).toEqual([]);
    // Direction 2: the same immutable object, linked, with the exact bytes.
    expect(fs.statSync(final).ino).toBe(fs.statSync(attempt).ino);
    expect(fs.readFileSync(final, "utf8")).toBe(patch);
    clearSync();
    await writePatchObjectAsync(dir, final, "replacement\n");
    expect(syncCalls()).toEqual([]);
    expect(fs.readFileSync(attempt, "utf8")).toBe(patch);
    expect(fs.readFileSync(final, "utf8")).toBe("replacement\n");
    expect(fs.readdirSync(join(dir, "patches")).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("replaces a mismatching cache inode without changing any existing hardlink", async () => {
    const dir = root();
    const target = join(dir, "patch.diff");
    await writePatchObjectAsync(dir, target, "first");
    const original = join(dir, "first.patch");
    fs.linkSync(target, original);
    const corrupt = join(dir, "patches", `${sha256("next").slice(7)}.patch`);
    fs.writeFileSync(corrupt, "wrong");
    const evidence = join(dir, "bad-old-link.patch");
    fs.linkSync(corrupt, evidence);
    const badInode = fs.statSync(evidence).ino;
    await writePatchObjectAsync(dir, target, "next");
    expect(fs.readFileSync(target, "utf8")).toBe("next");
    expect(fs.readFileSync(corrupt, "utf8")).toBe("next");
    expect(fs.statSync(target).ino).toBe(fs.statSync(corrupt).ino);
    expect(fs.statSync(target).ino).not.toBe(badInode);
    expect(fs.readFileSync(evidence, "utf8")).toBe("wrong");
    expect(fs.readFileSync(original, "utf8")).toBe("first");
  });

  it("copies when links are unsupported, but surfaces other publication failures", async () => {
    const dir = root();
    const target = join(dir, "patch.diff");
    const link = vi.mocked(fsp.link).mockImplementation(async () => {
      throw Object.assign(new Error("unsupported"), { code: "EXDEV" });
    });
    await writePatchObjectAsync(dir, target, "same bytes\r\n");
    expect(fs.readFileSync(target, "utf8")).toBe("same bytes\r\n");
    // A filesystem without links keeps the published copy, not a cache copy.
    expect(fs.readdirSync(join(dir, "patches"))).toEqual([]);
    link.mockImplementation(async () => {
      throw Object.assign(new Error("full"), { code: "ENOSPC" });
    });
    await expect(writePatchObjectAsync(dir, target, "new bytes")).rejects.toThrow("full");
    expect(fs.readFileSync(target, "utf8")).toBe("same bytes\r\n");
    expect(fs.readdirSync(dir).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("publishes the same bytes one after the other, never interleaved", async () => {
    const dir = root();
    const patch = "same candidate bytes\n";
    const object = join(dir, "patches", `${sha256(patch).slice(7)}.patch`);
    let reached!: () => void;
    const atObjectRename = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    io.holdObjectRename = {
      object,
      reached,
      release: new Promise<void>((resolve) => (release = resolve)),
    };
    const first = writePatchObjectAsync(dir, join(dir, "a", "patch.diff"), patch);
    await atObjectRename;
    io.touched = [];
    const second = writePatchObjectAsync(dir, join(dir, "b", "patch.diff"), patch);
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    // Direction 1: while the first holds its object rename, the second has not
    // even read the cache entry the first is about to publish.
    expect(io.touched).toEqual([]);
    release();
    await Promise.all([first, second]);
    // Direction 2: both published, the second reusing the first's object.
    expect(fs.readFileSync(join(dir, "b", "patch.diff"), "utf8")).toBe(patch);
    expect(fs.statSync(join(dir, "a", "patch.diff")).ino).toBe(
      fs.statSync(join(dir, "b", "patch.diff")).ino,
    );
    // Different bytes are not held behind it.
    io.touched = [];
    await writePatchObjectAsync(dir, join(dir, "c", "patch.diff"), "other bytes\n");
    expect(io.touched.length).toBeGreaterThan(0);
  });

  it("refuses a linked cache namespace and touches nothing outside it", async () => {
    const dir = root();
    const outside = root();
    const path = join(outside, `${sha256("outside bytes").slice(7)}.patch`);
    fs.writeFileSync(path, "outside bytes");
    fs.symlinkSync(outside, join(dir, "patches"), "dir");
    await expect(
      writePatchObjectAsync(dir, join(dir, "run.patch"), "outside bytes"),
    ).rejects.toThrow("plain directory");
    expect(fs.readFileSync(path, "utf8")).toBe("outside bytes");
    expect(fs.existsSync(join(dir, "run.patch"))).toBe(false);
  });
});
