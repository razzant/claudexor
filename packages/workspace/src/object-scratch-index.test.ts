import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureWorkingTreeTransient } from "./git-transient-capture.js";
import { materializePatchTree, snapshotTree, stashCreate } from "./git.js";
import { composeOnTarget } from "./object-compose.js";
import { revertDeliveryPair } from "./object-revert.js";

// #535 round 8 (P4-F2): under core.splitIndex=true any write of an index, also of
// a private GIT_INDEX_FILE, writes `sharedindex.*` into the repository's Git
// directory. A read-only check, a revert and a capture leave that directory alone.
const dirs: string[] = [];
let configDir: string | undefined;
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  configDir = process.env["CLAUDEXOR_CONFIG_DIR"];
  process.env["CLAUDEXOR_CONFIG_DIR"] = temp("cx-scratch-config-");
});
afterEach(() => {
  if (configDir === undefined) delete process.env["CLAUDEXOR_CONFIG_DIR"];
  else process.env["CLAUDEXOR_CONFIG_DIR"] = configDir;
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
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
const git = (repo: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync("git", ["-C", repo, ...args], { env: { ...ENV, ...env } })
    .toString("utf8")
    .trim();

function userRepo(): string {
  const repo = temp("cx-scratch-");
  git(repo, ["init", "-q", "-b", "main"]);
  for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(repo, name), `${name}\n`);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);
  return repo;
}

/** HEAD's tree with `changes`, through a private index. */
function treeWith(repo: string, changes: Record<string, string>): string {
  const env = { GIT_INDEX_FILE: join(temp("cx-scratch-index-"), "index") };
  git(repo, ["read-tree", "HEAD"], env);
  for (const [path, content] of Object.entries(changes)) {
    const scratch = join(temp("cx-scratch-blob-"), "blob");
    writeFileSync(scratch, content);
    const oid = git(repo, ["hash-object", "-w", scratch]);
    git(repo, ["update-index", "--add", "--cacheinfo", `100644,${oid},${path}`], env);
  }
  return git(repo, ["write-tree"], env);
}

/** Split the repository's own index; returns the check on its Git directory. */
function splitIndex(repo: string): () => void {
  git(repo, ["config", "core.splitIndex", "true"]);
  git(repo, ["update-index", "--split-index"]);
  const shared = () =>
    readdirSync(join(repo, ".git"))
      .filter((name) => name.startsWith("sharedindex."))
      .sort();
  const before = shared();
  expect(before).toHaveLength(1);
  const index = readFileSync(join(repo, ".git", "index"));
  return () => {
    expect(shared()).toEqual(before);
    expect(readFileSync(join(repo, ".git", "index")).equals(index)).toBe(true);
  };
}

describe("a scratch index never writes a shared index into the user's Git directory", () => {
  it("composition, as the read-only apply check runs it", async () => {
    const repo = userRepo();
    const base = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const target = treeWith(repo, { "a.txt": "target\n" });
    const candidate = treeWith(repo, { "b.txt": "candidate\n" });
    const unchanged = splitIndex(repo);

    const composed = await composeOnTarget({ repo, base, target, candidate });

    expect(composed.ok).toBe(true);
    unchanged();
  });

  it("composition of overlapping paths, through its patch step", async () => {
    const repo = userRepo();
    writeFileSync(join(repo, "long.txt"), `${"line\n".repeat(50)}`);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "long"]);
    const base = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const target = treeWith(repo, { "long.txt": `first\n${"line\n".repeat(50)}` });
    const candidate = treeWith(repo, { "long.txt": `${"line\n".repeat(50)}last\n` });
    const unchanged = splitIndex(repo);

    const composed = await composeOnTarget({ repo, base, target, candidate });

    expect(composed.ok).toBe(true);
    unchanged();
  });

  it("the as-written tree of a take-back", async () => {
    const repo = userRepo();
    const pre = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const post = treeWith(repo, { "a.txt": "written\n" });
    const current = treeWith(repo, { "a.txt": "seen through a filter\n" });
    writeFileSync(join(repo, "a.txt"), "written\n");
    const unchanged = splitIndex(repo);

    await revertDeliveryPair({
      worktree: repo,
      pair: { pre_tree: pre, post_tree: post },
      currentTree: current,
      unproven: ["a.txt"],
    });

    unchanged();
  });

  it("a capture", async () => {
    const repo = userRepo();
    const baseSha = git(repo, ["rev-parse", "HEAD"]);
    writeFileSync(join(repo, "a.txt"), "edited\n");
    writeFileSync(join(repo, "new.txt"), "new\n");
    const unchanged = splitIndex(repo);

    const captured = await captureWorkingTreeTransient(repo, baseSha, [], { owner: repo });

    expect(captured.captureIncomplete).toBe(false);
    unchanged();
  });

  it("a dirty snapshot", async () => {
    const repo = userRepo();
    writeFileSync(join(repo, "a.txt"), "edited\n");
    writeFileSync(join(repo, "new.txt"), "new\n");
    const unchanged = splitIndex(repo);

    expect(await stashCreate(repo)).toMatch(/^[0-9a-f]{40}$/);
    expect(await snapshotTree(repo)).toMatch(/^[0-9a-f]{40}$/);

    unchanged();
  });

  it("a legacy patch materialization", async () => {
    const repo = userRepo();
    const baseSha = git(repo, ["rev-parse", "HEAD"]);
    const unchanged = splitIndex(repo);

    await materializePatchTree(
      repo,
      baseSha,
      "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a.txt\n+patched\n",
    );

    unchanged();
  });
});
