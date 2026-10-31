import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReviewerCandidateInventory, prepareReviewerWorkspace } from "./reviewerWorkspace.js";

// A reviewer workspace's Git baseline (`git add -A --force`, then `git commit`) is
// Claudexor's own repository over the copied files: nothing in the user's Git
// configuration decides it. git-lfs set up for the user (`git lfs install` writes
// `filter.lfs.*` into ~/.gitconfig) ran its clean filter while review was prepared (A),
// committed a pointer where the reviewer reads the stored blob (B), and, once it could
// not run, kept the review from starting (C).
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The test's own Git: no configuration of the user's or the system's. */
const OWN_GIT = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

const POINTER = "version https://git-lfs.github.com/spec/v1\n";
const CONTENT = "the real large content\n";
const LFS_ATTRIBUTES = "*.bin filter=lfs\n";

/** One case's directory, and the log where a program the user configured records each run. */
function scratch() {
  const base = mkdtempSync(join(tmpdir(), "cx-reviewer-baseline-"));
  dirs.push(base);
  const log = join(base, "ran.log");
  return { base, log, ran: () => (existsSync(log) ? readFileSync(log, "utf8") : "") };
}

/** The user's Git, in a home of the test's own: `config` in ~/.gitconfig, `attributes` in
 * Git's default attributes file ($XDG_CONFIG_HOME/git/attributes). */
function userGit(base: string, config: Record<string, string>, attributes?: string) {
  const home = join(base, "home");
  mkdirSync(join(home, ".config", "git"), { recursive: true });
  for (const [key, value] of Object.entries(config))
    execFileSync("git", ["config", "--file", join(home, ".gitconfig"), key, value], {
      env: OWN_GIT,
    });
  if (attributes !== undefined)
    writeFileSync(join(home, ".config", "git", "attributes"), attributes);
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
}

/** git-lfs as the user has it: a required clean filter that records each run and stores a pointer. */
const lfs = (log: string) => ({
  "filter.lfs.clean": `cat >/dev/null; echo clean %f >> '${log}'; echo '${POINTER.trim()}'`,
  "filter.lfs.required": "true",
});

/** An executable that records each run in `log` and fails. */
function recorder(dir: string, name: string, log: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> '${log}'\nexit 1\n`, { mode: 0o755 });
  return path;
}

/** A reviewer workspace over a saved copy holding `files` (#535): what the reviewer reads of
 * a path, and what the baseline commit holds of it. */
async function prepared(base: string, files: Record<string, string>) {
  const source = join(base, "saved");
  mkdirSync(source);
  for (const [path, content] of Object.entries(files)) writeFileSync(join(source, path), content);
  mkdirSync(join(base, "evidence"));
  const paths = Object.keys(files);
  const inventory = await buildReviewerCandidateInventory(source, new Set(), false, paths);
  const workspace = await prepareReviewerWorkspace({
    sourceRoot: source,
    sourceEvidenceDir: join(base, "evidence"),
    workspaceBaseDir: join(base, "reviewers"),
    reviewerDirName: "01-reviewer",
    excludeRoots: [],
    candidateCopyPaths: inventory.copyPaths,
    candidatePaths: paths,
    savedCopy: { unavailable: [] },
  });
  return {
    read: (path: string) => readFileSync(join(workspace.root, path), "utf8"),
    committed: (path: string) =>
      execFileSync("git", ["-C", workspace.root, "cat-file", "blob", `HEAD:${path}`], {
        env: OWN_GIT,
        encoding: "utf8",
      }),
  };
}

describe("a reviewer workspace's Git baseline holds the copied bytes, whatever the user's Git configuration says", () => {
  it("runs no filter the user configured over a stored LFS pointer (A)", async () => {
    const { base, log, ran } = scratch();
    userGit(base, lfs(log));

    const reviewer = await prepared(base, { ".gitattributes": LFS_ATTRIBUTES, "big.bin": POINTER });

    expect(ran()).toBe("");
    expect(reviewer.read("big.bin")).toBe(POINTER);
    expect(reviewer.committed("big.bin")).toBe(POINTER);
  });

  it("commits the stored blob the reviewer reads, never what the user's filter would store (B)", async () => {
    const { base, log } = scratch();
    userGit(base, lfs(log));

    const reviewer = await prepared(base, { ".gitattributes": LFS_ATTRIBUTES, "big.bin": CONTENT });

    expect(reviewer.read("big.bin")).toBe(CONTENT);
    expect(reviewer.committed("big.bin")).toBe(CONTENT);
  });

  it("starts when a required filter the user configured cannot run (C)", async () => {
    const { base } = scratch();
    // The required `process` filter `git lfs install` writes, once git-lfs is no longer
    // on the PATH (a named command that cannot exist, whatever this machine has).
    userGit(base, {
      "filter.lfs.process": "claudexor-test-no-git-lfs filter-process",
      "filter.lfs.required": "true",
    });

    const reviewer = await prepared(base, { ".gitattributes": LFS_ATTRIBUTES, "big.bin": CONTENT });

    expect(reviewer.read("big.bin")).toBe(CONTENT);
    expect(reviewer.committed("big.bin")).toBe(CONTENT);
  });

  // Shell scripts as configured programs are a POSIX fixture.
  it.skipIf(process.platform === "win32")(
    "runs no hook, monitor or signing program the user configured",
    async () => {
      const { base, log, ran } = scratch();
      const hooks = join(base, "hooks");
      const template = join(base, "template");
      for (const hook of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]) {
        recorder(hooks, hook, log);
        recorder(join(template, "hooks"), hook, log);
      }
      recorder(hooks, "post-index-change", log);
      userGit(base, {
        "core.fsmonitor": recorder(join(base, "bin"), "fsmonitor", log),
        "core.hooksPath": hooks,
        "init.templateDir": template,
        "commit.gpgSign": "true",
        "gpg.program": recorder(join(base, "bin"), "gpg", log),
      });

      const reviewer = await prepared(base, { "a.txt": "a\n" });

      expect(ran()).toBe("");
      expect(reviewer.committed("a.txt")).toBe("a\n");
    },
  );

  it("keeps the copied line endings whatever the user's attributes file says", async () => {
    const { base } = scratch();
    userGit(base, {}, "* text=auto\n");

    const reviewer = await prepared(base, { "crlf.txt": "one\r\ntwo\r\n" });

    expect(reviewer.read("crlf.txt")).toBe("one\r\ntwo\r\n");
    expect(reviewer.committed("crlf.txt")).toBe("one\r\ntwo\r\n");
  });

  it("starts, keeping the copied line endings, whatever the user's line-ending settings say", async () => {
    const { base } = scratch();
    // `core.safecrlf` refuses a conversion `core.autocrlf` could not reverse.
    userGit(base, { "core.autocrlf": "input", "core.safecrlf": "true" });

    const reviewer = await prepared(base, { "crlf.txt": "one\r\ntwo\r\n" });

    expect(reviewer.read("crlf.txt")).toBe("one\r\ntwo\r\n");
    expect(reviewer.committed("crlf.txt")).toBe("one\r\ntwo\r\n");
  });
});
