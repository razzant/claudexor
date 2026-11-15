import { describe, expect, it } from "vitest";
import {
  ProcessIdentityService,
  compareProcessBirth,
  compareProcessIdentity,
  createAsyncProcessIdentityReader,
  createProcessObservationReader,
  executeWin32ProcessTimes,
  executeWin32ProcessTimesAsync,
  observeProcess,
  isKnownProcessIdentity,
  parseDarwinHelperOutput,
  parseLinuxProcStat,
  parseLinuxProcStatObservation,
  type KnownProcessIdentity,
  type LinuxProcessState,
  type ProcessIdentity,
  type ProcessIdentityReader,
  type ProcessObservationReader,
} from "./process-identity.js";
import { ProcessGroupService, parseProcessGroupHandle } from "./process-group.js";

const WIN32_READING = "claudexor-process-identity-win32-v1\t4242\t133700000000000000";

function win32Service(
  runWin32Reader: (pid: number) => {
    status: number | null;
    stdout: string;
    stderr: string;
    errorCode?: string;
  },
): ProcessIdentityService {
  return new ProcessIdentityService({ platform: "win32", runWin32Reader });
}

const win32Reader = () => ({ status: 0, stdout: WIN32_READING, stderr: "" });

function linuxStat(
  pid: number,
  pgid: number,
  startTicks: string,
  comm = "worker ) with spaces",
  state: LinuxProcessState | string = "S",
): string {
  // fieldsFromState[0]=state, [2]=pgrp/field5, [19]=starttime/field22.
  const fields4Through21 = Array.from({ length: 18 }, (_, index) => String(index + 1));
  fields4Through21[1] = String(pgid);
  return `${pid} (${comm}) ${state} ${fields4Through21.join(" ")} ${startTicks} 0 0 0\n`;
}

function knownLinux(pid: number, pgid: number, startToken: string): KnownProcessIdentity {
  return {
    status: "known",
    pid,
    platform: "linux",
    source: "procfs_stat",
    startToken,
    processGroupId: pgid,
  };
}

describe("locale-independent process identity", () => {
  it("parses exact Linux PGID/start ticks identically for C, English and Russian contexts", () => {
    const raw = linuxStat(4312, 4312, "987654321");
    const identities = ["C", "en_US.UTF-8", "ru_RU.UTF-8"].map(() => parseLinuxProcStat(raw, 4312));
    expect(identities).toEqual(Array(3).fill(knownLinux(4312, 4312, "linux:987654321")));
  });

  it("handles spaces/right parentheses in comm and refuses malformed or mismatched fields", () => {
    expect(parseLinuxProcStat(linuxStat(77, 77, "0", "name ) ) spaces"), 77)).toEqual(
      knownLinux(77, 77, "linux:0"),
    );
    expect(parseLinuxProcStat(linuxStat(41, 41, "123"), 42)).toMatchObject({ status: "unknown" });
    expect(parseLinuxProcStat(linuxStat(42, 42, "12.3"), 42)).toMatchObject({ status: "unknown" });
    expect(parseLinuxProcStatObservation(linuxStat(42, 42, "123", "worker", "?"), 42)).toEqual({
      identity: expect.objectContaining({ status: "unknown", reason: "malformed_response" }),
      linuxState: null,
    });
  });

  it("keeps mutable Linux state separate from byte-compatible birth identity", () => {
    const sleeping = linuxStat(77, 77, "101", "worker", "S");
    const zombie = linuxStat(77, 77, "101", "worker", "Z");
    const sleepingObservation = parseLinuxProcStatObservation(sleeping, 77);
    const zombieObservation = parseLinuxProcStatObservation(zombie, 77);

    expect(sleepingObservation.identity).toEqual(zombieObservation.identity);
    expect(parseLinuxProcStat(sleeping, 77)).toEqual(parseLinuxProcStat(zombie, 77));
    expect(sleepingObservation.linuxState).toBe("S");
    expect(zombieObservation.linuxState).toBe("Z");
    if (sleepingObservation.identity.status !== "known") throw new Error("expected known identity");
    expect(compareProcessIdentity(sleepingObservation.identity, zombieObservation.identity)).toBe(
      "same",
    );
  });

  it("reads identity and Linux state atomically while caching self identity only", () => {
    let reads = 0;
    let state: LinuxProcessState = "S";
    const options = {
      platform: "linux",
      selfPid: 55,
      readTextFile: () => {
        reads += 1;
        return linuxStat(55, 55, "900", "self", state);
      },
    };
    const service = new ProcessIdentityService(options);
    const observation = createProcessObservationReader(options);

    expect(observation.observe(55)).toMatchObject({
      linuxState: "S",
      identity: { status: "known" },
    });
    expect(reads).toBe(1);
    expect(service.self()).toMatchObject({ status: "known", startToken: "linux:900" });
    expect(reads).toBe(2);
    state = "Z";
    expect(service.self()).toMatchObject({ status: "known", startToken: "linux:900" });
    expect(reads).toBe(2);
    expect(observation.observe(55).linuxState).toBe("Z");
    expect(reads).toBe(3);
  });

  it("preserves legacy ProcessIdentityService subclass member names", () => {
    expect("observe" in new ProcessIdentityService({ platform: "win32" })).toBe(false);
    let reads = 0;
    let privateObserveCalls = 0;
    class LegacyPrivateObserveService extends ProcessIdentityService {
      constructor() {
        super({
          platform: "linux",
          readTextFile: () => {
            reads += 1;
            return linuxStat(55, 55, "900");
          },
        });
        void this.observe;
      }

      private observe(_pid: number): void {
        privateObserveCalls += 1;
      }
    }

    let publicObserveCalls = 0;
    class LegacyPublicObserveService extends ProcessIdentityService {
      observe(_pid: number): string {
        publicObserveCalls += 1;
        return "legacy-observation";
      }
    }

    let linuxObservationCalls = 0;
    class LegacyLinuxObservationService extends ProcessIdentityService {
      constructor() {
        super({
          platform: "linux",
          readTextFile: () => {
            reads += 1;
            return linuxStat(55, 55, "901");
          },
        });
        void this.readLinuxObservation;
      }

      private readLinuxObservation(_pid: number): void {
        linuxObservationCalls += 1;
      }
    }

    const privateObserve = new LegacyPrivateObserveService();
    expect(privateObserve.read(55)).toEqual(knownLinux(55, 55, "linux:900"));
    expect(privateObserveCalls).toBe(0);
    expect("observe" in privateObserve).toBe(true);

    const publicObserve = new LegacyPublicObserveService({
      platform: "linux",
      readTextFile: () => linuxStat(55, 55, "902"),
    });
    expect(publicObserve.read(55)).toEqual(knownLinux(55, 55, "linux:902"));
    expect(publicObserveCalls).toBe(0);
    expect(publicObserve.observe(55)).toBe("legacy-observation");
    expect(publicObserveCalls).toBe(1);

    const linuxObservation = new LegacyLinuxObservationService();
    expect(linuxObservation.read(55)).toEqual(knownLinux(55, 55, "linux:901"));
    expect(linuxObservationCalls).toBe(0);
    expect(reads).toBe(2);
  });

  it("uses only an explicitly supplied observation capability", () => {
    const identity = knownLinux(55, 55, "linux:1");
    let reads = 0;
    let collidingObserveCalls = 0;
    class LegacyReaderWithUnrelatedObserve implements ProcessIdentityReader {
      constructor() {
        void this.observe;
      }

      private observe(_pid: number): void {
        collidingObserveCalls += 1;
      }

      read(): ProcessIdentity {
        reads += 1;
        return identity;
      }

      self(): ProcessIdentity {
        return identity;
      }
    }
    const legacyReader = new LegacyReaderWithUnrelatedObserve();
    expect(observeProcess(legacyReader, 55)).toEqual({ identity, linuxState: null });
    expect(reads).toBe(1);
    expect(collidingObserveCalls).toBe(0);

    let observations = 0;
    const observationReader: ProcessObservationReader = {
      observe: () => ({ identity, linuxState: "Z" as const }),
    };
    observationReader.observe = () => {
      observations += 1;
      return { identity, linuxState: "Z" };
    };
    expect(observeProcess(legacyReader, 55, observationReader).linuxState).toBe("Z");
    expect(reads).toBe(1);
    expect(observations).toBe(1);
  });

  it("strictly parses Darwin PID/PGID/start and rejects localized prose", () => {
    expect(
      parseDarwinHelperOutput("claudexor-process-identity-v2\t123\t123\t1777777777\t000042\n", 123),
    ).toEqual({
      status: "known",
      pid: 123,
      platform: "darwin",
      source: "proc_pidinfo",
      startToken: "darwin:1777777777:000042",
      processGroupId: 123,
    });
    expect(parseDarwinHelperOutput("Mon Jul 14 10:00:00 2026\n", 123)).toMatchObject({
      status: "unknown",
      reason: "malformed_response",
    });
  });

  it("one process is its birth; group authority is that birth in the recorded group", () => {
    const expected = knownLinux(90, 90, "linux:100");
    const regrouped = knownLinux(90, 91, "linux:100"); // the same process after setsid/setpgid
    const reborn = knownLinux(90, 90, "linux:101"); // the pid reused by another process
    expect(compareProcessBirth(expected, regrouped)).toBe("same");
    expect(compareProcessIdentity(expected, regrouped)).toBe("different");
    for (const compare of [compareProcessBirth, compareProcessIdentity]) {
      expect(compare(expected, expected)).toBe("same");
      expect(compare(expected, reborn)).toBe("different");
      expect(compare(expected, { status: "missing", pid: 90, platform: "linux" })).toBe("missing");
      expect(
        compare(expected, { status: "unknown", pid: 90, platform: "linux", reason: "io_error" }),
      ).toBe("unknown");
    }
  });

  it("preserves missing/unknown and compares exact identity including PGID", () => {
    const expected = knownLinux(90, 90, "linux:100");
    expect(compareProcessIdentity(expected, expected)).toBe("same");
    expect(compareProcessIdentity(expected, knownLinux(90, 91, "linux:100"))).toBe("different");
    const missing = new ProcessIdentityService({
      platform: "linux",
      readTextFile: () => {
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      },
    });
    expect(missing.read(90).status).toBe("missing");

    const denied = createProcessObservationReader({
      platform: "linux",
      readTextFile: () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    });
    expect(denied.observe(90)).toEqual({
      identity: {
        status: "unknown",
        pid: 90,
        platform: "linux",
        reason: "permission_denied",
      },
      linuxState: null,
    });

    const unsupported = createProcessObservationReader({ platform: "win32" });
    expect(unsupported.observe(90)).toEqual({
      identity: {
        status: "unknown",
        pid: 90,
        platform: "win32",
        reason: "unsupported_platform",
      },
      linuxState: null,
    });
  });

  it("keeps Darwin identity observation state-free", () => {
    const service = createProcessObservationReader({
      platform: "darwin",
      darwinHelperPath: "/private/helper",
      runDarwinHelper: () => ({
        status: 0,
        stdout: "claudexor-process-identity-v2\t123\t123\t1777777777\t000042\n",
        stderr: "",
      }),
    });
    expect(service.observe(123)).toEqual({
      identity: {
        status: "known",
        pid: 123,
        platform: "darwin",
        source: "proc_pidinfo",
        startToken: "darwin:1777777777:000042",
        processGroupId: 123,
      },
      linuxState: null,
    });
  });
});

describe("process group handles", () => {
  it("brands only an exact known group leader and round-trips strict persisted JSON", () => {
    const identity = {
      read: () => knownLinux(55, 55, "linux:1"),
      self: () => knownLinux(1, 1, "linux:0"),
    };
    const service = new ProcessGroupService({ platform: "linux", identity });
    const captured = service.captureLeader(55);
    expect(captured.status).toBe("known");
    if (captured.status !== "known") throw new Error("expected known group");
    expect(parseProcessGroupHandle(JSON.parse(JSON.stringify(captured.handle)))).toMatchObject({
      pgid: 55,
    });
    expect(JSON.stringify(captured.handle)).not.toContain("linuxState");

    const memberIdentity = { ...identity, read: () => knownLinux(55, 44, "linux:1") };
    expect(
      new ProcessGroupService({ platform: "linux", identity: memberIdentity }).captureLeader(55),
    ).toMatchObject({
      status: "unknown",
      reason: "not_process_group_leader",
    });
  });

  it("refuses to signal a group whose recorded leader has left it, even with the same birth", () => {
    let pgid = 55;
    const identity = {
      read: () => knownLinux(55, pgid, "linux:1"),
      self: () => knownLinux(1, 1, "linux:0"),
    };
    const signalled: number[] = [];
    const service = new ProcessGroupService({
      platform: "linux",
      identity,
      signalProcessGroup: (negativePgid) => {
        signalled.push(negativePgid);
      },
    });
    const captured = service.captureLeader(55);
    if (captured.status !== "known") throw new Error("expected known group");
    pgid = 77;
    expect(service.signal(captured.handle, "SIGTERM")).toMatchObject({
      status: "unknown",
      reason: "stale_leader",
    });
    expect(signalled).toEqual([]);
  });

  it("treats only ESRCH as proof that every process in the group is gone", () => {
    const identity = {
      read: () => knownLinux(55, 55, "linux:1"),
      self: () => knownLinux(1, 1, "linux:0"),
    };
    const captured = new ProcessGroupService({ platform: "linux", identity }).captureLeader(55);
    if (captured.status !== "known") throw new Error("expected known group");
    const empty = new ProcessGroupService({
      platform: "linux",
      identity,
      probeProcessGroup: () => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      },
    });
    const denied = new ProcessGroupService({
      platform: "linux",
      identity,
      probeProcessGroup: () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      },
    });
    expect(empty.probeEmpty(captured.handle).status).toBe("empty");
    expect(denied.probeEmpty(captured.handle)).toMatchObject({
      status: "unknown",
      reason: "permission_denied",
    });
  });
});

describe("win32 process identity (opt-in kernel birth token)", () => {
  it("stays unprovable until a lane opts a reader in", () => {
    const withoutReader = new ProcessIdentityService({ platform: "win32" });
    expect(withoutReader.read(4242)).toEqual({
      status: "unknown",
      pid: 4242,
      platform: "win32",
      reason: "unsupported_platform",
    });
  });

  it("reads the process creation FILETIME as the birth token", () => {
    expect(win32Service(win32Reader).read(4242)).toEqual({
      status: "known",
      pid: 4242,
      platform: "win32",
      source: "win32_process_times",
      startToken: "win32:133700000000000000",
      processGroupId: 4242,
    });
  });

  it("detects a recycled pid instead of trusting the number", () => {
    const recorded = win32Service(win32Reader).read(4242) as KnownProcessIdentity;
    const recycled = win32Service(() => ({
      status: 0,
      stdout: "claudexor-process-identity-win32-v1\t4242\t133700000000009999",
      stderr: "",
    })).read(4242);
    expect(compareProcessIdentity(recorded, recycled)).toBe("different");
    expect(compareProcessIdentity(recorded, win32Service(win32Reader).read(4242))).toBe("same");
  });

  it("maps reader exits to missing, permission_denied and helper failures", () => {
    expect(win32Service(() => ({ status: 3, stdout: "", stderr: "" })).read(4242)).toMatchObject({
      status: "missing",
      platform: "win32",
    });
    expect(win32Service(() => ({ status: 4, stdout: "", stderr: "" })).read(4242)).toMatchObject({
      status: "unknown",
      reason: "permission_denied",
    });
    expect(win32Service(() => ({ status: 5, stdout: "", stderr: "" })).read(4242)).toMatchObject({
      status: "unknown",
      reason: "helper_failed",
    });
    expect(
      win32Service(() => ({ status: null, stdout: "", stderr: "", errorCode: "ENOENT" })).read(
        4242,
      ),
    ).toMatchObject({ status: "unknown", reason: "helper_unavailable" });
    expect(
      win32Service(() => ({ status: 0, stdout: "surprise\n", stderr: "" })).read(4242),
    ).toMatchObject({ status: "unknown", reason: "malformed_response" });
    expect(
      win32Service(() => ({ status: 0, stdout: WIN32_READING, stderr: "" })).read(99),
    ).toMatchObject({ status: "unknown", reason: "malformed_response" });
  });

  it("refuses an identity whose source or group shape is not the win32 contract", () => {
    const honest = win32Service(win32Reader).read(4242) as KnownProcessIdentity;
    expect(isKnownProcessIdentity(honest)).toBe(true);
    // A pid-shaped token is refused by shape alone only when it collides with
    // the pid: the point of the source name is that a reader without birth
    // times can never mint this record.
    expect(isKnownProcessIdentity({ ...honest, source: "win32_process" })).toBe(false);
    expect(isKnownProcessIdentity({ ...honest, processGroupId: 7 })).toBe(false);
  });
});

describe("win32 asynchronous opt-in reader (#694 r17, operator boundary)", () => {
  it("maps the same reader exits as the synchronous service, and stays unsupported without an opt-in", async () => {
    const reader = (execution: Awaited<ReturnType<typeof executeWin32ProcessTimesAsync>>) =>
      createAsyncProcessIdentityReader({
        platform: "win32",
        runWin32Reader: async () => execution,
      });
    expect(await reader({ status: 0, stdout: WIN32_READING, stderr: "" }).read(4242)).toEqual(
      win32Service(win32Reader).read(4242),
    );
    for (const status of [3, 4, 5])
      expect(await reader({ status, stdout: "", stderr: "" }).read(4242)).toEqual(
        win32Service(() => ({ status, stdout: "", stderr: "" })).read(4242),
      );
    expect(
      await reader({ status: null, stdout: "", stderr: "", errorCode: "ETIMEDOUT" }).read(4242),
    ).toMatchObject({ status: "unknown", reason: "helper_unavailable" });
    expect(await createAsyncProcessIdentityReader({ platform: "win32" }).read(4242)).toMatchObject({
      status: "unknown",
      reason: "unsupported_platform",
    });
  });

  it.runIf(process.platform === "win32")(
    "native: the real asynchronous reader reads this process's birth as the synchronous one does",
    async () => {
      const sync = new ProcessIdentityService({ runWin32Reader: executeWin32ProcessTimes }).read(
        process.pid,
      );
      const async = await createAsyncProcessIdentityReader({
        runWin32Reader: executeWin32ProcessTimesAsync,
      }).read(process.pid);
      expect(async).toEqual(sync);
      expect(async.status).toBe("known");
    },
    60_000,
  );
});

describe("win32 process-group semantics (leader-death proof, tree kill)", () => {
  const leader: KnownProcessIdentity = {
    status: "known",
    pid: 4242,
    platform: "win32",
    source: "win32_process_times",
    startToken: "win32:133700000000000000",
    processGroupId: 4242,
  };
  const service = (
    identity: ProcessIdentity,
    killProcessTree?: (pid: number) => "killed" | "not_found" | "failed",
  ) =>
    new ProcessGroupService({
      platform: "win32",
      identity: { read: () => identity, self: () => identity },
      killProcessTree,
      probeProcessGroup: () => {
        throw new Error("win32 must never probe a POSIX process group");
      },
      signalProcessGroup: () => {
        throw new Error("win32 must never signal a POSIX process group");
      },
    });
  const handle = parseProcessGroupHandle({ schemaVersion: 1, pgid: leader.pid, leader });

  it("reads emptiness from the leader identity, never from a group probe", () => {
    expect(service(leader).probeEmpty(handle)).toMatchObject({ status: "nonempty" });
    expect(
      service({ status: "missing", pid: 4242, platform: "win32" }).probeEmpty(handle),
    ).toMatchObject({ status: "empty" });
    // A recycled pid is a different process: the recorded one is gone.
    expect(
      service({ ...leader, startToken: "win32:133700000000009999" }).probeEmpty(handle),
    ).toMatchObject({ status: "empty" });
    expect(
      service({
        status: "unknown",
        pid: 4242,
        platform: "win32",
        reason: "helper_failed",
      }).probeEmpty(handle),
    ).toMatchObject({ status: "unknown", reason: "probe_failed" });
  });

  it("terminates through the injected tree kill and never without one", () => {
    const calls: number[] = [];
    const killer = service(leader, (pid) => {
      calls.push(pid);
      return "killed";
    });
    expect(killer.signal(handle, "SIGTERM")).toMatchObject({ status: "sent" });
    expect(killer.signal(handle, "SIGKILL")).toMatchObject({ status: "sent" });
    expect(calls).toEqual([4242, 4242]);
    expect(service(leader, () => "not_found").signal(handle, "SIGTERM")).toMatchObject({
      status: "empty",
    });
    expect(service(leader, () => "failed").signal(handle, "SIGTERM")).toMatchObject({
      status: "unknown",
      reason: "signal_failed",
    });
    expect(service(leader).signal(handle, "SIGTERM")).toMatchObject({
      status: "unknown",
      reason: "unsupported_platform",
    });
  });

  it("never kills a pid the recorded identity no longer owns", () => {
    const calls: number[] = [];
    const recycled = service({ ...leader, startToken: "win32:1" }, (pid) => {
      calls.push(pid);
      return "killed";
    });
    expect(recycled.signal(handle, "SIGKILL")).toMatchObject({
      status: "unknown",
      reason: "stale_leader",
    });
    expect(calls).toEqual([]);
  });
});
