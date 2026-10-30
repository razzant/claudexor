import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ProjectThreadPort } from "@claudexor/daemon";
import { locateScanner } from "@claudexor/delivery";
import { projectRuntimeDir } from "@claudexor/util";
import { ensureThreadWorktree } from "@claudexor/workspace";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { applyThreadDiff } from "./thread-delivery.js";

const dirs: string[] = [];
const stores: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (repo: string, ...args: string[]): string =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

/** Assembled at runtime so no secret-shaped literal lives in this file;
 * high-entropy so the publication scanner's own rules recognize it. */
const secret = `ghp_${"q7Lm2Xv9Rk4Tz8Nw3Bp6Hs1Jd5Gf0Yc2Ae9U"}`;
const leakBytes = (kind: "text" | "binary"): Buffer =>
  kind === "text"
    ? Buffer.from(`${secret}\n`)
    : Buffer.concat([Buffer.from([0]), Buffer.from(secret), Buffer.from([0])]);
const leakName = (kind: "text" | "binary"): string => (kind === "text" ? "LEAK.txt" : "LEAK.bin");

/** A committed project with a pushable bare `origin`. */
function projectWithOrigin() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-thread-delivery-")));
  const remote = mkdtempSync(join(tmpdir(), "claudexor-thread-delivery-remote-"));
  dirs.push(repo, remote, projectRuntimeDir(repo));
  execFileSync("git", ["init", "--bare", "-b", "main", remote]);
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "README.md"), "# test\n");
  git(repo, "add", "-A");
  git(repo, "-c", "user.email=t@t.dev", "-c", "user.name=Test", "commit", "-m", "init");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
  return { repo, remote };
}

/** A project with a pushable `origin` and an isolated thread worktree that
 * holds one changed file with secret-like bytes. */
async function threadWithLeak(kind: "text" | "binary") {
  const { repo, remote } = projectWithOrigin();
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

describe("thread delivery keeps credential-shaped bytes exact and gates only publication (INV-146)", () => {
  it.each(["text", "binary"] as const)(
    "applies the live %s worktree bytes exactly and advances the durable watermark to them",
    async (kind) => {
      const { repo } = projectWithOrigin();
      const storeRoot = realpathSync(mkdtempSync(join(tmpdir(), "cx-thread-store-")));
      dirs.push(storeRoot);
      const sql = await sqlFixture(storeRoot);
      stores.push(sql);
      // The real daemon thread store is the watermark owner (no port double).
      const threads = sql.graph.threads;
      const thread = threads.createThread({ repoRoot: repo, workspace: "isolated" });
      const worktree = await ensureThreadWorktree(repo, thread.id);
      threads.setThreadWorktree(thread.id, worktree.path, worktree.baseSha);
      threads.bindTurnRun(threads.createTurn(thread.id, "write the file").id, "run-head");
      writeFileSync(join(worktree.path, leakName(kind)), leakBytes(kind));

      const result = await applyThreadDiff(threads, thread.id, { mode: "apply" });

      expect(result).toMatchObject({ applied: true, status: "applied" });
      // The exact bytes the agent wrote arrive in the project, unredacted.
      expect(readFileSync(join(repo, leakName(kind))).equals(leakBytes(kind))).toBe(true);
      // Success durably advances base and delivered-through together, to the
      // delivered project snapshot the persistent branch and worktree now hold.
      const delivered = threads.getThread(thread.id)!.workspace;
      expect(delivered).toMatchObject({
        mode: "isolated",
        worktree_path: worktree.path,
        delivered_through_run_id: "run-head",
      });
      const sha = delivered.base_sha!;
      expect(sha).not.toBe(worktree.baseSha);
      expect(git(repo, "rev-parse", `refs/heads/claudexor/thread-${thread.id}`)).toBe(sha);
      expect(git(worktree.path, "rev-parse", "HEAD")).toBe(sha);
      expect(git(worktree.path, "status", "--porcelain")).toBe("");
      const blob = execFileSync("git", [
        "-C",
        repo,
        "cat-file",
        "blob",
        `${sha}:${leakName(kind)}`,
      ]);
      expect(blob.equals(leakBytes(kind))).toBe(true);
      // The advanced watermark is the next base: nothing is delivered twice.
      await expect(applyThreadDiff(threads, thread.id, { mode: "apply" })).resolves.toMatchObject({
        applied: false,
        status: "empty",
      });
      expect(threads.getThread(thread.id)!.workspace.base_sha).toBe(sha);
    },
  );

  it("refuses 'pr' typed and creates nothing when the publication scanner is unavailable", async () => {
    const { repo, remote, threads } = await threadWithLeak("text");
    const headBefore = git(repo, "rev-parse", "HEAD");
    const branchesBefore = git(repo, "branch", "--list");
    const remoteRefsBefore = git(remote, "for-each-ref");
    const saved = process.env.CLAUDEXOR_BETTERLEAKS_PATH;
    process.env.CLAUDEXOR_BETTERLEAKS_PATH = join(repo, "README.md");
    try {
      const result = await applyThreadDiff(threads, "thread-1", { mode: "pr" });
      expect(result).toMatchObject({ applied: false, status: "rejected", headMoved: false });
      expect(result.delivery).toMatchObject({
        refused: true,
        treeMutated: false,
        publicationRefusal: { code: "publication_scan_unavailable" },
      });
    } finally {
      if (saved === undefined) delete process.env.CLAUDEXOR_BETTERLEAKS_PATH;
      else process.env.CLAUDEXOR_BETTERLEAKS_PATH = saved;
    }
    expect(existsSync(join(repo, "LEAK.txt"))).toBe(false);
    expect(git(repo, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(repo, "branch", "--list")).toBe(branchesBefore);
    expect(git(remote, "for-each-ref")).toBe(remoteRefsBefore);
  });

  it.runIf(locateScanner({ env: process.env, configDir: null }).ok)(
    "refuses 'pr' for a scanner finding before any branch, commit or push",
    async () => {
      const { repo, remote, threads } = await threadWithLeak("text");
      const headBefore = git(repo, "rev-parse", "HEAD");
      const remoteRefsBefore = git(remote, "for-each-ref");
      const result = await applyThreadDiff(threads, "thread-1", { mode: "pr" });
      expect(result).toMatchObject({ applied: false, status: "rejected" });
      expect(result.delivery?.publicationRefusal?.code).toBe("publication_scan_findings");
      expect(result.detail).toMatch(/github-pat in LEAK\.txt:1/);
      expect(result.detail).not.toContain(secret);
      expect(existsSync(join(repo, "LEAK.txt"))).toBe(false);
      expect(git(repo, "rev-parse", "HEAD")).toBe(headBefore);
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
