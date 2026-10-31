import { execFileSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { materializeTree, type MaterializeInput } from "./object-materialize.js";

// INV-114: a delivery never destroys what it did not track. A snapshot leaves
// ignored files out, so a path the result adds can hold a file the target tree
// does not name, and `read-tree -m -u` overwrites it; nothing could bring it back.
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

function userRepo(files: Record<string, string> = { "kept.txt": "committed\n" }): string {
  const repo = mkdtempSync(join(tmpdir(), "cx-occupied-"));
  dirs.push(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);
  return repo;
}

/** HEAD's tree with `changes` (null removes a path), through a private index. */
function treeWith(repo: string, changes: Record<string, string | null>): string {
  const scratch = mkdtempSync(join(tmpdir(), "cx-occupied-index-"));
  dirs.push(scratch);
  const env = { GIT_INDEX_FILE: join(scratch, "index") };
  git(repo, ["read-tree", "HEAD"], env);
  // Removals first: a directory's entries must go before a file takes its name.
  let removals = "";
  let additions = "";
  for (const [path, content] of Object.entries(changes)) {
    if (content === null) removals += `0 ${"0".repeat(40)}\t${path}\0`;
    else
      additions += `100644 ${git(repo, ["hash-object", "-w", "--stdin"], env, content)}\t${path}\0`;
  }
  git(repo, ["update-index", "-z", "--index-info"], env, removals + additions);
  return git(repo, ["write-tree"], env);
}

const head = (repo: string) => git(repo, ["rev-parse", "HEAD^{tree}"]);
const MODES: MaterializeInput["index"][] = ["temporary", "real"];

describe.skipIf(process.platform === "win32")("a path the result adds", () => {
  it.each(MODES)(
    "refuses a file only .git/info/exclude hides (%s index), writing nothing",
    async (index) => {
      const repo = userRepo();
      writeFileSync(join(repo, ".git/info/exclude"), "notes.md\n");
      writeFileSync(join(repo, "notes.md"), "the user's own notes\n");
      const from = head(repo);
      const to = treeWith(repo, { "notes.md": "the agent's notes\n" });

      const written = await materializeTree({ worktree: repo, from, to, index });

      expect(written).toMatchObject({
        ok: false,
        treeMutated: false,
        refusal: { code: "delivery_path_occupied", paths: ["notes.md"], pathCount: 1 },
      });
      expect(readFileSync(join(repo, "notes.md"), "utf8")).toBe("the user's own notes\n");
      expect(head(repo)).toBe(from);
      expect(git(repo, ["write-tree"])).toBe(from);
    },
  );

  it("refuses an ignored file, keeping every other path of the result unwritten", async () => {
    const repo = userRepo({ ".gitignore": "ign.txt\n", "kept.txt": "committed\n" });
    writeFileSync(join(repo, "ign.txt"), "ignored bytes\n");
    const from = head(repo);
    const to = treeWith(repo, {
      "ign.txt": "delivered\n",
      "kept.txt": "changed by the result\n",
      "other.txt": "new\n",
    });

    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });

    expect(written).toMatchObject({
      ok: false,
      treeMutated: false,
      refusal: { code: "delivery_path_occupied", paths: ["ign.txt"] },
    });
    expect(readFileSync(join(repo, "ign.txt"), "utf8")).toBe("ignored bytes\n");
    expect(readFileSync(join(repo, "kept.txt"), "utf8")).toBe("committed\n");
    expect(lstatSync(join(repo, "other.txt"), { throwIfNoEntry: false })).toBeUndefined();
  });

  it("refuses an ignored directory a file would replace", async () => {
    const repo = userRepo({ ".gitignore": "cache/\n", "kept.txt": "committed\n" });
    mkdirSync(join(repo, "cache"));
    writeFileSync(join(repo, "cache/data.bin"), "expensive\n");
    const from = head(repo);
    const to = treeWith(repo, { cache: "now a file\n" });

    const written = await materializeTree({ worktree: repo, from, to, index: "real" });

    expect(written).toMatchObject({
      ok: false,
      treeMutated: false,
      refusal: { code: "delivery_path_occupied", paths: ["cache/data.bin"] },
    });
    expect(readFileSync(join(repo, "cache/data.bin"), "utf8")).toBe("expensive\n");
  });

  it("refuses an ignored file standing where the result needs a directory", async () => {
    const repo = userRepo({ ".gitignore": "notes\n", "kept.txt": "committed\n" });
    writeFileSync(join(repo, "notes"), "a file, not a directory\n");
    const from = head(repo);
    const to = treeWith(repo, { "notes/a/deep.txt": "delivered\n" });

    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });

    expect(written).toMatchObject({
      ok: false,
      treeMutated: false,
      refusal: { code: "delivery_path_occupied", paths: ["notes"] },
    });
    expect(readFileSync(join(repo, "notes"), "utf8")).toBe("a file, not a directory\n");
  });

  it("refuses an ignored symlink standing where the result needs a directory, and writes nothing through it", async () => {
    const repo = userRepo({ ".gitignore": "link\n", "kept.txt": "committed\n" });
    const elsewhere = mkdtempSync(join(tmpdir(), "cx-occupied-elsewhere-"));
    dirs.push(elsewhere);
    symlinkSync(elsewhere, join(repo, "link"));
    const from = head(repo);
    const to = treeWith(repo, { "link/x.txt": "delivered\n" });

    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });

    expect(written).toMatchObject({
      ok: false,
      treeMutated: false,
      refusal: { code: "delivery_path_occupied", paths: ["link"] },
    });
    expect(readlinkSync(join(repo, "link"))).toBe(elsewhere);
    expect(lstatSync(join(elsewhere, "x.txt"), { throwIfNoEntry: false })).toBeUndefined();
  });

  it("refuses a tracked directory turning into a file while it also holds an ignored file", async () => {
    const repo = userRepo({ ".gitignore": "*.log\n", "d/x.txt": "tracked\n" });
    writeFileSync(join(repo, "d/debug.log"), "ignored\n");
    const from = head(repo);
    const to = treeWith(repo, { "d/x.txt": null, d: "now a file\n" });

    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });

    expect(written).toMatchObject({
      ok: false,
      treeMutated: false,
      refusal: { code: "delivery_path_occupied", paths: ["d/debug.log"] },
    });
    expect(readFileSync(join(repo, "d/debug.log"), "utf8")).toBe("ignored\n");
    expect(readFileSync(join(repo, "d/x.txt"), "utf8")).toBe("tracked\n");
  });

  // The surviving paths: nothing above may narrow an ordinary delivery.
  it("delivers onto absent paths and replaces tracked ones", async () => {
    const repo = userRepo({ "kept.txt": "committed\n", "old.txt": "old\n" });
    const from = head(repo);
    const to = treeWith(repo, {
      "kept.txt": "changed\n",
      "old.txt": null,
      "new/deep/file.txt": "new\n",
    });

    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });

    expect(written).toEqual({ ok: true, changed: 3, treeMutated: true });
    expect(readFileSync(join(repo, "new/deep/file.txt"), "utf8")).toBe("new\n");
  });

  it("delivers a new file into an ignored directory, leaving what the directory holds", async () => {
    const repo = userRepo({ ".gitignore": "build/\n", "kept.txt": "committed\n" });
    mkdirSync(join(repo, "build"));
    writeFileSync(join(repo, "build/cached.o"), "ignored\n");
    const from = head(repo);
    const to = treeWith(repo, { "build/new.txt": "delivered\n" });

    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });

    expect(written).toEqual({ ok: true, changed: 1, treeMutated: true });
    expect(readFileSync(join(repo, "build/cached.o"), "utf8")).toBe("ignored\n");
    expect(readFileSync(join(repo, "build/new.txt"), "utf8")).toBe("delivered\n");
  });

  it("delivers into an empty directory Git never tracked", async () => {
    const repo = userRepo();
    mkdirSync(join(repo, "empty"));
    const from = head(repo);
    const to = treeWith(repo, { "empty/new.txt": "delivered\n" });

    expect(await materializeTree({ worktree: repo, from, to, index: "temporary" })).toEqual({
      ok: true,
      changed: 1,
      treeMutated: true,
    });
  });

  it("delivers a tracked file turning into a directory, and a tracked directory into a file", async () => {
    const repo = userRepo({ f: "a file\n", "d/x.txt": "tracked\n", "d/sub/y.txt": "tracked\n" });
    const from = head(repo);
    const to = treeWith(repo, {
      f: null,
      "f/inside.txt": "now a directory\n",
      "d/x.txt": null,
      "d/sub/y.txt": null,
      d: "now a file\n",
    });

    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });

    expect(written).toEqual({ ok: true, changed: 5, treeMutated: true });
    expect(readFileSync(join(repo, "f/inside.txt"), "utf8")).toBe("now a directory\n");
    expect(readFileSync(join(repo, "d"), "utf8")).toBe("now a file\n");
  });

  it.each(MODES)(
    "a hard link is no case alias: an ignored second name of a removed file is refused (%s index), nothing written",
    async (index) => {
      const repo = userRepo({ "gone.txt": "the user's bytes\n" });
      writeFileSync(join(repo, ".git/info/exclude"), "held.txt\n");
      linkSync(join(repo, "gone.txt"), join(repo, "held.txt"));
      const from = head(repo);
      const to = treeWith(repo, { "gone.txt": null, "held.txt": "the agent's file\n" });

      const written = await materializeTree({ worktree: repo, from, to, index });

      expect(written).toMatchObject({
        ok: false,
        treeMutated: false,
        refusal: { code: "delivery_path_occupied", paths: ["held.txt"], pathCount: 1 },
      });
      expect(readFileSync(join(repo, "held.txt"), "utf8")).toBe("the user's bytes\n");
      expect(readFileSync(join(repo, "gone.txt"), "utf8")).toBe("the user's bytes\n");
      expect(head(repo)).toBe(from);
    },
  );

  it("on a filesystem that folds case, a directory renamed only by case is no occupied path", async () => {
    const repo = userRepo({ "Dir/a.txt": "old spelling\n" });
    const folds = lstatSync(join(repo, "dir"), { throwIfNoEntry: false }) !== undefined;
    if (!folds) return; // A case-sensitive filesystem has no alias to read.
    git(repo, ["config", "core.ignorecase", "true"]);
    const from = head(repo);
    const to = treeWith(repo, { "Dir/a.txt": null, "dir/a.txt": "new spelling\n" });

    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });

    expect(written).toMatchObject({ ok: true, treeMutated: true });
    expect(readFileSync(join(repo, "dir/a.txt"), "utf8")).toBe("new spelling\n");
    expect(existsSync(join(repo, "dir/a.txt"))).toBe(true);
  });

  it("on a filesystem that folds case, a rename that only changes case is no occupied path", async () => {
    const repo = userRepo({ "File.txt": "old name\n" });
    const folds = lstatSync(join(repo, "file.txt"), { throwIfNoEntry: false }) !== undefined;
    if (!folds) return; // A case-sensitive filesystem has no alias to read.
    git(repo, ["config", "core.ignorecase", "true"]);
    const from = head(repo);
    const to = treeWith(repo, { "File.txt": null, "file.txt": "new name\n" });

    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });

    expect(written).toMatchObject({ ok: true, treeMutated: true });
    expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("new name\n");
  });
});
