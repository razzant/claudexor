/**
 * run-deadline/1: a warden after a normal terminal still has the run's
 * recorded process groups once the run-scope row left the index. Through the
 * real index: the custody settles the row and retires it, the retirement
 * observer hands the row to the deadline registry, which keeps it in the
 * run's record; the warden reads it there. A failed index read with no kept
 * copy gives marker-only coverage, which never releases early.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type {
  KnownProcessIdentity,
  ProcessIdentity,
  ScopeReapOptions,
  ScopeReapOutcome,
} from "@claudexor/core";
import { RunDeadlines, runWarden } from "@claudexor/daemon";
import { DaemonRunScopeIndex, RUN_SCOPE_INDEX_FILE } from "./run-scope-index.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0);
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "claudexor-retired-scope-"));
  dirs.push(dir);
  return dir;
};

const SEC = 1_000_000_000n;
/** The record as the warden reads it (state and the kept rows). */
const readRecord = (path: string) =>
  JSON.parse(readFileSync(path, "utf8")) as { state: string; scopes?: Array<{ marker: string }> };
const me: KnownProcessIdentity = {
  status: "known",
  pid: process.pid,
  platform: "linux",
  source: "procfs_stat",
  startToken: "linux:7",
  processGroupId: process.pid,
};

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

/** A finished run with a deadline: its row settled and retired from the real index. */
async function finishedRun(keepRetired: boolean) {
  const root = temp();
  const indexPath = join(root, RUN_SCOPE_INDEX_FILE);
  let host = 1_000n * SEC;
  const clock = {
    kind: "boottime" as const,
    bootId: () => "boot",
    hostNow: () => host,
    wallNow: () =>
      Date.parse("2026-11-22T12:00:00.000Z") + Number((host - 1_000n * SEC) / 1_000_000n),
  };
  const deadlines = new RunDeadlines({
    dir: join(root, "run-deadlines"),
    runScopesPath: indexPath,
    clock,
    spawnWarden: async () => ({ pid: 1 }),
    platform: "linux",
  });
  const index = new DaemonRunScopeIndex({
    path: indexPath,
    owner: async () => me,
    identity: {
      read: async (pid: number): Promise<ProcessIdentity> =>
        pid === me.pid ? me : { status: "missing", pid, platform: "linux" },
    },
    // The custody's own settlement: the run's group is proven gone.
    reap: async () => outcome(),
    table: { snapshot: async () => [], row: async () => null },
    roots: () => [],
  });
  if (keepRetired) index.onRetired((row) => deadlines.keepRetiredScope(row));
  await deadlines.stage("job", {
    own: deadlines.toPoint(new Date(clock.wallNow() + 60_000).toISOString()),
    successorOf: null,
    parentJobId: null,
  });
  deadlines.admit("job");
  const { marker } = await index.open("run-1");
  await deadlines.attachScope("job", marker);
  // The custody settles the run's row (recorded groups proven empty) and retires it.
  const row = index.list().find((entry) => entry.marker === marker)!;
  row.root_groups = [
    { pgid: 4242, leader_pid: 4242, leader_birth: "linux:9", leader_identity: undefined } as never,
  ];
  await index.settle("run-1", marker);
  expect(
    index.list().some((entry) => entry.marker === marker),
    "the row was retired",
  ).toBe(false);
  deadlines.close("job"); // the normal terminal
  await deadlines.dispose();
  return {
    root,
    recordPath: join(root, "run-deadlines", "job.json"),
    indexPath,
    marker,
    advance: (s: bigint) => (host += s * SEC),
  };
}

/** The warden over the finished run; a census that cannot read every same-user env. */
async function warden(recordPath: string) {
  const seen: ScopeReapOptions[] = [];
  let host = 1_000n * SEC;
  const reason = await runWarden(recordPath, {
    platform: "linux",
    now: () => (host += SEC),
    sleep: async () => {},
    cgroup: { populated: async () => false, kill: async () => true, remove: async () => {} },
    reap: async (opts) => {
      seen.push(opts);
      const recorded = (opts.captured?.length ?? 0) > 0 || (opts.rootGroups?.length ?? 0) > 0;
      return outcome({
        coverage: recorded ? "marker+capture" : "marker",
        completeness: "not_provable",
        completenessReason: "an unrelated same-user process environment is unreadable",
      });
    },
  });
  return { reason, seen };
}

describe("run-deadline/1: the warden after a normal terminal, through the real run-scope index", () => {
  it("reads the retired row the registry kept in the record and leaves at once", async () => {
    const run = await finishedRun(true);
    const record = readRecord(run.recordPath);
    expect(record.state).toBe("closed");
    expect(record.scopes?.map((s) => s.marker)).toEqual([run.marker]);
    const { reason, seen } = await warden(run.recordPath);
    expect(reason).toBe("released");
    expect(seen[0]!.rootGroups?.map((g) => g.pgid)).toEqual([4242]);
  });

  it("without the kept row (an unreadable index, nothing in the record) it never releases early", async () => {
    const run = await finishedRun(false);
    writeFileSync(run.indexPath, "{ torn");
    const record = readRecord(run.recordPath);
    expect(record.scopes ?? []).toEqual([]);
    const { reason, seen } = await warden(run.recordPath);
    // Marker-only coverage: it waits for the deadline and only then stops and leaves.
    expect(reason).toBe("unresolved");
    expect(seen[0]!.rootGroups ?? []).toEqual([]);
  });
});
