import { execFileSync } from "node:child_process";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Lane start and envelope disposal do not wait on the disk or on `ps` on the main
 * thread (#688, style of daemon/src/store/main-thread-sync.test.ts): the spies
 * replace the synchronous entry points for every module of this test's graph.
 */
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const patched = { mkdirSync: vi.fn(actual.mkdirSync), rmSync: vi.fn(actual.rmSync) };
  return { ...actual, ...patched, default: { ...actual, ...patched } };
});
/** Hooks into the awaited lifecycle calls: the task directory's prune and the
 * scoped home's creation (#704). */
const lifecycle = vi.hoisted(() => ({
  pruneOf: null as string | null,
  atPrune: null as (() => Promise<void>) | null,
  homeOf: null as string | null,
  ownerAtHome: [] as boolean[],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const { existsSync: exists } = await vi.importActual<typeof import("node:fs")>("node:fs");
  const { join: joinPath } = await vi.importActual<typeof import("node:path")>("node:path");
  const prune = async (path: unknown): Promise<void> => {
    const during = lifecycle.atPrune;
    if (!during || String(path) !== lifecycle.pruneOf) return;
    lifecycle.atPrune = null;
    await during();
  };
  const patched = {
    // A listing of the task directory returns, then the hook runs (a slow disk).
    readdir: (async (...args: Parameters<typeof actual.readdir>) => {
      const listed = await actual.readdir(...args);
      await prune(args[0]);
      return listed;
    }) as typeof actual.readdir,
    rmdir: (async (...args: Parameters<typeof actual.rmdir>) => {
      await prune(args[0]);
      return actual.rmdir(...args);
    }) as typeof actual.rmdir,
    mkdir: (async (...args: Parameters<typeof actual.mkdir>) => {
      const home = lifecycle.homeOf;
      if (home && String(args[0]).startsWith(joinPath(home, "home")))
        lifecycle.ownerAtHome.push(exists(joinPath(home, "owner.json")));
      return actual.mkdir(...args);
    }) as typeof actual.mkdir,
  };
  return { ...actual, ...patched, default: { ...actual, ...patched } };
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const patched = { execFileSync: vi.fn(actual.execFileSync) };
  return { ...actual, ...patched, default: { ...actual, ...patched } };
});
const { WorkspaceManager } = await import("./manager.js");

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

function project(): { repo: string; runtimeRoot: string } {
  const base = mkdtempSync(join(tmpdir(), "claudexor-lane-sync-"));
  roots.push(base);
  const repo = join(base, "repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"], { env: GIT_ENV });
  writeFileSync(join(repo, "AGENTS.md"), "# rules\n");
  writeFileSync(join(repo, "a.txt"), "a\n");
  execFileSync("git", ["-C", repo, "add", "-A"], { env: GIT_ENV });
  execFileSync("git", ["-C", repo, "commit", "-qm", "one"], { env: GIT_ENV });
  return { repo, runtimeRoot: join(base, "runtime") };
}

const psCalls = () =>
  vi.mocked(childProcess.execFileSync).mock.calls.filter(([command]) => command === "ps");
const recursiveRmSyncCalls = () =>
  vi.mocked(fs.rmSync).mock.calls.filter(([, options]) => options?.recursive === true);

beforeEach(() => {
  vi.mocked(fs.mkdirSync).mockClear();
  vi.mocked(fs.rmSync).mockClear();
  vi.mocked(childProcess.execFileSync).mockClear();
});

describe(
  "lane start and envelope disposal off the main thread (#688)",
  { timeout: 120_000 },
  () => {
    it("make no mkdirSync, recursive rmSync or ps after the first envelope", async () => {
      const { repo, runtimeRoot } = project();
      const manager = new WorkspaceManager(repo, { runtimeRoot });
      // The first envelope may learn this process's own start time once.
      const first = await manager.create({
        taskId: "t0",
        attemptId: "a00",
        custody: { runId: "run-0", runDir: join(runtimeRoot, "runs", "run-0") },
      });
      await manager.dispose(first);
      vi.mocked(fs.mkdirSync).mockClear();
      vi.mocked(fs.rmSync).mockClear();
      vi.mocked(childProcess.execFileSync).mockClear();

      for (let i = 1; i <= 3; i += 1) {
        const envelope = await manager.create({
          taskId: `t${i}`,
          attemptId: "a01",
          custody: { runId: `run-${i}`, runDir: join(runtimeRoot, "runs", `run-${i}`) },
        });
        const base = join(runtimeRoot, "workspaces", `t${i}`, "a01");
        // Direction 1: the envelope is whole before `create` returns.
        const owner = JSON.parse(readFileSync(join(base, "owner.json"), "utf8")) as {
          pid: number;
          started: string | null;
        };
        expect(owner.pid).toBe(process.pid);
        // The start time `ps` gave once (Windows has no `ps`: null, read once too).
        expect(owner.started === null ? process.platform : typeof owner.started).toBe(
          process.platform === "win32" ? "win32" : "string",
        );
        for (const dir of [".codex", ".claude", ".cursor", join(".config", "opencode"), ".copilot"])
          expect(existsSync(join(envelope.home_dir, dir))).toBe(true);
        expect(existsSync(join(base, "private-clone-v1"))).toBe(true);
        expect(existsSync(join(base, "continuation-custody.json"))).toBe(true);
        expect(existsSync(join(base, "bridge-created.json"))).toBe(true);
        expect(readFileSync(join(envelope.worktree_path, "a.txt"), "utf8")).toBe("a\n");
        await manager.dispose(envelope);
        expect(existsSync(base)).toBe(false);
        expect(existsSync(join(runtimeRoot, "workspaces", `t${i}`))).toBe(false);
      }
      // Direction 2: none of it waited on the disk or on `ps` synchronously.
      expect(vi.mocked(fs.mkdirSync)).not.toHaveBeenCalled();
      expect(recursiveRmSyncCalls()).toEqual([]);
      expect(psCalls()).toEqual([]);
    });

    it("prunes an empty task directory, never a sibling envelope another create makes meanwhile (#704)", async () => {
      const { repo, runtimeRoot } = project();
      const manager = new WorkspaceManager(repo, { runtimeRoot });
      const taskDir = join(runtimeRoot, "workspaces", "race");
      const a = await manager.create({ taskId: "race", attemptId: "a01" });
      let b: Awaited<ReturnType<typeof manager.create>> | null = null;
      // While dispose(A) prunes the task directory, create(B) of the same task runs whole.
      lifecycle.pruneOf = taskDir;
      lifecycle.atPrune = async () => {
        b = await manager.create({ taskId: "race", attemptId: "a02" });
      };
      try {
        await manager.dispose(a);
      } finally {
        lifecycle.atPrune = null;
      }
      // Direction 1: B was made during the prune and is whole after it.
      expect(b).not.toBeNull();
      const baseB = join(taskDir, "a02");
      expect(existsSync(join(baseB, "owner.json"))).toBe(true);
      expect(existsSync(b!.home_dir)).toBe(true);
      expect(readFileSync(join(b!.worktree_path, "a.txt"), "utf8")).toBe("a\n");
      // Direction 2: with no sibling left, the prune removes the empty directory.
      await manager.dispose(b!);
      expect(existsSync(taskDir)).toBe(false);
    });

    it("writes owner.json before it makes the envelope's scoped home (#704)", async () => {
      const { repo, runtimeRoot } = project();
      const manager = new WorkspaceManager(repo, { runtimeRoot });
      lifecycle.homeOf = join(runtimeRoot, "workspaces", "owner-first", "a01");
      lifecycle.ownerAtHome = [];
      try {
        const envelope = await manager.create({ taskId: "owner-first", attemptId: "a01" });
        // Direction 1: the crash sweeper's liveness marker was on disk, whole,
        // when the first directory of the scoped home was made.
        expect(lifecycle.ownerAtHome.length).toBeGreaterThan(0);
        expect(lifecycle.ownerAtHome[0]).toBe(true);
        // Direction 2: the envelope is whole when `create` returns.
        const owner = JSON.parse(readFileSync(join(lifecycle.homeOf, "owner.json"), "utf8")) as {
          pid: number;
          envelope_id: string;
        };
        expect(owner).toMatchObject({ pid: process.pid, envelope_id: envelope.id });
        expect(existsSync(join(envelope.home_dir, ".codex"))).toBe(true);
        await manager.dispose(envelope);
      } finally {
        lifecycle.homeOf = null;
      }
    });

    it("disposes a read-only scoped home off the main thread (#704)", async () => {
      const { repo, runtimeRoot } = project();
      const manager = new WorkspaceManager(repo, { runtimeRoot });
      const readOnly = manager.readOnlyHomeEnv();
      const home = readOnly.env["HOME"] as string;
      // Native state a harness left in the scoped home.
      fs.mkdirSync(join(home, ".codex", "sessions"), { recursive: true });
      for (let i = 0; i < 5; i += 1)
        writeFileSync(join(home, ".codex", "sessions", `s${i}.jsonl`), "{}\n");
      vi.mocked(fs.rmSync).mockClear();
      await readOnly.dispose();
      // Direction 1: no recursive removal waited on the main thread.
      expect(recursiveRmSyncCalls()).toEqual([]);
      // Direction 2: the scoped home and its throwaway base are gone.
      expect(existsSync(home)).toBe(false);
      expect(existsSync(dirname(home))).toBe(false);
    });

    it("the spies observe the synchronous calls they guard (negative control)", () => {
      const dir = mkdtempSync(join(tmpdir(), "claudexor-lane-sync-control-"));
      roots.push(dir);
      fs.mkdirSync(join(dir, "x", "y"), { recursive: true });
      fs.rmSync(join(dir, "x"), { recursive: true, force: true });
      childProcess.execFileSync("ps", ["-p", String(process.pid), "-o", "pid="]);
      expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledTimes(1);
      expect(recursiveRmSyncCalls()).toHaveLength(1);
      expect(psCalls()).toHaveLength(1);
    });
  },
);
