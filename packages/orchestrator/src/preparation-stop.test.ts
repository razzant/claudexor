import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createFakeHarness } from "@claudexor/harness-fake";
import type { HarnessAdapter } from "@claudexor/core";
import type { HarnessRunSpec, RunEvent } from "@claudexor/schema";
import { RuntimeConcurrencyCaps } from "@claudexor/schema";
import { BudgetLedger } from "@claudexor/budget";
import { projectRuntimeDir } from "@claudexor/util";
import { DelegationBudgetAuthority } from "./delegationBudgetAuthority.js";
import { Orchestrator, type OrchestratorResult, type RunInput } from "./orchestrator.js";
import {
  allAlive,
  allEnded,
  endIdentified,
  holdUntil,
  identify,
  leavingFilter,
  publishedPids,
  stateOf,
  until,
  type Identity,
} from "../../core/src/test-support/process-fixtures.js";

// #694: Stop while a candidate's envelope is still being prepared (a Git clean
// filter holds the dirty-snapshot `add`) must end the run as cancelled without
// starting any harness, without a false workspace failure, and without settling
// a never-dispatched lease as unknown cost.

const roots: string[] = [];
const releases: string[] = [];
afterEach(() => {
  for (const release of releases.splice(0)) writeFileSync(release, "");
  delete process.env.GIT_CONFIG_COUNT;
});
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0);

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

/** A project whose untracked `x.held` passes through a clean filter that holds
 * while `<root>/hold` exists, recording "<filter pid> <git pid>" each time it holds. */
function world(plainFolder = false) {
  const root = mkdtempSync(join(tmpdir(), "cx-prep-stop-"));
  roots.push(root);
  const repo = join(root, "project");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env: GIT_ENV });
  mkdirSync(repo);
  if (!plainFolder) execFileSync("git", ["init", "-q", "-b", "main", repo], { env: GIT_ENV });
  writeFileSync(join(repo, ".gitattributes"), "*.held filter=held\n");
  writeFileSync(join(repo, "README.md"), "base\n");
  if (!plainFolder) git("add", "-A");
  if (!plainFolder) git("commit", "-qm", "base");
  writeFileSync(join(repo, "x.held"), "dirty\n");
  const hold = join(root, "hold");
  const pids = join(root, "pids");
  const release = join(root, "release");
  releases.push(release);
  const program = join(root, "filter.sh");
  writeFileSync(
    program,
    `#!/bin/sh\nif [ -e '${hold}' ]; then mkdir -p '${pids}' && echo "$$ $PPID" > '${pids}/$$.tmp' && mv '${pids}/$$.tmp' '${pids}/$$'; ${holdUntil(root, release)}; fi\nexec cat\n`,
    { mode: 0o755 },
  );
  process.env.GIT_CONFIG_COUNT = "2";
  process.env.GIT_CONFIG_KEY_0 = "filter.held.clean";
  process.env.GIT_CONFIG_VALUE_0 = program;
  process.env.GIT_CONFIG_KEY_1 = "filter.held.smudge";
  process.env.GIT_CONFIG_VALUE_1 = "cat";
  return {
    repo,
    pids,
    hold: () => writeFileSync(hold, ""),
    held: () => publishedPids(pids),
  };
}

function editingFake(executions: string[]): HarnessAdapter {
  const base = createFakeHarness("fake-success");
  return {
    ...base,
    async *run(spec: HarnessRunSpec) {
      executions.push(spec.intent);
      writeFileSync(join(spec.cwd, `edit-${executions.length}.txt`), `${executions.length}\n`);
      yield* base.run(spec);
    },
  };
}

/** The run's outcome within a bound (the unrepaired engine never settles: its
 * preparation ignores Stop until the held child ends by itself). */
async function settled(run: Promise<OrchestratorResult>, ms = 60_000) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const events = (result: OrchestratorResult): RunEvent[] =>
  readFileSync(join(result.runDir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RunEvent);
const ofType = (all: RunEvent[], type: string) => all.filter((event) => event.type === type);

function orchestrator(
  executions: string[],
  parallel: number,
  delegationBudgetAuthority?: DelegationBudgetAuthority,
) {
  return new Orchestrator({
    registry: new Map([["fake-success", editingFake(executions)]]),
    reviewers: [],
    runtimeConcurrencyCaps: RuntimeConcurrencyCaps.parse({ max_parallel_candidates: parallel }),
    ...(delegationBudgetAuthority ? { delegationBudgetAuthority } : {}),
  });
}

/** A Delegate child on a parent's finite family ledger (the shared accounting a
 * wrong settlement would poison for the parent). */
function delegateFamily(child: string) {
  const parentLedger = new BudgetLedger({ kind: "finite", maxUsd: 5 });
  const authority = new DelegationBudgetAuthority();
  authority.registerParent("parent-run", parentLedger);
  authority.noteChildAccepted("parent-run", `admission-${child}`);
  return {
    parentLedger,
    authority,
    input: {
      delegatedFromRunId: "parent-run",
      delegationAdmissionId: `admission-${child}`,
      runId: child,
    } satisfies Partial<RunInput>,
  };
}

const request = (repo: string, signal: AbortSignal, extra: Partial<RunInput> = {}): RunInput => ({
  repoRoot: repo,
  prompt: "edit",
  mode: "agent",
  harnesses: ["fake-success"],
  paidBudget: { kind: "finite", maxUsd: 5 },
  signal,
  ...extra,
});

// POSIX-only, as its `#!/bin/sh` holding filter is; on Windows a step that takes the
// user's locks is not interrupted (`userLockStep`, proven with an injected platform
// in packages/workspace/src/preparation-stop-outcome.test.ts).
const posixDescribe = describe.runIf(process.platform !== "win32");

posixDescribe("Stop during candidate preparation (#694)", () => {
  it("ends a best-of run whose first envelope holds, before any harness starts, and closes every lease", async () => {
    const w = world();
    w.hold();
    const executions: string[] = [];
    const stop = new AbortController();
    const run = orchestrator(executions, 1).run(request(w.repo, stop.signal, { n: 3 }));
    await until("the first candidate's preparation to hold", () => w.held().length >= 2);
    const held = await identify(w.held());
    expect(await allAlive(held)).toBe(true); // proven identities, not a vacuous exit
    stop.abort();
    const result = await settled(run);
    expect(result).not.toBeNull();
    const all = events(result!);
    expect(result!.lifecycle).toBe("cancelled");
    expect(executions).toEqual([]);
    await until("the stopped children to exit", () => allEnded(held), 10_000);
    // Entering the execution path is what `harness.started` announces: none did.
    expect(ofType(all, "harness.started")).toEqual([]);
    expect(ofType(all, "harness.completed").map((event) => event.payload)).toEqual([
      expect.objectContaining({ attempt_id: "a01", status: "cancelled", phase: "workspace" }),
    ]);
    expect(
      ofType(all, "budget.lease.created").map((event) => [
        event.payload["attempt_id"],
        event.payload["granted"],
      ]),
    ).toEqual([
      ["a01", true],
      ["a02", true],
      ["a03", true],
    ]);
    // No candidate became a workspace failure card, and nothing was settled as unknown cost.
    expect(existsSync(join(result!.runDir, "attempts", "a01", "attempt.yaml"))).toBe(false);
    expect(result!.facts.reason).toBe("user_cancelled");
    expect(ofType(all, "budget.cash")).toEqual([]); // no lease was settled, unknown or otherwise
    expect(result!.spendUsd ?? 0).toBe(0);
    // The never-started envelopes are gone.
    const workspaces = join(result!.runDir, "..", "..", "workspaces");
    const bases = existsSync(workspaces)
      ? readdirSync(workspaces).flatMap((task) => readdirSync(join(workspaces, task)))
      : [];
    expect(bases).toEqual([]);
  }, 120_000);

  it("the same run without a stop prepares and runs all three candidates", async () => {
    const w = world();
    const executions: string[] = [];
    const result = await orchestrator(executions, 1).run(
      request(w.repo, new AbortController().signal, { n: 3, synthesis: "never" }),
    );
    // Three real dispatches: their unknown cost stays unknown under the finite cap.
    expect(result.facts.reason).toBe("cost_unverifiable");
    expect(executions).toHaveLength(3);
    expect(ofType(events(result), "harness.started")).toHaveLength(3);
    expect(
      ofType(events(result), "budget.cash").some(
        (event) => event.payload["cash_knowledge"] === "unknown",
      ),
    ).toBe(true);
  }, 120_000);

  it("a Delegate child stopped in preparation leaves its family's cash known, while a dispatched one stays unknown", async () => {
    const w = world();
    w.hold();
    const stopped = delegateFamily("child-stopped");
    const stop = new AbortController();
    let remainingAtTerminal: number | null | undefined;
    // Three candidates, one at a time: the first holds in preparation, two stay queued.
    const run = orchestrator([], 1, stopped.authority).run({
      ...request(w.repo, stop.signal, { ...stopped.input, n: 3 }),
      onEvent(event) {
        // Read at the terminal, before the child's release could clear what it left held.
        if (event.type === "run.failed" || event.type === "run.completed")
          remainingAtTerminal = stopped.parentLedger.remainingUsd();
      },
    });
    await until("the child's preparation to hold", () => w.held().length >= 2);
    stop.abort();
    const result = await settled(run);
    expect(result?.lifecycle).toBe("cancelled");
    expect(remainingAtTerminal).toBe(5); // every started and queued lease was released
    expect(stopped.parentLedger.terminal()).toBeNull();
    expect(stopped.parentLedger.cashCertainty().reported).toBeNull(); // nothing was settled
    expect(ofType(events(result!), "budget.cash")).toEqual([]);

    writeFileSync(join(w.pids, "..", "release"), "");
    const dispatched = delegateFamily("child-dispatched");
    const executions: string[] = [];
    const done = await orchestrator(executions, 1, dispatched.authority).run(
      request(w.repo, new AbortController().signal, dispatched.input),
    );
    expect(executions).toEqual(["implement"]);
    expect(done.facts.reason).toBe("cost_unverifiable");
    expect(dispatched.parentLedger.terminal()).toBe("cost_unverifiable");
    expect(dispatched.parentLedger.cashCertainty().reported).toBe("unknown");
  }, 180_000);

  it("a stop while synthesis prepares keeps the finished candidates and their spend", async () => {
    const w = world();
    const executions: string[] = [];
    const stop = new AbortController();
    const run = orchestrator(executions, 2).run({
      ...request(w.repo, stop.signal, { n: 2, synthesis: "always" }),
      onEvent(event) {
        if (event.type === "synthesis.started") w.hold();
      },
    });
    await until("synthesis preparation to hold", () => w.held().length >= 2);
    stop.abort();
    const result = await settled(run);
    expect(result).not.toBeNull();
    const all = events(result!);
    expect(result!.lifecycle).toBe("cancelled");
    expect(executions).toEqual(["implement", "implement"]);
    const completions = ofType(all, "harness.completed").map((event) => event.payload);
    expect(completions.filter((payload) => payload["attempt_id"] !== "synth")).toHaveLength(2);
    expect(completions.find((payload) => payload["attempt_id"] === "synth")).toMatchObject({
      status: "cancelled",
      phase: "workspace",
    });
    for (const attempt of ["a01", "a02"])
      expect(existsSync(join(result!.runDir, "attempts", attempt))).toBe(true);
  }, 120_000);

  it("a stop during the project's own Git initialization keeps its partial receipt and ends cancelled", async () => {
    const w = world(true);
    w.hold();
    const executions: string[] = [];
    const stop = new AbortController();
    const run = orchestrator(executions, 1).run(request(w.repo, stop.signal));
    await until("the project's `git add` to hold", () => w.held().length >= 2);
    const pids = await identify(w.held());
    expect(await allAlive(pids)).toBe(true); // proven identities, not a vacuous exit
    stop.abort();
    const result = await settled(run);
    expect(result).not.toBeNull();
    const all = events(result!);
    expect(result!.lifecycle).toBe("cancelled");
    expect(executions).toEqual([]);
    await until("the stopped children to exit", () => allEnded(pids), 10_000);
    expect(ofType(all, "project.git.initialized").map((event) => event.payload)).toEqual([
      expect.objectContaining({ partial: true, initialized: true, failed_stage: "add" }),
    ]);
    expect(ofType(all, "harness.started")).toEqual([]);
    expect(existsSync(join(w.repo, ".git", "index.lock"))).toBe(false);
    expect(readFileSync(join(w.repo, "x.held"), "utf8")).toBe("dirty\n");
    // The terminal's own artifacts agree with it: no workspace failure record remains.
    expect(readFileSync(join(result!.runDir, "final", "summary.md"), "utf8")).toContain(
      "Lifecycle: cancelled",
    );
    expect(existsSync(join(result!.runDir, "final", "failure.yaml"))).toBe(false);
  }, 120_000);

  it("a deadline while a convergence envelope prepares ends cancelled with the deadline remedies and no attempt", async () => {
    const w = world();
    w.hold();
    const executions: string[] = [];
    const stop = new AbortController();
    const run = orchestrator(executions, 1).run(
      request(w.repo, stop.signal, { attempts: 2, review: false }),
    );
    await until("the convergence preparation to hold", () => w.held().length >= 2);
    stop.abort("wall_clock_exceeded"); // the deadline's stop, with its own remedies
    const result = await settled(run);
    expect(result).not.toBeNull();
    expect(result!.lifecycle).toBe("cancelled");
    expect(result!.facts.reason).toBe("wall_clock_exceeded");
    expect(executions).toEqual([]);
    expect(ofType(events(result!), "harness.started")).toEqual([]);
    // The convergence's own cancelled terminal, not a generic one.
    expect(readFileSync(join(result!.runDir, "final", "failure.yaml"), "utf8")).toContain(
      "max-seconds",
    );
  }, 120_000);
});

// #694 final review: a filter can start a process that closes its pipes and leaves
// its Git's group; the Git's own end (a stop, or its failure) is then proven while
// that process, still in the run's scope, runs on. The candidate's base is the
// run's until its barrier settled the scope: never deleted from under that process.

/** The same project with a REQUIRED smudge filter that leaves a process behind
 * (`leavingFilter`) and then holds (`hold`) or fails (`fail`). */
function leavingWorld(mode: "hold" | "fail") {
  const w = world();
  const filter = leavingFilter(join(w.repo, ".."), mode);
  process.env.GIT_CONFIG_COUNT = "3";
  process.env.GIT_CONFIG_VALUE_0 = "cat";
  process.env.GIT_CONFIG_VALUE_1 = filter.command;
  process.env.GIT_CONFIG_KEY_2 = "filter.held.required";
  process.env.GIT_CONFIG_VALUE_2 = "true";
  const published = filter.left;
  /** The bases of attempt `attemptId` now on disk, under whatever task the run minted. */
  const bases = (attemptId: string): string[] => {
    const workspaces = join(projectRuntimeDir(w.repo), "workspaces");
    return existsSync(workspaces)
      ? readdirSync(workspaces)
          .map((task) => join(workspaces, task, attemptId))
          .filter((base) => existsSync(base))
      : [];
  };
  return { ...w, published, bases };
}

/** The left children these tests identified: ended by that identity whatever a test skipped. */
const ownLeft: Identity[] = [];
afterEach(() => endIdentified(ownLeft));

/** Watch attempt `attemptId`'s base while `child` runs: true once the base, having
 * existed, is gone while that process is still alive. */
function watchBase(w: ReturnType<typeof leavingWorld>, attemptId: string, child: Identity) {
  const seen = { existed: false, removedUnderChild: false };
  const timer = setInterval(() => {
    if (w.bases(attemptId).length > 0) seen.existed = true;
    else if (seen.existed && stateOf(child) === "alive") seen.removedUnderChild = true;
  }, 10);
  return { seen, stop: () => clearInterval(timer) };
}

describe.runIf(process.platform !== "win32")(
  "a candidate base outlives what its preparation left running, until the run's barrier (#694)",
  () => {
    it("a stop: the run ends cancelled, its barrier ends the filter's left child, and only then the base goes", async () => {
      const w = leavingWorld("hold");
      const executions: string[] = [];
      const stop = new AbortController();
      const run = orchestrator(executions, 1).run(request(w.repo, stop.signal, { n: 1 }));
      await until("the filter's child to publish itself", () => w.published().length >= 1);
      const [left] = w.published() as [{ pid: number; scope: string[] }];
      const [child] = (await identify([left.pid])) as [Identity];
      ownLeft.push(child);
      expect(left.scope).toHaveLength(1); // it carries the run's scope marker
      const watch = watchBase(w, "a01", child);
      await until("the candidate base to exist", () => watch.seen.existed);
      stop.abort();
      const result = await settled(run);
      watch.stop();
      expect(result).not.toBeNull();
      expect(result!.lifecycle).toBe("cancelled");
      expect(executions).toEqual([]);
      const all = events(result!);
      // The Git's own end was proven: an ordinary cancelled attempt, nothing unconfirmed.
      expect(ofType(all, "harness.completed").map((event) => event.payload)).toEqual([
        { harness_id: "fake-success", attempt_id: "a01", status: "cancelled", phase: "workspace" },
      ]);
      expect(watch.seen.removedUnderChild).toBe(false);
      // The barrier's settlement ended the child (recorded with the run)…
      const scope = readFileSync(join(result!.runDir, "final", "process_scope.yaml"), "utf8");
      expect(scope).toMatch(new RegExp(`ended:\\s*\\n\\s*- pid: ${child.pid}\\b`));
      expect(scope).toContain(left.scope[0]!);
      expect(stateOf(child)).toBe("ended");
      // …and then released the base.
      expect(w.bases("a01")).toEqual([]);
    }, 120_000);

    it("a failed filter: the next candidate prepares while the first one's base stays under its left child; the barrier ends both and frees both", async () => {
      const w = leavingWorld("fail");
      const executions: string[] = [];
      const run = orchestrator(executions, 1).run(
        request(w.repo, new AbortController().signal, { n: 2, synthesis: "never" }),
      );
      await until("the first filter's child to publish itself", () => w.published().length >= 1);
      const [first] = (await identify([w.published()[0]!.pid])) as [Identity];
      ownLeft.push(first);
      const watch = watchBase(w, "a01", first);
      const result = await settled(run);
      watch.stop();
      expect(result).not.toBeNull();
      expect(executions).toEqual([]);
      const all = events(result!);
      expect(
        ofType(all, "harness.completed").map((event) => [
          event.payload["attempt_id"],
          event.payload["status"],
          event.payload["phase"],
        ]),
      ).toEqual([
        ["a01", "failed", "workspace"],
        ["a02", "failed", "workspace"],
      ]);
      // The first base was there, and never went while its filter's child ran.
      expect(watch.seen).toEqual({ existed: true, removedUnderChild: false });
      const scope = readFileSync(join(result!.runDir, "final", "process_scope.yaml"), "utf8");
      const ended = w.published().map((left) => left.pid);
      expect(ended).toHaveLength(2);
      for (const pid of ended) expect(scope).toMatch(new RegExp(`- pid: ${pid}\\b`));
      expect(stateOf(first)).toBe("ended");
      expect([...w.bases("a01"), ...w.bases("a02")]).toEqual([]);
    }, 120_000);
  },
);
