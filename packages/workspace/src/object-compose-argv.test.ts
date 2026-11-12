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
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
// #650: synchronous fixture Git must not block the worker past testTimeout.
const GIT_BOUND_MS = 30_000;
type GitFailure = NodeJS.ErrnoException & { status: number | null; signal: string | null };
// These fixtures pass command lines of about 59,000 characters; a failure keeps both ends.
const clip = (text: string) =>
  text.length <= 1_000
    ? text
    : `${text.slice(0, 500)}…${text.length - 1_000} characters…${text.slice(-500)}`;
const gitWithin =
  (timeoutMs: number) =>
  (repo: string, args: string[], env: Record<string, string> = {}, input?: string) => {
    const argv = ["-C", repo, ...args];
    try {
      return execFileSync("git", argv, {
        env: { ...ENV, ...env },
        input,
        stdio: "pipe", // diagnostics reach the error, not the run log
        maxBuffer: 1 << 26,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      })
        .toString("utf8")
        .trim();
    } catch (error) {
      // The same error, its fields kept: the command and its ending lead the message.
      const failure = error as GitFailure;
      const { code, status, signal } = failure;
      const ending = code === "ETIMEDOUT" ? `timed out after ${timeoutMs} ms` : "failed";
      failure.message = `${clip(`git ${argv.join(" ")}`)} ${ending} (status ${status}, signal ${signal}): ${clip(failure.message)}`;
      throw failure;
    }
  };
const git = gitWithin(GIT_BOUND_MS);
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
    const blob = (text: string) => git(repo, ["hash-object", "-w", "--stdin"], {}, text);
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
      const info = entries.map(([path, oid]) => `100644 ${oid}\t${path}\0`).join("");
      git(repo, ["update-index", "-z", "--index-info"], env, info);
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
    const direct = git(repo, ["diff", "--raw", "-z", ...flags, base, candidate, ...spec]);
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

describe("this file's Git children are bounded and fail honestly (#650)", () => {
  const longArgs = ["rev-parse", "--verify", `${"a".repeat(60_000)}-last`];
  const clipped = String.raw`git -C .+ rev-parse --verify a{1,500}…\d+ characters…a{1,500}-last`;

  it("ends a child at the bound, naming it without printing its whole command line", () => {
    // A stand-in for a blocked Git that only SIGKILL can end.
    const bin = mkdtempSync(join(tmpdir(), "cx-compose-argv-bin-"));
    dirs.push(bin);
    writeFileSync(join(bin, "git"), "#!/bin/sh\ntrap '' TERM\nexec sleep 20\n", { mode: 0o755 });
    const env = { PATH: `${bin}:${process.env["PATH"] ?? ""}` };
    expect(() => gitWithin(500)(bin, longArgs, env)).toThrow(
      expect.objectContaining({
        code: "ETIMEDOUT",
        status: null,
        signal: "SIGKILL",
        spawnargs: ["-C", bin, ...longArgs],
        message: expect.stringMatching(
          new RegExp(
            `^${clipped} timed out after 500 ms \\(status null, signal SIGKILL\\): spawnSync git ETIMEDOUT$`,
          ),
        ),
      }),
    );
  });

  it("names a Git command that exits nonzero and keeps its status and diagnostics", () => {
    const repo = mkdtempSync(join(tmpdir(), "cx-compose-argv-"));
    dirs.push(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    expect(() => git(repo, longArgs)).toThrow(
      expect.objectContaining({
        status: 128,
        signal: null,
        message: expect.stringMatching(
          new RegExp(
            `^${clipped} failed \\(status 128, signal null\\): Command failed: ${clipped}\\n\\S`,
          ),
        ),
      }),
    );
  });
});
