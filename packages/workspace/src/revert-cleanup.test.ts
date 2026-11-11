import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceError } from "@claudexor/core";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    rmSync: (
      path: Parameters<typeof actual.rmSync>[0],
      options?: { recursive?: boolean; force?: boolean },
    ) => {
      actual.rmSync(path, options);
      if (String(path).includes("claudexor-transient-revert-")) {
        throw new Error("revert cleanup sentinel");
      }
    },
  };
});

import { revertWorkingTreePatch } from "./revert.js";

const roots: string[] = [];

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "claudexor-revert-cleanup-"));
  roots.push(repo);
  execFileSync("git", ["-C", repo, "init", "-q"]);
  writeFileSync(join(repo, "README.md"), "base\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "base",
  ]);
  return repo;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

describe("transient Git revert cleanup", () => {
  it("marks cleanup-only failure after a successful reverse without denying the rollback", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "README.md"), "candidate\n");
    const patch = execFileSync("git", ["-C", repo, "diff", "--binary"], {
      encoding: "utf8",
    });

    const error = await revertWorkingTreePatch(repo, patch, {
      isolateObjectWrites: true,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkspaceError);
    expect((error as Error).message).toBe("transient revert scratch cleanup failed");
    expect((error as Error & { rollbackReverted?: boolean }).rollbackReverted).toBe(true);
    expect((error as Error & { cleanupError?: Error }).cleanupError?.message).toBe(
      "revert cleanup sentinel",
    );
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("base\n");
  });

  it("preserves a reverse-check refusal and attaches cleanup failure separately", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "README.md"), "candidate\n");
    const patch = execFileSync("git", ["-C", repo, "diff", "--binary"], {
      encoding: "utf8",
    });
    writeFileSync(join(repo, "README.md"), "later user edit\n");

    const result = await revertWorkingTreePatch(repo, patch, { isolateObjectWrites: true });

    expect(result).toMatchObject({
      reverted: false,
      reasonCode: "postimage_diverged",
      cleanupError: "revert cleanup sentinel",
    });
    expect(result.reason).toMatch(/postimage no longer matches/);
  });

  it("preserves the primary typed setup error when scratch cleanup also fails", async () => {
    const missingRepo = join(initRepo(), "missing");
    const error = await revertWorkingTreePatch(
      missingRepo,
      "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n",
      { isolateObjectWrites: true },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkspaceError);
    expect((error as Error).message).toMatch(/could not resolve Git objects/);
    expect((error as Error & { cleanupError?: Error }).cleanupError?.message).toBe(
      "revert cleanup sentinel",
    );
  });

  it("does not call a no-index reverse-check failure concurrent user divergence", async () => {
    const repo = initRepo();
    const result = await revertWorkingTreePatch(
      repo,
      "Binary files a/preview.png and b/preview.png differ\n",
      { noIndex: true },
    );

    expect(result).toMatchObject({ reverted: false, reasonCode: "reverse_apply_failed" });
    expect(result.reason).toMatch(/could not be proven reversible/);
    expect(result.reason).not.toMatch(/later user edits|postimage/);
  });
});
