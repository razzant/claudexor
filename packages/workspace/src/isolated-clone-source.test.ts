import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isolatedCloneAdd, stashCreate } from "./git.js";

// #501: `git clone --shared` lists the source's objects as an alternate only for
// a full source. From a shallow one Git silently makes a transport clone of what
// the source's refs reach, so an object only the source holds (a Claudexor dirty
// snapshot, a composed delivery tree) could not be read in the private clone.
const dirs: string[] = [];
// Each test removes its own repositories: one sweep at the end of the file can
// outlast the hook timeout on a loaded machine (#376).
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const git = (repo: string, args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { env: ENV })
    .toString("utf8")
    .trim();
const holds = (args: string[], oid: string) =>
  spawnSync("git", [...args, "cat-file", "-e", oid], { env: ENV }).status === 0;
const same = (a: string, b: string) => realpathSync(a) === realpathSync(b);
const digest = (path: string) =>
  existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;

/** A three-commit upstream and a store-shaped bare repository, under a path with a space and non-ASCII. */
function world() {
  const root = join(mkdtempSync(join(tmpdir(), "cx-clone-source-")), "dir with space ü");
  dirs.push(join(root, ".."));
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  git(work, ["init", "-q", "-b", "main"]);
  for (const value of ["one", "two", "three"]) {
    writeFileSync(join(work, "value.txt"), `${value}\n`);
    git(work, ["add", "-A"]);
    git(work, ["commit", "-qm", value]);
  }
  git(root, ["clone", "-q", "--bare", work, "upstream.git"]);
  git(root, ["init", "-q", "--bare", "store.git"]);
  return {
    root,
    upstream: `file://${join(root, "upstream.git")}`,
    store: join(root, "store.git", "objects"),
  };
}

/** Dirty the tree and take Claudexor's snapshot: a commit only the source's object database holds. */
async function dirtySnapshot(repo: string): Promise<string> {
  writeFileSync(join(repo, "value.txt"), "three\nunsaved ü edit\n");
  writeFileSync(join(repo, "new file ü.txt"), "untracked\n");
  const snapshot = await stashCreate(repo);
  expect(snapshot).toBeTruthy();
  expect(git(repo, ["for-each-ref", "--contains", snapshot!])).toBe("");
  return snapshot!;
}

async function cloneOf(source: string, snapshot: string, store?: string): Promise<string> {
  const clone = join(mkdtempSync(join(tmpdir(), "cx-clone-source-tree-")), "tree");
  dirs.push(join(clone, ".."));
  await isolatedCloneAdd(source, clone, "claudexor/t/a01", snapshot, store);
  expect(git(clone, ["rev-parse", "HEAD"])).toBe(snapshot);
  expect(readFileSync(join(clone, "value.txt"), "utf8")).toBe("three\nunsaved ü edit\n");
  expect(readFileSync(join(clone, "new file ü.txt"), "utf8")).toBe("untracked\n");
  expect(git(clone, ["remote"])).toBe("");
  return clone;
}

const alternatesOf = (clone: string) =>
  readFileSync(join(clone, ".git", "objects", "info", "alternates"), "utf8")
    .split("\n")
    .filter(Boolean);

/** What a clone could change in its source as Git and the user see it. */
function sourceState(repo: string) {
  const gitDir = git(repo, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const common = git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return {
    head: git(repo, ["rev-parse", "HEAD"]),
    refs: git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    index: digest(join(gitDir, "index")),
    shallow: digest(join(common, "shallow")),
    alternates: existsSync(join(common, "objects", "info", "alternates")),
    // A read that never refreshes the index it is comparing.
    status: execFileSync("git", ["-C", repo, "status", "--porcelain=v1"], {
      env: { ...ENV, GIT_OPTIONAL_LOCKS: "0" },
    }).toString("utf8"),
    worktree: [digest(join(repo, "value.txt")), digest(join(repo, "new file ü.txt"))],
  };
}

describe("isolatedCloneAdd keeps its source as an object alternate (#501)", () => {
  it("a shallow source: its objects are the first alternate, the store the second", async () => {
    const w = world();
    const source = join(w.root, "shallow");
    git(w.root, ["clone", "-q", "--depth", "1", w.upstream, source]);
    expect(git(source, ["rev-parse", "--is-shallow-repository"])).toBe("true");
    const snapshot = await dirtySnapshot(source);
    const before = sourceState(source);
    const clone = await cloneOf(source, snapshot, w.store);

    const [first, second, ...rest] = alternatesOf(clone);
    expect(same(first!, join(source, ".git", "objects"))).toBe(true);
    expect(second).toBe(w.store);
    expect(rest).toEqual([]);
    // Still a consistent shallow repository: its history reads down to the boundary.
    expect(git(clone, ["rev-parse", "--is-shallow-repository"])).toBe("true");
    expect(git(clone, ["log", "--format=%s"])).toBe(
      "claudexor: dirty worktree snapshot (incl. untracked)\nthree",
    );
    // Writes in the clone stay there: neither the source nor the store gets them.
    writeFileSync(join(clone, "probe.txt"), `private ${snapshot}\n`);
    const probe = git(clone, ["hash-object", "-w", "probe.txt"]);
    git(clone, ["add", "-A"]);
    git(clone, ["commit", "-qm", "private"]);
    for (const oid of [probe, git(clone, ["rev-parse", "HEAD"])]) {
      expect(holds(["-C", source], oid)).toBe(false);
      expect(holds(["--git-dir", join(w.root, "store.git")], oid)).toBe(false);
    }
    expect(sourceState(source)).toEqual(before);
  });

  it("a shallow source whose .git is a file lends the object directory Git names", async () => {
    const w = world();
    const source = join(w.root, "separate");
    const gitDir = join(w.root, "separate git dir.git");
    git(w.root, ["clone", "-q", "--depth", "1", "--separate-git-dir", gitDir, w.upstream, source]);
    expect(existsSync(join(source, ".git", "HEAD"))).toBe(false);
    const snapshot = await dirtySnapshot(source);
    const clone = await cloneOf(source, snapshot);

    expect(alternatesOf(clone).map((line) => same(line, join(gitDir, "objects")))).toEqual([true]);
  });

  it("a full source keeps the one alternate Git itself writes", async () => {
    const w = world();
    const source = join(w.root, "full");
    git(w.root, ["clone", "-q", w.upstream, source]);
    const snapshot = await dirtySnapshot(source);
    const before = sourceState(source);
    const clone = await cloneOf(source, snapshot, w.store);

    const [first, second, ...rest] = alternatesOf(clone);
    expect(same(first!, join(source, ".git", "objects"))).toBe(true);
    expect(second).toBe(w.store);
    expect(rest).toEqual([]);
    expect(sourceState(source)).toEqual(before);
  });

  it("a linked worktree source lends its repository's common object directory", async () => {
    const w = world();
    const main = join(w.root, "main");
    git(w.root, ["clone", "-q", w.upstream, main]);
    const source = join(w.root, "linked ü");
    git(main, ["worktree", "add", "-q", "-b", "side", source]);
    const snapshot = await dirtySnapshot(source);
    const before = sourceState(source);
    const clone = await cloneOf(source, snapshot, w.store);

    const [first, second, ...rest] = alternatesOf(clone);
    expect(same(first!, join(main, ".git", "objects"))).toBe(true);
    expect(second).toBe(w.store);
    expect(rest).toEqual([]);
    expect(sourceState(source)).toEqual(before);
  });

  it("a linked worktree of a shallow repository keeps that repository's history boundary", async () => {
    const w = world();
    const main = join(w.root, "main shallow");
    git(w.root, ["clone", "-q", "--depth", "1", w.upstream, main]);
    const source = join(w.root, "linked ü");
    git(main, ["worktree", "add", "-q", "-b", "side", source]);
    expect(git(source, ["rev-parse", "--is-shallow-repository"])).toBe("true");
    const snapshot = await dirtySnapshot(source);
    const before = sourceState(source);
    const clone = await cloneOf(source, snapshot, w.store);

    // Git copies such a source locally: the alternate and refs come, its boundary did not.
    const [first, second, ...rest] = alternatesOf(clone);
    expect(same(first!, join(main, ".git", "objects"))).toBe(true);
    expect(second).toBe(w.store);
    expect(rest).toEqual([]);
    const boundary = git(source, ["rev-parse", "--path-format=absolute", "--git-path", "shallow"]);
    expect(readFileSync(join(clone, ".git", "shallow"), "utf8")).toBe(
      readFileSync(boundary, "utf8"),
    );
    // A harness or gate reading history meets the source's boundary, not a broken graph.
    expect(git(clone, ["rev-parse", "--is-shallow-repository"])).toBe("true");
    expect(git(clone, ["log", "--format=%s"])).toBe(
      "claudexor: dirty worktree snapshot (incl. untracked)\nthree",
    );
    const fsck = ["-C", clone, "fsck", "--connectivity-only", "--no-dangling"];
    expect(spawnSync("git", fsck, { env: ENV }).status).toBe(0);
    expect(sourceState(source)).toEqual(before);
  });

  it("a clone that fails for another reason keeps Git's error alone", async () => {
    const w = world();
    const source = join(w.root, "shallow");
    git(w.root, ["clone", "-q", "--depth", "1", w.upstream, source]);
    const occupied = join(mkdtempSync(join(tmpdir(), "cx-clone-source-tree-")), "tree");
    dirs.push(join(occupied, ".."));
    mkdirSync(occupied);
    writeFileSync(join(occupied, "already here"), "\n");
    const head = git(source, ["rev-parse", "HEAD"]);
    const failed = await isolatedCloneAdd(source, occupied, "claudexor/t/a01", head).then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(failed?.startsWith("isolated clone failed: ")).toBe(true);
    expect(failed).toContain("already exists");
    expect(failed).not.toContain("does not hold");
    expect(failed).not.toContain("Claudexor fetches nothing");
  });
});
