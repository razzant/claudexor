import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { materializeTree } from "./object-materialize.js";

// A temporary-index checkout (apply, take-back, revert) must cost what
// `git apply` costs: hash work for the paths it writes, never for the whole
// worktree, while the user's index stays exactly as it was.
const dirs: string[] = [];
afterAll(() => {
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
const git = (repo: string, args: string[], env: Record<string, string> = {}, input?: string) =>
  execFileSync("git", ["-C", repo, ...args], { env: { ...ENV, ...env }, input })
    .toString("utf8")
    .trim();
const OLD = new Date("2020-01-01T00:00:00Z");
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** `n` committed files whose stat the index holds and does not consider racy. */
function userRepo(n: number): string {
  const repo = temp("cx-seed-");
  git(repo, ["init", "-q", "-b", "main"]);
  for (let i = 0; i < n; i++) {
    const path = join(repo, `d${Math.floor(i / 50)}`, `f${i}.txt`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `file ${i}\n`);
    utimesSync(path, OLD, OLD);
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);
  return repo;
}

/** HEAD's tree with `changes` (path -> content), written through a private index. */
function treeWith(repo: string, changes: Record<string, string>): string {
  const env = { GIT_INDEX_FILE: join(temp("cx-seed-index-"), "index") };
  git(repo, ["read-tree", "HEAD"], env);
  let info = "";
  for (const [path, content] of Object.entries(changes))
    info += `100644 ${git(repo, ["hash-object", "-w", "--stdin"], env, content)}\t${path}\0`;
  git(repo, ["update-index", "-z", "--index-info"], env, info);
  return git(repo, ["write-tree"], env);
}

/** One line per file Git hashes through its clean conversion, and per file a checkout writes. */
function countingFilter(repo: string) {
  const at = temp("cx-seed-count-");
  const common = git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  mkdirSync(join(common, "info"), { recursive: true });
  writeFileSync(join(common, "info", "attributes"), "* filter=count\n");
  git(repo, ["config", "filter.count.clean", `echo c >> '${join(at, "clean")}'; cat`]);
  git(repo, ["config", "filter.count.smudge", `echo s >> '${join(at, "smudge")}'; cat`]);
  const lines = (name: string) =>
    existsSync(join(at, name))
      ? readFileSync(join(at, name), "utf8").split("\n").filter(Boolean).length
      : 0;
  return { clean: () => lines("clean"), smudge: () => lines("smudge") };
}

const CHANGES = { "d0/f1.txt": "one\n", "d2/f120.txt": "two\n", "d5/f298.txt": "three\n" };
const K = Object.keys(CHANGES).length;

describe.skipIf(process.platform === "win32")("a temporary-index checkout seeds its index", () => {
  it.each(["main", "linked"] as const)(
    "hashes only the paths it writes, not the whole worktree (%s worktree)",
    async (kind) => {
      const main = userRepo(300);
      let repo = main;
      if (kind === "linked") {
        repo = join(temp("cx-seed-linked-"), "wt");
        git(main, ["worktree", "add", "-q", repo, "HEAD"]);
        for (const name of git(repo, ["ls-files", "-z"]).split("\0").filter(Boolean))
          utimesSync(join(repo, name), OLD, OLD);
        git(repo, ["update-index", "-q", "--really-refresh"]);
      }
      const indexPath = git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
      const indexBefore = readFileSync(indexPath);
      const from = git(repo, ["rev-parse", "HEAD^{tree}"]);
      const to = treeWith(repo, CHANGES);
      const counts = countingFilter(repo);

      const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });

      expect(written).toEqual({ ok: true, changed: K, treeMutated: true });
      for (const [path, content] of Object.entries(CHANGES))
        expect(readFileSync(join(repo, path), "utf8")).toBe(content);
      // A checkout writes the K paths once; the stat cache keeps the other 297 un-hashed
      // (an unseeded index hashed all 300 before writing).
      expect(counts.smudge()).toBe(K);
      expect(counts.clean()).toBeLessThanOrEqual(3 * K);
      expect(readFileSync(indexPath).equals(indexBefore)).toBe(true);
    },
  );

  it("refuses before writing a path the user changed without changing its stat, never overwriting it", async () => {
    const repo = userRepo(20);
    git(repo, ["config", "core.trustctime", "false"]);
    const file = join(repo, "d0/f1.txt");
    // Same size, same inode, the old mtime: the user's index trusts this file.
    writeFileSync(file, "FILE 1\n");
    utimesSync(file, OLD, OLD);
    expect(git(repo, ["status", "--porcelain"])).toBe("");
    const from = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const to = treeWith(repo, { "d0/f1.txt": "changed\n" });

    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });

    expect(written).toMatchObject({
      ok: false,
      treeMutated: false,
      refusal: { code: "delivery_target_changed", paths: ["d0/f1.txt"] },
    });
    expect(readFileSync(file, "utf8")).toBe("FILE 1\n");
  });

  it("keeps the user's staged change staged and out of what it writes", async () => {
    const repo = userRepo(20);
    writeFileSync(join(repo, "d0/f2.txt"), "staged edit\n");
    git(repo, ["add", "d0/f2.txt"]);
    const indexBefore = readFileSync(join(repo, ".git", "index"));
    const from = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const to = treeWith(repo, { "d0/f3.txt": "changed\n" });

    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });

    expect(written).toEqual({ ok: true, changed: 1, treeMutated: true });
    expect(readFileSync(join(repo, ".git", "index")).equals(indexBefore)).toBe(true);
    expect(git(repo, ["diff", "--cached", "--name-only"])).toBe("d0/f2.txt");
    expect(readFileSync(join(repo, "d0/f2.txt"), "utf8")).toBe("staged edit\n");
    expect(readFileSync(join(repo, "d0/f3.txt"), "utf8")).toBe("changed\n");
  });

  it("only reads a split index: no shared index is written or removed in the user's Git directory", async () => {
    const repo = userRepo(600);
    // A quarter of the entries change: above Git's splitIndex.maxPercentChange
    // (20%), where writing a split index would also write a new shared index.
    const many = Object.fromEntries(
      Array.from({ length: 150 }, (_, at) => [
        `d${Math.floor((at * 4) / 50)}/f${at * 4}.txt`,
        `changed ${at}\n`,
      ]),
    );
    // Built first: under core.splitIndex=true any write of another index file
    // (this helper's too) leaves a shared index in the user's Git directory.
    const from = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const to = treeWith(repo, many);
    git(repo, ["config", "core.splitIndex", "true"]);
    git(repo, ["update-index", "--split-index"]);
    const shared = () =>
      readdirSync(join(repo, ".git"))
        .filter((name) => name.startsWith("sharedindex."))
        .sort();
    const sharedBefore = shared();
    expect(sharedBefore).toHaveLength(1);
    const indexBefore = readFileSync(join(repo, ".git", "index"));
    const counts = countingFilter(repo);

    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });

    expect(written).toEqual({ ok: true, changed: 150, treeMutated: true });
    expect(shared()).toEqual(sharedBefore);
    expect(readFileSync(join(repo, ".git", "index")).equals(indexBefore)).toBe(true);
    expect(counts.clean()).toBeLessThanOrEqual(3 * 150);
  });

  it("seeds while another process holds index.lock, and neither takes nor removes it", async () => {
    const repo = userRepo(300);
    const lock = join(repo, ".git", "index.lock");
    writeFileSync(lock, "held by another process");
    const lockStat = statSync(lock);
    const from = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const to = treeWith(repo, CHANGES);
    const counts = countingFilter(repo);

    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });

    expect(written).toEqual({ ok: true, changed: K, treeMutated: true });
    expect(readFileSync(lock, "utf8")).toBe("held by another process");
    expect(statSync(lock).ino).toBe(lockStat.ino);
    expect(counts.clean()).toBeLessThanOrEqual(3 * K);
  });

  it("without any index file reads `from` whole and still writes exactly the change", async () => {
    const repo = userRepo(20);
    rmSync(join(repo, ".git", "index"));
    const from = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const to = treeWith(repo, { "d0/f3.txt": "changed\n" });

    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });

    expect(written).toEqual({ ok: true, changed: 1, treeMutated: true });
    expect(readFileSync(join(repo, "d0/f3.txt"), "utf8")).toBe("changed\n");
    expect(existsSync(join(repo, ".git", "index"))).toBe(false);
  });
});
