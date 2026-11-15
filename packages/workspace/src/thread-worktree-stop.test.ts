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
import { join } from "node:path";
import { projectRuntimeDir } from "@claudexor/util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { worktreeAdd } from "./git.js";
import { PreparationCancelled } from "./git-run.js";
import { ensureThreadWorktree } from "./thread-tree.js";
import {
  allAlive,
  allEnded,
  holdUntil,
  identify,
  publishedPids,
  until,
  type Identity,
} from "../../core/src/test-support/process-fixtures.js";

// #694 (thread preparation): Stop reaches the isolated-thread worktree a running
// turn prepares. A held smudge filter stands for a checkout that does not end by
// itself. `git worktree add` changes the user's repository, so it is stopped the
// ordinary way (SIGINT, then SIGKILL): Git then removes what it was creating. A
// killed add leaves its registration locked "initializing", which only this
// call's own exact path may clear. Surviving branches and worktrees are kept.
//
// The held-filter scenarios are POSIX-only (`posixDescribe`): their fixture is a
// `#!/bin/sh` filter read through `ps`, and they assert that the stop INTERRUPTS
// `git worktree add`. On Windows that step takes the user's locks and is not
// interrupted (`userLockStep`): it finishes and the stop is taken at its
// boundary — proven with an injected platform in preparation-stop-outcome.test.ts.

const posixDescribe = describe.runIf(process.platform !== "win32");
const dirs: string[] = [];
const releases: string[] = [];
afterEach(() => {
  for (const release of releases.splice(0)) writeFileSync(release, "");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.GIT_CONFIG_COUNT;
}, 0);

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const saved = new Map<string, string | undefined>();
beforeAll(() => {
  for (const [key, value] of Object.entries(GIT_ENV)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
});
afterAll(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const git = (repo: string, ...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { env: { ...process.env, ...GIT_ENV } })
    .toString("utf8")
    .trim();

/** One `ps` field of `pid` (for walking up to a parent); null when it cannot be read. */
const ps = (field: string, pid: number): string | null => {
  try {
    return (
      execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)])
        .toString()
        .trim() || null
    );
  } catch {
    return null;
  }
};

/** What a stop returned instead of the expected one, for the assertion's message:
 * a refusal's typed context names why its end was not proven and what is held. */
const why = (error: unknown): string =>
  JSON.stringify({
    name: (error as Error | undefined)?.constructor?.name,
    message: (error as Error | undefined)?.message,
    context: (error as { context?: unknown } | undefined)?.context,
  });

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

/** A project with a committed `y.held` (smudge filter `held`) and a holding filter
 * program configured for every Git child of this process. */
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-thread-stop-")));
  dirs.push(root);
  const repo = join(root, "project");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, ".gitattributes"), "*.held filter=held\n");
  writeFileSync(join(repo, "y.held"), "committed\n");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  writeFileSync(join(repo, "notes.txt"), "the user's own untracked work\n");
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
  process.env.GIT_CONFIG_KEY_0 = "filter.held.smudge";
  process.env.GIT_CONFIG_VALUE_0 = program;
  process.env.GIT_CONFIG_KEY_1 = "filter.held.clean";
  process.env.GIT_CONFIG_VALUE_1 = "cat";
  const threadDir = (id: string) => join(projectRuntimeDir(repo), "threads", id);
  return {
    repo,
    release,
    threadDir,
    tree: (id: string) => join(threadDir(id), "tree"),
    hold: () => writeFileSync(hold, ""),
    unhold: () => rmSync(hold, { force: true }),
    held: () => publishedPids(pids),
    /** What the user's repository holds, to prove a stop changed none of it. */
    userState: () => ({
      head: git(repo, "rev-parse", "HEAD"),
      status: git(repo, "status", "--porcelain"),
      index: git(repo, "ls-files", "-s"),
      notes: readFileSync(join(repo, "notes.txt"), "utf8"),
    }),
    registered: (path: string) =>
      git(repo, "worktree", "list", "--porcelain")
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .some((line) => realpathOrSelf(line.slice("worktree ".length)) === realpathOrSelf(path)),
    branch: (id: string) => git(repo, "branch", "--list", `claudexor/thread-${id}`),
  };
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The `git worktree add` process above a held filter (its checkout may run in a child). */
async function worktreeAddProcess(filterPid: number): Promise<Identity> {
  let pid = Number(ps("ppid", filterPid));
  for (let depth = 0; depth < 3 && pid > 1; depth += 1) {
    const command = ps("command", pid) ?? "";
    if (/\bworktree add\b/.test(command)) return (await identify([pid]))[0]!;
    pid = Number(ps("ppid", pid));
  }
  throw new Error(`no git worktree add process above filter ${filterPid}`);
}

describe("Stop reaches the isolated-thread worktree (#694)", () => {
  it("a stop before preparation changes nothing, not even a folder that is no repository yet", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-thread-stop-plain-")));
    dirs.push(root);
    const folder = join(root, "plain");
    mkdirSync(folder);
    writeFileSync(join(folder, "data.txt"), "user data\n");
    const stop = new AbortController();
    stop.abort();
    await expect(
      ensureThreadWorktree(folder, "th-pre", { signal: stop.signal }),
    ).rejects.toBeInstanceOf(PreparationCancelled);
    expect(existsSync(join(folder, ".git"))).toBe(false);
    expect(existsSync(join(projectRuntimeDir(folder), "threads", "th-pre"))).toBe(false);
  });
});

posixDescribe("Stop interrupts the isolated-thread worktree's Git (#694, POSIX)", () => {
  it("a stop while the new thread's worktree add holds ends Git's add gently, leaves no worktree, and the next turn creates it", async () => {
    const w = world();
    const before = w.userState();
    w.hold();
    const stop = new AbortController();
    const prepared = ensureThreadWorktree(w.repo, "th-new", { signal: stop.signal });
    await until("the worktree checkout to hold", () => w.held().length >= 2);
    const held = await identify(w.held());
    expect(await allAlive(held)).toBe(true); // proven identities, not a vacuous exit
    stop.abort();
    const outcome = await settled(prepared);
    expect(outcome.settled).toBe(true);
    expect(outcome.error, why(outcome.error)).toBeInstanceOf(PreparationCancelled);
    await until("the stopped children to exit", () => allEnded(held), 10_000);
    // Git's own SIGINT cleanup removed the registration and directory; this call
    // then removed its own new branch. The user's repository is as it was.
    expect(w.registered(w.tree("th-new"))).toBe(false);
    expect(w.branch("th-new")).toBe("");
    expect(existsSync(w.threadDir("th-new"))).toBe(false);
    expect(w.userState()).toEqual(before);

    w.unhold();
    const next = await ensureThreadWorktree(w.repo, "th-new");
    expect(next.created).toBe(true);
    expect(readFileSync(join(next.path, "y.held"), "utf8")).toBe("committed\n");
    expect(w.registered(next.path)).toBe(true);
    expect(w.userState()).toEqual(before);
  }, 120_000);

  it("a stopped `git worktree add` ends gently: Git itself removes its registration, the branch stays for its caller", async () => {
    const w = world();
    const base = git(w.repo, "rev-parse", "HEAD");
    const path = w.tree("th-direct");
    w.hold();
    const stop = new AbortController();
    const added = worktreeAdd(w.repo, path, "claudexor/thread-th-direct", base, stop.signal);
    await until("the worktree checkout to hold", () => w.held().length >= 2);
    const held = await identify(w.held());
    stop.abort();
    const outcome = await settled(added);
    expect(outcome.error, why(outcome.error)).toBeInstanceOf(PreparationCancelled);
    await until("the stopped children to exit", () => allEnded(held), 10_000);
    // A SIGKILL would have left the registration locked "initializing"; SIGINT let Git
    // remove it and the directory. The branch Git made is its caller's to remove.
    expect(w.registered(path)).toBe(false);
    expect(existsSync(path)).toBe(false);
    expect(w.branch("th-direct")).toContain("claudexor/thread-th-direct");
  }, 120_000);

  it("an add killed before Git's own cleanup leaves its locked registration, which this call alone removes", async () => {
    const w = world();
    const before = w.userState();
    w.hold();
    const prepared = ensureThreadWorktree(w.repo, "th-killed", {
      signal: new AbortController().signal,
    });
    await until("the worktree checkout to hold", () => w.held().length >= 2);
    const [filterPid] = w.held() as [number];
    const add = await worktreeAddProcess(filterPid);
    expect(await allAlive([add])).toBe(true);
    // A kill Git cannot clean up after (as an escalation, an OOM or an operator would):
    // this test's own child, by its proven identity.
    process.kill(add.pid, "SIGKILL");
    await until("the killed add to be gone", () => allEnded([add]), 10_000);
    // What Git leaves: the registration, locked "initializing" (and the branch it holds).
    expect(git(w.repo, "worktree", "list", "--porcelain")).toContain("locked initializing");
    expect(w.registered(w.tree("th-killed"))).toBe(true);
    writeFileSync(w.release, ""); // its orphaned checkout may now finish and close the pipes
    const outcome = await settled(prepared);
    expect(outcome.settled).toBe(true);
    expect(outcome.error).toBeInstanceOf(Error);
    expect((outcome.error as Error).message).toContain("SIGKILL");
    expect((outcome.error as Error).message).not.toContain("could not be removed");
    expect(w.registered(w.tree("th-killed"))).toBe(false);
    expect(w.branch("th-killed")).toBe("");
    expect(existsSync(w.threadDir("th-killed"))).toBe(false);
    expect(w.userState()).toEqual(before);

    w.unhold();
    const next = await ensureThreadWorktree(w.repo, "th-killed");
    expect(next.created).toBe(true);
    expect(w.registered(next.path)).toBe(true);
  }, 120_000);

  it("a recovery add killed after the lost directory's stale registration went: its own locked registration goes, the branch stays, the next turn recovers", async () => {
    const w = world();
    const first = await ensureThreadWorktree(w.repo, "th-stale");
    // The directory is lost WITHOUT Git: its registration stays behind, stale.
    rmSync(w.threadDir("th-stale"), { recursive: true, force: true });
    expect(w.registered(first.path)).toBe(true);
    expect(git(w.repo, "worktree", "list", "--porcelain")).toContain("prunable");
    const tip = git(w.repo, "rev-parse", "refs/heads/claudexor/thread-th-stale");
    const before = w.userState();
    w.hold();
    const prepared = ensureThreadWorktree(w.repo, "th-stale", {
      signal: new AbortController().signal,
    });
    await until("the recovery checkout to hold", () => w.held().length >= 2);
    const [filterPid] = w.held() as [number];
    const add = await worktreeAddProcess(filterPid);
    expect(await allAlive([add])).toBe(true);
    // This test's own child, by its proven identity: a kill Git cannot clean up after.
    process.kill(add.pid, "SIGKILL");
    await until("the killed add to be gone", () => allEnded([add]), 10_000);
    // The stale registration went before this add; the locked one is the add's own.
    expect(git(w.repo, "worktree", "list", "--porcelain")).toContain("locked initializing");
    writeFileSync(w.release, ""); // its orphaned checkout may now finish and close the pipes
    const outcome = await settled(prepared);
    expect(outcome.settled).toBe(true);
    expect(outcome.error).toBeInstanceOf(Error);
    expect((outcome.error as Error).message).not.toContain("could not be removed");
    expect(w.registered(first.path)).toBe(false);
    expect(git(w.repo, "rev-parse", "refs/heads/claudexor/thread-th-stale")).toBe(tip);
    expect(existsSync(w.threadDir("th-stale"))).toBe(false);
    expect(w.userState()).toEqual(before);

    w.unhold();
    const next = await ensureThreadWorktree(w.repo, "th-stale");
    expect(next).toMatchObject({ created: true, baseSha: first.baseSha });
    expect(w.registered(next.path)).toBe(true);
    expect(readFileSync(join(next.path, "y.held"), "utf8")).toBe("committed\n");
  }, 120_000);

  it("a stop while a surviving branch is checked out again keeps that branch for the next turn", async () => {
    const w = world();
    const first = await ensureThreadWorktree(w.repo, "th-kept");
    // The worktree directory is lost; its branch survives (the recovery path).
    git(w.repo, "worktree", "remove", "--force", first.path);
    rmSync(w.threadDir("th-kept"), { recursive: true, force: true });
    const tip = git(w.repo, "rev-parse", "refs/heads/claudexor/thread-th-kept");
    const before = w.userState();
    w.hold();
    const stop = new AbortController();
    const prepared = ensureThreadWorktree(w.repo, "th-kept", { signal: stop.signal });
    await until("the recovery checkout to hold", () => w.held().length >= 2);
    const held = await identify(w.held());
    expect(await allAlive(held)).toBe(true);
    stop.abort();
    stop.abort(); // a second Stop changes nothing
    const outcome = await settled(prepared);
    expect(outcome.error, why(outcome.error)).toBeInstanceOf(PreparationCancelled);
    await until("the stopped children to exit", () => allEnded(held), 10_000);
    expect(git(w.repo, "rev-parse", "refs/heads/claudexor/thread-th-kept")).toBe(tip);
    expect(w.registered(w.tree("th-kept"))).toBe(false);
    expect(w.userState()).toEqual(before);

    w.unhold();
    const next = await ensureThreadWorktree(w.repo, "th-kept");
    expect(next).toMatchObject({ created: true, baseSha: first.baseSha });
    expect(readFileSync(join(next.path, "y.held"), "utf8")).toBe("committed\n");
  }, 120_000);
});
