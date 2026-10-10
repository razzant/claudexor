import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureDirectory,
  linkExternalFile,
  unlinkExternalFile,
  writeExternalFile,
  type ExternalRegistry,
} from "./external-files.js";

/** The store runs only where `node:sqlite` exists; elsewhere these cases are skipped, not failed. */
const sqliteAvailable = await import("node:sqlite").then(
  () => true,
  () => false,
);
const describeStore = sqliteAvailable ? describe : describe.skip;

const openSpy = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const openSync = (...args: Parameters<typeof actual.openSync>) => {
    openSpy(...args);
    return actual.openSync(...args);
  };
  return { ...actual, openSync, default: { ...actual, openSync } };
});

let root: string;
let registered: string[];
const registry: ExternalRegistry = {
  registerExternal: (dir) => {
    registered.push(dir);
    return registered.length;
  },
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-external-"));
  registered = [];
  openSpy.mockClear();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describeStore("external files (SYNTHESIS_R5 §4.4)", () => {
  it("writes through an O_DSYNC temp, renames, registers the directory, leaves no temp", async () => {
    const { constants } = await import("node:fs");
    const dir = join(root, "final");
    const receipt = writeExternalFile(registry, {
      dir,
      name: "run_facts.yaml",
      bytes: Buffer.from("facts"),
    });
    expect(receipt).toEqual({ path: join(dir, "run_facts.yaml"), generation: 2, written: true });
    expect(readFileSync(receipt.path, "utf8")).toBe("facts");
    expect(readdirSync(dir)).toEqual(["run_facts.yaml"]);
    // The directory was created, so its parent was registered first; then the directory itself.
    expect(registered).toEqual([root, dir]);
    const tempOpen = openSpy.mock.calls.find(([path]) => String(path).endsWith(".tmp"));
    expect(tempOpen, "temp file opened").toBeDefined();
    const flags = Number(tempOpen![1]);
    expect(flags & constants.O_DSYNC).toBe(constants.O_DSYNC);
    expect(flags & constants.O_EXCL).toBe(constants.O_EXCL);
    expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
  });

  it("replaces by default and keeps an existing content-addressed file", () => {
    const dir = join(root, "blobs");
    const first = writeExternalFile(registry, { dir, name: "abc", bytes: Buffer.from("one") });
    const before = statSync(first.path);
    const replaced = writeExternalFile(registry, { dir, name: "abc", bytes: Buffer.from("two") });
    expect(replaced.written).toBe(true);
    expect(readFileSync(replaced.path, "utf8")).toBe("two");
    const kept = writeExternalFile(registry, {
      dir,
      name: "abc",
      bytes: Buffer.from("three"),
      keepExisting: true,
    });
    expect(kept.written).toBe(false);
    expect(readFileSync(kept.path, "utf8")).toBe("two");
    expect(statSync(kept.path).ino).toBe(statSync(replaced.path).ino);
    expect(before.ino).not.toBe(statSync(kept.path).ino);
    expect(readdirSync(dir)).toEqual(["abc"]);
  });

  it("links a source into place once and reports an existing target", () => {
    const parts = join(root, "uploads");
    const blobs = join(root, "blobs");
    const part = writeExternalFile(registry, {
      dir: parts,
      name: "u1.part",
      bytes: Buffer.from("bytes"),
    });
    const linked = linkExternalFile(registry, { source: part.path, dir: blobs, name: "sha" });
    expect(linked.written).toBe(true);
    expect(statSync(linked.path).nlink).toBe(2);
    const again = linkExternalFile(registry, { source: part.path, dir: blobs, name: "sha" });
    expect(again.written).toBe(false);
    expect(registered.at(-1)).toBe(blobs);
    const g = unlinkExternalFile(registry, part.path);
    expect(existsSync(part.path)).toBe(false);
    expect(registered[g - 1]).toBe(parts);
    expect(unlinkExternalFile(registry, part.path)).toBe(g + 1);
  });

  it("ensureDirectory registers only when it created something", () => {
    const dir = join(root, "a", "b");
    ensureDirectory(registry, dir);
    expect(registered).toEqual([join(root, "a")]);
    ensureDirectory(registry, dir);
    expect(registered).toEqual([join(root, "a")]);
  });
});
