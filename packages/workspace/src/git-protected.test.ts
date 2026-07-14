import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyPatchAndIndexProtected,
  applyPatchProtected,
  reversePatchAndIndexProtected,
} from "./git.js";

const PATCH = [
  "diff --git a/a.txt b/a.txt",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1 +1 @@",
  "-one",
  "+two",
  "diff --git a/b.txt b/b.txt",
  "deleted file mode 100644",
  "--- a/b.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-delete me",
  "diff --git a/c.txt b/c.txt",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/c.txt",
  "@@ -0,0 +1 @@",
  "+created",
  "",
].join("\n");

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "claudexor-protected-git-"));
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, "b.txt"), "delete me\n");
  writeFileSync(join(repo, "keep.txt"), "base\n");
  git(repo, ["add", "--", "a.txt", "b.txt", "keep.txt"]);
  git(repo, [
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-q",
    "-m",
    "base",
  ]);
  return repo;
}

describe("preimage-bound protected Git mutation", () => {
  it("reverses only the exact patch postimage and preserves unrelated concurrent edits", async () => {
    const repo = initRepo();
    const applied = await applyPatchAndIndexProtected(repo, PATCH);
    expect(applied.ok).toBe(true);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("two\n");

    // Simulate user work arriving after Claudexor's mutation on paths outside
    // the patch. Compensation must not use status cleanliness as a proxy and
    // must not reset either file.
    writeFileSync(join(repo, "keep.txt"), "concurrent user edit\n");
    writeFileSync(join(repo, "untracked-user.txt"), "preserve me\n");

    const reversed = await reversePatchAndIndexProtected(repo, PATCH);
    expect(reversed.ok).toBe(true);
    expect(reversed.treeMutated).toBe(false);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\n");
    expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("delete me\n");
    expect(() => readFileSync(join(repo, "c.txt"), "utf8")).toThrow();
    expect(readFileSync(join(repo, "keep.txt"), "utf8")).toBe("concurrent user edit\n");
    expect(readFileSync(join(repo, "untracked-user.txt"), "utf8")).toBe("preserve me\n");
    expect(git(repo, ["diff", "--cached", "--name-only"])).toBe("");
  });

  it("refuses reverse compensation when a user changed the patch postimage", async () => {
    const repo = initRepo();
    expect((await applyPatchAndIndexProtected(repo, PATCH)).ok).toBe(true);
    writeFileSync(join(repo, "a.txt"), "user changed the postimage\n");
    writeFileSync(join(repo, "untracked-user.txt"), "preserve me\n");
    const indexBefore = git(repo, ["diff", "--cached", "--binary"]);
    const statusBefore = git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);

    const reversed = await reversePatchAndIndexProtected(repo, PATCH);
    expect(reversed.ok).toBe(false);
    expect(reversed.treeMutated).toBe(true);
    expect(reversed.detail).toContain("reverse apply --check refused");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("user changed the postimage\n");
    expect(readFileSync(join(repo, "untracked-user.txt"), "utf8")).toBe("preserve me\n");
    expect(git(repo, ["diff", "--cached", "--binary"])).toBe(indexBefore);
    expect(git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).toBe(
      statusBefore,
    );
  });

  it("a refused forward apply preserves staged, unstaged, and untracked user state byte-for-byte", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "keep.txt"), "staged user edit\n");
    git(repo, ["add", "--", "keep.txt"]);
    writeFileSync(join(repo, "a.txt"), "unstaged conflicting user edit\n");
    writeFileSync(join(repo, "untracked-user.txt"), "preserve me\n");
    const indexBefore = git(repo, ["write-tree"]).trim();
    const statusBefore = git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);

    const applied = await applyPatchProtected(repo, PATCH);
    expect(applied.ok).toBe(false);
    expect(applied.treeMutated).toBe(false);
    expect(git(repo, ["write-tree"]).trim()).toBe(indexBefore);
    expect(git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).toBe(
      statusBefore,
    );
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("unstaged conflicting user edit\n");
    expect(readFileSync(join(repo, "keep.txt"), "utf8")).toBe("staged user edit\n");
    expect(readFileSync(join(repo, "untracked-user.txt"), "utf8")).toBe("preserve me\n");
  });
});
