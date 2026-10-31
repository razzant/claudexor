import child, { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitObjectResult } from "@claudexor/schema";
import { captureWorkingTreeTransient } from "./git-transient-capture.js";
import { materializeTree } from "./object-materialize.js";
import { materializeSavedFiles } from "./object-saved-files.js";
import {
  beginPendingRoots,
  endPendingRoots,
  objectStorePath,
  pruneObjectStore,
} from "./object-store.js";

// #535 teardown: the removal of a disposable scratch or of a pending lease record
// comes after the operation's answer and must never replace it. Every fault is real:
// Git runs, and a directory made read-only (POSIX) refuses the removal. The only seam
// is node's own spawn, which the compiled process runner calls: it lets a test act at
// the moment a given Git child starts, or stand in for one Git child that fails.
const originalSpawn = child.spawn;
type Spawned = { args: string[]; env: Record<string, string | undefined> };
let onSpawn: ((spawned: Spawned) => { failWith: string } | void) | null = null;
const roots: string[] = [];
const unlock: string[] = [];
let configDir: string | undefined;

beforeEach(() => {
  configDir = process.env["CLAUDEXOR_CONFIG_DIR"];
  child.spawn = function (this: unknown, command: string, args: string[], options: never) {
    const env = (options as { env?: Record<string, string> } | undefined)?.env ?? {};
    const acted = onSpawn?.({ args, env });
    if (acted)
      return originalSpawn.call(
        this,
        "/bin/sh",
        ["-c", `printf '%s\\n' "$0" >&2; exit 128`, acted.failWith],
        options,
      );
    return originalSpawn.call(this, command, args, options);
  } as typeof child.spawn;
  syncBuiltinESMExports();
});
afterEach(() => {
  onSpawn = null;
  child.spawn = originalSpawn;
  syncBuiltinESMExports();
  for (const path of unlock.splice(0)) if (existsSync(path)) chmodSync(path, 0o700);
  if (configDir === undefined) delete process.env["CLAUDEXOR_CONFIG_DIR"];
  else process.env["CLAUDEXOR_CONFIG_DIR"] = configDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (repo: string, args: string[], input?: string) =>
  execFileSync("git", ["-C", repo, ...args], { env: GIT_ENV, encoding: "utf8", input }).trim();

/** Make `dir` refuse the removal of its entries until the test ends. */
function lock(dir: string): void {
  unlock.push(dir);
  chmodSync(dir, 0o500);
}

/** A repository whose worktree and index hold `base` (f.txt "before"), and `candidate` (f.txt "after!"). */
function trees() {
  const root = mkdtempSync(join(tmpdir(), "cx-teardown-"));
  roots.push(root);
  process.env["CLAUDEXOR_CONFIG_DIR"] = join(root, "config");
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  const before = git(repo, ["hash-object", "-w", "--stdin"], "before\n");
  const after = git(repo, ["hash-object", "-w", "--stdin"], "after!\n");
  const base = git(repo, ["mktree"], `100644 blob ${before}\tf.txt\n`);
  const candidate = git(repo, ["mktree"], `100644 blob ${after}\tf.txt\n`);
  git(repo, ["read-tree", base]);
  git(repo, ["checkout-index", "--all"]);
  return { root, repo, base, candidate };
}

const removalFault = (outcome: object) =>
  (outcome as { cleanupError?: { code?: string } }).cleanupError;
const DENIED = ["EACCES", "ENOTEMPTY", "EPERM"];

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "teardown never replaces what an object operation answered (#535)",
  () => {
    it("control: a temporary-index write proves its content and removes its scratch", async () => {
      const { repo, base, candidate } = trees();
      let scratch: string | undefined;
      onSpawn = ({ env }) => {
        if (env["GIT_INDEX_FILE"]?.includes("claudexor-materialize-"))
          scratch = dirname(env["GIT_INDEX_FILE"]);
      };
      const written = await materializeTree({
        worktree: repo,
        from: base,
        to: candidate,
        index: "temporary",
      });
      expect(written).toEqual({ ok: true, changed: 1, treeMutated: true });
      expect(removalFault(written)).toBeUndefined();
      expect(readFileSync(join(repo, "f.txt"), "utf8")).toBe("after!\n");
      expect(scratch && existsSync(scratch)).toBe(false);
    });

    it("a scratch that cannot be removed after a proven write keeps the write's result", async () => {
      const { repo, base, candidate } = trees();
      let scratch: string | undefined;
      onSpawn = ({ env }) => {
        const index = env["GIT_INDEX_FILE"];
        if (index?.includes("claudexor-materialize-")) scratch = dirname(index);
        // The content proof runs in its own scratch, after the checkout wrote.
        if (index?.includes("claudexor-proof-") && scratch) lock(scratch);
      };
      const written = await materializeTree({
        worktree: repo,
        from: base,
        to: candidate,
        index: "temporary",
      });
      expect(written).toEqual({ ok: true, changed: 1, treeMutated: true });
      expect(DENIED).toContain(removalFault(written)?.code);
      // Not serialized into any receipt.
      expect(JSON.parse(JSON.stringify(written))).toEqual({
        ok: true,
        changed: 1,
        treeMutated: true,
      });
      expect(readFileSync(join(repo, "f.txt"), "utf8")).toBe("after!\n");
      // The user's index is untouched; the scratch stays in the temp dir.
      expect(git(repo, ["write-tree"])).toBe(base);
      expect(scratch && existsSync(scratch)).toBe(true);
    });

    it("a scratch that cannot be removed after a typed refusal keeps the refusal", async () => {
      const { repo, base, candidate } = trees();
      writeFileSync(join(repo, "f.txt"), "the user's edit\n");
      let scratch: string | undefined;
      onSpawn = ({ args, env }) => {
        const index = env["GIT_INDEX_FILE"];
        if (index?.includes("claudexor-materialize-")) scratch = dirname(index);
        if (args.includes("read-tree") && args.includes("-u") && scratch) lock(scratch);
      };
      const written = await materializeTree({
        worktree: repo,
        from: base,
        to: candidate,
        index: "temporary",
      });
      expect(written).toMatchObject({
        ok: false,
        treeMutated: false,
        refusal: { code: "delivery_target_changed" },
      });
      expect(DENIED).toContain(removalFault(written)?.code);
      expect(readFileSync(join(repo, "f.txt"), "utf8")).toBe("the user's edit\n");
    });
  },
);

/** A project whose store exists, so its owners lease it, and a result of `trees()`. */
function leasedProject() {
  const t = trees();
  const result: GitObjectResult = {
    schema: "git_objects/v1",
    object_format: "sha1",
    base_tree: t.base,
    candidate_tree: t.candidate,
    base_commit: null,
    store_boundary_commit: null,
    digest: `sha256:${"0".repeat(64)}`,
  } as GitObjectResult;
  const store = objectStorePath(t.repo);
  mkdirSync(join(store, "objects"), { recursive: true });
  const pending = join(store, "claudexor", "pending");
  return { ...t, result, store, pending };
}

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "a pending lease that cannot be removed never replaces its operation's answer (#535)",
  () => {
    it("endPendingRoots reports, never throws, and the record it kept still holds prune off", async () => {
      const { store, pending } = leasedProject();
      const lease = await beginPendingRoots(store, []);
      lock(pending);
      const fault = endPendingRoots(lease);
      expect(DENIED).toContain((fault as { code?: string }).code);
      expect(readdirSync(pending)).toHaveLength(1);
      expect(await pruneObjectStore({ store, graceMs: 0, objectFormat: "sha1" })).toEqual({
        freedBytes: 0,
        yielded: true,
      });
      chmodSync(pending, 0o700);
      expect(endPendingRoots(lease)).toBeUndefined();
      expect(readdirSync(pending)).toEqual([]);
    });

    it("control: a saved copy that runs out of space answers space_insufficient and releases its lease", async () => {
      const { repo, result, pending, root } = leasedProject();
      const into = join(root, "saved");
      onSpawn = ({ args }) => {
        if (args.includes("checkout-index"))
          return { failWith: "error: unable to write file f.txt: No space left on device" };
      };
      const saved = await materializeSavedFiles({
        repo,
        projectRoot: repo,
        result,
        changedPaths: ["f.txt"],
        into,
      });
      expect(saved).toEqual({
        written: [],
        unavailable: [{ path: "f.txt", reason: "space_insufficient" }],
      });
      expect(readdirSync(pending)).toEqual([]);
    });

    it("a saved copy's lease that cannot be released keeps space_insufficient, and its scratch still goes", async () => {
      const { repo, result, store, pending, root } = leasedProject();
      const into = join(root, "saved");
      let scratch: string | undefined;
      onSpawn = ({ args, env }) => {
        const gitDir = env["GIT_DIR"];
        if (gitDir?.includes("claudexor-saved-files-")) scratch = dirname(gitDir);
        if (args.includes("checkout-index")) {
          lock(pending);
          return { failWith: "error: unable to write file f.txt: No space left on device" };
        }
      };
      const saved = await materializeSavedFiles({
        repo,
        projectRoot: repo,
        result,
        changedPaths: ["f.txt"],
        into,
      });
      expect(saved).toEqual({
        written: [],
        unavailable: [{ path: "f.txt", reason: "space_insufficient" }],
      });
      expect(scratch).toBeDefined();
      expect(existsSync(scratch!)).toBe(false);
      // Not released: the record stays and a prune still yields to it.
      expect(readdirSync(pending)).toHaveLength(1);
      expect(await pruneObjectStore({ store, graceMs: 0, objectFormat: "sha1" })).toEqual({
        freedBytes: 0,
        yielded: true,
      });
    });

    it("a capture whose lease cannot be released keeps its result and still removes its scratch", async () => {
      const { root } = trees();
      const repo = join(root, "work");
      mkdirSync(repo);
      git(repo, ["init", "-q", "-b", "main"]);
      writeFileSync(join(repo, "f.txt"), "before\n");
      git(repo, ["add", "-A"]);
      git(repo, [
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@example.invalid",
        "commit",
        "-qm",
        "base",
      ]);
      const owner = join(root, "run");
      mkdirSync(owner);
      writeFileSync(join(repo, "f.txt"), "first\n");
      // The first capture makes the store, so the second leases it.
      expect((await captureWorkingTreeTransient(repo, "HEAD", [], { owner })).result).toBeTruthy();
      const pending = join(objectStorePath(repo), "claudexor", "pending");
      writeFileSync(join(repo, "f.txt"), "second\n");
      let scratch: string | undefined;
      onSpawn = ({ args, env }) => {
        const objects = env["GIT_OBJECT_DIRECTORY"];
        if (objects?.includes("claudexor-transient-diff-")) scratch = dirname(objects);
        // The view estimate runs after the custody import has ended its own lease.
        if (args.includes("--batch-check=%(objectname) %(objectsize)") && !unlock.includes(pending))
          lock(pending);
      };
      const captured = await captureWorkingTreeTransient(repo, "HEAD", [], { owner });
      expect(captured.captureIncomplete).toBe(false);
      expect(captured.result?.candidate_tree).toBeTruthy();
      expect(unlock).toContain(pending);
      expect(readdirSync(pending)).toHaveLength(1);
      expect(scratch && existsSync(scratch)).toBe(false);
    });
  },
);
