// #694 r17: the operator's door over held preparation resources, through each
// resource's own release and serialization, on real files and real Git.
// - The decision: a proven end releases; where nothing can be read, only a
//   confirmation recorded at the resource and bound to its generation does; the
//   pid of a writer recorded without a birth is the one measured reason it may
//   outweigh; anything else a read measures refuses.
// - The writer observation (Windows' opt-in birth reader): born inside the
//   record's window refuses; later, missing or unknown does not stop the door.
// - Thread records: early frees itself only, complete keeps the finished tree, an
//   owned one undoes only what it made (a moved branch stays); stale digests, an
//   unwritable confirmation, a measured member and a newer generation refuse.
// - Envelope bases: a live creator in another process and this process's own
//   preparation still under way refuse; continuation custody keeps the base.
// - Staging: the prune keeps it where nothing can be read; the door removes it
//   unless its writer's recorded identity is alive or its transfer is under way.
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
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
import { dirname, join } from "node:path";
import {
  defaultProcessIdentityService,
  compareProcessBirth,
  createAsyncProcessIdentityReader,
  executeWin32ProcessTimesAsync,
  mintRunScopeMarker,
  preparationQuiet,
  runCaptureRaw,
  type KnownProcessIdentity,
  type PreparationQuietVerdict,
  type ProcessIdentity,
} from "@claudexor/core";
import { projectRuntimeDir } from "@claudexor/util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  confirmEnvelopeRelease,
  holdEnvelopePreparation,
  releaseEnvelopeBase,
} from "./envelope-preparation.js";
import { ENVELOPE_CUSTODY_FILE } from "./envelope-custody.js";
import { processStartTime } from "./envelope-recovery.js";
import { ensureObjectStore, objectStorePath } from "./object-store.js";
import { ownerState } from "./object-store-leases.js";
import {
  confirmThreadRelease,
  holdThreadPreparation,
  PreparationHeld,
  readThreadPreparation,
  releaseThreadPreparation,
  threadPreparationRecordPath,
  threadTreeState,
  writeThreadPreparation,
  type PreparationQuietRead,
  type ThreadPreparationRecord,
} from "./preparation-hold.js";
import {
  hasPreparationChild,
  observeWriter,
  preparationUnderWay,
  recordDigest,
  releaseDecision,
  stagingGeneration,
  threadGeneration,
} from "./preparation-release.js";
import {
  confirmStagingRelease,
  stagingRead,
  stagingVerdict,
  writeStagingOwner,
  type StagingOwnerRecord,
} from "./staging-owner.js";
import { ensureThreadWorktree } from "./thread-tree.js";

const posix = process.platform !== "win32";
const dirs: string[] = [];
const children: Array<ReturnType<typeof spawn>> = [];
afterEach(() => {
  // Only this test's own children, through their own handles.
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
});

describe("current child lifetime at the maintenance door (#694 V14)", () => {
  it.runIf(process.platform === "win32")(
    "native Windows: a real inherited pipe causes an unconfirmed hold, retained until explicit operator recovery",
    async () => {
      const root = temp("cx-native-held-");
      const release = join(root, "release");
      const pidFile = join(root, "holder.pid");
      const program = join(root, "holder.cjs");
      writeFileSync(
        program,
        `const fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);process.exit(0);}},20);
process.send('ready');`,
      );
      const stop = new AbortController();
      const capturing = runCaptureRaw(
        process.execPath,
        [
          "-e",
          `const {spawn}=require('node:child_process');
// On Windows a non-detached child dies with its parent's libuv Job.
// This holder must outlive the direct Node process while keeping its stderr pipe.
const c=spawn(process.execPath,[${JSON.stringify(program)}],{detached:true,stdio:['ignore','ignore',2,'ipc'],windowsHide:true});
c.on('message',()=>{c.disconnect();c.unref();process.exit(0);});`,
        ],
        {
          abortSignal: stop.signal,
          onExit: () =>
            queueMicrotask(() => stop.abort("direct child exited, inherited pipe still open")),
          exitDrainMs: 100,
          exitDrainMaxMs: 500,
          cancelKillDelayMs: -1,
        },
      );
      const reader = createAsyncProcessIdentityReader({
        runWin32Reader: executeWin32ProcessTimesAsync,
      });
      let birth: ProcessIdentity | undefined;
      try {
        await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 15_000 });
        const pid = Number(readFileSync(pidFile, "utf8"));
        birth = await reader.read(pid);
        expect(birth.status).toBe("known");
        const captured = await capturing;
        expect(captured.termination).toMatchObject({
          status: "unconfirmed",
          reason: "output_held",
          directExited: true,
          groups: [],
        });
        if (captured.termination?.status !== "unconfirmed")
          throw new Error("native capture did not produce the required hold");
        // Real capture outcome, real resource owner and release; no injected
        // Windows census, termination result or liveness verdict in this case.
        const base = join(root, "base");
        mkdirSync(base);
        writeFileSync(
          join(base, "owner.json"),
          JSON.stringify({
            pid: process.pid,
            started: null,
            envelope_id: "native-held",
            created_at: new Date().toISOString(),
            preparation: { preparing: true, scope_marker: null },
          }),
        );
        await holdEnvelopePreparation(base, captured.termination);
        expect(await releaseEnvelopeBase(base)).toBe(false);
        writeFileSync(release, "");
        await vi.waitFor(
          async () => {
            const now = await reader.read(pid);
            expect(birth?.status === "known" ? compareProcessBirth(birth, now) : "unknown").toMatch(
              /^(missing|different)$/,
            );
          },
          { timeout: 30_000, interval: 500 },
        );
        expect(await releaseEnvelopeBase(base)).toBe(false); // no Windows tree census after exit
        const receipt = await confirmEnvelopeRelease(base, {
          digest: recordDigest(readFileSync(join(base, "owner.json"))),
          readWriter: reader.read,
        });
        expect(receipt).toMatchObject({
          outcome: "released",
          basis: "operator_confirmed",
          stop: { reason: "output_held" },
        });
        expect(existsSync(base)).toBe(false);
      } finally {
        writeFileSync(release, "");
        stop.abort();
        await capturing;
        if (birth?.status === "known") {
          const original = birth;
          await vi.waitFor(
            async () =>
              expect(compareProcessBirth(original, await reader.read(original.pid))).toMatch(
                /^(missing|different)$/,
              ),
            { timeout: 30_000, interval: 500 },
          );
        }
      }
    },
    90_000,
  );

  it.each(["thread", "envelope"] as const)(
    "%s: refuses new and recorded confirmations until its real direct child exits",
    async (kind) => {
      const root = temp("cx-current-child-");
      const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      const directExit = once(child, "exit").then(() => {});
      await once(child, "spawn");
      const quiet: PreparationQuietRead = (facts) => preparationQuiet(facts, { platform: "win32" });
      const path = join(root, "resource");
      mkdirSync(path);
      writeFileSync(join(path, "keep"), "partial bytes");
      const recordPath =
        kind === "thread" ? threadPreparationRecordPath(path) : join(path, "owner.json");
      if (kind === "thread")
        writeThreadPreparation({
          schema: 1,
          thread_id: "current",
          tree: path,
          scope: null,
          opened_at: new Date().toISOString(),
          own_registration: false,
          own_branch: null,
        });
      else
        writeFileSync(
          recordPath,
          JSON.stringify({
            pid: process.pid,
            started: null,
            envelope_id: "current",
            created_at: new Date().toISOString(),
            preparation: { preparing: true, scope_marker: null },
          }),
        );
      const cause = {
        reason: "direct_child_alive" as const,
        groups: [],
        rootPid: child.pid!,
        directExited: false,
        directExit,
      };
      const callDone = preparationUnderWay(path);
      try {
        if (kind === "thread") holdThreadPreparation(path, cause);
        else await holdEnvelopePreparation(path, cause);
        callDone(); // the failed preparation returned; its child did not exit
        const confirm = () =>
          kind === "thread"
            ? confirmThreadRelease(root, path, {
                digest: recordDigest(readFileSync(recordPath)),
                readWriter: null,
                quiet,
              })
            : confirmEnvelopeRelease(path, {
                digest: recordDigest(readFileSync(recordPath)),
                readWriter: null,
                quiet,
              });
        const automatic = async () => {
          if (kind === "thread")
            await expect(releaseThreadPreparation(root, path, quiet)).rejects.toBeInstanceOf(
              PreparationHeld,
            );
          else expect(await releaseEnvelopeBase(path, quiet)).toBe(false);
        };
        for (let attempt = 0; attempt < 2; attempt++) {
          expect(await confirm()).toMatchObject({ outcome: "refused" });
          await automatic();
          expect(child.exitCode).toBeNull();
          expect(readFileSync(join(path, "keep"), "utf8")).toBe("partial bytes");
        }
        // An already-recorded basis cannot override the current handle either.
        const record = JSON.parse(readFileSync(recordPath, "utf8"));
        const facts = kind === "thread" ? record : record.preparation;
        facts.operator_release = {
          confirmed_at: new Date().toISOString(),
          generation:
            kind === "thread"
              ? `thread:${record.thread_id}:${record.opened_at}:${facts.held.at}`
              : `envelope:${record.envelope_id}:${record.created_at}:${facts.held.at}`,
          observation: { reasons: [] },
        };
        writeFileSync(recordPath, JSON.stringify(record));
        expect(await confirm()).toMatchObject({ outcome: "refused" });
        await automatic();
        child.stdin.end();
        await directExit;
        await vi.waitFor(() => {
          const now = JSON.parse(readFileSync(recordPath, "utf8"));
          expect((kind === "thread" ? now : now.preparation).held.direct_exit_observed_at).toEqual(
            expect.any(Number),
          );
        });
        expect(await confirm()).toMatchObject({ outcome: "released", continued: true });
        expect(existsSync(path)).toBe(false);
      } finally {
        callDone(); // disposer is idempotent
        child.stdin.end();
        await directExit;
      }
    },
  );

  // #694 V15: the hold itself can fail. The thread owns its stop's real direct
  // child before its record is read or rewritten, so neither fault leaves a
  // running child that nothing refuses for. Real child, real faults, the real
  // hold, confirmation and release; only the Windows read is injected.
  const holdFaults: Array<{
    name: string;
    portable: boolean;
    /** What the hold answers: it throws (a refused write) or returns false (unread). */
    outcome: "throws" | false;
    arm: (dir: string, recordPath: string) => () => void;
  }> = [
    {
      name: "record cannot be rewritten (a read-only thread directory: EACCES)",
      portable: false,
      outcome: "throws",
      arm: (dir) => {
        chmodSync(dir, 0o500);
        return () => chmodSync(dir, 0o700);
      },
    },
    {
      name: "record's temporary file cannot be made (a directory is in its way)",
      portable: true,
      outcome: "throws",
      arm: (_dir, recordPath) => {
        const inTheWay = `${recordPath}.${process.pid}.tmp`;
        mkdirSync(inTheWay);
        return () => rmSync(inTheWay, { recursive: true });
      },
    },
    {
      name: "record cannot be read (EACCES)",
      portable: false,
      outcome: false,
      arm: (_dir, recordPath) => {
        chmodSync(recordPath, 0o000);
        return () => chmodSync(recordPath, 0o600);
      },
    },
    {
      name: "record is torn bytes just then",
      portable: true,
      outcome: false,
      arm: (_dir, recordPath) => {
        const bytes = readFileSync(recordPath);
        writeFileSync(recordPath, bytes.subarray(0, bytes.length >> 1));
        return () => writeFileSync(recordPath, bytes);
      },
    },
  ];
  const liveChild = async () => {
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const directExit = once(child, "exit").then(() => {});
    await once(child, "spawn");
    return {
      child,
      directExit,
      cause: {
        reason: "direct_child_alive" as const,
        groups: [],
        rootPid: child.pid!,
        directExited: false,
        directExit,
      },
    };
  };
  /** A half-made thread tree with the owning record its preparation wrote. */
  const halfThread = (prefix: string) => {
    const root = temp(prefix);
    const dir = join(root, "thread");
    const tree = join(dir, "tree");
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, "keep"), "partial bytes");
    writeThreadPreparation({
      schema: 1,
      thread_id: "fault",
      tree,
      scope: null,
      opened_at: new Date().toISOString(),
      own_registration: false,
      own_branch: null,
    });
    return { root, dir, tree, recordPath: threadPreparationRecordPath(tree) };
  };

  it.each(
    holdFaults
      .filter((fault) => fault.portable || (posix && process.getuid?.() !== 0))
      .map((fault) => [fault.name, fault] as const),
  )(
    "thread: a hold whose %s still owns its real direct child — confirmations and releases refuse until it exits; then the operator's confirmation releases",
    async (_name, fault) => {
      const { root, dir, tree, recordPath } = halfThread("cx-hold-fault-");
      const { child, directExit, cause } = await liveChild();
      const quiet: PreparationQuietRead = (facts) => preparationQuiet(facts, { platform: "win32" });
      const before = readFileSync(recordPath, "utf8");
      try {
        const disarm = fault.arm(dir, recordPath);
        let answered: unknown;
        try {
          answered = holdThreadPreparation(tree, cause);
        } catch (error) {
          answered = error;
        } finally {
          disarm();
        }
        // The stop's facts are nowhere durable: the record is as it was.
        expect(readFileSync(recordPath, "utf8")).toBe(before);
        expect(readThreadPreparation(tree)).not.toHaveProperty("held");
        const confirm = () =>
          confirmThreadRelease(root, tree, {
            digest: recordDigest(readFileSync(recordPath)),
            readWriter: null,
            quiet,
          });
        const refusesAll = async () => {
          expect(await confirm()).toMatchObject({
            outcome: "refused",
            reasons: [expect.stringMatching(/current child has not exited/)],
          });
          await expect(releaseThreadPreparation(root, tree, quiet)).rejects.toMatchObject({
            context: {
              preparation: { unresolved: [expect.stringMatching(/current child has not exited/)] },
            },
          });
          // The preparation's own call after a failure (the platform's limit) too.
          await expect(
            releaseThreadPreparation(root, tree, quiet, { platformLimit: true }),
          ).rejects.toBeInstanceOf(PreparationHeld);
          expect(child.exitCode).toBeNull();
          expect(readFileSync(join(tree, "keep"), "utf8")).toBe("partial bytes");
        };
        // Its current child is owned all the same, and outweighs every release.
        await refusesAll();
        await refusesAll();
        expect(hasPreparationChild(tree)).toBe(true);
        // The hold said so: a refused write threw, an unread record answered false.
        if (fault.outcome === "throws") expect(answered).toBeInstanceOf(Error);
        else expect(answered).toBe(false);
        // A basis already recorded for this generation does not outweigh it either.
        const record = readThreadPreparation(tree)!;
        writeThreadPreparation({
          ...record,
          operator_release: {
            confirmed_at: new Date().toISOString(),
            generation: threadGeneration(record),
            observation: { reasons: [] },
          },
        });
        await refusesAll();
        // Its observed exit ends that ownership. The record never took the stop, so
        // where no read proves an end the release stays the operator's.
        child.stdin.end();
        await directExit;
        await vi.waitFor(() => expect(hasPreparationChild(tree)).toBe(false));
        expect(await confirm()).toMatchObject({
          outcome: "released",
          basis: "operator_confirmed",
          continued: true,
        });
        expect(existsSync(dir)).toBe(false);
      } finally {
        child.stdin.end();
        await directExit;
      }
    },
  );

  it("thread: an exit observation that fails proves no exit — the ownership stays for confirmations, recorded ones too, and for the automatic release", async () => {
    const { root, tree, recordPath } = halfThread("cx-exit-unobserved-");
    const quiet: PreparationQuietRead = (facts) =>
      preparationQuiet(facts, { platform: "win32", probePidAlive: () => false });
    let fail: (reason: Error) => void = () => {};
    const directExit = new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
    holdThreadPreparation(tree, {
      reason: "direct_child_alive",
      groups: [],
      rootPid: 4242,
      directExited: false,
      directExit,
    });
    fail(new Error("the exit could not be observed"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(hasPreparationChild(tree)).toBe(true);
    const record = readThreadPreparation(tree)!;
    expect(record.held).toMatchObject({ direct_writer_pid: 4242 }); // no exit was stamped
    writeThreadPreparation({
      ...record,
      operator_release: {
        confirmed_at: new Date().toISOString(),
        generation: threadGeneration(record),
        observation: { reasons: [] },
      },
    });
    expect(
      await confirmThreadRelease(root, tree, {
        digest: recordDigest(readFileSync(recordPath)),
        readWriter: null,
        quiet,
      }),
    ).toMatchObject({
      outcome: "refused",
      reasons: [expect.stringMatching(/current child has not exited/)],
    });
    await expect(releaseThreadPreparation(root, tree, quiet)).rejects.toBeInstanceOf(
      PreparationHeld,
    );
    expect(readFileSync(join(tree, "keep"), "utf8")).toBe("partial bytes");
  });

  it("thread: an exit stamp that cannot be written leaves the writer's pid on the record — the observed exit still ends the current-child ownership, and that PID-only record (all a restarted daemon has) stays the operator's to confirm", async () => {
    const { root, dir, tree, recordPath } = halfThread("cx-stamp-fault-");
    const { child, directExit, cause } = await liveChild();
    const inTheWay = `${recordPath}.${process.pid}.tmp`;
    try {
      holdThreadPreparation(tree, cause);
      const held = readFileSync(recordPath, "utf8");
      expect(JSON.parse(held).held).toMatchObject({
        reason: "direct_child_alive",
        direct_writer_pid: child.pid,
      });
      expect(hasPreparationChild(tree)).toBe(true);
      mkdirSync(inTheWay); // the stamp's rewrite of the record will be refused
      child.stdin.end();
      await directExit;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(readFileSync(recordPath, "utf8")).toBe(held);
      expect(hasPreparationChild(tree)).toBe(false);
    } finally {
      rmSync(inTheWay, { recursive: true, force: true });
      child.stdin.end();
      await directExit;
    }
    // That pid in use again (by any process): held by the measured pid, never by
    // itself released, and the operator's confirmation may cover it (r17).
    const inUse: PreparationQuietRead = (facts) =>
      preparationQuiet(facts, { platform: "win32", probePidAlive: () => true });
    await expect(releaseThreadPreparation(root, tree, inUse)).rejects.toMatchObject({
      context: {
        release_requires: "operator_confirmation",
        preparation: { unresolved: [expect.stringMatching(/own process \d+ .* still in use/)] },
      },
    });
    expect(readFileSync(join(tree, "keep"), "utf8")).toBe("partial bytes");
    expect(
      await confirmThreadRelease(root, tree, {
        digest: recordDigest(readFileSync(recordPath)),
        readWriter: null,
        quiet: inUse,
      }),
    ).toMatchObject({
      outcome: "released",
      basis: "operator_confirmed",
      writer: { pid: child.pid, outcome: "unknown" },
    });
    expect(existsSync(dir)).toBe(false);
  });

  it("an unreadable recorded staging identity stays held, including prune and an earlier confirmation; an old PID-only writer can be confirmed", async () => {
    const store = temp("cx-staging-identity-");
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const exit = once(child, "exit");
    await once(child, "spawn");
    const identity: KnownProcessIdentity = {
      status: "known",
      pid: child.pid!,
      platform: "win32",
      source: "win32_process_times",
      processGroupId: -1,
      startToken: "win32:134000000000000000",
    };
    const read = vi.spyOn(defaultProcessIdentityService, "read").mockImplementation((pid) => ({
      status: "unknown",
      pid,
      platform: process.platform,
      reason: "helper_unavailable",
    }));
    try {
      for (const recorded of [true, false]) {
        const name = `tmp_claudexor-${recorded ? "known" : "pid"}`;
        const path = join(store, "objects", name);
        mkdirSync(path, { recursive: true });
        const record: StagingOwnerRecord = {
          schema: 1,
          intent: "index-pack",
          creator: { pid: process.pid },
          scope: null,
          writer: { pid: child.pid!, ...(recorded ? { identity } : {}) },
        };
        const confirm = () =>
          confirmStagingRelease(store, name, {
            digest: recordDigest(readFileSync(join(path, "owner.json"))),
            readWriter: null,
          });
        writeStagingOwner(path, record);
        expect(await stagingVerdict(path, ownerState)).toBe("keep");
        if (recorded) {
          expect(await stagingRead(record)).not.toHaveProperty("writerInUse");
          expect(await confirm()).toMatchObject({ outcome: "refused" });
          record.operator_release = {
            generation: stagingGeneration(record),
            confirmed_at: new Date().toISOString(),
            observation: { reasons: [] },
          };
          writeStagingOwner(path, record);
          expect(await stagingVerdict(path, ownerState)).toBe("keep");
          expect(await confirm()).toMatchObject({ outcome: "refused" });
        } else {
          expect(await stagingRead(record)).toMatchObject({ writerInUse: child.pid });
          expect(await confirm()).toMatchObject({
            outcome: "released",
            basis: "operator_confirmed",
          });
        }
      }
    } finally {
      read.mockRestore();
      child.stdin.end();
      await exit;
    }
  });

  it("a parseable non-record never authorizes automatic thread cleanup", async () => {
    const root = temp("cx-malformed-prep-");
    const tree = join(root, "tree");
    mkdirSync(tree);
    writeFileSync(join(tree, "keep"), "unowned");
    writeFileSync(threadPreparationRecordPath(tree), "{}");
    await expect(
      releaseThreadPreparation(root, tree, async () => ({ status: "quiet" })),
    ).rejects.toBeInstanceOf(PreparationHeld);
    expect(readFileSync(join(tree, "keep"), "utf8")).toBe("unowned");
  });
});
afterAll(() => {
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
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

/** Windows, injected: no group probe, no census; only the pid probe measures. */
const win32Quiet =
  (inUse: ReadonlySet<number> = new Set()): PreparationQuietRead =>
  (facts) =>
    preparationQuiet(facts, { platform: "win32", probePidAlive: (pid) => inUse.has(pid) });
const memberAlive: PreparationQuietRead = async () => ({
  status: "held",
  reasons: ["process group 77 still has members"],
});

function world() {
  const root = temp("cx-prep-maint-");
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
      opened_at: new Date(Date.now() - 60_000).toISOString(),
      own_registration: null,
      own_branch: null,
      held: { reason: "output_held", groups: [], at: new Date().toISOString() },
      ...fields,
    }),
    tip: (id: string) =>
      git(repo, "for-each-ref", "--format=%(objectname)", `refs/heads/claudexor/thread-${id}`),
  };
}
const inspected = (tree: string) => recordDigest(readFileSync(threadPreparationRecordPath(tree)));
const confirm = (
  w: ReturnType<typeof world>,
  id: string,
  quiet: PreparationQuietRead,
  readWriter: ((pid: number) => Promise<ProcessIdentity>) | null = null,
) => confirmThreadRelease(w.repo, w.tree(id), { digest: inspected(w.tree(id)), readWriter, quiet });
const win32Birth = (ms: number) =>
  `win32:${(BigInt(ms) * 10_000n + 116_444_736_000_000_000n).toString()}`;
const known = (pid: number, ms: number): ProcessIdentity => ({
  status: "known",
  pid,
  platform: "win32",
  source: "win32_process_times",
  startToken: win32Birth(ms),
  processGroupId: pid,
});

describe("the release decision (#694 r17)", () => {
  const quiet: PreparationQuietVerdict = { status: "quiet" };
  const unproven: PreparationQuietVerdict = { status: "quiet", unproven: "no census" };
  const writer: PreparationQuietVerdict = {
    status: "held",
    reasons: ["writer 4242 in use"],
    writerInUse: 4242,
    unproven: "no census",
  };
  const measured: PreparationQuietVerdict = { status: "held", reasons: ["group 77 alive"] };
  const both: PreparationQuietVerdict = {
    status: "held",
    reasons: ["writer 4242 in use", "group 77 alive"],
    writerInUse: 4242,
  };
  it("a proven end releases on every ground; unproven only with a bound confirmation or the creator's platform limit; a measured member never", () => {
    const none = { operator: false, platformLimit: false };
    const op = { operator: true, platformLimit: false };
    const creator = { operator: false, platformLimit: true };
    expect(releaseDecision(quiet, none)).toMatchObject({ release: true, basis: "machine_proven" });
    expect(releaseDecision(unproven, none)).toMatchObject({
      release: false,
      operatorMayConfirm: true,
    });
    expect(releaseDecision(unproven, op)).toMatchObject({
      release: true,
      basis: "operator_confirmed",
    });
    expect(releaseDecision(unproven, creator)).toMatchObject({
      release: true,
      basis: "platform_limit",
    });
    expect(releaseDecision(writer, none)).toMatchObject({
      release: false,
      operatorMayConfirm: true,
    });
    expect(releaseDecision(writer, op)).toMatchObject({
      release: true,
      basis: "operator_confirmed",
    });
    // The creator's platform limit never covers a writer pid in use.
    expect(releaseDecision(writer, creator)).toMatchObject({ release: false });
    for (const verdict of [measured, both])
      for (const grounds of [none, op, creator])
        expect(releaseDecision(verdict, grounds)).toMatchObject({
          release: false,
          operatorMayConfirm: false,
        });
  });

  it("the writer observation: a birth inside the record's window may be the stopped writer; later, missing or unknown is no identity and no end", () => {
    const opened = Date.parse("2026-11-15T10:00:00.000Z");
    const held = Date.parse("2026-11-15T10:05:00.000Z");
    const window = {
      opened_at: new Date(opened).toISOString(),
      held_at: new Date(held).toISOString(),
    };
    expect(observeWriter(9, known(9, opened + 1_000), window).outcome).toBe("plausible_original");
    expect(observeWriter(9, known(9, held + 1_000), window).outcome).toBe("born_after_hold");
    expect(observeWriter(9, { status: "missing", pid: 9, platform: "win32" }, window).outcome).toBe(
      "missing",
    );
    expect(
      observeWriter(
        9,
        { status: "unknown", pid: 9, platform: "win32", reason: "helper_failed" },
        window,
      ),
    ).toMatchObject({ outcome: "unknown", detail: "helper_failed" });
    expect(observeWriter(9, null, window).outcome).toBe("unknown");
    // Before the record, a reversed or missing window, a non-win32 token: unknown, never an end.
    expect(observeWriter(9, known(9, opened - 1_000), window).outcome).toBe("unknown");
    expect(
      observeWriter(9, known(9, opened + 1_000), {
        opened_at: window.held_at,
        held_at: window.opened_at,
      }).outcome,
    ).toBe("unknown");
    expect(
      observeWriter(9, known(9, opened + 1_000), { opened_at: window.opened_at }).outcome,
    ).toBe("unknown");
    expect(
      observeWriter(9, { ...known(9, opened), startToken: "linux:123" } as ProcessIdentity, window)
        .outcome,
    ).toBe("unknown");
  });
});

describe("the operator's door over a thread record (#694 r17)", () => {
  it("early: frees only its record; the tree, registration and branch that were there stay as they were", async () => {
    const w = world();
    const made = await ensureThreadWorktree(w.repo, "early");
    writeFileSync(join(made.path, "work"), "w\n");
    writeThreadPreparation(w.record("early", { early: true }));
    await expect(releaseThreadPreparation(w.repo, made.path, win32Quiet())).rejects.toMatchObject({
      context: { release_requires: "operator_confirmation" },
    });
    expect(await confirm(w, "early", win32Quiet())).toMatchObject({
      outcome: "released",
      basis: "operator_confirmed",
    });
    expect(threadTreeState(made.path)).toBe("ready");
    expect(readFileSync(join(made.path, "work"), "utf8")).toBe("w\n");
    expect(w.tip("early")).toBe(made.baseSha);
  });

  it("complete: only the record goes, the finished checkout is handed over as made", async () => {
    const w = world();
    const made = await ensureThreadWorktree(w.repo, "done");
    writeFileSync(join(made.path, "work"), "w\n");
    writeThreadPreparation(
      w.record("done", {
        complete: true,
        own_registration: true,
        own_branch: { name: "claudexor/thread-done", tip: made.baseSha },
      }),
    );
    expect(await confirm(w, "done", win32Quiet())).toMatchObject({ outcome: "completed" });
    expect(threadTreeState(made.path)).toBe("ready");
    expect(readFileSync(join(made.path, "work"), "utf8")).toBe("w\n");
    expect(w.tip("done")).toBe(made.baseSha);
  });

  it("owning: undoes only what it made; a branch that moved since is kept", async () => {
    const w = world();
    const tree = w.tree("owned");
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, "half"), "x\n");
    git(w.repo, "branch", "claudexor/thread-owned", w.head);
    writeFileSync(join(w.repo, "b.txt"), "b\n");
    git(w.repo, "add", "-A");
    git(w.repo, "commit", "-qm", "moved");
    const moved = git(w.repo, "rev-parse", "HEAD");
    git(w.repo, "branch", "-f", "claudexor/thread-owned", moved);
    writeThreadPreparation(
      w.record("owned", {
        own_registration: false,
        own_branch: { name: "claudexor/thread-owned", tip: w.head },
      }),
    );
    expect(await confirm(w, "owned", win32Quiet())).toMatchObject({ outcome: "released" });
    expect(existsSync(dirname(tree))).toBe(false);
    expect(w.tip("owned")).toBe(moved);
    expect(readFileSync(join(w.repo, "a.txt"), "utf8")).toBe("a\n");
  });

  it("refuses, changing nothing: a measured member, an unreadable record, a stale digest; and a missing record is not a proof of an earlier release", async () => {
    const w = world();
    const tree = w.tree("refused");
    mkdirSync(tree, { recursive: true });
    writeThreadPreparation(w.record("refused", { own_registration: false }));
    const bytes = readFileSync(threadPreparationRecordPath(tree), "utf8");
    expect(await confirm(w, "refused", memberAlive)).toMatchObject({
      outcome: "refused",
      reasons: ["process group 77 still has members"],
    });
    expect(
      await confirmThreadRelease(w.repo, tree, {
        digest: "0".repeat(64),
        readWriter: null,
        quiet: win32Quiet(),
      }),
    ).toMatchObject({ outcome: "stale" });
    expect(readFileSync(threadPreparationRecordPath(tree), "utf8")).toBe(bytes);
    writeFileSync(threadPreparationRecordPath(tree), bytes.slice(0, 10));
    expect(await confirm(w, "refused", win32Quiet())).toMatchObject({ outcome: "refused" });
    rmSync(threadPreparationRecordPath(tree));
    expect(
      await confirmThreadRelease(w.repo, tree, {
        digest: "0".repeat(64),
        readWriter: null,
        quiet: win32Quiet(),
      }),
    ).toEqual({ outcome: "not_held" });
    expect(existsSync(join(tree, ""))).toBe(true);
  });

  it("the writer's pid alone: a birth inside the record's window refuses; one born after the stop does not stop the door, and the observation stays recorded", async () => {
    const w = world();
    const opened = Date.now() - 60_000;
    const heldAt = Date.now() - 30_000;
    for (const [id, born, outcome] of [
      ["plausible", opened + 5_000, "refused"],
      ["reused", heldAt + 5_000, "released"],
    ] as const) {
      const tree = w.tree(id);
      mkdirSync(tree, { recursive: true });
      writeThreadPreparation(
        w.record(id, {
          own_registration: false,
          opened_at: new Date(opened).toISOString(),
          held: {
            reason: "direct_child_alive" as const,
            groups: [],
            direct_writer_pid: 4242,
            at: new Date(heldAt).toISOString(),
          },
        }),
      );
      const result = await confirm(w, id, win32Quiet(new Set([4242])), async (pid) =>
        known(pid, born),
      );
      expect(result).toMatchObject({
        outcome,
        writer: {
          pid: 4242,
          outcome: outcome === "refused" ? "plausible_original" : "born_after_hold",
        },
      });
      expect(threadTreeState(tree)).toBe(outcome === "refused" ? "held" : "absent");
      if (outcome === "refused")
        expect(readThreadPreparation(tree)).not.toHaveProperty("operator_release");
    }
    // No reader (POSIX, or the reader unavailable): unknown, the operator's statement decides.
    const tree = w.tree("unread");
    mkdirSync(tree, { recursive: true });
    writeThreadPreparation(
      w.record("unread", {
        own_registration: false,
        held: {
          reason: "direct_child_alive" as const,
          groups: [],
          direct_writer_pid: 4242,
          at: new Date().toISOString(),
        },
      }),
    );
    expect(await confirm(w, "unread", win32Quiet(new Set([4242])))).toMatchObject({
      outcome: "released",
      writer: { outcome: "unknown" },
    });
  });

  it.runIf(posix && process.getuid?.() !== 0)(
    "a confirmation that cannot be written releases nothing; one bound to an older generation is not inherited",
    async () => {
      const w = world();
      const tree = w.tree("unwritable");
      mkdirSync(tree, { recursive: true });
      writeFileSync(join(tree, "half"), "x\n");
      writeThreadPreparation(w.record("unwritable", { own_registration: false }));
      const bytes = readFileSync(threadPreparationRecordPath(tree), "utf8");
      chmodSync(dirname(tree), 0o500);
      try {
        expect(await confirm(w, "unwritable", win32Quiet())).toMatchObject({
          outcome: "basis_not_recorded",
        });
      } finally {
        chmodSync(dirname(tree), 0o700);
      }
      expect(readFileSync(threadPreparationRecordPath(tree), "utf8")).toBe(bytes);
      expect(readFileSync(join(tree, "half"), "utf8")).toBe("x\n");
      // A confirmation given for an earlier hold of the same thread (another `at`).
      const record = readThreadPreparation(tree)!;
      writeThreadPreparation({
        ...record,
        operator_release: {
          confirmed_at: new Date().toISOString(),
          generation: `thread:unwritable:${record.opened_at}:2026-01-01T00:00:00.000Z`,
          observation: { reasons: [] },
        },
      });
      await expect(releaseThreadPreparation(w.repo, tree, win32Quiet())).rejects.toMatchObject({
        context: { release_requires: "operator_confirmation" },
      });
      expect(readFileSync(join(tree, "half"), "utf8")).toBe("x\n");
    },
  );
});

describe("the operator's door over an envelope base (#694 r17)", () => {
  const base = (owner: Record<string, unknown>) => {
    const root = temp("cx-prep-maint-base-");
    const dir = join(root, "workspaces", "task", "a1");
    mkdirSync(join(dir, "tree"), { recursive: true });
    writeFileSync(join(dir, "tree", "a.txt"), "a\n");
    writeFileSync(
      join(dir, "owner.json"),
      `${JSON.stringify({
        envelope_id: "env-1",
        created_at: new Date(Date.now() - 60_000).toISOString(),
        ...owner,
        preparation: {
          scope_marker: null,
          preparing: true,
          held: { reason: "output_held", groups: [], at: new Date().toISOString() },
        },
      })}\n`,
    );
    return dir;
  };
  const digestOf = (dir: string) => recordDigest(readFileSync(join(dir, "owner.json")));
  const confirmBase = (dir: string, quiet = win32Quiet()) =>
    confirmEnvelopeRelease(dir, { digest: digestOf(dir), readWriter: null, quiet });

  it("held where nothing can be read; released on confirmation, owner.json last", async () => {
    const dir = base({ pid: process.pid, started: processStartTime(process.pid) });
    expect(await releaseEnvelopeBase(dir, win32Quiet())).toBe(false);
    expect(await confirmBase(dir)).toMatchObject({
      outcome: "released",
      basis: "operator_confirmed",
    });
    expect(existsSync(dir)).toBe(false);
  });

  it("refuses while this process's own preparation of it is under way, or its creator lives in another process", async () => {
    const own = base({ pid: process.pid, started: processStartTime(process.pid) });
    const done = preparationUnderWay(own);
    expect(await confirmBase(own)).toMatchObject({
      outcome: "refused",
      reasons: [expect.stringMatching(/under way/)],
    });
    done();
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    children.push(child);
    await new Promise((resolve) => child.once("spawn", resolve));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const external = base({ pid: child.pid, started: processStartTime(child.pid!) });
    expect(await confirmBase(external)).toMatchObject({
      outcome: "refused",
      reasons: [expect.stringMatching(new RegExp(`creator pid ${child.pid}`))],
    });
    expect(existsSync(join(external, "tree", "a.txt"))).toBe(true);
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    expect(await confirmBase(external)).toMatchObject({ outcome: "released" });
  });

  it("continuation custody: the base is kept for its custody owner and only its hold is lifted", async () => {
    const dir = base({ pid: process.pid, started: processStartTime(process.pid) });
    writeFileSync(join(dir, ENVELOPE_CUSTODY_FILE), "{}\n");
    expect(await confirmBase(dir)).toMatchObject({ outcome: "completed" });
    expect(existsSync(join(dir, "tree", "a.txt"))).toBe(true);
    const owner = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8"));
    expect(owner.preparation).toMatchObject({
      preparing: false,
      operator_release: expect.any(Object),
    });
  });
});

describe.runIf(posix)("the operator's door over object-store staging (#694 r17)", () => {
  const OLD = new Date(Date.now() - 2 * 3_600_000);
  const identityOf = (pid: number): KnownProcessIdentity | undefined => {
    const read = defaultProcessIdentityService.read(pid);
    return read.status === "known" ? read : undefined;
  };
  async function store() {
    const repo = temp("cx-prep-maint-store-");
    execFileSync("git", ["init", "-q"], { cwd: repo, env: { ...process.env } });
    await ensureObjectStore(repo, "sha1");
    return objectStorePath(repo);
  }
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  function staging(storePath: string, n: number, record: StagingOwnerRecord) {
    const name = `tmp_claudexor-${uuid(n)}`;
    const dir = join(storePath, "objects", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "transfer.pack"), "x");
    writeStagingOwner(dir, record);
    for (const path of [join(dir, "transfer.pack"), join(dir, "owner.json"), dir])
      utimesSync(path, OLD, OLD);
    return { dir, name };
  }
  const deadCreator = { pid: 2 ** 22 + 17 };
  const scoped = (
    writer: StagingOwnerRecord["writer"],
    creator = deadCreator,
  ): StagingOwnerRecord => ({
    schema: 1,
    intent: "index-pack",
    creator,
    scope: { marker: mintRunScopeMarker() },
    writer,
  });
  const confirmIt = (s: string, item: { dir: string; name: string }, quiet = win32Quiet()) =>
    confirmStagingRelease(s, item.name, {
      digest: recordDigest(readFileSync(join(item.dir, "owner.json"))),
      readWriter: null,
      quiet,
    });

  it("kept by the prune where nothing can be read, removed on confirmation; a writer whose recorded identity is alive, a transfer under way and a live creator refuse", async () => {
    const s = await store();
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    children.push(child);
    await new Promise((resolve) => child.once("spawn", resolve));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const unproven = staging(s, 1, scoped(null));
    const pidOnly = staging(s, 2, scoped({ pid: child.pid! }));
    const identity = identityOf(child.pid!);
    const alive = staging(s, 3, scoped({ pid: child.pid!, ...(identity ? { identity } : {}) }));
    const self = {
      pid: process.pid,
      ...(identityOf(process.pid) ? { identity: identityOf(process.pid)! } : {}),
    };
    const underWay = staging(s, 4, scoped(null, self));
    const liveCreator = staging(s, 5, scoped(null, { pid: child.pid! }));
    // The prune's verdict where its scope read proves nothing (Windows): every one stays.
    for (const item of [unproven, pidOnly, alive, underWay, liveCreator])
      expect(await stagingVerdict(item.dir, ownerState, win32Quiet())).toBe("keep");
    expect(await confirmIt(s, unproven)).toMatchObject({ outcome: "released" });
    expect(existsSync(unproven.dir)).toBe(false);
    expect(await confirmIt(s, pidOnly)).toMatchObject({
      outcome: "released",
      basis: "operator_confirmed",
    });
    if (identity)
      expect(await confirmIt(s, alive)).toMatchObject({
        outcome: "refused",
        reasons: [expect.stringMatching(/writer .* is alive/)],
      });
    const done = preparationUnderWay(underWay.dir);
    expect(await confirmIt(s, underWay)).toMatchObject({
      outcome: "refused",
      reasons: [expect.stringMatching(/under way/)],
    });
    done();
    expect(await confirmIt(s, liveCreator)).toMatchObject({
      outcome: "refused",
      reasons: [expect.stringMatching(/creator .* may still be running/)],
    });
    expect(existsSync(liveCreator.dir)).toBe(true);
    // Its transfer over (this process created it): the confirmation releases it.
    expect(await confirmIt(s, underWay)).toMatchObject({ outcome: "released" });
    expect(existsSync(underWay.dir)).toBe(false);
  });
});
