import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { reapRecordedOrphans, writePidsSnapshot } from "./orphan-reaper.js";

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
