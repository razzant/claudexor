import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  mintRunScopeMarker,
  type KnownProcessIdentity,
  type LiveChildProcess,
  type ProcessGroupHandle,
  type ProcessIdentity,
  type ProcessTableReader,
  type ProcessTableRow,
  type ScopeReapOptions,
  type ScopeReapOutcome,
} from "@claudexor/core";
import { DaemonRunScopeIndex, RUN_SCOPE_INDEX_FILE } from "./run-scope-index.js";
import { spawnProcess } from "@claudexor/core";
import { armDaemonLifecycle, runStartupCrashGc } from "./daemon-lifecycle.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "claudexor-scope-index-"));
  dirs.push(dir);
  return dir;
}

const T0 = "Mon Oct 12 14:00:00 2026";
const T1 = "Mon Oct 12 14:00:05 2026";
const T2 = "Mon Oct 12 14:00:09 2026";

function known(pid: number, token: string): KnownProcessIdentity {
  return {
    status: "known",
    pid,
    platform: "linux",
    source: "procfs_stat",
    startToken: `linux:${token}`,
    processGroupId: pid,
  };
}

function settledOutcome(over: Partial<ScopeReapOutcome> = {}): ScopeReapOutcome {
  return {
    coverage: "marker+capture",
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
    ...over,
  };
}

/** A fake reaper that records every marker it was asked to end. */
function fakeReaper(outcomes: Record<string, ScopeReapOutcome> = {}) {
  const calls: ScopeReapOptions[] = [];
  return {
    calls,
    reap: async (opts: ScopeReapOptions) => {
      calls.push(opts);
      return outcomes[opts.marker] ?? settledOutcome();
    },
  };
}

function fakeTable(rows: ProcessTableRow[]): ProcessTableReader {
  return {
    async snapshot() {
      return rows;
    },
    async row(pid) {
      return rows.find((r) => r.pid === pid) ?? null;
    },
  };
}

/** A registry root as `liveChildProcesses()` reports it: pid, marker and the spawn-time handle. */
function fakeRoot(pid: number, scopeMarker: string): LiveChildProcess {
  const leader = known(pid, String(pid));
  return {
    pid,
    cmd: "harness",
    scopeMarker,
    processGroup: { schemaVersion: 1, pgid: pid, leader } as unknown as ProcessGroupHandle,
  };
}

function fakeIdentity(live: Record<number, KnownProcessIdentity>) {
  return {
    async read(pid: number): Promise<ProcessIdentity> {
      return live[pid] ?? { status: "missing", pid, platform: "linux" };
    },
  };
}

function readIndex(root: string) {
  return JSON.parse(readFileSync(join(root, RUN_SCOPE_INDEX_FILE), "utf8")) as {
    entries: Array<Record<string, unknown>>;
  };
}

describe("DaemonRunScopeIndex", () => {
  it("records the scope durably BEFORE returning the marker, with the daemon's identity as owner", async () => {
    const root = tempRoot();
    const me = known(process.pid, "7");
    const index = new DaemonRunScopeIndex({
      path: join(root, RUN_SCOPE_INDEX_FILE),
      owner: async () => me,
      reap: fakeReaper().reap,
      table: fakeTable([]),
      roots: () => [],
    });
    const { marker } = await index.open("run-1");
    const file = readIndex(root);
    expect(file.entries).toHaveLength(1);
    expect(file.entries[0]).toMatchObject({
      marker,
      run_id: "run-1",
      state: "open",
      owner: me,
      captured: [],
      scope_start: null,
    });
  });

  it("captures a live root's descendants (pid, pgid, birth) and the scope start on the tick, persisted", async () => {
    const root = tempRoot();
    const rows: ProcessTableRow[] = [
      { pid: 100, ppid: process.pid, pgid: 100, birth: T0 },
      { pid: 200, ppid: 100, pgid: 200, birth: T1 }, // a setsid shell
      { pid: 210, ppid: 200, pgid: 200, birth: T1 }, // its tool
      { pid: 999, ppid: 1, pgid: 999, birth: T0 }, // unrelated
    ];
    const index = new DaemonRunScopeIndex({
      path: join(root, RUN_SCOPE_INDEX_FILE),
      owner: async () => known(process.pid, "7"),
      reap: fakeReaper().reap,
      table: fakeTable(rows),
      identity: fakeIdentity({ 100: known(100, "100") }),
      roots: () => [fakeRoot(100, marker)],
    });
    const { marker } = await index.open("run-1");
    await index.captureTick();
    const entry = index.list()[0]!;
    expect(entry.scope_start).toBe(T0);
    expect(entry.captured).toEqual([
      { pid: 100, pgid: 100, birth: T0 },
      { pid: 200, pgid: 200, birth: T1 },
      { pid: 210, pgid: 200, birth: T1 },
    ]);
    // Idempotent: a second tick adds nothing.
    await index.captureTick();
    expect(index.list()[0]!.captured).toHaveLength(3);
    expect(readIndex(root).entries[0]!["captured"]).toHaveLength(3);
  });

  it("capture revalidates the root's spawn-time identity: a reused root pid captures nothing (item 7)", async () => {
    const root = tempRoot();
    const rows: ProcessTableRow[] = [
      { pid: 100, ppid: 1, pgid: 100, birth: T1 }, // a stranger now owns pid 100
      { pid: 200, ppid: 100, pgid: 200, birth: T1 },
    ];
    const reused = new DaemonRunScopeIndex({
      path: join(root, RUN_SCOPE_INDEX_FILE),
      owner: async () => known(process.pid, "7"),
      reap: fakeReaper().reap,
      table: fakeTable(rows),
      // The registry handle says birth "100"; the live reading says "999".
      identity: fakeIdentity({ 100: known(100, "999") }),
      roots: () => [fakeRoot(100, marker)],
    });
    const { marker } = await reused.open("run-reused");
    await reused.captureTick();
    expect(reused.list()[0]!.captured).toEqual([]);
    // Unchanged identity: walked as usual.
    const same = new DaemonRunScopeIndex({
      path: join(root, "same.json"),
      owner: async () => known(process.pid, "7"),
      reap: fakeReaper().reap,
      table: fakeTable(rows),
      identity: fakeIdentity({ 100: known(100, "100") }),
      roots: () => [fakeRoot(100, marker2)],
    });
    const { marker: marker2 } = await same.open("run-same");
    await same.captureTick();
    expect(same.list()[0]!.captured.map((c) => c.pid)).toEqual([100, 200]);
  });

  it("settle hands the recorded rows to the reaper, retires a settled entry and keeps an unresolved one with its outcome", async () => {
    const root = tempRoot();
    const path = join(root, RUN_SCOPE_INDEX_FILE);
    const reaper = fakeReaper();
    const index = new DaemonRunScopeIndex({
      path,
      owner: async () => known(process.pid, "7"),
      reap: reaper.reap,
      table: fakeTable([{ pid: 100, ppid: process.pid, pgid: 100, birth: T0 }]),
      identity: fakeIdentity({ 100: known(100, "100") }),
      roots: () => [fakeRoot(100, marker)],
    });
    const { marker } = await index.open("run-1");
    await index.captureTick();
    const outcome = await index.settle("run-1", marker);
    expect(outcome.settled).toBe(true);
    expect(reaper.calls[0]).toMatchObject({
      marker,
      scopeStart: T0,
      captured: [{ pid: 100, pgid: 100, birth: T0 }],
    });
    expect(readIndex(root).entries).toEqual([]);

    // An unsettled reap keeps the entry as unresolved with its outcome summary.
    const survivor = settledOutcome({
      settled: false,
      survivors: [{ pid: 4711, startToken: "ps:x" }],
      reusedGroups: [77],
    });
    const second = new DaemonRunScopeIndex({
      path,
      owner: async () => known(process.pid, "7"),
      reap: fakeReaper({}).reap,
      table: fakeTable([]),
      roots: () => [],
    });
    const { marker: m2 } = await second.open("run-2");
    const firstSettlement = new Date(T1).toISOString();
    let settlementClock = firstSettlement;
    const kept = new DaemonRunScopeIndex({
      path,
      owner: async () => known(process.pid, "7"),
      reap: fakeReaper({ [m2]: survivor }).reap,
      table: fakeTable([]),
      roots: () => [],
      now: () => settlementClock,
    });
    await kept.settle("run-2", m2);
    expect(readIndex(root).entries[0]).toMatchObject({
      marker: m2,
      state: "unresolved",
      settled_at: firstSettlement,
      outcome: { survivors: [4711], reused_groups: [77], ended: 0 },
    });
    settlementClock = new Date(T2).toISOString();
    survivor.unreadable.push({ pid: 4712, reason: "identity_unreadable" });
    await kept.settle("run-2", m2);
    expect(readIndex(root).entries[0]).toMatchObject({
      settled_at: firstSettlement,
      outcome: { unreadable: [4712] },
    });
  });

  it("the pids tick retries a live unresolved owner with a fresh budget and retires only a fresh settled census", async () => {
    const root = tempRoot();
    const path = join(root, RUN_SCOPE_INDEX_FILE);
    const owner = known(5151, "5151");
    const survivor = settledOutcome({
      settled: false,
      incomplete: true,
      completeness: "not_provable",
      completenessReason: "settlement deadline expired",
      survivors: [{ pid: 4711, startToken: "ps:x" }],
    });
    const first = new DaemonRunScopeIndex({
      path,
      owner: async () => owner,
      reap: async () => survivor,
      table: fakeTable([]),
      identity: fakeIdentity({ 5151: owner }),
      roots: () => [],
      deadlineMs: 321,
      now: () => new Date(T1).toISOString(),
    });
    const { marker } = await first.open("run-live-unresolved");
    await first.settle("run-live-unresolved", marker);
    expect(readFileSync(path, "utf8")).not.toContain("\n");

    const calls: ScopeReapOptions[] = [];
    const second = new DaemonRunScopeIndex({
      path,
      reap: async (opts) => {
        calls.push(opts);
        return settledOutcome({
          completeness: "not_provable",
          completenessReason: "darwin census",
        });
      },
      table: fakeTable([]),
      identity: fakeIdentity({ 5151: owner }),
      roots: () => [],
      deadlineMs: 321,
    });
    await second.captureTick();
    await vi.waitFor(() => expect(second.list()).toEqual([]));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      marker,
      deadlineMs: 321,
      settledAt: new Date(T1).toISOString(),
    });
    await vi.waitFor(() => expect(readIndex(root).entries).toEqual([]));
  });

  it("pids ticks keep capturing while a retry runs and retry every stuck entry in oldest-first rounds", async () => {
    const root = tempRoot();
    const owner = known(5151, "5151");
    const survivor = settledOutcome({
      settled: false,
      survivors: [{ pid: 4711, startToken: "ps:x" }],
    });
    let now = "2026-10-12T14:00:00Z";
    let finish: ((outcome: ScopeReapOutcome) => void) | undefined;
    let retry = false;
    const calls: ScopeReapOptions[] = [];
    const table = fakeTable([{ pid: 100, ppid: 5151, pgid: 100, birth: T0 }]);
    const snapshot = vi.spyOn(table, "snapshot");
    const live: Record<number, KnownProcessIdentity> = { 5151: owner, 100: known(100, "100") };
    const identity = fakeIdentity(live);
    const readIdentity = vi.spyOn(identity, "read");
    let roots: LiveChildProcess[] = [];
    const index = new DaemonRunScopeIndex({
      path: join(root, RUN_SCOPE_INDEX_FILE),
      owner: async () => owner,
      identity,
      table,
      roots: () => roots,
      now: () => now,
      reap: async (opts) => {
        if (!retry) return survivor;
        calls.push(opts);
        return new Promise<ScopeReapOutcome>((resolve) => {
          finish = resolve;
        });
      },
    });
    const markers: string[] = [];
    // Deliberately insert out of settlement order to exercise the ordering seam.
    for (const minute of [3, 1, 2]) {
      now = `2026-10-12T14:0${minute}:00Z`;
      const { marker } = await index.open(`stuck-${minute}`);
      markers.push(marker);
      await index.settle(`stuck-${minute}`, marker);
    }
    roots = [fakeRoot(100, (await index.open("live-run")).marker)];
    retry = true;
    try {
      let ticks = 0;
      for (const marker of [markers[1], markers[2], markers[0], markers[1]]) {
        const before = calls.length;
        const capture = index.captureTick();
        expect(index.captureTick()).toBe(capture); // Concurrent capture still coalesces.
        await capture;
        ticks += 1;
        await vi.waitFor(() => expect(calls).toHaveLength(before + 1));
        expect(calls.at(-1)?.marker).toBe(marker);
        // This reap spans multiple ticks: capture completes on each, with no new reap.
        await index.captureTick();
        await index.captureTick();
        ticks += 2;
        expect(snapshot).toHaveBeenCalledTimes(ticks);
        expect(calls).toHaveLength(before + 1);
        finish!(survivor);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(calls).toHaveLength(before + 1); // Finishing cannot drain the queue this tick.
      }
      expect(index.list().filter((entry) => entry.state === "unresolved")).toHaveLength(3);
      // A missing owner must not turn the tick into a scan of every stuck PID.
      roots = [];
      delete live[5151];
      readIdentity.mockClear();
      await index.captureTick();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(readIdentity).toHaveBeenCalledExactlyOnceWith(5151);
      expect(calls).toHaveLength(4);
      live[5151] = owner;
      await index.captureTick();
      await vi.waitFor(() => expect(calls).toHaveLength(5));
      expect(calls.at(-1)?.marker).toBe(markers[0]);
    } finally {
      finish?.(survivor);
      index.dispose();
    }
  });

  it("keeps a survivor outcome on a live retry and does not rewrite identical bytes", async () => {
    const root = tempRoot();
    const path = join(root, RUN_SCOPE_INDEX_FILE);
    const owner = known(6161, "6161");
    const survivor = settledOutcome({
      settled: false,
      incomplete: true,
      completeness: "not_provable",
      completenessReason: "deadline miss",
      survivors: [{ pid: 4712, startToken: "ps:y" }],
    });
    const first = new DaemonRunScopeIndex({
      path,
      owner: async () => owner,
      reap: async () => survivor,
      table: fakeTable([]),
      identity: fakeIdentity({ 6161: owner }),
      roots: () => [],
    });
    const { marker } = await first.open("run-live-survivor");
    await first.settle("run-live-survivor", marker);
    const before = readFileSync(path, "utf8");
    const calls: ScopeReapOptions[] = [];
    const second = new DaemonRunScopeIndex({
      path,
      reap: async (opts) => {
        calls.push(opts);
        return survivor;
      },
      table: fakeTable([]),
      identity: fakeIdentity({ 6161: owner }),
      roots: () => [],
    });
    await second.captureTick();
    expect(calls).toHaveLength(1);
    expect(second.list()).toMatchObject([{ marker, state: "unresolved" }]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("settle hands the reaper the entry's opening time as scopeStartAt (the census skips older processes); a row without opened_at hands null, the full census (round 5)", async () => {
    const root = tempRoot();
    const path = join(root, RUN_SCOPE_INDEX_FILE);
    const reaper = fakeReaper();
    const index = new DaemonRunScopeIndex({
      path,
      owner: async () => known(process.pid, "7"),
      reap: reaper.reap,
      table: fakeTable([]),
      identity: fakeIdentity({}),
      roots: () => [],
    });
    const before = Date.now();
    const { marker } = await index.open("run-1");
    const openedAt = readIndex(root).entries[0]?.["opened_at"];
    expect(typeof openedAt).toBe("string");
    expect(Date.parse(openedAt as string)).toBeGreaterThanOrEqual(before - 1);
    await index.settle("run-1", marker);
    expect(reaper.calls).toHaveLength(1);
    expect(reaper.calls[0]?.scopeStartAt).toBe(openedAt);
    expect(reaper.calls[0]?.settledAt).toBeNull();

    // A startup settlement of an entry recorded without an opening time keeps
    // the full census: the reaper is handed no age.
    const legacyPath = join(root, "legacy.json");
    const legacyMarker = mintRunScopeMarker();
    writeFileSync(
      legacyPath,
      JSON.stringify({
        schema_version: 1,
        entries: [
          {
            marker: legacyMarker,
            run_id: "run-legacy",
            owner: known(4242, "4242"),
            state: "open",
            scope_start: null,
            root_groups: [],
            captured: [],
          },
        ],
      }),
    );
    const legacy = new DaemonRunScopeIndex({
      path: legacyPath,
      identity: fakeIdentity({}),
      reap: reaper.reap,
      table: fakeTable([]),
      roots: () => [],
    });
    await legacy.settleDeadOwners();
    expect(reaper.calls.map((c) => c.marker)).toEqual([marker, legacyMarker]);
    expect(reaper.calls[1]?.scopeStartAt).toBeNull();
  });

  it("start: reaps a dead generation's scopes, spares a live owner's, never touches an unindexed marker, treats a missing file as empty and an unreadable one as unknown (preserved aside)", async () => {
    const root = tempRoot();
    const path = join(root, RUN_SCOPE_INDEX_FILE);
    const deadDaemon = known(4242, "4242");
    const liveDaemon = known(5151, "5151");
    const deadMarker = mintRunScopeMarker();
    const liveMarker = mintRunScopeMarker();
    const strangerMarker = mintRunScopeMarker(); // grammar-shaped, NOT in the index
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        entries: [
          {
            marker: deadMarker,
            run_id: "run-dead",
            owner: deadDaemon,
            state: "unresolved",
            settled_at: new Date(T1).toISOString(),
            opened_at: "x",
            scope_start: T0,
            root_groups: [],
            captured: [{ pid: 210, pgid: 200, birth: T1 }],
          },
          {
            marker: liveMarker,
            run_id: "run-live",
            owner: liveDaemon,
            state: "open",
            opened_at: "x",
            scope_start: null,
            root_groups: [],
            captured: [],
          },
        ],
      }),
    );
    const reaper = fakeReaper();
    const index = new DaemonRunScopeIndex({
      path,
      identity: fakeIdentity({ 5151: liveDaemon }), // 4242 is gone (or recycled)
      reap: reaper.reap,
      table: fakeTable([]),
      roots: () => [],
    });
    const actions = await index.settleDeadOwners();
    expect(reaper.calls.map((c) => c.marker)).toEqual([deadMarker]);
    expect(reaper.calls[0]).toMatchObject({
      scopeStart: T0,
      settledAt: new Date(T1).toISOString(),
      captured: [{ pid: 210, pgid: 200, birth: T1 }],
    });
    expect(reaper.calls.some((c) => c.marker === strangerMarker)).toBe(false);
    expect(actions.join("\n")).toMatch(/run-dead: settled/);
    expect(actions.join("\n")).toMatch(/run-live: owner 5151 is live; untouched/);
    const after = readIndex(root).entries;
    expect(after.map((e) => e["marker"])).toEqual([liveMarker]);

    // Crash before the first index write: no file, nothing to do.
    const empty = new DaemonRunScopeIndex({
      path: join(root, "absent.json"),
      reap: reaper.reap,
      table: fakeTable([]),
      roots: () => [],
    });
    expect(await empty.settleDeadOwners()).toEqual([]);
    // Corrupt file: UNKNOWN, not empty — disclosed, preserved aside, index usable.
    const corruptPath = join(root, "corrupt.json");
    writeFileSync(corruptPath, "{not json");
    const disclosures: string[] = [];
    const corrupt = new DaemonRunScopeIndex({
      path: corruptPath,
      reap: reaper.reap,
      table: fakeTable([]),
      roots: () => [],
      log: (message) => disclosures.push(message),
    });
    // The disclosure is also a startup action (crash_gc_scopes), not only a log line.
    const corruptActions = await corrupt.settleDeadOwners();
    expect(corruptActions).toHaveLength(1);
    expect(corruptActions[0]).toMatch(/unreadable .*parse failed.*preserved as .*UNKNOWN/);
    expect(disclosures.join("\n")).toMatch(/unreadable .*parse failed.*UNKNOWN/);
    const aside = readdirSync(root).find((name) => name.startsWith("corrupt.json.unreadable-"));
    expect(aside).toBeDefined();
    expect(readFileSync(join(root, aside!), "utf8")).toBe("{not json");
    // The index stays usable: a new run is recorded in a fresh file.
    await corrupt.open("run-after-corrupt");
    expect(JSON.parse(readFileSync(corruptPath, "utf8")).entries).toHaveLength(1);
    // A readable, well-formed file is never moved aside; a missing one is simply empty.
    expect(disclosures).toHaveLength(1);
  });

  it("settle is bounded by ONE deadline: a seed hung on its table read cannot extend it; a fast seed leaves the reap the remainder (fix round 3)", async () => {
    const root = mkdtempSync(join(tmpdir(), "cx-scope-"));
    const hungRow = new Promise<never>(() => {});
    const hung = fakeReaper();
    const index = new DaemonRunScopeIndex({
      path: join(root, RUN_SCOPE_INDEX_FILE),
      owner: async () => known(process.pid, "self"),
      reap: hung.reap,
      table: { snapshot: async () => [], row: () => hungRow },
      identity: fakeIdentity({ 100: known(100, "100") }),
      roots: () => [fakeRoot(100, "x")],
      deadlineMs: 200,
    });
    const { marker } = await index.open("run-hung");
    void index.seedRoot(fakeRoot(100, marker)); // the refinement never returns from `ps -p`
    const started = Date.now();
    const outcome = await index.settle("run-hung", marker);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(outcome.settled).toBe(true);
    // The reap received what was left of the one deadline, not a fresh one.
    expect(hung.calls[0]?.deadlineMs).toBeGreaterThanOrEqual(0);
    expect(hung.calls[0]?.deadlineMs).toBeLessThanOrEqual(10);
    // The synchronous seed landed before the hang: the group is on record.
    expect(hung.calls[0]?.rootGroups?.map((g) => g.pgid)).toEqual([100]);

    const fast = fakeReaper();
    const quick = new DaemonRunScopeIndex({
      path: join(root, "quick-" + RUN_SCOPE_INDEX_FILE),
      owner: async () => known(process.pid, "self"),
      reap: fast.reap,
      table: fakeTable([{ pid: 100, ppid: process.pid, pgid: 100, birth: T0 }]),
      identity: fakeIdentity({ 100: known(100, "100") }),
      roots: () => [fakeRoot(100, "x")],
      // A production-sized budget keeps the margin far above scheduling
      // delay on a loaded host; a fast seed spends almost none of it.
      deadlineMs: 5_000,
    });
    const quickMarker = (await quick.open("run-fast")).marker;
    void quick.seedRoot(fakeRoot(100, quickMarker));
    await quick.settle("run-fast", quickMarker);
    expect(fast.calls[0]?.deadlineMs).toBeGreaterThan(2_500);
    expect(fast.calls[0]?.deadlineMs).toBeLessThanOrEqual(5_000);
  }, 15_000);

  it("a seed refinement still pending when settlement stops waiting for it starts no read and records nothing afterwards; the spawn-time group and the kept entry stand (both directions)", async () => {
    const run = async (late: boolean) => {
      const root = tempRoot();
      const path = join(root, RUN_SCOPE_INDEX_FILE);
      const reads: string[] = [];
      let answer!: () => void;
      const tableAnswer = new Promise<void>((resolve) => (answer = resolve));
      const calls: ScopeReapOptions[] = [];
      const index = new DaemonRunScopeIndex({
        path,
        owner: async () => known(process.pid, "self"),
        reap: async (opts) => {
          calls.push(opts);
          // What the real reap reports when the seed wait left it no budget.
          return late
            ? settledOutcome({
                settled: false,
                incomplete: true,
                completeness: "not_provable",
                completenessReason: "settlement deadline expired before every source was read",
              })
            : settledOutcome();
        },
        identity: {
          async read(pid: number): Promise<ProcessIdentity> {
            reads.push(`identity ${pid}`);
            return known(100, "100");
          },
        },
        table: {
          snapshot: async () => [],
          async row(pid) {
            reads.push(`row ${pid}`);
            await tableAnswer;
            return { pid: 100, ppid: process.pid, pgid: 100, birth: T0 };
          },
        },
        roots: () => [],
        deadlineMs: late ? 100 : 5_000,
      });
      const { marker } = await index.open("run-seed");
      const seeding = index.seedRoot(fakeRoot(100, marker));
      await vi.waitFor(() => expect(reads).toEqual(["identity 100", "row 100"]));
      if (!late) answer(); // the table answers while the settlement still waits
      await index.settle("run-seed", marker);
      const recorded = readFileSync(path, "utf8");
      if (late) answer(); // ...or only after the settlement stopped waiting
      await seeding;
      return { reads, calls, recorded, after: readFileSync(path, "utf8"), entries: index.list() };
    };
    const late = await run(true);
    // The group recorded at spawn was handed to the reap, and the entry keeps its obligation.
    expect(late.calls[0]?.rootGroups).toEqual([
      { pgid: 100, leaderPid: 100, leaderBirth: null, leaderIdentity: known(100, "100") },
    ]);
    expect(late.entries).toMatchObject([
      { state: "unresolved", root_groups: [{ pgid: 100, leader_birth: null }], captured: [] },
    ]);
    // The late answer started no second identity read and refined nothing.
    expect(late.reads).toEqual(["identity 100", "row 100"]);
    expect(late.after).toBe(late.recorded);
    // In time, the same answer refines the group before the reap.
    const timely = await run(false);
    expect(timely.reads).toEqual(["identity 100", "row 100", "identity 100"]);
    expect(timely.calls[0]?.rootGroups?.[0]?.leaderBirth).toBe(T0);
  }, 15_000);

  it("settlement never waits for ANOTHER run's seed: a slow refinement elsewhere leaves this run its whole budget, which starts at settlement entry (round 4, Astra R3)", async () => {
    const root = mkdtempSync(join(tmpdir(), "cx-scope-"));
    const never = new Promise<never>(() => {});
    const reaper = fakeReaper();
    // Astra's shape taken to its limit: the OTHER run's refinement never
    // returns from its identity or table read. A settlement that waited for
    // it would spend this run's whole production-sized budget (5 s) and hand
    // the reap nothing; the margins below stay far above scheduling delay on
    // a loaded host.
    const index = new DaemonRunScopeIndex({
      path: join(root, RUN_SCOPE_INDEX_FILE),
      owner: async () => known(process.pid, "self"),
      reap: reaper.reap,
      table: { snapshot: async () => [], row: () => never },
      identity: { read: () => never },
      roots: () => [],
      deadlineMs: 5_000,
    });
    const other = await index.open("run-other");
    void index.seedRoot(fakeRoot(100, other.marker)); // a refinement that never ends
    const mine = await index.open("run-mine");
    const started = Date.now();
    const outcome = await index.settle("run-mine", mine.marker);
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(outcome.settled).toBe(true);
    const call = reaper.calls.find((c) => c.marker === mine.marker);
    // The reap received (almost) the whole budget: nothing was spent waiting
    // for the other run's seed.
    expect(call?.deadlineMs).toBeGreaterThan(2_500);
    expect(call?.deadlineMs).toBeLessThanOrEqual(5_000);
  }, 15_000);

  it("an entry whose census is unsupported (Windows) is retired after disclosure, never kept forever", async () => {
    const root = tempRoot();
    const path = join(root, RUN_SCOPE_INDEX_FILE);
    const unsupported = settledOutcome({
      coverage: "tree_only",
      census: "unsupported",
      settled: false,
    });
    const index = new DaemonRunScopeIndex({
      path,
      owner: async () => known(process.pid, "7"),
      reap: fakeReaper({}).reap,
      table: fakeTable([]),
      roots: () => [],
    });
    const { marker } = await index.open("run-win");
    const retiring = new DaemonRunScopeIndex({
      path,
      owner: async () => known(process.pid, "7"),
      reap: fakeReaper({ [marker]: unsupported }).reap,
      table: fakeTable([]),
      roots: () => [],
    });
    const outcome = await retiring.settle("run-win", marker);
    expect(outcome.settled).toBe(false);
    expect(readIndex(root).entries).toEqual([]);
  });

  it("start: retiring a census-less (Windows) entry says so: unresolved, retired without proof", async () => {
    const root = tempRoot();
    const path = join(root, RUN_SCOPE_INDEX_FILE);
    const dead = new DaemonRunScopeIndex({
      path,
      owner: async () => known(4_000_000, "7"),
      reap: fakeReaper().reap,
      table: fakeTable([]),
      roots: () => [],
    });
    const { marker } = await dead.open("run-win-crash");
    const unsupported = settledOutcome({
      coverage: "tree_only",
      census: "unsupported",
      settled: false,
    });
    const next = new DaemonRunScopeIndex({
      path,
      owner: async () => known(process.pid, "8"),
      identity: fakeIdentity({}),
      reap: fakeReaper({ [marker]: unsupported }).reap,
      table: fakeTable([]),
      roots: () => [],
    });
    const [action] = await next.settleDeadOwners();
    expect(action).toMatch(/UNRESOLVED \(tree_only, census unsupported/);
    expect(action).toMatch(/retired without proof/);
    expect(readIndex(root).entries).toEqual([]);
  });

  it("a syntactically valid index with a malformed row is preserved aside and disclosed, never partially loaded (item 5)", async () => {
    const root = tempRoot();
    const path = join(root, RUN_SCOPE_INDEX_FILE);
    const original = JSON.stringify({ schema_version: 1, entries: [null] });
    writeFileSync(path, original);
    const disclosures: string[] = [];
    const reaper = fakeReaper();
    const index = new DaemonRunScopeIndex({
      path,
      identity: fakeIdentity({}),
      reap: reaper.reap,
      table: fakeTable([]),
      roots: () => [],
      log: (message) => disclosures.push(message),
    });
    const actions = await index.settleDeadOwners();
    expect(reaper.calls).toEqual([]);
    expect(actions.join("\n")).toMatch(/unreadable .*malformed entry #0.*preserved as/);
    expect(disclosures.join("\n")).toMatch(/malformed entry #0/);
    const aside = readdirSync(root).find((name) =>
      name.startsWith(`${RUN_SCOPE_INDEX_FILE}.unreadable-`),
    );
    expect(aside).toBeDefined();
    expect(readFileSync(join(root, aside!), "utf8")).toBe(original);
    // A well-formed row with captured rows is never dropped silently either:
    // a malformed captured row makes the whole file unknown.
    const path2 = join(root, "rows.json");
    writeFileSync(
      path2,
      JSON.stringify({
        schema_version: 1,
        entries: [
          {
            marker: mintRunScopeMarker(),
            run_id: "r",
            owner: null,
            state: "open",
            opened_at: "x",
            scope_start: null,
            root_groups: [],
            captured: [{ pid: "not-a-number" }],
          },
        ],
      }),
    );
    const second = new DaemonRunScopeIndex({
      path: path2,
      identity: fakeIdentity({}),
      reap: reaper.reap,
      table: fakeTable([]),
      roots: () => [],
      log: () => {},
    });
    expect((await second.settleDeadOwners()).join("\n")).toMatch(/malformed entry #0/);
    expect(readdirSync(root).some((name) => name.startsWith("rows.json.unreadable-"))).toBe(true);
  });

  it("a PRESENT but malformed membership container (captured or root_groups not an array) is preserved aside and disclosed; a missing one keeps the compatibility default (round 4)", async () => {
    const root = tempRoot();
    const row = (over: Record<string, unknown>) => ({
      marker: mintRunScopeMarker(),
      run_id: "r",
      owner: null,
      state: "open",
      opened_at: "x",
      scope_start: null,
      root_groups: [],
      captured: [],
      ...over,
    });
    const reaper = fakeReaper();
    const make = (name: string, entry: Record<string, unknown>) => {
      const path = join(root, name);
      const original = JSON.stringify({ schema_version: 1, entries: [entry] });
      writeFileSync(path, original);
      const index = new DaemonRunScopeIndex({
        path,
        identity: fakeIdentity({}),
        reap: reaper.reap,
        table: fakeTable([]),
        roots: () => [],
        log: () => {},
      });
      return { path, original, index };
    };
    // Object-valued `captured` carrying a real pid/pgid/birth: unknown, never [].
    const captured = make("captured.json", row({ captured: { pid: 100, pgid: 100, birth: T0 } }));
    expect((await captured.index.settleDeadOwners()).join("\n")).toMatch(/malformed entry #0/);
    expect(captured.index.list()).toEqual([]);
    const capturedAside = readdirSync(root).find((n) => n.startsWith("captured.json.unreadable-"));
    expect(capturedAside).toBeDefined();
    expect(readFileSync(join(root, capturedAside!), "utf8")).toBe(captured.original);
    // Opening another run afterwards never overwrites the original silently:
    // the preserved copy keeps its bytes.
    await captured.index.open("run-after");
    expect(readFileSync(join(root, capturedAside!), "utf8")).toBe(captured.original);
    // Object-valued `root_groups`: the same path.
    const groups = make(
      "groups.json",
      row({ root_groups: { pgid: 100, leader_pid: 100, leader_birth: null } }),
    );
    expect((await groups.index.settleDeadOwners()).join("\n")).toMatch(/malformed entry #0/);
    expect(readdirSync(root).some((n) => n.startsWith("groups.json.unreadable-"))).toBe(true);
    // A MISSING container is the compatibility default: the row loads as-is.
    const legacy = row({});
    delete (legacy as Record<string, unknown>)["captured"];
    delete (legacy as Record<string, unknown>)["root_groups"];
    const missing = make("missing.json", legacy);
    expect(missing.index.list()).toMatchObject([{ run_id: "r", root_groups: [], captured: [] }]);
    expect((await missing.index.settleDeadOwners()).join("\n")).not.toMatch(/malformed/);
    expect(readdirSync(root).some((n) => n.startsWith("missing.json.unreadable-"))).toBe(false);
  });

  it("capture re-checks the root's identity AFTER the snapshot and stores nothing when it changed (item 8)", async () => {
    const root = tempRoot();
    const rows: ProcessTableRow[] = [
      { pid: 100, ppid: 1, pgid: 100, birth: T0 },
      { pid: 200, ppid: 100, pgid: 200, birth: T1 },
    ];
    let reads = 0;
    const flipping = {
      async read(pid: number): Promise<ProcessIdentity> {
        reads += 1;
        // first read (before the snapshot): the spawn-time leader; second
        // read (after): a stranger owns the pid now.
        return reads === 1 ? known(pid, "100") : known(pid, "999");
      },
    };
    const index = new DaemonRunScopeIndex({
      path: join(root, RUN_SCOPE_INDEX_FILE),
      owner: async () => known(process.pid, "7"),
      reap: fakeReaper().reap,
      table: fakeTable(rows),
      identity: flipping,
      roots: () => [fakeRoot(100, marker)],
    });
    const { marker } = await index.open("run-flip");
    await index.captureTick();
    expect(index.list()[0]!.captured).toEqual([]);
  });

  it("scope_start keeps the EARLIEST birth when a later-born root is seeded first (NIT)", async () => {
    const root = tempRoot();
    const rows: ProcessTableRow[] = [
      { pid: 100, ppid: process.pid, pgid: 100, birth: T1 }, // born later, seeded first
      { pid: 300, ppid: process.pid, pgid: 300, birth: T0 }, // born earlier
    ];
    const index = new DaemonRunScopeIndex({
      path: join(root, RUN_SCOPE_INDEX_FILE),
      owner: async () => known(process.pid, "7"),
      reap: fakeReaper().reap,
      table: fakeTable(rows),
      identity: fakeIdentity({ 100: known(100, "100"), 300: known(300, "300") }),
      roots: () => [fakeRoot(100, marker), fakeRoot(300, marker)],
    });
    const { marker } = await index.open("run-floor");
    await index.seedRoot(fakeRoot(100, marker));
    expect(index.list()[0]!.scope_start).toBe(T1);
    await index.seedRoot(fakeRoot(300, marker));
    expect(index.list()[0]!.scope_start).toBe(T0);
    const groups = index.list()[0]!.root_groups;
    expect(groups.map((g) => [g.pgid, g.leader_birth])).toEqual([
      [100, T1],
      [300, T0],
    ]);
    expect(groups.every((g) => g.leader_identity?.status === "known")).toBe(true);
  });

  it("start: a leader that exited before any snapshot is reaped by marker alone (empty capture, no floor)", async () => {
    const root = tempRoot();
    const path = join(root, RUN_SCOPE_INDEX_FILE);
    const dead = known(4242, "4242");
    const marker = mintRunScopeMarker();
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        entries: [
          {
            marker,
            run_id: "run-short",
            owner: dead,
            state: "open",
            opened_at: "x",
            scope_start: null,
            root_groups: [],
            captured: [],
          },
        ],
      }),
    );
    const reaper = fakeReaper();
    const index = new DaemonRunScopeIndex({
      path,
      identity: fakeIdentity({}),
      reap: reaper.reap,
      table: fakeTable([]),
      roots: () => [],
    });
    await index.settleDeadOwners();
    expect(reaper.calls).toHaveLength(1);
    expect(reaper.calls[0]).toMatchObject({ marker, captured: [], scopeStart: null });
    expect(existsSync(path)).toBe(true);
    expect(readIndex(root).entries).toEqual([]);
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Spawn a marked /bin/sh root through the engine's own spawn path; it starts a
 * background /bin/sleep (platform binary: env invisible on darwin) in ITS OWN
 * group and exits within ~100 ms — before any 2 s capture tick could run. With
 * `holdUntil` it instead waits on its stdin, closed once that resolves (which is
 * handed the sleep's pid first, so the caller's teardown has it either way). */
async function shortRootLeavingSleep(
  marker: string,
  holdUntil?: (sleepPid: number) => Promise<unknown>,
): Promise<{ sleepPid: number }> {
  let sleepPid = 0;
  let release = (): void => {};
  const tail = holdUntil ? "read line" : "/bin/sleep 0.1";
  for await (const ev of spawnProcess(
    "/bin/sh",
    ["-c", `/bin/sleep 600 & echo sleep:$!; ${tail}`],
    {
      env: { [marker]: "1" },
      keepStdinOpen: Boolean(holdUntil),
      onSpawn: (io) => (release = () => io.end()),
    },
  )) {
    if (ev.type !== "stdout" || !ev.line.startsWith("sleep:")) continue;
    sleepPid = Number(ev.line.slice(6));
    if (holdUntil) {
      await holdUntil(sleepPid);
      release();
    }
  }
  return { sleepPid };
}

describe.runIf(process.platform !== "win32")(
  "root group seeded at spawn (fix round 1 item 2)",
  () => {
    it("a short root that exits before the first tick still leaves its group on record, and its background /bin/sleep is ended at the barrier", async () => {
      const root = tempRoot();
      const index = new DaemonRunScopeIndex({ path: join(root, RUN_SCOPE_INDEX_FILE) });
      let sleepPid = 0;
      try {
        const { marker } = await index.open("run-short");
        ({ sleepPid } = await shortRootLeavingSleep(marker));
        expect(sleepPid).toBeGreaterThan(0);
        expect(alive(sleepPid)).toBe(true);
        // No captureTick was ever called: only the spawn-time seed exists.
        const outcome = await index.settle("run-short", marker);
        expect(outcome.ended.map((m) => m.pid)).toContain(sleepPid);
        expect(outcome.settled).toBe(true);
        expect(alive(sleepPid)).toBe(false);
      } finally {
        index.dispose();
        try {
          if (sleepPid) process.kill(sleepPid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, 30_000);

    it("a root that exits within milliseconds still leaves its group on record (synchronous seed) and its background /bin/sleep is ended (item 10)", async () => {
      const root = tempRoot();
      const index = new DaemonRunScopeIndex({ path: join(root, RUN_SCOPE_INDEX_FILE) });
      let sleepPid = 0;
      try {
        const { marker } = await index.open("run-ms");
        // No `/bin/sleep 0.1` tail this time: the shell exits as soon as it has
        // started the background sleep — before any table read could land.
        for await (const ev of spawnProcess("/bin/sh", ["-c", "/bin/sleep 600 & echo sleep:$!"], {
          env: { [marker]: "1" },
        })) {
          if (ev.type === "stdout" && ev.line.startsWith("sleep:"))
            sleepPid = Number(ev.line.slice(6));
        }
        expect(sleepPid).toBeGreaterThan(0);
        expect(alive(sleepPid)).toBe(true);
        const entry = index.list()[0]!;
        expect(entry.root_groups).toHaveLength(1);
        expect(entry.root_groups[0]!.leader_identity?.status).toBe("known");
        const outcome = await index.settle("run-ms", marker);
        expect(outcome.ended.map((m) => m.pid)).toContain(sleepPid);
        expect(alive(sleepPid)).toBe(false);
      } finally {
        index.dispose();
        try {
          if (sleepPid) process.kill(sleepPid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, 30_000);

    it("a daemon that crashed before the first tick: the next start settles the seeded group and ends the leftover", async () => {
      const root = tempRoot();
      const path = join(root, RUN_SCOPE_INDEX_FILE);
      const dying = new DaemonRunScopeIndex({ path });
      let sleepPid = 0;
      try {
        const { marker } = await dying.open("run-crashed");
        // The root lives until its spawn-time seed is on disk WITH the leader's
        // birth (only a live leader's birth can be read), then exits; the
        // daemon then "crashes" (no tick, no settle).
        ({ sleepPid } = await shortRootLeavingSleep(marker, (pid) => {
          sleepPid = pid; // the teardown below has it even if this wait fails
          return vi.waitFor(
            () => expect(readIndex(root).entries[0]?.["scope_start"]).toBeTruthy(),
            { timeout: 10_000 },
          );
        }));
        dying.dispose();
        const persisted = readIndex(root).entries[0]!;
        expect((persisted["root_groups"] as unknown[]).length).toBe(1);
        expect(persisted["scope_start"]).toBeTruthy();
        expect(alive(sleepPid)).toBe(true);
        // Next daemon life: the previous owner's identity is gone.
        const next = new DaemonRunScopeIndex({ path, identity: fakeIdentity({}), roots: () => [] });
        const actions = await next.settleDeadOwners();
        expect(actions.join("\n")).toMatch(/run-crashed: settled/);
        expect(alive(sleepPid)).toBe(false);
        expect(readIndex(root).entries).toEqual([]);
      } finally {
        dying.dispose();
        try {
          if (sleepPid) process.kill(sleepPid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, 30_000);
  },
);

describe("daemon lifecycle wiring", () => {
  it("startup crash GC settles scopes BEFORE the workspace sweep and discloses each action", async () => {
    const root = tempRoot();
    const order: string[] = [];
    await runStartupCrashGc({
      daemonDir: root,
      diagnostics: {
        record: (record) => {
          order.push(`${record.stage}:${record.message}`);
          return true;
        },
      },
      knownProjectRoots: () => {
        order.push("sweep");
        return [];
      },
      runScopes: {
        settleDeadOwners: async () => ["scope abc of run r: settled (marker+capture, census ok)"],
      },
    });
    const scopeIndex = order.findIndex((item) => item.startsWith("crash_gc_scopes:"));
    const sweepIndex = order.indexOf("sweep");
    expect(scopeIndex).toBeGreaterThanOrEqual(0);
    expect(scopeIndex).toBeLessThan(sweepIndex);
    expect(order[scopeIndex]).toContain("scopes: scope abc of run r: settled");
  });

  it("the pids tick also runs the scope capture pass, and only once snapshots are armed", async () => {
    vi.useFakeTimers();
    try {
      const root = tempRoot();
      const signals = new EventEmitter() as EventEmitter & Pick<NodeJS.Process, "on" | "off">;
      let ticks = 0;
      const lifecycle = armDaemonLifecycle({
        daemonDir: root,
        logPath: join(root, "daemon.log"),
        signals,
        beginShutdown: async () => {},
        pidsWriter: { refresh: async () => {}, settled: async () => {} },
        scopeCapture: {
          captureTick: async () => {
            ticks += 1;
          },
        },
      });
      vi.advanceTimersByTime(5_000);
      expect(ticks).toBe(0);
      lifecycle.beginPidSnapshots();
      vi.advanceTimersByTime(4_100);
      expect(ticks).toBe(2);
      await lifecycle.finalize();
    } finally {
      vi.useRealTimers();
    }
  });
});
