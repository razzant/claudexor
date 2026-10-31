import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { snapshotTree } from "./git.js";

// A snapshot decides from the bytes, whatever the user's Git configuration or
// index says (#535 R3 A1). With `core.ignoreStat`, a filesystem monitor that
// reports nothing, or an entry marked assume-unchanged, `git status` called an
// edited file clean: the snapshot was HEAD, so a revert composed on it answered
// reverted:true over the delivered bytes it never saw.
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

function repoWith(setup: (repo: string) => void = () => {}): string {
  const repo = mkdtempSync(join(tmpdir(), "cx-snapshot-stat-"));
  dirs.push(repo);
  git(repo, "init", "-q", "-b", "main");
  setup(repo);
  writeFileSync(join(repo, "f.txt"), "hello\n");
  writeFileSync(join(repo, "g.txt"), "other\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  return repo;
}

/** A monitor that always answers "nothing changed since my token". */
function lyingMonitor(repo: string): void {
  const hook = join(mkdtempSync(join(tmpdir(), "cx-fsmonitor-")), "hook.sh");
  dirs.push(join(hook, ".."));
  writeFileSync(hook, "#!/bin/sh\nprintf 'token\\0'\n");
  chmodSync(hook, 0o755);
  git(repo, "config", "core.fsmonitor", hook);
  // The first status records the monitor's token in the index; from then on it is asked.
  git(repo, "status", "--porcelain");
  git(repo, "status", "--porcelain");
}

const blobAt = (repo: string, tree: string, path: string) =>
  git(repo, "rev-parse", `${tree}:${path}`);
const blobOf = (repo: string, content: string) =>
  execFileSync("git", ["-C", repo, "hash-object", "--stdin"], { env: ENV, input: content })
    .toString("utf8")
    .trim();

describe.each([
  ["core.ignoreStat=true", (repo: string) => git(repo, "config", "core.ignoreStat", "true"), null],
  ["a filesystem monitor that reports nothing", null, lyingMonitor],
  [
    "an assume-unchanged entry",
    null,
    (repo: string) => git(repo, "update-index", "--assume-unchanged", "f.txt"),
  ],
  [
    "a skip-worktree entry whose file is there",
    null,
    (repo: string) => git(repo, "update-index", "--skip-worktree", "f.txt"),
  ],
] as const)("%s", (_name, before, after) => {
  it("an edited tracked file is in the snapshot", async () => {
    const repo = repoWith(before ?? undefined);
    after?.(repo);
    writeFileSync(join(repo, "f.txt"), "edited\n");

    const tree = git(repo, "rev-parse", `${await snapshotTree(repo)}^{tree}`);

    expect(blobAt(repo, tree, "f.txt")).toBe(blobOf(repo, "edited\n"));
    expect(blobAt(repo, tree, "g.txt")).toBe(blobOf(repo, "other\n"));
  });

  it("an untouched worktree is still HEAD", async () => {
    const repo = repoWith(before ?? undefined);
    after?.(repo);

    expect(await snapshotTree(repo)).toBe(git(repo, "rev-parse", "HEAD"));
  });
});

describe("a sparse checkout", () => {
  it("leaves its absent files as the index has them: no edit, no snapshot", async () => {
    const repo = repoWith((repo) => {
      mkdirSync(join(repo, "far"));
      writeFileSync(join(repo, "far", "x.txt"), "far away\n");
    });
    git(repo, "sparse-checkout", "set", "--no-cone", "/f.txt", "/g.txt");

    expect(await snapshotTree(repo)).toBe(git(repo, "rev-parse", "HEAD"));
    // The user's own index keeps its marks.
    expect(git(repo, "ls-files", "-t", "far/x.txt")).toBe("S far/x.txt");
  });
});
