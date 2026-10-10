import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ProjectThreadPort } from "@claudexor/daemon";
import { PR_SECRET_LIKE_REFUSAL } from "@claudexor/delivery";
import { projectRuntimeDir } from "@claudexor/util";
import { ensureThreadWorktree } from "@claudexor/workspace";
import { applyThreadDiff } from "./thread-delivery.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (repo: string, ...args: string[]): string =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

/** Assembled at runtime so no secret-shaped literal lives in this file. */
const secret = ["sk", "f".repeat(24)].join("-");
const leakBytes = (kind: "text" | "binary"): Buffer =>
  kind === "text"
    ? Buffer.from(`${secret}\n`)
    : Buffer.concat([Buffer.from([0]), Buffer.from(secret), Buffer.from([0])]);
const leakName = (kind: "text" | "binary"): string => (kind === "text" ? "LEAK.txt" : "LEAK.bin");

/** A project with a pushable `origin` and an isolated thread worktree that
 * holds one changed file with secret-like bytes. */
async function threadWithLeak(kind: "text" | "binary") {
  const repo = mkdtempSync(join(tmpdir(), "claudexor-thread-delivery-"));
  const remote = mkdtempSync(join(tmpdir(), "claudexor-thread-delivery-remote-"));
  dirs.push(repo, remote, projectRuntimeDir(repo));
  execFileSync("git", ["init", "--bare", "-b", "main", remote]);
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "README.md"), "# test\n");
  git(repo, "add", "-A");
  git(repo, "-c", "user.email=t@t.dev", "-c", "user.name=Test", "commit", "-m", "init");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
  const worktree = await ensureThreadWorktree(repo, "thread-1");
  writeFileSync(join(worktree.path, leakName(kind)), leakBytes(kind));
  const thread = {
    workspace: { mode: "isolated", worktree_path: worktree.path, base_sha: worktree.baseSha },
    repo: { root: repo },
    head_run_id: null,
  };
  const threads = {
    getThread: () => thread,
    setThreadWorktree: () => undefined,
  } as unknown as ProjectThreadPort;
  return { repo, remote, threads };
}

describe("thread delivery keeps secret-like bytes local (INV-062)", () => {
  it.each(["text", "binary"] as const)(
    "applies the live %s worktree bytes exactly instead of refusing them",
    async (kind) => {
      const { repo, threads } = await threadWithLeak(kind);

      const result = await applyThreadDiff(threads, "thread-1", { mode: "apply" });

      expect(result).toMatchObject({ applied: true, status: "applied" });
      // The exact bytes the agent wrote arrive in the project, unredacted.
      expect(readFileSync(join(repo, leakName(kind))).equals(leakBytes(kind))).toBe(true);
    },
  );

  it.each(["text", "binary"] as const)(
    "refuses 'pr' for a %s finding before any branch, commit or push",
    async (kind) => {
      const { repo, remote, threads } = await threadWithLeak(kind);
      const headBefore = git(repo, "rev-parse", "HEAD");
      const branchesBefore = git(repo, "branch", "--list");
      const remoteRefsBefore = git(remote, "for-each-ref");

      const result = await applyThreadDiff(threads, "thread-1", { mode: "pr" });

      expect(result).toMatchObject({ applied: false, status: "rejected", headMoved: false });
      expect(result.detail).toBe(PR_SECRET_LIKE_REFUSAL);
      expect(result.delivery).toMatchObject({ refused: true, treeMutated: false });
      // Refused before the fresh verify: the verifier never ran on this patch.
      expect(result.delivery?.finalVerify).toMatchObject({
        attempted: false,
        reason: "secret_like_patch_not_published",
      });
      // Nothing was created locally and nothing reached the remote.
      expect(existsSync(join(repo, leakName(kind)))).toBe(false);
      expect(git(repo, "rev-parse", "HEAD")).toBe(headBefore);
      expect(git(repo, "branch", "--list")).toBe(branchesBefore);
      expect(git(remote, "for-each-ref")).toBe(remoteRefsBefore);
    },
  );

  it.each(["branch", "commit"] as const)(
    "allows the local '%s' delivery of a secret-like text patch",
    async (mode) => {
      const { repo, remote, threads } = await threadWithLeak("text");
      const remoteRefsBefore = git(remote, "for-each-ref");

      const result = await applyThreadDiff(threads, "thread-1", {
        mode,
        branch: "claudexor/local-delivery",
        message: "local delivery",
      });

      expect(result.applied).toBe(true);
      expect(result.status).toBe(mode === "branch" ? "branched" : "committed");
      expect(git(repo, "show", `${result.delivery?.commit ?? "HEAD"}:LEAK.txt`)).toBe(secret);
      // Local only: the remote is untouched.
      expect(git(remote, "for-each-ref")).toBe(remoteRefsBefore);
    },
  );
});
