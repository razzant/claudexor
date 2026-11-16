// #694 r10 B: the release criterion only reads. Survivors keep a hold and are
// never signalled by the read; a failed or unfinished census and an unreadable
// KNOWN member keep it, while a same-uid stranger whose environment the census
// could not read holds nothing (it limits completeness only); a recorded
// group's id is proven reused only by a birth in a LATER second than the
// observed exit. Real processes here are this test's own children.
//
// The group and census rules are POSIX rules: the tests that model them name
// their platform (`POSIX`) instead of inheriting the host's, since on Windows
// no group is probed and no census exists. What a read answers there — quiet
// but `unproven`, and a hold on the stopped step's own live process — has its
// own tests below, with the platform injected.
import { execFileSync, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { mintRunScopeMarker } from "./process-scope.js";
import { preparationQuiet } from "./process-scope-quiet.js";
import { ScopeReaper, type ScopeReapOutcome } from "./process-scope-census.js";
import { createLinuxScopeCensusReader } from "./process-scope-readers.js";
import type { AsyncProcessIdentityReader } from "./process-identity.js";
import type { ProcessTableReader } from "./process-table.js";

const posix = process.platform !== "win32";
/** The platform of the group and census rules, whatever host runs the test. */
const POSIX = { platform: "linux" } as const;
const children: Array<ReturnType<typeof spawn>> = [];
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
});
const outcome = (patch: Partial<ScopeReapOutcome>): ScopeReapOutcome => ({
  coverage: "marker",
  census: "ok",
  censusFailure: null,
  ended: [],
  survivors: [],
  unreadable: [],
  reusedGroups: [],
  settled: true,
  incomplete: false,
  completeness: "complete",
  completenessReason: null,
  restricted: false,
  durationMs: 0,
  ...patch,
});
const tableWith = (pid: number, birth: string): ProcessTableReader => ({
  snapshot: async () => [],
  row: async (asked) => (asked === pid ? { pid, ppid: 1, pgid: pid, birth } : null),
});
const lstart = (ms: number) => new Date(ms).toString().slice(0, 24);

describe("preparationQuiet (#694 r10 B)", () => {
  it("a recorded group still answering keeps the hold unless its id was born in a later second than the exit", async () => {
    const exitAt = Date.parse("2026-11-14T10:00:00.400Z");
    const alive = () => true;
    expect(
      await preparationQuiet({ groups: [77] }, { ...POSIX, probeGroupAlive: alive, table: null }),
    ).toEqual({
      status: "held",
      reasons: ["process group 77 still has members"],
    });
    // The same second proves nothing (lstart is rounded to the second).
    const same = await preparationQuiet(
      { groups: [77], directExitObservedAt: exitAt },
      { ...POSIX, probeGroupAlive: alive, table: tableWith(77, lstart(exitAt + 300)) },
    );
    expect(same.status).toBe("held");
    // No observed exit (a daemon crash) proves nothing either.
    const crash = await preparationQuiet(
      { groups: [77] },
      { ...POSIX, probeGroupAlive: alive, table: tableWith(77, lstart(exitAt + 5_000)) },
    );
    expect(crash.status).toBe("held");
    const later = await preparationQuiet(
      { groups: [77], directExitObservedAt: exitAt },
      { ...POSIX, probeGroupAlive: alive, table: tableWith(77, lstart(exitAt + 2_000)) },
    );
    expect(later).toEqual({ status: "quiet" });
    expect(
      await preparationQuiet({ groups: [77] }, { ...POSIX, probeGroupAlive: () => false }),
    ).toEqual({ status: "quiet" });
  });

  it("the census decides by reading: failed, an unreadable known member, unfinished or a survivor keeps the hold", async () => {
    const marker = mintRunScopeMarker();
    const read = (patch: Partial<ScopeReapOutcome>) =>
      preparationQuiet({ marker, groups: [] }, { ...POSIX, census: async () => outcome(patch) });
    expect((await read({})).status).toBe("quiet");
    expect((await read({ census: "failed", censusFailure: "ps failed" })).status).toBe("held");
    expect((await read({ survivors: [{ pid: 9, startToken: "t" }] })).status).toBe("held");
    expect((await read({ unreadable: [{ pid: 9, reason: "identity_unreadable" }] })).status).toBe(
      "held",
    );
    expect((await read({ incomplete: true })).status).toBe("held");
    // A count of same-uid environments the host's census could not read names no
    // member of this scope: it limits completeness and holds nothing.
    expect(
      await read({
        censusUnreadable: 2,
        completeness: "not_provable",
        completenessReason: "2 same-uid process environment(s) were unreadable",
      }),
    ).toEqual({ status: "quiet" });
    // The read never asks for a signal: its delivery is a no-op.
    let delivery: unknown;
    await preparationQuiet(
      { marker, groups: [] },
      {
        ...POSIX,
        census: async (opts) => {
          delivery = opts.signal;
          return outcome({});
        },
      },
    );
    expect(typeof delivery).toBe("function");
  });

  it("linux reader: a same-uid stranger with a denied environment (EACCES) holds nothing; a member that carried the marker and then turned unreadable holds", async () => {
    const marker = mintRunScopeMarker();
    const denied = () => Object.assign(new Error("permission denied"), { code: "EACCES" });
    // pid 10: a stranger of our uid whose environ is always denied (a non-dumpable
    // process, e.g. the session's sshd). pid 20: carried the marker when `member`
    // says so at the census, and is denied at its confirmation.
    const linux = (member: boolean) => {
      const reads = new Map<number, number>();
      return createLinuxScopeCensusReader({
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
    };
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
    const signals: number[] = [];
    const read = (member: boolean) =>
      preparationQuiet(
        { marker, groups: [] },
        {
          platform: "linux",
          deadlineMs: 500,
          census: (opts) =>
            new ScopeReaper().reap({
              ...opts,
              census: linux(member),
              identity,
              signal: (pid) => signals.push(pid),
            }),
        },
      );
    expect(await read(false)).toEqual({ status: "quiet" });
    expect(await read(true)).toEqual({
      status: "held",
      reasons: ["scope member 20 could not be read (membership_unreadable)"],
    });
    expect(signals).toEqual([]);
  });

  it("win32 (injected): nothing can be read there, so quiet is `unproven` and never a proof — a recorded group is not probed and the census is unsupported", async () => {
    const marker = mintRunScopeMarker();
    let probed = 0;
    const alive = () => {
      probed += 1;
      return true;
    };
    // The real census owner answers `unsupported` for win32: no reader exists.
    const verdict = await preparationQuiet(
      { marker, groups: [77], directExitObservedAt: Date.now() },
      { platform: "win32", probeGroupAlive: alive },
    );
    expect(verdict).toEqual({
      status: "quiet",
      unproven: expect.stringMatching(/no process groups to probe and no process census/),
    });
    expect(probed).toBe(0);
    // Without a marker or a group there is still nothing a read could prove.
    expect(await preparationQuiet({ groups: [] }, { platform: "win32" })).toEqual({
      status: "quiet",
      unproven: expect.any(String),
    });
    // A census that does not exist proves nothing on any platform.
    const unsupported = await preparationQuiet(
      { marker, groups: [] },
      {
        ...POSIX,
        census: async () =>
          outcome({
            coverage: "tree_only",
            census: "unsupported",
            settled: false,
            completeness: "not_provable",
            completenessReason: "no environment census exists on this platform",
          }),
      },
    );
    expect(unsupported).toEqual({
      status: "quiet",
      unproven: "no environment census exists on this platform",
    });
    // Negative control: the same facts read on POSIX are a proof, with no `unproven`.
    expect(
      await preparationQuiet(
        { marker, groups: [77] },
        { ...POSIX, probeGroupAlive: () => false, census: async () => outcome({}) },
      ),
    ).toEqual({ status: "quiet" });
  });

  it("the stopped step's own process, recorded where no group names it, holds while its pid is in use (win32 injected, and POSIX); once free the read is quiet, on win32 still unproven", async () => {
    const facts = { groups: [], directWriterPid: 4242 };
    const asked: number[] = [];
    const inUse = (pid: number) => {
      asked.push(pid);
      return true;
    };
    for (const platform of ["win32", "linux"] as const) {
      // The pid alone is the reason (`writerInUse`); on win32 the rest proves nothing too.
      expect(await preparationQuiet(facts, { platform, probePidAlive: inUse })).toEqual({
        status: "held",
        reasons: [
          "the stopped step's own process 4242 had not exited at its stop and that pid is still in use",
        ],
        writerInUse: 4242,
        ...(platform === "win32" ? { unproven: expect.any(String) } : {}),
      });
    }
    expect(asked).toEqual([4242, 4242]);
    expect(
      await preparationQuiet(facts, { platform: "win32", probePidAlive: () => false }),
    ).toEqual({ status: "quiet", unproven: expect.any(String) });
    expect(await preparationQuiet(facts, { ...POSIX, probePidAlive: () => false })).toEqual({
      status: "quiet",
    });
    // No recorded direct writer: the pid probe is never asked.
    asked.length = 0;
    await preparationQuiet({ groups: [] }, { platform: "win32", probePidAlive: inUse });
    expect(asked).toEqual([]);
  });

  it("the real pid probe (native on every platform): this test's own live child holds as a recorded direct writer and is not signalled; after its exit the hold is gone", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    children.push(child);
    await new Promise((resolve) => child.once("spawn", resolve));
    const facts = { groups: [], directWriterPid: child.pid! };
    const held = await preparationQuiet(facts);
    expect(held).toEqual({
      status: "held",
      reasons: [expect.stringContaining(`own process ${child.pid} had not exited`)],
      writerInUse: child.pid,
      ...(posix ? {} : { unproven: expect.any(String) }),
    });
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    const after = await preparationQuiet(facts);
    expect(after.status).toBe("quiet");
    // Only Windows cannot prove it: there the same answer says so.
    expect("unproven" in after).toBe(!posix);
  });

  it.runIf(posix)(
    "a captured descendant that left its group holds, is not signalled by the read, and releases once gone",
    async () => {
      const openedAt = new Date(Date.now() - 5_000).toISOString();
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        detached: true,
        stdio: "ignore",
      });
      children.push(child);
      await new Promise((r) => setTimeout(r, 200));
      const birth = execFileSync("ps", ["-o", "lstart=", "-p", String(child.pid)], {
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      })
        .toString()
        .trim();
      const marker = mintRunScopeMarker();
      const sources = {
        // Captured under an earlier group id; it now leads its own group.
        captured: [{ pid: child.pid!, pgid: 1, birth }],
        scopeStartAt: openedAt,
      };
      const held = await preparationQuiet({ marker, groups: [] }, { sources, deadlineMs: 800 });
      expect(held.status).toBe("held");
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
      expect((await preparationQuiet({ marker, groups: [] }, { sources })).status).toBe("quiet");
    },
    20_000,
  );
});
