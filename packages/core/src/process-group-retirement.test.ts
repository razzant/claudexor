// #694 r13: a marked capture child that closed by itself, with its own process
// group then proven empty (signal 0: ESRCH), ends that group as a membership
// basis. Nothing else does: a stop we asked for, a live or unknown group
// (EPERM included), Windows. The basis is REMOVED from the recorded rows, not
// flagged: a captured row that named the group keeps its pid and birth with
// `pgid: -1` (NO_GROUP_BASIS), so a reader of any age admits no leaderless
// stranger group later born under the same id, while a recorded member that
// moved to another group (D: G -> H) still counts by its own pid and birth.
// No test here signals a process that is not this test's own child.
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCaptureRaw } from "./capture-raw.js";
import { capturedCandidates, NO_GROUP_BASIS, type ProcessTableRow } from "./process-table.js";
import {
  liveChildProcesses,
  onChildGroupRetired,
  registerChildProcess,
  retireChildProcess,
  unregisterChildProcess,
  type LiveChildProcess,
} from "./process-registry.js";
import { mintRunScopeMarker, scopeMarkerEnv } from "./process-scope.js";

const unsubscribe: Array<() => void> = [];
afterEach(() => {
  for (const off of unsubscribe.splice(0)) off();
  vi.restoreAllMocks();
});
const observe = () => {
  const seen: LiveChildProcess[] = [];
  unsubscribe.push(onChildGroupRetired((child) => seen.push(child)));
  return seen;
};

const T0 = "Mon Oct 12 14:00:00 2026";
const T1 = "Mon Oct 12 14:00:05 2026";
const T2 = "Mon Oct 12 14:00:09 2026";
const T3 = "Mon Oct 12 14:00:12 2026";

describe("a group proven empty is no membership basis", () => {
  // A stranger's leaderless group born in scope under the recorded id G=500:
  // its leader is gone, its members are all born after the scope floor.
  const stranger: ProcessTableRow[] = [{ pid: 501, ppid: 1, pgid: 500, birth: T2 }];

  it("the hole while the row still names the group: the stranger group is admitted (negative control)", () => {
    const found = capturedCandidates([{ pid: 500, pgid: 500, birth: T1 }], stranger, T0);
    expect([...found.candidates.keys()]).toEqual([501]);
  });

  it("once the row lost its group (as written, and as reloaded) the stranger group is not admitted", () => {
    const found = capturedCandidates([{ pid: 500, pgid: NO_GROUP_BASIS, birth: T1 }], stranger, T0);
    expect([...found.candidates.keys()]).toEqual([]);
    expect(found.unproven).toEqual([]);
    expect(found.reusedGroups).toEqual([]);
  });

  it("a recorded member that moved to another group still counts by its own pid and birth (D: G -> H)", () => {
    const moved: ProcessTableRow[] = [{ pid: 600, ppid: 1, pgid: 700, birth: T1 }, ...stranger];
    const recorded = [{ pid: 600, pgid: NO_GROUP_BASIS, birth: T1 }];
    expect([...capturedCandidates(recorded, moved, T0).candidates.entries()]).toEqual([[600, T1]]);
    // A different birth under that pid is someone else.
    const other = capturedCandidates(
      recorded,
      [{ pid: 600, ppid: 1, pgid: 700, birth: T2 }, ...stranger],
      T0,
    );
    expect(other.candidates.size).toBe(0);
  });

  it("a group id is a basis only above 1: rows without a basis never admit a group, whatever the table shows", () => {
    // Kernel threads sit in group 0 on Linux; nothing is in group -1.
    const table: ProcessTableRow[] = [
      { pid: 2, ppid: 0, pgid: 0, birth: T2 },
      { pid: 9, ppid: 1, pgid: 1, birth: T2 },
    ];
    for (const pgid of [NO_GROUP_BASIS, 0, 1]) {
      const found = capturedCandidates([{ pid: 500, pgid, birth: T1 }], table, T0, {
        rootGroups: [{ pgid, leaderPid: 500, leaderBirth: T1 }],
      });
      expect([found.candidates.size, found.unproven, found.reusedGroups]).toEqual([0, [], []]);
    }
  });

  describe("who vouches for a live leader of G", () => {
    // A new own generation: leader 500 born at T3 with a member, both in scope.
    const generation: ProcessTableRow[] = [
      { pid: 500, ppid: 1, pgid: 500, birth: T3 },
      { pid: 510, ppid: 500, pgid: 500, birth: T3 },
    ];
    const old = { pid: 500, pgid: NO_GROUP_BASIS, birth: T1 }; // the emptied generation's leader
    const fresh = { pid: 500, pgid: 500, birth: T3 }; // captured again, as its group's leader

    it("the root group's own record comes before captured history", () => {
      // An earlier generation's leader row that never lost its group (its end was
      // not observed) no longer makes the newly registered root's group look recycled.
      const found = capturedCandidates([{ pid: 500, pgid: 500, birth: T1 }], generation, T0, {
        rootGroups: [{ pgid: 500, leaderPid: 500, leaderBirth: T3 }],
      });
      expect([...found.candidates.keys()].sort()).toEqual([500, 510]);
      expect(found.reusedGroups).toEqual([]);
    });

    it.each([
      ["old first", [old, fresh]],
      ["new first", [fresh, old]],
    ])(
      "without a root record only a row that IS the leader (pid == pgid == G) vouches: %s",
      (_order, captured) => {
        const found = capturedCandidates(captured, generation, T0);
        expect([...found.candidates.keys()].sort()).toEqual([500, 510]);
        expect(found.reusedGroups).toEqual([]);
      },
    );

    it("the emptied generation's leader row alone vouches for nothing: the group is left unproven, never admitted", () => {
      // The group is named only by a member row; its live leader has no recorded birth.
      const found = capturedCandidates(
        [old, { pid: 510, pgid: 500, birth: T3 }],
        [...generation, { pid: 511, ppid: 1, pgid: 500, birth: T3 }],
        T0,
      );
      expect([...found.candidates.keys()]).toEqual([510]); // by its own pid and birth only
      expect(found.reusedGroups).toEqual([500]);
      expect(found.unproven.sort()).toEqual([500, 511]);
    });

    it("a live leader of another birth still proves the recorded group gone", () => {
      const found = capturedCandidates([fresh], [{ pid: 500, ppid: 1, pgid: 500, birth: T2 }], T0);
      expect(found.candidates.size).toBe(0);
      expect(found.reusedGroups).toEqual([500]);
      expect(found.unproven).toEqual([]);
    });
  });
});

describe.runIf(process.platform !== "win32")("which close retires a group", () => {
  /** This test's own detached child (its own group's leader), ended after. */
  const leader = async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: true,
      stdio: "ignore",
    });
    await new Promise((resolve) => child.once("spawn", resolve));
    unsubscribe.push(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    return child.pid!;
  };

  it("only an ESRCH answer retires; an alive or unknown probe does not", async () => {
    const seen = observe();
    const pid = await leader();
    const child = registerChildProcess(pid, "leader");
    expect(child).not.toBeNull();
    retireChildProcess(child!, () => true); // alive, or a probe that failed (unknown)
    expect(seen).toEqual([]);
    const again = registerChildProcess(pid, "leader")!;
    retireChildProcess(again, () => false); // ESRCH
    expect(seen).toEqual([again]);
  });

  it("EPERM (a group this user may not signal) and any error but ESRCH are unknown, not empty", async () => {
    const seen = observe();
    const pid = await leader();
    const child = registerChildProcess(pid, "leader")!;
    // The probe itself is stubbed: nothing is sent to any process.
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });
    retireChildProcess(child); // the default probe
    expect(kill).toHaveBeenCalledWith(-pid, 0);
    expect(seen).toEqual([]);
    kill.mockImplementation(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    const again = registerChildProcess(pid, "leader")!;
    retireChildProcess(again);
    expect(seen).toEqual([again]);
  });

  it("Windows has no group to probe: nothing is concluded there", async () => {
    const seen = observe();
    const pid = await leader();
    const child = registerChildProcess(pid, "leader")!;
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      retireChildProcess(child, () => false);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    expect(seen).toEqual([]);
    expect(liveChildProcesses().some((c) => c === child)).toBe(false); // still unregistered
  });

  it("only the exact registration is removed, by a close, an error or a stop alike", async () => {
    const pid = await leader();
    const first = registerChildProcess(pid, "first")!;
    const second = registerChildProcess(pid, "second")!;
    retireChildProcess(first, () => true); // the earlier child's natural close
    unregisterChildProcess(first); // its error, or its close after a stop
    expect(liveChildProcesses().filter((c) => c.pid === pid)).toEqual([second]);
    unregisterChildProcess(second);
    expect(liveChildProcesses().some((c) => c.pid === pid)).toBe(false);
  });

  it("a stopped capture's close does not unregister a later registration under its pid", async () => {
    const marker = mintRunScopeMarker();
    const controller = new AbortController();
    let later: LiveChildProcess | null = null;
    const off = (await import("./process-registry.js")).onChildProcessRegistered((child) => {
      // Stands for the pid being reused by a newer child before the old close arrives.
      if (child.scopeMarker === marker && later === null)
        later = registerChildProcess(child.pid, "later");
    });
    unsubscribe.push(off);
    const run = runCaptureRaw(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      env: { ...process.env, ...scopeMarkerEnv(marker) },
      abortSignal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await run;
    expect(later).not.toBeNull();
    try {
      expect(liveChildProcesses().filter((c) => c.pid === later!.pid)).toEqual([later]);
    } finally {
      unregisterChildProcess(later);
    }
  });

  it("a marked capture that closes by itself with its group empty retires it", async () => {
    const seen = observe();
    const marker = mintRunScopeMarker();
    const result = await runCaptureRaw(process.execPath, ["-e", "process.exit(0)"], {
      env: { ...process.env, ...scopeMarkerEnv(marker) },
    });
    expect(result.code).toBe(0);
    const mine = seen.filter((child) => child.scopeMarker === marker);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.processGroup.pgid).toBe(mine[0]!.pid);
  });

  it("a capture whose group still has a member when it closes retires nothing", async () => {
    const seen = observe();
    const marker = mintRunScopeMarker();
    // The child leaves a background sibling in its own group (stdio detached, so
    // the capture closes), then exits.
    const result = await runCaptureRaw(
      process.execPath,
      [
        "-e",
        "const c=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},3000)'],{stdio:'ignore'});console.log(c.pid);c.unref();",
      ],
      { env: { ...process.env, ...scopeMarkerEnv(marker) } },
    );
    expect(result.code).toBe(0);
    const sibling = Number(result.stdout.trim());
    try {
      expect(seen.filter((child) => child.scopeMarker === marker)).toEqual([]);
    } finally {
      try {
        process.kill(sibling, "SIGKILL"); // this test's own grandchild, alive in that group
      } catch {
        /* already gone */
      }
    }
  });

  it("a stop we asked for retires nothing, whatever the group", async () => {
    const seen = observe();
    const marker = mintRunScopeMarker();
    const controller = new AbortController();
    const run = runCaptureRaw(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      env: { ...process.env, ...scopeMarkerEnv(marker) },
      abortSignal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await run;
    expect(seen.filter((child) => child.scopeMarker === marker)).toEqual([]);
  });
});
