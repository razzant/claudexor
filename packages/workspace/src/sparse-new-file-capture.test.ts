import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureWorkingTreeTransient, snapshotTree } from "./git.js";
import { decodeNulNames } from "./git-snapshot.js";
import { GitOperationError } from "./git-observed.js";
import { objectStorePath } from "./object-store.js";

// #734: a sparse checkout of src/ where the work also creates files outside the patterns.
// `git add -A` refuses such a new file (exit 1), and `add -A --sparse` would record every
// omitted tracked file as a deletion. Both captures must hold the new file exactly as a
// full checkout's native `git add -A` does, staged in the user's index or not.

const dirs: string[] = [];
afterEach(() => {
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
  // Fixed dates: the same fixture is the same commit and trees on every run.
  GIT_AUTHOR_DATE: "2026-11-21T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-11-21T00:00:00Z",
};
// A capture's tree is kept in the project object store, never in the user's repository.
const gitBytes = (
  repo: string,
  args: string[],
  env: Record<string, string | undefined> = {},
  cwd = repo, // a directory below `repo`: the objects are still `repo`'s project store
) =>
  execFileSync("git", ["-C", cwd, ...args], {
    env: {
      ...ENV,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(objectStorePath(repo), "objects"),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
const git = (repo: string, ...args: string[]) => gitBytes(repo, args).toString("utf8").trim();

function put(repo: string, path: string, content: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

/** The same commit twice: `sparse` checks out only src/ (the root's own files stay), the
 * other is the conventional full checkout. The root ignores *.txt and *.pyc is ignored, and
 * a tracked tests/.gitignore allows *.txt again: omitted by the sparse checkout, absent from
 * its disk, and still Git's rule for tests/. */
function repository(sparse: boolean, patterns = ["--cone", "src"]): string {
  const repo = mkdtempSync(join(tmpdir(), "cx-sparse-new-file-"));
  dirs.push(repo);
  git(repo, "init", "-q", "-b", "main");
  // #734 Windows CI: the runner's global Git config sets core.autocrlf=true, and the
  // product's collectors inherit that environment while the native-tree helper above is
  // isolated by GIT_CONFIG_NOSYSTEM/GIT_CONFIG_GLOBAL. Record the same line-ending rule
  // in each synthetic repository, so both read one config and stage/commit one byte form.
  git(repo, "config", "core.autocrlf", "false");
  put(repo, "src/a", "one\n");
  put(repo, "other/b", "two\n");
  put(repo, ".gitignore", "*.txt\n");
  put(repo, "tests/.gitignore", "!*.txt\n*.pyc\n");
  put(repo, "tests/old.py", "old\n");
  put(repo, "src/vendor/.gitignore", "!*.txt\n*.pyc\n");
  put(repo, "src/vendor/old.py", "old\n");
  git(repo, "add", "-A", "-f");
  git(repo, "commit", "-qm", "base");
  if (sparse) {
    git(repo, "sparse-checkout", "set", ...patterns);
    expect(() => readFileSync(join(repo, "other/b"))).toThrow();
    expect(() => readFileSync(join(repo, "tests/.gitignore"))).toThrow();
  }
  return repo;
}

/** An edit inside the patterns; outside them a new test, a text file only the omitted
 * tests/.gitignore keeps, and a file only it ignores. Returns the new test's working bytes. */
function work(repo: string, staged: boolean): string {
  put(repo, "src/a", "one edited\n");
  put(repo, "tests/notes.txt", "notes\n");
  put(repo, "tests/cache.pyc", "ignored\n");
  put(repo, "tests/new_test.py", "print(1)\n");
  if (staged) git(repo, "add", "--sparse", "tests/new_test.py", "tests/notes.txt");
  // After staging, so the staged bytes differ from the bytes that must be captured.
  put(repo, "tests/new_test.py", "print(2)\r\n");
  return "print(2)\r\n";
}

/** What native Git's own `add -A` records for the full checkout, as a tree id. */
function nativeTree(repo: string, base: string, cwd = repo, scope: string[] = []): string {
  const index = join(repo, ".git", "native-index");
  const env = { GIT_INDEX_FILE: index };
  gitBytes(repo, ["read-tree", base], env, cwd);
  gitBytes(repo, ["add", "-A", ...scope], env, cwd);
  return gitBytes(repo, ["write-tree"], env, cwd).toString("utf8").trim();
}

const names = (repo: string, base: string, tree: string) =>
  git(repo, "diff", "--no-renames", "--name-status", base, tree).split("\n").filter(Boolean);
const NEW_FILES = ["M\tsrc/a", "A\ttests/new_test.py", "A\ttests/notes.txt"];

async function capture(repo: string, excludes: string[] = [], cwd = repo) {
  const captured = await captureWorkingTreeTransient(cwd, "HEAD", excludes, { projectRoot: repo });
  if (captured.captureIncomplete) throw captured.captureFailure;
  return captured;
}

async function transient(repo: string, excludes: string[] = [], cwd = repo) {
  return (await capture(repo, excludes, cwd)).result!.candidate_tree;
}

async function snapshot(repo: string, cwd = repo): Promise<string> {
  return git(repo, "rev-parse", `${await snapshotTree(cwd)}^{tree}`);
}

describe("new files outside the sparse-checkout patterns (#734)", () => {
  it.each(["unstaged", "staged"] as const)(
    "both captures hold the new files of a sparse checkout as native Git does, %s",
    async (state) => {
      const full = repository(false);
      work(full, state === "staged");
      const sparse = repository(true);
      const bytes = work(sparse, state === "staged");
      const userBefore = {
        index: readFileSync(join(sparse, ".git/index")),
        patterns: readFileSync(join(sparse, ".git/info/sparse-checkout")),
      };
      const native = nativeTree(full, "HEAD");
      // Staged, the user's index holds the first bytes, not the ones that must be captured.
      if (state === "staged")
        expect(gitBytes(sparse, ["show", ":tests/new_test.py"]).toString()).toBe("print(1)\n");

      // The conventional full checkout is the control: its captures are native Git's tree.
      expect(await transient(full)).toBe(native);
      expect(await snapshot(full)).toBe(native);

      const candidate = await transient(sparse);
      const dirty = await snapshot(sparse);

      // M src/a plus the two new files; no deletion of the omitted tracked files.
      expect(names(sparse, "HEAD", candidate)).toEqual(NEW_FILES);
      expect(names(sparse, "HEAD", dirty)).toEqual(NEW_FILES);
      expect(candidate).toBe(native);
      expect(dirty).toBe(native);
      for (const tree of [candidate, dirty]) {
        expect(gitBytes(sparse, ["cat-file", "blob", `${tree}:tests/new_test.py`]).toString()).toBe(
          bytes,
        );
        expect(git(sparse, "cat-file", "blob", `${tree}:other/b`)).toBe("two");
        expect(git(sparse, "cat-file", "blob", `${tree}:tests/old.py`)).toBe("old");
      }
      // The user's index and sparse-checkout specification are never written.
      const userAfter = {
        index: readFileSync(join(sparse, ".git/index")),
        patterns: readFileSync(join(sparse, ".git/info/sparse-checkout")),
      };
      expect(userAfter.index.equals(userBefore.index)).toBe(true);
      expect(userAfter.patterns.equals(userBefore.patterns)).toBe(true);
    },
  );

  it("keeps a staged new file even when a new ignore rule matches it (#734)", async () => {
    const sparse = repository(true);
    const bytes = work(sparse, true); // stages tests/new_test.py, then rewrites its bytes
    // A rule added to the root .gitignore after staging now matches the new test:
    // untracked it would be ignored, but real Git still reports the staged file.
    put(sparse, ".gitignore", "*.txt\nnew_test.py\n");
    expect(git(sparse, "status", "--porcelain", "--", "tests/new_test.py")).toBe(
      "AM tests/new_test.py",
    );
    const indexBefore = readFileSync(join(sparse, ".git/index"));

    const candidate = await transient(sparse);
    const dirty = await snapshot(sparse);

    const changed = ["M\t.gitignore", "M\tsrc/a", "A\ttests/new_test.py", "A\ttests/notes.txt"];
    expect(names(sparse, "HEAD", candidate)).toEqual(changed);
    expect(names(sparse, "HEAD", dirty)).toEqual(changed);
    for (const tree of [candidate, dirty]) {
      expect(gitBytes(sparse, ["cat-file", "blob", `${tree}:tests/new_test.py`]).toString()).toBe(
        bytes,
      );
    }
    expect(readFileSync(join(sparse, ".git/index")).equals(indexBefore)).toBe(true);
  });

  it("leaves the caller's excluded evidence out of the capture", async () => {
    const sparse = repository(true);
    work(sparse, false);
    put(sparse, ".review-evidence/check.txt", "evidence\n");
    put(sparse, ".review-evidence/check.log", "evidence\n");

    const captured = await capture(sparse, [":(exclude,top).review-evidence"]);

    expect(names(sparse, "HEAD", captured.result!.candidate_tree)).toEqual(NEW_FILES);
    expect(captured.patch).toContain("b/tests/new_test.py");
    expect(captured.patch).not.toContain(".review-evidence");
  });

  it.each(["unstaged", "staged"] as const)(
    "keeps each collector's scope from a subdirectory of a sparse checkout, %s",
    async (state) => {
      // Non-cone patterns leave src/vendor out, though src itself is checked out.
      const patterns = ["--no-cone", "/.gitignore", "/src/", "!/src/vendor/"];
      const build = (sparse: boolean) => {
        const repo = repository(sparse, patterns);
        put(repo, "src/a", "one edited\n");
        put(repo, "src/vendor/notes.txt", "notes\n");
        put(repo, "src/vendor/cache.pyc", "ignored\n");
        put(repo, "src/vendor/new_test.py", "print(1)\n");
        put(repo, "tests/sibling.py", "sibling\n");
        if (state === "staged")
          git(
            repo,
            "add",
            "--sparse",
            "src/vendor/new_test.py",
            "src/vendor/notes.txt",
            "tests/sibling.py",
          );
        put(repo, "src/vendor/new_test.py", "print(2)\r\n");
        return repo;
      };
      const full = build(false);
      const sparse = build(true);
      expect(() => readFileSync(join(sparse, "src/vendor/old.py"))).toThrow();
      const [fullDir, sparseDir] = [join(full, "src"), join(sparse, "src")];
      // Native Git from the same directory: the candidate capture's `add -A -- .` is the
      // directory's scope, the snapshot's bare `add -A` the whole tree's.
      const nativeHere = nativeTree(full, "HEAD", fullDir, ["--", "."]);
      const nativeAll = nativeTree(full, "HEAD", fullDir);

      expect(await transient(full, [], fullDir)).toBe(nativeHere);
      expect(await snapshot(full, fullDir)).toBe(nativeAll);
      const candidate = await transient(sparse, [], sparseDir);
      const dirty = await snapshot(sparse, sparseDir);

      // The sibling outside the directory stays out of the candidate capture only.
      const here = ["M\tsrc/a", "A\tsrc/vendor/new_test.py", "A\tsrc/vendor/notes.txt"];
      expect(names(sparse, "HEAD", candidate)).toEqual(here);
      expect(names(sparse, "HEAD", dirty)).toEqual([...here, "A\ttests/sibling.py"]);
      expect(candidate).toBe(nativeHere);
      expect(dirty).toBe(nativeAll);
      for (const tree of [candidate, dirty])
        expect(
          gitBytes(sparse, ["cat-file", "blob", `${tree}:src/vendor/new_test.py`]).toString(),
        ).toBe("print(2)\r\n");
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "refuses, naming Git's failure, when a new file cannot be read, instead of dropping it",
    async () => {
      const sparse = repository(true);
      work(sparse, false);
      put(sparse, "tests/locked.py", "locked\n");
      chmodSync(join(sparse, "tests/locked.py"), 0o000);

      const capture = await captureWorkingTreeTransient(sparse, "HEAD", [], {
        projectRoot: sparse,
      });
      await expect(snapshotTree(sparse)).rejects.toThrow();

      expect(capture.captureIncomplete).toBe(true);
      expect(capture.captureFailure).toBeInstanceOf(Error);
      expect(capture.result).toBeUndefined();
    },
  );
});

describe("NUL-delimited Git name listings are decoded byte-faithfully (#734)", () => {
  const listing = (names: string[]) =>
    Buffer.concat(names.flatMap((name) => [Buffer.from(name, "utf8"), Buffer.alloc(1)]));

  it("keeps valid multibyte names exact, including a final name without its NUL", () => {
    expect(decodeNulNames(listing(["src/привет.py", "tests/未テスト.js"]), "ls")).toEqual([
      "src/привет.py",
      "tests/未テスト.js",
    ]);
    expect(
      decodeNulNames(Buffer.concat([listing(["a.txt"]), Buffer.from("тест/b", "utf8")]), "ls"),
    ).toEqual(["a.txt", "тест/b"]);
    expect(decodeNulNames(Buffer.alloc(0), "ls")).toEqual([]);
    expect(decodeNulNames(listing(["", "x"]), "ls")).toEqual(["x"]);
  });

  it("keeps a leading U+FEFF, which is a real character of the name", () => {
    const names = ["\uFEFFa.txt", "dir/\uFEFFb", "\uFEFF\uFEFFc", "\uFEFF"];
    expect(decodeNulNames(listing(names), "ls")).toEqual(names);
    expect(decodeNulNames(Buffer.from("\uFEFFlast", "utf8"), "ls")).toEqual(["\uFEFFlast"]);
  });

  it("refuses, not guesses or omits, a name that is not valid UTF-8", () => {
    // Benign malformed bytes only: an isolated continuation byte, no path text.
    const malformed = Buffer.concat([
      Buffer.from("dir/\u00ff"),
      Buffer.from([0xff]),
      Buffer.alloc(1),
    ]);
    expect(() => decodeNulNames(malformed, "ls-files (new files)")).toThrow(GitOperationError);
    try {
      decodeNulNames(malformed, "ls-files (new files)");
    } catch (error) {
      expect((error as GitOperationError).code).toBe("capture_read_failed");
      expect((error as Error).message).toContain("not valid UTF-8");
    }
    // A valid name before the malformed one is never turned into a silent omission.
    expect(() => decodeNulNames(Buffer.concat([listing(["ok.py"]), malformed]), "ls")).toThrow(
      GitOperationError,
    );
  });
});
