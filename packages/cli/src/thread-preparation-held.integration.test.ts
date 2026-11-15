import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ScopeReapOptions, ScopeReapOutcome } from "@claudexor/core";
import { projectRuntimeDir } from "@claudexor/util";
import { afterEachClosed } from "./test-support/after-each-closed.js";
import {
  endIdentified,
  startOf,
  until,
  type Identity,
} from "../../core/src/test-support/process-fixtures.js";

/**
 * #694 r12 through the production daemon runner: a Stop during an accepted
 * thread turn's worktree add whose survivor the preparation's scope could NOT end
 * leaves the tree, its registration and its new branch held with their record;
 * Retry refuses (rewriting nothing), and so does a NEW daemon instance on the same
 * data (fresh modules, the same store and record files); once the survivor ended,
 * the next turn releases and recreates the tree and runs. A daemon that died
 * midway (a record and a half checkout, no Stop) is the same: refused while a
 * member of its scope lives, released once it ended. A Stop earlier, during the
 * base snapshot and before anything of the thread exists, leaves the
 * preparation's early record instead: the same refusals, with no second snapshot
 * while the survivor lives.
 *
 * Real: runtime, scheduler, runner, SQL store, Git, the release criterion (its
 * census and group probes). The ONE injected seam is the daemon's reap
 * (`reapScopeMembers`, which the scope's settlement calls): while `spare` names a
 * pid, that settlement reports it as a member it could not end (as for a process
 * it may not signal) instead of ending it. The survivor is this test's own
 * grandchild, ended by its exact identity.
 */
const spare: { pid: number | null } = { pid: null };
/** r17: while set, the daemon's release read proves nothing (as on Windows): a
 * quiet answer comes back `unproven`. A second declared seam, read-only. */
const unprovable = { on: false };
vi.mock("@claudexor/core", async (original) => {
  const real = await original<typeof import("@claudexor/core")>();
  return {
    ...real,
    preparationQuiet: async (...args: Parameters<typeof real.preparationQuiet>) => {
      const verdict = await real.preparationQuiet(...args);
      return unprovable.on && verdict.status === "quiet" && verdict.unproven === undefined
        ? { ...verdict, unproven: "injected: no read can prove it on this platform" }
        : verdict;
    },
    reapScopeMembers: async (opts: ScopeReapOptions): Promise<ScopeReapOutcome> => {
      if (spare.pid === null) return real.reapScopeMembers(opts);
      return {
        coverage: "marker+capture",
        census: "ok",
        censusFailure: null,
        ended: [],
        survivors: [{ pid: spare.pid, startToken: "spared" }],
        unreadable: [],
        reusedGroups: [],
        settled: false,
        incomplete: false,
        completeness: "not_provable",
        completenessReason: null,
        restricted: false,
        durationMs: 0,
      } as unknown as ScopeReapOutcome;
    },
  };
});
vi.mock("./run-orchestrator.js", () => ({
  buildRunOrchestrator: () => ({
    async run(input: Record<string, unknown>) {
      const { Orchestrator } = await import("@claudexor/orchestrator");
      const { createFakeHarness } = await import("@claudexor/harness-fake");
      return await new Orchestrator({
        registry: new Map([["fake-success", createFakeHarness("fake-success")]]),
        reviewers: [],
      }).run(input as never);
    },
  }),
}));

const cleanups: Array<() => void | Promise<void>> = [];
const removals: Array<() => void> = [];
const own: Identity[] = [];
const configDir = process.env.CLAUDEXOR_CONFIG_DIR;
/** End this test's own processes by measured identity (`endIdentified`). */
const endOwn = (): Promise<void> => endIdentified(own);
async function identified(pid: number): Promise<{ pid: number; start: string }> {
  let start: string | "gone" | null = null;
  await until("a start time", () => (start = startOf(pid)) !== null);
  if (start === "gone") throw new Error(`process ${pid} ended before it was identified`);
  const entry = { pid, start: start as unknown as string };
  own.push(entry);
  return entry;
}
afterEachClosed(async () => {
  spare.pid = null;
  unprovable.on = false;
  await endOwn();
  const ownedRemovals = removals.splice(0).reverse();
  for (const fn of cleanups.splice(0).reverse()) await fn();
  return () => {
    for (const remove of ownedRemovals) remove();
    for (const key of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"])
      delete process.env[key];
    if (configDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = configDir;
  };
});

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const git = (repo: string, ...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { env: GIT_ENV })
    .toString("utf8")
    .trim();
function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  removals.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "interrupted", "blocked"]);

/** One daemon instance over `daemonDir` (fresh modules: a new process's state). */
async function daemonInstance(daemonDir: string, fresh: boolean) {
  vi.resetModules();
  const { EngineStore, createPartition, createSqlDaemonServices, setGlobalGenerationInTx } =
    await import("@claudexor/daemon");
  const { createSqlDaemonRuntime } = await import("./sql-daemon-runtime.js");
  const store = await EngineStore.open({
    daemonDir,
    workerEntry: resolve(import.meta.dirname, "../../daemon/dist/store/flusher-worker.js"),
  });
  // A new store gets its generation once; a restarted one keeps what it recorded.
  if (fresh)
    store.transaction(() => setGlobalGenerationInTx(store, createPartition(store, "global").pid));
  const graph = createSqlDaemonServices(store, { purgeFiles: async () => [] });
  const runtime = createSqlDaemonRuntime(graph, {
    server: { socketPath: join(daemonDir, "..", `u-${Date.now()}.sock`), token: "fixture" },
    authReadiness: () => ({ invalidate: () => {} }),
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await runtime.stop();
    await graph.close();
    await store.close();
  };
  cleanups.push(stop);
  return { graph, runtime, stop };
}

/** The held part of the filter: ONE process (the shell `exec`s it) that announces
 * itself (`holding`, by rename), blocks while the test directory exists, then
 * passes its input through. A `/bin/sh` loop of short `sleep`s does not end
 * reliably on a group SIGINT: the shell can miss one that lands just as a `sleep`
 * exits and would stand for a survivor no test meant. A test stops
 * only once the holder announced itself: then no shell is left in Git's group. */
const HOLD_JS =
  "const fs=require('node:fs');const [root,holding]=process.argv.slice(2);" +
  "fs.writeFileSync(holding+'.tmp','');fs.renameSync(holding+'.tmp',holding);" +
  "const t=setInterval(()=>{if(!fs.existsSync(root)){" +
  "clearInterval(t);process.stdin.pipe(process.stdout);}},20);";
/** A project whose `y.held` filter (`side`: smudge runs in the checkout, clean in
 * the base snapshot), while `hold` exists, starts a survivor (own group, Git's
 * stderr, the preparation's marker) and blocks. Each filter run is logged. */
async function fixture(side: "smudge" | "clean" = "smudge") {
  const root = temp("cx-tph-");
  process.env.CLAUDEXOR_CONFIG_DIR = temp("cx-tph-config-");
  const repo = join(root, "project");
  mkdirSync(repo);
  writeFileSync(join(repo, ".gitattributes"), "*.held filter=held\n");
  writeFileSync(join(repo, "y.held"), "user data\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  // The base snapshot must run the clean filter on `y.held` every time: Git hashes
  // a tracked file again only when its stat differs from the index entry (or the
  // two were written within one second). Its content stays; its time does not.
  const earlier = new Date(Date.now() - 60_000);
  utimesSync(join(repo, "y.held"), earlier, earlier);
  const hold = join(root, "hold");
  const survivorFile = join(root, "survivor");
  const spawnSurvivor = join(root, "survivor.cjs");
  writeFileSync(
    spawnSurvivor,
    `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','ignore',2]});const f=require('node:fs');f.writeFileSync(${JSON.stringify(`${survivorFile}.tmp`)},String(c.pid));f.renameSync(${JSON.stringify(`${survivorFile}.tmp`)},${JSON.stringify(survivorFile)});c.unref();`,
  );
  const holder = join(root, "hold.cjs");
  const holding = join(root, "holding");
  writeFileSync(holder, HOLD_JS);
  const program = join(root, "filter.sh");
  const runs = join(root, "filter.log");
  writeFileSync(
    program,
    `#!/bin/sh\necho run >> '${runs}'\nif [ -e '${hold}' ] && [ ! -e '${survivorFile}' ]; then '${process.execPath}' '${spawnSurvivor}'; exec '${process.execPath}' '${holder}' '${root}' '${holding}'; fi\nexec cat\n`,
    { mode: 0o755 },
  );
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = `filter.held.${side}`;
  process.env.GIT_CONFIG_VALUE_0 = program;
  const daemonDir = join(root, "daemon");
  let instance = await daemonInstance(daemonDir, true);
  const thread = instance.graph.threads.createThread({
    repoRoot: repo,
    workspace: "isolated",
    primaryHarness: "fake-success",
    eligibleHarnesses: ["fake-success"],
  });
  const turn = async (prompt: string) => {
    const created = instance.graph.threads.createTurn(thread.id, prompt);
    const { id } = await instance.runtime.client.enqueue({
      prompt,
      mode: "agent",
      scope: { kind: "project", root: repo },
      harnesses: ["fake-success"],
      threadId: thread.id,
      turnId: created.id,
    });
    return { turnId: created.id, jobId: id };
  };
  const terminal = (id: string) =>
    vi.waitFor(
      async () => {
        const record = await instance.runtime.client.status(id);
        expect(TERMINAL.has(record.state)).toBe(true);
        return record;
      },
      { timeout: 60_000, interval: 25 },
    );
  const treePath = join(projectRuntimeDir(repo), "threads", thread.id, "tree");
  return {
    repo,
    thread,
    turn,
    terminal,
    treePath,
    recordPath: join(treePath, "..", "preparation.json"),
    /** How many times the filter ran so far. */
    filterRuns: () => (existsSync(runs) ? readFileSync(runs, "utf8").trim().split("\n").length : 0),
    turnError: (turnId: string) => instance.graph.threads.getTurn(turnId)?.enqueue_error,
    cancel: (jobId: string) => instance.runtime.client.cancel(jobId),
    status: (jobId: string) => instance.runtime.client.status(jobId),
    hold: () => writeFileSync(hold, ""),
    unhold: () => rmSync(hold, { force: true }),
    /** The filter's holder announced itself: the shell is gone from Git's group. */
    holding: () => until("the holder to announce itself", () => existsSync(holding)),
    survivor: async () => {
      await until("the survivor to report", () => existsSync(survivorFile));
      return identified(Number(readFileSync(survivorFile, "utf8")));
    },
    /** The daemon's registered held preparation maintenance (#694 r17). */
    maintenance: () => instance.runtime.controlRoutes,
    /** Stop this daemon instance and start a new one on the same data. */
    restart: async () => {
      await instance.stop();
      instance = await daemonInstance(daemonDir, false);
    },
  };
}

describe.runIf(process.platform !== "win32")(
  "a held thread preparation through the daemon runner (#694 r12)",
  () => {
    it("Stop with a survivor the scope could not end: held, Retry and a new daemon refuse, the end releases and the next turn runs", async () => {
      const f = await fixture();
      f.hold();
      const first = await f.turn("edit, then stop");
      const survivor = await f.survivor();
      spare.pid = survivor.pid; // the daemon's settlement cannot end it
      await f.holding();
      expect((await f.status(first.jobId)).state).toBe("running");
      await f.cancel(first.jobId);
      const stopped = await f.terminal(first.jobId);
      expect(stopped.state).toBe("cancelled"); // the user's Stop, whatever stays held
      expect(stopped.runId).toBeUndefined(); // no run was invented
      expect(startOf(survivor.pid)).toBe(survivor.start);
      // The turn's refusal discloses the unconfirmed stop and what is held.
      expect(f.turnError(first.turnId)).toMatchObject({
        code: "termination_unconfirmed",
        context: { held: [f.treePath], termination_unconfirmed: { reason: "output_held" } },
      });
      // Nothing is removed under the survivor: the record and the new branch stay
      // (Git's own interrupted `worktree add` may have dropped its fresh directory).
      const record = readFileSync(f.recordPath, "utf8");
      expect(JSON.parse(record)).toMatchObject({
        held: { reason: "output_held" },
        own_branch: { name: `claudexor/thread-${f.thread.id}` },
      });
      expect(git(f.repo, "branch", "--list", `claudexor/thread-${f.thread.id}`)).not.toBe("");

      // Retry: refused by the read-only release, nothing rewritten, no signal sent.
      f.unhold();
      const retry = await f.turn("edit");
      expect((await f.terminal(retry.jobId)).runId).toBeUndefined();
      expect(f.turnError(retry.turnId)).toMatchObject({
        code: "termination_unconfirmed",
        retryable: true,
      });
      expect(readFileSync(f.recordPath, "utf8")).toBe(record);
      expect(startOf(survivor.pid)).toBe(survivor.start);

      // A new daemon instance on the same data: the same refusal from the same files.
      await f.restart();
      const afterRestart = await f.turn("edit");
      expect((await f.terminal(afterRestart.jobId)).runId).toBeUndefined();
      expect(f.turnError(afterRestart.turnId)).toMatchObject({ code: "termination_unconfirmed" });
      expect(readFileSync(f.recordPath, "utf8")).toBe(record);

      // The survivor ends: the next turn releases, recreates the tree and runs.
      spare.pid = null;
      await endOwn();
      const next = await f.turn("edit");
      const done = await f.terminal(next.jobId);
      expect(done.state).toBe("succeeded");
      expect(done.runId).toEqual(expect.any(String));
      expect(existsSync(f.recordPath)).toBe(false);
      expect(readFileSync(join(f.treePath, "y.held"), "utf8")).toBe("user data\n");
    }, 240_000);

    it("r17: where no read can prove the end, a held preparation stays held for every turn and after a restart; the daemon's maintenance lists it and releases it on the operator's confirmation, and the next turn runs", async () => {
      const f = await fixture();
      f.hold();
      const first = await f.turn("edit, then stop");
      const survivor = await f.survivor();
      spare.pid = survivor.pid;
      await f.holding();
      await f.cancel(first.jobId);
      expect((await f.terminal(first.jobId)).state).toBe("cancelled");
      // The survivor ends, but from now on no read can prove that (as on Windows).
      spare.pid = null;
      await endOwn();
      unprovable.on = true;
      f.unhold();
      const record = readFileSync(f.recordPath, "utf8");
      const retry = await f.turn("edit");
      expect((await f.terminal(retry.jobId)).runId).toBeUndefined();
      expect(f.turnError(retry.turnId)).toMatchObject({
        code: "termination_unconfirmed",
        context: { held: [f.treePath], release_requires: "operator_confirmation" },
      });
      await f.restart();
      const afterRestart = await f.turn("edit");
      expect((await f.terminal(afterRestart.jobId)).runId).toBeUndefined();
      expect(f.turnError(afterRestart.turnId)).toMatchObject({
        context: { release_requires: "operator_confirmation" },
      });
      expect(readFileSync(f.recordPath, "utf8")).toBe(record);
      // The new daemon's maintenance finds it (its known roots) and reads it fresh.
      const held = await f.maintenance().heldPreparations();
      const item = held.preparations.find((entry) => entry.kind === "thread");
      expect(item).toMatchObject({
        path: f.treePath,
        thread_id: f.thread.id,
        stop: { reason: "output_held" },
        release: "operator_confirmation",
        refusal: null,
      });
      const serialized: string[] = [];
      const serialize = <T>(threadId: string, work: () => Promise<T>) => {
        serialized.push(threadId);
        return work();
      };
      expect(
        await f
          .maintenance()
          .releasePreparation(
            { selector: item!.selector, digest: "0".repeat(64), confirm_processes_ended: true },
            serialize,
          ),
      ).toMatchObject({ outcome: "stale" });
      expect(readFileSync(f.recordPath, "utf8")).toBe(record);
      const released = await f
        .maintenance()
        .releasePreparation(
          { selector: item!.selector, digest: item!.digest, confirm_processes_ended: true },
          serialize,
        );
      expect(released).toMatchObject({
        outcome: "released",
        basis: "operator_confirmed",
        continued: false,
      });
      expect(serialized).toEqual([f.thread.id, f.thread.id]);
      expect(existsSync(f.recordPath)).toBe(false);
      // The stopped turn stays what it was: cancelled, no run invented.
      expect((await f.status(first.jobId)).state).toBe("cancelled");
      const next = await f.turn("edit");
      const done = await f.terminal(next.jobId);
      expect(done.state).toBe("succeeded");
      expect(readFileSync(join(f.treePath, "y.held"), "utf8")).toBe("user data\n");
      expect(existsSync(f.recordPath)).toBe(false);
    }, 240_000);

    it("Stop during the base snapshot, before anything of the thread exists, with a survivor the scope could not end: the early record holds, Retry and a new daemon refuse without a second snapshot, the end releases and the next turn runs", async () => {
      const f = await fixture("clean");
      const branch = `claudexor/thread-${f.thread.id}`;
      f.hold();
      const first = await f.turn("edit, then stop");
      const survivor = await f.survivor();
      spare.pid = survivor.pid; // the daemon's settlement cannot end it
      await f.holding();
      // Durable while the snapshot still runs: before the Stop, with nothing made.
      expect(JSON.parse(readFileSync(f.recordPath, "utf8"))).toMatchObject({
        early: true,
        own_registration: null,
        own_branch: null,
      });
      const snapshots = f.filterRuns();
      expect(snapshots).toBeGreaterThan(0);
      await f.cancel(first.jobId);
      const stopped = await f.terminal(first.jobId);
      expect(stopped.state).toBe("cancelled");
      expect(stopped.runId).toBeUndefined();
      expect(startOf(survivor.pid)).toBe(survivor.start);
      // The refusal is typed and discloses the unconfirmed stop of the early step.
      expect(f.turnError(first.turnId)).toMatchObject({
        code: "termination_unconfirmed",
        retryable: true,
        context: {
          termination_unconfirmed: { reason: "output_held" },
          preparation: { early: true, record: f.recordPath },
        },
      });
      const record = readFileSync(f.recordPath, "utf8");
      expect(JSON.parse(record)).toMatchObject({ early: true, held: { reason: "output_held" } });
      expect(existsSync(f.treePath)).toBe(false);
      expect(git(f.repo, "branch", "--list", branch)).toBe("");

      // Retry: refused by the read-only release; no second snapshot, nothing rewritten.
      f.unhold();
      const retry = await f.turn("edit");
      expect((await f.terminal(retry.jobId)).runId).toBeUndefined();
      expect(f.turnError(retry.turnId)).toMatchObject({
        code: "termination_unconfirmed",
        retryable: true,
      });
      expect(f.filterRuns()).toBe(snapshots);
      expect(readFileSync(f.recordPath, "utf8")).toBe(record);
      expect(startOf(survivor.pid)).toBe(survivor.start);

      // A new daemon instance (a fresh runner) on the same data: the same refusal.
      await f.restart();
      const afterRestart = await f.turn("edit");
      expect((await f.terminal(afterRestart.jobId)).runId).toBeUndefined();
      expect(f.turnError(afterRestart.turnId)).toMatchObject({ code: "termination_unconfirmed" });
      expect(f.filterRuns()).toBe(snapshots);
      expect(readFileSync(f.recordPath, "utf8")).toBe(record);

      // The writer ends, but the record cannot be removed (its directory is read-only):
      // the proven end is a typed cleanup refusal through the daemon, never an
      // unconfirmed termination; nothing is rewritten and no second snapshot runs.
      spare.pid = null;
      await endOwn();
      const threadDir = dirname(f.recordPath);
      chmodSync(threadDir, 0o500);
      try {
        const blocked = await f.turn("edit");
        expect((await f.terminal(blocked.jobId)).runId).toBeUndefined();
        const refusal = f.turnError(blocked.turnId);
        expect(refusal).toMatchObject({
          code: "preparation_cleanup_failed",
          retryable: true,
          context: {
            held: [f.treePath],
            preparation: { early: true, cleanup_error: expect.stringContaining("EACCES") },
          },
        });
        expect(refusal?.context).not.toHaveProperty("termination_unconfirmed");
        expect(f.filterRuns()).toBe(snapshots);
        expect(readFileSync(f.recordPath, "utf8")).toBe(record);
      } finally {
        chmodSync(threadDir, 0o700);
      }

      // The fault is gone: the next turn frees the record, makes the tree and runs.
      const next = await f.turn("edit");
      const done = await f.terminal(next.jobId);
      expect(done.state).toBe("succeeded");
      expect(done.runId).toEqual(expect.any(String));
      expect(existsSync(f.recordPath)).toBe(false);
      expect(f.filterRuns()).toBeGreaterThan(snapshots);
      expect(readFileSync(join(f.treePath, "y.held"), "utf8")).toBe("user data\n");
    }, 240_000);

    it("a daemon that died midway (record, half checkout, no Stop): refused while its scope's member lives, then the turn runs", async () => {
      const f = await fixture();
      const { mintRunScopeMarker, scopeMarkerEnv } = await import("@claudexor/core");
      const marker = mintRunScopeMarker();
      mkdirSync(f.treePath, { recursive: true });
      writeFileSync(join(f.treePath, ".git"), "gitdir: /nowhere\n"); // a half checkout
      writeFileSync(
        f.recordPath,
        JSON.stringify({
          schema: 1,
          thread_id: f.thread.id,
          tree: f.treePath,
          scope: { marker },
          opened_at: new Date().toISOString(),
          own_registration: true,
          own_branch: null,
        }),
      );
      // A process of that scope (a hook's background job) is still alive.
      const writer = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        env: { ...process.env, ...scopeMarkerEnv(marker) },
        stdio: "ignore",
      });
      await identified(writer.pid!);
      const refused = await f.turn("edit");
      expect((await f.terminal(refused.jobId)).runId).toBeUndefined();
      expect(f.turnError(refused.turnId)).toMatchObject({ code: "termination_unconfirmed" });
      expect(existsSync(join(f.treePath, ".git"))).toBe(true); // never taken, never removed
      await endOwn();
      const next = await f.turn("edit");
      expect((await f.terminal(next.jobId)).state).toBe("succeeded");
      expect(readFileSync(join(f.treePath, "y.held"), "utf8")).toBe("user data\n");
    }, 180_000);
  },
);
