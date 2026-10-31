import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlThreadApplyResponse } from "@claudexor/schema";
import type { ProjectThreadPort } from "@claudexor/daemon";
import { ensureThreadWorktree } from "@claudexor/workspace";
import { applyThreadDiff } from "./thread-delivery.js";

// The delivery owner's internal `headStranded` fact is not part of the strict
// wire receipt: a thread apply whose HEAD could not return must still answer its
// receipt, whose detail names the way back, instead of a schema error.
const stranded = {
  mode: "branch" as const,
  applied: false,
  refused: true,
  treeMutated: true,
  headStranded: true,
  branch: "claudexor/wp",
  detail: "failed to leave branch claudexor/wp; run git checkout --detach abc to return",
  finalVerify: {
    attempted: true,
    base_sha: "a".repeat(40),
    applied_cleanly: true,
    gates_passed: null,
    gates: [],
    duration_ms: 1,
    reason: null,
  },
  targetPreimageSha: "a".repeat(40),
};
vi.mock("@claudexor/delivery", async (original) => ({
  ...(await original<typeof import("@claudexor/delivery")>()),
  verifyAndDeliver: async () => stranded,
}));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a thread apply's delivery receipt", () => {
  it("survives a stranded HEAD: the strict receipt parses and keeps the way back", async () => {
    const repo = mkdtempSync(join(tmpdir(), "cx-thread-receipt-"));
    dirs.push(repo);
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]);
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "base\n");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "base");
    const worktree = await ensureThreadWorktree(repo, "thread-receipt");
    dirs.push(dirname(worktree.path));
    writeFileSync(join(worktree.path, "a.txt"), "changed\n");
    const threads = {
      getThread: () => ({
        id: "thread-receipt",
        repo: { root: repo },
        head_run_id: null,
        workspace: { mode: "isolated", worktree_path: worktree.path, base_sha: worktree.baseSha },
      }),
      setThreadWorktree: () => undefined,
    } as unknown as ProjectThreadPort;

    const answer = await applyThreadDiff(threads, "thread-receipt", { mode: "branch" });

    const wire = ControlThreadApplyResponse.parse(answer);
    expect(wire.applied).toBe(false);
    expect(wire.delivery).toMatchObject({
      treeMutated: true,
      detail: expect.stringContaining("git checkout --detach"),
    });
    expect(wire.delivery).not.toHaveProperty("headStranded");
  });
});
