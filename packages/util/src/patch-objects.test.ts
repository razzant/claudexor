import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prunePatchObjects, writePatchObject } from "./patch-objects.js";
import { sha256 } from "./index.js";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, linkSync: vi.fn(actual.linkSync), fsyncSync: vi.fn(actual.fsyncSync) };
});

const roots: string[] = [];
const root = () => {
  const path = fs.mkdtempSync(join(tmpdir(), "patch-objects-"));
  roots.push(path);
  return path;
};
afterEach(() => {
  vi.mocked(fs.linkSync).mockReset();
  vi.mocked(fs.fsyncSync).mockReset();
  for (const path of roots.splice(0)) fs.rmSync(path, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

describe("immutable patch publication", () => {
  it("shares identical attempt/final/anchor bytes and replaces only the changed path", async () => {
    const dir = root();
    const patch = "diff --git a/a b/a\n+" + "ordinary bytes\r\n".repeat(100_000);
    const paths = [
      "runs/r/attempts/a01/patch.diff",
      "runs/r/final/patch.diff",
      "anchors/objects/a.patch",
    ].map((path) => join(dir, path));
    for (const path of paths) writePatchObject(dir, path, patch);
    expect(new Set(paths.map((path) => fs.statSync(path).ino)).size).toBe(1);
    for (const path of paths) expect(fs.readFileSync(path, "utf8")).toBe(patch);
    writePatchObject(dir, paths[1], "replacement\n");
    expect(fs.readFileSync(paths[0], "utf8")).toBe(patch);
    expect(fs.readFileSync(paths[2], "utf8")).toBe(patch);
    expect(fs.readFileSync(paths[1], "utf8")).toBe("replacement\n");
    fs.rmSync(join(dir, "runs"), { recursive: true });
    expect(await prunePatchObjects(dir, true)).toBe(Buffer.byteLength("replacement\n"));
    expect(await prunePatchObjects(dir, false)).toBe(Buffer.byteLength("replacement\n"));
    expect(fs.readFileSync(paths[2], "utf8")).toBe(patch);
    fs.unlinkSync(paths[2]);
    expect(await prunePatchObjects(dir, false)).toBe(Buffer.byteLength(patch));
    expect(fs.readdirSync(join(dir, "patches"))).toEqual([]);
  });

  it("separates different display/exact bytes and leaves old plain files readable", async () => {
    const dir = root();
    const legacy = join(dir, "legacy.patch");
    fs.writeFileSync(legacy, "legacy bytes\n");
    writePatchObject(dir, join(dir, "display.patch"), "+[redacted]\n");
    writePatchObject(dir, join(dir, "exact.patch"), "+original bytes\n");
    expect(fs.statSync(join(dir, "display.patch")).ino).not.toBe(
      fs.statSync(join(dir, "exact.patch")).ino,
    );
    expect(fs.readFileSync(legacy, "utf8")).toBe("legacy bytes\n");
    expect(await prunePatchObjects(dir, false)).toBe(0);
  });

  it("replaces a mismatching cache inode without changing any existing hardlink", () => {
    const dir = root();
    const target = join(dir, "patch.diff");
    writePatchObject(dir, target, "first");
    const original = join(dir, "first.patch");
    fs.linkSync(target, original);
    const corrupt = join(dir, "patches", `${sha256("next").slice(7)}.patch`);
    fs.writeFileSync(corrupt, "wrong");
    const evidence = join(dir, "bad-old-link.patch");
    fs.linkSync(corrupt, evidence);
    const badInode = fs.statSync(evidence).ino;
    writePatchObject(dir, target, "next");
    expect(fs.readFileSync(target, "utf8")).toBe("next");
    expect(fs.readFileSync(corrupt, "utf8")).toBe("next");
    expect(fs.statSync(target).ino).toBe(fs.statSync(corrupt).ino);
    expect(fs.statSync(target).ino).not.toBe(badInode);
    expect(fs.readFileSync(evidence, "utf8")).toBe("wrong");
    expect(fs.readFileSync(original, "utf8")).toBe("first");
    expect(fs.readdirSync(join(dir, "patches")).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("copies when links are unsupported, but surfaces other publication failures", () => {
    const dir = root();
    const target = join(dir, "patch.diff");
    const link = vi.mocked(fs.linkSync).mockImplementation(() => {
      throw Object.assign(new Error("unsupported"), { code: "EXDEV" });
    });
    writePatchObject(dir, target, "same bytes\r\n");
    expect(fs.readFileSync(target, "utf8")).toBe("same bytes\r\n");
    expect(fs.readdirSync(join(dir, "patches"))).toEqual([]);
    link.mockImplementation(() => {
      throw Object.assign(new Error("full"), { code: "ENOSPC" });
    });
    expect(() => writePatchObject(dir, target, "new bytes")).toThrow("full");
    expect(fs.readFileSync(target, "utf8")).toBe("same bytes\r\n");
  });

  it("keeps objects outside a linked cache namespace", async () => {
    const dir = root();
    const outside = root();
    const path = join(outside, `${sha256("outside bytes").slice(7)}.patch`);
    fs.writeFileSync(path, "outside bytes");
    fs.symlinkSync(outside, join(dir, "patches"), "dir");
    for (const dryRun of [true, false])
      await expect(prunePatchObjects(dir, dryRun)).rejects.toThrow("plain directory");
    expect(() => writePatchObject(dir, join(dir, "run.patch"), "outside bytes")).toThrow(
      "plain directory",
    );
    expect(fs.readFileSync(path, "utf8")).toBe("outside bytes");
    fs.unlinkSync(join(dir, "patches"));
    fs.mkdirSync(join(dir, "patches"));
    fs.renameSync(path, join(dir, "patches", `${sha256("outside bytes").slice(7)}.patch`));
    expect(await prunePatchObjects(dir, false)).toBe(Buffer.byteLength("outside bytes"));
  });

  it("promotes ordinary run bytes to durable anchor ownership before publication", () => {
    const dir = root();
    const run = join(dir, "runs", "r", "patch.diff");
    const anchor = join(dir, "anchors", "objects", "a.patch");
    writePatchObject(dir, run, "shared bytes", { durable: false });
    expect(fs.fsyncSync).not.toHaveBeenCalled();
    const ino = fs.statSync(run).ino;
    const flushed: { ino: number; file: boolean; anchorExists: boolean }[] = [];
    const original = vi.mocked(fs.fsyncSync).getMockImplementation()!;
    vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
      const stat = fs.fstatSync(fd);
      flushed.push({ ino: stat.ino, file: stat.isFile(), anchorExists: fs.existsSync(anchor) });
      original(fd);
    });
    writePatchObject(dir, anchor, "shared bytes");
    expect(fs.statSync(anchor).ino).toBe(ino);
    expect(flushed).toContainEqual({ ino, file: true, anchorExists: false });
    expect(flushed.some((entry) => !entry.file && entry.anchorExists)).toBe(true);
    expect(fs.readFileSync(anchor, "utf8")).toBe("shared bytes");
  });
});
