import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { materializeTree } from "./object-materialize.js";

// #535 repair r1: the per-path content proof after `read-tree -m -u` must hold
// for every name Git can store (F5) and for both symlink settings (F6).
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

function userRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cx-materialize-"));
  dirs.push(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "kept.txt"), "committed\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);
  return repo;
}

/** HEAD's tree plus `entries` (mode, content, path), written through a private index. */
function treeWith(repo: string, entries: { mode: string; content: string; path: string }[]) {
  const scratch = mkdtempSync(join(tmpdir(), "cx-materialize-index-"));
  dirs.push(scratch);
  const env = { GIT_INDEX_FILE: join(scratch, "index") };
  git(repo, ["read-tree", "HEAD"], env);
  let info = "";
  for (const entry of entries) {
    const oid = git(repo, ["hash-object", "-w", "--stdin"], env, entry.content);
    info += `${entry.mode} ${oid}\t${entry.path}\0`;
  }
  git(repo, ["update-index", "-z", "--index-info"], env, info);
  return git(repo, ["write-tree"], env);
}

describe("materializeTree content proof", () => {
  // Windows filesystems cannot hold these names.
  it.skipIf(process.platform === "win32")(
    "proves paths Git would read as quoted on stdin (F5)",
    async () => {
      const repo = userRepo();
      const names = [
        '"quoted.txt',
        '"both".txt',
        "back\\slash.txt",
        "tab\there.txt",
        "new\nline.txt",
      ];
      const from = git(repo, ["rev-parse", "HEAD^{tree}"]);
      const to = treeWith(
        repo,
        names.map((path, at) => ({ mode: "100644", content: `file ${at}\n`, path })),
      );
      const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });
      expect(written).toEqual({ ok: true, changed: names.length, treeMutated: true });
      names.forEach((path, at) =>
        expect(readFileSync(join(repo, path), "utf8")).toBe(`file ${at}\n`),
      );
    },
  );

  it.each([true, false])("verifies an added symlink with core.symlinks=%s (F6)", async (links) => {
    const repo = userRepo();
    git(repo, ["config", "core.symlinks", String(links)]);
    const from = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const to = treeWith(repo, [{ mode: "120000", content: "kept.txt", path: "link" }]);
    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });
    expect(written).toEqual({ ok: true, changed: 1, treeMutated: true });
    const stat = lstatSync(join(repo, "link"));
    if (links) {
      expect(stat.isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(repo, "link"))).toBe("kept.txt");
    } else {
      // Git writes the link as a plain file holding its target.
      expect(stat.isFile()).toBe(true);
      expect(readFileSync(join(repo, "link"), "utf8")).toBe("kept.txt");
    }
  });
});

// Whether a failed checkout wrote anything is measured on the paths it would
// write, never read from Git's wording (Astra A3): a path name in a partial
// checkout's message can read like a refusal, and real refusals stay unchanged.
describe("materializeTree after a failed checkout", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a partial checkout whose failing path is named like a refusal is reported as written",
    async () => {
      const repo = userRepo();
      mkdirSync(join(repo, "z"));
      writeFileSync(join(repo, "z", "old.txt"), "old\n");
      writeFileSync(join(repo, "a.txt"), "a\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-qm", "dirs"]);
      const from = git(repo, ["rev-parse", "HEAD^{tree}"]);
      const to = treeWith(repo, [
        { mode: "100644", content: "a2\n", path: "a.txt" },
        { mode: "100644", content: "never\n", path: "z/index.lock.txt" },
      ]);
      // Git writes a.txt, then cannot create z/index.lock.txt in a read-only directory.
      chmodSync(join(repo, "z"), 0o555);
      try {
        const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });
        expect(written).toMatchObject({
          ok: false,
          treeMutated: true,
          refusal: { code: "git_failed", paths: ["a.txt", "z/index.lock.txt"] },
        });
        if (!written.ok) {
          expect(written.refusal.message).toContain("index.lock.txt");
          expect(written.refusal.message).toContain("the checkout stopped partway");
        }
        expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a2\n");
      } finally {
        chmodSync(join(repo, "z"), 0o755);
      }
    },
  );

  it.each(["temporary", "real"] as const)(
    "a path the user changed since T is refused before any write, unchanged (%s index)",
    async (index) => {
      const repo = userRepo();
      const from = git(repo, ["rev-parse", "HEAD^{tree}"]);
      const to = treeWith(repo, [{ mode: "100644", content: "ours\n", path: "kept.txt" }]);
      writeFileSync(join(repo, "kept.txt"), "user edit\n");
      const written = await materializeTree({ worktree: repo, from, to, index });
      expect(written).toMatchObject({
        ok: false,
        treeMutated: false,
        refusal: { code: "delivery_target_changed" },
      });
      if (!written.ok) expect(written.refusal.message).toContain("not uptodate");
      expect(readFileSync(join(repo, "kept.txt"), "utf8")).toBe("user edit\n");
      expect(git(repo, ["diff", "--cached", "--name-only"])).toBe("");
    },
  );

  it("an untracked file in the way of an added path is refused before any write, unchanged", async () => {
    const repo = userRepo();
    const from = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const to = treeWith(repo, [{ mode: "100644", content: "ours\n", path: "n.txt" }]);
    writeFileSync(join(repo, "n.txt"), "the user's untracked file\n");
    const written = await materializeTree({ worktree: repo, from, to, index: "temporary" });
    expect(written).toMatchObject({
      ok: false,
      treeMutated: false,
      refusal: { code: "delivery_path_occupied", paths: ["n.txt"] },
    });
    expect(readFileSync(join(repo, "n.txt"), "utf8")).toBe("the user's untracked file\n");
  });
});
