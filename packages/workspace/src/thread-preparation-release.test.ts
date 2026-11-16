// #694: the one release of a thread preparation, at its edges.
// - Linux: a same-uid process whose environment the census cannot read (EACCES:
//   a non-dumpable stranger such as the session's sshd) is not a member of the
//   scope and does not keep a released preparation held; a member that carried
//   the marker and then turned unreadable still does. The real Linux census
//   reader runs over an injected /proc.
// - An `early` record owns nothing of the thread: its release frees the record
//   alone and leaves a tree, a registration or a branch that was there before.
// - A branch the preparation made that moved since is kept and the release
//   completes (the thread is not refused forever); only a branch still at its
//   recorded tip that Git cannot delete fails the release, retryably.
// - Where no read can prove an end (Windows, injected): a release still runs but
//   proves nothing; a step that fails there is a hold, not a cleanup fault after
//   a proven end; and the stopped step's own process, where no group names it,
//   holds while its pid is in use.
// - A read that no longer proves the end answers its caller without the saved
//   cleanup fault even when the record cannot be rewritten.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createLinuxScopeCensusReader,
  mintRunScopeMarker,
  preparationQuiet,
  ScopeReaper,
  type AsyncProcessIdentityReader,
} from "@claudexor/core";
import { projectRuntimeDir } from "@claudexor/util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  envelopePreparationVerdict,
  holdEnvelopePreparation,
  readEnvelopePreparation,
} from "./envelope-preparation.js";
import { recordDigest } from "./preparation-release.js";
import {
  assertThreadTreeReady,
  confirmThreadRelease,
  heldFrom,
  holdThreadPreparation,
  PreparationCleanupFailed,
  PreparationHeld,
  readThreadPreparation,
  releaseThreadPreparation,
  threadPreparationRecordPath,
  threadTreeState,
  writeThreadPreparation,
  type PreparationQuietRead,
  type ThreadPreparationRecord,
} from "./preparation-hold.js";
import { ensureThreadWorktree } from "./thread-tree.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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
  execFileSync("git", ["-C", repo, ...args], { env: { ...process.env } })
    .toString()
    .trim();

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-thread-release-")));
  dirs.push(root);
  const repo = join(root, "project");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const tree = (id: string) => join(projectRuntimeDir(repo), "threads", id, "tree");
  return {
    repo,
    tree,
    head: git(repo, "rev-parse", "HEAD"),
    record: (id: string, fields: Partial<ThreadPreparationRecord>): ThreadPreparationRecord => ({
      schema: 1,
      thread_id: id,
      tree: tree(id),
      scope: null,
      opened_at: new Date().toISOString(),
      own_registration: null,
      own_branch: null,
      ...fields,
    }),
    tip: (id: string) =>
      git(repo, "for-each-ref", "--format=%(objectname)", `refs/heads/claudexor/thread-${id}`),
    registered: (id: string) =>
      git(repo, "worktree", "list", "--porcelain")
        .split("\n")
        .some((line) => line === `worktree ${tree(id)}`),
  };
}

/** The release criterion over the real Linux census reader with an injected
 * /proc: pid 10 is a same-uid stranger whose environ is always denied; pid 20
 * (only when `member`) carried `marker` at the census read and is denied at
 * its confirmation. Signals, if any were sent, are recorded. */
function linuxQuiet(marker: string, member: boolean, signals: number[]): PreparationQuietRead {
  const denied = () => Object.assign(new Error("permission denied"), { code: "EACCES" });
  const reads = new Map<number, number>();
  const census = createLinuxScopeCensusReader({
    listProc: async () => (member ? ["10", "20", "self"] : ["10", "self"]),
    readTextFile: async (path) => {
      const pid = Number(path.split("/")[2]);
      reads.set(pid, (reads.get(pid) ?? 0) + 1);
      if (pid === 10) throw denied();
      if (pid === 20 && reads.get(pid) === 1) return `PATH=/x\0${marker}=1\0`;
      if (pid === 20) throw denied();
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    },
    statUid: async () => 501,
    selfUid: 501,
  });
  const identity: AsyncProcessIdentityReader = {
    read: async (pid) => ({
      status: "known",
      pid,
      platform: "linux",
      source: "procfs_stat",
      startToken: `linux:${pid}`,
      processGroupId: pid,
    }),
  };
  return (facts) =>
    preparationQuiet(facts, {
      platform: "linux",
      deadlineMs: 500,
      census: (opts) =>
        new ScopeReaper().reap({
          ...opts,
          census,
          identity,
          signal: (pid) => signals.push(pid),
        }),
    });
}

/** A read that proves the end, as a POSIX read with nothing recorded does. The
 * tests of what follows a PROVEN end name it instead of inheriting the host's
 * read: on Windows no read is a proof (`unproven`). */
const provenQuiet: PreparationQuietRead = (facts) => preparationQuiet(facts, { platform: "linux" });

/** The release criterion as on Windows (injected): no group probe, no census;
 * only the pid probe measures, answered from `inUse`. */
const win32Quiet =
  (inUse: ReadonlySet<number> = new Set()): PreparationQuietRead =>
  (facts) =>
    preparationQuiet(facts, { platform: "win32", probePidAlive: (pid) => inUse.has(pid) });

/** A stop that left the step's own process running, as Windows reports it: no
 * process group; `exit()` is this daemon seeing that process exit. */
function directWriterStop(pid: number) {
  let exit: () => void = () => {};
  const directExit = new Promise<void>((resolve) => {
    exit = resolve;
  });
  return {
    termination: {
      reason: "direct_child_alive" as const,
      groups: [] as number[],
      rootPid: pid,
      directExited: false,
      directExit,
    },
    /** The exit, and the turn in which the record takes it. */
    exit: async () => {
      exit();
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  };
}

describe("releaseThreadPreparation (#694)", () => {
  it("linux: an unrelated same-uid process with an unreadable environment does not keep a failed preparation held; an unreadable known member does", async () => {
    const w = world();
    const marker = mintRunScopeMarker();
    const signals: number[] = [];
    const half = (id: string) => {
      mkdirSync(w.tree(id), { recursive: true });
      writeFileSync(join(w.tree(id), "half"), "checkout\n");
      writeThreadPreparation(w.record(id, { scope: { marker }, own_registration: false }));
    };

    // A known member whose membership can no longer be read: held, nothing changes.
    half("member");
    const bytes = readFileSync(threadPreparationRecordPath(w.tree("member")), "utf8");
    const held = await releaseThreadPreparation(
      w.repo,
      w.tree("member"),
      linuxQuiet(marker, true, signals),
    ).catch((e: unknown) => e);
    expect(held).toBeInstanceOf(PreparationHeld);
    expect(held).toMatchObject({
      code: "termination_unconfirmed",
      context: {
        preparation: { unresolved: ["scope member 20 could not be read (membership_unreadable)"] },
      },
    });
    expect(readFileSync(threadPreparationRecordPath(w.tree("member")), "utf8")).toBe(bytes);
    expect(readFileSync(join(w.tree("member"), "half"), "utf8")).toBe("checkout\n");

    // Only the stranger is unreadable: the same record is released.
    half("stranger");
    expect(
      await releaseThreadPreparation(
        w.repo,
        w.tree("stranger"),
        linuxQuiet(marker, false, signals),
      ),
    ).toBe("released");
    expect(existsSync(dirname(w.tree("stranger")))).toBe(false);
    // And a Retry of such a thread, which that stranger used to refuse forever,
    // releases the failed preparation itself and makes the tree.
    half("retry");
    const made = await ensureThreadWorktree(w.repo, "retry", {
      quiet: linuxQuiet(marker, false, signals),
    });
    expect(made).toMatchObject({ path: w.tree("retry"), created: true });
    expect(existsSync(join(w.tree("retry"), "half"))).toBe(false);
    expect(signals).toEqual([]); // the criterion only reads
  });

  it("an early record owns nothing of the thread: its release frees the record alone", async () => {
    const w = world();
    // Alone in its directory: the record and the empty thread directory go.
    mkdirSync(dirname(w.tree("alone")), { recursive: true });
    writeThreadPreparation(w.record("alone", { early: true }));
    expect(threadTreeState(w.tree("alone"))).toBe("held");
    expect(await releaseThreadPreparation(w.repo, w.tree("alone"))).toBe("released");
    expect(existsSync(dirname(w.tree("alone")))).toBe(false);

    // Beside what was there before it — a directory at the tree's path and a
    // surviving thread branch: both stay.
    git(w.repo, "branch", "claudexor/thread-kept", w.head);
    mkdirSync(w.tree("kept"), { recursive: true });
    writeFileSync(join(w.tree("kept"), "not-ours"), "x\n");
    writeThreadPreparation(w.record("kept", { early: true }));
    expect(await releaseThreadPreparation(w.repo, w.tree("kept"))).toBe("released");
    expect(existsSync(threadPreparationRecordPath(w.tree("kept")))).toBe(false);
    expect(readFileSync(join(w.tree("kept"), "not-ours"), "utf8")).toBe("x\n");
    expect(w.tip("kept")).toBe(w.head);

    // Over a ready tree (its project had to be initialized again): the tree, its
    // registration and its branch stay, and it is ready again.
    const ready = await ensureThreadWorktree(w.repo, "ready");
    writeFileSync(join(ready.path, "work"), "w\n");
    writeThreadPreparation(w.record("ready", { early: true }));
    expect(threadTreeState(ready.path)).toBe("held");
    expect(await releaseThreadPreparation(w.repo, ready.path)).toBe("released");
    expect(threadTreeState(ready.path)).toBe("ready");
    expect(readFileSync(join(ready.path, "work"), "utf8")).toBe("w\n");
    expect(w.registered("ready")).toBe(true);
    expect(w.tip("ready")).toBe(ready.baseSha);
  });

  it("a branch the preparation made that moved since is kept and the release completes: Retry recovers the thread from it", async () => {
    const w = world();
    /** What a killed `worktree add -b` leaves: the registration, a tree and the new branch. */
    const halfAdd = (id: string) => {
      mkdirSync(dirname(w.tree(id)), { recursive: true });
      git(w.repo, "worktree", "add", "-q", "-b", `claudexor/thread-${id}`, w.tree(id), w.head);
      writeThreadPreparation(
        w.record(id, {
          own_registration: true,
          own_branch: { name: `claudexor/thread-${id}`, tip: w.head },
        }),
      );
    };

    // Control: still at its recorded tip — the branch is this preparation's and goes.
    halfAdd("own");
    expect(await releaseThreadPreparation(w.repo, w.tree("own"))).toBe("released");
    expect(w.tip("own")).toBe("");
    expect(w.registered("own")).toBe(false);
    expect(existsSync(dirname(w.tree("own")))).toBe(false);

    // Moved: someone committed on it between the failure and the release.
    halfAdd("moved");
    git(w.tree("moved"), "commit", "-q", "--allow-empty", "-m", "someone's commit");
    const moved = w.tip("moved");
    expect(moved).not.toBe(w.head);
    expect(await releaseThreadPreparation(w.repo, w.tree("moved"))).toBe("released");
    expect(w.tip("moved")).toBe(moved); // kept, as it is now
    expect(w.registered("moved")).toBe(false);
    expect(existsSync(dirname(w.tree("moved")))).toBe(false); // the record went too
    // The thread is not trapped: its next turn recovers the tree from that branch.
    const recovered = await ensureThreadWorktree(w.repo, "moved");
    expect(recovered).toMatchObject({ path: w.tree("moved"), created: true, baseSha: moved });
    expect(threadTreeState(w.tree("moved"))).toBe("ready");
    // And the turn after it reuses that tree.
    expect(await ensureThreadWorktree(w.repo, "moved")).toMatchObject({ created: false });
  });

  it("a branch still at its recorded tip that Git cannot delete fails the release, recorded once and retryable", async () => {
    const w = world();
    mkdirSync(dirname(w.tree("locked")), { recursive: true });
    git(w.repo, "branch", "claudexor/thread-locked", w.head);
    writeThreadPreparation(
      w.record("locked", {
        own_registration: false,
        own_branch: { name: "claudexor/thread-locked", tip: w.head },
      }),
    );
    // Another writer holds the ref's lock.
    const lock = join(w.repo, ".git", "refs", "heads", "claudexor", "thread-locked.lock");
    writeFileSync(lock, "");
    const failed = await releaseThreadPreparation(w.repo, w.tree("locked"), provenQuiet).catch(
      (e: unknown) => e,
    );
    // The read proved the end before this step: a cleanup fault, typed as one.
    expect(failed).toBeInstanceOf(PreparationCleanupFailed);
    expect(failed).toMatchObject({ code: "preparation_cleanup_failed", retryable: true });
    expect((failed as PreparationCleanupFailed).context).not.toHaveProperty(
      "termination_unconfirmed",
    );
    expect((failed as Error).message).toMatch(/still at the tip.*could not be deleted/s);
    expect(w.tip("locked")).toBe(w.head);
    const recorded = readFileSync(threadPreparationRecordPath(w.tree("locked")), "utf8");
    expect(readThreadPreparation(w.tree("locked"))?.cleanup_error).toMatch(/could not be deleted/);
    // The same fault again rewrites nothing.
    await expect(
      releaseThreadPreparation(w.repo, w.tree("locked"), provenQuiet),
    ).rejects.toBeInstanceOf(PreparationCleanupFailed);
    expect(readFileSync(threadPreparationRecordPath(w.tree("locked")), "utf8")).toBe(recorded);
    rmSync(lock);
    expect(await releaseThreadPreparation(w.repo, w.tree("locked"))).toBe("released");
    expect(w.tip("locked")).toBe("");
  });

  it("readers of the tree refuse with what its record states: a recorded cleanup fault, a hold once a read no longer proves the end, a hold for an unreadable record", async () => {
    const w = world();
    const tree = w.tree("readers");
    const recordPath = threadPreparationRecordPath(tree);
    const refusal = (): unknown => {
      try {
        assertThreadTreeReady(tree);
        return undefined;
      } catch (error) {
        return error;
      }
    };
    mkdirSync(dirname(tree), { recursive: true });
    git(w.repo, "branch", "claudexor/thread-readers", w.head);
    writeThreadPreparation(
      w.record("readers", {
        own_registration: false,
        own_branch: { name: "claudexor/thread-readers", tip: w.head },
        held: { reason: "output_held", groups: [], at: new Date().toISOString() },
      }),
    );
    // Before any release: a stop whose end is not proven.
    expect(refusal()).toMatchObject({ code: "termination_unconfirmed" });
    // The real release proves the end, then Git cannot delete the branch (a held ref lock).
    const lock = join(w.repo, ".git", "refs", "heads", "claudexor", "thread-readers.lock");
    writeFileSync(lock, "");
    await expect(releaseThreadPreparation(w.repo, tree, provenQuiet)).rejects.toBeInstanceOf(
      PreparationCleanupFailed,
    );
    const cleanup = refusal();
    expect(cleanup).toBeInstanceOf(PreparationCleanupFailed);
    expect(cleanup).toMatchObject({
      code: "preparation_cleanup_failed",
      retryable: true,
      requiredActions: [expect.stringContaining("Clear what prevents the cleanup")],
      context: {
        held: [tree],
        preparation: { cleanup_error: expect.stringMatching(/could not be deleted/) },
      },
    });
    const context = (cleanup as PreparationCleanupFailed).context;
    expect(context).not.toHaveProperty("termination_unconfirmed");
    expect(context.preparation).not.toHaveProperty("held"); // the stop is history there
    // A later release whose read does not prove the end any more: a hold, and the
    // record stops stating a proven end; nothing the preparation made changes.
    const held = await releaseThreadPreparation(w.repo, tree, async () => ({
      status: "held",
      reasons: ["scope member 7 is alive"],
    })).catch((e: unknown) => e);
    expect(held).toBeInstanceOf(PreparationHeld);
    expect(held).toMatchObject({
      code: "termination_unconfirmed",
      context: { preparation: { unresolved: ["scope member 7 is alive"] } },
    });
    expect((held as PreparationHeld).context.preparation).not.toHaveProperty("cleanup_error");
    expect(readThreadPreparation(tree)).not.toHaveProperty("cleanup_error");
    expect(readThreadPreparation(tree)).toMatchObject({
      own_branch: { name: "claudexor/thread-readers", tip: w.head },
      held: { reason: "output_held" },
    });
    expect(w.tip("readers")).toBe(w.head);
    expect(refusal()).toMatchObject({
      code: "termination_unconfirmed",
      requiredActions: [
        expect.stringContaining("Wait for the stopped preparation's processes"),
        expect.stringContaining("gc release-preparation"),
      ],
      context: { termination_unconfirmed: { reason: "output_held" } },
    });
    // A record that cannot be read is a hold too, never a cleanup fault.
    const bytes = readFileSync(recordPath, "utf8");
    writeFileSync(recordPath, bytes.slice(0, bytes.length / 2));
    expect(refusal()).toBeInstanceOf(PreparationHeld);
    expect(refusal()).toMatchObject({
      context: { termination_unconfirmed: { reason: "record_unreadable" } },
    });
    writeFileSync(recordPath, bytes);
    // The fault cleared: the next release finishes and readers find no tree to refuse.
    rmSync(lock);
    expect(await releaseThreadPreparation(w.repo, tree)).toBe("released");
    expect(refusal()).toBeUndefined();
    expect(threadTreeState(tree)).toBe("absent");
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "a half checkout that cannot be removed whole fails the release with its record still stating the facts; cleared, the record goes last",
    async () => {
      const w = world();
      const tree = w.tree("half");
      const recordPath = threadPreparationRecordPath(tree);
      // What a killed checkout left: files, and a directory whose entries cannot go.
      mkdirSync(join(tree, "sub", "locked"), { recursive: true });
      writeFileSync(join(tree, "a.txt"), "a\n");
      writeFileSync(join(tree, "sub", "locked", "b.txt"), "b\n");
      writeThreadPreparation(w.record("half", { own_registration: false }));
      chmodSync(join(tree, "sub", "locked"), 0o500);
      try {
        const failed = await releaseThreadPreparation(w.repo, tree).catch((e: unknown) => e);
        expect(failed).toBeInstanceOf(PreparationCleanupFailed);
        expect(failed).toMatchObject({
          code: "preparation_cleanup_failed",
          context: {
            held: [tree],
            preparation: { cleanup_error: expect.stringMatching(/EACCES/) },
          },
        });
        // The record outlives the refused removal, with the fault; the tree is still held.
        expect(readThreadPreparation(tree)).toMatchObject({
          own_registration: false,
          cleanup_error: expect.stringMatching(/EACCES/),
        });
        expect(existsSync(join(tree, "sub", "locked", "b.txt"))).toBe(true);
        expect(threadTreeState(tree)).toBe("held");
      } finally {
        chmodSync(join(tree, "sub", "locked"), 0o700);
      }
      expect(await releaseThreadPreparation(w.repo, tree)).toBe("released");
      expect(existsSync(recordPath)).toBe(false);
      expect(existsSync(dirname(tree))).toBe(false);
    },
  );

  it.runIf(process.platform !== "win32")(
    "an early or a complete record that cannot be removed (its directory is read-only) refuses the release as a cleanup fault, changes nothing, and goes once the fault is cleared",
    async () => {
      const w = world();
      const marker = mintRunScopeMarker();
      const quiet: PreparationQuietRead = async () => ({ status: "quiet" });
      // Early, recorded after a stop whose end is now proven: the record alone is its own.
      mkdirSync(w.tree("early"), { recursive: true });
      writeFileSync(join(w.tree("early"), "not-ours"), "x\n");
      writeThreadPreparation(
        w.record("early", {
          early: true,
          scope: { marker },
          held: { reason: "output_held", groups: [], at: new Date().toISOString() },
        }),
      );
      // Complete: a real checkout whose record came back (as after a failed removal).
      const made = await ensureThreadWorktree(w.repo, "done");
      writeFileSync(join(made.path, "work"), "w\n");
      writeThreadPreparation(w.record("done", { complete: true, own_registration: true }));
      for (const id of ["early", "done"]) {
        const dir = dirname(w.tree(id));
        const bytes = readFileSync(threadPreparationRecordPath(w.tree(id)), "utf8");
        chmodSync(dir, 0o500);
        try {
          const failed = await releaseThreadPreparation(w.repo, w.tree(id), quiet).catch(
            (e: unknown) => e,
          );
          expect(failed, id).toBeInstanceOf(PreparationCleanupFailed);
          expect(failed, id).toMatchObject({
            code: "preparation_cleanup_failed",
            retryable: true,
            context: {
              held: [w.tree(id)],
              preparation: { cleanup_error: expect.stringMatching(/EACCES/) },
            },
          });
          const context = (failed as PreparationCleanupFailed).context;
          expect(context, id).not.toHaveProperty("termination_unconfirmed");
          expect(context.preparation, id).not.toHaveProperty("held");
          // The record could not even take the fault: its bytes are as they were.
          expect(readFileSync(threadPreparationRecordPath(w.tree(id)), "utf8"), id).toBe(bytes);
          expect(threadTreeState(w.tree(id)), id).toBe("held");
        } finally {
          chmodSync(dir, 0o700);
        }
      }
      expect(await releaseThreadPreparation(w.repo, w.tree("early"), quiet)).toBe("released");
      expect(readFileSync(join(w.tree("early"), "not-ours"), "utf8")).toBe("x\n");
      expect(await releaseThreadPreparation(w.repo, w.tree("done"), quiet)).toBe("completed");
      expect(threadTreeState(made.path)).toBe("ready");
      expect(readFileSync(join(made.path, "work"), "utf8")).toBe("w\n");
      expect(w.registered("done")).toBe(true);
      expect(w.tip("done")).toBe(made.baseSha);
    },
  );
});

describe("a release where no read can prove the end (Windows, injected) (#694)", () => {
  it("r17: an unconfirmed stop is held there — no release runs by itself; once an operator's confirmation is recorded a failing step is a cleanup fault under it, kept across a restart, and the next release finishes", async () => {
    const w = world();
    const tree = w.tree("unproven");
    mkdirSync(dirname(tree), { recursive: true });
    git(w.repo, "branch", "claudexor/thread-unproven", w.head);
    writeThreadPreparation(
      w.record("unproven", {
        own_registration: false,
        own_branch: { name: "claudexor/thread-unproven", tip: w.head },
        held: { reason: "output_held", groups: [], at: new Date().toISOString() },
      }),
    );
    const recordPath = threadPreparationRecordPath(tree);
    const bytes = readFileSync(recordPath, "utf8");
    // Another writer holds the ref's lock (on Windows: what a live process would).
    const lock = join(w.repo, ".git", "refs", "heads", "claudexor", "thread-unproven.lock");
    writeFileSync(lock, "");
    const held = await releaseThreadPreparation(w.repo, tree, win32Quiet()).catch(
      (e: unknown) => e,
    );
    expect(held).toBeInstanceOf(PreparationHeld);
    expect(held).not.toBeInstanceOf(PreparationCleanupFailed);
    expect(held).toMatchObject({
      code: "termination_unconfirmed",
      retryable: true,
      context: {
        held: [tree],
        release_requires: "operator_confirmation",
        termination_unconfirmed: { reason: "output_held" },
        preparation: {
          unresolved: [expect.stringMatching(/no process groups to probe and no process census/)],
        },
      },
    });
    // Nothing ran: the record is byte-for-byte what it was, the branch is where it was.
    expect(readFileSync(recordPath, "utf8")).toBe(bytes);
    expect(w.tip("unproven")).toBe(w.head);
    // Even the preparation's own platform-limit call cannot release a recorded stop.
    await expect(
      releaseThreadPreparation(w.repo, tree, win32Quiet(), { platformLimit: true }),
    ).rejects.toBeInstanceOf(PreparationHeld);
    // A stale digest (the record changed since it was inspected) changes nothing.
    expect(
      await confirmThreadRelease(w.repo, tree, {
        digest: recordDigest(`${bytes} `),
        readWriter: null,
        quiet: win32Quiet(),
      }),
    ).toMatchObject({ outcome: "stale" });
    expect(readFileSync(recordPath, "utf8")).toBe(bytes);
    // The operator confirms the inspected record: the confirmation is recorded first,
    // then the release runs and Git cannot delete the branch — a cleanup fault.
    const confirmed = await confirmThreadRelease(w.repo, tree, {
      digest: recordDigest(bytes),
      readWriter: null,
      quiet: win32Quiet(),
    });
    expect(confirmed).toMatchObject({
      outcome: "cleanup_failed",
      basis: "operator_confirmed",
      continued: false,
      cleanup_error: expect.stringMatching(/could not be deleted/),
    });
    const after = readThreadPreparation(tree)!;
    expect(after.operator_release).toMatchObject({
      generation: `thread:unproven:${after.opened_at}:${after.held!.at}`,
      observation: { reasons: [], unproven: expect.any(String) },
    });
    expect(after.cleanup_error).toMatch(/could not be deleted/);
    expect(() => assertThreadTreeReady(tree)).toThrow(PreparationCleanupFailed);
    // A new daemon (any later release, nothing in memory): the same confirmation
    // stands for this record, so the fault is a cleanup fault again, not a hold.
    await expect(releaseThreadPreparation(w.repo, tree, win32Quiet())).rejects.toBeInstanceOf(
      PreparationCleanupFailed,
    );
    // A process a read measures alive still holds, confirmation or not.
    const alive = await releaseThreadPreparation(w.repo, tree, async () => ({
      status: "held",
      reasons: ["scope member 7 is alive"],
    })).catch((e: unknown) => e);
    expect(alive).toBeInstanceOf(PreparationHeld);
    expect((alive as PreparationHeld).context).not.toHaveProperty("release_requires");
    expect(w.tip("unproven")).toBe(w.head);
    rmSync(lock);
    expect(await releaseThreadPreparation(w.repo, tree, win32Quiet())).toBe("released");
    expect(w.tip("unproven")).toBe("");
    expect(threadTreeState(tree)).toBe("absent");
  });

  it("r17 healthy path: after an ordinary failure (no stop recorded) the preparation's own call still releases under the platform's tree-only limit; a later consumer of the same record does not", async () => {
    const w = world();
    const tree = w.tree("ordinary");
    mkdirSync(tree, { recursive: true });
    writeThreadPreparation(w.record("ordinary", { own_registration: false }));
    // A later consumer (a crash left this record): held, the operator's to confirm.
    await expect(releaseThreadPreparation(w.repo, tree, win32Quiet())).rejects.toMatchObject({
      context: { release_requires: "operator_confirmation" },
    });
    expect(
      await releaseThreadPreparation(w.repo, tree, win32Quiet(), { platformLimit: true }),
    ).toBe("released");
    expect(threadTreeState(tree)).toBe("absent");
  });

  it("an old PID-only record after Restart holds while its pid is in use; no current handle remains and the operator can confirm", async () => {
    const w = world();
    const tree = w.tree("writer");
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, "half"), "checkout\n");
    // Only persisted bytes survived Restart; calling holdThreadPreparation here
    // would incorrectly create a CURRENT child observation in this daemon.
    writeThreadPreparation(
      w.record("writer", {
        own_registration: false,
        held: heldFrom(directWriterStop(4242).termination),
      }),
    );
    // The record names the process: nothing else of this stop can be measured there.
    expect(readThreadPreparation(tree)?.held).toMatchObject({
      reason: "direct_child_alive",
      groups: [],
      direct_writer_pid: 4242,
    });
    expect(readThreadPreparation(tree)?.held).not.toHaveProperty("direct_exit_observed_at");
    // A new daemon reads the same record: held while that pid is in use.
    const held = await releaseThreadPreparation(w.repo, tree, win32Quiet(new Set([4242]))).catch(
      (e: unknown) => e,
    );
    expect(held).toBeInstanceOf(PreparationHeld);
    expect(held).toMatchObject({
      code: "termination_unconfirmed",
      context: {
        held: [tree],
        termination_unconfirmed: { reason: "direct_child_alive" },
        preparation: { unresolved: [expect.stringMatching(/own process 4242 .* still in use/)] },
      },
    });
    expect(readFileSync(join(tree, "half"), "utf8")).toBe("checkout\n");
    // The same holds where a read can prove the rest (POSIX): a measured process is not an end.
    await expect(
      releaseThreadPreparation(w.repo, tree, (facts) =>
        preparationQuiet(facts, { platform: "linux", probePidAlive: () => true }),
      ),
    ).rejects.toBeInstanceOf(PreparationHeld);
    // The pid is free: nothing measured holds any more, but nothing proves the end of
    // what it started either (Windows): still held, the operator's to confirm (r17).
    await expect(releaseThreadPreparation(w.repo, tree, win32Quiet())).rejects.toMatchObject({
      context: { release_requires: "operator_confirmation" },
    });
    expect(readFileSync(join(tree, "half"), "utf8")).toBe("checkout\n");
    expect(
      await confirmThreadRelease(w.repo, tree, {
        digest: recordDigest(readFileSync(threadPreparationRecordPath(tree))),
        readWriter: null,
        quiet: win32Quiet(),
      }),
    ).toMatchObject({ outcome: "released", basis: "operator_confirmed" });
    expect(threadTreeState(tree)).toBe("absent");
  });

  it("this daemon seeing that process exit rewrites the hold: the pid is no longer waited on (another process may have taken it), and only the hold that stop wrote is touched", async () => {
    const w = world();
    const tree = w.tree("seen");
    mkdirSync(tree, { recursive: true });
    writeThreadPreparation(w.record("seen", { own_registration: false }));
    const first = directWriterStop(4242);
    holdThreadPreparation(tree, first.termination);
    const before = readThreadPreparation(tree)!.held!;
    await first.exit();
    const after = readThreadPreparation(tree)!.held!;
    expect(after).not.toHaveProperty("direct_writer_pid");
    expect(after).toMatchObject({ reason: "direct_child_alive", groups: [], at: before.at });
    expect(after.direct_exit_observed_at).toEqual(expect.any(Number));
    // Pid 4242 names another process by now: it holds nothing of this record; what
    // is left unread is the end of what the writer started (r17: the operator's).
    const left = await releaseThreadPreparation(w.repo, tree, win32Quiet(new Set([4242]))).catch(
      (e: unknown) => e,
    );
    expect(left).toMatchObject({
      context: {
        release_requires: "operator_confirmation",
        preparation: { unresolved: [expect.not.stringMatching(/4242/)] },
      },
    });

    // A later stop's hold is not touched by an earlier stop's exit.
    const other = w.tree("later");
    mkdirSync(other, { recursive: true });
    writeThreadPreparation(w.record("later", { own_registration: false }));
    const earlier = directWriterStop(5151);
    holdThreadPreparation(other, earlier.termination);
    await new Promise((resolve) => setTimeout(resolve, 5));
    holdThreadPreparation(other, directWriterStop(6161).termination);
    const later = readFileSync(threadPreparationRecordPath(other), "utf8");
    await earlier.exit();
    expect(readFileSync(threadPreparationRecordPath(other), "utf8")).toBe(later);
    expect(readThreadPreparation(other)?.held).toMatchObject({ direct_writer_pid: 6161 });
    // A record that has gone is not brought back.
    const gone = w.tree("gone");
    mkdirSync(gone, { recursive: true });
    writeThreadPreparation(w.record("gone", { own_registration: false }));
    const stop = directWriterStop(7171);
    holdThreadPreparation(gone, stop.termination);
    rmSync(threadPreparationRecordPath(gone));
    await stop.exit();
    expect(existsSync(threadPreparationRecordPath(gone))).toBe(false);
  });

  it("a stop that recorded a process group (POSIX) names no direct writer: its record is as before, and the group's probe answers for it", async () => {
    const w = world();
    const tree = w.tree("grouped");
    mkdirSync(tree, { recursive: true });
    writeThreadPreparation(w.record("grouped", { own_registration: false }));
    holdThreadPreparation(tree, {
      reason: "direct_child_alive",
      groups: [4242],
      rootPid: 4242,
      directExited: false,
      directExit: Promise.resolve(),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const held = readThreadPreparation(tree)!.held!;
    expect(Object.keys(held).sort()).toEqual(["at", "groups", "reason"]);
    expect(held.groups).toEqual([4242]);
  });

  it("a current envelope child holds despite a quiet PID probe; its observed exit stamps the record and leaves only the tree limitation", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-base-writer-")));
    dirs.push(root);
    const marker = mintRunScopeMarker();
    writeFileSync(
      join(root, "owner.json"),
      `${JSON.stringify({ pid: 1, preparation: { scope_marker: marker, preparing: true } })}\n`,
    );
    const stop = directWriterStop(4242);
    await holdEnvelopePreparation(root, stop.termination);
    expect(readEnvelopePreparation(root)).toMatchObject({
      scope_marker: marker,
      preparing: true,
      held: { reason: "direct_child_alive", groups: [], direct_writer_pid: 4242 },
    });
    // Current handle evidence cannot be overridden by a confirmation or a PID read.
    expect(await envelopePreparationVerdict(root, win32Quiet(new Set([4242])))).toEqual({
      status: "held",
      reasons: [expect.stringMatching(/current child has not exited/)],
    });
    // An empty injected PID probe still cannot release the actual current child.
    expect(await envelopePreparationVerdict(root, win32Quiet())).toEqual({
      status: "held",
      reasons: [expect.stringMatching(/current child has not exited/)],
    });
    await stop.exit();
    // The base's stamp is an awaited write off the main thread (#704): bounded wait.
    for (let i = 0; i < 250 && readEnvelopePreparation(root)?.held?.direct_writer_pid; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const held = readEnvelopePreparation(root)?.held;
    expect(held).not.toHaveProperty("direct_writer_pid");
    expect(held?.direct_exit_observed_at).toEqual(expect.any(Number));
    // The stamp took the pid off: it no longer holds; the unread end still does (r17).
    expect(await envelopePreparationVerdict(root, win32Quiet(new Set([4242])))).toEqual({
      status: "held",
      reasons: [expect.stringMatching(/no process groups to probe/)],
      operatorMayConfirm: true,
    });
  });
});

describe("a read that no longer proves the end, over a record that cannot be rewritten (#694)", () => {
  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "answers its caller with the current facts, without the saved cleanup fault; the record keeps that fault for the readers that only read it, until a release can write",
    async () => {
      const w = world();
      const tree = w.tree("stale");
      const dir = dirname(tree);
      mkdirSync(dir, { recursive: true });
      writeThreadPreparation(
        w.record("stale", {
          own_registration: false,
          held: { reason: "output_held", groups: [], at: new Date().toISOString() },
          cleanup_error: "an earlier release could not remove the record",
        }),
      );
      const recordPath = threadPreparationRecordPath(tree);
      const bytes = readFileSync(recordPath, "utf8");
      const stillRuns: PreparationQuietRead = async () => ({
        status: "held",
        reasons: ["scope member 7 is alive"],
      });
      chmodSync(dir, 0o500); // the record cannot be rewritten
      try {
        const held = await releaseThreadPreparation(w.repo, tree, stillRuns).catch(
          (e: unknown) => e,
        );
        // The caller of this release gets what its own read says: a hold, no cleanup fault.
        expect(held).toBeInstanceOf(PreparationHeld);
        expect(held).toMatchObject({
          code: "termination_unconfirmed",
          context: {
            held: [tree],
            termination_unconfirmed: { reason: "output_held" },
            preparation: { unresolved: ["scope member 7 is alive"] },
          },
        });
        expect((held as PreparationHeld).context.preparation).not.toHaveProperty("cleanup_error");
        // The record could not take it: readers that only read it (Apply, a read-only
        // turn, file reads) still refuse, with the last cleanup fault that was saved.
        expect(readFileSync(recordPath, "utf8")).toBe(bytes);
        expect(() => assertThreadTreeReady(tree)).toThrow(PreparationCleanupFailed);
        expect(threadTreeState(tree)).toBe("held");
      } finally {
        chmodSync(dir, 0o700);
      }
      // Writable again: the next such release takes the fault off the record too.
      await expect(releaseThreadPreparation(w.repo, tree, stillRuns)).rejects.toBeInstanceOf(
        PreparationHeld,
      );
      expect(readThreadPreparation(tree)).not.toHaveProperty("cleanup_error");
      expect(() => assertThreadTreeReady(tree)).toThrow(PreparationHeld);
      expect(await releaseThreadPreparation(w.repo, tree, provenQuiet)).toBe("released");
    },
  );
});
