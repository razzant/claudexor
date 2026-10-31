import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReviewerCandidateInventory, prepareReviewerWorkspace } from "./reviewerWorkspace.js";

// A reviewer copy of a result's saved files (#535): the source holds exactly the
// files the result changed, and the listed paths name its deletions too. ESM
// namespaces cannot be spied, so node:fs and node:fs/promises are wrapped once.
let freeBytes: number | null = null;
let fullAt: string | null = null;
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    statfsSync: (...args: Parameters<typeof fs.statfsSync>) => {
      const real = fs.statfsSync(...args);
      return freeBytes === null ? real : { ...real, bavail: 1, bsize: freeBytes };
    },
  };
});
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    // A disk that fills while `fullAt` is written: part of it lands, then ENOSPC.
    cp: (source: string, destination: string, options: Parameters<typeof fs.cp>[2] = {}) =>
      fs.cp(source, destination, {
        ...options,
        filter: async (from: string, to: string) => {
          if (fullAt !== null && basename(from) === fullAt) {
            writeFileSync(to, "par");
            throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
              code: "ENOSPC",
            });
          }
          return options.filter ? options.filter(from, to) : true;
        },
      }),
  };
});

const dirs: string[] = [];
const locked: string[] = [];
afterEach(() => {
  freeBytes = null;
  fullAt = null;
  for (const dir of locked.splice(0)) chmodSync(dir, 0o700);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A saved copy holding `files`, listed with `candidatePaths`, prepared for one reviewer;
 * `unavailable`: what the first copy could not hold, and why. */
async function prepared(
  files: Record<string, string>,
  candidatePaths: string[],
  unavailable: { path: string; reason: string }[] = [],
) {
  const base = mkdtempSync(join(tmpdir(), "cx-reviewer-saved-"));
  dirs.push(base);
  const source = join(base, "saved");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(source, path, ".."), { recursive: true });
    writeFileSync(join(source, path), content);
  }
  mkdirSync(join(base, "evidence"));
  const inventory = await buildReviewerCandidateInventory(source, new Set(), false, candidatePaths);
  return prepareReviewerWorkspace({
    sourceRoot: source,
    sourceEvidenceDir: join(base, "evidence"),
    workspaceBaseDir: join(base, "reviewers"),
    reviewerDirName: "01-reviewer",
    excludeRoots: [],
    candidateCopyPaths: inventory.copyPaths,
    candidatePaths,
    savedCopy: { unavailable },
  });
}

const FILES = { "a.txt": "first file\n", "b.txt": "second file\n", "d/c.txt": "third file\n" };

describe("a reviewer copy of a result's saved files", () => {
  it("names a file the saved copy could not hold with that copy's own cause (#535 R5 B4)", async () => {
    const workspace = await prepared(
      { "a.txt": "first file\n" },
      ["a.txt", "big.txt"],
      [{ path: "big.txt", reason: "space_insufficient" }],
    );

    expect(workspace.uninspectable).toEqual([{ path: "big.txt", reason: "space_insufficient" }]);
    expect(readFileSync(join(workspace.root, "a.txt"), "utf8")).toBe("first file\n");
  });

  it("that cannot fit copies nothing and names every file, so the review cannot pass clean (#535 R3 B4)", async () => {
    freeBytes = 1024;

    const workspace = await prepared(FILES, Object.keys(FILES));

    expect(workspace.uninspectable.map((file) => [file.path, file.reason]).sort()).toEqual([
      ["a.txt", "space_insufficient"],
      ["b.txt", "space_insufficient"],
      ["d/c.txt", "space_insufficient"],
    ]);
    for (const path of Object.keys(FILES))
      expect(existsSync(join(workspace.root, path))).toBe(false);
  });

  it("on a disk that fills mid-copy, keeps no partial file and names what it lacks (#535 R3 B4)", async () => {
    fullAt = "b.txt";

    const workspace = await prepared(FILES, Object.keys(FILES));

    const named = new Map(workspace.uninspectable.map((file) => [file.path, file.reason]));
    expect(named.get("b.txt")).toBe("space_insufficient");
    expect(existsSync(join(workspace.root, "b.txt"))).toBe(false);
    for (const [path, content] of Object.entries(FILES)) {
      const copy = join(workspace.root, path);
      if (named.has(path)) expect(named.get(path)).toBe("space_insufficient");
      else expect(readFileSync(copy, "utf8")).toBe(content);
      if (named.has(path)) expect(lstatSync(copy, { throwIfNoEntry: false })).toBeUndefined();
    }
  });

  it("that fits is copied whole, nothing named", async () => {
    const workspace = await prepared(FILES, Object.keys(FILES));

    expect(workspace.uninspectable).toEqual([]);
    for (const [path, content] of Object.entries(FILES))
      expect(readFileSync(join(workspace.root, path), "utf8")).toBe(content);
  });

  it("reads a deleted descendant of a directory that became a file as deleted (#535 R3 B2)", async () => {
    const workspace = await prepared({ dir: "now a file\n" }, ["dir", "dir/old.txt"]);

    expect(readFileSync(join(workspace.root, "dir"), "utf8")).toBe("now a file\n");
    expect(workspace.uninspectable).toEqual([]);
  });
});

/** A copy of a result's saved files that failed (#535 R15): `left` is what its directory
 * still holds, `null` when it is gone; `mode` turns it unlistable. */
async function preparedFailed(
  left: Record<string, string> | null,
  unavailable: { path: string; reason: string }[],
  options: { failed?: boolean; mode?: number } = {},
) {
  const base = mkdtempSync(join(tmpdir(), "cx-reviewer-failed-"));
  dirs.push(base);
  const source = join(base, "saved");
  if (left) {
    mkdirSync(source);
    for (const [path, content] of Object.entries(left)) writeFileSync(join(source, path), content);
    if (options.mode !== undefined) {
      chmodSync(source, options.mode);
      locked.push(source);
    }
  }
  mkdirSync(join(base, "evidence"));
  const candidatePaths = unavailable.map((file) => file.path);
  const inventory = await buildReviewerCandidateInventory(source, new Set(), false, candidatePaths);
  return prepareReviewerWorkspace({
    sourceRoot: source,
    sourceEvidenceDir: join(base, "evidence"),
    workspaceBaseDir: join(base, "reviewers"),
    reviewerDirName: "01-reviewer",
    excludeRoots: [],
    candidateCopyPaths: inventory.copyPaths,
    candidatePaths,
    savedCopy: { unavailable, failed: options.failed ?? true },
  });
}

const candidateEntries = (root: string) =>
  readdirSync(root).filter((entry) => entry !== ".git" && entry !== ".claudexor-review-evidence");

describe("a reviewer copy of a saved copy that failed (#535 R15)", () => {
  const named = [{ path: "big.txt", reason: "space_insufficient" }];

  it("gives a copy that is gone each file it names with its cause, and nothing to read", async () => {
    const workspace = await preparedFailed(null, named);

    expect(workspace.uninspectable).toEqual(named);
    expect(existsSync(workspace.evidenceDir)).toBe(true);
    expect(candidateEntries(workspace.root)).toEqual([]);
  });

  it("never reads what the failed copy left behind", async () => {
    const workspace = await preparedFailed({ "big.txt": "par", "prior.txt": "old\n" }, named);

    expect(workspace.uninspectable).toEqual(named);
    expect(candidateEntries(workspace.root)).toEqual([]);
  });

  // A mode-000 directory is a POSIX fixture: Windows does not enforce those bits, and root
  // reads through them.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "does not read a copy that cannot be listed",
    async () => {
      const workspace = await preparedFailed({ "left.bin": "x" }, named, { mode: 0o000 });

      expect(workspace.uninspectable).toEqual(named);
      expect(candidateEntries(workspace.root)).toEqual([]);
    },
  );

  it("still refuses a copy that did not fail and is gone, rather than read its files as deleted (control)", async () => {
    await expect(preparedFailed(null, [], { failed: false })).rejects.toThrow(
      "candidate root does not exist",
    );
  });
});
