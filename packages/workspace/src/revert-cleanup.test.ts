import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceError, type CaptureResult } from "@claudexor/core";

let intercept: ((args: string[]) => CaptureResult | undefined) | null = null;
let refuseCleanup = true;
const removedScratch: string[] = [];
vi.mock("@claudexor/core", async (original) => {
  const core = await original<typeof import("@claudexor/core")>();
  return {
    ...core,
    runCaptureRaw: async (...args: Parameters<typeof core.runCaptureRaw>) =>
      intercept?.(args[1]) ?? core.runCaptureRaw(...args),
  };
});

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
        removedScratch.push(String(path));
        if (refuseCleanup) throw new Error("revert cleanup sentinel");
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
  intercept = null;
  refuseCleanup = true;
  removedScratch.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

describe("transient Git revert cleanup", () => {
  it.each(["before", "after", "both", "no-index", "neither"])(
    "keeps the failed reverse result and scratch cleanup with %s status observation",
    async (unavailable) => {
      const repo = initRepo();
      writeFileSync(join(repo, "README.md"), "candidate\n");
      const patch = execFileSync("git", ["-C", repo, "diff", "--binary"], { encoding: "utf8" });
      let reads = 0;
      let applies = 0;
      intercept = (args) => {
        if (args[1] !== repo) return;
        if (args.includes("status")) {
          reads++;
          if (
            unavailable === "both" ||
            (unavailable === "before" && reads === 1) ||
            (unavailable === "after" && reads === 2)
          )
            return {
              code: reads === 1 ? 128 : null,
              signal: null,
              stdout: "",
              stderr: "status unavailable",
            };
        }
        if (args.includes("apply") && !args.includes("--check")) {
          applies++;
          return { code: 1, signal: null, stdout: "", stderr: "reverse sentinel" };
        }
      };
      const result = await revertWorkingTreePatch(repo, patch, {
        isolateObjectWrites: true,
        noIndex: unavailable === "no-index",
      });
      expect(result).toMatchObject({
        reverted: false,
        removed: [],
        reasonCode: "reverse_apply_failed",
        cleanupError: "revert cleanup sentinel",
      });
      expect(result.reason).toContain("reverse sentinel");
      if (unavailable === "neither") expect(result.reason).toContain("observed pre-revert state");
      else {
        expect(result.reason).toContain("target state is unknown");
        expect(result.reason).not.toMatch(/remains at|target changed/);
      }
      expect(reads).toBe(unavailable === "no-index" ? 0 : 2);
      expect(applies).toBe(1);
      expect(removedScratch).toHaveLength(1);
      expect(existsSync(removedScratch[0]!)).toBe(false);
      expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("candidate\n");
    },
  );

  it("exact reverse succeeds and cleans its scratch when diagnostic status throws", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "README.md"), "candidate\n");
    const patch = execFileSync("git", ["-C", repo, "diff", "--binary"], { encoding: "utf8" });
    refuseCleanup = false;
    let reads = 0;
    intercept = (args) => {
      if (args[1] === repo && args.includes("status")) {
        reads++;
        throw new Error("status transport failed");
      }
    };
    expect(await revertWorkingTreePatch(repo, patch, { isolateObjectWrites: true })).toEqual({
      reverted: true,
      removed: [],
    });
    expect(reads).toBe(1);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("base\n");
    expect(removedScratch).toHaveLength(1);
    expect(existsSync(removedScratch[0]!)).toBe(false);
  });

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
