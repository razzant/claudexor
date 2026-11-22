/**
 * The one launch point of the processes a run starts (run-deadline/1, INV-144).
 *
 * The spawn environment decides membership: when it carries a Claudexor run
 * scope marker, the child enters that run's cgroup before exec (where the
 * daemon proved a cgroup boundary, `process-cgroup.ts`) and is registered under
 * the marker, so the run's stop, its scope settlement and its deadline's warden
 * all find it. Without a marker the launch is exactly a plain spawn.
 *
 * A bounded operation a run performs that cannot thread an env through every
 * launch of its own (an in-run delivery with its Git, gh and scanner children,
 * a thread turn's Git preflight) runs inside `withinRunScope(marker, ...)`:
 * every launch here inside it carries that marker too. Only
 * such operations open it; a run's harness and gate launches carry their
 * marker in their own env, and a launch handed to a longer-lived custodian
 * (its env stripped of run markers) is never made inside it.
 *
 * Everything a run executes launches through here or through `spawnProcess` /
 * `runCaptureRaw`, which use it; `run-spawn.test.ts` refuses a direct
 * `node:child_process` launch anywhere else except its listed, explained
 * exceptions (host measurement, the daemon's own processes, operator commands).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { enterScopeCgroup } from "./process-cgroup.js";
import { registerChildProcess, type LiveChildProcess } from "./process-registry.js";
import { SCOPE_MARKER_VALUE, runScopeMarkerOf, scopeMarkerEnv } from "./process-scope.js";

const bounded = new AsyncLocalStorage<string>();

/** Run `work` as part of the run whose scope marker is `marker` (see the module doc). */
export function withinRunScope<T>(marker: string | undefined, work: () => T): T {
  return marker ? bounded.run(marker, work) : work();
}

export interface RunOwnedSpawn<T extends ChildProcess> {
  child: T;
  /** The run scope marker the launch carries; undefined for an unscoped launch. */
  marker: string | undefined;
  /** The registry entry (null without `register`, or when the child has no pid). */
  registration: LiveChildProcess | null;
}

export interface RunOwnedSpawnOptions {
  /** Register the child in the process registry under this name (and its marker). */
  register?: string;
  /** Test seam: the underlying spawn (default `node:child_process` spawn). */
  spawnFn?: (binary: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
}

export function spawnRunOwned<T extends ChildProcess = ChildProcess>(
  binary: string,
  args: readonly string[],
  options: SpawnOptions & { env: NodeJS.ProcessEnv },
  run: RunOwnedSpawnOptions = {},
): RunOwnedSpawn<T> {
  // Inside a bounded run scope its marker is added (any other marker the env
  // carries, an enclosing host's included, is kept) and names the registration.
  const scoped = bounded.getStore();
  const env =
    scoped && options.env[scoped] !== SCOPE_MARKER_VALUE
      ? { ...options.env, ...scopeMarkerEnv(scoped) }
      : options.env;
  const marker = scoped ?? runScopeMarkerOf(env);
  const launch = enterScopeCgroup({ binary, args: [...args] }, env);
  const child = (run.spawnFn ?? spawn)(launch.binary, launch.args, { ...options, env }) as T;
  const registration =
    run.register !== undefined && typeof child.pid === "number"
      ? registerChildProcess(child.pid, run.register, marker)
      : null;
  return { child, marker, registration };
}
