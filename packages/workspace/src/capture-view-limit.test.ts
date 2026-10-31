import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimatePatchViewBytes } from "./capture-objects.js";
import { captureWorkingTreeTransient } from "./git.js";

// The size decision of a patch view, through real Git. The only seam watches
// what each Git child printed: one that printed patch text rendered a view,
// whatever its arguments, so "no render was attempted" is a fact.
const renders: string[][] = [];
vi.mock("@claudexor/core", async (original) => {
  const core = await original<typeof import("@claudexor/core")>();
  return {
    ...core,
    runCaptureRaw: async (...args: Parameters<typeof core.runCaptureRaw>) => {
      const result = await core.runCaptureRaw(...args);
      if (String(result.stdout).includes("diff --git")) renders.push(args[1]);
      return result;
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  renders.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const LARGE = 1024 * 1024;

function repo(): { root: string; git: (...args: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), "cx-view-limit-"));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { maxBuffer: 1 << 26 })
      .toString()
      .trim();
  git("init", "-q");
  git("config", "core.fileMode", "true");
  writeFileSync(join(root, "large.bin"), Buffer.alloc(LARGE, 7));
  git("add", ".");
  git("-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-qm", "base");
  return { root, git };
}

describe("the patch view estimate", () => {
  it("a mode-only change counts its header, not its blob", async () => {
    const { root, git } = repo();
    const before = git("rev-parse", "HEAD");
    chmodSync(join(root, "large.bin"), 0o755);
    git("add", ".");
    git("-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-qm", "chmod");

    const { bytes } = await estimatePatchViewBytes(root, before, git("rev-parse", "HEAD"), {});

    expect(bytes).toBe(1024);
  });

  it("a mode-only change of a large blob stays renderable under a limit smaller than the blob", async () => {
    const { root, git } = repo();
    const base = git("rev-parse", "HEAD");
    chmodSync(join(root, "large.bin"), 0o755);

    const captured = await captureWorkingTreeTransient(root, base, [], {
      viewLimitBytes: 64 * 1024,
    });

    expect(captured.patchViewUnavailable).toBeUndefined();
    expect(captured.patch).toContain("old mode 100644");
    expect(captured.patch).toContain("new mode 100755");
  });

  it("a content change still counts both sides", async () => {
    const { root, git } = repo();
    const before = git("rev-parse", "HEAD");
    writeFileSync(join(root, "large.bin"), Buffer.alloc(LARGE, 8));
    git("add", ".");
    git("-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-qm", "edit");

    const { bytes } = await estimatePatchViewBytes(root, before, git("rev-parse", "HEAD"), {});

    expect(bytes).toBe(1024 + 2 * Math.ceil((LARGE * 5) / 4));
  });

  it("over the limit it is the typed absence, and no render is attempted", async () => {
    const { root, git } = repo();
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(root, "large.bin"), Buffer.alloc(LARGE, 8));

    const captured = await captureWorkingTreeTransient(root, base, [], {
      viewLimitBytes: 64 * 1024,
    });

    expect(captured).toMatchObject({ captureIncomplete: false, patch: "" });
    expect(captured.patchViewUnavailable).toEqual({
      reason: "exceeds_view_limit",
      limitBytes: 64 * 1024,
      estimatedBytes: 1024 + 2 * Math.ceil((LARGE * 5) / 4),
    });
    expect(captured.changedPaths).toEqual(["large.bin"]);
    expect(renders).toEqual([]);
    // The seam is live: the same capture under a larger limit renders.
    const rendered = await captureWorkingTreeTransient(root, base, [], {
      viewLimitBytes: 16 * LARGE,
    });
    expect(rendered.patchViewUnavailable).toBeUndefined();
    expect(renders).toHaveLength(1);
  });
});
