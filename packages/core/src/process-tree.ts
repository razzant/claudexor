/**
 * Whole-tree termination (QA-027). `spawnProcess` puts the direct harness child
 * in its OWN process group so a cancel/timeout can signal the group. But a
 * vendor tool can `setsid` into a NEW process group and, once its parent CLI
 * exits, reparent to pid 1 — so signalling only the direct group leaks that
 * escaped group (it kept a `/bin/sleep 60` orphan alive ~40s after a terminal
 * `cancelled`). Group kill of one PGID is NOT a process-tree boundary.
 *
 * This module snapshots the live process tree WHILE it is still intact
 * (descendants still chained by ppid to the root), captures an identity-proven
 * {@link ProcessGroupHandle} for every distinct descendant process group, then
 * reaps them all with the EXISTING recorded-orphan machinery — the same
 * `ProcessGroupService` (identity-verified `signal` + `probeEmpty`) the daemon
 * crash-GC reaper uses. No new raw killer: a recycled/stale pgid is never
 * signalled, and terminal is reported only after every owned group is proven
 * empty (fail-closed to `unconfirmed`, never a silent success).
 */
import { spawnSync } from "node:child_process";
import {
  defaultProcessGroupService,
  type ProcessGroupHandle,
  type ProcessGroupService,
} from "./process-group.js";
import {
  compareProcessIdentity,
  defaultProcessIdentityService,
  type KnownProcessIdentity,
  type ProcessIdentityReader,
} from "./process-identity.js";

export interface ProcessTreeNode {
  pid: number;
  ppid: number;
  pgid: number;
}

export interface ProcessTreeReader {
  /** All live processes as {pid,ppid,pgid}; [] when unreadable (fail-closed). */
  snapshot(): ProcessTreeNode[];
}

/**
 * Read the live process table via `ps` (POSIX, present on both darwin and
 * linux). C locale, bounded time/buffer, no shell. Any failure yields [] — the
 * caller then falls back to the direct-group signal it already sends, and a
 * genuinely alive-but-invisible group surfaces as `unconfirmed`.
 */
export function readProcessTable(
  run: (cmd: string, args: string[]) => { status: number | null; stdout: string } = (cmd, args) => {
    const r = spawnSync(cmd, args, {
      encoding: "utf8",
      timeout: 1_500,
      maxBuffer: 4 * 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    });
    return { status: r.status, stdout: r.stdout ?? "" };
  },
): ProcessTreeNode[] {
  let out: { status: number | null; stdout: string };
  try {
    out = run("ps", ["-A", "-o", "pid=,ppid=,pgid="]);
  } catch {
    return [];
  }
  if (out.status !== 0 || !out.stdout) return [];
  const nodes: ProcessTreeNode[] = [];
  for (const line of out.stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 3) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const pgid = Number(parts[2]);
    if (
      !Number.isSafeInteger(pid) ||
      !Number.isSafeInteger(ppid) ||
      !Number.isSafeInteger(pgid) ||
      pid <= 0
    ) {
      continue;
    }
    nodes.push({ pid, ppid, pgid });
  }
  return nodes;
}

export const defaultProcessTreeReader: ProcessTreeReader = {
  snapshot: () => readProcessTable(),
};

/**
 * Distinct process-group ids of `rootPid` and every transitive descendant, per
 * a tree snapshot. BFS over ppid so a grandchild that escaped into its own
 * pgid is still discovered — as long as the snapshot was taken before its
 * parent chain was torn down.
 */
export function descendantProcessGroupIds(rootPid: number, nodes: ProcessTreeNode[]): number[] {
  const childrenByPpid = new Map<number, ProcessTreeNode[]>();
  const self = new Map<number, ProcessTreeNode>();
  for (const node of nodes) {
    self.set(node.pid, node);
    const bucket = childrenByPpid.get(node.ppid);
    if (bucket) bucket.push(node);
    else childrenByPpid.set(node.ppid, [node]);
  }
  const pgids = new Set<number>();
  const seen = new Set<number>();
  const queue: number[] = [rootPid];
  const rootNode = self.get(rootPid);
  if (rootNode) pgids.add(rootNode.pgid);
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of childrenByPpid.get(pid) ?? []) {
      if (child.pid === pid) continue; // pid 1 is its own ppid on some tables
      pgids.add(child.pgid);
      queue.push(child.pid);
    }
  }
  return [...pgids];
}

export interface CapturedProcessGroups {
  handles: ProcessGroupHandle[];
  /** Live pgids whose leader identity could not be proven (fail-closed). */
  unresolved: Array<{ pgid: number; reason: string }>;
}

/**
 * Identity-proven handles for every process group in `rootPid`'s tree. A pgid
 * whose leader is gone/recycled/unreadable lands in `unresolved` — we never
 * signal an unproven group.
 */
export function captureProcessTreeGroups(
  rootPid: number,
  deps: {
    tree?: ProcessTreeReader;
    groups?: ProcessGroupService;
    probeGroupAlive?: (pgid: number) => boolean;
  } = {},
): CapturedProcessGroups {
  const tree = deps.tree ?? defaultProcessTreeReader;
  const groups = deps.groups ?? defaultProcessGroupService;
  const probeGroupAlive = deps.probeGroupAlive ?? defaultProbeGroupAlive;
  const handles: ProcessGroupHandle[] = [];
  const unresolved: Array<{ pgid: number; reason: string }> = [];
  for (const pgid of descendantProcessGroupIds(rootPid, tree.snapshot())) {
    const capture = groups.captureLeader(pgid);
    if (capture.status === "known") handles.push(capture.handle);
    else if (capture.status === "unknown") unresolved.push({ pgid, reason: capture.reason });
    else {
      // `missing` = the group LEADER exited between the ps snapshot and this
      // capture. That does NOT prove the group empty: a non-leader member can
      // still be alive under the leaderless pgid (round-2 #3). A raw signal-0
      // group probe is the honest liveness check — if the group is still alive we
      // record it as unresolved (we can never signal it without a proven leader,
      // but reapProcessTree must NOT report `confirmed` while it survives). ESRCH
      // (truly gone) is the only outcome that lets the pgid drop silently.
      if (probeGroupAlive(pgid)) {
        unresolved.push({ pgid, reason: "leader_exited_group_alive" });
      }
    }
  }
  return { handles, unresolved };
}

export type ProcessTreeTerminationOutcome =
  /** Every owned process group was proven empty (ESRCH). */
  | { state: "confirmed"; pgids: number[] }
  /**
   * At least one group was still alive (or unprovable) after the bounded
   * escalation ladder. `survivors` were proven-nonempty; `unresolved` could not
   * be identity-verified so were never signalled.
   */
  | {
      state: "unconfirmed";
      survivors: number[];
      unresolved: Array<{ pgid: number; reason: string }>;
    };

export interface ReapProcessTreeOptions {
  /** The direct child pid; its whole descendant tree is reaped. */
  rootPid: number;
  /**
   * The root's ORIGINAL identity, captured while it was provably alive (round-4
   * #2). The fixed-point rescan discovers descendants from the numeric `rootPid`;
   * if the child exits and its PID is reused mid-deadline, a rescan would capture
   * an UNRELATED replacement tree. Binding the root identity stops NEW-descendant
   * discovery the moment the root goes missing or its identity differs — already
   * captured groups keep being probed to death. Absent (legacy callers): numeric
   * behavior, no re-verification.
   */
  rootIdentity?: KnownProcessIdentity;
  /** Reads live process identity for the root re-verification (default real). */
  identity?: ProcessIdentityReader;
  /** Handles captured elsewhere (e.g. the direct child at spawn) to include. */
  seedHandles?: ProcessGroupHandle[];
  /** Cooperative signal first (default SIGTERM). */
  cooperativeSignal?: NodeJS.Signals;
  /** Grace before SIGKILL escalation (default 1000ms). */
  graceMs?: number;
  /** Overall bound before returning `unconfirmed` (default graceMs + 4000). */
  deadlineMs?: number;
  /** Probe/re-scan cadence (default 100ms). */
  probeIntervalMs?: number;
  groups?: ProcessGroupService;
  tree?: ProcessTreeReader;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Disclosed once per newly captured group (e.g. record for crash-GC). */
  onCapture?: (handle: ProcessGroupHandle) => void;
  /**
   * Raw liveness probe for a pgid whose leader identity could NOT be proven
   * (never a kill — signal 0 only). ESRCH -> gone (returns false); anything
   * else -> keep waiting (fail-closed true). Lets a group we cannot safely
   * signal still clear once it actually dies, instead of pinning the deadline.
   */
  probeGroupAlive?: (pgid: number) => boolean;
}

function defaultProbeGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

/**
 * Reap `rootPid`'s whole process tree and PROVE it dead. Cooperative signal ->
 * bounded grace -> SIGKILL, re-scanning for groups that fork/re-group during
 * the race (fixed point) until every group probes empty or the deadline lapses.
 *
 * The initial capture runs synchronously (before the first await) so callers
 * that invoke this the instant a cancel fires snapshot the tree while its ppid
 * chain is still intact.
 */
export async function reapProcessTree(
  opts: ReapProcessTreeOptions,
): Promise<ProcessTreeTerminationOutcome> {
  const groups = opts.groups ?? defaultProcessGroupService;
  const tree = opts.tree ?? defaultProcessTreeReader;
  const identity = opts.identity ?? defaultProcessIdentityService;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const coop = opts.cooperativeSignal ?? "SIGTERM";
  const graceMs = opts.graceMs ?? 1_000;
  const deadlineMs = opts.deadlineMs ?? graceMs + 4_000;
  const probeIntervalMs = Math.max(1, opts.probeIntervalMs ?? 100);
  const probeGroupAlive = opts.probeGroupAlive ?? defaultProbeGroupAlive;

  const start = now();
  const handles = new Map<number, ProcessGroupHandle>();
  const unresolved = new Map<number, string>();

  // Drop identity-unverified pgids that have actually exited (raw ESRCH probe).
  const pruneDeadUnresolved = (): void => {
    for (const pgid of [...unresolved.keys()]) {
      if (!handles.has(pgid) && !probeGroupAlive(pgid)) unresolved.delete(pgid);
    }
  };

  // Is the numeric rootPid still the SAME process we were asked to reap? Only a
  // proven `different`/`missing` blocks further descendant discovery (the PID was
  // reused or the root vanished); `same` and an unreadable `unknown` keep
  // discovering (best-effort — we can never prove reuse from an unreadable read,
  // and refusing on `unknown` would leak escaped descendants on hosts without a
  // usable identity source). With no `rootIdentity` supplied this is always true.
  const rootStillReapable = (): boolean => {
    if (!opts.rootIdentity) return true;
    const comparison = compareProcessIdentity(opts.rootIdentity, identity.read(opts.rootPid));
    return comparison !== "different" && comparison !== "missing";
  };

  const capture = (): void => {
    // Once the root is gone/reused, stop enumerating NEW descendants from its
    // (possibly recycled) PID; keep probing the groups captured while it was valid.
    if (!rootStillReapable()) return;
    const snap = captureProcessTreeGroups(opts.rootPid, { tree, groups, probeGroupAlive });
    for (const handle of snap.handles) {
      if (!handles.has(handle.pgid)) {
        handles.set(handle.pgid, handle);
        opts.onCapture?.(handle);
      }
      unresolved.delete(handle.pgid);
    }
    for (const item of snap.unresolved) {
      if (!handles.has(item.pgid)) unresolved.set(item.pgid, item.reason);
    }
  };

  // Snapshot WHILE the tree is alive, then seed any externally captured groups.
  capture();
  for (const handle of opts.seedHandles ?? []) {
    if (!handles.has(handle.pgid)) {
      handles.set(handle.pgid, handle);
      opts.onCapture?.(handle);
    }
  }

  const done = (): ProcessTreeTerminationOutcome => {
    // Re-probe every captured group so a group we signalled but never re-probed
    // is not falsely reported alive.
    for (const [pgid, handle] of [...handles]) {
      if (groups.probeEmpty(handle).status === "empty") handles.delete(pgid);
    }
    pruneDeadUnresolved();
    if (handles.size === 0 && unresolved.size === 0) {
      return { state: "confirmed", pgids: [] };
    }
    return {
      state: "unconfirmed",
      survivors: [...handles.keys()],
      unresolved: [...unresolved].map(([pgid, reason]) => ({ pgid, reason })),
    };
  };

  pruneDeadUnresolved();
  if (handles.size === 0 && unresolved.size === 0) return { state: "confirmed", pgids: [] };

  // Cooperative signal to every proven group.
  for (const handle of handles.values()) groups.signal(handle, coop);

  for (;;) {
    // Drop groups proven empty; only ESRCH proves a group gone.
    for (const [pgid, handle] of [...handles]) {
      if (groups.probeEmpty(handle).status === "empty") handles.delete(pgid);
    }
    // Fixed point: catch a descendant that forked/re-grouped during the race.
    capture();
    pruneDeadUnresolved();
    if (handles.size === 0 && unresolved.size === 0) return { state: "confirmed", pgids: [] };

    const elapsed = now() - start;
    if (elapsed >= deadlineMs) return done();

    // Past the grace window every surviving/newly-captured group gets SIGKILL,
    // each round (a group that fork/re-grouped after escalation still dies).
    if (elapsed >= graceMs) {
      for (const handle of handles.values()) groups.signal(handle, "SIGKILL");
    }
    await sleep(probeIntervalMs);
  }
}
