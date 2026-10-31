import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureFailureEvidence } from "./capture-failure.js";
import { captureWorkingTreeTransient } from "./git-transient-capture.js";
import { gitObserved, GitOperationError } from "./git-observed.js";

// #535 phase 2: what still fails after object capture is typed by its real
// Git cause (no model prose is read): a read error, a stall, a signal, no space.
// `fakeFreeBytes` makes statfs report a nearly full filesystem (ESM namespaces
// cannot be spied, so node:fs is wrapped once for this file).
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
const roots: string[] = [];
afterEach(() => {
  fakeFreeBytes = null;
  for (const root of roots.splice(0)) {
    try {
      execFileSync("chmod", ["-R", "u+rwx", root]);
    } catch {
      // Already removable.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "cx-capture-classes-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args]);
  git("init", "-q");
  writeFileSync(join(root, "kept.txt"), "unchanged\n");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "base",
  );
  return root;
}

describe("typed Git failure classes on the object path", () => {
  it("an unreadable changed file is a read failure with Git's own words, never 'no changes'", async () => {
    if (process.getuid?.() === 0) return; // root reads mode-000 files
    const root = repo();
    writeFileSync(join(root, "secret-unreadable.bin"), Buffer.alloc(1024, 3));
    chmodSync(join(root, "secret-unreadable.bin"), 0o000);
    const captured = await captureWorkingTreeTransient(root, "HEAD");
    expect(captured.captureIncomplete).toBe(true);
    const failure = captureFailureEvidence(captured.captureFailure);
    expect(failure.code).toBe("capture_read_failed");
    expect(failure.message).toMatch(/Permission denied|unable to index file/);
  });

  it("a Git child with no progress is stopped as a stall, not after a wall clock", async () => {
    const root = repo();
    const started = Date.now();
    const error = await gitObserved(root, ["-c", "alias.zz=!sleep 30", "zz"], {
      label: "zz",
      stallMs: 400,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitOperationError);
    expect((error as GitOperationError).code).toBe("capture_git_stalled");
    expect(captureFailureEvidence(error as Error)).toMatchObject({
      code: "capture_git_stalled",
      stallMs: 400,
    });
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it("a Git child killed by a signal is a signal failure naming it", async () => {
    const root = repo();
    const error = await gitObserved(root, ["-c", "alias.kk=!kill -KILL $PPID; sleep 5", "kk"], {
      label: "kk",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitOperationError);
    expect((error as GitOperationError).code).toBe("capture_git_signal");
    expect(captureFailureEvidence(error as Error)).toMatchObject({
      code: "capture_git_signal",
      signal: "SIGKILL",
    });
  });

  it("the free-space preflight refuses before anything is written, with exact numbers", async () => {
    const root = repo();
    writeFileSync(join(root, "big.bin"), Buffer.alloc(256 * 1024, 1));
    fakeFreeBytes = 4096;
    const captured = await captureWorkingTreeTransient(root, "HEAD");
    expect(captured.captureIncomplete).toBe(true);
    const failure = captureFailureEvidence(captured.captureFailure);
    expect(failure.code).toBe("capture_space_insufficient");
    expect(failure.availableBytes).toBe(4096);
    expect(failure.requiredBytes).toBeGreaterThan(256 * 1024);
  });
});
