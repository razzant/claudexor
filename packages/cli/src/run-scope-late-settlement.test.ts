import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  mintRunScopeMarker,
  reapScopeMembers,
  type KnownProcessIdentity,
  type ProcessTableReader,
  type ProcessTableRow,
  type ScopeCensusReader,
  type ScopeReapOptions,
  type ScopeReapOutcome,
} from "@claudexor/core";
import { DaemonRunScopeIndex, RUN_SCOPE_INDEX_FILE } from "./run-scope-index.js";
import { RunScopeIndexPublisher } from "./run-scope-index-file.js";
import { parseEntry } from "./run-scope-index-rows.js";
import type { LaterScopeSettlement, LaterSettlementListener } from "./run-scope-late-settlement.js";
import { bindLaterScopeSettlements, LATER_PROCESS_SCOPE } from "./run-scope-later-record.js";

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

function index(path: string, reap: (opts: ScopeReapOptions) => Promise<ScopeReapOutcome>) {
  return new DaemonRunScopeIndex({
    path,
    owner: async () => self,
    reap,
    table,
    roots: () => [],
    deadlineMs: 1,
    now: () => "2026-11-04T00:00:00.000Z",
    laterAttempts: true,
  });
}
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
    const publisher = new RunScopeIndexPublisher(path, body, async (_path, text) => {
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
  });

  it("rejects the receipt of a revision whose write failed and never leaves a waiter hanging", async () => {
    const root = tempRoot();
    const blocker = join(root, "not-a-directory");
    writeFileSync(blocker, "x");
    const publisher = new RunScopeIndexPublisher(join(blocker, "index.json"), () => ({
      schema_version: 1,
      entries: [],
    }));
    await expect(publisher.publish(publisher.changed())).rejects.toThrow();
    await expect(publisher.publish(publisher.changed())).rejects.toThrow();
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
    expect(calls[1]).toMatchObject({ marker, deadlineMs: 1 });
    await vi.waitFor(() => expect(readIndex(path).entries).toEqual([]));
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
    expect(readIndex(path).entries).toEqual([]);
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
        log: () => {},
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
      log: () => {},
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
    const reaps = calls.length;
    expect(readIndex(path).entries).toEqual([]);
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
      log: () => {},
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
    expect(readIndex(path).entries).toEqual([]);
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
