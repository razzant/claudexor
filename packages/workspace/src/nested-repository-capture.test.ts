import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { captureWorkingTreeTransient, stashCreate } from "./git.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];

function repository(): { root: string; git: (cwd: string, ...args: string[]) => void } {
  const root = mkdtempSync(join(tmpdir(), "cx-nested-capture-"));
  roots.push(root);
  const git = (cwd: string, ...args: string[]) => {
    execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
  };
  git(root, "init", "-q");
  writeFileSync(join(root, "tracked.txt"), "base\n");
  git(root, "add", "tracked.txt");
  git(root, ...identity, "commit", "-qm", "base");
  return { root, git };
}

it("captures the rest of the candidate when untracked folders hold their own repositories", async () => {
  const { root, git } = repository();
  // A repository without a commit makes `git add` refuse outright; one with a
  // commit would become a commit link the patch cannot carry. Both stay out.
  const empty = join(root, ".review-evidence", "no commit yet");
  mkdirSync(empty, { recursive: true });
  git(empty, "init", "-q");
  writeFileSync(join(empty, "probe.txt"), "inside an empty repository\n");
  const committed = join(root, ".review-evidence", "base-copy");
  mkdirSync(committed, { recursive: true });
  git(committed, "init", "-q");
  writeFileSync(join(committed, "copy.txt"), "inside a committed repository\n");
  git(committed, "add", "copy.txt");
  git(committed, ...identity, "commit", "-qm", "copy");
  writeFileSync(join(root, "tracked.txt"), "base\nchanged\n");
  writeFileSync(join(root, "new.txt"), "new file\n");

  const captured = await captureWorkingTreeTransient(root, "HEAD");

  expect(captured.captureIncomplete).toBe(false);
  expect(captured.patch).toContain("+changed");
  expect(captured.patch).toContain("b/new.txt");
  expect(captured.patch).not.toContain(".review-evidence");
  expect(captured.patch).not.toContain("Subproject commit");
  expect(captured.excludedNestedRepositories).toEqual([
    ".review-evidence/base-copy",
    ".review-evidence/no commit yet",
  ]);
});

it("names nothing and keeps every untracked file when no nested repository exists", async () => {
  const { root } = repository();
  mkdirSync(join(root, ".review-evidence", "notes"), { recursive: true });
  writeFileSync(join(root, ".review-evidence", "notes", "log.txt"), "plain evidence\n");

  const captured = await captureWorkingTreeTransient(root, "HEAD");

  expect(captured.captureIncomplete).toBe(false);
  expect(captured.patch).toContain("b/.review-evidence/notes/log.txt");
  expect(captured.excludedNestedRepositories).toBeUndefined();
});

it("keeps a submodule the candidate declares as its commit link", async () => {
  const { root, git } = repository();
  // `git submodule add` clones the repository and declares it in .gitmodules.
  git(
    root,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "-q",
    library(),
    "modules/library",
  );
  const undeclared = join(root, ".review-evidence", "copy");
  mkdirSync(undeclared, { recursive: true });
  git(undeclared, "init", "-q");

  const captured = await captureWorkingTreeTransient(root, "HEAD");

  expect(captured.captureIncomplete).toBe(false);
  expect(captured.patch).toContain("b/.gitmodules");
  expect(captured.patch).toContain("b/modules/library");
  expect(captured.patch).toContain("Subproject commit");
  expect(captured.excludedNestedRepositories).toEqual([".review-evidence/copy"]);
});

function library(): string {
  const root = mkdtempSync(join(tmpdir(), "cx-nested-library-"));
  roots.push(root);
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  run("init", "-q");
  writeFileSync(join(root, "lib.txt"), "library\n");
  run("add", "lib.txt");
  run(...identity, "commit", "-qm", "library");
  return root;
}

function nestedRepository(
  path: string,
  git: (cwd: string, ...args: string[]) => void,
  commit: boolean,
) {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q");
  writeFileSync(join(path, "inside.txt"), "inside a nested repository\n");
  if (!commit) return;
  git(path, "add", "inside.txt");
  git(path, ...identity, "commit", "-qm", "nested");
}

it("names top-relative paths and still captures when the project root is a subdirectory", async () => {
  const { root, git } = repository();
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "file.txt"), "base\n");
  git(root, "add", "sub/file.txt");
  git(root, ...identity, "commit", "-qm", "sub");
  writeFileSync(join(root, "sub", "file.txt"), "base\nedited\n");
  nestedRepository(join(root, "sub", "clone"), git, true);
  nestedRepository(join(root, "sub", "scratch"), git, false);
  // A declared submodule under the subdirectory stays a commit link, though
  // its .gitmodules lives at the worktree top, outside the capture root.
  git(
    root,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "-q",
    library(),
    "sub/vendor/lib",
  );

  const captured = await captureWorkingTreeTransient(join(root, "sub"), "HEAD");

  expect(captured.captureIncomplete).toBe(false);
  expect(captured.patch).toContain("+edited");
  expect(captured.patch).not.toContain("sub/clone");
  expect(captured.patch).not.toContain("sub/scratch");
  expect(captured.patch).toContain("b/sub/vendor/lib");
  expect(captured.excludedNestedRepositories).toEqual(["sub/clone", "sub/scratch"]);
});

it("excludes a nested repository by its literal name, never as a glob over its siblings", async () => {
  const { root, git } = repository();
  nestedRepository(join(root, "ev", "[ab]"), git, true);
  mkdirSync(join(root, "ev"), { recursive: true });
  writeFileSync(join(root, "ev", "b"), "a sibling the glob [ab] would match\n");

  const captured = await captureWorkingTreeTransient(root, "HEAD");

  expect(captured.captureIncomplete).toBe(false);
  expect(captured.patch).toContain("b/ev/b");
  expect(captured.excludedNestedRepositories).toEqual(["ev/[ab]"]);
});

it("snapshots a dirty tree without its undeclared nested repositories", async () => {
  const { root, git } = repository();
  writeFileSync(join(root, "tracked.txt"), "base\nchanged\n");
  // Left by an earlier in-place turn: without a commit `add -A` refuses it,
  // with one it would freeze into the next turn's base as a commit link.
  nestedRepository(join(root, "scratch-repo"), git, false);
  nestedRepository(join(root, "ref", "clone"), git, true);
  git(
    root,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "-q",
    library(),
    "modules/library",
  );

  const snapshot = await stashCreate(root);

  expect(snapshot).not.toBeNull();
  const names = execFileSync("git", ["-C", root, "ls-tree", "-r", "--name-only", snapshot ?? ""], {
    encoding: "utf8",
  }).split("\n");
  expect(names).toEqual(expect.arrayContaining(["tracked.txt", ".gitmodules", "modules/library"]));
  expect(
    names.filter((name) => name.startsWith("scratch-repo") || name.startsWith("ref/")),
  ).toEqual([]);
});

it("reads .gitmodules whatever the worktree path is spelled like", async () => {
  // A trailing space is a legal path byte; the declared submodule must still be found.
  const parent = mkdtempSync(join(tmpdir(), "cx-nested-spelling-"));
  roots.push(parent);
  const root = join(parent, "project ");
  mkdirSync(root);
  const git = (cwd: string, ...args: string[]) => {
    execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
  };
  git(root, "init", "-q");
  writeFileSync(join(root, "tracked.txt"), "base\n");
  git(root, "add", "tracked.txt");
  git(root, ...identity, "commit", "-qm", "base");
  mkdirSync(join(root, "sub"));
  git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", library(), "sub/library");

  const captured = await captureWorkingTreeTransient(join(root, "sub"), "HEAD");

  expect(captured.captureIncomplete).toBe(false);
  expect(captured.patch).toContain("b/sub/library");
  expect(captured.excludedNestedRepositories).toBeUndefined();
});
