import type { ChildProcess } from "node:child_process";
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
  ProcessGroupService,
  defaultProcessGroupService,
  type ProcessGroupHandle,
} from "./process-group.js";
import {
  ProcessIdentityService,
  compareProcessIdentity,
  defaultProcessIdentityService,
  executeWin32ProcessTimes,
  type KnownProcessIdentity,
  type ProcessIdentityReader,
} from "./process-identity.js";

/**
 * Process-group service for a lane that must supervise its child on Windows
 * too — today the interactive native-login runner and the daemon that watches
 * it. Off win32 this is the ordinary service. On win32 it opts into the two
 * Windows seams: the kernel birth-time identity reader (so a recycled pid is
 * never mistaken for the recorded process) and this module's `taskkill /T /F`
 * as the terminator. Every other consumer keeps the fail-closed default, where
 * win32 identity stays unprovable and no group signal is ever sent.
 */
export function processGroupServiceWithWindowsSupport(
  platform: NodeJS.Platform = process.platform,
): ProcessGroupService {
  if (platform !== "win32") return new ProcessGroupService({ platform });
  return new ProcessGroupService({
    platform,
    identity: new ProcessIdentityService({ platform, runWin32Reader: executeWin32ProcessTimes }),
    killProcessTree: (pid) => killWindowsProcessTree(pid).status,
  });
}

export interface ProcessTreeNode {
  pid: number;
  ppid: number;
  pgid: number;
}

/**
 * Which whole-tree termination mechanism this host offers. POSIX hosts get the
 * identity-proven process-group ladder above; win32 has no process groups, no
 * `ps`, and no ESRCH group probe — its honest minimal tree kill is
 * `taskkill /PID <pid> /T /F` (Job Objects would need a native addon, declined
 * by owner proportionality). The strategy is decided ONCE here so callers
 * dispatch on a named mechanism, not on a platform string.
 */
export type KillTreeStrategy = "posix_process_group" | "windows_taskkill";

export function resolveKillTreeStrategy(platform: string = process.platform): KillTreeStrategy {
  return platform === "win32" ? "windows_taskkill" : "posix_process_group";
}

/**
 * Typed D21 disclosure reason: Windows offers no process-group emptiness probe,
 * so a tree kill there can never PROVE whole-tree death (taskkill enumerates
 * the parent-child snapshot at kill time; a descendant whose intermediate
 * parent already exited is unreachable). The reap reports `unconfirmed` with
 * this reason instead of overclaiming `confirmed`.
 */
export const WINDOWS_TREE_DEATH_PROOF_UNAVAILABLE = "windows_no_process_group_death_proof";

export type WindowsKillTreeResult =
  | { status: "killed"; pid: number }
  | { status: "not_found"; pid: number }
  | { status: "failed"; pid: number; detail: string };

/**
 * `taskkill /PID <pid> /T /F` via an absolute System32 path (mirrors the pinned
 * `PATH` used for `ps` above — a poisoned PATH must not pick the killer).
 * `taskkill /T` reports one aggregate exit while members of the tree can exit
 * during its walk, so a non-zero exit cannot prove the root was absent before
 * the command. Root liveness owns that distinction; whole-tree death remains
 * separately unprovable on Windows and is disclosed by the reap owner below.
 */
export function killWindowsProcessTree(
  pid: number,
  run: (
    cmd: string,
    args: string[],
  ) => { status: number | null; stdout: string; stderr: string } = (cmd, args) => {
    const r = spawnSync(cmd, args, {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  },
  probeAlive: (pid: number) => boolean = defaultProbePidAlive,
): WindowsKillTreeResult {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { status: "failed", pid, detail: "invalid pid" };
  }
  if (!probeAlive(pid)) return { status: "not_found", pid };
  const systemRoot = process.env["SystemRoot"] || "C:\\Windows";
  const taskkill = `${systemRoot}\\System32\\taskkill.exe`;
  let out: { status: number | null; stdout: string; stderr: string };
  try {
    out = run(taskkill, ["/PID", String(pid), "/T", "/F"]);
  } catch (error) {
    return {
      status: "failed",
      pid,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (out.status === 0) return { status: "killed", pid };
  // A non-zero aggregate result can mean one enumerated member disappeared
  // while /T was terminating the tree. If the pre-call-live root is now gone,
  // the root operation succeeded; descendants remain covered by D21's typed
  // no-whole-tree-proof disclosure rather than inferred from this exit code.
  if (!probeAlive(pid)) return { status: "killed", pid };
  return {
    status: "failed",
    pid,
    detail: `taskkill exited ${out.status}: ${(out.stderr || out.stdout).trim().slice(0, 200)}`,
  };
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
  /** Platform whose kill-tree strategy applies (default the live host). */
  platform?: string;
  /** Injection seam for the win32 tree killer (deterministic tests). */
  windowsKillTree?: (pid: number) => WindowsKillTreeResult;
  /** Raw single-PID liveness probe for the win32 path (signal 0 only). */
  probePidAlive?: (pid: number) => boolean;
}

function defaultProbeGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

function defaultProbePidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

/**
 * The win32 leg of {@link reapProcessTree}: one forced tree kill, then a
 * bounded liveness poll on the ROOT pid (the only identity Windows lets us
 * probe without a native addon).
 *
 * Fail-closed honesty (QA-027/D21): even a fully successful taskkill cannot
 * prove the WHOLE tree dead — Windows has no process-group ESRCH probe and no
 * rescan path to orphaned grandchildren — so the best possible outcome is
 * `unconfirmed` carrying the typed {@link WINDOWS_TREE_DEATH_PROOF_UNAVAILABLE}
 * reason. That surfaces as a disclosure on the run, never a refusal (the kill
 * itself is real), and never a silent `confirmed` the platform cannot back.
 *
 * PID-reuse: the kill is issued only while the root still PROBES alive; the
 * probe→kill window is the residual risk Windows leaves without Job Objects
 * (declined: native addon). The root pid is not re-killed once it probes dead.
 */
async function reapProcessTreeWindows(
  opts: ReapProcessTreeOptions,
): Promise<ProcessTreeTerminationOutcome> {
  const kill = opts.windowsKillTree ?? killWindowsProcessTree;
  const probeAlive = opts.probePidAlive ?? defaultProbePidAlive;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const graceMs = opts.graceMs ?? 1_000;
  const deadlineMs = opts.deadlineMs ?? graceMs + 4_000;
  const probeIntervalMs = Math.max(1, opts.probeIntervalMs ?? 100);
  const disclosure: ProcessTreeTerminationOutcome = {
    state: "unconfirmed",
    survivors: [],
    unresolved: [{ pgid: opts.rootPid, reason: WINDOWS_TREE_DEATH_PROOF_UNAVAILABLE }],
  };
  if (!probeAlive(opts.rootPid)) return disclosure;
  const killed = kill(opts.rootPid);
  const start = now();
  while (probeAlive(opts.rootPid)) {
    if (killed.status === "failed" || now() - start >= deadlineMs) {
      // The root itself is proven alive: report it as a survivor, not merely
      // an unprovable tree.
      return { state: "unconfirmed", survivors: [opts.rootPid], unresolved: [] };
    }
    await sleep(probeIntervalMs);
  }
  return disclosure;
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
  if (resolveKillTreeStrategy(opts.platform ?? process.platform) === "windows_taskkill") {
    // No `ps`, no pgids, no group ESRCH probe on win32 — the POSIX ladder
    // below would capture nothing and falsely report `confirmed`. The kill is
    // issued synchronously before the first await, like the POSIX capture.
    return reapProcessTreeWindows(opts);
  }
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

/** Stop a directly owned child before its wrapper can orphan the vendor payload.
 * The ChildProcess handle pins ownership until exit; preserve Windows' existing
 * weaker whole-tree proof and return a failed taskkill to callers needing it. */
export function killOwnedProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
  platform: NodeJS.Platform = process.platform,
  killTree: typeof killWindowsProcessTree = killWindowsProcessTree,
): WindowsKillTreeResult | null {
  if (child.exitCode != null || child.signalCode != null) return null;
  if (platform === "win32" && child.pid) {
    const result = killTree(child.pid);
    if (result.status !== "failed") return result;
    child.kill(signal);
    return result;
  }
  child.kill(signal);
  return null;
}
