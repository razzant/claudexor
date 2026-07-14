/**
 * Orphaned-child bookkeeping for the daemon. Harness children run in
 * their OWN process groups (deliberate: group kill), so they survive a daemon
 * crash/SIGKILL and keep mutating trees with nobody watching. The daemon
 * periodically snapshots exact kernel process-group handles to a pids file;
 * on the next start, only the same leader birth identity may be signalled.
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import {
  defaultProcessGroupService,
  liveChildProcesses,
  parseProcessGroupHandle,
  type ProcessGroupHandle,
  type ProcessGroupService,
} from "@claudexor/core";

interface RecordedChild {
  pid: number;
  cmd: string;
  processGroup: ProcessGroupHandle;
}

export function writePidsSnapshot(path: string): void {
  try {
    const pids = liveChildProcesses();
    if (pids.length === 0) {
      rmSync(path, { force: true });
      return;
    }
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ pids }, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    /* best-effort bookkeeping; never fail a run over it */
  }
}

/**
 * Kill process groups recorded by a PREVIOUS daemon life. Legacy pid/cmd-only
 * entries and stale/unknown identities are skipped fail-closed.
 */
export function reapRecordedOrphans(
  path: string,
  processGroups: ProcessGroupService = defaultProcessGroupService,
): string[] {
  let recorded: RecordedChild[] = [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { pids?: unknown };
    if (Array.isArray(raw.pids)) {
      recorded = raw.pids.flatMap((value): RecordedChild[] => {
        if (!value || typeof value !== "object") return [];
        const candidate = value as Partial<RecordedChild>;
        if (!Number.isSafeInteger(candidate.pid) || typeof candidate.cmd !== "string") return [];
        try {
          const processGroup = parseProcessGroupHandle(candidate.processGroup);
          return processGroup.pgid === candidate.pid
            ? [{ pid: candidate.pid as number, cmd: candidate.cmd, processGroup }]
            : [];
        } catch {
          return [];
        }
      });
    }
  } catch {
    return [];
  }
  const actions: string[] = [];
  for (const child of recorded) {
    const term = processGroups.signal(child.processGroup, "SIGTERM");
    if (term.status !== "sent") {
      if (term.status === "unknown") {
        actions.push(`skip orphan process group ${child.pid} (${child.cmd}): ${term.reason}`);
      }
      continue;
    }
    actions.push(`SIGTERM orphan process group ${child.pid} (${child.cmd})`);
    setTimeout(() => processGroups.signal(child.processGroup, "SIGKILL"), 3_000).unref?.();
  }
  rmSync(path, { force: true });
  return actions;
}
