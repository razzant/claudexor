/**
 * The run-deadline warden (run-deadline/1, invariant 4): one small detached
 * process per deadline-bearing run that ends the run's scope at the deadline
 * whether or not the daemon is alive.
 *
 * Why a separate process: a daemon that is SIGKILLed or hangs cannot end
 * anything, and harness children live in their own process groups and sessions
 * by design, so they outlive it. Cleanup at the NEXT daemon start is not
 * enforcement. The warden is started before the run's first launch, in its own
 * session, without the run's scope marker, and it only ever reads one state
 * file the daemon rewrites atomically.
 *
 * Time: the daemon converts the absolute deadline once to the host's
 * monotonic clock (`process.hrtime`, system-wide: CLOCK_MONOTONIC on Linux,
 * the Mach clock on macOS) and writes that target. The warden compares its own
 * monotonic reading against it, so a wall-clock step never moves the stop.
 *
 * Ending: the existing scope reaper (`reapScopeMembers`) — marker census by
 * measured identity, TERM, a bounded grace, KILL, bounded rescans for forks.
 * It signals only processes that carry the run's marker and whose birth it
 * measured; never pid 1, never itself.
 */
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  reapScopeMembers,
  withoutRunScopeMarkers,
  type ScopeReapOptions,
  type ScopeReapOutcome,
} from "@claudexor/core";

/** The daemon's own timer gets this head start before the warden acts, so a
 * live daemon ends the run through the ordinary cancel path first. */
export const WARDEN_HEAD_START_MS = 1_000;
/** Warden poll cadence of its state file. */
export const WARDEN_POLL_MS = 200;
/** Reap attempts at the deadline; each is bounded by `scopeReapDeadlineMs`. */
export const WARDEN_REAP_ATTEMPTS = 2;
/**
 * The declared stop grace. Worst case from the deadline: head start (1s) + one
 * poll (0.2s) + two bounded reaps (2 x 5s) = 11.2s; 15s leaves margin for a
 * loaded host while staying well inside the contract's 30s ceiling.
 */
export const RUN_DEADLINE_STOP_GRACE_SEC = 15;

export interface WardenState {
  version: 1;
  jobId: string;
  /** The run's scope marker NAME; null until the run opened its scope. */
  marker: string | null;
  /** Effective deadline, wall-clock ISO (informational for readers). */
  at: string;
  /** Effective deadline on the host monotonic clock, decimal nanoseconds. */
  monoTargetNs: string;
  revision: number;
  /** The daemon settled the run itself; the warden may exit. */
  closed: boolean;
}

export interface WardenOutcome {
  reapedAt: string;
  settled: boolean;
  ended: number;
  survivors: number;
  completeness: ScopeReapOutcome["completeness"];
  completenessReason: string | null;
}

export function wardenOutcomePath(statePath: string): string {
  return `${statePath}.outcome.json`;
}

/** Atomic replace (tmp + fsync + rename) so a reader never sees a torn file. */
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

export function readWardenState(path: string): WardenState | null | "unreadable" {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as WardenState;
    if (value?.version !== 1 || typeof value.monoTargetNs !== "string") return "unreadable";
    BigInt(value.monoTargetNs);
    return value;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? null : "unreadable";
  }
}

export function readWardenOutcome(statePath: string): WardenOutcome | null {
  try {
    return JSON.parse(readFileSync(wardenOutcomePath(statePath), "utf8")) as WardenOutcome;
  } catch {
    return null;
  }
}

export function removeWardenFiles(statePath: string): void {
  rmSync(statePath, { force: true });
  rmSync(wardenOutcomePath(statePath), { force: true });
  rmSync(wardenReadyPath(statePath), { force: true });
}

/** The engine's alternate entry role that runs a warden (`claudexord.bundle.cjs`). */
export const WARDEN_ENTRY_ROLE = "--run-deadline-warden";
const ENGINE_BUNDLE = "claudexord.bundle.cjs";
const WARDEN_READY_TIMEOUT_MS = 10_000;

export function wardenReadyPath(statePath: string): string {
  return `${statePath}.ready`;
}

/**
 * argv of the warden for this build. An installed package runs the small
 * sibling entry (TS under tsx in a source checkout); the single-file engine
 * bundle runs itself in its warden role. Anything else has no warden: the
 * caller refuses the run rather than launch it unenforced.
 */
export function wardenCommand(moduleUrl: string = import.meta.url): {
  command: string;
  args: string[];
  cwd: string;
} {
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
  if (basename(self) === ENGINE_BUNDLE)
    return { command: process.execPath, args: [self, WARDEN_ENTRY_ROLE], cwd: dirname(self) };
  throw Object.assign(new Error(`no run-deadline warden entry for ${basename(self)}`), {
    code: "run_deadline_warden_unavailable",
    status: 503,
    retryable: false,
  });
}

/**
 * Start the warden for `statePath` and resolve once it reported itself
 * running (its ready file), so an exited or foreign entry never passes for
 * enforcement. Detached: its own session and process group, so neither a
 * signal to the daemon's group nor the daemon's death reaches it. Its
 * environment drops every Claudexor run marker, so it is never a member of
 * the scope it ends.
 */
export async function spawnWarden(statePath: string): Promise<{ pid: number }> {
  const { command, args, cwd } = wardenCommand();
  rmSync(wardenReadyPath(statePath), { force: true });
  const child = spawn(command, [...args, statePath], {
    cwd,
    detached: true,
    stdio: "ignore",
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
  monoNow?: () => bigint;
  sleep?: (ms: number) => Promise<void>;
  reap?: (opts: ScopeReapOptions) => Promise<ScopeReapOutcome>;
  pollMs?: number;
  headStartMs?: number;
}

/**
 * The warden's whole life: poll the state file; exit when the daemon closed or
 * removed it; at target + head start end the scope, record the outcome, exit.
 * A transiently unreadable file keeps the last good state (never "no deadline").
 */
export async function runWarden(
  statePath: string,
  deps: WardenLoopDeps = {},
): Promise<"closed" | "removed" | "reaped" | "no_scope"> {
  const monoNow = deps.monoNow ?? (() => process.hrtime.bigint());
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const reap = deps.reap ?? reapScopeMembers;
  const headStartNs = BigInt(Math.round((deps.headStartMs ?? WARDEN_HEAD_START_MS) * 1e6));
  let last: WardenState | null = null;
  try {
    writeJsonAtomic(wardenReadyPath(statePath), { pid: process.pid });
  } catch {
    return "removed"; // no directory any more: nothing to guard
  }
  for (;;) {
    const read = readWardenState(statePath);
    if (read === null) return "removed";
    if (read !== "unreadable") last = read;
    if (last?.closed) return "closed";
    if (last && monoNow() >= BigInt(last.monoTargetNs) + headStartNs) {
      if (!last.marker) return "no_scope";
      let outcome: ScopeReapOutcome | null = null;
      for (let attempt = 0; attempt < WARDEN_REAP_ATTEMPTS; attempt += 1) {
        // A full census, never an age-filtered one: the age filter is measured on
        // the wall clock, and a backward step must not hide a member.
        outcome = await reap({ marker: last.marker, scopeStartAt: null });
        if (outcome.settled) break;
      }
      try {
        writeJsonAtomic(wardenOutcomePath(statePath), {
          reapedAt: new Date().toISOString(),
          settled: outcome?.settled ?? false,
          ended: outcome?.ended.length ?? 0,
          survivors: outcome?.survivors.length ?? 0,
          completeness: outcome?.completeness ?? "not_provable",
          completenessReason: outcome?.completenessReason ?? null,
        } satisfies WardenOutcome);
      } catch {
        /* the outcome file is evidence only; the stop already happened */
      }
      return "reaped";
    }
    await sleep(deps.pollMs ?? WARDEN_POLL_MS);
  }
}
