import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureFailureEvidence } from "./capture-failure.js";
import { captureWorkingTreeTransient, snapshotTree } from "./git.js";
import { listedNames, nameText, QUOTED_NAMES, quotedNames } from "./git-nested-repositories.js";
import { objectStorePath } from "./object-store.js";

// #734: a sparse checkout of src/ where the work also creates files outside the
// patterns. Git's `add -A` refuses such a new file, which failed the whole capture;
// both captures now hold it, and everything `add -A` did before stays as it was.

// `fakeFreeBytes` makes statfs report a nearly full filesystem (ESM namespaces cannot be
// spied, so node:fs is wrapped once for this file, as capture-failure-classes.test.ts does).
let fakeFreeBytes: number | null = null;
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    statfsSync: (...args: Parameters<typeof fs.statfsSync>) => {
      const real = fs.statfsSync(...args);
      return fakeFreeBytes === null ? real : { ...real, bavail: 1, bsize: fakeFreeBytes };
    },
  };
});

const dirs: string[] = [];
afterEach(() => {
  fakeFreeBytes = null;
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
// A capture's tree is kept in the project object store, never in the user's repository.
const gitBytes = (repo: string, args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], {
    env: { ...ENV, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(objectStorePath(repo), "objects") },
    stdio: ["ignore", "pipe", "ignore"],
  });
const git = (repo: string, ...args: string[]) => gitBytes(repo, args).toString("utf8").trim();

function put(repo: string, path: string, content: string | Buffer): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

const PATTERNS = {
  cone: ["--cone", "src"],
  "non-cone": ["--no-cone", "/.gitattributes", "/.gitignore", "src/"],
};

/** src/a and other/b are tracked, with any `more`; only src/ (and the root's own files) is checked out. */
function sparseRepo(
  mode: keyof typeof PATTERNS = "cone",
  more: Record<string, string> = {},
  patterns: readonly string[] = PATTERNS[mode],
): string {
  const repo = mkdtempSync(join(tmpdir(), "cx-sparse-new-file-"));
  dirs.push(repo);
  git(repo, "init", "-q", "-b", "main");
  put(repo, "src/a", "one\n");
  put(repo, "other/b", "two\n");
  put(repo, "other/.gitignore", "*.log\n");
  put(repo, ".gitignore", "*.tmp\n");
  put(repo, ".gitattributes", "*.py text eol=lf\n");
  for (const [path, content] of Object.entries(more)) put(repo, path, content);
  git(repo, "add", "-A", "-f");
  git(repo, "commit", "-qm", "base");
  git(repo, "sparse-checkout", "set", ...patterns);
  expect(existsSync(join(repo, "other/b"))).toBe(false);
  return repo;
}

/** What the user's Git holds: the index with its marks, the patterns and the status. */
const userState = (repo: string) => ({
  index: git(repo, "ls-files", "-s", "-t"),
  patterns: git(repo, "sparse-checkout", "list"),
  status: git(repo, "status", "--porcelain", "--untracked-files=all", "--ignored"),
});
/** The files of the user's Git a capture must never write, byte for byte. */
const userBytes = (repo: string) => ({
  index: readFileSync(join(repo, ".git/index")),
  patterns: readFileSync(join(repo, ".git/info/sparse-checkout")),
});
const changes = (repo: string, base: string, tree: string) =>
  git(repo, "diff", "--no-renames", "--name-status", base, tree).split("\n").filter(Boolean);
const blob = (repo: string, tree: string, path: string) =>
  gitBytes(repo, ["cat-file", "blob", `${tree}:${path}`]);

const EVIDENCE = Buffer.from([0, 1, 2, 0xff, 0x65, 0x76, 0]);
const ISSUE = ["A\t.review-evidence/check.txt", "M\tsrc/a", "A\ttests/new_test.py"];

/** The issue's work: an edit inside the patterns, a new test and review evidence outside. */
function work(repo: string): void {
  put(repo, "src/a", "one edited\n");
  put(repo, "tests/new_test.py", "print(1)\r\n");
  put(repo, ".review-evidence/check.txt", EVIDENCE);
}

async function captured(
  repo: string,
  base: string,
  excludes: string[] = [],
  cwd = repo,
): Promise<string> {
  const capture = await captureWorkingTreeTransient(cwd, base, excludes, { projectRoot: repo });
  if (capture.captureIncomplete) throw capture.captureFailure;
  return capture.result!.candidate_tree;
}

describe("new files outside the sparse-checkout patterns (#734)", () => {
  it.each(["cone", "non-cone"] as const)(
    "are held by the snapshot and the capture beside the edit, in a %s checkout",
    async (mode) => {
      const repo = sparseRepo(mode);
      work(repo);
      const before = userState(repo);

      const snapshot = await snapshotTree(repo);
      const capture = await captureWorkingTreeTransient(repo, "HEAD", [], { projectRoot: repo });

      expect(changes(repo, "HEAD", snapshot)).toEqual(ISSUE);
      expect(capture.captureIncomplete).toBe(false);
      expect(capture.result?.candidate_tree).toBe(git(repo, "rev-parse", `${snapshot}^{tree}`));
      // Git's own conversion (the root .gitattributes), the evidence byte for byte,
      // and the file the sparse checkout leaves out exactly as HEAD has it.
      expect(blob(repo, snapshot, "tests/new_test.py").toString()).toBe("print(1)\n");
      expect(blob(repo, snapshot, ".review-evidence/check.txt").equals(EVIDENCE)).toBe(true);
      expect(git(repo, "rev-parse", `${snapshot}:other`)).toBe(
        git(repo, "rev-parse", "HEAD:other"),
      );
      expect(capture.patch).toContain("b/tests/new_test.py");
      expect(capture.patch).toContain("GIT binary patch");
      expect(capture.patch).not.toContain("other/b");
      expect(userState(repo)).toEqual(before);
      expect(existsSync(join(repo, "other/b"))).toBe(false);
    },
  );

  it("leave the evidence out only where the caller excludes it", async () => {
    const repo = sparseRepo();
    work(repo);

    const tree = await captured(repo, "HEAD", [":(exclude,top).review-evidence"]);

    expect(changes(repo, "HEAD", tree)).toEqual(["M\tsrc/a", "A\ttests/new_test.py"]);
  });

  it("are followed on the next turn: an edit, a removal, and a file the user staged", async () => {
    const repo = sparseRepo();
    work(repo);
    const base = await snapshotTree(repo); // the turn's private dirty baseline
    expect(git(repo, "ls-files", "tests", ".review-evidence")).toBe("");

    put(repo, "tests/new_test.py", "print(2)\r\n");
    rmSync(join(repo, ".review-evidence/check.txt"));
    const next = ["D\t.review-evidence/check.txt", "M\ttests/new_test.py"];
    expect(changes(repo, base, await captured(repo, base))).toEqual(next);
    expect(changes(repo, base, await snapshotTree(repo))).toEqual(next);

    // The user's own index may hold the file by now; the working tree still decides.
    git(repo, "add", "--sparse", "tests/new_test.py");
    put(repo, "tests/new_test.py", "print(3)\r\n");
    const staged = await captured(repo, base);
    expect(changes(repo, base, staged)).toEqual(next);
    expect(blob(repo, staged, "tests/new_test.py").toString()).toBe("print(3)\n");

    rmSync(join(repo, "tests/new_test.py"));
    const removed = ["D\t.review-evidence/check.txt", "D\ttests/new_test.py"];
    expect(changes(repo, base, await captured(repo, base))).toEqual(removed);
    expect(changes(repo, base, await snapshotTree(repo))).toEqual(removed);
  });

  it.skipIf(process.platform === "win32")(
    "are held when the checkout is named through a symlink and `..`, as Git resolves it",
    async () => {
      const repo = sparseRepo();
      work(repo);
      const holder = mkdtempSync(join(tmpdir(), "cx-sparse-link-"));
      dirs.push(holder);
      symlinkSync(join(repo, "src"), join(holder, "link"));
      // Physically the checkout's top; resolved as text it would be the link's own parent.
      const root = `${holder}/link/..`;
      const before = userBytes(repo);

      const snapshot = await snapshotTree(root);
      const capture = await captureWorkingTreeTransient(root, "HEAD", [], { projectRoot: repo });

      expect(userBytes(repo)).toEqual(before);
      expect(changes(repo, "HEAD", snapshot)).toEqual(ISSUE);
      expect(capture.captureIncomplete).toBe(false);
      expect(capture.result?.candidate_tree).toBe(git(repo, "rev-parse", `${snapshot}^{tree}`));
    },
  );

  it("are held under the names Git must quote, byte for byte", async () => {
    const repo = sparseRepo();
    // Non-ASCII, a real U+FFFD and a glob-like name anywhere; a quote, a backslash,
    // a tab and a newline where a file system can hold them.
    const names = ["tests/тест \uFFFD.py", "tests/[n]ew_test.py"];
    if (process.platform !== "win32") names.push('tests/q"uo\\te\tline\nnext.py');
    for (const name of names) put(repo, name, "print(1)\n");
    const before = userBytes(repo);

    const snapshot = await snapshotTree(repo);
    const tree = await captured(repo, "HEAD");

    expect(userBytes(repo)).toEqual(before);
    expect(tree).toBe(git(repo, "rev-parse", `${snapshot}^{tree}`));
    const added = gitBytes(repo, ["diff", "--no-renames", "--name-only", "-z", "HEAD", tree]);
    expect(added.toString("utf8").split("\0").filter(Boolean).sort()).toEqual([...names].sort());
  });

  it("stay out below a directory that became another repository where the base has files, which is named", async () => {
    const repo = sparseRepo();
    work(repo);
    // Git descends into other/ (the index has other/b) and lists the repository's file as plain.
    mkdirSync(join(repo, "other"));
    git(join(repo, "other"), "init", "-q");
    put(repo, "other/new", "inside another repository\n");
    const before = userBytes(repo);

    const snapshot = await snapshotTree(repo);
    const capture = await captureWorkingTreeTransient(repo, "HEAD", [], { projectRoot: repo });

    expect(userBytes(repo)).toEqual(before);
    expect(changes(repo, "HEAD", snapshot)).toEqual(ISSUE);
    expect(capture.captureIncomplete).toBe(false);
    expect(capture.result?.candidate_tree).toBe(git(repo, "rev-parse", `${snapshot}^{tree}`));
    expect(capture.excludedNestedRepositories).toEqual(["other"]);
    expect(git(repo, "rev-parse", `${snapshot}:other`)).toBe(git(repo, "rev-parse", "HEAD:other"));
  });

  it("are followed on a later turn, ignored by now or not, except below a directory that became another repository, which is named", async () => {
    const repo = sparseRepo();
    work(repo);
    const base = await snapshotTree(repo); // took in tests/ and .review-evidence/
    // The base's entries make Git descend into tests/ and list no repository there: it is
    // found through the base's own files. The evidence is ignored by now, and followed all
    // the same, as `add -A` follows a tracked file.
    git(join(repo, "tests"), "init", "-q");
    put(repo, ".git/info/exclude", "/.review-evidence/\n");
    put(repo, "tests/new_test.py", "print(2)\r\n");
    put(repo, "src/a", "one edited twice\n");
    put(repo, ".review-evidence/check.txt", "edited\n");
    expect(git(repo, "check-ignore", ".review-evidence/check.txt")).toBe(
      ".review-evidence/check.txt",
    );
    const before = userBytes(repo);

    const capture = await captureWorkingTreeTransient(repo, base, [], { projectRoot: repo });

    expect(userBytes(repo)).toEqual(before);
    expect(capture.captureIncomplete).toBe(false);
    const tree = capture.result!.candidate_tree;
    expect(changes(repo, base, tree)).toEqual(["M\t.review-evidence/check.txt", "M\tsrc/a"]);
    expect(capture.excludedNestedRepositories).toEqual(["tests"]);
    expect(git(repo, "rev-parse", `${tree}:tests`)).toBe(git(repo, "rev-parse", `${base}:tests`));
    expect(blob(repo, tree, "tests/new_test.py").toString()).toBe("print(1)\n");
  });

  it("are left as the snapshot has them in a worktree made on it, where the sparse checkout leaves them absent", async () => {
    const repo = sparseRepo();
    work(repo);
    const base = await snapshotTree(repo);
    const holder = mkdtempSync(join(tmpdir(), "cx-sparse-worktree-"));
    dirs.push(holder);
    const thread = join(holder, "thread");
    git(repo, "worktree", "add", "-q", "--detach", thread, base);
    // Sparse like the checkout it came from (a Git that does not copy the patterns gets them
    // here): the files the snapshot took in out there are absent, each marked by Git itself.
    git(thread, "sparse-checkout", "set", "--cone", "src");
    expect(git(thread, "ls-files", "-t", "tests", ".review-evidence")).toBe(
      "S .review-evidence/check.txt\nS tests/new_test.py",
    );
    expect(existsSync(join(thread, "tests"))).toBe(false);
    put(thread, "src/a", "one edited by the agent\n");
    const before = userState(thread);

    const tree = await captured(repo, base, [], thread);

    // Only the agent's edit: nobody deleted the files that checkout never had.
    expect(changes(repo, base, tree)).toEqual(["M\tsrc/a"]);
    expect(blob(repo, tree, "tests/new_test.py").toString()).toBe("print(1)\n");
    expect(userState(thread)).toEqual(before);
  });

  it("do not false-positive on bracket names: shape[2].csv is not shape2.csv", async () => {
    const repo = sparseRepo();
    put(repo, "other/.gitignore", "shape2.csv\n");
    git(repo, "add", "-f", "other/.gitignore");
    git(repo, "commit", "-qm", "ignore rule");
    git(repo, "sparse-checkout", "set", "--cone", "src");
    put(repo, "src/a", "edited\n");
    put(repo, "other/shape[2].csv", "data\n");
    put(repo, "other/shape2.csv", "ignored\n");
    const before = userBytes(repo);

    const capture = await captureWorkingTreeTransient(repo, "HEAD", [], { projectRoot: repo });

    expect(userBytes(repo)).toEqual(before);
    // shape[2].csv is NOT ignored (the rule matches shape2.csv, not shape[2].csv).
    // shape2.csv IS ignored and must not appear; capture fails on it as before.
    expect(capture.captureIncomplete).toBe(true);
    expect(capture.captureFailure?.message).toContain("shape2.csv");
  });

  it("are left as the snapshot has them where the user committed them and the sparse checkout then left them out again", async () => {
    const repo = sparseRepo();
    work(repo);
    const base = await snapshotTree(repo);
    git(repo, "add", "--sparse", "tests/new_test.py", ".review-evidence/check.txt");
    git(repo, "commit", "-qm", "keep the work");
    git(repo, "sparse-checkout", "reapply");
    expect(git(repo, "ls-files", "-t", "tests", ".review-evidence")).toBe(
      "S .review-evidence/check.txt\nS tests/new_test.py",
    );
    expect(existsSync(join(repo, "tests"))).toBe(false);
    put(repo, "src/a", "one edited twice\n");

    expect(changes(repo, base, await captured(repo, base))).toEqual(["M\tsrc/a"]);
  });

  it("are counted before they are written, among them a file the user's Git ignores by now", async () => {
    const repo = sparseRepo();
    put(repo, ".review-evidence/check.txt", EVIDENCE);
    const base = await snapshotTree(repo); // took in the evidence
    put(repo, ".git/info/exclude", "/.review-evidence/\n");
    put(repo, ".review-evidence/check.txt", Buffer.alloc(256 * 1024, 7));
    // The preflight reads `git status`, which lists nothing: the one changed file is ignored by now.
    expect(git(repo, "status", "--porcelain", "--untracked-files=all")).toBe("");
    fakeFreeBytes = 4096; // nearly full, and what the capture would write fits only if it is not counted

    const refused = await captureWorkingTreeTransient(repo, base, [], { projectRoot: repo });

    expect(refused.captureIncomplete).toBe(true);
    expect(refused.captureFailure?.message).toMatch(
      /^capture needs \d+ bytes plus a \d+-byte margin;/,
    );
    const failure = captureFailureEvidence(refused.captureFailure);
    expect(failure.code).toBe("capture_space_insufficient");
    expect(failure.availableBytes).toBe(4096);
    expect(failure.requiredBytes).toBeGreaterThan(256 * 1024);

    fakeFreeBytes = null;
    expect(changes(repo, base, await captured(repo, base))).toEqual([
      "M\t.review-evidence/check.txt",
    ]);
  });

  it("are held beside an empty .git directory or a gitfile that names no repository: neither is one", async () => {
    const repo = sparseRepo();
    work(repo);
    mkdirSync(join(repo, "tests/.git"));
    put(repo, ".review-evidence/.git", "not a gitfile\n");
    const before = userBytes(repo);

    const capture = await captureWorkingTreeTransient(repo, "HEAD", [], { projectRoot: repo });

    expect(userBytes(repo)).toEqual(before);
    expect(capture.captureIncomplete).toBe(false);
    expect(capture.excludedNestedRepositories).toBeUndefined();
    expect(changes(repo, "HEAD", capture.result!.candidate_tree)).toEqual(ISSUE);
  });

  it("are not taken under a glob-like name that only a .gitignore outside the patterns ignores", async () => {
    const repo = sparseRepo("cone", { "other/archive.log": "tracked all the same\n" });
    put(repo, "src/a", "one edited\n");
    // Each stands, read as a glob, for the tracked other/archive.log (a file system that
    // reserves `*` and `?` in names cannot hold the last two).
    const names = ["other/[a]rchive.log"];
    if (process.platform !== "win32") names.push("other/arc*ve.log", "other/arch?ve.log");
    for (const name of names) put(repo, name, "noise\n");
    // The user's Git ignores the new files themselves (other/.gitignore, read from its index).
    expect(git(repo, "status", "--porcelain", "--untracked-files=all", "--ignored")).toBe(
      ["M src/a", ...[...names].sort().map((name) => `!! ${name}`)].join("\n"),
    );
    const before = userBytes(repo);

    await expect(snapshotTree(repo)).rejects.toThrow(/other\/\[a\]rchive\.log/);
    const capture = await captureWorkingTreeTransient(repo, "HEAD", [], { projectRoot: repo });

    expect(userBytes(repo)).toEqual(before);
    expect(capture.captureIncomplete).toBe(true);
    // Git's refusal lists every file that is still new to the scratch index: none was taken.
    for (const name of names) expect(capture.captureFailure?.message).toContain(name);
  });

  // Out of the patterns, a `.gitignore` is read from the user's index alone, at every level
  // above the file, and not only in the file's own directory.
  it.each(["other/cache/x.log", "other/deep/er/y.log"])(
    "are not taken when a .gitignore outside the patterns ignores them from above their directory: %s",
    async (path) => {
      const repo = sparseRepo();
      put(repo, "src/a", "one edited\n");
      put(repo, path, "noise\n");
      expect(git(repo, "status", "--porcelain", "--untracked-files=all", "--ignored")).toBe(
        `M src/a\n!! ${path}`,
      );
      const before = userBytes(repo);

      await expect(snapshotTree(repo)).rejects.toThrow(path);
      const capture = await captureWorkingTreeTransient(repo, "HEAD", [], { projectRoot: repo });

      expect(userBytes(repo)).toEqual(before);
      expect(capture.captureIncomplete).toBe(true);
      expect(capture.captureFailure?.message).toContain(path);
    },
  );

  it("fail the capture, in Git's words, below a commit link that only the checkout's own index holds", async () => {
    const repo = sparseRepo();
    // The base has no link there, so the new file is one to the capture; the checkout's own
    // index has it, and Git refuses to say whether a path inside a submodule is ignored.
    git(
      repo,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${git(repo, "rev-parse", "HEAD")},vendor/sub`,
    );
    put(repo, "src/a", "one edited\n");
    put(repo, "vendor/sub/new.txt", "inside the link\n");
    const before = userBytes(repo);

    await expect(snapshotTree(repo)).rejects.toThrow(/vendor\/sub\/new\.txt/);
    const capture = await captureWorkingTreeTransient(repo, "HEAD", [], { projectRoot: repo });

    expect(userBytes(repo)).toEqual(before);
    expect(capture.captureIncomplete).toBe(true);
    expect(capture.captureFailure?.message).toContain("vendor/sub/new.txt");
  });

  // `check-ignore` reads a leading `:` as pathspec magic, and refuses some of it outright.
  describe.skipIf(process.platform === "win32")("a name that starts with a colon", () => {
    it.each([
      [":!odd.py", false],
      [":!odd.log", true],
    ])(
      "is only a name: %s, ignored by the root .gitignore outside the patterns: %s",
      async (name, ignored) => {
        const repo = sparseRepo("non-cone", { ".gitignore": "*.log\n" }, ["--no-cone", "/src/"]);
        put(repo, "src/a", "one edited\n");
        put(repo, name, "print(1)\n");
        const before = userBytes(repo);

        const capture = await captureWorkingTreeTransient(repo, "HEAD", [], { projectRoot: repo });

        expect(userBytes(repo)).toEqual(before);
        if (ignored) {
          expect(capture.captureIncomplete).toBe(true);
          expect(capture.captureFailure?.message).toContain(name);
        } else {
          expect(capture.captureIncomplete).toBe(false);
          const tree = capture.result!.candidate_tree;
          expect(changes(repo, "HEAD", tree)).toEqual([`A\t${name}`, "M\tsrc/a"]);
          expect(tree).toBe(git(repo, "rev-parse", `${await snapshotTree(repo)}^{tree}`));
        }
      },
    );
  });

  it("are not taken when the root .gitignore, outside a non-cone checkout's patterns, ignores them", async () => {
    const repo = sparseRepo("non-cone", { ".gitignore": ".env\n" }, ["--no-cone", "/src/"]);
    expect(existsSync(join(repo, ".gitignore"))).toBe(false);
    put(repo, "src/a", "one edited\n");
    put(repo, "tests/.env", "SECRET=1\n");
    expect(git(repo, "status", "--porcelain", "--untracked-files=all", "--ignored")).toBe(
      "M src/a\n!! tests/.env",
    );
    const before = userBytes(repo);

    await expect(snapshotTree(repo)).rejects.toThrow(/tests\/\.env/);
    const capture = await captureWorkingTreeTransient(repo, "HEAD", [], { projectRoot: repo });

    expect(userBytes(repo)).toEqual(before);
    expect(capture.captureIncomplete).toBe(true);
    expect(capture.captureFailure?.message).toContain("tests/.env");
  });

  it("are taken only within the capture's own directory", async () => {
    const repo = sparseRepo();
    git(repo, "sparse-checkout", "set", "--no-cone", "/src/a");
    put(repo, "src/a", "one edited\n");
    put(repo, "src/new.py", "print(1)\r\n");
    put(repo, "tests/new_test.py", "print(1)\r\n");

    const tree = await captured(repo, "HEAD", [], join(repo, "src"));

    expect(changes(repo, "HEAD", tree)).toEqual(["M\tsrc/a", "A\tsrc/new.py"]);
  });
});

// Each of these answers the same without the #734 step: it changes none of them.
describe("what a sparse checkout's capture did before stays (#734 controls)", () => {
  const EDIT = ["M\tsrc/a"];

  it("an ignored file outside the patterns stays out, and alone it is no change", async () => {
    const repo = sparseRepo();
    put(repo, "tests/cache.tmp", "noise\n");
    expect(await snapshotTree(repo)).toBe(git(repo, "rev-parse", "HEAD"));

    put(repo, "src/a", "one edited\n");
    expect(changes(repo, "HEAD", await snapshotTree(repo))).toEqual(EDIT);
    expect(changes(repo, "HEAD", await captured(repo, "HEAD"))).toEqual(EDIT);
  });

  it("a file only a .gitignore outside the patterns ignores is not taken: the capture still refuses", async () => {
    const repo = sparseRepo();
    put(repo, "src/a", "one edited\n");
    put(repo, "other/debug.log", "noise\n");
    // The user's Git reads other/.gitignore from its index; a scratch index cannot.
    expect(git(repo, "status", "--porcelain", "--untracked-files=all")).toBe("M src/a");

    await expect(snapshotTree(repo)).rejects.toThrow(/other\/debug\.log/);
    const capture = await captureWorkingTreeTransient(repo, "HEAD", [], { projectRoot: repo });
    expect(capture.captureIncomplete).toBe(true);
    expect(capture.captureFailure?.message).toContain("other/debug.log");
  });

  it("a tracked file outside the patterns keeps the base's blob, absent or restored and edited", async () => {
    const repo = sparseRepo();
    put(repo, "src/a", "one edited\n");
    put(repo, "other/b", "two edited\n");

    expect(changes(repo, "HEAD", await snapshotTree(repo))).toEqual(EDIT);
    expect(changes(repo, "HEAD", await captured(repo, "HEAD"))).toEqual(EDIT);
  });

  it("a new file below a path the base holds as a file replaces nothing: the capture refuses", async () => {
    const repo = sparseRepo();
    put(repo, "other/b/inner.txt", "new\n");

    await expect(snapshotTree(repo)).rejects.toThrow(/other\/b\/inner\.txt/);
    const capture = await captureWorkingTreeTransient(repo, "HEAD", [], { projectRoot: repo });
    expect(capture.captureIncomplete).toBe(true);
  });

  it("an undeclared repository outside the patterns stays out, named", async () => {
    const repo = sparseRepo();
    put(repo, "src/a", "one edited\n");
    mkdirSync(join(repo, "vendor/copy"), { recursive: true });
    git(join(repo, "vendor/copy"), "init", "-q");

    const capture = await captureWorkingTreeTransient(repo, "HEAD", [], { projectRoot: repo });

    expect(capture.captureIncomplete).toBe(false);
    expect(capture.excludedNestedRepositories).toEqual(["vendor/copy"]);
    expect(changes(repo, "HEAD", capture.result!.candidate_tree)).toEqual(EDIT);
  });
});

// Names reach Git and come back as its own C-quoted lines: the one text form that
// carries a byte that is not UTF-8 (decoded, such a byte is U+FFFD, another file's name).
describe("names as Git's quoted lines (#734)", () => {
  it("keep every byte, to Git and back", () => {
    const repo = sparseRepo("non-cone");
    git(repo, "sparse-checkout", "set", "--no-cone", "/*");
    // Each byte a name can hold, at its start and at its end (`/` and NUL cannot be in one).
    // No file is made from them: `check-rules` only matches the text, so a byte Windows
    // reserves in file names (`\`, `:`, `"`) is plain text here, as on every other system.
    const names = Array.from({ length: 255 }, (_, at) => String.fromCharCode(at + 1))
      .filter((byte) => byte !== "/")
      .map((byte) => `${byte}mid${byte}`);

    // Every name is inside the patterns here, so `check-rules` prints each one back.
    const echoed = execFileSync(
      "git",
      ["-C", repo, ...QUOTED_NAMES, "sparse-checkout", "check-rules"],
      { env: ENV, input: quotedNames(names) },
    ).toString("utf8");

    expect(listedNames('plain name\n"a\\377\\tb\\\\\\""\n')).toEqual(["plain name", 'a\xff\tb\\"']);
    expect(listedNames(echoed)).toEqual(names);
  });

  it("are text only where their bytes are UTF-8: a real U+FFFD and a leading U+FEFF are, a stray byte is not", () => {
    expect(nameText("tests/\xd1\x82\xd0\xb5\xd1\x81\xd1\x82.py")).toBe("tests/тест.py");
    expect(nameText("\xef\xbb\xbfbom \xef\xbf\xbd.py")).toBe("\uFEFFbom \uFFFD.py");
    expect(nameText("other/\xff.py")).toBeNull();
    expect(nameText("cut \xd1")).toBeNull();
  });
});

// A capture's base is a commit the caller chose earlier; HEAD may be anywhere by now.
// What a dirty base took in is what it added to its own boundary commit, never to HEAD.
describe("a capture against an earlier base, wherever HEAD is by now (#734)", () => {
  it("still succeeds, following the base's own files, on a branch with no commit yet", async () => {
    const repo = sparseRepo();
    work(repo);
    const base = await snapshotTree(repo);
    git(repo, "checkout", "-q", "--orphan", "fresh");
    put(repo, "src/a", "one edited twice\n");
    put(repo, "tests/new_test.py", "print(2)\r\n");
    const before = userBytes(repo);

    const tree = await captured(repo, base);

    expect(userBytes(repo)).toEqual(before);
    expect(changes(repo, base, tree)).toEqual(["M\tsrc/a", "M\ttests/new_test.py"]);
  });

  it.each(["its commit", "a dirty snapshot"] as const)(
    "records no removal of a file the patterns leave out that HEAD dropped since: the base is %s",
    async (kind) => {
      const repo = sparseRepo();
      put(repo, "src/a", "one edited\n");
      const base =
        kind === "its commit" ? git(repo, "rev-parse", "HEAD") : await snapshotTree(repo);
      git(repo, "rm", "-q", "--cached", "--sparse", "other/b");
      git(repo, "commit", "-qm", "drop other/b");
      put(repo, "src/a", "one edited twice\n");
      const before = userBytes(repo);

      const tree = await captured(repo, base);

      expect(userBytes(repo)).toEqual(before);
      expect(changes(repo, base, tree)).toEqual(["M\tsrc/a"]);
      expect(git(repo, "rev-parse", `${tree}:other`)).toBe(git(repo, "rev-parse", `${base}:other`));
    },
  );

  it("still reads a file the base took in after HEAD committed it too", async () => {
    const repo = sparseRepo();
    work(repo);
    const base = await snapshotTree(repo);
    git(repo, "add", "--sparse", "tests/new_test.py");
    git(repo, "commit", "-qm", "keep the test");
    put(repo, "tests/new_test.py", "print(2)\r\n");
    const before = userBytes(repo);

    const tree = await captured(repo, base);

    expect(userBytes(repo)).toEqual(before);
    expect(changes(repo, base, tree)).toEqual(["M\ttests/new_test.py"]);
    expect(blob(repo, tree, "tests/new_test.py").toString()).toBe("print(2)\n");
  });

  it.each([
    ["a directory where the base took in a file", "tests/new_test.py/child"],
    ["a file where the base took in a directory", "tests/pkg"],
  ])("refuses %s: no entry is replaced", async (_, collides) => {
    const repo = sparseRepo();
    put(repo, "tests/new_test.py", "print(1)\n");
    put(repo, "tests/pkg/inner.py", "print(1)\n");
    const base = await snapshotTree(repo);
    rmSync(join(repo, collides.split("/").slice(0, 2).join("/")), { recursive: true });
    put(repo, collides, "print(2)\n");
    const before = userBytes(repo);

    const capture = await captureWorkingTreeTransient(repo, base, [], { projectRoot: repo });

    expect(userBytes(repo)).toEqual(before);
    expect(capture.captureIncomplete).toBe(true);
    expect(capture.captureFailure?.message).toContain(`'${collides}'`);
  });

  it("reads a base's file whose name is not UTF-8 as itself, never as its U+FFFD neighbour", async () => {
    const repo = sparseRepo("cone", { "other/\uFFFD.py": "kept\n" });
    // A dirty base as a snapshot records one, holding other/<FF>.py too: built from
    // objects alone, since no file system here need hold such a name. Neither is on disk.
    const index = {
      ...ENV,
      GIT_INDEX_FILE: join(repo, ".git/base-index"),
      GIT_AUTHOR_NAME: "Claudexor",
      GIT_AUTHOR_EMAIL: "noreply@claudexor.local",
    };
    const run = (args: string[], input?: Buffer) =>
      execFileSync("git", ["-C", repo, ...args], { env: index, input })
        .toString("utf8")
        .trim();
    const name = Buffer.concat([Buffer.from("other/"), Buffer.from([0xff]), Buffer.from(".py")]);
    const content = run(["hash-object", "-w", "--stdin"], Buffer.from("taken in\n"));
    run(["read-tree", "HEAD"]);
    run(
      ["update-index", "-z", "--index-info"],
      Buffer.concat([Buffer.from(`100644 ${content}\t`), name, Buffer.from([0])]),
    );
    const base = run([
      "commit-tree",
      run(["write-tree"]),
      "-p",
      "HEAD",
      "-m",
      "claudexor: dirty worktree snapshot (incl. untracked)",
    ]);
    const before = userBytes(repo);

    const tree = await captured(repo, base);

    expect(userBytes(repo)).toEqual(before);
    const removed = gitBytes(repo, ["diff", "--no-renames", "--name-status", "-z", base, tree]);
    expect(removed.equals(Buffer.concat([Buffer.from("D\0"), name, Buffer.from([0])]))).toBe(true);
    expect(git(repo, "rev-parse", `${tree}:other/\uFFFD.py`)).toBe(
      git(repo, "rev-parse", "HEAD:other/\uFFFD.py"),
    );
  });
});
