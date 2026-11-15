// #694 r13: a root whose own process group was proven empty at its natural
// close stops being a membership basis for EVERY reader of the index file,
// also a host that predates this engine and knows no new key: the basis is
// removed from the bytes. The exact registration's `root_groups` row goes and
// captured rows that named the group keep pid and birth with `pgid: -1`.
//
// The real index and serializer write the bytes. They are read back three
// ways: by this engine's own reader (`capturedCandidates` over `reapSources`),
// by this engine's loader, and by `oldHostTargets`/`oldHostMembers` below — the
// author's transliteration of the rule a host built before this change applies
// to schema 1 (it ignores unknown keys, takes group ids only above 1 and also
// derives a group from every captured pgid). Processes are table rows; nothing
// is signalled.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  birthEpochSeconds,
  capturedCandidates,
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
import { loadRunScopeIndex, runScopeIndexBody } from "./run-scope-index-file.js";
import { orderCaptured, reapSources } from "./run-scope-index-rows.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0);

const T0 = "Mon Oct 12 14:00:00 2026";
const T1 = "Mon Oct 12 14:00:05 2026";
const T2 = "Mon Oct 12 14:00:09 2026";
const T3 = "Mon Oct 12 14:00:12 2026";
const OPENED = new Date(T0).toISOString();

const known = (pid: number, token: string): KnownProcessIdentity => ({
  status: "known",
  pid,
  platform: "linux",
  source: "procfs_stat",
  startToken: `linux:${token}`,
  processGroupId: pid,
});
/** A registration as the process registry hands it out (its own group's leader). */
const registration = (pid: number, marker: string, token = String(pid)): LiveChildProcess => ({
  pid,
  cmd: "git",
  scopeMarker: marker,
  processGroup: {
    schemaVersion: 1,
    pgid: pid,
    leader: known(pid, token),
  } as unknown as ProcessGroupHandle,
});

/** The real index over a temp file, with a process table and live roots the test drives. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), "claudexor-emptied-group-"));
  dirs.push(dir);
  const path = join(dir, RUN_SCOPE_INDEX_FILE);
  const state = {
    rows: [] as ProcessTableRow[],
    roots: [] as LiveChildProcess[],
    /** When set, the next snapshot/row read waits for it (a read in flight). */
    gate: null as Promise<void> | null,
    /** False: only snapshots wait for `gate`; single-row reads answer at once. */
    gateRows: true,
  };
  const table: ProcessTableReader = {
    async snapshot() {
      const rows = [...state.rows]; // the table as it was when the read began
      await state.gate;
      return rows;
    },
    async row(pid) {
      const row = state.rows.find((r) => r.pid === pid) ?? null;
      if (state.gateRows) await state.gate;
      return row;
    },
  };
  const identity = {
    async read(pid: number): Promise<ProcessIdentity> {
      const root = state.roots.find((r) => r.pid === pid);
      return root ? root.processGroup.leader : { status: "missing", pid, platform: "linux" };
    },
  };
  const index = (reaps: ScopeReapOptions[] = []) =>
    new DaemonRunScopeIndex({
      path,
      owner: async () => known(process.pid, "7"),
      now: () => OPENED,
      // Every settlement stays unresolved here: the entry and its rows are kept.
      reap: async (opts) => {
        reaps.push(opts);
        return {
          coverage: "marker+capture",
          census: "ok",
          censusFailure: null,
          ended: [],
          survivors: [],
          unreadable: [],
          reusedGroups: [],
          settled: false,
          incomplete: false,
          completeness: "not_provable",
          completenessReason: null,
          restricted: false,
          durationMs: 1,
        } satisfies ScopeReapOutcome;
      },
      table,
      identity,
      roots: () => state.roots,
    });
  return { path, state, index, bytes: () => readFileSync(path, "utf8") };
}

type OldGroup = { pgid: number; leader_pid: number; leader_birth: string; floor: string };
/** `(groups, captured)` as the earlier host derives them from the file's bytes. */
function oldHostTargets(bytes: string): {
  groups: OldGroup[];
  captured: Array<{ pid: number; birth: string }>;
} {
  const int = (value: unknown): number => (Number.isInteger(value) ? (value as number) : 0);
  const data = JSON.parse(bytes) as { schema_version: number; entries: Array<Record<string, any>> };
  expect(data.schema_version).toBe(1);
  const groups: OldGroup[] = [];
  const captured: Array<{ pid: number; birth: string }> = [];
  for (const entry of data.entries) {
    const floor = String(entry.scope_start || "") || String(entry.opened_at || "");
    for (const group of entry.root_groups ?? [])
      if (int(group.pgid) > 1)
        groups.push({
          pgid: int(group.pgid),
          leader_pid: int(group.leader_pid),
          leader_birth: String(group.leader_birth || ""),
          floor,
        });
    const leaders = new Map<number, string>();
    for (const item of entry.captured ?? []) leaders.set(int(item.pid), String(item.birth || ""));
    for (const item of entry.captured ?? []) {
      const [pid, pgid, birth] = [int(item.pid), int(item.pgid), String(item.birth || "")];
      if (pid > 1 && birth) captured.push({ pid, birth });
      if (pgid > 1 && groups.every((group) => group.pgid !== pgid))
        groups.push({ pgid, leader_pid: pgid, leader_birth: leaders.get(pgid) ?? "", floor });
    }
  }
  return { groups, captured };
}
/** The pids that host would end for those targets against one process table: each
 * captured pid alive with its recorded birth, and a recorded group's live members —
 * unless a live pid == G is not the recorded leader, or a member predates the floor. */
function oldHostMembers(bytes: string, rows: ProcessTableRow[]): number[] {
  const { groups, captured } = oldHostTargets(bytes);
  const byPid = new Map(rows.map((row) => [row.pid, row] as const));
  const members = new Set<number>();
  for (const item of captured) if (byPid.get(item.pid)?.birth === item.birth) members.add(item.pid);
  for (const group of groups) {
    const candidates = rows.filter((row) => row.pgid === group.pgid);
    const leader = byPid.get(group.pgid);
    if (leader && group.leader_birth && leader.birth === group.leader_birth)
      members.add(group.pgid);
    if (candidates.length === 0) continue;
    const floor = (birthEpochSeconds(group.leader_birth || group.floor) ?? 0) - 1;
    const stranger =
      leader !== undefined && (!group.leader_birth || leader.birth !== group.leader_birth);
    if (stranger || candidates.some((row) => (birthEpochSeconds(row.birth) ?? 0) < floor)) continue;
    for (const row of candidates) members.add(row.pid);
  }
  return [...members].sort((a, b) => a - b);
}
/** The pids THIS engine's reader takes for the entry against one process table. */
function engineMembers(path: string, rows: ProcessTableRow[]): number[] {
  const entry = loadRunScopeIndex(path, () => {}).entries[0]!;
  const sources = reapSources(entry);
  const found = capturedCandidates(sources.captured, rows, sources.scopeStart, sources);
  return [...found.candidates.keys()].sort((a, b) => a - b);
}

/** Later, on the host: D left its group for H and lives; a stranger's leaderless
 * group reuses the id G=500 (its leader is gone, its member was born in scope). */
const LATER: ProcessTableRow[] = [
  { pid: 600, ppid: 1, pgid: 700, birth: T1 },
  { pid: 901, ppid: 1, pgid: 500, birth: T2 },
];

/** An open scope whose root R (pid == pgid == 500) and its child D (600, in R's
 * group) were seeded and captured. */
async function seeded() {
  const w = world();
  const index = w.index();
  const { marker } = await index.open("run-g");
  const root = registration(500, marker);
  w.state.roots = [root];
  w.state.rows = [
    { pid: 500, ppid: 1, pgid: 500, birth: T1 },
    { pid: 600, ppid: 500, pgid: 500, birth: T1 },
  ];
  await index.seedRoot(root);
  await index.captureTick();
  return { ...w, restarted: w.index, index, marker, root };
}

describe("a root group proven empty leaves the index file (#694 r13)", () => {
  it("the written bytes give every reader no basis for G, and D still counts by its own pid and birth", async () => {
    const w = await seeded();
    // Before: R's group is on record, by its root row and by both captured rows.
    expect(oldHostTargets(w.bytes()).groups.map((group) => group.pgid)).toEqual([500]);
    // R closed by itself and signal 0 to its group answered ESRCH.
    w.state.roots = [];
    await w.index.retireRootGroup(w.root);
    const entry = JSON.parse(w.bytes()).entries[0];
    expect(entry.root_groups).toEqual([]);
    expect(entry.captured).toEqual([
      { pid: 500, pgid: -1, birth: T1 },
      { pid: 600, pgid: -1, birth: T1 },
    ]);
    expect(w.bytes()).not.toMatch(/retired/);
    // The earlier host: zero groups, D individually; the stranger is not reached.
    expect(oldHostTargets(w.bytes())).toEqual({
      groups: [],
      captured: [
        { pid: 500, birth: T1 },
        { pid: 600, birth: T1 },
      ],
    });
    expect(oldHostMembers(w.bytes(), LATER)).toEqual([600]);
    // This engine's reader, from the file as a restarted daemon loads it.
    expect(engineMembers(w.path, LATER)).toEqual([600]);
    const reaps: ScopeReapOptions[] = [];
    await w.restarted(reaps).settle("run-g", w.marker);
    expect(reaps[0]).toMatchObject({ rootGroups: [], captured: entry.captured });
    expect(reaps[0]).not.toHaveProperty("retiredGroups");
  });

  it("negative control: a flag the earlier host does not know (`retired: true`) presents G to it again", () => {
    const w = world();
    // The same scope as a build that only flagged the row would have written it.
    const flagged = {
      schema_version: 1,
      entries: [
        {
          marker: `CLAUDEXOR_RUN_SCOPE_${"ab".repeat(16)}`,
          run_id: "run-g",
          owner: known(process.pid, "7"),
          state: "open",
          opened_at: OPENED,
          scope_start: T1,
          root_groups: [
            {
              pgid: 500,
              leader_pid: 500,
              leader_birth: T1,
              leader_identity: known(500, "500"),
              retired: true,
            },
          ],
          captured: [
            { pid: 500, pgid: 500, birth: T1 },
            { pid: 600, pgid: 500, birth: T1 },
          ],
        },
      ],
    };
    writeFileSync(w.path, JSON.stringify(flagged));
    expect(oldHostTargets(w.bytes()).groups.map((group) => group.pgid)).toEqual([500]);
    expect(oldHostMembers(w.bytes(), LATER)).toEqual([600, 901]); // the stranger is reached
    // This engine reads such a row as any row of an earlier engine: the flag is no
    // second way to end a basis (it was never published).
    expect(engineMembers(w.path, LATER)).toEqual([600, 901]);
  });

  it("the normalized rows survive serialize, parse and serialize again unchanged", async () => {
    const w = await seeded();
    w.state.roots = [];
    await w.index.retireRootGroup(w.root);
    const first = w.bytes();
    const loaded = loadRunScopeIndex(w.path, () => {});
    expect(loaded.unrecognized).toEqual([]);
    expect(JSON.stringify(runScopeIndexBody(loaded))).toBe(first.trim());
    // And through a restarted index that writes the file again.
    await w.restarted().open("run-next");
    expect(JSON.parse(w.bytes()).entries[0]).toEqual(JSON.parse(first).entries[0]);
  });

  it("only the exact registration's row goes: another identity under the same numbers is not removed, nor removes", async () => {
    const w = await seeded();
    const stranger = registration(500, w.marker, "another-birth");
    await w.index.retireRootGroup(stranger); // not this row's registration
    expect(JSON.parse(w.bytes()).entries[0].root_groups).toHaveLength(1);
    expect(oldHostTargets(w.bytes()).groups.map((group) => group.pgid)).toEqual([500]);
    // A registration of another scope, or one without a marker, changes nothing either.
    await w.index.retireRootGroup({ ...w.root, scopeMarker: undefined });
    expect(JSON.parse(w.bytes()).entries[0].root_groups).toHaveLength(1);
  });

  it("a seed still reading when the group was proven empty records nothing more, and a late seed brings nothing back", async () => {
    const w = world();
    const index = w.index();
    const { marker } = await index.open("run-s");
    const root = registration(500, marker);
    w.state.roots = [root];
    w.state.rows = [{ pid: 500, ppid: 1, pgid: 500, birth: T1 }];
    let release = (): void => {};
    w.state.gate = new Promise<void>((resolve) => (release = resolve));
    const seeding = index.seedRoot(root); // its row is recorded; its `ps -p` read waits
    await expect.poll(() => index.list()[0]!.root_groups.length).toBe(1);
    await index.retireRootGroup(root);
    release();
    w.state.gate = null;
    await seeding;
    await index.seedRoot(root); // the same registration, seeded again late
    const entry = JSON.parse(w.bytes()).entries[0];
    expect(entry.root_groups).toEqual([]);
    expect(entry.captured).toEqual([]);
    expect(entry.scope_start).toBeNull();
    expect(oldHostTargets(w.bytes()).groups).toEqual([]);
  });

  it("a capture pass whose snapshot is older than the proof adds what it saw by pid and birth only; a fresh pass that finds an own new leader G restores it", async () => {
    const w = await seeded();
    // A second live root S (800) of the same scope; its child 810 sits in R's group.
    const other = registration(800, w.marker);
    w.state.roots = [w.root, other];
    w.state.rows = [
      ...w.state.rows,
      { pid: 800, ppid: 1, pgid: 800, birth: T1 },
      { pid: 810, ppid: 800, pgid: 500, birth: T2 },
    ];
    await w.index.seedRoot(other);
    let release = (): void => {};
    w.state.gate = new Promise<void>((resolve) => (release = resolve));
    const pass = w.index.captureTick(); // its snapshot is taken, the pass waits
    // Meanwhile R closes by itself and its group is proven empty.
    w.state.roots = [other];
    await w.index.retireRootGroup(w.root);
    release();
    w.state.gate = null;
    await pass;
    const stale = JSON.parse(w.bytes()).entries[0];
    expect(stale.root_groups.map((group: { pgid: number }) => group.pgid)).toEqual([800]);
    expect(stale.captured).toContainEqual({ pid: 810, pgid: -1, birth: T2 }); // evidence, no basis
    expect(stale.captured.filter((row: { pgid: number }) => row.pgid === 500)).toEqual([]);
    expect(oldHostTargets(w.bytes()).groups.map((group) => group.pgid)).toEqual([800]);
    expect(oldHostMembers(w.bytes(), LATER)).toEqual([600]);

    // A fresh pass, begun after the proof: S's descendant 500 (a new birth) now
    // leads a new group 500 with a member. The verified walk records them as seen.
    w.state.rows = [
      { pid: 800, ppid: 1, pgid: 800, birth: T1 },
      { pid: 500, ppid: 800, pgid: 500, birth: T3 },
      { pid: 520, ppid: 500, pgid: 500, birth: T3 },
    ];
    await w.index.captureTick();
    const fresh = JSON.parse(w.bytes()).entries[0];
    expect(fresh.captured).toContainEqual({ pid: 500, pgid: -1, birth: T1 }); // the old leader, kept
    expect(fresh.captured).toContainEqual({ pid: 500, pgid: 500, birth: T3 });
    // Both readers take the new generation by its own leader's birth, not the old one's.
    const now: ProcessTableRow[] = [...w.state.rows, { pid: 521, ppid: 1, pgid: 500, birth: T3 }];
    expect(engineMembers(w.path, now)).toEqual([500, 520, 521, 800]);
    expect(oldHostMembers(w.bytes(), now)).toEqual([500, 520, 521, 800]);
    expect(oldHostTargets(w.bytes()).groups.find((group) => group.pgid === 500)?.leader_birth).toBe(
      T3,
    );
  });

  it("a new own registration under the emptied numbers is a basis of its own, and the earlier one's late events do not touch it", async () => {
    const w = await seeded();
    w.state.roots = [];
    await w.index.retireRootGroup(w.root);
    // pid 500 is reused by this scope's next root: another measured identity.
    const next = registration(500, w.marker, "next-birth");
    w.state.roots = [next];
    w.state.rows = [{ pid: 500, ppid: 1, pgid: 500, birth: T3 }];
    await w.index.seedRoot(next);
    await w.index.retireRootGroup(w.root); // the earlier registration's event, again
    await w.index.seedRoot(w.root); // and its late seed
    const entry = JSON.parse(w.bytes()).entries[0];
    expect(entry.root_groups).toEqual([
      { pgid: 500, leader_pid: 500, leader_birth: T3, leader_identity: known(500, "next-birth") },
    ]);
    // The root's own record of its leader decides, whatever the captured history says.
    const now: ProcessTableRow[] = [
      { pid: 500, ppid: 1, pgid: 500, birth: T3 },
      { pid: 530, ppid: 500, pgid: 500, birth: T3 },
    ];
    expect(engineMembers(w.path, now)).toEqual([500, 530]);
    expect(oldHostMembers(w.bytes(), now)).toEqual([500, 530]);
    // Its own proof of emptiness removes exactly it.
    w.state.roots = [];
    await w.index.retireRootGroup(next);
    expect(JSON.parse(w.bytes()).entries[0].root_groups).toEqual([]);
    expect(oldHostMembers(w.bytes(), LATER)).toEqual([600]);
  });

  describe("the order of captured rows a host of any age relies on", () => {
    // The earlier host vouches for a captured group's leader by the LAST row of
    // that pid, whatever its group: a row without a basis must not follow a based one.
    const old = { pid: 500, pgid: -1, birth: T1 }; // the emptied generation's leader
    const fresh = { pid: 500, pgid: 500, birth: T3 }; // a new own leader of group 500, captured
    const member = { pid: 520, pgid: 500, birth: T3 };
    /** The new generation, with a member no capture recorded (521). */
    const now: ProcessTableRow[] = [
      { pid: 500, ppid: 800, pgid: 500, birth: T3 },
      { pid: 520, ppid: 500, pgid: 500, birth: T3 },
      { pid: 521, ppid: 520, pgid: 500, birth: T3 },
    ];
    /** The real serializer's bytes for one entry holding exactly these captured rows. */
    const bytesOf = (captured: Array<{ pid: number; pgid: number; birth: string }>) =>
      JSON.stringify(
        runScopeIndexBody({
          entries: [
            {
              marker: `CLAUDEXOR_RUN_SCOPE_${"cd".repeat(16)}`,
              run_id: "run-o",
              owner: known(process.pid, "7"),
              state: "open",
              opened_at: OPENED,
              scope_start: T1,
              root_groups: [],
              captured,
            },
          ],
          unrecognized: [],
        }),
      );

    it("orderCaptured moves a basis-less row before the first based row of its pid, and nothing else", () => {
      const other = { pid: 700, pgid: 700, birth: T2 };
      const lone = { pid: 600, pgid: -1, birth: T1 }; // no based row of its pid: stays
      const rows = [other, fresh, member, lone, old];
      orderCaptured(rows);
      expect(rows).toEqual([other, old, fresh, member, lone]);
      const again = [...rows];
      orderCaptured(again);
      expect(again).toEqual(rows); // already ordered: unchanged
      // Several generations and pids at once.
      const many = [
        { pid: 9, pgid: 9, birth: T3 },
        { pid: 8, pgid: 8, birth: T3 },
        { pid: 9, pgid: -1, birth: T1 },
        { pid: 8, pgid: -1, birth: T1 },
        { pid: 9, pgid: -1, birth: T2 },
      ];
      orderCaptured(many);
      expect(
        many.map((row) => `${row.pid}:${row.pgid}:${row.birth === T3 ? "new" : "old"}`),
      ).toEqual(["9:-1:old", "9:-1:old", "9:9:new", "8:-1:old", "8:8:new"]);
    });

    it("negative control: with the new captured leader BEFORE the emptied one's row the earlier host takes the old birth and loses the new group's uncaptured member", () => {
      const unordered = bytesOf([fresh, member, old]);
      expect(oldHostTargets(unordered).groups).toEqual([
        expect.objectContaining({ pgid: 500, leader_birth: T1 }),
      ]);
      expect(oldHostMembers(unordered, now)).toEqual([500, 520]); // 521 is not reached
    });

    it("in the producer's order (either arrival order) the earlier host takes the live leader's birth and reaches the uncaptured member", () => {
      for (const arrival of [
        [old, fresh, member],
        [fresh, member, old],
      ]) {
        const captured = arrival.map((row) => ({ ...row }));
        orderCaptured(captured);
        const bytes = bytesOf(captured);
        expect(oldHostTargets(bytes).groups).toEqual([
          expect.objectContaining({ pgid: 500, leader_birth: T3 }),
        ]);
        expect(oldHostMembers(bytes, now)).toEqual([500, 520, 521]);
        // A stranger now holding pid 500 (another birth) is never taken for that leader.
        const stranger: ProcessTableRow[] = [
          { pid: 500, ppid: 1, pgid: 500, birth: T2 },
          { pid: 901, ppid: 500, pgid: 500, birth: T2 },
        ];
        expect(oldHostMembers(bytes, stranger)).toEqual([]);
      }
    });

    it("the real index: a stale pass that records the emptied leader AFTER the new generation was recorded still writes it first", async () => {
      const w = world();
      const index = w.index();
      const { marker } = await index.open("run-order");
      const sroot = registration(800, marker);
      const root = registration(500, marker);
      // Both roots are seeded while the table shows only 800: R leaves no captured row yet.
      w.state.roots = [sroot, root];
      w.state.rows = [{ pid: 800, ppid: 1, pgid: 800, birth: T1 }];
      await index.seedRoot(sroot);
      await index.seedRoot(root);
      // R (500) and its child D (600) now show in the table, below the live root S.
      w.state.rows = [
        { pid: 800, ppid: 1, pgid: 800, birth: T1 },
        { pid: 500, ppid: 800, pgid: 500, birth: T1 },
        { pid: 600, ppid: 500, pgid: 500, birth: T1 },
      ];
      let release = (): void => {};
      w.state.gate = new Promise<void>((resolve) => (release = resolve));
      w.state.gateRows = false;
      const stale = index.captureTick(); // its snapshot is taken; the pass waits
      // R closes by itself, its group is proven empty; pid 500 is reused at once by
      // this scope's next root, which is registered and seeded before the pass resumes.
      await index.retireRootGroup(root);
      const next = registration(500, marker, "next-birth");
      w.state.roots = [sroot, next];
      w.state.rows = [
        { pid: 800, ppid: 1, pgid: 800, birth: T1 },
        { pid: 500, ppid: 800, pgid: 500, birth: T3 },
        { pid: 520, ppid: 500, pgid: 500, birth: T3 },
      ];
      await index.seedRoot(next);
      expect(index.list()[0]!.captured).toContainEqual({ pid: 500, pgid: 500, birth: T3 });
      release();
      w.state.gate = null;
      await stale;
      const entry = JSON.parse(w.bytes()).entries[0];
      const of500 = entry.captured.filter((row: { pid: number }) => row.pid === 500);
      expect(of500).toEqual([
        { pid: 500, pgid: -1, birth: T1 }, // recorded later, written first
        { pid: 500, pgid: 500, birth: T3 },
      ]);
      expect(entry.captured).toContainEqual({ pid: 600, pgid: -1, birth: T1 });
      // Every reader takes the new generation whole, by its own leader's birth.
      const now2: ProcessTableRow[] = [
        ...w.state.rows,
        { pid: 521, ppid: 520, pgid: 500, birth: T3 },
      ];
      expect(oldHostMembers(w.bytes(), now2)).toEqual([500, 520, 521, 800]);
      expect(engineMembers(w.path, now2)).toEqual([500, 520, 521, 800]);
      // The same holds were the new generation known by capture alone (no root row):
      // the file's own order of captured rows carries it.
      const captureOnly = JSON.parse(w.bytes());
      captureOnly.entries[0].root_groups = captureOnly.entries[0].root_groups.filter(
        (group: { pgid: number }) => group.pgid !== 500,
      );
      expect(oldHostMembers(JSON.stringify(captureOnly), now2)).toEqual([500, 520, 521, 800]);
    });
  });
});
