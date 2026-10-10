import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProcessGroupService,
  defaultProcessGroupService,
  parseProcessGroupHandle,
  registerChildProcess,
  type KnownProcessIdentity,
  type ProcessGroupHandle,
  unregisterChildProcess,
} from "@claudexor/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PidsSnapshotWriter, reapRecordedOrphans, writePidsSnapshot } from "./orphan-reaper.js";

function known(pid: number, startToken: string): KnownProcessIdentity {
  return {
    status: "known",
    pid,
    platform: "linux",
    source: "procfs_stat",
    startToken,
    processGroupId: pid,
  };
}

function handle(pid: number, startToken: string): ProcessGroupHandle {
  return parseProcessGroupHandle({ schemaVersion: 1, pgid: pid, leader: known(pid, startToken) });
}

function processGroups(startToken: string, signalProcessGroup = vi.fn()): ProcessGroupService {
  return new ProcessGroupService({
    platform: "linux",
    identity: {
      read: (pid) => known(pid, startToken),
      self: () => known(1, "linux:1"),
    },
    signalProcessGroup,
  });
}

describe("orphan reaper", () => {
  let dir: string;
  afterEach(() => {
    unregisterChildProcess(43);
    if (dir) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("signals only an exact persisted process-group identity", () => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), "claudexor-reaper-"));
    const pidsPath = join(dir, "pids.json");
    const signal = vi.fn();
    try {
      writeFileSync(
        pidsPath,
        JSON.stringify({
          pids: [{ pid: 41, cmd: "sleep", processGroup: handle(41, "linux:100") }],
        }),
      );
      const actions = reapRecordedOrphans(pidsPath, processGroups("linux:100", signal));
      expect(actions).toContain("SIGTERM orphan process group 41 (sleep)");
      expect(signal).toHaveBeenCalledWith(-41, "SIGTERM");
      vi.advanceTimersByTime(3_000);
      expect(signal).toHaveBeenLastCalledWith(-41, "SIGKILL");
      expect(existsSync(pidsPath)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is not a quiescence proof: it returns before the recorded group is confirmed gone", () => {
    // Pinned so no caller treats a restart terminal as "the harness stopped".
    // A group that ignores SIGTERM is still alive when the reaper returns, its
    // record is already deleted, and SIGKILL is only scheduled; a child absent
    // from the last periodic snapshot is never signalled at all. A crash-
    // interrupted run therefore keeps the typed `host_restart` disposition
    // (unknown custody), never a confirmed stop.
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), "claudexor-reaper-"));
    const pidsPath = join(dir, "pids.json");
    const signal = vi.fn();
    try {
      writeFileSync(
        pidsPath,
        JSON.stringify({
          pids: [{ pid: 51, cmd: "harness", processGroup: handle(51, "linux:9") }],
        }),
      );
      const groups = new ProcessGroupService({
        platform: "linux",
        identity: { read: (pid) => known(pid, "linux:9"), self: () => known(1, "linux:1") },
        signalProcessGroup: signal,
        probeProcessGroup: () => undefined, // the group survives TERM
      });
      expect(reapRecordedOrphans(pidsPath, groups)).toEqual([
        "SIGTERM orphan process group 51 (harness)",
      ]);
      expect(existsSync(pidsPath)).toBe(false);
      expect(signal.mock.calls).toEqual([[-51, "SIGTERM"]]);
      expect(groups.probeEmpty(handle(51, "linux:9")).status).toBe("nonempty");
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips same-pid reuse and legacy pid/cmd snapshots fail-closed", () => {
    dir = mkdtempSync(join(tmpdir(), "claudexor-reaper-"));
    const pidsPath = join(dir, "pids.json");
    const signal = vi.fn();
    writeFileSync(
      pidsPath,
      JSON.stringify({
        pids: [
          { pid: 41, cmd: "sleep", processGroup: handle(41, "linux:100") },
          { pid: 42, cmd: "sleep" },
        ],
      }),
    );
    const actions = reapRecordedOrphans(pidsPath, processGroups("linux:200", signal));
    expect(actions).toContain("skip orphan process group 41 (sleep): stale_leader");
    expect(signal).not.toHaveBeenCalled();
    expect(existsSync(pidsPath)).toBe(false);
  });

  it("writePidsSnapshot writes live children and clears the file when none remain", () => {
    dir = mkdtempSync(join(tmpdir(), "claudexor-reaper-"));
    const pidsPath = join(dir, "pids.json");
    const exact = handle(43, "linux:300");
    vi.spyOn(defaultProcessGroupService, "captureLeader")
      .mockReturnValueOnce({ status: "known", handle: exact })
      .mockReturnValueOnce({ status: "unknown", pid: 44, reason: "helper_unavailable" });
    registerChildProcess(43, "exact-child");
    registerChildProcess(44, "unknown-child");
    writePidsSnapshot(pidsPath);
    expect(JSON.parse(readFileSync(pidsPath, "utf8"))).toEqual({
      pids: [{ pid: 43, cmd: "exact-child", processGroup: exact }],
    });
    unregisterChildProcess(43);
    writePidsSnapshot(pidsPath);
    expect(existsSync(pidsPath)).toBe(false);
  });

  it("tolerates a corrupt pids file", () => {
    dir = mkdtempSync(join(tmpdir(), "claudexor-reaper-"));
    const pidsPath = join(dir, "pids.json");
    writeFileSync(pidsPath, "{ nope");
    expect(reapRecordedOrphans(pidsPath)).toEqual([]);
    // Corrupt file stays for manual inspection (no destructive cleanup).
    expect(readFileSync(pidsPath, "utf8")).toContain("nope");
  });
});

describe("periodic pids.json writer", () => {
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-pids-writer-"));
    let children: unknown[] = [];
    const writer = new PidsSnapshotWriter(join(dir, "pids.json"), () => children);
    return {
      dir,
      path: join(dir, "pids.json"),
      writer,
      set: (next: unknown[]) => {
        children = next;
      },
    };
  }

  it("writes off the calling turn and only when the set of children changed", async () => {
    const f = fixture();
    f.set([{ pid: 101, cmd: "harness-a" }]);
    const write = f.writer.refresh();
    // Asynchronous: nothing is on disk until the write settles.
    expect(existsSync(f.path)).toBe(false);
    await write;
    expect(JSON.parse(readFileSync(f.path, "utf8"))).toEqual({
      pids: [{ pid: 101, cmd: "harness-a" }],
    });
    // Unchanged set: no file I/O at all, so a removed file stays removed.
    rmSync(f.path);
    await f.writer.refresh();
    expect(existsSync(f.path)).toBe(false);
    // A changed set is written; an emptied set removes the file.
    f.set([
      { pid: 101, cmd: "harness-a" },
      { pid: 202, cmd: "harness-b" },
    ]);
    await f.writer.refresh();
    expect(JSON.parse(readFileSync(f.path, "utf8")).pids).toHaveLength(2);
    f.set([]);
    await f.writer.refresh();
    expect(existsSync(f.path)).toBe(false);
    rmSync(f.dir, { recursive: true, force: true });
  });

  it("keeps one write in flight and retries a failed write on the next check", async () => {
    const f = fixture();
    f.set([{ pid: 303, cmd: "harness-c" }]);
    const first = f.writer.refresh();
    expect(f.writer.refresh()).toBe(first);
    await f.writer.settled();
    expect(existsSync(f.path)).toBe(true);
    // A failed write is not remembered as written: with the directory gone
    // the write fails, and the same set is written once it can be.
    rmSync(f.dir, { recursive: true, force: true });
    f.set([{ pid: 404, cmd: "harness-d" }]);
    await f.writer.refresh();
    expect(existsSync(f.path)).toBe(false);
    mkdirSync(f.dir);
    await f.writer.refresh();
    expect(JSON.parse(readFileSync(f.path, "utf8")).pids).toEqual([{ pid: 404, cmd: "harness-d" }]);
    rmSync(f.dir, { recursive: true, force: true });
  });
});
