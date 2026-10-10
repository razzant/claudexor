import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectThreadPort, ProjectStorePort } from "@claudexor/daemon";
import { sqlActivityRecords } from "./sql-daemon-queries.js";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { ArtifactStore } from "@claudexor/artifact-store";
import { noProjectRepoRoot, projectRuntimeDir } from "@claudexor/util";
import { createRetentionRunner, scheduleStartupRetention } from "./retention-service.js";
import { threadPurgeOwner } from "./thread-purge.js";

const roots: string[] = [];
const sqlStores: Array<Awaited<ReturnType<typeof sqlFixture>>> = [];
let previousConfigDir: string | undefined;
let previousHome: string | undefined;

beforeEach(() => {
  // Run trees live in the per-project RUNTIME dir under the user config dir,
  // not inside the repo — scope it so fixtures never touch the real one.
  previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
  previousHome = process.env.HOME;
  const configDir = mkdtempSync(join(tmpdir(), "claudexor-retention-cfg-"));
  roots.push(configDir);
  process.env.CLAUDEXOR_CONFIG_DIR = configDir;
  // keep_last_runs_per_project defaults to 20 — a single aged run would be
  // spared as "recent". These tests are about the health/serialization gates,
  // so the keep-N sparing (covered in retention.test.ts) is set aside.
  writeFileSync(join(configDir, "config.yaml"), "retention:\n  keep_last_runs_per_project: 0\n");
});

afterEach(async () => {
  for (const sql of sqlStores.splice(0).reverse()) await sql.close();
  if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
  else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A project root whose runtime dir holds one long-terminal run tree. */
function projectWithAgedRun(runId: string): string {
  const root = mkdtempSync(join(tmpdir(), "claudexor-retention-svc-"));
  roots.push(root);
  const runDir = join(new ArtifactStore(root).runsDir(), runId);
  mkdirSync(join(runDir, "final"), { recursive: true });
  writeFileSync(join(runDir, "final", "summary.md"), "# done\n");
  return root;
}

type FakeThread = {
  id: string;
  run_ids: string[];
  state?: string;
  purge_after?: string | null;
  head_run_id?: string | null;
  repo?: { root: string } | null;
  workspace?: { mode: string };
};

/** A project root whose runtime dir still holds a thread's isolated worktree
 * dir and a lane home (what the purge owner deletes). */
function projectWithThreadDirs(threadId: string): string {
  const root = mkdtempSync(join(tmpdir(), "claudexor-retention-purge-"));
  roots.push(root);
  const runtime = projectRuntimeDir(root);
  mkdirSync(join(runtime, "threads", threadId, "tree"), { recursive: true });
  writeFileSync(join(runtime, "threads", threadId, "tree", "unapplied.txt"), "work\n");
  mkdirSync(join(runtime, "lanes", threadId, "claude-default", "home"), { recursive: true });
  return root;
}

const worktreeDir = (root: string, threadId: string) =>
  join(projectRuntimeDir(root), "threads", threadId);

function deps(input: {
  projectRoots: string[];
  healthyRoots: string[];
  threadRunIds?: string[];
  threads?: FakeThread[];
  records: Array<{ runId?: string; state: string; finishedAt?: string; params?: unknown }>;
  purged?: string[];
  /** Directory errors the purge owner throws AFTER journaling `purged`, per
   * thread and in attempt order (the real owner journals first, then deletes). */
  cleanupErrors?: Record<string, Error[]>;
}) {
  const projects = {
    list: () => input.projectRoots.map((root, i) => ({ id: `p${i}`, root })),
  } as unknown as ProjectStorePort;
  let rows: FakeThread[] =
    input.threads ?? (input.threadRunIds ? [{ id: "t1", run_ids: input.threadRunIds }] : []);
  const threads = {
    healthyProjectRoots: () => input.healthyRoots,
    // Like the store, a purged thread drops out of every listing; only the
    // retention pass lists it, to finish a cleanup that failed.
    listThreads: () => rows.filter((thread) => thread.state !== "purged"),
    listPurgedThreads: () => rows.filter((thread) => thread.state === "purged"),
    turnsFor: () => [],
  } as unknown as ProjectThreadPort;
  return {
    projects: () => projects,
    threads,
    daemonJobs: async () => input.records,
    purgeThread: async (id: string) => {
      rows = rows.map((thread) => (thread.id === id ? { ...thread, state: "purged" } : thread));
      const error = input.cleanupErrors?.[id]?.shift();
      if (error) throw error;
      const thread = rows.find((row) => row.id === id);
      if (thread?.repo) {
        for (const dir of ["threads", "lanes"]) {
          rmSync(join(projectRuntimeDir(thread.repo.root), dir, id), {
            recursive: true,
            force: true,
          });
        }
      }
      input.purged?.push(id);
      return { id, state: "purged" };
    },
    // The REAL leftover check of the purge owner, over the directories above.
    hasPurgeLeftovers: threadPurgeOwner(threads, noProjectRepoRoot()).hasPurgeLeftovers,
  };
}

const ancient = new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString();

describe("retention service composition", () => {
  it("selects generation ownership from the real default and override roots", async () => {
    const home = mkdtempSync(join(tmpdir(), "claudexor-retention-home-"));
    roots.push(home);
    process.env.HOME = home;
    delete process.env.CLAUDEXOR_CONFIG_DIR;
    const defaultRoot = join(home, ".claudexor");
    for (const name of ["v1", "v2", "v3"]) mkdirSync(join(defaultRoot, name), { recursive: true });
    writeFileSync(
      join(defaultRoot, "v3", "config.yaml"),
      "retention:\n  keep_last_runs_per_project: 0\n",
    );

    const defaultReceipt = await createRetentionRunner(
      deps({ projectRoots: [], healthyRoots: [], records: [] }),
    )({ dry_run: true, data_root_report: true });
    expect(defaultReceipt.data_root_unrecognized).toEqual(["v1"]);

    const overrideRoot = mkdtempSync(join(tmpdir(), "claudexor-retention-override-"));
    roots.push(overrideRoot);
    process.env.CLAUDEXOR_CONFIG_DIR = overrideRoot;
    for (const name of ["v1", "v2", "v3"]) {
      mkdirSync(join(overrideRoot, name), { recursive: true });
    }
    writeFileSync(
      join(overrideRoot, "config.yaml"),
      "retention:\n  keep_last_runs_per_project: 0\n",
    );

    const overrideReceipt = await createRetentionRunner(
      deps({ projectRoots: [], healthyRoots: [], records: [] }),
    )({ dry_run: true, data_root_report: true });
    expect(overrideReceipt.data_root_unrecognized).toEqual(["v1", "v2", "v3"]);
  });

  it("fails CLOSED for a project whose partition journal is quarantined (W3.6)", async () => {
    // The reference set (listThreads/turnsFor) only spans READY partitions. If
    // a quarantined project's runs were still swept, they would be judged
    // against an EMPTY reference set and a live thread's history would vanish.
    const root = projectWithAgedRun("run-quarantined");
    const run = await createRetentionRunner(
      deps({
        projectRoots: [root],
        healthyRoots: [], // partition not ready
        records: [{ runId: "run-quarantined", state: "succeeded", finishedAt: ancient }],
      }),
    )({ dry_run: true });
    // Not examined at all — the project is skipped, its runs protected.
    expect(run.deleted_runs).toEqual([]);
    expect(run.examined_runs).toBe(0);
  });

  it("sweeps a project once its partition is healthy", async () => {
    const root = projectWithAgedRun("run-healthy");
    const run = await createRetentionRunner(
      deps({
        projectRoots: [root],
        healthyRoots: [root],
        records: [{ runId: "run-healthy", state: "succeeded", finishedAt: ancient }],
      }),
    )({ dry_run: true });
    expect(run.examined_runs).toBe(1);
    expect(run.deleted_runs.map((d) => d.run_id)).toEqual(["run-healthy"]);
  });

  it("serializes concurrent passes — two never run at once", async () => {
    // Pinned on the property itself, not on its side effects: the tombstone
    // guard makes overlapping passes idempotent on DISK regardless, so a
    // deletion-count assertion would pass with no serialization at all. This
    // observes concurrency directly through a dep the pass must call.
    const root = projectWithAgedRun("run-serial");
    let active = 0;
    let peak = 0;
    const base = deps({
      projectRoots: [root],
      healthyRoots: [root],
      records: [{ runId: "run-serial", state: "succeeded", finishedAt: ancient }],
    });
    const runner = createRetentionRunner({
      ...base,
      daemonJobs: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        try {
          return await base.daemonJobs();
        } finally {
          active -= 1;
        }
      },
    });
    // The startup pass and an operator `gc` firing together.
    await Promise.all([runner({ dry_run: true }), runner({ dry_run: true })]);
    expect(peak).toBe(1);
  });
});

describe("expired trash purge in the retention pass (owner decision E2)", () => {
  const past = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const trashThreads: FakeThread[] = [
    { id: "t-expired", run_ids: ["run-trash-only"], state: "trashed", purge_after: past },
    { id: "t-fresh", run_ids: ["run-fresh"], state: "trashed", purge_after: future },
    { id: "t-active", run_ids: [], state: "active", purge_after: null },
  ];

  it("purges ONLY expired trash through the one purge owner and discloses it on opt-in", async () => {
    const purged: string[] = [];
    const runner = createRetentionRunner(
      deps({ projectRoots: [], healthyRoots: [], threads: trashThreads, records: [], purged }),
    );
    const receipt = await runner({ dry_run: false, trash_purge_report: true });
    expect(purged).toEqual(["t-expired"]);
    expect(receipt.purged_threads).toEqual(["t-expired"]);
    expect(receipt.errors).toEqual([]);
  });

  it("still purges without the opt-in but keeps the receipt key absent (version skew)", async () => {
    const purged: string[] = [];
    const receipt = await createRetentionRunner(
      deps({ projectRoots: [], healthyRoots: [], threads: trashThreads, records: [], purged }),
    )({ dry_run: false });
    expect(purged).toEqual(["t-expired"]);
    expect(receipt).not.toHaveProperty("purged_threads");
    expect(receipt).not.toHaveProperty("purge_leftovers");
  });

  it("dry run lists expired trash, deletes nothing, and previews its runs as unreferenced", async () => {
    const root = projectWithAgedRun("run-trash-only");
    const freshRun = join(new ArtifactStore(root).runsDir(), "run-fresh");
    mkdirSync(join(freshRun, "final"), { recursive: true });
    writeFileSync(join(freshRun, "final", "summary.md"), "# done\n");
    const purged: string[] = [];
    const receipt = await createRetentionRunner(
      deps({
        projectRoots: [root],
        healthyRoots: [root],
        threads: trashThreads,
        records: [
          { runId: "run-trash-only", state: "succeeded", finishedAt: ancient },
          { runId: "run-fresh", state: "succeeded", finishedAt: ancient },
        ],
        purged,
      }),
    )({ dry_run: true, trash_purge_report: true });
    expect(purged).toEqual([]);
    expect(receipt.purged_threads).toEqual(["t-expired"]);
    // The would-be-purged thread no longer protects its run in the preview;
    // the still-restorable trashed thread keeps protecting its own.
    expect(receipt.deleted_runs.map((d) => d.run_id)).toEqual(["run-trash-only"]);
    expect(receipt.kept.referenced).toBe(1);
  });

  it("keeps an expired thread with a live turn for a later pass and says why", async () => {
    const purged: string[] = [];
    const receipt = await createRetentionRunner(
      deps({
        projectRoots: [],
        healthyRoots: [],
        threads: trashThreads,
        records: [{ state: "running", params: { threadId: "t-expired", mode: "ask" } }],
        purged,
      }),
    )({ dry_run: false, trash_purge_report: true });
    expect(purged).toEqual([]);
    expect(receipt.purged_threads).toEqual([]);
    expect(receipt.errors).toEqual([
      "expired trash thread t-expired kept: a turn is still running",
    ]);
  });

  it("sees a live turn through the in-process activity projection the daemon feeds it", async () => {
    const sqlRoot = realpathSync(mkdtempSync(join(tmpdir(), "retention-sql-")));
    roots.push(sqlRoot);
    const sql = await sqlFixture(sqlRoot);
    sqlStores.push(sql);
    const commands = sql.graph.commands.current();
    commands.accept({
      id: "job-turn",
      params: { threadId: "t-expired", mode: "ask", scope: { kind: "none" }, prompt: "p" },
      idempotencyKey: "turn",
      clientId: "fixture",
    });
    const turn = (state: "running" | "succeeded") => {
      commands.update("job-turn", { runId: "run-turn", state });
      return sqlActivityRecords(sql.store);
    };
    const purged: string[] = [];
    const kept = await createRetentionRunner(
      deps({
        projectRoots: [],
        healthyRoots: [],
        threads: trashThreads,
        records: turn("running"),
        purged,
      }),
    )({ dry_run: false, trash_purge_report: true });
    expect(purged).toEqual([]);
    expect(kept.purged_threads).toEqual([]);
    expect(kept.errors).toEqual(["expired trash thread t-expired kept: a turn is still running"]);
    // A finished turn no longer holds the expired thread back.
    const preview = await createRetentionRunner(
      deps({
        projectRoots: [],
        healthyRoots: [],
        threads: trashThreads,
        records: turn("succeeded"),
      }),
    )({ dry_run: true, trash_purge_report: true });
    expect(preview.purged_threads).toEqual(["t-expired"]);
  });

  it("discloses a cleanup error after the purge commit, and the next pass finishes that purge", async () => {
    const root = projectWithThreadDirs("t-expired");
    const purged: string[] = [];
    const runner = createRetentionRunner(
      deps({
        projectRoots: [root],
        healthyRoots: [root],
        threads: [
          {
            id: "t-expired",
            run_ids: [],
            state: "trashed",
            purge_after: past,
            repo: { root },
            workspace: { mode: "isolated" },
          },
        ],
        records: [],
        purged,
        cleanupErrors: { "t-expired": [new Error("worktree removal failed")] },
      }),
    );
    const first = await runner({ dry_run: false, trash_purge_report: true });
    expect(first.purged_threads).toEqual([]);
    expect(first.purge_leftovers).toEqual([]);
    expect(first.errors).toEqual(["expired trash thread t-expired: worktree removal failed"]);
    // Journaled `purged` (hidden, no Restore) while its worktree stays on disk.
    expect(existsSync(worktreeDir(root, "t-expired"))).toBe(true);

    const second = await runner({ dry_run: false, trash_purge_report: true });
    expect(second.purge_leftovers).toEqual(["t-expired"]);
    expect(second.errors).toEqual([]);
    expect(existsSync(worktreeDir(root, "t-expired"))).toBe(false);
    expect(purged).toEqual(["t-expired"]);

    // Nothing is left on disk, so the next pass has nothing to finish.
    const third = await runner({ dry_run: false, trash_purge_report: true });
    expect(third.purge_leftovers).toEqual([]);
    expect(purged).toEqual(["t-expired"]);
  });

  it("retries a purge whose cleanup hit ENOTEMPTY (a Windows lock) until the directory goes", async () => {
    // The purge route already journaled `purged`; its cleanup failed and left both directories.
    const root = projectWithThreadDirs("t-locked");
    const enotempty = Object.assign(
      new Error(`ENOTEMPTY: directory not empty, rmdir '${worktreeDir(root, "t-locked")}'`),
      { code: "ENOTEMPTY" },
    );
    const purged: string[] = [];
    const runner = createRetentionRunner(
      deps({
        projectRoots: [root],
        healthyRoots: [root],
        threads: [
          {
            id: "t-locked",
            run_ids: [],
            state: "purged",
            repo: { root },
            workspace: { mode: "isolated" },
          },
        ],
        records: [],
        purged,
        cleanupErrors: { "t-locked": [enotempty] },
      }),
    );
    const first = await runner({ dry_run: false, trash_purge_report: true });
    expect(first.purge_leftovers).toEqual([]);
    expect(first.errors).toEqual([`purged thread t-locked cleanup: ${enotempty.message}`]);
    expect(existsSync(worktreeDir(root, "t-locked"))).toBe(true);

    const second = await runner({ dry_run: false, trash_purge_report: true });
    expect(second.purge_leftovers).toEqual(["t-locked"]);
    expect(second.errors).toEqual([]);
    expect(existsSync(worktreeDir(root, "t-locked"))).toBe(false);
    expect(purged).toEqual(["t-locked"]);
  });

  it("dry run lists an unfinished purge without deleting; a finished purge is left alone", async () => {
    const root = projectWithThreadDirs("t-leftover");
    const purged: string[] = [];
    const isolated = { repo: { root }, workspace: { mode: "isolated" } };
    const receipt = await createRetentionRunner(
      deps({
        projectRoots: [root],
        healthyRoots: [root],
        threads: [
          { id: "t-leftover", run_ids: [], state: "purged", ...isolated },
          { id: "t-done", run_ids: [], state: "purged", ...isolated },
        ],
        records: [],
        purged,
      }),
    )({ dry_run: true, trash_purge_report: true });
    expect(receipt.purge_leftovers).toEqual(["t-leftover"]);
    expect(purged).toEqual([]);
    expect(existsSync(worktreeDir(root, "t-leftover"))).toBe(true);
  });

  it("the startup pass requests the trash disclosure and logs the purge count", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "claudexor-retention-log-"));
    roots.push(logDir);
    const logPath = join(logDir, "daemon.log");
    const requests: unknown[] = [];
    const runner = createRetentionRunner(
      deps({ projectRoots: [], healthyRoots: [], threads: trashThreads, records: [] }),
    );
    scheduleStartupRetention(
      async (request) => {
        requests.push(request);
        return runner(request);
      },
      { logPath, shuttingDown: () => false, delayMs: 0 },
    );
    const readLog = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
    for (let i = 0; i < 500 && !readLog().includes("retention:"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(requests).toEqual([{ dry_run: false, trash_purge_report: true }]);
    expect(readLog()).toContain("1 expired trash threads");
  });
});
