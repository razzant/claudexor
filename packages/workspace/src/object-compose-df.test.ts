import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { composeOnTarget } from "./object-compose.js";
import { materializeTree } from "./object-materialize.js";
import { revertDeliveryPair } from "./object-revert.js";

// A directory that becomes a file or a symlink is one change: the deletions
// under it travel with it. `u` must hold them too, or step 6 leaves them out of
// the index and `git apply --cached` refuses on a target that never changed. A
// revert composes the other way, so the same gap made a file-to-directory change
// impossible to take back.
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

type Entry = string | { link: string };
function tree(repo: string, files: Record<string, Entry>): string {
  const scratch = mkdtempSync(join(tmpdir(), "cx-compose-df-index-"));
  dirs.push(scratch);
  const env = { GIT_INDEX_FILE: join(scratch, "index") };
  let info = "";
  for (const [path, entry] of Object.entries(files)) {
    const bytes = typeof entry === "string" ? entry : entry.link;
    const oid = git(repo, ["hash-object", "-w", "--stdin"], env, bytes);
    info += `${typeof entry === "string" ? "100644" : "120000"} ${oid}\t${path}\0`;
  }
  git(repo, ["update-index", "--add", "-z", "--index-info"], env, info);
  return git(repo, ["write-tree"], env);
}

/** A repository checked out at the tree of `files`, committed on main. */
function repoAt(files: Record<string, Entry>): { repo: string; base: string } {
  const repo = mkdtempSync(join(tmpdir(), "cx-compose-df-"));
  dirs.push(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  const base = tree(repo, files);
  git(repo, ["read-tree", "-m", "-u", base]);
  git(repo, ["commit", "-qm", "base"]);
  return { repo, base };
}

const lines = (mark: string) =>
  Array.from({ length: 30 }, (_, at) => `${mark} line ${at}\n`).join("");

describe("a directory that becomes a file or a symlink", () => {
  it("composes on an unchanged target as a file", async () => {
    const { repo, base } = repoAt({ "d/x.txt": "x\n", "d/sub/y.txt": "y\n", "kept.txt": "kept\n" });
    const candidate = tree(repo, { d: "now a file\n", "kept.txt": "kept\n" });

    const composed = await composeOnTarget({ repo, base, target: base, candidate });

    expect(composed).toMatchObject({ ok: true, tree: candidate });
  });

  it.skipIf(process.platform === "win32")(
    "composes on an unchanged target as a symlink",
    async () => {
      const { repo, base } = repoAt({ "d/x.txt": "x\n", "kept.txt": "kept\n" });
      const candidate = tree(repo, { d: { link: "kept.txt" }, "kept.txt": "kept\n" });

      const composed = await composeOnTarget({ repo, base, target: base, candidate });

      expect(composed).toMatchObject({ ok: true, tree: candidate });
    },
  );

  it("keeps a target change that shares nothing with the directory", async () => {
    const { repo, base } = repoAt({ "d/x.txt": "x\n", "other.txt": lines("base") });
    const target = tree(repo, { "d/x.txt": "x\n", "other.txt": lines("target") });
    const candidate = tree(repo, { d: "now a file\n", "other.txt": lines("base") });
    const expected = tree(repo, { d: "now a file\n", "other.txt": lines("target") });

    const composed = await composeOnTarget({ repo, base, target, candidate });

    expect(composed).toMatchObject({ ok: true, tree: expected });
  });

  it("refuses when the target really changed a file under the directory", async () => {
    const { repo, base } = repoAt({ "d/x.txt": "x\n" });
    const target = tree(repo, { "d/x.txt": "the user's edit\n" });
    const candidate = tree(repo, { d: "now a file\n" });

    const composed = await composeOnTarget({ repo, base, target, candidate });

    expect(composed).toMatchObject({ ok: false, refusal: { code: "delivery_conflict" } });
  });

  it("refuses when the target added a file under the directory", async () => {
    const { repo, base } = repoAt({ "d/x.txt": "x\n" });
    const target = tree(repo, { "d/x.txt": "x\n", "d/new.txt": "the user's new file\n" });
    const candidate = tree(repo, { d: "now a file\n" });

    const composed = await composeOnTarget({ repo, base, target, candidate });

    expect(composed).toMatchObject({ ok: false, refusal: { code: "delivery_conflict" } });
  });

  it("accepts a deletion the target already made under the directory (an identical outcome)", async () => {
    const { repo, base } = repoAt({ "d/x.txt": "x\n", "d/y.txt": "y\n" });
    const target = tree(repo, { "d/y.txt": "y\n" });
    const candidate = tree(repo, { d: "now a file\n" });

    const composed = await composeOnTarget({ repo, base, target, candidate });

    expect(composed).toMatchObject({ ok: true, tree: candidate });
  });

  it("delivers to the worktree and reverts on the pair", async () => {
    const { repo, base } = repoAt({ "d/x.txt": "x\n", "d/sub/y.txt": "y\n", "kept.txt": "kept\n" });
    const candidate = tree(repo, { d: "now a file\n", "kept.txt": "kept\n" });
    const composed = await composeOnTarget({ repo, base, target: base, candidate });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;

    expect(
      await materializeTree({ worktree: repo, from: base, to: composed.tree, index: "temporary" }),
    ).toMatchObject({ ok: true });
    expect(readFileSync(join(repo, "d"), "utf8")).toBe("now a file\n");

    const reverted = await revertDeliveryPair({
      worktree: repo,
      pair: { pre_tree: base, post_tree: composed.tree },
      currentTree: composed.tree,
    });

    expect(reverted).toMatchObject({ ok: true, tree: base });
    expect(readFileSync(join(repo, "d/x.txt"), "utf8")).toBe("x\n");
    expect(readFileSync(join(repo, "d/sub/y.txt"), "utf8")).toBe("y\n");
    expect(lstatSync(join(repo, "d")).isDirectory()).toBe(true);
  });
});

describe("a file that becomes a directory", () => {
  it("composes, delivers and reverts on the pair", async () => {
    const { repo, base } = repoAt({ f: "a file\n", "kept.txt": "kept\n" });
    const candidate = tree(repo, { "f/inside.txt": "inside\n", "kept.txt": "kept\n" });
    const composed = await composeOnTarget({ repo, base, target: base, candidate });
    expect(composed).toMatchObject({ ok: true, tree: candidate });
    if (!composed.ok) return;
    await materializeTree({ worktree: repo, from: base, to: composed.tree, index: "temporary" });
    expect(readFileSync(join(repo, "f/inside.txt"), "utf8")).toBe("inside\n");

    const reverted = await revertDeliveryPair({
      worktree: repo,
      pair: { pre_tree: base, post_tree: composed.tree },
      currentTree: composed.tree,
    });

    expect(reverted).toMatchObject({ ok: true, tree: base });
    expect(readFileSync(join(repo, "f"), "utf8")).toBe("a file\n");
  });

  it("a later edit outside the delivery survives the revert", async () => {
    const { repo, base } = repoAt({ f: "a file\n", "kept.txt": lines("base") });
    const candidate = tree(repo, { "f/inside.txt": "inside\n", "kept.txt": lines("base") });
    const composed = await composeOnTarget({ repo, base, target: base, candidate });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    await materializeTree({ worktree: repo, from: base, to: composed.tree, index: "temporary" });
    // The user edits another file after the delivery.
    const edited = lines("user");
    writeFileSync(join(repo, "kept.txt"), edited);
    const current = tree(repo, { "f/inside.txt": "inside\n", "kept.txt": edited });

    const reverted = await revertDeliveryPair({
      worktree: repo,
      pair: { pre_tree: base, post_tree: composed.tree },
      currentTree: current,
    });

    expect(reverted).toMatchObject({ ok: true });
    expect(readFileSync(join(repo, "f"), "utf8")).toBe("a file\n");
    expect(readFileSync(join(repo, "kept.txt"), "utf8")).toBe(edited);
  });

  it("a later edit inside the delivered directory refuses the revert, nothing restored", async () => {
    const { repo, base } = repoAt({ f: "a file\n" });
    const candidate = tree(repo, { "f/inside.txt": "inside\n" });
    const composed = await composeOnTarget({ repo, base, target: base, candidate });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    await materializeTree({ worktree: repo, from: base, to: composed.tree, index: "temporary" });
    writeFileSync(join(repo, "f/inside.txt"), "the user's edit\n");
    const current = tree(repo, { "f/inside.txt": "the user's edit\n" });

    const reverted = await revertDeliveryPair({
      worktree: repo,
      pair: { pre_tree: base, post_tree: composed.tree },
      currentTree: current,
    });

    expect(reverted).toMatchObject({
      ok: false,
      treeMutated: false,
      refusal: { code: "revert_conflict" },
    });
    expect(readFileSync(join(repo, "f/inside.txt"), "utf8")).toBe("the user's edit\n");
    expect(existsSync(join(repo, "f/inside.txt"))).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "a symlink that becomes a directory delivers and reverts",
    async () => {
      const { repo, base } = repoAt({ l: { link: "kept.txt" }, "kept.txt": "kept\n" });
      const candidate = tree(repo, { "l/inside.txt": "inside\n", "kept.txt": "kept\n" });
      const composed = await composeOnTarget({ repo, base, target: base, candidate });
      expect(composed).toMatchObject({ ok: true, tree: candidate });
      if (!composed.ok) return;
      await materializeTree({ worktree: repo, from: base, to: composed.tree, index: "temporary" });

      const reverted = await revertDeliveryPair({
        worktree: repo,
        pair: { pre_tree: base, post_tree: composed.tree },
        currentTree: composed.tree,
      });

      expect(reverted).toMatchObject({ ok: true, tree: base });
      expect(readlinkSync(join(repo, "l"))).toBe("kept.txt");
    },
  );
});

describe("a rename onto the name of the directory it replaces", () => {
  it("carries the target's edit and takes the directory's deletions with it", async () => {
    const text = lines("rename me");
    const { repo, base } = repoAt({ "d/x.txt": "x\n", "a.txt": text });
    const edited = text.replace("rename me line 3", "target edit");
    const target = tree(repo, { "d/x.txt": "x\n", "a.txt": edited });
    const candidate = tree(repo, { d: text });
    const expected = tree(repo, { d: edited });

    const composed = await composeOnTarget({ repo, base, target, candidate });

    expect(composed).toMatchObject({ ok: true, tree: expected });
  });
});

describe("a rename out of a directory that becomes a file", () => {
  it("emits each record once: the rename's source is not deleted a second time", async () => {
    const text = lines("rename me");
    const { repo, base } = repoAt({ "d/x.txt": text, "d/y.txt": "y\n" });
    const edited = text.replace("rename me line 3", "target edit");
    const target = tree(repo, { "d/x.txt": edited, "d/y.txt": "y\n" });
    const candidate = tree(repo, { d: "now a file\n", "e.txt": text });
    const expected = tree(repo, { d: "now a file\n", "e.txt": edited });

    const composed = await composeOnTarget({ repo, base, target, candidate });

    expect(composed).toMatchObject({ ok: true, tree: expected });
  });
});

describe("many paths under a directory that becomes a file", () => {
  it("does not depend on where a command-line batch would have fallen", async () => {
    const files: Record<string, Entry> = {};
    for (let at = 0; at < 450; at += 1) files[`d/f${at}.txt`] = `${at}\n`;
    const { repo, base } = repoAt(files);
    const candidate = tree(repo, { d: "now a file\n" });

    const composed = await composeOnTarget({ repo, base, target: base, candidate });

    expect(composed).toMatchObject({ ok: true, tree: candidate });
  });
});

describe("a rename endpoint beside a directory turned into a file", () => {
  it("the closure takes both, and the composition keeps the rename's bytes", async () => {
    const text = lines("rename me");
    const { repo, base } = repoAt({ "d/x.txt": "x\n", "a.txt": text });
    // The target edits the rename's source; the candidate renames it and turns d into a file.
    const edited = text.replace("rename me line 3", "target edit");
    const target = tree(repo, { "d/x.txt": "x\n", "a.txt": edited });
    const candidate = tree(repo, { d: "now a file\n", "b.txt": text });
    const expected = tree(repo, { d: "now a file\n", "b.txt": edited });

    const composed = await composeOnTarget({ repo, base, target, candidate });

    expect(composed).toMatchObject({ ok: true, tree: expected });
  });
});
