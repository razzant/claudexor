import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every leaf operation removeTree makes goes through this mock: it counts what
 * is in flight, yields once so a concurrent operation could start meanwhile,
 * and lets a test inject a race or a failure. `node:fs` stays real, so the
 * test observes the tree with synchronous reads that removeTree never makes.
 */
const leaf = vi.hoisted(() => ({
  inFlight: 0,
  maxInFlight: 0,
  removed: [] as string[],
  /** Entries a directory `rm` found inside it: always 0 when each entry goes alone. */
  nonEmptyDirectoryRemovals: [] as string[],
  afterReaddir: null as null | ((dir: string, names: string[]) => void),
  failRm: null as null | ((path: string) => NodeJS.ErrnoException | null),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const fs = await import("node:fs");
  const observed = async <T>(body: () => Promise<T>): Promise<T> => {
    leaf.inFlight += 1;
    leaf.maxInFlight = Math.max(leaf.maxInFlight, leaf.inFlight);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return await body();
    } finally {
      leaf.inFlight -= 1;
    }
  };
  const rm: typeof actual.rm = (path, options) =>
    observed(async () => {
      const target = String(path);
      const failure = leaf.failRm?.(target);
      if (failure) throw failure;
      const stat = fs.lstatSync(target, { throwIfNoEntry: false });
      if (stat?.isDirectory() && fs.readdirSync(target).length > 0)
        leaf.nonEmptyDirectoryRemovals.push(target);
      await actual.rm(path, options);
      leaf.removed.push(target);
    });
  const readdir = ((path: string, options: never) =>
    observed(async () => {
      const entries = await actual.readdir(path, options);
      leaf.afterReaddir?.(
        String(path),
        (entries as unknown as { name: string }[]).map((entry) => entry.name),
      );
      return entries;
    })) as unknown as typeof actual.readdir;
  const lstat = ((path: string) => observed(() => actual.lstat(path))) as typeof actual.lstat;
  return { ...actual, default: { ...actual, rm, readdir, lstat }, rm, readdir, lstat };
});

const { removeTree } = await import("./remove-tree.js");

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) {
    chmodRecursive(root);
    rmSync(root, { recursive: true, force: true });
  }
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function chmodRecursive(path: string): void {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return;
  chmodSync(path, 0o700);
  if (lstatSync(path).isDirectory())
    for (const name of readdirSync(path)) chmodRecursive(join(path, name));
}

/** An envelope-shaped tree: nested subdirectories plus the root's own marker files. */
function envelope(): string {
  const base = mkdtempSync(join(tmpdir(), "claudexor-remove-tree-"));
  roots.push(base);
  for (const dir of ["home/.codex/sessions", "home/.claude", "tree/src/deep", "tree/.git/objects"])
    mkdirSync(join(base, dir), { recursive: true });
  for (const file of [
    "home/.codex/sessions/rollout.jsonl",
    "home/.claude/settings.json",
    "tree/src/deep/a.ts",
    "tree/src/b.ts",
    "tree/.git/objects/pack",
    "tree/README.md",
  ])
    writeFileSync(join(base, file), file);
  for (const marker of [
    "owner.json",
    "private-clone-v1",
    "bridge-created.json",
    "continuation-custody.json",
    "artifact-created.json",
  ])
    writeFileSync(join(base, marker), "{}\n");
  return base;
}

beforeEach(() => {
  leaf.inFlight = 0;
  leaf.maxInFlight = 0;
  leaf.removed = [];
  leaf.nonEmptyDirectoryRemovals = [];
  leaf.afterReaddir = null;
  leaf.failRm = null;
});

describe("removeTree (#688)", () => {
  it("removes one entry at a time: one operation in flight, and no directory removal fans out", async () => {
    const base = envelope();
    await removeTree(base);
    expect(existsSync(base)).toBe(false);
    // Direction 1: never two leaf operations at once, although each yields.
    expect(leaf.maxInFlight).toBe(1);
    // Direction 2: every directory was empty when its own rm ran, so Node's
    // recursive removal (which starts every child at once) never ran on one.
    expect(leaf.nonEmptyDirectoryRemovals).toEqual([]);
    // Every entry got its own rm (9 directories, 11 files), the root last.
    expect(leaf.removed).toHaveLength(21);
    expect(leaf.removed.at(-1)).toBe(base);
  });

  it("removes the root's own entries after every subtree, the named last entry last", async () => {
    const base = envelope();
    await removeTree(base, { lastEntry: "owner.json" });
    const order = leaf.removed.map((path) => relative(base, path));
    const rootOwn = [
      "owner.json",
      "private-clone-v1",
      "bridge-created.json",
      "continuation-custody.json",
      "artifact-created.json",
    ];
    const firstRootOwn = Math.min(...rootOwn.map((name) => order.indexOf(name)));
    // Every entry under a subdirectory, and the subdirectories, went first.
    const subtree = order.filter((path) => path.includes(sep) || ["home", "tree"].includes(path));
    expect(subtree).toHaveLength(15);
    for (const path of subtree) expect(order.indexOf(path)).toBeLessThan(firstRootOwn);
    // Then the root's own entries, `owner.json` the last of them, then the root.
    expect(new Set(order.slice(-6, -1))).toEqual(new Set(rootOwn));
    expect(order.at(-2)).toBe("owner.json");
    expect(order.at(-1)).toBe("");
    // Without a named entry the root's own entries still follow every subtree.
    const again = envelope();
    leaf.removed = [];
    await removeTree(again);
    const plain = leaf.removed.map((path) => relative(again, path));
    expect(new Set(plain.slice(-6, -1))).toEqual(new Set(rootOwn));
    expect(plain.at(-1)).toBe("");
  });

  it.runIf(process.platform !== "win32")(
    "removes read-only files, and removes a root link without following it",
    async () => {
      const base = envelope();
      chmodSync(join(base, "tree", "src", "b.ts"), 0o444);
      chmodSync(join(base, "owner.json"), 0o400);
      const outside = mkdtempSync(join(tmpdir(), "claudexor-remove-tree-outside-"));
      roots.push(outside);
      writeFileSync(join(outside, "kept.txt"), "kept");
      const link = `${base}-link`;
      symlinkSync(outside, link, "dir");
      roots.push(link);
      await removeTree(base);
      expect(existsSync(base)).toBe(false);
      await removeTree(link);
      expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
      // The link's target and its contents were never touched.
      expect(readdirSync(outside)).toEqual(["kept.txt"]);
    },
  );

  it("treats entries that vanish meanwhile as removed, and still fails on any other error", async () => {
    // A file and a whole subdirectory disappear between their listing and their removal.
    const base = envelope();
    leaf.afterReaddir = (dir, names) => {
      if (dir !== base) return;
      leaf.afterReaddir = null;
      expect(names).toContain("tree");
      rmSync(join(base, "tree"), { recursive: true, force: true });
      rmSync(join(base, "bridge-created.json"), { force: true });
    };
    await removeTree(base, { lastEntry: "owner.json" });
    expect(existsSync(base)).toBe(false);
    // An absent root is already removed.
    await expect(removeTree(base)).resolves.toBeUndefined();

    // A failure that is not absence stops the walk and rejects; the root's own
    // entries, removed last, are still there for the recovery that reads them.
    const failing = envelope();
    leaf.failRm = (path) =>
      path.endsWith(join("tree", "src", "b.ts"))
        ? Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
        : null;
    await expect(removeTree(failing, { lastEntry: "owner.json" })).rejects.toMatchObject({
      code: "EACCES",
    });
    expect(existsSync(join(failing, "owner.json"))).toBe(true);
    expect(existsSync(join(failing, "continuation-custody.json"))).toBe(true);
  });
});
