import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  mintRunScopeMarker,
  reapScopeMembers,
  type KnownProcessIdentity,
  type LiveChildProcess,
  type ProcessTableReader,
  type ProcessTableRow,
  type ScopeCensusReader,
  type ScopeReapOptions,
  type ScopeReapOutcome,
} from "@claudexor/core";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { DaemonRunScopeIndex, RUN_SCOPE_INDEX_FILE } from "./run-scope-index.js";
import { RunScopeIndexPublisher } from "./run-scope-index-file.js";
import { parseEntry } from "./run-scope-index-rows.js";
import {
  LateScopeSettlement,
  type LaterScopeSettlement,
  type LaterSettlementListener,
} from "./run-scope-late-settlement.js";
import { bindLaterScopeSettlements, LATER_PROCESS_SCOPE } from "./run-scope-later-record.js";
import { createSqlDaemonRuntime } from "./sql-daemon-runtime.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0);
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "claudexor-scope-late-"));
  dirs.push(dir);
  return dir;
}
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
function outcome(over: Partial<ScopeReapOutcome> = {}): ScopeReapOutcome {
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
const expired = outcome({
  settled: false,
  incomplete: true,
  completeness: "not_provable",
  completenessReason: "settlement deadline expired before every source was read",
  durationMs: 5,
});
const table: ProcessTableReader = {
  async snapshot() {
    return [];
  },
  async row() {
    return null;
  },
} as unknown as ProcessTableReader;
const readIndex = (path: string) =>
  JSON.parse(readFileSync(path, "utf8")) as { entries: Array<Record<string, unknown>> };
// Well-formed identities: a reloaded index re-parses each persisted owner.
const self = known(process.pid, "1001");

function index(
  path: string,
  reap: (opts: ScopeReapOptions) => Promise<ScopeReapOutcome>,
  log?: (message: string) => void,
) {
  return new DaemonRunScopeIndex({
    path,
    owner: async () => self,
    reap,
    table,
    roots: () => [],
    deadlineMs: 1,
    now: () => "2026-11-04T00:00:00.000Z",
    laterAttempts: true,
    ...(log ? { log } : {}),
  });
}
const noLog = () => {};
async function ticks(subject: DaemonRunScopeIndex, count: number) {
  for (let i = 0; i < count; i++) {
    await subject.captureTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("compact coalesced run-scope publication (#613)", () => {
  it("carries every change made during a write in the next one and answers each receipt", async () => {
    const path = join(tempRoot(), RUN_SCOPE_INDEX_FILE);
    let state = 0;
    const body = vi.fn(() => ({ schema_version: 1 as const, entries: [{ state }] }));
    const written: string[] = [];
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => (unblock = resolve));
    const publisher = new RunScopeIndexPublisher(path, body, noLog, async (_path, text) => {
      written.push(text);
      if (written.length === 1) await blocked;
    });
    state = 1;
    const first = publisher.publish(publisher.changed());
    // The first write serialized state 1 before its first await and is still open.
    expect(written).toEqual(['{"schema_version":1,"entries":[{"state":1}]}']);
    state = 2;
    const second = publisher.publish(publisher.changed());
    state = 3;
    const third = publisher.publish(publisher.changed());
    expect(body).toHaveBeenCalledTimes(1);
    unblock();
    await Promise.all([first, second, third]);
    // Revisions 2 and 3 arrived during that write: ONE next write carried the latest state.
    expect(body).toHaveBeenCalledTimes(2);
    expect(written).toEqual([
      '{"schema_version":1,"entries":[{"state":1}]}',
      '{"schema_version":1,"entries":[{"state":3}]}',
    ]);
    // An already published revision needs no write.
    await publisher.publish(2);
    expect(body).toHaveBeenCalledTimes(2);
    // A newly requested revision with the SAME serialized state still answers its receipt,
    // without rewriting the file; a subsequent real change still publishes.
    await publisher.publish(publisher.changed());
    expect(written).toHaveLength(2);
    state = 4;
    await publisher.publish(publisher.changed());
    expect(written).toHaveLength(3);
    expect(JSON.parse(written[2]!).entries).toEqual([{ state: 4 }]);
  });

  it("repeats a failed write on a bare publish with the current state, and never a clean one", async () => {
    let state = 1;
    let failing = true;
    const written: string[] = [];
    const publisher = new RunScopeIndexPublisher(
      join(tempRoot(), "index.json"),
      () => ({ schema_version: 1 as const, entries: [{ state }] }),
      noLog,
      async (_path, text) => {
        if (failing) throw new Error("fixture: no space left");
        written.push(text);
      },
    );
    const receipt = publisher.publish(publisher.changed());
    await expect(receipt).rejects.toThrow("no space left");
    await expect(publisher.publish()).rejects.toThrow("no space left");
    state = 2;
    publisher.changed();
    failing = false;
    await publisher.publish();
    expect(written).toEqual(['{"schema_version":1,"entries":[{"state":2}]}']);
    // Its own receipt stays what it was: that write failed.
    await expect(receipt).rejects.toThrow("no space left");
    await publisher.publish();
    expect(written).toHaveLength(1);
  });

  it("rejects the receipt of a revision whose write failed and never leaves a waiter hanging", async () => {
    const root = tempRoot();
    const blocker = join(root, "not-a-directory");
    writeFileSync(blocker, "x");
    const publisher = new RunScopeIndexPublisher(
      join(blocker, "index.json"),
      () => ({ schema_version: 1, entries: [] }),
      noLog,
    );
    await expect(publisher.publish(publisher.changed())).rejects.toThrow();
    await expect(publisher.publish(publisher.changed())).rejects.toThrow();
  });

  it("repeats only what a failed write left, and leaves a running write to finish", async () => {
    let attempts = 0;
    let write: () => Promise<void> = async () => {
      throw new Error("fixture: no space left");
    };
    const logs: string[] = [];
    const publisher = new RunScopeIndexPublisher(
      join(tempRoot(), "index.json"),
      () => ({ schema_version: 1 as const, entries: [] }),
      (line) => logs.push(line),
      async () => {
        attempts += 1;
        await write();
      },
    );
    publisher.repeat();
    expect(attempts).toBe(0);

    await expect(publisher.publish(publisher.changed())).rejects.toThrow("no space left");
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    write = () => held;
    const publish = vi.spyOn(publisher, "publish");
    // However long this write hangs, the ticks behind it collect nothing.
    for (let tick = 0; tick < 3; tick++) publisher.repeat();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(attempts).toBe(2);
    release();
    await vi.waitFor(() => expect(logs).toHaveLength(2));
    publisher.repeat();
    expect(attempts).toBe(2);
    expect(logs[0]).toContain("stay unpublished");
    expect(logs[1]).toContain("have now landed");
  });
});

describe("later bounded settlement of finished owned runs (INV-144, #613)", () => {
  it("retires an expired terminal settlement after a fresh attempt and reports it", async () => {
    const path = join(tempRoot(), RUN_SCOPE_INDEX_FILE);
    const calls: ScopeReapOptions[] = [];
    let terminal = true;
    const subject = index(path, async (opts) => {
      calls.push(opts);
      const result = terminal ? expired : outcome();
      terminal = false;
      return result;
    });
    const settlements: LaterScopeSettlement[] = [];
    subject.onLaterSettlement((settlement) => void settlements.push(settlement));
    const { marker } = await subject.open("run-late");
    expect((await subject.settle("run-late", marker)).incomplete).toBe(true);
    expect(readIndex(path).entries[0]).toMatchObject({
      state: "unresolved",
      outcome: {
        incomplete: true,
        completeness_reason: expired.completenessReason,
        duration_ms: 5,
      },
    });
    await vi.waitFor(async () => {
      await ticks(subject, 1);
      expect(settlements).toHaveLength(1);
    });
    expect(settlements[0]).toMatchObject({ runId: "run-late", marker, attempt: 1 });
    expect(settlements[0]!.outcome.settled).toBe(true);
    // A new reap with its own budget, never a prolonged terminal attempt.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.settledAt).toBeNull();
    expect(calls[1]).toMatchObject({
      marker,
      deadlineMs: 1,
      settledAt: "2026-11-04T00:00:00.000Z",
    });
    await vi.waitFor(() => expect(readIndex(path).entries).toEqual([]));
  });

  it("keeps the first settlement through later and startup attempts and logs only changed outcomes", async () => {
    const path = join(tempRoot(), RUN_SCOPE_INDEX_FILE);
    const calls: ScopeReapOptions[] = [];
    const logs: string[] = [];
    let result = expired;
    const subject = index(
      path,
      async (opts) => {
        calls.push(opts);
        return result;
      },
      (line) => logs.push(line),
    );
    subject.onLaterSettlement(() => {});
    const { marker } = await subject.open("run-stuck");
    await subject.settle("run-stuck", marker);
    const first = subject.list()[0]!.settled_at;
    logs.length = 0;
    // The tick starts a later attempt without waiting for it, and starts none while the previous
    // attempt is still writing or before its spacing has passed. So tick until the index records
    // attempt n, and never once it does: one extra tick would start attempt n + 1.
    const recorded = () => Number(readIndex(path).entries[0]?.late_attempts ?? 0);
    const attempt = async (n: number) => {
      await vi.waitFor(
        async () => {
          if (recorded() < n) await subject.captureTick();
          expect(recorded()).toBe(n);
        },
        { timeout: 5_000 },
      );
    };
    await attempt(1);
    expect(logs).toEqual([]);
    result = outcome({ settled: false, survivors: [{ pid: 42, startToken: "ps:42" }] });
    await attempt(2);
    expect(logs).toHaveLength(1);
    result = { ...result, durationMs: 37 };
    await attempt(3);
    expect(logs).toHaveLength(1);
    expect(calls.slice(1).every((call) => call.settledAt === first)).toBe(true);
    const startupCalls: ScopeReapOptions[] = [];
    const next = new DaemonRunScopeIndex({
      path,
      roots: () => [],
      table,
      now: () => "2026-11-05T00:00:00.000Z",
      identity: { read: async (pid) => ({ status: "missing", pid, platform: "linux" }) },
      reap: async (opts) => {
        startupCalls.push(opts);
        return result;
      },
    });
    await next.settleDeadOwners();
    await next.settleDeadOwners();
    expect(startupCalls.map((call) => call.settledAt)).toEqual([first, first]);
    expect(readIndex(path).entries[0]?.settled_at).toBe(first);
    result = outcome();
    await vi.waitFor(
      async () => {
        if (readIndex(path).entries.length > 0) await subject.captureTick();
        expect(readIndex(path).entries).toEqual([]);
      },
      { timeout: 5_000 },
    );
    expect(logs).toHaveLength(2);
  });

  it("retries failing reaps and reports but discloses only changed failures and recovery", async () => {
    const entry = parseEntry({
      marker: mintRunScopeMarker(),
      run_id: "quiet",
      owner: self,
      state: "unresolved",
      opened_at: "2026-11-04T00:00:00.000Z",
      settled_at: "2026-11-04T00:00:00.000Z",
      root_groups: [],
      captured: [],
    })!;
    const logs: string[] = [];
    let failure: string | null = "first";
    let reportFailure: string | null = "report";
    let now = Date.parse("2026-11-05T00:00:00.000Z");
    const reap = vi.fn(async () => {
      if (failure) throw new Error(failure);
      return expired;
    });
    const record = vi.fn(async () => {});
    const subject = new LateScopeSettlement({
      entries: () => [entry],
      owner: async () => self,
      reap,
      table,
      deadlineMs: 1,
      record,
      log: (line) => logs.push(line),
      now: () => now,
      iso: () => new Date(now).toISOString(),
    });
    const listener = vi.fn(async () => {
      if (reportFailure) throw new Error(reportFailure);
    });
    subject.subscribe(listener);
    await subject.tick();
    await subject.tick();
    expect(reap).toHaveBeenCalledTimes(2);
    expect(logs).toHaveLength(1);
    failure = "second";
    await subject.tick();
    expect(logs).toHaveLength(2);
    failure = null;
    await subject.tick();
    expect(logs).toHaveLength(4); // attempt recovery, first owed report
    await subject.tick();
    await subject.tick();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(logs).toHaveLength(4);
    reportFailure = "changed report";
    await subject.tick();
    expect(logs).toHaveLength(5);
    reportFailure = null;
    await subject.tick();
    expect(logs).toHaveLength(6);
    now += 10;
    await subject.tick();
    expect(record).toHaveBeenCalledTimes(2);
    expect(logs).toHaveLength(6);
  });

  it("owes a report its listener failed and repeats it without reaping again", async () => {
    const path = join(tempRoot(), RUN_SCOPE_INDEX_FILE);
    const calls: ScopeReapOptions[] = [];
    let terminal = true;
    const subject = index(path, async (opts) => {
      calls.push(opts);
      const result = terminal ? expired : outcome();
      terminal = false;
      return result;
    });
    const reports: LaterScopeSettlement[] = [];
    let failures = 1;
    subject.onLaterSettlement(async (settlement) => {
      reports.push(settlement);
      if (failures-- > 0) throw new Error("fixture: the later record could not be written");
    });
    const { marker } = await subject.open("run-owed");
    await subject.settle("run-owed", marker);
    await vi.waitFor(async () => {
      await ticks(subject, 1);
      expect(reports).toHaveLength(2);
    });
    // One later reap settled and retired the entry; the owed report repeated that attempt.
    expect(calls).toHaveLength(2);
    expect(reports[0]).toMatchObject({ runId: "run-owed", marker, attempt: 1 });
    expect(reports[1]).toEqual(reports[0]);
    await ticks(subject, 3);
    expect(reports).toHaveLength(2);
    expect(calls).toHaveLength(2);
    await vi.waitFor(() => expect(readIndex(path).entries).toEqual([]));
  });

  it("binds a report that fails to record or return as owed, never as done", async () => {
    let listener!: LaterSettlementListener;
    const settled = vi.fn(async () => {
      throw new Error("fixture: the store is busy");
    });
    const runDir = tempRoot();
    mkdirSync(join(runDir, "final"));
    bindLaterScopeSettlements(
      { onLaterSettlement: (bound) => ((listener = bound), () => {}) },
      {
        run: (runId) => (runId === "run-a" ? { id: "job-a", runDir } : { id: "job-b" }),
        settled,
      },
    );
    const settlement = {
      runId: "run-a",
      marker: mintRunScopeMarker(),
      outcome: outcome(),
      attempt: 1,
      at: "2026-11-04T00:00:00.000Z",
    };
    await expect(listener(settlement)).rejects.toThrow("the store is busy");
    expect(existsSync(join(runDir, LATER_PROCESS_SCOPE))).toBe(true);
    // A run without a directory has nothing to record and nothing to return.
    await expect(listener({ ...settlement, runId: "run-b" })).resolves.toBeUndefined();
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("keeps a row whose later-attempt facts are malformed verbatim and unknown", () => {
    const row = {
      marker: mintRunScopeMarker(),
      run_id: "run-x",
      state: "unresolved",
      opened_at: "2026-11-04T00:00:00.000Z",
      root_groups: [],
      captured: [],
    };
    const at = "2026-11-04T00:00:01.000Z";
    expect(parseEntry({ ...row, late_attempts: 4, last_attempt_at: at })).toMatchObject({
      late_attempts: 4,
      last_attempt_at: at,
    });
    for (const malformed of [
      { late_attempts: -1 },
      { late_attempts: 1.5 },
      { late_attempts: "2" },
      { late_attempts: null },
      { last_attempt_at: 7 },
    ])
      expect(parseEntry({ ...row, ...malformed })).toBeNull();
  });

  describe("an index write that failed", () => {
    /** A real outage of the real writer: a directory where its temporary file goes. */
    const writesFail = (path: string) => mkdirSync(`${path}.tmp`);
    const writesWork = (path: string) => rmdirSync(`${path}.tmp`);
    function settling(path: string, log?: (message: string) => void) {
      const calls: string[] = [];
      let terminal = true;
      const subject = index(
        path,
        async (opts) => {
          calls.push(opts.marker);
          const result = terminal ? expired : outcome();
          terminal = false;
          return result;
        },
        log,
      );
      return { subject, calls };
    }
    async function eventually(subject: DaemonRunScopeIndex, check: () => void) {
      await vi.waitFor(async () => {
        await ticks(subject, 1);
        check();
      });
    }

    it("repeats only the write after a delivered settlement: no reap and no second report", async () => {
      const path = join(tempRoot(), RUN_SCOPE_INDEX_FILE);
      const logs: string[] = [];
      const { subject, calls } = settling(path, (line) => logs.push(line));
      const reports: LaterScopeSettlement[] = [];
      subject.onLaterSettlement((settlement) => void reports.push(settlement));
      const { marker } = await subject.open("run-stale");
      await subject.settle("run-stale", marker);

      writesFail(path);
      await eventually(subject, () => {
        expect(reports).toHaveLength(1);
        expect(subject.list()).toEqual([]);
      });
      await ticks(subject, 3);
      // Told and retired here; the file says otherwise and must not claim more than it holds.
      expect(readIndex(path).entries).toEqual([
        expect.objectContaining({ marker, state: "unresolved" }),
      ]);
      expect(logs.join("\n")).toContain("later settlement of run-stale could not be persisted");

      writesWork(path);
      await eventually(subject, () => expect(readIndex(path).entries).toEqual([]));
      await ticks(subject, 3);
      expect(calls).toHaveLength(2);
      expect(reports).toHaveLength(1);
    });

    it("keeps a listener's own debt apart: its report repeats, the reap never does", async () => {
      const path = join(tempRoot(), RUN_SCOPE_INDEX_FILE);
      const { subject, calls } = settling(path);
      const reports: LaterScopeSettlement[] = [];
      let down = true;
      subject.onLaterSettlement(async (settlement) => {
        reports.push(settlement);
        if (down) throw new Error("fixture: the later record could not be written");
      });
      const { marker } = await subject.open("run-both");
      await subject.settle("run-both", marker);

      writesFail(path);
      await eventually(subject, () => expect(subject.list()).toEqual([]));
      down = false;
      await eventually(subject, () => expect(reports.length).toBeGreaterThan(1));
      const delivered = reports.length;
      writesWork(path);
      await eventually(subject, () => expect(readIndex(path).entries).toEqual([]));
      await ticks(subject, 3);
      expect(reports).toHaveLength(delivered);
      expect(reports.at(-1)).toEqual(reports[0]);
      expect(calls).toHaveLength(2);
    });

    it("carries everything that changed during the outage in the one repeated write", async () => {
      const path = join(tempRoot(), RUN_SCOPE_INDEX_FILE);
      const logs: string[] = [];
      const { subject } = settling(path, (line) => logs.push(line));
      subject.onLaterSettlement(() => {});
      const { marker } = await subject.open("run-retired");
      await subject.settle("run-retired", marker);

      writesFail(path);
      await eventually(subject, () => expect(subject.list()).toHaveLength(0));
      // Its barrier is not turned into success: `open` still reports that this write failed.
      const { marker: opened } = await subject.open("run-opened");
      expect(logs.join("\n")).toContain("could not record scope for run-opened before launch");
      expect(readIndex(path).entries).toEqual([expect.objectContaining({ marker })]);

      writesWork(path);
      await eventually(subject, () =>
        expect(readIndex(path).entries).toEqual([
          expect.objectContaining({ marker: opened, state: "open" }),
        ]),
      );
    });

    it("repeats a terminal settlement's write too, and the unresolved row it records", async () => {
      const path = join(tempRoot(), RUN_SCOPE_INDEX_FILE);
      const { subject, calls } = settling(path);
      const { marker } = await subject.open("run-terminal");
      writesFail(path);
      await subject.settle("run-terminal", marker);
      expect(readIndex(path).entries).toEqual([expect.objectContaining({ state: "open" })]);
      writesWork(path);
      await eventually(subject, () =>
        expect(readIndex(path).entries).toEqual([
          expect.objectContaining({ marker, state: "unresolved" }),
        ]),
      );
      // No listener is bound, so nothing here started a reap of its own.
      expect(calls).toHaveLength(1);
    });

    it("says so once when an outage lasts, and once when it ends", async () => {
      const path = join(tempRoot(), RUN_SCOPE_INDEX_FILE);
      const logs: string[] = [];
      const { subject } = settling(path, (line) => logs.push(line));
      const { marker } = await subject.open("run-outage-log");
      writesFail(path);
      await subject.settle("run-outage-log", marker);
      await ticks(subject, 12);
      await vi.waitFor(() =>
        expect(logs.filter((line) => line.includes("stay unpublished"))).toHaveLength(1),
      );
      writesWork(path);
      await eventually(subject, () =>
        expect(logs.filter((line) => line.includes("have now landed"))).toHaveLength(1),
      );
      await ticks(subject, 3);
      expect(logs.filter((line) => line.includes("stay unpublished"))).toHaveLength(1);
      expect(logs.filter((line) => line.includes("have now landed"))).toHaveLength(1);
    });

    it("ends an outage with whichever write lands, and says a new one again", async () => {
      const path = join(tempRoot(), RUN_SCOPE_INDEX_FILE);
      const logs: string[] = [];
      const { subject } = settling(path, (line) => logs.push(line));
      const said = (text: string) => logs.filter((line) => line.includes(text)).length;
      await subject.open("run-before");
      writesFail(path);
      await subject.open("run-during");
      expect(said("stay unpublished")).toBe(1);
      writesWork(path);
      // A run's own write lands first, which leaves a tick nothing to repeat or announce.
      await subject.open("run-after");
      expect(said("have now landed")).toBe(1);
      expect(readIndex(path).entries).toHaveLength(3);
      await ticks(subject, 2);
      expect(said("have now landed")).toBe(1);

      writesFail(path);
      await subject.open("run-second");
      expect(said("stay unpublished")).toBe(2);
      writesWork(path);
      await eventually(subject, () => expect(said("have now landed")).toBe(2));
      expect(readIndex(path).entries).toHaveLength(4);
    });

    it("repeats a seed's write like any other", async () => {
      const path = join(tempRoot(), RUN_SCOPE_INDEX_FILE);
      const { subject, calls } = settling(path);
      const { marker } = await subject.open("run-seed");
      writesFail(path);
      // This process, under an identity it does not have: the group is recorded, no birth read.
      await subject.seedRoot({
        pid: process.pid,
        scopeMarker: marker,
        processGroup: { schemaVersion: 1, pgid: 4321, leader: known(process.pid, "3003") },
      } as unknown as LiveChildProcess);
      expect(subject.list()[0]?.root_groups).toHaveLength(1);
      expect(readIndex(path).entries).toEqual([expect.objectContaining({ root_groups: [] })]);
      writesWork(path);
      await eventually(subject, () =>
        expect(readIndex(path).entries).toEqual([
          expect.objectContaining({
            root_groups: [expect.objectContaining({ pgid: 4321, leader_pid: process.pid })],
          }),
        ]),
      );
      expect(calls).toEqual([]);
    });

    it("repeats a start's failed rewrite on the tick, with nothing reaped for it", async () => {
      const path = join(tempRoot(), RUN_SCOPE_INDEX_FILE);
      const { subject } = settling(path);
      const { marker } = await subject.open("run-rewrite");
      await subject.settle("run-rewrite", marker);
      const reaped: string[] = [];
      const next = new DaemonRunScopeIndex({
        path,
        owner: async () => known(process.pid, "2002"),
        identity: { read: async () => ({ status: "missing", pid: self.pid, platform: "linux" }) },
        reap: async (opts) => {
          reaped.push(opts.marker);
          return outcome();
        },
        table,
        roots: () => [],
        deadlineMs: 1,
        now: () => "2026-11-04T00:00:00.000Z",
      });
      writesFail(path);
      const actions = await next.settleDeadOwners();
      expect(actions.join("\n")).toContain("run-scope index could not be rewritten");
      expect(readIndex(path).entries).toEqual([expect.objectContaining({ marker })]);
      writesWork(path);
      await eventually(next, () => expect(readIndex(path).entries).toEqual([]));
      expect(reaped).toEqual([marker]);
    });

    it("leaves a restart a stale row it settles again by identity, with nobody told twice", async () => {
      const path = join(tempRoot(), RUN_SCOPE_INDEX_FILE);
      const { subject } = settling(path);
      const reports: LaterScopeSettlement[] = [];
      subject.onLaterSettlement((settlement) => void reports.push(settlement));
      const { marker } = await subject.open("run-restart");
      await subject.settle("run-restart", marker);
      writesFail(path);
      await eventually(subject, () => expect(subject.list()).toEqual([]));
      writesWork(path);

      // The daemon died before any write landed; its successor reads the stale row.
      expect(readIndex(path).entries).toEqual([expect.objectContaining({ marker })]);
      const reaped: string[] = [];
      const next = new DaemonRunScopeIndex({
        path,
        owner: async () => known(process.pid, "2002"),
        identity: { read: async () => ({ status: "missing", pid: self.pid, platform: "linux" }) },
        reap: async (opts) => {
          reaped.push(opts.marker);
          return outcome();
        },
        table,
        roots: () => [],
        deadlineMs: 1,
        now: () => "2026-11-04T00:00:00.000Z",
      });
      await next.settleDeadOwners();
      expect(reaped).toEqual([marker]);
      expect(readIndex(path).entries).toEqual([]);
      expect(reports).toHaveLength(1);
    });
  });

  describe("a consumer closing around an attempt", () => {
    /** One eligible finished scope. `gate` holds an await open for the test to act inside. */
    function attempting(gate: "owner" | "reap" | "record" | null) {
      const effects: string[] = [];
      const log: string[] = [];
      let reached = () => {};
      let open = () => {};
      const entered = new Promise<void>((done) => (reached = done));
      const opened = new Promise<void>((done) => (open = done));
      const hold = async (name: typeof gate) => {
        if (gate !== name) return;
        gate = null; // once: the next attempt, after the test opens this one, runs straight through
        reached();
        await opened;
      };
      const entry = parseEntry({
        marker: mintRunScopeMarker(),
        run_id: "run-closing",
        owner: self,
        state: "unresolved",
        opened_at: "2026-11-04T00:00:00.000Z",
        settled_at: "2026-11-04T00:00:00.000Z",
        root_groups: [],
        captured: [],
      })!;
      const subject = new LateScopeSettlement({
        entries: () => [entry],
        owner: async () => {
          await hold("owner");
          return self;
        },
        reap: async () => {
          effects.push("reap");
          await hold("reap");
          return outcome();
        },
        record: async () => {
          effects.push("record");
          await hold("record");
        },
        table,
        deadlineMs: 1,
        log: (line) => log.push(line),
        now: () => Date.parse("2026-11-05T00:00:00.000Z"),
        iso: () => "2026-11-05T00:00:00.000Z",
      });
      const consumer = (name: string) => subject.subscribe(() => void effects.push(name));
      return { subject, effects, log, entry, entered, open, consumer };
    }

    it("tells a bound consumer once, before the entry is recorded", async () => {
      const f = attempting(null);
      f.consumer("told");
      await f.subject.tick();
      expect(f.effects).toEqual(["reap", "told", "record"]);
      expect(f.entry.late_attempts).toBe(1);
    });

    it("never starts a reap for a consumer that closed before it began", async () => {
      const f = attempting("owner");
      const unbind = f.consumer("closed");
      const tick = f.subject.tick();
      await f.entered;
      unbind();
      f.open();
      await tick;
      expect(f.effects).toEqual([]);
      expect(f.entry.late_attempts).toBeUndefined();

      // The entry waited: the next binding gets a normal attempt.
      f.consumer("next");
      await f.subject.tick();
      expect(f.effects).toEqual(["reap", "next", "record"]);
    });

    it("finishes a reap already running at close without retiring its entry", async () => {
      const f = attempting("reap");
      const unbind = f.consumer("closed");
      const tick = f.subject.tick();
      await f.entered;
      unbind();
      f.open();
      await tick;
      // It ran, it cannot be recalled, and nobody heard it: nothing is recorded as settled.
      expect(f.effects).toEqual(["reap"]);
      expect(f.entry.late_attempts).toBeUndefined();
      expect(f.log).toEqual([expect.stringContaining("finished after its listener closed")]);

      f.consumer("next");
      await f.subject.tick();
      expect(f.effects).toEqual(["reap", "reap", "next", "record"]);
    });

    it("gives a running reap's report to the binding that replaced the closed one", async () => {
      const f = attempting("reap");
      const unbind = f.consumer("closed");
      const tick = f.subject.tick();
      await f.entered;
      unbind();
      f.consumer("replacement");
      f.open();
      await tick;
      expect(f.effects).toEqual(["reap", "replacement", "record"]);
    });

    it("has already told the consumer when a close lands during the record", async () => {
      const f = attempting("record");
      const unbind = f.consumer("told");
      const tick = f.subject.tick();
      await f.entered;
      unbind();
      f.open();
      await tick;
      expect(f.effects).toEqual(["reap", "told", "record"]);
    });
  });

  it("attempts nothing with no one to tell, and continues for the next subscriber", async () => {
    const path = join(tempRoot(), RUN_SCOPE_INDEX_FILE);
    const calls: string[] = [];
    let terminal = true;
    const subject = index(path, async (opts) => {
      calls.push(opts.marker);
      const result = terminal ? expired : outcome();
      terminal = false;
      return result;
    });
    const { marker } = await subject.open("run-unbound");
    await subject.settle("run-unbound", marker);
    await ticks(subject, 6);
    await subject.captureTick();
    // A settled attempt here would retire the entry and tell nobody.
    expect(calls).toHaveLength(1);
    expect(readIndex(path).entries).toEqual([expect.objectContaining({ state: "unresolved" })]);

    const reports: LaterScopeSettlement[] = [];
    const unbind = subject.onLaterSettlement((settlement) => void reports.push(settlement));
    await vi.waitFor(async () => {
      await ticks(subject, 1);
      expect(reports).toHaveLength(1);
    });
    unbind();
    expect(reports[0]).toMatchObject({ runId: "run-unbound", attempt: 1 });
    expect(calls).toHaveLength(2);
  });

  it("connects the factory's runtime, and its stop ends that", async () => {
    const root = tempRoot();
    const sql = await sqlFixture(root);
    const subscribers = new Set<LaterSettlementListener>();
    const runtime = createSqlDaemonRuntime(sql.graph, {
      server: { socketPath: join(root, "unused.sock"), token: "fixture" },
      authReadiness: () => ({ invalidate() {} }),
      agent: () => async () => ({ lifecycle: "succeeded" }),
      laterScopes: {
        onLaterSettlement(listener) {
          subscribers.add(listener);
          return () => void subscribers.delete(listener);
        },
      },
    });
    try {
      expect(subscribers.size).toBe(1);
      const runDir = tempRoot();
      mkdirSync(join(runDir, "final"));
      const known = { id: "job-known", runDir } as never;
      vi.spyOn(sql.graph.commands.queries, "getByRunId").mockReturnValue(known);
      const settled = vi
        .spyOn(runtime.server.deferred, "processScopeSettled")
        .mockResolvedValue(undefined);
      await [...subscribers][0]!({
        runId: "run-known",
        marker: mintRunScopeMarker(),
        outcome: outcome(),
        attempt: 1,
        at: "2026-11-04T00:00:00.000Z",
      });
      expect(settled).toHaveBeenCalledExactlyOnceWith("job-known");
      expect(existsSync(join(runDir, LATER_PROCESS_SCOPE))).toBe(true);
    } finally {
      await runtime.stop();
      await sql.close();
    }
    expect(subscribers.size).toBe(0);
  });

  it("never loses a settled report to an outage: unsettled ones give way to newer attempts", async () => {
    const path = join(tempRoot(), RUN_SCOPE_INDEX_FILE);
    const calls: string[] = [];
    let settled = false;
    const subject = index(path, async (opts) => {
      calls.push(opts.marker);
      return settled ? outcome() : expired;
    });
    // The real binder: while `final/` is missing the record write throws, so the report is owed.
    const runDir = tempRoot();
    const returned: string[] = [];
    bindLaterScopeSettlements(subject, {
      run: (runId) => (runId === "run-outage" ? { id: "job-outage", runDir } : undefined),
      settled: async (jobId) => void returned.push(jobId),
    });
    const seen: LaterScopeSettlement[] = [];
    subject.onLaterSettlement((settlement) => void seen.push(settlement));
    const { marker } = await subject.open("run-outage");
    await subject.settle("run-outage", marker);
    // The outage does not stop the reaping of unresolved attempts; each owes its own newer fact.
    await vi.waitFor(async () => {
      await ticks(subject, 1);
      expect(seen.length).toBeGreaterThan(2);
    });
    settled = true;
    await vi.waitFor(async () => {
      await ticks(subject, 1);
      expect(seen.at(-1)?.outcome.settled).toBe(true);
    });
    const attempts = seen.map((settlement) => settlement.attempt);
    expect(attempts).toEqual(attempts.map((_, at) => at + 1));
    // Settled: the entry is gone, so no newer attempt can replace this report.
    await vi.waitFor(() => expect(readIndex(path).entries).toEqual([]));
    const reaps = calls.length;
    await ticks(subject, 3);
    expect(calls).toHaveLength(reaps);
    expect(returned).toEqual([]);
    expect(existsSync(join(runDir, LATER_PROCESS_SCOPE))).toBe(false);
    // The outage ends: the owed report lands once, carrying the newest attempt.
    mkdirSync(join(runDir, "final"));
    await vi.waitFor(async () => {
      await ticks(subject, 1);
      expect(returned).toEqual(["job-outage"]);
    });
    await ticks(subject, 3);
    expect(returned).toEqual(["job-outage"]);
    expect(calls).toHaveLength(reaps);
    expect(JSON.parse(readFileSync(join(runDir, LATER_PROCESS_SCOPE), "utf8"))).toMatchObject({
      attempt: attempts.at(-1),
      outcome: { settled: true },
    });
  });

  it("holds a run past a group it cannot prove and returns it once that member left", async () => {
    const OLDER = "Mon Oct 12 13:00:00 2026";
    const YOUNGER = "Mon Oct 12 14:00:09 2026";
    let rows: ProcessTableRow[] = [
      { pid: 7, ppid: 1, pgid: 200, birth: OLDER },
      { pid: 230, ppid: 1, pgid: 200, birth: YOUNGER },
    ];
    const signals: number[] = [];
    const census: ScopeCensusReader = {
      census: async (markers) => ({
        status: "ok",
        members: new Map(markers.map((name) => [name, []])),
        unreadable: 0,
      }),
      confirm: async () => false,
    };
    const liveTable: ProcessTableReader = {
      snapshot: async () => rows,
      row: async (pid) => rows.find((row) => row.pid === pid) ?? null,
    };
    const path = join(tempRoot(), RUN_SCOPE_INDEX_FILE);
    const marker = mintRunScopeMarker();
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        entries: [
          {
            marker,
            run_id: "run-group",
            owner: self,
            state: "unresolved",
            opened_at: "2026-10-12T14:00:00.000Z",
            settled_at: "2026-11-04T00:00:00.000Z",
            scope_start: "Mon Oct 12 14:00:00 2026",
            root_groups: [],
            captured: [{ pid: 200, pgid: 200, birth: "Mon Oct 12 14:00:05 2026" }],
          },
        ],
      }),
    );
    const subject = index(path, (opts) =>
      reapScopeMembers({
        ...opts,
        census,
        table: liveTable,
        signal: (pid) => void signals.push(pid),
        deadlineMs: 5_000,
      }),
    );
    const runDir = tempRoot();
    mkdirSync(join(runDir, "final"));
    const returned: string[] = [];
    bindLaterScopeSettlements(subject, {
      run: () => ({ id: "job-group", runDir }),
      settled: async (jobId) => void returned.push(jobId),
    });
    const later = () => JSON.parse(readFileSync(join(runDir, LATER_PROCESS_SCOPE), "utf8"));
    await vi.waitFor(async () => {
      await ticks(subject, 1);
      expect(existsSync(join(runDir, LATER_PROCESS_SCOPE))).toBe(true);
    });
    expect(later().outcome).toMatchObject({
      settled: false,
      reused_groups: [200],
      unreadable: [{ pid: 230, reason: "group_membership_unproven" }],
    });
    expect(returned).toEqual([]);
    expect(readIndex(path).entries[0]).toMatchObject({ marker, state: "unresolved" });
    rows = rows.filter((row) => row.pid !== 230);
    await vi.waitFor(async () => {
      await ticks(subject, 1);
      expect(returned).toEqual(["job-group"]);
    });
    expect(later().outcome).toMatchObject({ settled: true, reused_groups: [200], unreadable: [] });
    await vi.waitFor(() => expect(readIndex(path).entries).toEqual([]));
    expect(signals).toEqual([]);
  });

  it("acts on no row with a malformed marker or outcome and keeps each one verbatim", async () => {
    const row = {
      marker: mintRunScopeMarker(),
      run_id: "run-x",
      state: "unresolved",
      owner: self,
      opened_at: "2026-11-04T00:00:00.000Z",
      settled_at: "2026-11-04T00:00:00.000Z",
      root_groups: [],
      captured: [],
    };
    // Rows of an older writer carry only the summary fields it knew.
    const older = {
      coverage: "marker",
      census: "failed",
      census_failure: "ps failed",
      ended: 0,
      survivors: [41],
      unreadable: [],
      reused_groups: [],
      restricted: false,
      completeness: "not_provable",
    };
    expect(parseEntry({ ...row, outcome: older })).toMatchObject({ outcome: older });
    const malformed = [
      { marker: "NOT_A_SCOPE" },
      { marker: `HOST_SCOPE_${"0".repeat(32)}` },
      { marker: `${row.marker}\n` },
      { outcome: null },
      { outcome: "ok" },
      { outcome: [] },
      { outcome: {} },
      { outcome: { ...older, census: "maybe" } },
      { outcome: { ...older, census: undefined } },
      { outcome: { ...older, survivors: "41" } },
      { outcome: { ...older, unreadable: [{ pid: 1 }] } },
      { outcome: { ...older, reused_groups: [1.5] } },
    ];
    for (const fields of malformed) expect(parseEntry({ ...row, ...fields })).toBeNull();

    // Neither the start of a daemon nor a later attempt reaches them.
    const path = join(tempRoot(), RUN_SCOPE_INDEX_FILE);
    const rows = malformed.map((fields, at) => ({ ...row, run_id: `run-${at}`, ...fields }));
    const good = mintRunScopeMarker();
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        entries: [
          { ...row, marker: good, run_id: "run-good", owner: known(4242, "2002") },
          ...rows,
        ],
      }),
    );
    const reaped: string[] = [];
    const reap = async (opts: ScopeReapOptions) => {
      reaped.push(opts.marker);
      return opts.marker === good ? outcome() : expired;
    };
    const started = new DaemonRunScopeIndex({
      path,
      owner: async () => self,
      identity: { read: async () => ({ status: "missing", pid: 4242, platform: "linux" }) },
      reap,
      table,
      roots: () => [],
      deadlineMs: 1,
      now: () => "2026-11-04T00:00:00.000Z",
    });
    const actions = await started.settleDeadOwners();
    expect(reaped).toEqual([good]);
    expect(actions[0]).toContain(`keeps ${rows.length} unrecognized row(s)`);
    const late = index(path, reap);
    late.onLaterSettlement(() => {});
    await ticks(late, 5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reaped).toEqual([good]);
    // Verbatim through the rewrites (JSON drops the one undefined field as it did on write).
    expect(readIndex(path).entries).toEqual(JSON.parse(JSON.stringify(rows)));
  });

  it("keeps attempting past the former cap, and never touches open, foreign or unsupported scopes", async () => {
    const path = join(tempRoot(), RUN_SCOPE_INDEX_FILE);
    const calls: string[] = [];
    const subject = index(path, async (opts) => {
      calls.push(opts.marker);
      return expired;
    });
    const { marker: owned } = await subject.open("run-owned");
    await subject.settle("run-owned", owned);
    await subject.open("run-open");
    const foreign = mintRunScopeMarker();
    const unsupported = mintRunScopeMarker();
    const row = (marker: string, runId: string, owner: KnownProcessIdentity, census: string) => ({
      marker,
      run_id: runId,
      owner,
      state: "unresolved",
      opened_at: "2026-11-04T00:00:00.000Z",
      settled_at: "2026-11-04T00:00:00.000Z",
      scope_start: null,
      root_groups: [],
      captured: [],
      outcome: { census, survivors: [], unreadable: [] },
    });
    const file = readIndex(path);
    file.entries.push(
      row(foreign, "run-foreign", known(4242, "2002"), "ok"),
      row(unsupported, "run-windows", self, "unsupported"),
    );
    writeFileSync(path, JSON.stringify(file));
    const reloaded = index(path, async (opts) => {
      calls.push(opts.marker);
      return expired;
    });
    reloaded.onLaterSettlement(() => {});
    calls.length = 0;
    // No unchosen cap: more attempts than the former three, each bounded by its own
    // deadline and spaced by its multiple on the existing capture tick.
    await vi.waitFor(async () => {
      await ticks(reloaded, 2);
      expect(calls.length).toBeGreaterThan(3);
    });
    expect(new Set(calls)).toEqual(new Set([owned]));
    await vi.waitFor(() =>
      expect(
        readIndex(path).entries.find((entry) => entry.marker === owned)?.late_attempts,
      ).toBeGreaterThan(3),
    );
    const entries = readIndex(path).entries;
    expect(entries.find((entry) => entry.marker === owned)).toMatchObject({
      state: "unresolved",
      settled_at: "2026-11-04T00:00:00.000Z",
    });
    expect(entries.find((entry) => entry.run_id === "run-open")).toMatchObject({ state: "open" });
  });
});
