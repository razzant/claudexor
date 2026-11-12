import { execFileSync } from "node:child_process";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
