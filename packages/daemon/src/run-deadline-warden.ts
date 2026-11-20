/**
 * The run-deadline warden (run-deadline/1, invariant 4): one small detached
 * process per deadline-bearing run that ends the run at its deadline whether or
 * not the daemon is alive.
 *
 * Why a separate process: a daemon that is SIGKILLed or hangs cannot end
 * anything, and harness children live in their own process groups and sessions
 * by design, so they outlive it. Cleanup at the NEXT daemon start is not
 * enforcement. The warden starts before the run's first process (the thread
 * worktree preparation included), in its own session, without any run marker,
 * and only reads files: its own state file, which the daemon replaces
 * atomically, the state file of the Delegate parent it inherits a deadline
 * from, and the run-scope index (`daemon/run-scopes.json`).
 *
 * What it ends at the deadline, by measured identity only:
 * - the run's cgroup, whole, through `cgroup.kill` when the daemon proved a
 *   delegated cgroup v2 boundary (`run-deadline-cgroup.ts`);
 * - every process carrying one of the run's scope markers (preparation and run);
 * - the process groups and descendants the daemon recorded for those markers in
 *   the run-scope index while the run was live (also members whose environment
 *   no longer shows the marker).
 * It repeats until the group is confirmed empty (an empty cgroup, or a complete
 * marker census), its state file is removed, or, where no census can prove
 * emptiness (macOS), three consecutive passes found nothing.
 *
 * When the daemon ended the run itself it marks the state `released`; the
 * warden leaves at once only if the group is then confirmed empty, otherwise it
 * stays to the deadline.
 *
 * Time: the target is a reading of the host clock (`run-deadline-clock.ts`) the
 * daemon converted the absolute deadline to once; a wall-clock step never moves
 * it, and on Linux the clock counts suspend.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { open as openFile, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readRunScopeEntries,
  reapScopeMembers,
  reapSources,
  withoutRunScopeMarkers,
  type ScopeReapOptions,
  type ScopeReapOutcome,
} from "@claudexor/core";
import { clockOfKind, type HostClockKind } from "./run-deadline-clock.js";
import { cgroupMembers, killCgroup, removeRunCgroup } from "./run-deadline-cgroup.js";

/** The daemon's own timer gets this head start before the warden acts, so a
 * live daemon ends the run through the ordinary cancel path first. */
export const WARDEN_HEAD_START_MS = 1_000;
/** Warden poll cadence of its state file. */
export const WARDEN_POLL_MS = 200;
/**
 * The declared stop grace: head start (1 s) + one poll (0.2 s) + the first
 * enforcement pass (cgroup.kill at once; a bounded marker reap of at most 5 s),
 * with later passes as margin, inside the contract's 30 s ceiling.
 */
export const RUN_DEADLINE_STOP_GRACE_SEC = 15;
/** Passes that found nothing before a warden without a provable census leaves. */
const UNPROVABLE_SETTLED_PASSES = 3;

export interface DeadlinePointState {
  at: string;
  /** Host clock reading of `at`, decimal nanoseconds. */
  targetNs: string;
}

export interface WardenState {
  version: 2;
  jobId: string;
  clock: HostClockKind;
  bootId: string | null;
  /** The run's own deadline (its current revision); null when only inherited. */
  own: DeadlinePointState | null;
  revision: number;
  /** State file name of the Delegate parent whose CURRENT deadline also caps this run. */
  parent: string | null;
  /** The parent's effective deadline when this file was written: used only if the
   * parent's file can no longer be read (it can only make the stop earlier). */
  inherited: (DeadlinePointState & { from: string }) | null;
  /** Fixed when the run reached a terminal (its effective deadline then). */
  frozen: (DeadlinePointState & { inheritedFrom: string | null }) | null;
  markers: string[];
  cgroup: string | null;
  runScopes: string | null;
  /** The daemon ended the run itself: leave once the group is confirmed empty. */
  released: boolean;
}

export interface WardenOutcome {
  reason: "reaped" | "released" | "removed" | "unprovable_settled";
  at: string;
  settled: boolean;
  ended: number;
  survivors: number;
  completeness: ScopeReapOutcome["completeness"];
  completenessReason: string | null;
}

export const wardenOutcomePath = (statePath: string) => `${statePath}.outcome.json`;
export const wardenReadyPath = (statePath: string) => `${statePath}.ready`;
export const wardenDonePath = (statePath: string) => `${statePath}.done`;

/** Atomic replace (tmp + fsync + rename), synchronous: the warden's own records. */
export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

let tmpSequence = 0;
/** The same, off the main thread's blocking path: the daemon's writes. */
export async function writeJsonAtomicAsync(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${(tmpSequence += 1)}.tmp`;
  const handle = await openFile(tmp, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
}

export function parseWardenState(text: string): WardenState | "unreadable" {
  try {
    const value = JSON.parse(text) as WardenState;
    if (value?.version !== 2 || !Array.isArray(value.markers)) return "unreadable";
    for (const point of [value.own, value.frozen, value.inherited])
      if (point) BigInt(point.targetNs);
    return value;
  } catch {
    return "unreadable";
  }
}

export function readWardenState(path: string): WardenState | null | "unreadable" {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? null : "unreadable";
  }
  return parseWardenState(text);
}

export function readWardenOutcome(statePath: string): WardenOutcome | null {
  try {
    return JSON.parse(readFileSync(wardenOutcomePath(statePath), "utf8")) as WardenOutcome;
  } catch {
    return null;
  }
}

export function removeWardenFiles(statePath: string): void {
  for (const path of [
    statePath,
    wardenOutcomePath(statePath),
    wardenReadyPath(statePath),
    wardenDonePath(statePath),
  ])
    rmSync(path, { force: true });
}

const MAX_CHAIN = 8;

/**
 * The effective target of a state: its frozen value, else the earlier of its own
 * deadline and the parent's current effective one (read from the parent's file,
 * or the cached `inherited` value when that file is gone).
 */
export function effectiveTarget(
  state: WardenState,
  dir: string,
  read: (path: string) => WardenState | null | "unreadable" = readWardenState,
  depth = 0,
): bigint | null {
  if (state.frozen) return BigInt(state.frozen.targetNs);
  let best = state.own ? BigInt(state.own.targetNs) : null;
  let parentTarget: bigint | null = null;
  if (state.parent && depth < MAX_CHAIN) {
    const parent = read(join(dir, state.parent));
    if (parent && parent !== "unreadable") parentTarget = effectiveTarget(parent, dir, read, depth + 1);
  }
  if (parentTarget === null && state.inherited) parentTarget = BigInt(state.inherited.targetNs);
  if (parentTarget !== null && (best === null || parentTarget < best)) best = parentTarget;
  return best;
}

/** The engine's alternate entry role that runs a warden inside the engine bundle. */
export const WARDEN_ENTRY_ROLE = "--run-deadline-warden";
/** The small dedicated warden bundle shipped beside the engine bundle. */
export const WARDEN_BUNDLE = "run-deadline-warden.cjs";
const ENGINE_BUNDLE = "claudexord.bundle.cjs";
const WARDEN_READY_TIMEOUT_MS = 10_000;

/**
 * argv of the warden for this build. An installed package runs the sibling
 * entry (TS under tsx in a source checkout); the engine bundle runs the small
 * `run-deadline-warden.cjs` beside it, or itself in its warden role when that
 * file is absent. Anything else has no warden: the run is refused.
 */
export function wardenCommand(
  moduleUrl: string = import.meta.url,
  exists: (path: string) => boolean = existsSync,
): { command: string; args: string[]; cwd: string } {
  const self = fileURLToPath(moduleUrl);
  const unbundled = /run-deadline-warden\.(ts|js)$/.exec(self);
  if (unbundled) {
    const entry = self.replace(/run-deadline-warden\.(ts|js)$/, `run-deadline-warden-main.$1`);
    return {
      command: process.execPath,
      args: unbundled[1] === "ts" ? ["--import", "tsx", entry] : [entry],
      cwd: dirname(entry),
    };
  }
  if (basename(self) === ENGINE_BUNDLE) {
    const small = join(dirname(self), WARDEN_BUNDLE);
    return exists(small)
      ? { command: process.execPath, args: [small], cwd: dirname(self) }
      : { command: process.execPath, args: [self, WARDEN_ENTRY_ROLE], cwd: dirname(self) };
  }
  throw Object.assign(new Error(`no run-deadline warden entry for ${basename(self)}`), {
    code: "run_deadline_warden_unavailable",
    status: 503,
    retryable: false,
  });
}

/**
 * Start the warden for `statePath` and resolve once it reported itself running
 * (its ready file), so an exited or foreign entry never passes for enforcement.
 * Detached: its own session and process group, outside every run cgroup, so
 * neither a signal to the daemon's group, the daemon's death nor the run's own
 * cgroup.kill reaches it. Its environment drops every Claudexor run marker, so
 * it is never a member of the scope it ends.
 */
export async function spawnWarden(statePath: string): Promise<{ pid: number }> {
  const { command, args, cwd } = wardenCommand();
  rmSync(wardenReadyPath(statePath), { force: true });
  const child = spawn(command, [...args, statePath], {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: withoutRunScopeMarkers({ ...process.env }) as NodeJS.ProcessEnv,
  });
  let exited = false;
  child.once("exit", () => (exited = true));
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", () => resolve());
  });
  const end = Date.now() + WARDEN_READY_TIMEOUT_MS;
  while (!existsSync(wardenReadyPath(statePath))) {
    if (exited || Date.now() > end) {
      if (!exited) child.kill("SIGKILL");
      throw Object.assign(new Error("the run-deadline warden did not start"), {
        code: "run_deadline_warden_unavailable",
        status: 503,
        retryable: true,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.unref();
  return { pid: child.pid! };
}

export interface WardenLoopDeps {
  now?: (kind: HostClockKind) => bigint;
  sleep?: (ms: number) => Promise<void>;
  reap?: (opts: ScopeReapOptions) => Promise<ScopeReapOutcome>;
  pollMs?: number;
  headStartMs?: number;
  platform?: NodeJS.Platform;
  cgroup?: {
    members(dir: string): Promise<number[] | null>;
    kill(dir: string): Promise<boolean>;
    remove(dir: string): Promise<void>;
  };
}

/** A non-signalling reap: any member it would signal makes the group "not empty". */
const PROBE = Object.assign(new Error("probe"), { code: "EPROBE" });

interface Pass {
  settled: boolean;
  confirmed: boolean;
  outcomes: ScopeReapOutcome[];
}

/**
 * The warden's whole life (see the module doc). Returns why it left.
 */
export async function runWarden(
  statePath: string,
  deps: WardenLoopDeps = {},
): Promise<WardenOutcome["reason"]> {
  const now = deps.now ?? ((kind: HostClockKind) => clockOfKind(kind)());
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const reap = deps.reap ?? reapScopeMembers;
  const platform = deps.platform ?? process.platform;
  const cgroups = deps.cgroup ?? {
    members: cgroupMembers,
    kill: killCgroup,
    remove: removeRunCgroup,
  };
  const headStartNs = BigInt(Math.round((deps.headStartMs ?? WARDEN_HEAD_START_MS) * 1e6));
  const dir = dirname(statePath);
  const finish = (reason: WardenOutcome["reason"], pass?: Pass): WardenOutcome["reason"] => {
    const outcomes = pass?.outcomes ?? [];
    try {
      if (pass)
        writeJsonAtomic(wardenOutcomePath(statePath), {
          reason,
          at: new Date().toISOString(),
          settled: pass.settled,
          ended: outcomes.reduce((sum, o) => sum + o.ended.length, 0),
          survivors: outcomes.reduce((sum, o) => sum + o.survivors.length, 0),
          completeness: pass.confirmed ? "complete" : "not_provable",
          completenessReason: outcomes.find((o) => o.completenessReason)?.completenessReason ?? null,
        } satisfies WardenOutcome);
      if (existsSync(dir)) writeJsonAtomic(wardenDonePath(statePath), { reason, pid: process.pid });
    } catch {
      /* evidence only: the stop already happened */
    }
    return reason;
  };
  try {
    writeJsonAtomic(wardenReadyPath(statePath), { pid: process.pid });
  } catch {
    return "removed"; // no directory any more: nothing to guard
  }

  const sources = (state: WardenState, marker: string): Partial<ScopeReapOptions> => {
    const entry = state.runScopes
      ? readRunScopeEntries(state.runScopes)?.find((row) => row.marker === marker)
      : undefined;
    if (!entry) return {};
    const recorded = reapSources(entry);
    // The census age filter is measured on the wall clock (macOS only); never
    // let a clock step hide a member there.
    return platform === "linux" ? recorded : { ...recorded, scopeStartAt: null };
  };
  /** One pass over every boundary source; `probe` signals nothing. */
  const pass = async (state: WardenState, probe: boolean): Promise<Pass> => {
    const outcomes: ScopeReapOutcome[] = [];
    let cgroupEmpty = true;
    if (state.cgroup) {
      if (!probe) await cgroups.kill(state.cgroup);
      const members = await cgroups.members(state.cgroup);
      cgroupEmpty = members !== null && members.length === 0;
    }
    for (const marker of state.markers) {
      outcomes.push(
        await reap({
          scopeStartAt: null,
          ...sources(state, marker),
          marker,
          ...(probe
            ? {
                signal: () => {
                  throw PROBE;
                },
              }
            : {}),
        }),
      );
    }
    if (state.cgroup && !probe && !cgroupEmpty) {
      const members = await cgroups.members(state.cgroup);
      cgroupEmpty = members !== null && members.length === 0;
    }
    const settled = cgroupEmpty && outcomes.every((o) => o.settled);
    const confirmed = settled && outcomes.every((o) => o.completeness === "complete");
    return { settled, confirmed, outcomes };
  };

  let last: WardenState | null = null;
  let releasedProbeAt = 0n;
  let releasedBackoffMs = 1_000;
  for (;;) {
    const read = readWardenState(statePath);
    if (read === null) return finish("removed");
    if (read !== "unreadable") last = read;
    if (last) {
      const target = effectiveTarget(last, dir);
      const clockNow = now(last.clock);
      if (target !== null && clockNow >= target + headStartNs) break;
      if (last.released && clockNow >= releasedProbeAt) {
        const probe = await pass(last, true);
        if (probe.confirmed) return finish("released", probe);
        releasedProbeAt = now(last.clock) + BigInt(releasedBackoffMs) * 1_000_000n;
        releasedBackoffMs = Math.min(releasedBackoffMs * 2, 30_000);
      }
    }
    await sleep(deps.pollMs ?? WARDEN_POLL_MS);
  }

  // Enforcement: repeat until the group is confirmed empty or the file is removed.
  let settledPasses = 0;
  let backoffMs = 500;
  for (;;) {
    const read = readWardenState(statePath);
    if (read === null) return finish("removed");
    if (read !== "unreadable") last = read;
    const result = await pass(last!, false);
    if (result.confirmed) {
      if (last!.cgroup) await cgroups.remove(last!.cgroup);
      return finish("reaped", result);
    }
    settledPasses = result.settled ? settledPasses + 1 : 0;
    if (settledPasses >= UNPROVABLE_SETTLED_PASSES) return finish("unprovable_settled", result);
    await sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 2, 10_000);
  }
}
