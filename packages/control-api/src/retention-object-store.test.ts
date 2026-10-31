import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
});
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
const git = (repo: string, args: string[], env: Record<string, string> = {}, input?: string) =>
  execFileSync("git", ["-C", repo, ...args], { env: { ...ENV, ...env }, input })
    .toString("utf8")
    .trim();
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

const inStore = (store: string, oid: string) =>
  spawnSync("git", ["-C", store, "cat-file", "-e", oid], { env: { ...ENV, ...storeEnv(store) } })
    .status === 0;

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
