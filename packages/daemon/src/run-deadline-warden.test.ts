/** The warden loop, its boundary sources and the registry's hand-off, with
 * injected clocks, reaper and cgroup (no process is signalled here). */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ScopeReapOptions, ScopeReapOutcome } from "@claudexor/core";
import { afterAll, describe, expect, it } from "vitest";
import { cgroup2MountPoint, unifiedCgroupPath } from "./run-deadline-cgroup.js";
import { parseUptimeNs } from "./run-deadline-clock.js";
import { RunDeadlines } from "./run-deadlines.js";
import {
  WARDEN_BUNDLE,
  WARDEN_ENTRY_ROLE,
  effectiveTarget,
  readWardenOutcome,
  readWardenState,
  runWarden,
  wardenCommand,
  wardenDonePath,
  writeJsonAtomic,
  type WardenState,
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
const state = (patch: Partial<WardenState> = {}): WardenState => ({
  version: 2,
  jobId: "job",
  clock: "monotonic",
  bootId: null,
  own: point(1_000_000_000n),
  revision: 0,
  parent: null,
  inherited: null,
  frozen: null,
  markers: [MARKER],
  cgroup: null,
  runScopes: null,
  released: false,
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
  it("acts only after target + head start, then leaves once the group is confirmed empty", async () => {
    const path = join(temp(), "job.json");
    writeJsonAtomic(path, state());
    const time = clockDeps();
    const reaps: ScopeReapOptions[] = [];
    const result = await runWarden(path, {
      ...time,
      reap: async (opts) => {
        reaps.push(opts);
        expect(time.now()).toBeGreaterThanOrEqual(2_000_000_000n); // 1 s target + 1 s head start
        return outcome({ ended: [{ pid: 7, startToken: "x" }] });
      },
    });
    expect(result).toBe("reaped");
    expect(reaps).toHaveLength(1);
    expect(reaps[0]).toMatchObject({ marker: MARKER, scopeStartAt: null });
    expect(reaps[0]!.signal).toBeUndefined();
    expect(readWardenOutcome(path)).toMatchObject({ reason: "reaped", ended: 1 });
    expect(existsSync(wardenDonePath(path))).toBe(true);
  });

  it("does not leave after one pass while survivors or an unprovable census remain", async () => {
    const path = join(temp(), "job.json");
    writeJsonAtomic(path, state());
    const time = clockDeps();
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
    const result = await runWarden(path, { ...time, reap: async () => answers[calls++]! });
    expect(result).toBe("reaped");
    expect(calls).toBe(3);
  });

  it("without a provable census (macOS) leaves after three passes that found nothing", async () => {
    const path = join(temp(), "job.json");
    writeJsonAtomic(path, state());
    let calls = 0;
    const result = await runWarden(path, {
      ...clockDeps(),
      reap: async () => {
        calls += 1;
        return outcome({ completeness: "not_provable", completenessReason: "macOS" });
      },
    });
    expect(result).toBe("unprovable_settled");
    expect(calls).toBe(3);
  });

  it("kills the run's cgroup and waits until it is empty", async () => {
    const path = join(temp(), "job.json");
    writeJsonAtomic(path, state({ cgroup: "/sys/fs/cgroup/x/claudexor-runs/job" }));
    const kills: string[] = [];
    let populated = 2;
    const result = await runWarden(path, {
      ...clockDeps(),
      reap: async () => outcome(),
      cgroup: {
        kill: async (dir) => {
          kills.push(dir);
          return true;
        },
        members: async () => (populated-- > 0 ? [11] : []),
        remove: async () => {},
      },
    });
    expect(result).toBe("reaped");
    expect(kills.length).toBeGreaterThanOrEqual(2);
  });

  it("after a normal end leaves at once when the group is confirmed empty, without signalling", async () => {
    const path = join(temp(), "job.json");
    writeJsonAtomic(path, state({ own: point(3_600_000_000_000n), released: true }));
    const reaps: ScopeReapOptions[] = [];
    const result = await runWarden(path, {
      ...clockDeps(),
      reap: async (opts) => {
        reaps.push(opts);
        return outcome();
      },
    });
    expect(result).toBe("released");
    expect(reaps).toHaveLength(1);
    expect(reaps[0]!.signal).toBeTypeOf("function"); // the probe never signals
  });

  it("after a normal end stays to the deadline while the group is not confirmed empty", async () => {
    const path = join(temp(), "job.json");
    writeJsonAtomic(path, state({ own: point(5_000_000_000n), released: true }));
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

  it("follows a rewritten target and exits when its file is removed", async () => {
    const path = join(temp(), "job.json");
    writeJsonAtomic(path, state());
    let polls = 0;
    const result = await runWarden(path, {
      now: () => 0n,
      sleep: async () => {
        polls += 1;
        if (polls === 1) writeJsonAtomic(path, state({ own: point(60_000_000_000n) }));
        if (polls === 2) writeFileSync(path, "{torn");
        if (polls === 4) rmSync(path);
      },
      reap: async () => {
        throw new Error("must not reap");
      },
    });
    expect(result).toBe("removed");
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
    writeJsonAtomic(path, state({ runScopes: index }));
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

  it("caps a child by its parent's current file, or by the cached value once that file is gone", () => {
    const dir = temp();
    writeJsonAtomic(join(dir, "parent.json"), state({ jobId: "parent", own: point(5n) }));
    const child = state({
      jobId: "child",
      own: point(9n),
      parent: "parent.json",
      inherited: { ...point(7n), from: "parent" },
    });
    expect(effectiveTarget(child, dir)).toBe(5n);
    rmSync(join(dir, "parent.json"));
    expect(effectiveTarget(child, dir)).toBe(7n);
    expect(effectiveTarget({ ...child, frozen: { ...point(8n), inheritedFrom: null } }, dir)).toBe(
      8n,
    );
  });
});

describe("RunDeadlines warden hand-off", () => {
  it("refuses the run when its warden cannot start", async () => {
    const deadlines = new RunDeadlines({
      dir: temp(),
      spawnWarden: async () => {
        throw new Error("spawn refused");
      },
    });
    try {
      deadlines.admit("job", deadlines.toPoint(new Date(Date.now() + 60_000).toISOString()), null);
      await expect(deadlines.attachScope("job", MARKER)).rejects.toThrow("spawn refused");
    } finally {
      deadlines.dispose();
    }
  });

  it("adds later markers to the same warden and hands back a released state", async () => {
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
      deadlines.admit("job", deadlines.toPoint(new Date(Date.now() + 60_000).toISOString()), null);
      await deadlines.attachScope("job", MARKER);
      const second = `CLAUDEXOR_RUN_SCOPE_${"c".repeat(32)}`;
      await deadlines.attachScope("job", second);
      expect(started).toHaveLength(1);
      const written = readWardenState(started[0]!) as WardenState;
      expect(written).toMatchObject({ jobId: "job", markers: [MARKER, second], released: false });
      const remaining = BigInt(written.own!.targetNs) - process.hrtime.bigint();
      if (written.clock === "monotonic") expect(remaining).toBeGreaterThan(55_000_000_000n);
      deadlines.close("job");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(readWardenState(started[0]!)).toMatchObject({
        released: true,
        frozen: expect.anything(),
      });
    } finally {
      deadlines.dispose();
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
  });
});
