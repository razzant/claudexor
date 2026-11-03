import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      if (String(path).includes("claudexor-transient-diff-")) {
        throw new Error("scratch cleanup sentinel");
      }
    },
  };
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
