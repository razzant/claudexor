import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { snapshotTree } from "./git-snapshot.js";

// #535 R14 A1: the snapshot's clean check is `git status`, which trusts the index's
// stat cache. With `core.checkStat=minimal` and `core.trustctime=false` an edit that
// keeps a file's size and mtime reads as unchanged, so a clean answer returned HEAD
// while the file held other bytes, and a revert composed against it called the
// delivered file already reverted. The paths a caller decides on are now read by
// content; a sparse checkout's intentionally absent files still are not.
const dirs: string[] = [];
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
const git = (repo: string, ...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { env: ENV })
    .toString("utf8")
    .trim();
/** What the user's own `git status` says, without letting it rewrite the index. */
const userStatus = (repo: string) =>
  execFileSync("git", ["-C", repo, "status", "--porcelain"], {
    env: { ...ENV, GIT_OPTIONAL_LOCKS: "0" },
  })
    .toString("utf8")
    .trim();
const Y2000 = 946_684_800;

/** f.txt held "before\n" at a fixed mtime when the index recorded it; a minimal stat check. */
function repository() {
  const repo = mkdtempSync(join(tmpdir(), "cx-snapshot-exact-"));
  dirs.push(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "core.trustctime", "false");
  git(repo, "config", "core.checkStat", "minimal");
  writeFileSync(join(repo, "f.txt"), "before\n");
  writeFileSync(join(repo, "g.txt"), "g\n");
  utimesSync(join(repo, "f.txt"), Y2000, Y2000);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  return repo;
}

/** The same size and the same mtime: Git's stat check cannot see this edit. */
function hiddenEdit(repo: string, bytes: string) {
  writeFileSync(join(repo, "f.txt"), bytes);
  utimesSync(join(repo, "f.txt"), Y2000, Y2000);
}

describe("a snapshot reads the paths its caller decides on by content", () => {
  it("an edit that kept a file's size and mtime is seen there", async () => {
    const repo = repository();
    hiddenEdit(repo, "after!\n");
    expect(userStatus(repo)).toBe(""); // the user's own Git says clean

    const snapshot = await snapshotTree(repo, ["f.txt"]);

    expect(snapshot).not.toBe(git(repo, "rev-parse", "HEAD"));
    expect(git(repo, "show", `${snapshot}:f.txt`)).toBe("after!");
  });

  it("without such a path the shortcut stands, as the user's own status (control)", async () => {
    const repo = repository();
    hiddenEdit(repo, "after!\n");

    expect(await snapshotTree(repo)).toBe(git(repo, "rev-parse", "HEAD"));
    expect(await snapshotTree(repo, ["g.txt"])).toBe(git(repo, "rev-parse", "HEAD"));
  });

  it("a path that truly holds what the index says stays clean (control)", async () => {
    const repo = repository();
    hiddenEdit(repo, "before\n");

    expect(await snapshotTree(repo, ["f.txt", "g.txt"])).toBe(git(repo, "rev-parse", "HEAD"));
  });

  it("a file the sparse patterns leave out stays absent on purpose, not deleted", async () => {
    const repo = repository();
    mkdirSync(join(repo, "near"));
    mkdirSync(join(repo, "far"));
    writeFileSync(join(repo, "near/a.txt"), "a\n");
    writeFileSync(join(repo, "far/x.txt"), "x\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "dirs");
    git(repo, "sparse-checkout", "set", "--cone", "near");
    expect(existsSync(join(repo, "far/x.txt"))).toBe(false);

    expect(await snapshotTree(repo, ["far/x.txt", "near/a.txt"])).toBe(
      git(repo, "rev-parse", "HEAD"),
    );
  });

  it("an index copied for marks keeps the user's index time, so a racily clean entry is compared", async () => {
    const repo = repository();
    git(repo, "update-index", "--assume-unchanged", "g.txt"); // marks make the check copy the index
    // The index was written in the very second f.txt was last stamped: Git cannot
    // trust that entry's stat data and compares its content.
    utimesSync(join(repo, ".git/index"), Y2000, Y2000);
    hiddenEdit(repo, "after!\n");
    expect(userStatus(repo)).toBe("M f.txt");

    const snapshot = await snapshotTree(repo);

    expect(git(repo, "show", `${snapshot}:f.txt`)).toBe("after!");
  });
});
