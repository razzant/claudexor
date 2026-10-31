import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { composeOnTarget } from "./object-compose.js";

// #535 repair r1 (F8): composition passes changed paths to Git as pathspec
// arguments. A Windows command line holds about 32K characters, so a batch
// must be bounded by its total length, not only by its path count. Every Git
// command line composition starts is measured here.
const commandLines: number[] = [];
vi.mock("./git-observed.js", async (original) => {
  const actual = await original<typeof import("./git-observed.js")>();
  return {
    ...actual,
    gitObserved: async (...args: Parameters<typeof actual.gitObserved>) => {
      const [repo, argv] = args;
      commandLines.push(["git", "-C", repo, ...argv].reduce((sum, arg) => sum + arg.length + 1, 0));
      return actual.gitObserved(...args);
    },
  };
});

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
const git = (repo: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync("git", ["-C", repo, ...args], { env: { ...ENV, ...env }, maxBuffer: 1 << 26 })
    .toString("utf8")
    .trim();
const WINDOWS_COMMAND_LINE = 32_767;

describe("composition pathspec batches (F8)", () => {
  it("keeps every Git command line under the Windows limit for many long shared paths", async () => {
    const repo = mkdtempSync(join(tmpdir(), "cx-compose-argv-"));
    dirs.push(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    // 300 files with ~190-character paths that both the target and the candidate edit.
    const paths = Array.from(
      { length: 300 },
      (_, i) => `dir-${i % 7}/${"long-name-".repeat(17)}${String(i).padStart(4, "0")}.txt`,
    );
    const body = (edit: Record<number, string>) =>
      Array.from({ length: 20 }, (_, line) => `${edit[line] ?? `line ${line}`}\n`).join("");
    const writeAll = (edit: Record<number, string>) => {
      for (const path of paths) {
        mkdirSync(join(repo, path, ".."), { recursive: true });
        writeFileSync(join(repo, path), body(edit));
      }
    };
    const treeOfWorktree = () => {
      const index = join(mkdtempSync(join(tmpdir(), "cx-compose-argv-index-")), "index");
      dirs.push(join(index, ".."));
      git(repo, ["add", "-A"], { GIT_INDEX_FILE: index });
      return git(repo, ["write-tree"], { GIT_INDEX_FILE: index });
    };
    writeAll({});
    const base = treeOfWorktree();
    writeAll({ 1: "target" });
    const target = treeOfWorktree();
    writeAll({ 18: "candidate" });
    const candidate = treeOfWorktree();
    commandLines.length = 0;
    const composed = await composeOnTarget({ repo, base, target, candidate });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    expect(git(repo, ["show", `${composed.tree}:${paths[123]}`])).toBe(
      body({ 1: "target", 18: "candidate" }).trimEnd(),
    );
    expect(Math.max(...commandLines)).toBeLessThan(WINDOWS_COMMAND_LINE);
  });

  // A pairing component cannot be split: splitting it would change which sources
  // its destinations pair with. It is limited by two reduced trees instead.
  it("keeps a rename/copy component's command lines under the limit, its records unchanged", async () => {
    const repo = mkdtempSync(join(tmpdir(), "cx-compose-argv-"));
    dirs.push(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "diff.renames", "copies"]);
    const blob = (text: string) =>
      execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], { env: ENV, input: text })
        .toString("utf8")
        .trim();
    const text = Array.from({ length: 100 }, (_, at) => `line ${at}\n`).join("");
    const baseBlob = blob(text);
    const targetBlob = blob(text.replace("line 2\n", "target edit\n"));
    const candidateBlob = blob(text.replace("line 98\n", "candidate edit\n"));
    const paths = Array.from(
      { length: 300 },
      (_, at) => `d/${"long-name-".repeat(17)}${String(at).padStart(4, "0")}.txt`,
    );
    const tree = (entries: [string, string][]) => {
      const scratch = mkdtempSync(join(tmpdir(), "cx-compose-argv-index-"));
      dirs.push(scratch);
      const env = { GIT_INDEX_FILE: join(scratch, "index") };
      execFileSync("git", ["-C", repo, "update-index", "-z", "--index-info"], {
        env: { ...ENV, ...env },
        input: entries.map(([path, oid]) => `100644 ${oid}\t${path}\0`).join(""),
      });
      return git(repo, ["write-tree"], env);
    };
    const base = tree([["source.txt", baseBlob]]);
    const target = tree([["source.txt", targetBlob]]);
    const candidate = tree([
      ["source.txt", candidateBlob],
      ...paths.map((path): [string, string] => [path, baseBlob]),
    ]);
    // What the whole component yields when one command line holds every endpoint
    // (legal here, not on Windows): the same records must come out.
    const flags = ["--find-copies=100%", "--find-copies-harder", "--diff-filter=C"];
    const spec = ["--", "source.txt", ...paths].map((path, at) =>
      at === 0 ? path : `:(literal,top)${path}`,
    );
    const direct = execFileSync(
      "git",
      ["-C", repo, "diff", "--raw", "-z", ...flags, base, candidate, ...spec],
      {
        env: ENV,
        maxBuffer: 1 << 26,
      },
    ).toString("utf8");
    expect(direct.split("\0").filter((field) => field.startsWith(":"))).toHaveLength(300);
    commandLines.length = 0;

    const composed = await composeOnTarget({ repo, base, target, candidate });

    expect(composed).toMatchObject({ ok: true });
    if (!composed.ok) return;
    expect(Math.max(...commandLines)).toBeLessThan(WINDOWS_COMMAND_LINE);
    // The tree the same fixture composes when one command line holds every endpoint
    // (measured on the code before this split: 300 copies, a 58,980-character argv).
    expect(composed.tree).toBe("59dda2fa113e68980acc7f608035302e7670ede4");
    // The target's edit is carried through every copy, as `git apply` does for a copy record.
    expect(git(repo, ["rev-parse", `${composed.tree}:source.txt`])).toBe(
      blob(text.replace("line 2\n", "target edit\n").replace("line 98\n", "candidate edit\n")),
    );
    expect(git(repo, ["rev-parse", `${composed.tree}:${paths[123]}`])).toBe(targetBlob);
  });
});
