import { execFileSync } from "node:child_process";
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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  mintRunScopeMarker,
  preparationQuiet,
  reapScopeMembers,
  WorkspaceError,
} from "@claudexor/core";
import { ensureGitRepository, GitInitializationError } from "./git.js";
import {
  PreparationCancelled,
  PreparationStopped,
  unconfirmedTerminationOf,
  withScopeMarker,
} from "./git-run.js";
import { WorkspaceManager } from "./manager.js";
import { envelopePreparationVerdict, readEnvelopePreparation } from "./envelope-preparation.js";
import {
  allAlive,
  allEnded,
  endIdentified,
  holdUntil,
  identify,
  leavingFilter,
  publishedPid,
  publishedPids,
  stateOf,
  until,
  type Identity,
} from "../../core/src/test-support/process-fixtures.js";
import { ensureObjectStore, objectStorePath } from "./object-store.js";
import { acquirePruneLock, controlDir } from "./object-store-leases.js";

// #694: Stop must reach envelope preparation. A Git child that blocks (here a
// clean or smudge filter that waits for a release file, the way a real filter
// can hang) is ended through the existing process owner and awaited to its close;
// the never-started envelope its creator made is removed; nothing is left running.

const dirs: string[] = [];
const releases: string[] = [];
afterEach(() => {
  // Never leave a held child behind, whatever a failed assertion skipped.
  for (const release of releases.splice(0)) writeFileSync(release, "");
  for (const dir of dirs.splice(0)) {
    chmodTree(dir);
    rmSync(dir, { recursive: true, force: true });
  }
}, 0);

let REAL_GIT = "git";
beforeAll(() => {
  if (process.platform !== "win32")
    REAL_GIT = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
});
const BASE_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  LC_ALL: "C",
};
const saved = new Map<string, string | undefined>();
const setEnv = (patch: Record<string, string | undefined>) => {
  for (const [key, value] of Object.entries(patch)) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};
beforeAll(() => setEnv(BASE_ENV));
afterAll(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
afterEach(() =>
  setEnv({ GIT_CONFIG_COUNT: undefined, HOME: saved.get("HOME") ?? process.env.HOME }),
);

function chmodTree(dir: string): void {
  if (!existsSync(dir)) return;
  try {
    chmodSync(dir, 0o755);
    for (const name of readdirSync(dir, { withFileTypes: true }))
      if (name.isDirectory()) chmodTree(join(dir, name.name));
  } catch {
    // best effort: the removal below reports what remains
  }
}

const git = (repo: string, args: string[]) =>
  execFileSync(REAL_GIT, ["-C", repo, ...args], { env: { ...process.env, ...BASE_ENV } })
    .toString("utf8")
    .trim();

/** A filter program that records its own PID and its parent Git's PID, then
 * holds until `release` exists (or its test directory is gone), then passes its
 * input through. Each run publishes its PIDs as one file in the `pids`
 * directory, by rename: a reader sees it whole or not at all. */
function holdingProgram(root: string): { program: string; pids: string; release: string } {
  const program = join(root, "hold.sh");
  const pids = join(root, "pids");
  const release = join(root, "release");
  writeFileSync(
    program,
    `#!/bin/sh\nmkdir -p '${pids}'\necho "$$ $PPID" > '${pids}/$$.tmp' && mv '${pids}/$$.tmp' '${pids}/$$'\n${holdUntil(root, release)}\n`,
    { mode: 0o755 },
  );
  releases.push(release);
  return { program, pids, release };
}

/** Configure the filter for every Git child of this process (the user's repository and private clones alike). */
function useFilter(program: string, side: "clean" | "smudge"): void {
  setEnv({
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `filter.held.${side}`,
    GIT_CONFIG_VALUE_0: program,
    GIT_CONFIG_KEY_1: `filter.held.${side === "clean" ? "smudge" : "clean"}`,
    GIT_CONFIG_VALUE_1: "cat",
  });
}

function world(): { root: string; repo: string; runtime: string } {
  const root = mkdtempSync(join(tmpdir(), "cx-prep-cancel-"));
  dirs.push(root);
  const repo = join(root, "project");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, ".gitattributes"), "*.held filter=held\n");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);
  return { root, repo, runtime: join(root, "runtime") };
}

/** Settles within `ms` or reports that it did not (base behaviour: it never does). */
async function settled<T>(promise: Promise<T>, ms = 60_000) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ settled: false; value: undefined; error: unknown }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false, value: undefined, error: undefined }), ms);
  });
  const outcome = promise.then(
    (value) => ({ settled: true as const, value, error: undefined as unknown }),
    (error: unknown) => ({ settled: true as const, value: undefined, error }),
  );
  try {
    return await Promise.race([outcome, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// POSIX-only, as its `#!/bin/sh` holding filter is: these scenarios also assert
// that a stop INTERRUPTS the user's own `git add`, which Windows runs to its end
// (`userLockStep`, proven with an injected platform in preparation-stop-outcome.test.ts).
const posixDescribe = describe.runIf(process.platform !== "win32");

describe.runIf(process.platform === "win32")("native Windows preparation (#694)", () => {
  it("prepares and disposes a healthy isolated checkout", async () => {
    const { repo, runtime } = world();
    const manager = new WorkspaceManager(repo, { runtimeRoot: runtime });
    const envelope = await manager.create({
      taskId: "healthy",
      attemptId: "a1",
      dirtyPolicy: "snapshot",
    });
    expect(readFileSync(join(envelope.worktree_path, "README.md"), "utf8")).toBe("base\n");
    expect(readEnvelopePreparation(join(runtime, "workspaces", "healthy", "a1"))?.preparing).toBe(
      false,
    );
    await manager.dispose(envelope);
    expect(existsSync(envelope.worktree_path)).toBe(false);
  }, 60_000);

  it("cancels a real scratch-index Git filter, preserving the user's index and bytes", async () => {
    const { root, repo, runtime } = world();
    const ready = join(root, "ready.json");
    const release = join(root, "release");
    const program = join(root, "filter.cjs");
    releases.push(release);
    writeFileSync(
      program,
      `const fs=require('node:fs'); const chunks=[];
process.stdin.on('data', c=>chunks.push(c)); process.stdin.on('end', ()=>{
  if (!process.env.GIT_INDEX_FILE) { process.stdout.write(Buffer.concat(chunks)); return; }
  fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({index:process.env.GIT_INDEX_FILE,pid:process.pid}));
  const timer=setInterval(()=>{ if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);process.stdout.write(Buffer.concat(chunks));}},20);
});`,
    );
    setEnv({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "filter.held.clean",
      GIT_CONFIG_VALUE_0: `"${process.execPath.replaceAll("\\", "/")}" "${program.replaceAll("\\", "/")}"`,
    });
    writeFileSync(join(repo, "x.held"), "dirty\n");
    const index = readFileSync(join(repo, ".git", "index"));
    const stop = new AbortController();
    const outcome = settled(
      new WorkspaceManager(repo, { runtimeRoot: runtime }).create({
        taskId: "cancel",
        attemptId: "a1",
        inPlace: true,
        signal: stop.signal,
      }),
    );
    try {
      await until("native scratch-index filter", () => existsSync(ready));
      const scratch = JSON.parse(readFileSync(ready, "utf8")) as { index: string };
      expect(scratch.index).toContain("claudexor-snapshot-index-");
      stop.abort("native Windows scratch cancellation");
      const result = await outcome;
      expect(result.settled).toBe(true);
      expect(result.error).toBeInstanceOf(PreparationCancelled);
      expect(unconfirmedTerminationOf(result.error)).toBeUndefined();
      expect(existsSync(scratch.index)).toBe(false);
      expect(readFileSync(join(repo, ".git", "index"))).toEqual(index);
      expect(readFileSync(join(repo, "x.held"), "utf8")).toBe("dirty\n");
      expect(existsSync(join(repo, ".git", "index.lock"))).toBe(false);
      expect(existsSync(join(runtime, "workspaces", "cancel", "a1"))).toBe(false);
    } finally {
      writeFileSync(release, "");
      stop.abort();
      await outcome;
    }
  }, 90_000);
});

posixDescribe("Stop reaches envelope preparation (#694)", () => {
  it("a stop before preparation makes nothing and starts no Git", async () => {
    const { root, repo, runtime } = world();
    const hold = holdingProgram(root);
    useFilter(hold.program, "clean");
    writeFileSync(join(repo, "x.held"), "dirty\n");
    const stop = new AbortController();
    stop.abort();
    const wsm = new WorkspaceManager(repo, { runtimeRoot: runtime });
    for (const options of [
      { inPlace: true },
      { inPlace: false },
      { workspaceKind: "directory" as const },
    ])
      await expect(
        wsm.create({
          taskId: "t1",
          attemptId: "a01",
          dirtyPolicy: "snapshot",
          signal: stop.signal,
          ...options,
        }),
      ).rejects.toBeInstanceOf(PreparationCancelled);
    expect(existsSync(join(runtime, "workspaces", "t1", "a01"))).toBe(false);
    expect(existsSync(hold.pids)).toBe(false);
  });

  it.each([
    ["isolated (dirty snapshot)", false],
    ["in place (per-turn snapshot)", true],
  ])(
    "%s: a stop while `add` holds in a clean filter ends that Git and its filter, then removes the envelope",
    async (_label, inPlace) => {
      const { root, repo, runtime } = world();
      const hold = holdingProgram(root);
      useFilter(hold.program, "clean");
      writeFileSync(join(repo, "x.held"), "dirty\n");
      const statusBefore = git(repo, ["status", "--porcelain"]);
      const stop = new AbortController();
      const created = new WorkspaceManager(repo, { runtimeRoot: runtime }).create({
        taskId: "t2",
        attemptId: "a01",
        dirtyPolicy: "snapshot",
        inPlace,
        signal: stop.signal,
      });
      await until("the clean filter to hold", () => publishedPids(hold.pids).length >= 2);
      const held = await identify(publishedPids(hold.pids));
      expect(await allAlive(held)).toBe(true);
      stop.abort();
      const outcome = await settled(created);
      expect(outcome.settled).toBe(true);
      expect(outcome.error).toBeInstanceOf(PreparationCancelled);
      // The children were awaited to their close before the stop was reported.
      await until("the stopped children to exit", () => allEnded(held), 10_000);
      expect(existsSync(join(runtime, "workspaces", "t2", "a01"))).toBe(false);
      // The user's tree, index and lock state are as they were.
      expect(readFileSync(join(repo, "x.held"), "utf8")).toBe("dirty\n");
      expect(existsSync(join(repo, ".git", "index.lock"))).toBe(false);
      expect(git(repo, ["status", "--porcelain"])).toBe(statusBefore);
    },
    120_000,
  );

  it("a stop while the private clone's checkout holds in a smudge filter (its last step)", async () => {
    const { root, repo, runtime } = world();
    writeFileSync(join(repo, "y.held"), "committed\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "held file"]);
    const hold = holdingProgram(root);
    useFilter(hold.program, "smudge");
    const stop = new AbortController();
    const created = new WorkspaceManager(repo, { runtimeRoot: runtime }).create({
      taskId: "t3",
      attemptId: "a01",
      signal: stop.signal,
    });
    await until("the smudge filter to hold", () => publishedPids(hold.pids).length >= 2);
    const pids = await identify(publishedPids(hold.pids));
    expect(await allAlive(pids)).toBe(true); // proven identities, not a vacuous exit
    stop.abort();
    const outcome = await settled(created);
    expect(outcome.error).toBeInstanceOf(PreparationCancelled);
    await until("the stopped children to exit", () => allEnded(pids), 10_000);
    expect(existsSync(join(runtime, "workspaces", "t3", "a01"))).toBe(false);
  }, 120_000);

  it("the same unaborted signal leaves an ordinary preparation unchanged", async () => {
    const { root, repo, runtime } = world();
    const hold = holdingProgram(root);
    writeFileSync(hold.release, ""); // the filter passes through at once
    useFilter(hold.program, "clean");
    writeFileSync(join(repo, "x.held"), "dirty\n");
    const wsm = new WorkspaceManager(repo, { runtimeRoot: runtime });
    const env = await wsm.create({
      taskId: "t4",
      attemptId: "a01",
      dirtyPolicy: "snapshot",
      signal: new AbortController().signal,
    });
    expect(publishedPids(hold.pids).length).toBeGreaterThan(0); // the filter really ran
    expect(env.base_sha).not.toBe(git(repo, ["rev-parse", "HEAD"])); // the dirty snapshot
    expect(readFileSync(join(env.worktree_path, "x.held"), "utf8")).toBe("dirty\n");
    await wsm.dispose(env);
  }, 120_000);

  it("a stop that cannot remove the never-started envelope says so and stays a stop", async () => {
    const { root, repo, runtime } = world();
    const hold = holdingProgram(root);
    useFilter(hold.program, "clean");
    writeFileSync(join(repo, "x.held"), "dirty\n");
    const stop = new AbortController();
    const created = new WorkspaceManager(repo, { runtimeRoot: runtime }).create({
      taskId: "t5",
      attemptId: "a01",
      dirtyPolicy: "snapshot",
      signal: stop.signal,
    });
    await until("the clean filter to hold", () => publishedPids(hold.pids).length >= 2);
    const base = join(runtime, "workspaces", "t5", "a01");
    chmodSync(join(base, "home"), 0o500); // its entries cannot be removed
    stop.abort();
    const outcome = await settled(created);
    expect(outcome.error).toBeInstanceOf(PreparationCancelled);
    expect((outcome.error as Error).message).toContain("could not be removed");
    expect(existsSync(base)).toBe(true);
  }, 120_000);

  it("a stop while custody waits out a prune releases its own pending record", async () => {
    const { repo, runtime } = world();
    writeFileSync(join(repo, "README.md"), "dirty tracked\n"); // a dirty base enters the store
    const { store } = await ensureObjectStore(repo);
    const lock = acquirePruneLock(store);
    expect(lock).not.toBeNull();
    try {
      const stop = new AbortController();
      const created = new WorkspaceManager(repo, { runtimeRoot: runtime }).create({
        taskId: "t6",
        attemptId: "a01",
        dirtyPolicy: "snapshot",
        signal: stop.signal,
      });
      const pending = controlDir(store, "pending");
      await until("the import to wait on the prune lock", () => readdirSync(pending).length > 0);
      stop.abort();
      const outcome = await settled(created);
      expect(outcome.error).toBeInstanceOf(PreparationCancelled);
      expect(readdirSync(pending)).toEqual([]);
      expect(existsSync(join(runtime, "workspaces", "t6", "a01"))).toBe(false);
    } finally {
      lock?.release();
    }
  }, 120_000);

  it("one waiter's stop never ends a shared store initialization another run waits for", async () => {
    const { root, repo } = world();
    // The spawn layer searches the HOME-relative launcher directories first.
    const home = join(root, "home");
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    const marker = join(root, "init-pid");
    const calls = join(root, "calls");
    const release = join(root, "init-release");
    releases.push(release);
    writeFileSync(
      join(bin, "git"),
      [
        "#!/bin/sh",
        `case " $* " in *" init --bare "*) echo $$ > '${marker}.tmp' && mv '${marker}.tmp' '${marker}'; while [ ! -e '${release}' ] && [ -d '${root}' ]; do sleep 0.02; done; exec '${REAL_GIT}' "$@";; esac`,
        `'${REAL_GIT}' "$@"; status=$?; echo done >> '${calls}'; exit $status`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    setEnv({ HOME: home });
    const finished = () =>
      existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0;
    // The first caller starts the shared initialization (after its three format reads).
    const owner = ensureObjectStore(repo, undefined);
    await until("the shared initialization to hold", () => existsSync(marker));
    // Published by rename: whole or absent, never an empty file read as PID 0.
    const [initChild] = (await identify([
      publishedPid(readFileSync(marker, "utf8").trim(), marker),
    ])) as [Identity];
    const before = finished();
    // The second caller's own three reads finish; then it can only be waiting on the shared one.
    const stop = new AbortController();
    const waiter = ensureObjectStore(repo, undefined, stop.signal);
    await until("the waiter's own reads to finish", () => finished() >= before + 3);
    stop.abort();
    const stopped = await settled(waiter);
    expect(stopped.error).toBeInstanceOf(PreparationCancelled);
    expect(await allAlive([initChild])).toBe(true); // the shared child keeps running for its owner
    writeFileSync(release, "");
    const made = await settled(owner);
    expect(made.error).toBeUndefined();
    await until("the shared child to exit", () => allEnded([initChild]), 10_000);
    const store = objectStorePath(repo);
    expect(existsSync(join(store, "HEAD"))).toBe(true);
    expect(readdirSync(join(store, "..")).filter((name) => name.includes(".init-"))).toEqual([]);
  }, 120_000);

  it("an existing store's format read takes the stop: a stopped caller starts no Git, an ordinary one reads it", async () => {
    const { root, repo } = world();
    const { objectFormat } = await ensureObjectStore(repo);
    // The spawn layer searches the HOME-relative launcher directories first.
    const home = join(root, "home");
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    const calls = join(root, "calls");
    writeFileSync(
      join(bin, "git"),
      ["#!/bin/sh", `echo "$*" >> '${calls}'`, `exec '${REAL_GIT}' "$@"`, ""].join("\n"),
      { mode: 0o755 },
    );
    setEnv({ HOME: home });
    const started = () =>
      existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : [];
    const stop = new AbortController();
    stop.abort();
    await expect(ensureObjectStore(repo, objectFormat, stop.signal)).rejects.toBeInstanceOf(
      PreparationCancelled,
    );
    expect(started()).toEqual([]);
    // The same call unstopped reads the store's format through the same launcher.
    const kept = await ensureObjectStore(repo, objectFormat, new AbortController().signal);
    expect(kept).toEqual({ store: objectStorePath(repo), objectFormat });
    expect(started()).toEqual([`-C ${objectStorePath(repo)} rev-parse --show-object-format`]);
  });

  it("a stop during the user's Git initialization ends `add` softly and keeps the partial receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "cx-prep-init-"));
    dirs.push(root);
    const folder = join(root, "plain folder");
    mkdirSync(folder);
    writeFileSync(join(folder, ".gitattributes"), "*.held filter=held\n");
    writeFileSync(join(folder, "x.held"), "user data\n");
    const hold = holdingProgram(root);
    useFilter(hold.program, "clean");
    const stop = new AbortController();
    const initialized = ensureGitRepository(folder, { signal: stop.signal });
    await until("the user's `git add` to hold", () => publishedPids(hold.pids).length >= 2);
    const pids = await identify(publishedPids(hold.pids));
    expect(await allAlive(pids)).toBe(true); // proven identities, not a vacuous exit
    stop.abort();
    const outcome = await settled(initialized);
    expect(outcome.error).toBeInstanceOf(GitInitializationError);
    expect((outcome.error as GitInitializationError).progress).toMatchObject({
      initialized: true,
      failedStage: "add",
      baselineCommitted: false,
    });
    await until("the stopped children to exit", () => allEnded(pids), 10_000);
    // The ordinary escalation lets Git release its own lock; nothing removes it by hand.
    expect(existsSync(join(folder, ".git", "index.lock"))).toBe(false);
    expect(readFileSync(join(folder, "x.held"), "utf8")).toBe("user data\n");
  }, 120_000);
});

// #694 final review: a filter can start a process that closes its pipes and leaves
// its Git's group. The stopped (or failed) Git's own end is then proven while that
// process, still carrying the scope's marker, runs on. The base of an isolated
// preparation made in a scope is released by the scope's read, after its owner
// settled the scope, never deleted from under such a process.

/** Configure it as the REQUIRED filter of every Git child: a failing run fails its Git. */
function useRequiredFilter(command: string, side: "clean" | "smudge"): void {
  useFilter(command, side);
  setEnv({
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_2: "filter.held.required",
    GIT_CONFIG_VALUE_2: "true",
  });
}
/** The left children these tests identified: ended by that identity, whatever a test skipped. */
const own: Identity[] = [];
const endOwn = (): Promise<void> => endIdentified(own);
afterEach(endOwn);

/** A committed `.held` file, so the private clone's checkout runs the smudge filter. */
function heldWorld(): { root: string; repo: string; runtime: string } {
  const made = world();
  writeFileSync(join(made.repo, "y.held"), "committed\n");
  git(made.repo, ["add", "-A"]);
  git(made.repo, ["commit", "-qm", "held file"]);
  return made;
}

/** The single left child, identified, once the filter published it. */
async function leftChild(
  filter: ReturnType<typeof leavingFilter>,
  marker?: string,
): Promise<Identity> {
  await until("the filter's child to publish itself", () => filter.left().length >= 1);
  const [published] = filter.left() as [{ pid: number; scope: string[] }];
  const [id] = (await identify([published.pid])) as [Identity];
  own.push(id);
  if (marker) expect(published.scope).toContain(marker);
  else expect(published.scope).toEqual([]);
  return id;
}

/** The base's release read while `child` runs: held, and naming that child. Such a
 * read waits its whole bound for the member it found, so the bound starts short
 * and grows only when the census itself did not finish within it (a loaded host). */
async function heldBy(base: string, child: Identity): Promise<void> {
  let reasons: string[] = [];
  for (const deadlineMs of [4_000, 12_000, 30_000]) {
    const read = await envelopePreparationVerdict(base, (facts) =>
      preparationQuiet(facts, { deadlineMs }),
    );
    expect(read.status).toBe("held");
    reasons = (read as { reasons: string[] }).reasons;
    if (reasons.includes(`scope member ${child.pid} is alive`)) return;
  }
  throw new Error(`the release read never named the left child: ${reasons.join("; ")}`);
}

/** Start a preparation with its outcome's handlers attached at once: a failing
 * filter rejects it while the test is still identifying the child it left. */
const started = (wsm: WorkspaceManager, opts: Parameters<WorkspaceManager["create"]>[0]) =>
  settled(wsm.create(opts));

describe.runIf(process.platform !== "win32")(
  "an isolated base is not removed from under what its preparation left running (#694)",
  () => {
    it.each([
      ["a stop", "hold"],
      ["a failed filter", "fail"],
    ] as const)(
      "%s whose Git ended while a child it left runs on: the base waits for the scope's settlement, then goes",
      async (_label, mode) => {
        const { root, repo, runtime } = heldWorld();
        const filter = leavingFilter(root, mode);
        useRequiredFilter(filter.command, "smudge");
        const marker = mintRunScopeMarker();
        const opened = new Date().toISOString();
        const stop = new AbortController();
        const releases: Array<() => Promise<void>> = [];
        const signal = withScopeMarker(stop.signal, marker, (release) => releases.push(release));
        const created = started(new WorkspaceManager(repo, { runtimeRoot: runtime }), {
          taskId: "s1",
          attemptId: mode,
          signal,
        });
        const child = await leftChild(filter, marker);
        if (mode === "hold") stop.abort("stop");
        const outcome = await created;
        expect(outcome.settled).toBe(true);
        // The Git's own end was proven (or it simply failed): no unconfirmed stop.
        if (mode === "hold") expect(outcome.error).toBeInstanceOf(PreparationCancelled);
        else {
          expect(outcome.error).toBeInstanceOf(WorkspaceError);
          expect(outcome.error).not.toBeInstanceOf(PreparationStopped);
          expect((outcome.error as Error).message).toContain("smudge filter held failed");
        }
        expect(unconfirmedTerminationOf(outcome.error)).toBeUndefined();
        expect(outcome.error).not.toHaveProperty("heldBase");
        // What the filter left is alive, and the base is still there, unfinished.
        expect(await allAlive([child])).toBe(true);
        const base = join(runtime, "workspaces", "s1", mode);
        expect(readEnvelopePreparation(base)).toEqual({ scope_marker: marker, preparing: true });
        expect(releases).toHaveLength(1);
        // The release only reads: while the child runs, it refuses and removes nothing.
        await heldBy(base, child);
        expect(existsSync(base)).toBe(true);
        // The scope's owner settles it (ending the child by its measured identity)…
        const reaped = await reapScopeMembers({ marker, scopeStartAt: opened, deadlineMs: 30_000 });
        expect(reaped.settled).toBe(true);
        expect(reaped.ended.map((member) => member.pid)).toContain(child.pid);
        await until("the left child to end", () => allEnded([child]), 10_000);
        // …and then runs the release it was handed: the base goes.
        await releases[0]!();
        expect(existsSync(base)).toBe(false);
      },
      120_000,
    );

    it("without an owner of the scope, the release's own read waits for the left child and never removes the base under it", async () => {
      const { root, repo, runtime } = heldWorld();
      const filter = leavingFilter(root, "fail", 1_500);
      useRequiredFilter(filter.command, "smudge");
      const marker = mintRunScopeMarker();
      const base = join(runtime, "workspaces", "s2", "a01");
      const created = started(new WorkspaceManager(repo, { runtimeRoot: runtime }), {
        taskId: "s2",
        attemptId: "a01",
        signal: withScopeMarker(undefined, marker),
      });
      const child = await leftChild(filter, marker);
      // Until the child ends by itself the base stays; the failure waits for the read.
      let removedUnderChild = false;
      const watch = setInterval(() => {
        if (!existsSync(base) && stateOf(child) === "alive") removedUnderChild = true;
      }, 20);
      const outcome = await created;
      clearInterval(watch);
      expect(outcome.error).toBeInstanceOf(WorkspaceError);
      expect(removedUnderChild).toBe(false);
      expect(stateOf(child)).toBe("ended");
      expect(outcome.error).not.toHaveProperty("heldBase");
      expect(existsSync(base)).toBe(false);
    }, 120_000);

    it("without an owner, a left child that outlives the read keeps the base, named on the failure, for a later read", async () => {
      const { root, repo, runtime } = heldWorld();
      const filter = leavingFilter(root, "fail");
      useRequiredFilter(filter.command, "smudge");
      const marker = mintRunScopeMarker();
      const base = join(runtime, "workspaces", "s3", "a01");
      const created = started(new WorkspaceManager(repo, { runtimeRoot: runtime }), {
        taskId: "s3",
        attemptId: "a01",
        signal: withScopeMarker(undefined, marker),
      });
      const child = await leftChild(filter, marker);
      const outcome = await created; // the read's own bound (10 s) passes first
      expect(outcome.error).toBeInstanceOf(WorkspaceError);
      expect(outcome.error).toMatchObject({ heldBase: base });
      expect((outcome.error as Error).message).toContain(
        `its never-started envelope ${base} is kept`,
      );
      expect(await allAlive([child])).toBe(true);
      expect(readEnvelopePreparation(base)).toEqual({ scope_marker: marker, preparing: true });
      // The read the startup sweep makes: held while the child runs, quiet once it ended.
      await heldBy(base, child);
      await endOwn();
      expect((await envelopePreparationVerdict(base)).status).toBe("quiet");
    }, 120_000);

    it("outside any scope the same failure removes its base at once, as before", async () => {
      const { root, repo, runtime } = heldWorld();
      const filter = leavingFilter(root, "hold");
      useRequiredFilter(filter.command, "smudge");
      const stop = new AbortController();
      const created = started(new WorkspaceManager(repo, { runtimeRoot: runtime }), {
        taskId: "s4",
        attemptId: "a01",
        signal: stop.signal,
      });
      const child = await leftChild(filter);
      stop.abort("stop");
      const outcome = await created;
      expect(outcome.error).toBeInstanceOf(PreparationCancelled);
      expect(existsSync(join(runtime, "workspaces", "s4", "a01"))).toBe(false);
      expect(await allAlive([child])).toBe(true); // unmarked: no scope could ever read it
    }, 120_000);

    it("a scoped in-place preparation that fails still removes its base at once: nothing runs in it", async () => {
      const { root, repo, runtime } = world();
      const filter = leavingFilter(root, "fail");
      useRequiredFilter(filter.command, "clean");
      writeFileSync(join(repo, "x.held"), "dirty\n");
      const marker = mintRunScopeMarker();
      const releases: Array<() => Promise<void>> = [];
      const created = started(new WorkspaceManager(repo, { runtimeRoot: runtime }), {
        taskId: "s5",
        attemptId: "a01",
        dirtyPolicy: "snapshot",
        inPlace: true,
        signal: withScopeMarker(undefined, marker, (release) => releases.push(release)),
      });
      await leftChild(filter, marker);
      const outcome = await created;
      expect(outcome.error).toBeInstanceOf(Error);
      expect(outcome.error).not.toBeInstanceOf(PreparationStopped);
      expect(releases).toEqual([]);
      expect(existsSync(join(runtime, "workspaces", "s5", "a01"))).toBe(false);
      expect(readFileSync(join(repo, "x.held"), "utf8")).toBe("dirty\n");
    }, 120_000);

    it("a successful scoped preparation hands its envelope over with nothing deferred, whatever its filter left", async () => {
      const { root, repo, runtime } = heldWorld();
      const filter = leavingFilter(root, "pass");
      useRequiredFilter(filter.command, "smudge");
      const marker = mintRunScopeMarker();
      const releases: Array<() => Promise<void>> = [];
      const wsm = new WorkspaceManager(repo, { runtimeRoot: runtime });
      const env = await wsm.create({
        taskId: "s6",
        attemptId: "a01",
        signal: withScopeMarker(undefined, marker, (release) => releases.push(release)),
      });
      await leftChild(filter, marker);
      expect(readFileSync(join(env.worktree_path, "y.held"), "utf8")).toBe("committed\n");
      expect(releases).toEqual([]);
      expect(readEnvelopePreparation(join(runtime, "workspaces", "s6", "a01"))).toEqual({
        scope_marker: marker,
        preparing: false,
      });
      await endOwn();
      await wsm.dispose(env);
    }, 120_000);
  },
);
