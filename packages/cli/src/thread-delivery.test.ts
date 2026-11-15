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
import { describe, expect, it } from "vitest";
import { type ProjectThreadPort } from "@claudexor/daemon";
import { locateScanner } from "@claudexor/delivery";
import { projectRuntimeDir } from "@claudexor/util";
import { mintRunScopeMarker, type ScopeReapOutcome } from "@claudexor/core";
import { ensureThreadWorktree, threadTreeState } from "@claudexor/workspace";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { applyThreadDiff } from "./thread-delivery.js";
import { resolveThreadExecutionWorkspace } from "./thread-execution-workspace.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

const dirs: string[] = [];
const stores: Array<{ close(): Promise<void> }> = [];
afterEachClosed(async () => {
  // This test's entries, taken before its closes: a later test never removes them.
  const ownedDirs = dirs.splice(0);
  for (const store of stores.splice(0)) await store.close();
  return () => {
    for (const dir of ownedDirs) rmSync(dir, { recursive: true, force: true });
  };
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

  it.runIf(process.platform !== "win32")(
    "a Stop inside a held tree's hand-over leaves the ready tree unrecorded; the next turn records it, and Apply and read-only turns use it (#694)",
    async () => {
      const { repo } = projectWithOrigin();
      const storeRoot = realpathSync(mkdtempSync(join(tmpdir(), "cx-thread-store-")));
      dirs.push(storeRoot);
      const sql = await sqlFixture(storeRoot);
      stores.push(sql);
      const threads = sql.graph.threads;
      const thread = threads.createThread({ repoRoot: repo, workspace: "isolated" });
      const tree = join(projectRuntimeDir(repo), "threads", thread.id, "tree");
      const turn = (over: {
        access?: "readonly";
        signal?: AbortSignal;
        preparation?: Parameters<typeof resolveThreadExecutionWorkspace>[0]["preparation"];
      }) =>
        resolveThreadExecutionWorkspace({
          threadId: thread.id,
          repoRoot: repo,
          mode: "agent",
          requestedInPlace: false,
          protectedPaths: [],
          threads,
          ...over,
        });
      const workspace = () => threads.getThread(thread.id)!.workspace;
      // Turn 1: the real checkout completes, but its scope's settlement still sees a
      // member alive: the complete tree is held and nothing is recorded at the thread.
      const marker = mintRunScopeMarker();
      const unsettled = {
        coverage: "marker",
        census: "ok",
        censusFailure: null,
        ended: [],
        survivors: [{ pid: 4242, startToken: "fixture" }],
        unreadable: [],
        reusedGroups: [],
        settled: false,
        incomplete: false,
        completeness: "not_provable",
        completenessReason: null,
        restricted: false,
        durationMs: 1,
      } as unknown as ScopeReapOutcome;
      await expect(
        turn({
          preparation: {
            openScope: async () => ({ marker }),
            settleScope: async () => unsettled,
            quiet: async () => ({ status: "held", reasons: ["scope member 4242 is alive"] }),
          },
        }),
      ).rejects.toMatchObject({ code: "termination_unconfirmed", context: { held: [tree] } });
      expect(threadTreeState(tree)).toBe("held");
      expect(workspace().worktree_path).toBeNull();
      // Turn 2: the release's read proves the end and frees the record; the Stop
      // arrives inside that hand-over, before the tree reaches the thread's record.
      const stop = new AbortController();
      const stopped = await turn({
        signal: stop.signal,
        preparation: {
          openScope: async () => ({ marker: mintRunScopeMarker() }),
          settleScope: async () => null,
          quiet: async () => {
            stop.abort("stop");
            return { status: "quiet" };
          },
        },
      }).catch((error: unknown) => error);
      expect((stopped as Error).name).toBe("PreparationCancelled");
      expect(threadTreeState(tree)).toBe("ready");
      expect(workspace().worktree_path).toBeNull();
      // Turn 3 finds the ready tree (nothing is made) and records it.
      const made = await turn({});
      expect(made).toMatchObject({ executionRoot: tree, inPlace: true, promoted: false });
      const base = git(tree, "rev-parse", "HEAD");
      expect(workspace()).toMatchObject({ mode: "isolated", worktree_path: tree, base_sha: base });
      // The readers of that record now use the tree: a read-only turn runs in it…
      expect(await turn({ access: "readonly" })).toMatchObject({ executionRoot: tree });
      // …and Apply delivers what the turn wrote there.
      threads.bindTurnRun(threads.createTurn(thread.id, "write the file").id, "run-head");
      writeFileSync(join(tree, "NEW.txt"), "new\n");
      await expect(applyThreadDiff(threads, thread.id, { mode: "apply" })).resolves.toMatchObject({
        applied: true,
        status: "applied",
      });
      expect(readFileSync(join(repo, "NEW.txt"), "utf8")).toBe("new\n");
      // A later turn on the recorded tree writes nothing more to the thread.
      const recorded = threads.getThread(thread.id)!;
      await turn({});
      expect(threads.getThread(thread.id)).toEqual(recorded);
    },
  );

  it("refuses Apply of a tree whose preparation did not complete, changing nothing, then delivers once it is complete (#694)", async () => {
    const { repo } = projectWithOrigin();
    const storeRoot = realpathSync(mkdtempSync(join(tmpdir(), "cx-thread-store-")));
    dirs.push(storeRoot);
    const sql = await sqlFixture(storeRoot);
    stores.push(sql);
    const threads = sql.graph.threads;
    const thread = threads.createThread({ repoRoot: repo, workspace: "isolated" });
    const worktree = await ensureThreadWorktree(repo, thread.id);
    threads.setThreadWorktree(thread.id, worktree.path, worktree.baseSha);
    threads.bindTurnRun(threads.createTurn(thread.id, "write the file").id, "run-head");
    writeFileSync(join(worktree.path, "NEW.txt"), "new\n");
    // A half-made tree would deliver its missing files as deletions: the record refuses.
    const record = join(worktree.path, "..", "preparation.json");
    writeFileSync(record, JSON.stringify({ schema: 1, tree: worktree.path }));
    const headBefore = git(repo, "rev-parse", "HEAD");
    await expect(applyThreadDiff(threads, thread.id, { mode: "apply" })).rejects.toMatchObject({
      code: "termination_unconfirmed",
      context: {
        held: [worktree.path],
        termination_unconfirmed: { reason: "preparation_unfinished" },
      },
    });
    expect(existsSync(join(repo, "NEW.txt"))).toBe(false);
    expect(git(repo, "rev-parse", "HEAD")).toBe(headBefore);
    expect(threads.getThread(thread.id)!.workspace.base_sha).toBe(worktree.baseSha);
    // A release that proved the end and then could not finish: Apply refuses with
    // that cleanup fault and its remedy, not with processes to wait for.
    writeFileSync(
      record,
      JSON.stringify({
        schema: 1,
        tree: worktree.path,
        held: { reason: "output_held", groups: [7] },
        cleanup_error: "EIO: unlink preparation record",
      }),
    );
    const cleanup = await applyThreadDiff(threads, thread.id, { mode: "apply" }).catch(
      (error: unknown) => error,
    );
    expect(cleanup).toMatchObject({
      code: "preparation_cleanup_failed",
      retryable: true,
      requiredActions: [expect.stringContaining("Clear what prevents the cleanup")],
      context: {
        held: [worktree.path],
        preparation: { cleanup_error: "EIO: unlink preparation record" },
      },
    });
    expect((cleanup as { context: object }).context).not.toHaveProperty("termination_unconfirmed");
    expect(existsSync(join(repo, "NEW.txt"))).toBe(false);
    expect(git(repo, "rev-parse", "HEAD")).toBe(headBefore);
    rmSync(record);
    await expect(applyThreadDiff(threads, thread.id, { mode: "apply" })).resolves.toMatchObject({
      applied: true,
      status: "applied",
    });
    expect(readFileSync(join(repo, "NEW.txt"), "utf8")).toBe("new\n");
  });

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

  it("keeps an accepted ignored file through thread Apply, the next Raw turn, second Apply, and Revert", async () => {
    const { repo } = projectWithOrigin();
    writeFileSync(join(repo, ".gitignore"), "*.log\n");
    git(repo, "add", ".gitignore");
    git(repo, "-c", "user.email=t@t.dev", "-c", "user.name=Test", "commit", "-m", "ignore logs");
    const storeRoot = realpathSync(mkdtempSync(join(tmpdir(), "cx-thread-raw-")));
    dirs.push(storeRoot);
    const sql = await sqlFixture(storeRoot);
    stores.push(sql);
    const threads = sql.graph.threads;
    const thread = threads.createThread({ repoRoot: repo, workspace: "isolated" });
    const worktree = await ensureThreadWorktree(repo, thread.id);
    threads.setThreadWorktree(thread.id, worktree.path, worktree.baseSha);
    threads.bindTurnRun(threads.createTurn(thread.id, "raw file").id, "run-raw");
    const { RawContextPacket, RawGitPatchEnvelope } = await import("@claudexor/schema");
    const { sha256 } = await import("@claudexor/util");
    const { consumeRawPatchEnvelope, rawCandidateTree, rawAcceptedPaths, createPairRevertAnchor } =
      await import("@claudexor/workspace");
    const { revertInPlaceFromAnchor } = await import("@claudexor/delivery");
    const add = (text: string) =>
      `diff --git a/result.log b/result.log\nnew file mode 100644\n--- /dev/null\n+++ b/result.log\n@@ -0,0 +1 @@\n+${text}\n`;
    const edit = (from: string, to: string) =>
      `diff --git a/result.log b/result.log\n--- a/result.log\n+++ b/result.log\n@@ -1 +1 @@\n-${from}\n+${to}\n`;
    const rawRound = async (patch: string, touched: string[]) => {
      const base = threads.getThread(thread.id)!.workspace.base_sha!;
      const tree = await rawCandidateTree(worktree.path);
      const files = git(worktree.path, "ls-tree", "-r", tree)
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [modeOid, path] = line.split("\t");
          const [, mode, oid] = modeOid!.split(" ");
          const content = execFileSync("git", ["-C", worktree.path, "cat-file", "blob", oid!], {
            encoding: "utf8",
          });
          return { path, mode, blob_oid: oid, content_hash: sha256(content), content };
        });
      const packet = RawContextPacket.parse({
        schema_version: 1,
        packet_hash: `sha256:${tree}`,
        base_commit_sha: base,
        base_tree_sha: tree,
        readable_files: files,
        editable_paths: files.map((file) => file.path),
        creatable_roots: ["."],
        file_manifest: files.map((file) => ({
          path: file.path,
          disposition: "full",
          bytes: Buffer.byteLength(file.content),
          hash: file.content_hash,
        })),
        omissions: [],
        evidence_refs: files.map((file) => `git:${tree}:${file.path}:${file.blob_oid}`),
      });
      await consumeRawPatchEnvelope({
        repoRoot: repo,
        worktreePath: worktree.path,
        baseCommitSha: base,
        context: packet,
        envelope: RawGitPatchEnvelope.parse({
          schema_version: 1,
          context_packet_hash: packet.packet_hash,
          base_tree_sha: tree,
          patch,
          patch_hash: sha256(patch),
          touched_paths: touched.map((path) => ({
            path,
            expected_blob_oid: files.find((file) => file.path === path)?.blob_oid ?? null,
          })),
        }),
      });
    };
    await rawRound(add("first"), ["result.log"]);
    const first = await applyThreadDiff(threads, thread.id, { mode: "apply" });
    expect(first.applied).toBe(true);
    expect(readFileSync(join(repo, "result.log"), "utf8")).toBe("first\n");
    await rawRound(edit("first", "second"), ["result.log"]);
    const second = await applyThreadDiff(threads, thread.id, { mode: "apply" });
    expect(second).toMatchObject({ applied: true, status: "applied" });
    expect(readFileSync(join(repo, "result.log"), "utf8")).toBe("second\n");
    expect(
      await rawAcceptedPaths(worktree.path, threads.getThread(thread.id)!.workspace.base_sha!),
    ).toContain("result.log");
    const secondAnchor = await createPairRevertAnchor(repo, second.delivery!.deliveryPair!, repo);
    expect(await revertInPlaceFromAnchor(repo, secondAnchor, repo)).toMatchObject({
      reverted: true,
    });
    expect(readFileSync(join(repo, "result.log"), "utf8")).toBe("first\n");
    const firstAnchor = await createPairRevertAnchor(repo, first.delivery!.deliveryPair!, repo);
    expect(await revertInPlaceFromAnchor(repo, firstAnchor, repo)).toMatchObject({
      reverted: true,
    });
    expect(existsSync(join(repo, "result.log"))).toBe(false);
  });
});
