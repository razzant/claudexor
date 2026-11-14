import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceError } from "@claudexor/core";

// The scratch is removed one entry at a time, its root last (#688): the sentinel
// fails that last removal, after every byte below it is gone.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const rm = async (
    path: Parameters<typeof actual.rm>[0],
    options?: Parameters<typeof actual.rm>[1],
  ) => {
    await actual.rm(path, options);
    if (basename(String(path)).startsWith("claudexor-transient-diff-")) {
      throw new Error("scratch cleanup sentinel");
    }
  };
  return { ...actual, default: { ...actual, rm }, rm };
});

import { captureWorkingTreeTransient } from "./git.js";

const roots: string[] = [];

function initRepo(): { repo: string; base: string } {
  const repo = mkdtempSync(join(tmpdir(), "claudexor-git-cleanup-"));
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
  return {
    repo,
    base: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

describe("transient Git capture cleanup", () => {
  it("preserves the primary typed capture error when scratch cleanup also fails", async () => {
    const { repo } = initRepo();

    const error = await captureWorkingTreeTransient(repo, "not-a-real-base").catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(WorkspaceError);
    expect((error as Error).message).toMatch(/transient diff read-tree failed/);
    expect((error as Error & { cleanupError?: Error }).cleanupError?.message).toBe(
      "scratch cleanup sentinel",
    );
  });

  it("keeps a cleanup-only failure terminal", async () => {
    const { repo, base } = initRepo();

    const error = await captureWorkingTreeTransient(repo, base).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkspaceError);
    expect((error as Error).message).toBe("transient diff scratch cleanup failed");
    expect((error as Error & { cleanupError?: Error }).cleanupError?.message).toBe(
      "scratch cleanup sentinel",
    );
  });
});
