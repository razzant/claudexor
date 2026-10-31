import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeTree } from "./object-materialize.js";

// #535 R4 A2 at the checkout itself: whatever its caller checked before, a checkout
// never addresses a path outside the sparse-checkout patterns (a change to a
// skip-worktree file the user kept on disk deleted that file). It refuses typed
// with nothing written.
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
const git = (repo: string, args: string[], env: Record<string, string> = {}, input?: string) =>
  execFileSync("git", ["-C", repo, ...args], { env: { ...ENV, ...env }, input })
    .toString("utf8")
    .trim();
const read = (repo: string, path: string) =>
  existsSync(join(repo, path)) ? readFileSync(join(repo, path), "utf8") : null;

/** A cone sparse checkout of near/; far/x.txt is tracked outside it. */
function sparseRepo(): { repo: string; tree: string } {
  const repo = mkdtempSync(join(tmpdir(), "cx-materialize-sparse-"));
  dirs.push(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  mkdirSync(join(repo, "near"));
  mkdirSync(join(repo, "far"));
  writeFileSync(join(repo, "near/n.txt"), "n\n");
  writeFileSync(join(repo, "far/x.txt"), "x\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);
  git(repo, ["sparse-checkout", "set", "--cone", "near"]);
  return { repo, tree: git(repo, ["rev-parse", "HEAD^{tree}"]) };
}

/** `tree` with `files` set, built in a scratch index. */
function treeWith(repo: string, tree: string, files: Record<string, string>): string {
  const scratch = mkdtempSync(join(tmpdir(), "cx-materialize-sparse-index-"));
  dirs.push(scratch);
  const env = { GIT_INDEX_FILE: join(scratch, "index") };
  git(repo, ["read-tree", tree], env);
  for (const [path, content] of Object.entries(files)) {
    const blob = git(repo, ["hash-object", "-w", "--stdin"], env, content);
    git(repo, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], env);
  }
  return git(repo, ["write-tree"], env);
}

describe("a checkout in a sparse checkout", () => {
  it("refuses a tree that changes a path outside the patterns, writing nothing", async () => {
    const { repo, tree } = sparseRepo();
    mkdirSync(join(repo, "far"));
    writeFileSync(join(repo, "far/x.txt"), "x\n");
    const to = treeWith(repo, tree, { "far/x.txt": "changed\n", "near/n.txt": "n, changed\n" });

    const written = await materializeTree({ worktree: repo, from: tree, to, index: "temporary" });

    expect(written).toMatchObject({
      ok: false,
      treeMutated: false,
      refusal: { code: "delivery_outside_sparse_checkout", paths: ["far/x.txt"] },
    });
    expect(read(repo, "far/x.txt")).toBe("x\n");
    expect(read(repo, "near/n.txt")).toBe("n\n");
  });

  it("writes a tree that changes only paths inside the patterns (the control)", async () => {
    const { repo, tree } = sparseRepo();
    const to = treeWith(repo, tree, { "near/n.txt": "n, changed\n" });

    expect(
      await materializeTree({ worktree: repo, from: tree, to, index: "temporary" }),
    ).toMatchObject({ ok: true });

    expect(read(repo, "near/n.txt")).toBe("n, changed\n");
    expect(read(repo, "far/x.txt")).toBeNull();
  });

  it("with core.sparseCheckout set but no patterns file, writes everything as Git does", async () => {
    const repo = mkdtempSync(join(tmpdir(), "cx-materialize-no-patterns-"));
    dirs.push(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    mkdirSync(join(repo, "far"));
    writeFileSync(join(repo, "far/x.txt"), "x\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "base"]);
    git(repo, ["config", "core.sparseCheckout", "true"]);
    const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const to = treeWith(repo, tree, { "far/new.txt": "new\n" });

    expect(
      await materializeTree({ worktree: repo, from: tree, to, index: "temporary" }),
    ).toMatchObject({ ok: true });

    expect(read(repo, "far/new.txt")).toBe("new\n");
  });
});
