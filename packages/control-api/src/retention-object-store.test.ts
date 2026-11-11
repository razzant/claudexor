import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { objectStorePath, retainInObjectStore, storeEnv } from "@claudexor/workspace";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runRetentionPass, type RetentionDeps, type RetentionProject } from "./retention.js";

// #535 repair r1 (F3): a run retired by retention keeps its directory with
// tombstone.yaml, so a root record bound to that directory must die with the
// run's payload. Exercised through the real retention pass (Retirement.commit/
// finish), for a registered project and for an unregistered (#557-removed)
// namespace, in dry and real mode.
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)
beforeEach(() => {
  process.env["CLAUDEXOR_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "cx-retention-store-config-"));
  dirs.push(process.env["CLAUDEXOR_CONFIG_DIR"]);
});
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
// #650: a synchronous child blocks this worker, so Vitest's testTimeout cannot
// fire while it runs. Each Git child therefore has its own bound and is ended
// with SIGKILL, which it cannot ignore. The bound ends that child only.
const GIT_BOUND_MS = 10_000;

/** One Git child that exited by itself within `timeoutMs`, its output complete;
 * anything else throws. */
function runGit(
  repo: string,
  args: string[],
  env: Record<string, string> = {},
  input?: string,
  timeoutMs = GIT_BOUND_MS,
): SpawnSyncReturns<string> {
  const command = ["git", "-C", repo, ...args].join(" ");
  const result = spawnSync("git", ["-C", repo, ...args], {
    env: { ...ENV, ...env },
    input,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  // The error comes first: Git that exited 0 still times out while a process it
  // started holds Git's output open past the bound, and that output is cut off.
  const error = result.error as NodeJS.ErrnoException | undefined;
  if (error?.code === "ETIMEDOUT")
    throw new Error(
      result.status === null
        ? `${command} did not finish within ${timeoutMs} ms and was killed; processes it started may still run`
        : `${command} exited ${result.status}, but its output was still open at ${timeoutMs} ms and was cut off; processes it started may still run`,
      { cause: error },
    );
  if (error)
    throw new Error(`${command} did not run to completion: ${error.message}`, { cause: error });
  if (result.signal) throw new Error(`${command} was terminated by ${result.signal}`);
  return result;
}

const git = (repo: string, args: string[], env: Record<string, string> = {}, input?: string) => {
  const result = runGit(repo, args, env, input);
  if (result.status !== 0)
    throw new Error(`git -C ${repo} ${args.join(" ")} exited ${result.status}: ${result.stderr}`);
  return result.stdout.trim();
};
const NOW = Date.parse("2026-07-17T00:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

function userRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cx-retention-store-user-"));
  dirs.push(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "kept.txt"), "committed\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);
  return repo;
}

/** Retain one capture-shaped tree holding `content` under `owner`; returns the tree. */
async function capture(repo: string, content: string, owner: string): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), "cx-retention-store-scratch-"));
  dirs.push(scratch);
  mkdirSync(join(scratch, "objects"));
  const env = {
    GIT_INDEX_FILE: join(scratch, "index"),
    GIT_OBJECT_DIRECTORY: join(scratch, "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(repo, ".git", "objects"),
  };
  git(repo, ["read-tree", "HEAD"], env);
  const blob = git(repo, ["hash-object", "-w", "--stdin"], env, content);
  git(repo, ["update-index", "--add", "--cacheinfo", `100644,${blob},result.bin`], env);
  const tree = git(repo, ["write-tree"], env);
  await retainInObjectStore({
    projectRoot: repo,
    source: { cwd: repo, env, objectsDir: join(scratch, "objects") },
    roots: [tree],
    boundary: {
      commit: git(repo, ["rev-parse", "HEAD"]),
      tree: git(repo, ["rev-parse", "HEAD^{tree}"]),
    },
    objectFormat: "sha1",
    owner,
  });
  return tree;
}

function seedRun(runsDir: string, runId: string): string {
  const dir = join(runsDir, runId);
  mkdirSync(join(dir, "final"), { recursive: true });
  writeFileSync(join(dir, "final", "summary.md"), "# done\n");
  return dir;
}

function ageStoreObjects(store: string): void {
  const then = new Date(Date.now() - 3 * 3_600_000);
  const objects = join(store, "objects");
  for (const fan of readdirSync(objects).filter((name) => /^[0-9a-f]{2}$/.test(name)))
    for (const name of readdirSync(join(objects, fan)))
      utimesSync(join(objects, fan, name), then, then);
}

/** Whether the store holds `oid`. Absence is exactly `cat-file -e` exit 1 with no
 * diagnostics; any other answer is a failed read, never an absent object. */
function inStore(store: string, oid: string): boolean {
  const result = runGit(store, ["cat-file", "-e", oid], storeEnv(store));
  if (result.status === 0) return true;
  if (result.status === 1 && result.stderr === "") return false;
  throw new Error(`git cat-file -e ${oid} in ${store} exited ${result.status}: ${result.stderr}`);
}

/** Whether the process `pid` still exists (a zombie counts). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/** The pid a hook recorded in `file`, if any; never 0 or negative, which
 * `process.kill` reads as a process group. */
function recordedPid(file: string): number | undefined {
  const pid = existsSync(file) ? Number(readFileSync(file, "utf8").trim()) : Number.NaN;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

describe("retention reclaims object-store custody of retired runs (F3)", () => {
  it.each([
    ["a registered project", undefined],
    ["an unregistered (#557-removed) project", false],
  ] as const)("in %s, dry run and real pass agree", async (_label, keepLastRuns) => {
    const repo = userRepo();
    const store = objectStorePath(repo);
    const runsDir = join(dirname(store), "runs");
    const expiredRun = seedRun(runsDir, "run-expired");
    const recentRun = seedRun(runsDir, "run-recent");
    // A live thread owns objects through its own directory, outside runs/.
    const thread = mkdtempSync(join(tmpdir(), "cx-retention-store-thread-"));
    dirs.push(thread);
    const expiredTree = await capture(repo, "expired result ".repeat(20_000), expiredRun);
    const recentTree = await capture(repo, "recent result ".repeat(20_000), recentRun);
    const threadTree = await capture(repo, "thread snapshot ".repeat(20_000), thread);
    ageStoreObjects(store);
    const project: RetentionProject = {
      root: keepLastRuns === false ? dirname(store) : repo,
      runsDir,
      reviewsDir: null,
      ...(keepLastRuns === false ? { keepLastRuns } : {}),
    };
    const records = [
      { runId: "run-expired", state: "failed", finishedAt: daysAgo(90) },
      { runId: "run-recent", state: "failed", finishedAt: daysAgo(1) },
    ];
    const deps: RetentionDeps = {
      projects: () => [project],
      records: () => records,
      referencedRunIds: () => new Set(),
      now: () => NOW,
    };
    const policy = { runsMaxAgeDays: 30, reviewsMaxAgeDays: 14, keepLastRunsPerProject: 0 };

    const dry = await runRetentionPass(policy, { dry_run: true }, deps);
    expect(dry.deleted_runs.map((row) => row.run_id)).toEqual(["run-expired"]);
    expect(inStore(store, expiredTree)).toBe(true); // a dry run deletes nothing

    const real = await runRetentionPass(policy, { dry_run: false }, deps);
    expect(real.errors).toEqual([]);
    expect(real.deleted_runs.map((row) => row.run_id)).toEqual(["run-expired"]);
    expect(existsSync(join(expiredRun, "tombstone.yaml"))).toBe(true);
    // The retired run's result is reclaimed; live run and thread custody stays.
    expect(inStore(store, expiredTree)).toBe(false);
    expect(inStore(store, recentTree)).toBe(true);
    expect(inStore(store, threadTree)).toBe(true);
    // The dry run reported exactly what the real pass then freed.
    expect(dry.freed_bytes).toBe(real.freed_bytes);
  });
});

describe("this file's Git children are bounded and read honestly (#650)", () => {
  it("reads a failed object query as an error, never as an absent object", () => {
    const repo = userRepo();
    const store = join(repo, ".git");
    const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
    // A well-formed id of bytes no repository here holds.
    const absent = git(repo, ["hash-object", "--stdin"], {}, "never written\n");
    expect(inStore(store, tree)).toBe(true);
    expect(inStore(store, absent)).toBe(false);
    // A directory Git cannot open as a store used to read as "absent" too.
    const notAStore = mkdtempSync(join(tmpdir(), "cx-retention-store-empty-"));
    dirs.push(notAStore);
    expect(() => inStore(notAStore, tree)).toThrow(/exited 128/);
  });

  it("ends a direct child that ignores SIGTERM at its bound", () => {
    // A stand-in for a blocked Git that only SIGKILL can end.
    const bin = mkdtempSync(join(tmpdir(), "cx-retention-store-bin-"));
    dirs.push(bin);
    writeFileSync(join(bin, "git"), "#!/bin/sh\ntrap '' TERM\nexec sleep 20\n", { mode: 0o755 });
    const started = Date.now();
    expect(() =>
      runGit(bin, ["status"], { PATH: `${bin}:${process.env["PATH"] ?? ""}` }, undefined, 500),
    ).toThrow(/did not finish within 500 ms and was killed/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it.each([
    [
      // Git waits for this hook, so the commit never finishes by itself.
      "is killed while it waits for its hook",
      (pidFile: string) => `echo $$ > '${pidFile}'\nexec sleep 30`,
      /did not finish within 2000 ms and was killed; processes it started may still run/,
    ],
    [
      // Git commits and exits 0, but the hook's child keeps Git's output open:
      // status 0 arrives beside ETIMEDOUT, and the output is cut off.
      "exits 0 while its hook's child holds Git's output open",
      (pidFile: string) => `sleep 30 &\necho $! > '${pidFile}'`,
      /exited 0, but its output was still open at 2000 ms and was cut off; processes it started may still run/,
    ],
  ] as const)(
    "returns at the bound when Git %s, and the hook's process lives on",
    (_ending, script, thrown) => {
      const repo = userRepo();
      const hooks = join(repo, ".git", "hooks");
      const pidFile = join(repo, ".git", "hook.pid");
      mkdirSync(hooks, { recursive: true });
      writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\n${script(pidFile)}\n`, { mode: 0o755 });
      try {
        const started = Date.now();
        expect(() =>
          runGit(repo, ["commit", "--allow-empty", "-qm", "blocked"], {}, undefined, 2_000),
        ).toThrow(thrown);
        expect(Date.now() - started).toBeLessThan(10_000);
        // A bounded return is not tree cleanup: the process the hook left still runs.
        const hook = recordedPid(pidFile);
        expect(hook).toBeDefined();
        expect(alive(hook!)).toBe(true);
      } finally {
        // Also after any failed assertion: this test's own hook process, by the pid it recorded.
        const hook = recordedPid(pidFile);
        if (hook !== undefined && alive(hook)) process.kill(hook, "SIGKILL");
      }
    },
  );
});
