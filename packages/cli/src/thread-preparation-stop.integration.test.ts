import { execFileSync } from "node:child_process";
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
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  EngineStore,
  createPartition,
  createSqlDaemonServices,
  setGlobalGenerationInTx,
} from "@claudexor/daemon";
import { projectRuntimeDir } from "@claudexor/util";
import { createSqlDaemonRuntime } from "./sql-daemon-runtime.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";
import {
  allAlive,
  allEnded,
  identify,
  publishedPids,
  stateOf,
} from "../../core/src/test-support/process-fixtures.js";

/**
 * #694 through the production daemon: an accepted thread turn is a RUNNING job
 * before its isolated-thread worktree is prepared. Stop (cancelJob) aborts that
 * job's signal; the preparation must end, the job settle cancelled with no run,
 * and the turn keep an honest refusal (with any partial Git initialization) so
 * the next turn of the same thread runs. The runtime, scheduler, runner, SQL
 * store and Git are real; only the orchestrator builder is the real Orchestrator
 * over the offline fake harness, as in `terminal-staging-wiring.test.ts`.
 *
 * POSIX-only (`posixDescribe`): the fixture is a `#!/bin/sh` filter, and the
 * scenarios assert that Stop INTERRUPTS `git worktree add` and the first
 * initialization's `git add`. On Windows those steps take the user's locks and
 * finish before the stop is taken (`userLockStep`); that boundary is proven with
 * an injected platform in packages/workspace/src/preparation-stop-outcome.test.ts.
 */
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
const configDir = process.env.CLAUDEXOR_CONFIG_DIR;
afterEachClosed(async () => {
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

/** The held part of a fixture filter: ONE process that publishes its own pid and
 * its parent's (Git's) in `pids` (by rename), waits for `release` (or for its test
 * directory to go) and then passes its input through. A signal sent to its group
 * ends it at once. A `/bin/sh` loop of short `sleep`s does not do that reliably:
 * the shell can miss a SIGINT that lands just as a foreground child exits, and
 * would then stand for a survivor no test meant.
 * The holder publishes itself only after the shell's `exec` replaced it, so a test
 * that stops once it is published leaves no shell in Git's group. */
const HOLD_JS =
  "const fs=require('node:fs');const [release,root,pids]=process.argv.slice(2);" +
  "fs.mkdirSync(pids,{recursive:true});const own=pids+'/'+process.pid;" +
  "fs.writeFileSync(own+'.tmp',process.pid+' '+process.ppid);fs.renameSync(own+'.tmp',own);" +
  "const t=setInterval(()=>{if((release&&fs.existsSync(release))||!fs.existsSync(root)){" +
  "clearInterval(t);process.stdin.pipe(process.stdout);}},20);";
/** Write that program under `root`; returns the shell words that `exec` it. */
function holdUntil(root: string, release: string, pids: string): string {
  const program = join(root, "hold-until.cjs");
  writeFileSync(program, HOLD_JS);
  return `exec '${process.execPath}' '${program}' '${release}' '${root}' '${pids}'`;
}

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  removals.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "interrupted", "blocked"]);

/**
 * A project whose `.held` files pass through a filter that holds while `<root>/hold`
 * exists. `side` picks which filter holds: `smudge` holds the thread worktree's
 * checkout; `clean` holds the `git add` of a folder's first initialization.
 */
async function fixture(side: "smudge" | "clean", repository: boolean, survivor = false) {
  const root = temp("cx-tps-");
  process.env.CLAUDEXOR_CONFIG_DIR = temp("cx-tps-config-");
  const repo = join(root, "project");
  mkdirSync(repo);
  writeFileSync(join(repo, ".gitattributes"), "*.held filter=held\n");
  writeFileSync(join(repo, "y.held"), "user data\n");
  if (repository) {
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    writeFileSync(join(repo, "notes.txt"), "untracked user work\n");
  }
  const hold = join(root, "hold");
  const pids = join(root, "pids");
  const release = join(root, "release");
  const program = join(root, "filter.sh");
  // `survivor`: the filter also starts a process in its own group that keeps
  // Git's stderr open and outlives Git (a hook's background job).
  const spawnSurvivor = join(root, "survivor.cjs");
  const survivors = join(root, "survivors");
  writeFileSync(
    spawnSurvivor,
    `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','ignore',2]});const f=require('node:fs');f.mkdirSync(${JSON.stringify(survivors)},{recursive:true});f.writeFileSync(${JSON.stringify(survivors)}+'/'+c.pid+'.tmp',String(c.pid));f.renameSync(${JSON.stringify(survivors)}+'/'+c.pid+'.tmp',${JSON.stringify(survivors)}+'/'+c.pid);c.unref();`,
  );
  const start = survivor ? `'${process.execPath}' '${spawnSurvivor}'; ` : "";
  writeFileSync(
    program,
    `#!/bin/sh\nif [ -e '${hold}' ]; then ${start}${holdUntil(root, release, pids)}; fi\nexec cat\n`,
    { mode: 0o755 },
  );
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = `filter.held.${side}`;
  process.env.GIT_CONFIG_VALUE_0 = program;

  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: resolve(import.meta.dirname, "../../daemon/dist/store/flusher-worker.js"),
  });
  cleanups.push(() => store.close());
  store.transaction(() => setGlobalGenerationInTx(store, createPartition(store, "global").pid));
  const graph = createSqlDaemonServices(store, { purgeFiles: async () => [] });
  cleanups.push(() => graph.close());
  const runtime = createSqlDaemonRuntime(graph, {
    server: { socketPath: join(root, "u.sock"), token: "fixture" },
    authReadiness: () => ({ invalidate: () => {} }),
  });
  cleanups.push(() => runtime.stop());
  // Runs first (cleanups unwind in reverse): no held child outlives the test, and a
  // daemon that ignored Stop is not left waiting on it while it stops.
  cleanups.push(() => writeFileSync(release, ""));
  const thread = graph.threads.createThread({
    repoRoot: repo,
    workspace: "isolated",
    primaryHarness: "fake-success",
    eligibleHarnesses: ["fake-success"],
  });
  const turn = async (prompt: string) => {
    const created = graph.threads.createTurn(thread.id, prompt);
    const { id } = await runtime.client.enqueue({
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
        const record = await runtime.client.status(id);
        expect(TERMINAL.has(record.state)).toBe(true);
        return record;
      },
      { timeout: 60_000, interval: 25 },
    );
  const treePath = join(projectRuntimeDir(repo), "threads", thread.id, "tree");
  return {
    repo,
    runtime,
    graph,
    thread,
    turn,
    terminal,
    treePath,
    hold: () => writeFileSync(hold, ""),
    unhold: () => rmSync(hold, { force: true }),
    held: () => publishedPids(pids),
    survivors: () => publishedPids(survivors),
  };
}

const posixDescribe = describe.runIf(process.platform !== "win32");

posixDescribe("Stop during an accepted thread turn's worktree preparation (#694)", () => {
  it("cancels the running job before any run, keeps the user's repository, and the thread's next turn runs", async () => {
    const f = await fixture("smudge", true);
    const userState = () => ({
      head: git(f.repo, "rev-parse", "HEAD"),
      status: git(f.repo, "status", "--porcelain"),
      index: git(f.repo, "ls-files", "-s"),
      data: readFileSync(join(f.repo, "y.held"), "utf8"),
    });
    const before = userState();
    f.hold();
    const first = await f.turn("edit, then stop");
    await vi.waitFor(() => expect(f.held().length).toBeGreaterThanOrEqual(2), {
      timeout: 60_000,
      interval: 20,
    });
    expect((await f.runtime.client.status(first.jobId)).state).toBe("running");
    const held = await identify(f.held());
    expect(await allAlive(held)).toBe(true);
    await f.runtime.client.cancel(first.jobId);
    await f.runtime.client.cancel(first.jobId); // a repeated Stop changes nothing
    const record = await f.terminal(first.jobId);
    expect(record.state).toBe("cancelled");
    expect(record.runId).toBeUndefined(); // no run was invented
    await vi.waitFor(() => expect(allEnded(held)).toBe(true), { timeout: 10_000 });
    const refused = f.graph.threads.getTurn(first.turnId)?.enqueue_error;
    expect(refused?.message).toContain("preparation stopped");
    // Nothing of the stopped worktree remains; the user's repository is untouched.
    expect(git(f.repo, "worktree", "list", "--porcelain")).not.toContain(f.treePath);
    expect(git(f.repo, "branch", "--list", `claudexor/thread-${f.thread.id}`)).toBe("");
    expect(userState()).toEqual(before);

    f.unhold();
    const next = await f.turn("edit");
    const done = await f.terminal(next.jobId);
    expect(done.state).toBe("succeeded");
    expect(done.runId).toEqual(expect.any(String));
    expect(f.graph.threads.getThread(f.thread.id)?.workspace).toMatchObject({
      mode: "isolated",
      worktree_path: f.treePath,
    });
    expect(readFileSync(join(f.treePath, "y.held"), "utf8")).toBe("user data\n");
    expect(userState()).toEqual(before);
  }, 180_000);

  it("a stop during the folder's first Git initialization keeps the partial receipt on the turn", async () => {
    const f = await fixture("clean", false);
    f.hold();
    const first = await f.turn("edit, then stop");
    await vi.waitFor(() => expect(f.held().length).toBeGreaterThanOrEqual(2), {
      timeout: 60_000,
      interval: 20,
    });
    const held = await identify(f.held());
    expect(await allAlive(held)).toBe(true);
    await f.runtime.client.cancel(first.jobId);
    const record = await f.terminal(first.jobId);
    expect(record.state).toBe("cancelled");
    expect(record.runId).toBeUndefined();
    await vi.waitFor(() => expect(allEnded(held)).toBe(true), { timeout: 10_000 });
    const refused = f.graph.threads.getTurn(first.turnId)?.enqueue_error;
    expect(refused?.message).toContain("Git repository initialization was stopped during add");
    expect(refused?.context).toMatchObject({
      project_git_initialization: { partial: true, initialized: true, failed_stage: "add" },
    });
    // Git's own SIGINT cleanup released its index lock; nobody removed it by hand.
    expect(existsSync(join(f.repo, ".git", "index.lock"))).toBe(false);
    expect(readFileSync(join(f.repo, "y.held"), "utf8")).toBe("user data\n");

    f.unhold();
    const next = await f.turn("edit");
    expect((await f.terminal(next.jobId)).state).toBe("succeeded");
    expect(git(f.repo, "rev-parse", "HEAD")).toMatch(/^[0-9a-f]{40,64}$/);
  }, 180_000);

  it.runIf(process.platform !== "win32")(
    "a survivor of the stopped preparation that kept Git's stderr is ended by the preparation's own scope: an ordinary Stop, nothing held, the next turn runs (r10)",
    async () => {
      const f = await fixture("smudge", true, true);
      f.hold();
      const first = await f.turn("edit, then stop");
      await vi.waitFor(() => expect(f.survivors().length).toBe(1), {
        timeout: 60_000,
        interval: 20,
      });
      await vi.waitFor(() => expect(f.held().length).toBeGreaterThanOrEqual(1), {
        timeout: 60_000,
        interval: 20,
      });
      const survivor = await identify(f.survivors());
      removals.push(() => {
        // Only if the scope did not end it: this test's own grandchild, by its
        // measured identity, kept in custody until its end is proven.
        const deadline = Date.now() + 15_000;
        while (!allEnded(survivor)) {
          for (const id of survivor)
            if (stateOf(id) === "alive") {
              try {
                process.kill(id.pid, "SIGKILL");
              } catch {
                /* its end is proven by the next read, not by this */
              }
            }
          if (Date.now() > deadline)
            throw new Error(`own survivor not proven ended: ${JSON.stringify(survivor)}`);
        }
      });
      expect(await allAlive(survivor)).toBe(true);
      await f.runtime.client.cancel(first.jobId);
      const record = await f.terminal(first.jobId);
      expect(record.state).toBe("cancelled");
      expect(record.runId).toBeUndefined();
      // The scope's settlement ended it by measured identity; nothing stays held.
      expect(await allAlive(survivor)).toBe(false);
      expect(allEnded(survivor)).toBe(true);
      expect(existsSync(join(f.treePath, "..", "preparation.json"))).toBe(false);
      expect(git(f.repo, "branch", "--list", `claudexor/thread-${f.thread.id}`)).toBe("");
      f.unhold();
      const next = await f.turn("edit");
      const done = await f.terminal(next.jobId);
      expect(done.state).toBe("succeeded");
      expect(readFileSync(join(f.treePath, "y.held"), "utf8")).toBe("user data\n");
    },
    180_000,
  );
});
