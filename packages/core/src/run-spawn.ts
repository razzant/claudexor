/**
 * The one launch point of the processes a run starts (run-deadline/1, INV-144).
 *
 * The spawn environment decides membership: when it carries a Claudexor run
 * scope marker, the child enters that run's cgroup before exec (where the
 * daemon proved a cgroup boundary, `process-cgroup.ts`) and is registered under
 * the marker, so the run's stop, its scope settlement and its deadline's warden
 * all find it. Without a marker the launch is exactly a plain spawn.
 *
 * A run's whole body runs inside `withinRunScope(marker, ...)` (the
 * orchestrator opens it with the run's scope, a thread turn's preparation with
 * its own): every launch made inside it carries that marker, whatever env the
 * call site built. A process several runs share (a single-flight vendor probe,
 * a status cache, a token refresh) is launched inside `sharedLaunch(name, ...)`
 * instead: it carries no run marker, because the first caller's run ending must
 * not end it for the others; its name is the explicit, reviewed exception.
 *
 * A spent scope launches nothing (run-deadline/1): once the daemon registers a
 * fence for a marker and that fence reports the deadline reached or claimed,
 * a launch carrying the marker is refused, so a warden that proved the scope
 * empty is never overtaken by a later launch of the same run.
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
import {
  SCOPE_MARKER_VALUE,
  runScopeMarkerOf,
  scopeMarkerEnv,
  withoutRunScopeMarkers,
} from "./process-scope.js";

type LaunchScope = { marker: string; shared?: undefined } | { marker?: undefined; shared: string };
const bounded = new AsyncLocalStorage<LaunchScope>();

/** Run `work` as part of the run whose scope marker is `marker` (see the module doc). */
export function withinRunScope<T>(marker: string | undefined, work: () => T): T {
  return marker ? bounded.run({ marker }, work) : work();
}

/**
 * Run `work` as the named shared launch: its processes carry no run marker
 * (an enclosing run's included) because several runs share them.
 */
export function sharedLaunch<T>(name: string, work: () => T): T {
  return bounded.run({ shared: name }, work);
}

/** Run `work` outside any run's launch scope (a job a daemon starts afresh). */
export function outsideRunScope<T>(work: () => T): T {
  return bounded.exit(work);
}

const fences = new Map<string, () => boolean>();

/** run-deadline/1: once `spent()` is true, no launch carrying `marker` is made. */
export function registerScopeFence(marker: string, spent: () => boolean): void {
  fences.set(marker, spent);
}

export function unregisterScopeFence(marker: string): void {
  fences.delete(marker);
}

/** The scope's deadline was reached or claimed: the launch is refused. */
export class RunScopeSpentError extends Error {
  readonly code = "run_scope_spent";
  constructor(readonly marker: string) {
    super("the run's deadline was reached: no further process is launched in its scope");
  }
}

/** Every launch through the run-owned point, for tests that prove scope membership. */
export interface RunOwnedLaunch {
  binary: string;
  args: readonly string[];
  marker: string | undefined;
  shared: string | undefined;
}
const launchObservers = new Set<(launch: RunOwnedLaunch) => void>();

/** Observe every run-owned launch (test seam); returns the unsubscribe. */
export function observeRunOwnedLaunches(observer: (launch: RunOwnedLaunch) => void): () => void {
  launchObservers.add(observer);
  return () => launchObservers.delete(observer);
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
  // A shared launch carries none.
  const store = bounded.getStore();
  const scoped = store?.marker;
  const env = store?.shared
    ? (withoutRunScopeMarkers(options.env) as NodeJS.ProcessEnv)
    : scoped && options.env[scoped] !== SCOPE_MARKER_VALUE
      ? { ...options.env, ...scopeMarkerEnv(scoped) }
      : options.env;
  const marker = scoped ?? runScopeMarkerOf(env);
  if (fences.size > 0)
    for (const [name, value] of Object.entries(env))
      if (value === SCOPE_MARKER_VALUE && fences.get(name)?.()) throw new RunScopeSpentError(name);
  for (const observer of launchObservers)
    observer({ binary, args, marker, shared: store?.shared });
  const launch = enterScopeCgroup({ binary, args: [...args] }, env);
  const child = (run.spawnFn ?? spawn)(launch.binary, launch.args, { ...options, env }) as T;
  const registration =
    run.register !== undefined && typeof child.pid === "number"
      ? registerChildProcess(child.pid, run.register, marker)
      : null;
  return { child, marker, registration };
}
