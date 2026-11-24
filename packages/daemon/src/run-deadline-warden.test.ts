/** The warden loop, its boundary sources and the registry's hand-off, with
 * injected clocks, reaper and cgroup (no process is signalled here). */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ScopeReapOptions, ScopeReapOutcome } from "@claudexor/core";
import { afterAll, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import {
  cgroup2MountPoint,
  parsePopulated,
  probeCgroupBoundary,
  unifiedCgroupPath,
} from "./run-deadline-cgroup.js";
import { parseUptimeNs } from "./run-deadline-clock.js";
import { RunDeadlines } from "./run-deadlines.js";
import {
  RECORD_VERSION,
  claimPath,
  diskReader,
  enforcementOf,
  governingBound,
  readRecord,
  readWardenOutcome,
  wardenDonePath,
  writeJsonAtomic,
  type DeadlineRecord,
} from "./run-deadline-record.js";
import {
  WARDEN_BUNDLE,
  WARDEN_ENTRY_ROLE,
  runWarden,
  wardenCommand,
} from "./run-deadline-warden.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0);
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "d-rdw-"));
  dirs.push(dir);
  return dir;
};
const MARKER = `CLAUDEXOR_RUN_SCOPE_${"a".repeat(32)}`;
const point = (targetNs: bigint) => ({
  at: "2026-11-20T12:00:00.000Z",
  targetNs: targetNs.toString(),
});
const record = (patch: Partial<DeadlineRecord> = {}): DeadlineRecord => ({
  version: RECORD_VERSION,
  jobId: "job",
  clock: "monotonic",
  bootId: null,
  state: "armed",
  revision: 0,
  own: point(1_000_000_000n),
  successorOf: null,
  parent: null,
  parentJobId: null,
  inherited: null,
  frozen: null,
  markers: [MARKER],
  cgroup: null,
  runScopes: null,
  ...patch,
});
const outcome = (patch: Partial<ScopeReapOutcome> = {}): ScopeReapOutcome =>
  ({
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
    durationMs: 1,
    ...patch,
  }) as ScopeReapOutcome;

/** A fake clock the loop's sleeps advance. */
function clockDeps(stepMs = 200) {
  let now = 0n;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += BigInt(Math.max(ms, stepMs)) * 1_000_000n;
    },
    advance: (ms: number) => (now += BigInt(ms) * 1_000_000n),
  };
}

describe("runWarden", () => {
  it("acts only after target + head start, claims the deadline before its first stop, then leaves once confirmed", async () => {
    const path = join(temp(), "job.json");
    writeJsonAtomic(path, record());
    const time = clockDeps();
    const reaps: ScopeReapOptions[] = [];
    const result = await runWarden(path, {
      ...time,
      reap: async (opts) => {
        reaps.push(opts);
        expect(time.now()).toBeGreaterThanOrEqual(2_000_000_000n); // 1 s target + 1 s head start
        expect(existsSync(claimPath(path))).toBe(true); // claimed before the first stop
        return outcome({ ended: [{ pid: 7, startToken: "x" }] });
      },
    });
    expect(result).toBe("reaped");
    expect(reaps).toHaveLength(1);
    expect(reaps[0]).toMatchObject({ marker: MARKER, scopeStartAt: null });
    expect(reaps[0]!.signal).toBeUndefined();
    expect(readWardenOutcome(path)).toMatchObject({ reason: "reaped", ended: 1, confirmed: true });
    expect(enforcementOf(readWardenOutcome(path))).toEqual({ outcome: "confirmed", detail: null });
    expect(existsSync(wardenDonePath(path))).toBe(true);
  });

  it("does not leave after one pass while survivors remain", async () => {
    const path = join(temp(), "job.json");
    writeJsonAtomic(path, record());
    const answers = [
      outcome({
        settled: false,
        survivors: [{ pid: 9, startToken: "x" }],
        completeness: "not_provable",
      }),
      outcome({ settled: false, unreadable: [{ pid: 9, reason: "identity" }] }),
      outcome(),
    ];
    let calls = 0;
    const result = await runWarden(path, {
      ...clockDeps(),
      platform: "linux",
      reap: async () => answers[calls++]!,
    });
    expect(result).toBe("reaped");
    expect(calls).toBe(3);
  });

  it("on Linux an unprovable census is retried past three passes and ends only as an explicit unresolved report", async () => {
    const path = join(temp(), "job.json");
    writeJsonAtomic(path, record());
    let calls = 0;
    const result = await runWarden(path, {
      ...clockDeps(),
      platform: "linux",
      unresolvedAfterMs: 60_000,
      reap: async () => {
        calls += 1;
        return outcome({
          completeness: "not_provable",
          completenessReason: "2 same-uid process environments could not be read",
        });
      },
    });
    expect(result).toBe("unresolved");
    expect(calls).toBeGreaterThan(3);
    const report = readWardenOutcome(path);
    expect(report).toMatchObject({ reason: "unresolved", confirmed: false });
    expect(enforcementOf(report)).toEqual({
      outcome: "unresolved",
      detail: "2 same-uid process environments could not be read",
    });
  });

  it("a census that becomes provable on a later pass confirms, on Linux", async () => {
    const path = join(temp(), "job.json");
    writeJsonAtomic(path, record());
    let calls = 0;
    const result = await runWarden(path, {
      ...clockDeps(),
      platform: "linux",
      reap: async () => {
        calls += 1;
        return calls < 6
          ? outcome({ completeness: "not_provable", completenessReason: "x" })
          : outcome();
      },
    });
    expect(result).toBe("reaped");
    expect(calls).toBe(6);
  });

  it("without a provable census (macOS) leaves after three settled passes, reported unresolved", async () => {
    const path = join(temp(), "job.json");
    writeJsonAtomic(path, record());
    let calls = 0;
    const result = await runWarden(path, {
      ...clockDeps(),
      platform: "darwin",
      reap: async () => {
        calls += 1;
        return outcome({ completeness: "not_provable", completenessReason: "macOS" });
      },
    });
    expect(result).toBe("unresolved");
    expect(calls).toBe(3);
    expect(enforcementOf(readWardenOutcome(path))).toEqual({
      outcome: "unresolved",
      detail: "macOS",
    });
  });

  it("kills the run's cgroup and waits until cgroup.events reports it unpopulated", async () => {
    const path = join(temp(), "job.json");
    writeJsonAtomic(path, record({ cgroup: "/sys/fs/cgroup/x/claudexor-runs/job" }));
    const kills: string[] = [];
    // A nested subgroup keeps the cgroup populated although its own procs list is empty.
    let populated = 3;
    const result = await runWarden(path, {
      ...clockDeps(),
      platform: "linux",
      reap: async () => outcome(),
      cgroup: {
        kill: async (dir) => {
          kills.push(dir);
          return true;
        },
        populated: async () => populated-- > 0,
        remove: async () => {},
      },
    });
    expect(result).toBe("reaped");
    expect(kills.length).toBeGreaterThanOrEqual(2);
  });

  it("after the terminal leaves at once when the boundary is confirmed empty, without signalling", async () => {
    const path = join(temp(), "job.json");
    writeJsonAtomic(
      path,
      record({
        state: "closed",
        frozen: { ...point(3_600_000_000_000n), inheritedFrom: null, successorOf: null },
        cgroup: "/sys/fs/cgroup/x/run",
      }),
    );
    const reaps: ScopeReapOptions[] = [];
    const removed: string[] = [];
    const result = await runWarden(path, {
      ...clockDeps(),
      reap: async (opts) => {
        reaps.push(opts);
        return outcome();
      },
      cgroup: {
        kill: async () => {
          throw new Error("a closed, empty group is never killed");
        },
        populated: async () => false,
        remove: async (dir) => void removed.push(dir),
      },
    });
    expect(result).toBe("released");
    expect(removed).toEqual(["/sys/fs/cgroup/x/run"]);
    expect(reaps).toHaveLength(1);
    expect(reaps[0]!.signal).toBeTypeOf("function"); // the probe never signals
    expect(existsSync(claimPath(path))).toBe(false); // a closed run needs no claim
  });

  it("after the terminal stays to the deadline while the boundary is not confirmed empty", async () => {
    const path = join(temp(), "job.json");
    writeJsonAtomic(
      path,
      record({
        state: "closed",
        frozen: { ...point(5_000_000_000n), inheritedFrom: null, successorOf: null },
      }),
    );
    const time = clockDeps();
    const kinds: string[] = [];
    const result = await runWarden(path, {
      ...time,
      reap: async (opts) => {
        kinds.push(opts.signal ? "probe" : "reap");
        return opts.signal
          ? outcome({ settled: false, unreadable: [{ pid: 3, reason: "signal_failed:EPROBE" }] })
          : outcome();
      },
    });
    expect(result).toBe("reaped");
    expect(kinds.at(-1)).toBe("reap");
    expect(kinds.filter((kind) => kind === "probe").length).toBeGreaterThan(0);
    expect(time.now()).toBeGreaterThanOrEqual(6_000_000_000n);
  });

  it("on Linux after a normal terminal, a marker warden leaves once the recorded tree is empty and no readable environment carries the marker, though unrelated environments are unreadable", async () => {
    for (const coverage of ["marker+capture", "marker"] as const) {
      const dir = temp();
      const path = join(dir, "job.json");
      writeJsonAtomic(
        path,
        record({
          state: "closed",
          frozen: { ...point(3_600_000_000_000n), inheritedFrom: null, successorOf: null },
          runScopes: join(dir, "run-scopes.json"),
        }),
      );
      const time = clockDeps();
      const result = await runWarden(path, {
        ...time,
        platform: "linux",
        // A non-dumpable agent of the same user: the census cannot prove completeness.
        reap: async () =>
          outcome({
            coverage,
            completeness: "not_provable",
            completenessReason: "1 same-uid process environment unreadable",
          }),
        // Stop a warden that would stay: its clock reaching an hour means it never left.
        sleep: async (ms) => {
          if (time.now() > 60_000_000_000n) rmSync(path, { force: true });
          return time.sleep(ms);
        },
      });
      if (coverage === "marker+capture") {
        expect(result).toBe("released");
        expect(time.now()).toBeLessThan(60_000_000_000n);
        expect(readWardenOutcome(path)).toMatchObject({
          reason: "released",
          confirmed: false,
          detail: expect.stringContaining("unreadable"),
        });
      } else {
        // Without the recorded tree, the census alone proves nothing: it stays.
        expect(result).toBe("removed");
      }
    }
  });

  it("a closed child's survivors are stopped at its parent's current deadline when that came earlier", async () => {
    const dir = temp();
    writeJsonAtomic(
      join(dir, "parent.json"),
      record({ jobId: "parent", own: point(30_000_000_000n), markers: [] }),
    );
    const path = join(dir, "child.json");
    writeJsonAtomic(
      path,
      record({
        jobId: "child",
        own: null,
        parent: "parent.json",
        parentJobId: "parent",
        state: "closed",
        // It ended under the parent's earlier, longer deadline (one hour).
        frozen: { ...point(3_600_000_000_000n), inheritedFrom: "parent", successorOf: null },
      }),
    );
    const time = clockDeps();
    let firstStopAt: bigint | null = null;
    const result = await runWarden(path, {
      ...time,
      reap: async (opts) => {
        if (opts.signal) return outcome({ settled: false, unreadable: [{ pid: 4, reason: "x" }] });
        firstStopAt ??= time.now();
        return outcome();
      },
    });
    expect(result).toBe("reaped");
    expect(firstStopAt).not.toBeNull();
    expect(firstStopAt!).toBeGreaterThanOrEqual(31_000_000_000n);
    expect(firstStopAt!).toBeLessThan(40_000_000_000n);
  });

  it("follows a rewritten target and exits when its record is removed", async () => {
    const path = join(temp(), "job.json");
    writeJsonAtomic(path, record());
    let polls = 0;
    const result = await runWarden(path, {
      now: () => 0n,
      sleep: async () => {
        polls += 1;
        if (polls === 1) writeJsonAtomic(path, record({ own: point(60_000_000_000n) }));
        if (polls === 2) writeFileSync(path, "{torn");
        if (polls === 4) rmSync(path);
      },
      reap: async () => {
        throw new Error("must not reap");
      },
    });
    expect(result).toBe("removed");
  });

  it("never decides on a record it read before its clock reading (an unreadable read waits for the next one)", async () => {
    const path = join(temp(), "job.json");
    writeJsonAtomic(path, record()); // due at 1 s (+1 s head start)
    let clockReads = 0;
    let sleeps = 0;
    const result = await runWarden(path, {
      // The first reading is before the deadline; every later one is long past it.
      now: () => (++clockReads === 1 ? 0n : 10_000_000_000n),
      sleep: async () => {
        sleeps += 1;
        // The next read fails; the read after it shows the extension that was
        // published meanwhile. Only a fresh read may decide.
        if (sleeps === 1) writeFileSync(path, "{torn");
        if (sleeps === 2)
          writeJsonAtomic(path, record({ revision: 1, own: point(60_000_000_000n) }));
        if (sleeps === 3) rmSync(path);
      },
      reap: async () => {
        throw new Error("must not act on the revision read before the clock");
      },
    });
    expect(result).toBe("removed");
  });

  for (const change of ["extension", "shortening"] as const)
    it(`judges the record in force: a visible ${change} that did not commit moves nothing`, async () => {
      // The prior names an older revision: the change is not committed.
      const path = join(temp(), "job.json");
      const replaced = change === "extension" ? 1_000_000_000n : 60_000_000_000n;
      const requested = change === "extension" ? 60_000_000_000n : 1_000_000_000n;
      writeJsonAtomic(`${path}.prior`, record({ own: point(replaced) }));
      writeJsonAtomic(path, record({ revision: 1, own: point(requested) }));
      const time = clockDeps();
      let firstStopAt: bigint | null = null;
      const result = await runWarden(path, {
        ...time,
        reap: async () => {
          firstStopAt ??= time.now();
          return outcome();
        },
        sleep: async (ms) => {
          await time.sleep(ms);
          if (time.now() > 70_000_000_000n) rmSync(path);
        },
      });
      if (change === "extension") {
        // The replaced 1 s deadline governs (+1 s head start), not the 60 s one.
        expect(result).toBe("reaped");
        expect(firstStopAt!).toBeGreaterThanOrEqual(2_000_000_000n);
        expect(firstStopAt!).toBeLessThan(3_000_000_000n);
      } else {
        // Nothing stops the run at the 1 s instant of a shortening that never committed.
        expect(firstStopAt === null || firstStopAt >= 61_000_000_000n).toBe(true);
      }
    });

  it("reads its deadline before it reports itself ready: an unreadable record is never guarded", async () => {
    const path = join(temp(), "job.json");
    writeFileSync(path, "{torn");
    const result = await runWarden(path, {
      ...clockDeps(),
      reap: async () => {
        throw new Error("must not reap");
      },
    });
    expect(result).toBe("unresolved");
    expect(existsSync(`${path}.ready`), "never ready: the run is refused").toBe(false);
  });

  it("a record that stays unreadable for the head start is enforced at the last deadline read", async () => {
    const path = join(temp(), "job.json");
    writeJsonAtomic(path, record()); // due at 1 s (+1 s head start)
    const time = clockDeps();
    let sleeps = 0;
    let firstStopAt: bigint | null = null;
    const result = await runWarden(path, {
      ...time,
      sleep: async (ms) => {
        await time.sleep(ms);
        if ((sleeps += 1) === 1) writeFileSync(path, "{torn"); // unreadable from now on
        if (sleeps === 400) rmSync(path); // a warden that never acts leaves "removed"
      },
      reap: async () => {
        firstStopAt ??= time.now();
        return outcome({ ended: [{ pid: 7, startToken: "x" }] });
      },
    });
    expect(result).toBe("reaped");
    // Not at the first unreadable read past the deadline: only once it stayed
    // unreadable for the head start (1 s).
    expect(firstStopAt!).toBeGreaterThanOrEqual(2_000_000_000n);
    expect(firstStopAt!).toBeLessThan(4_000_000_000n);
  });

  it("feeds the run's recorded process groups and descendants from the run-scope index", async () => {
    const dir = temp();
    const index = join(dir, "run-scopes.json");
    writeFileSync(
      index,
      JSON.stringify({
        schema_version: 1,
        entries: [
          {
            marker: MARKER,
            run_id: "run-1",
            owner: null,
            state: "open",
            opened_at: "2026-11-20T10:00:00.000Z",
            scope_start: "Fri Nov 20 10:00:01 2026",
            root_groups: [{ pgid: 40, leader_pid: 40, leader_birth: "Fri Nov 20 10:00:01 2026" }],
            captured: [{ pid: 41, pgid: 40, birth: "Fri Nov 20 10:00:02 2026" }],
          },
        ],
      }),
    );
    const path = join(dir, "job.json");
    writeJsonAtomic(path, record({ runScopes: index }));
    const reaps: ScopeReapOptions[] = [];
    await runWarden(path, {
      ...clockDeps(),
      platform: "linux",
      reap: async (opts) => {
        reaps.push(opts);
        return outcome();
      },
    });
    expect(reaps[0]).toMatchObject({
      marker: MARKER,
      captured: [{ pid: 41, pgid: 40, birth: "Fri Nov 20 10:00:02 2026" }],
      rootGroups: [{ pgid: 40, leaderPid: 40, leaderBirth: "Fri Nov 20 10:00:01 2026" }],
      scopeStart: "Fri Nov 20 10:00:01 2026",
    });
  });

  it("caps a child by its parent's current record, or by the cached value once that record is gone", () => {
    const dir = temp();
    writeJsonAtomic(join(dir, "parent.json"), record({ jobId: "parent", own: point(5n) }));
    const child = record({
      jobId: "child",
      own: point(9n),
      parent: "parent.json",
      parentJobId: "parent",
      inherited: { ...point(7n), from: "parent" },
    });
    expect(governingBound(child, diskReader(dir))).toMatchObject({
      target: 5n,
      inheritedFrom: "parent",
    });
    rmSync(join(dir, "parent.json"));
    expect(governingBound(child, diskReader(dir))).toMatchObject({ target: 7n });
    const frozen = { ...child, frozen: { ...point(8n), inheritedFrom: null, successorOf: null } };
    expect(governingBound(frozen, diskReader(dir))).toMatchObject({ target: 7n });
  });
});

describe("RunDeadlines warden hand-off", () => {
  const held = async (deadlines: RunDeadlines, jobId: string, ms: number) => {
    await deadlines.stage(jobId, {
      own: deadlines.toPoint(new Date(Date.now() + ms).toISOString()),
      successorOf: null,
      parentJobId: null,
    });
    deadlines.admit(jobId);
  };

  it("refuses the run when its warden cannot start", async () => {
    const deadlines = new RunDeadlines({
      dir: temp(),
      spawnWarden: async () => {
        throw new Error("spawn refused");
      },
    });
    try {
      await held(deadlines, "job", 60_000);
      await expect(deadlines.attachScope("job", MARKER)).rejects.toThrow("spawn refused");
    } finally {
      await deadlines.dispose();
    }
  });

  it("adds later markers to the same warden and writes the terminal explicitly", async () => {
    const dir = temp();
    const started: string[] = [];
    const deadlines = new RunDeadlines({
      dir,
      spawnWarden: async (path) => {
        started.push(path);
        return { pid: 1 };
      },
    });
    try {
      await held(deadlines, "job", 60_000);
      await deadlines.attachScope("job", MARKER);
      const second = `CLAUDEXOR_RUN_SCOPE_${"c".repeat(32)}`;
      await deadlines.attachScope("job", second);
      expect(started).toHaveLength(1);
      const written = readRecord(started[0]!) as DeadlineRecord;
      expect(written).toMatchObject({ jobId: "job", markers: [MARKER, second], state: "armed" });
      const remaining = BigInt(written.own!.targetNs) - process.hrtime.bigint();
      if (written.clock === "monotonic") expect(remaining).toBeGreaterThan(55_000_000_000n);
      deadlines.close("job");
      await deadlines.read("job"); // after the job's pending transitions
      expect(readRecord(started[0]!)).toMatchObject({ state: "closed", frozen: expect.anything() });
    } finally {
      await deadlines.dispose();
    }
  });
});

describe("wardenCommand", () => {
  const url = (...parts: string[]) => pathToFileURL(join(tmpdir(), ...parts)).href;
  it("runs the sibling entry of an installed package and the small bundle beside the engine bundle", () => {
    expect(wardenCommand(url("pkg", "dist", "run-deadline-warden.js")).args).toEqual([
      join(tmpdir(), "pkg", "dist", "run-deadline-warden-main.js"),
    ]);
    expect(wardenCommand(url("app", "claudexord.bundle.cjs"), () => true).args).toEqual([
      join(tmpdir(), "app", WARDEN_BUNDLE),
    ]);
    expect(wardenCommand(url("app", "claudexord.bundle.cjs"), () => false).args).toEqual([
      join(tmpdir(), "app", "claudexord.bundle.cjs"),
      WARDEN_ENTRY_ROLE,
    ]);
    expect(() => wardenCommand(url("app", "claudexor.bundle.cjs"))).toThrow(
      expect.objectContaining({ code: "run_deadline_warden_unavailable" }),
    );
  });
});

describe("host facts", () => {
  it("reads CLOCK_BOOTTIME from /proc/uptime and the cgroup v2 facts", () => {
    expect(parseUptimeNs("12345.67 999.00\n")).toBe(12_345_670_000_000n);
    expect(
      cgroup2MountPoint(
        "29 23 0:26 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime shared:4 - cgroup2 cgroup2 rw\n",
      ),
    ).toBe("/sys/fs/cgroup");
    expect(
      unifiedCgroupPath("0::/user.slice/user-1000.slice/user@1000.service/app.slice/x.service\n"),
    ).toBe("/user.slice/user-1000.slice/user@1000.service/app.slice/x.service");
    expect(parsePopulated("populated 1\nfrozen 0\n")).toBe(true);
    expect(parsePopulated("populated 0\nfrozen 0\n")).toBe(false);
    expect(parsePopulated("frozen 0\n")).toBe(null);
  });
});

describe("the cgroup boundary probe", () => {
  const fakeChild = (pid: number | undefined) =>
    Object.assign(new EventEmitter(), { pid, kill: () => true });

  it("an exit delivered while the cgroup.kill write is pending is the probe's success", async () => {
    const dir = temp();
    let child!: EventEmitter;
    const boundary = await probeCgroupBoundary("linux", () => ({ dir }), {
      hasKill: () => true,
      spawn: () => (child = fakeChild(4242)) as never,
      readFile: async () => "4242\n",
      // The kernel ends the child before the write's promise settles.
      writeFile: async () => {
        child.emit("exit", null, "SIGKILL");
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    });
    expect(boundary).toEqual({ kind: "cgroup", runsDir: join(dir, "claudexor-runs") });
  });

  it("an asynchronous spawn error answers marker with its reason, never an uncaught error", async () => {
    const dir = temp();
    const boundary = await probeCgroupBoundary("linux", () => ({ dir }), {
      hasKill: () => true,
      spawn: () => {
        const child = fakeChild(undefined);
        setImmediate(() => child.emit("error", new Error("spawn /bin/sh ENOENT")));
        return child as never;
      },
      readFile: async () => "",
      writeFile: async () => {},
    });
    expect(boundary).toEqual({
      kind: "marker",
      reason: "the probe child could not start: spawn /bin/sh ENOENT",
    });
  });
});
