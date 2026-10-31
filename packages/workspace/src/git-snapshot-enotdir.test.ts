import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { snapshotTree } from "./git.js";

// #535 R4 F2: the snapshot's clean check asks lstat whether a skip-worktree file is
// there, and `throwIfNoEntry: false` does not cover ENOTDIR: when a parent of the
// marked path became a file, snapshotTree threw, so delivery, revert, in-place turn
// snapshots and envelope creation failed where main's stashCreate succeeded.
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

function repoWith(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "cx-snapshot-enotdir-"));
  dirs.push(repo);
  git(repo, "init", "-q", "-b", "main");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  return repo;
}

/** What main's stashCreate recorded: HEAD in a scratch index, then `add -A`. */
function plainSnapshotTree(repo: string): string {
  const scratch = mkdtempSync(join(tmpdir(), "cx-snapshot-enotdir-index-"));
  dirs.push(scratch);
  const env = { ...ENV, GIT_INDEX_FILE: join(scratch, "index") };
  execFileSync("git", ["-C", repo, "read-tree", "HEAD"], { env });
  execFileSync("git", ["-C", repo, "add", "-A"], { env });
  return execFileSync("git", ["-C", repo, "write-tree"], { env }).toString("utf8").trim();
}

describe("a skip-worktree path under a parent that became a file", () => {
  it("is absent: the snapshot holds what add -A records, as on main", async () => {
    const repo = repoWith({ "dir/file": "tracked\n", "keep.txt": "keep\n" });
    git(repo, "update-index", "--skip-worktree", "dir/file");
    rmSync(join(repo, "dir"), { recursive: true });
    writeFileSync(join(repo, "dir"), "now a file\n");
    writeFileSync(join(repo, "keep.txt"), "keep, edited\n");

    const tree = git(repo, "rev-parse", `${await snapshotTree(repo)}^{tree}`);

    expect(tree).toBe(plainSnapshotTree(repo));
    expect(git(repo, "cat-file", "-p", `${tree}:dir`)).toBe("now a file");
    expect(git(repo, "cat-file", "-p", `${tree}:keep.txt`)).toBe("keep, edited");
    expect(git(repo, "ls-files", "-t", "dir/file")).toBe("S dir/file");
  });

  it("is absent in a cone sparse checkout whose excluded directory's name is now a file", async () => {
    const repo = repoWith({ "near/n.txt": "n\n", "far/x.txt": "x\n" });
    git(repo, "sparse-checkout", "set", "--cone", "near");
    writeFileSync(join(repo, "far"), "the user's untracked file\n");
    writeFileSync(join(repo, "near/n.txt"), "n, edited\n");

    const tree = git(repo, "rev-parse", `${await snapshotTree(repo)}^{tree}`);

    expect(tree).toBe(plainSnapshotTree(repo));
    expect(git(repo, "cat-file", "-p", `${tree}:far`)).toBe("the user's untracked file");
    expect(git(repo, "cat-file", "-p", `${tree}:near/n.txt`)).toBe("n, edited");
  });

  it("still compares a marked file that is there by its bytes", async () => {
    const repo = repoWith({ "dir/file": "tracked\n", "keep.txt": "keep\n" });
    git(repo, "update-index", "--skip-worktree", "dir/file");
    writeFileSync(join(repo, "dir/file"), "edited behind the mark\n");

    const tree = git(repo, "rev-parse", `${await snapshotTree(repo)}^{tree}`);

    expect(git(repo, "cat-file", "-p", `${tree}:dir/file`)).toBe("edited behind the mark");
  });
});
