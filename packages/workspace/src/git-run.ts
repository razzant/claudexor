import { existsSync } from "node:fs";
import {
  assertCaptureComplete,
  captureTerminationOf,
  parseUnifiedDiff,
  runCaptureRaw,
  scopeMarkerEnv,
  WorkspaceError,
  type CaptureTermination,
} from "@claudexor/core";

/** A private operation decides from the bytes, whatever the user's configuration
 * says: `core.ignoreStat` would mark every entry Git adds assume-valid, so a
 * refresh and `diff-files` skip its content, and a filesystem monitor answers
 * from its own last observation instead of looking. */
export const STAT_TRUST_OFF = ["-c", "core.ignoreStat=false", "-c", "core.fsmonitor=false"];

/** A scratch index is always written whole: never as a split index (whose
 * shared part lives in the user's Git directory) and never sparse. It trusts no
 * stat shortcut, and an index copied from the user's carries over neither its
 * monitor state nor its untracked cache (both are dropped as it is read). */
export const SCRATCH_INDEX_CONFIG = [
  "-c",
  "core.splitIndex=false",
  "-c",
  "index.sparse=false",
  ...STAT_TRUST_OFF,
  "-c",
  "core.untrackedCache=false",
];

/** A stop whose end was not proven: the direct Git or a descendant may still run. */
export type UnconfirmedTermination = Extract<CaptureTermination, { status: "unconfirmed" }>;

/**
 * A preparation step stopped because its caller's signal was aborted (Stop or a
 * deadline). It is the outcome of that signal, never a Git failure. Whether what
 * the stopped Git started has ended is a separate fact: {@link PreparationCancelled}
 * when it was proven (or no child was running), {@link PreparationTerminationUnconfirmed}
 * when it was not. Accounting and stop detection look at this base class; cleanup
 * looks at the termination fact ({@link unconfirmedTerminationOf}).
 */
export class PreparationStopped extends WorkspaceError {
  constructor(
    readonly reason: unknown,
    message = `preparation stopped: ${typeof reason === "string" ? reason : "cancelled"}`,
  ) {
    super(message);
    this.name = "PreparationStopped";
  }
}

/** Stopped, and nothing the stopped step started is known to survive. */
export class PreparationCancelled extends PreparationStopped {
  constructor(reason: unknown) {
    super(reason);
    this.name = "PreparationCancelled";
  }
}

/** Stopped, but the end of the stopped Git (or of what it started) was not proven:
 * its resources are held, never removed or reused, until a read proves it. */
export class PreparationTerminationUnconfirmed extends PreparationStopped {
  constructor(
    reason: unknown,
    readonly termination: UnconfirmedTermination,
  ) {
    super(
      reason,
      `preparation stopped without confirmed termination (${termination.reason}): ${
        typeof reason === "string" ? reason : "cancelled"
      }`,
    );
    this.name = "PreparationTerminationUnconfirmed";
  }
}

/** The unconfirmed stop an error carries, whatever wrapped it: a stopped step, a
 * watchdog or timeout `GitOperationError`, a partial initialization or a failed
 * capture. Undefined when the end was proven or nothing was stopped. */
export function unconfirmedTerminationOf(error: unknown): UnconfirmedTermination | undefined {
  if (!error || typeof error !== "object") return undefined;
  const carried =
    (error as { termination?: CaptureTermination }).termination ?? captureTerminationOf(error);
  return carried?.status === "unconfirmed" ? carried : undefined;
}

/**
 * Remove a private resource that only the direct Git of a step writes (a scratch
 * index, a staging directory): at once, or, when a stop left that Git itself
 * running, once its exit is observed in this daemon. A descendant that outlived
 * an exited Git does not write there. If the daemon ends first, the leftover is
 * the same private litter a daemon crash mid-step leaves today.
 */
export function removeAfterDirectGit(error: unknown, remove: () => void): void {
  const unconfirmed = unconfirmedTerminationOf(error);
  if (unconfirmed && !unconfirmed.directExited) {
    // Nobody awaits the deferred removal: its fault cannot surface as a rejection.
    const later = (): void => {
      try {
        remove();
      } catch {
        /* the same private leftover a crash mid-step leaves */
      }
    };
    void unconfirmed.directExit.then(later, () => {});
    return;
  }
  remove();
}

/** What a run's stop left unconfirmed in its preparation, for the run's terminal:
 * each unconfirmed step's termination and the resources held after it. */
interface PreparationStops {
  unconfirmed: UnconfirmedTermination[];
  held: string[];
}

/** The process scope a preparation's Git children belong to rides the same
 * parameter as its stop: a signal derived for it carries the scope marker, and
 * every Git step given that signal starts with the marker in its environment. */
const scopeMarkers = new WeakMap<
  AbortSignal,
  {
    marker: string;
    afterSettled?: (release: () => Promise<void>) => void;
    stops: PreparationStops;
  }
>();

/** A stop for preparation steps whose Git children join the scope `marker`;
 * `afterSettled` lets a preparation hand its owner a release to run once that
 * scope settled (the run's barrier). Unconfirmed stops it records go to the
 * signal it was derived from only when that one carries the same scope. */
export function withScopeMarker(
  signal: AbortSignal | undefined,
  marker: string,
  afterSettled?: (release: () => Promise<void>) => void,
): AbortSignal {
  const scoped = signal ? AbortSignal.any([signal]) : new AbortController().signal;
  const parent = signal ? scopeMarkers.get(signal) : undefined;
  const stops = parent?.marker === marker ? parent.stops : { unconfirmed: [], held: [] };
  scopeMarkers.set(scoped, { marker, ...(afterSettled ? { afterSettled } : {}), stops });
  return scoped;
}

/** The scope marker a preparation stop carries, if any. */
export function scopeMarkerOf(signal: AbortSignal | undefined): string | undefined {
  return signal ? scopeMarkers.get(signal)?.marker : undefined;
}

/** Ask the scope's owner to run `release` once the scope settled; false when it has
 * none. `held` names the resource kept until then (disclosed on the run's terminal). */
export function afterScopeSettled(
  signal: AbortSignal | undefined,
  release: () => Promise<void>,
  held?: string,
): boolean {
  const entry = signal ? scopeMarkers.get(signal) : undefined;
  if (held) entry?.stops.held.push(held);
  entry?.afterSettled?.(release);
  return entry?.afterSettled !== undefined;
}

/**
 * An unconfirmed stop disclosed in the shape a harness's terminal uses
 * (`survivors`: process groups proven alive; `unresolved`: groups whose end could
 * not be read, each with why), plus the preparation's own `reason`. One shape for
 * every `termination_unconfirmed` a preparation discloses: a stopped attempt's
 * completion, the run's cancelled terminal, a thread turn's refusal.
 */
export interface TerminationDisclosure {
  survivors: number[];
  unresolved: Array<{ pgid: number; reason: string }>;
  reason: string;
}

/** Shared event presentation for preparation stop facts. Even a terminal's
 * held list is a dated observation, never a fresh resource inventory. An empty
 * list does not turn an unconfirmed stop into proof of a retained base. */
export function preparationStopSummary(payload: Record<string, unknown>): string | null {
  const value = payload["termination_unconfirmed"];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const stop = value as Record<string, unknown>;
  if (
    typeof stop["reason"] !== "string" ||
    !Array.isArray(stop["survivors"]) ||
    !Array.isArray(stop["unresolved"])
  )
    return null;
  const held = Array.isArray(payload["held"])
    ? payload["held"].filter((path): path is string => typeof path === "string" && path.length > 0)
    : [];
  return (
    `Termination unconfirmed at this event (${stop["reason"]}). ` +
    (held.length
      ? `Held paths at this event: ${held.map((path) => JSON.stringify(path)).join(", ")}. `
      : "No held paths reported in this event. ") +
    "Inspect current state with `claudexor gc preparations`. If release is needed, first verify the processes and their children ended, then use `claudexor gc release-preparation <selector> --digest <digest> --confirm-ended` from that inspection."
  );
}

export function terminationDisclosure(termination: {
  reason: string;
  groups: readonly number[];
}): TerminationDisclosure {
  const alive = termination.reason === "group_alive" || termination.reason === "direct_child_alive";
  return {
    survivors: alive ? [...termination.groups] : [],
    unresolved: alive
      ? []
      : termination.groups.map((pgid) => ({ pgid, reason: termination.reason })),
    reason: termination.reason,
  };
}

/** For the run's terminal: every unconfirmed preparation stop under its stop, merged
 * into one disclosure, and the held resources still on disk; empty when none. */
export function preparationStopsOf(signal: AbortSignal | undefined): {
  termination_unconfirmed?: TerminationDisclosure;
  held?: string[];
} {
  const stops = signal ? scopeMarkers.get(signal)?.stops : undefined;
  if (!stops || stops.unconfirmed.length === 0) return {};
  const each = stops.unconfirmed.map(terminationDisclosure);
  return {
    termination_unconfirmed: {
      survivors: [...new Set(each.flatMap((item) => item.survivors))],
      unresolved: each.flatMap((item) => item.unresolved),
      reason: [...new Set(each.map((item) => item.reason))].join(", "),
    },
    held: [...new Set(stops.held)].filter((path) => existsSync(path)),
  };
}

/** The arguments of a Git step given `signal`: one that joins a preparation scope
 * never starts the user's fsmonitor daemon (`STAT_TRUST_OFF`), which would carry
 * the scope's marker and be ended with it; the user's configuration is unchanged. */
export function scopedGitArgs(signal: AbortSignal | undefined, args: string[]): string[] {
  return scopeMarkerOf(signal) ? [...STAT_TRUST_OFF, ...args] : args;
}

/** The environment entry that places a Git child in its preparation's scope. */
export function scopeEnvOf(signal: AbortSignal | undefined): Record<string, string> {
  const marker = scopeMarkerOf(signal);
  return marker ? scopeMarkerEnv(marker) : {};
}

/**
 * The stop handed to a Git step that takes the USER'S own locks (a worktree
 * registration, the first initialization with its baseline commit, the user's
 * index). On Windows such a step is not interrupted (a killed one leaves
 * `index.lock` or a locked registration behind): it runs to its end in the same
 * scope and the stop is taken at the step's boundary by the caller. A hung step
 * there waits for the stall watchdog — a disclosed platform limit. Steps on
 * private state (a scratch `GIT_INDEX_FILE`) are interrupted as on POSIX.
 */
export function userLockStep(
  signal: AbortSignal | undefined,
  platform: NodeJS.Platform = process.platform,
): AbortSignal | undefined {
  if (platform !== "win32" || !signal) return signal;
  // Not interrupted, but still in the same scope: its marker, its stops and the
  // owner's release travel with it (the same record, not a copy).
  const entry = scopeMarkers.get(signal);
  if (!entry) return undefined;
  const uninterrupted = new AbortController().signal;
  scopeMarkers.set(uninterrupted, entry);
  return uninterrupted;
}

/** Stop before the next preparation step once `signal` is aborted. */
export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new PreparationCancelled(signal.reason);
}

/** Keep an unproven capture end on its preparation carrier, even without a caller
 * abort (a watchdog or time bound). Only the caller's abort is a preparation stop. */
export function stoppedAfter(
  signal: AbortSignal | undefined,
  termination: CaptureTermination | undefined,
): void {
  if (signal && termination?.status === "unconfirmed")
    scopeMarkers.get(signal)?.stops.unconfirmed.push(termination);
  if (!signal?.aborted) return;
  if (termination?.status === "unconfirmed") {
    throw new PreparationTerminationUnconfirmed(signal.reason, termination);
  }
  throw new PreparationCancelled(signal.reason);
}

/** BYTE-FAITHFUL git capture: raw buffers, never readline — CR
 * bytes in CRLF diff content survive, and no trailing newline is fabricated
 * (trim-based consumers like revParse are unaffected: git ends its own
 * output with \n). `signal` stops the child with the ordinary escalation and
 * throws a {@link PreparationStopped} instead of its result. */
export async function git(
  repo: string,
  args: string[],
  input?: string,
  signal?: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return gitEnv(repo, args, {}, input, signal);
}

export async function revParse(repo: string, ref: string, signal?: AbortSignal): Promise<string> {
  const r = await git(repo, ["rev-parse", ref], undefined, signal);
  if (r.code !== 0) throw new WorkspaceError(`git rev-parse ${ref} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** A status read takes no optional lock (no index refresh written back), so it
 * can be interrupted on every platform. Only a successful read can establish
 * a clean tree; failed/unknown exits may also have empty stdout. */
export async function statusPorcelain(repo: string, signal?: AbortSignal): Promise<string> {
  const r = await gitEnv(
    repo,
    ["status", "--porcelain"],
    { GIT_OPTIONAL_LOCKS: "0" },
    undefined,
    signal,
  );
  if (r.code !== 0) throw new WorkspaceError(`git status failed: ${r.stderr.trim()}`);
  return r.stdout;
}

/** `git` with extra environment (e.g. a scratch GIT_INDEX_FILE for snapshots). */
export async function gitEnv(
  repo: string,
  args: string[],
  env: Record<string, string>,
  input?: string,
  signal?: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  throwIfCancelled(signal);
  let r: Awaited<ReturnType<typeof runCaptureRaw>>;
  try {
    r = await runCaptureRaw("git", ["-C", repo, ...scopedGitArgs(signal, args)], {
      timeoutMs: 60_000,
      env: { ...scopeEnvOf(signal), ...env },
      input,
      windowsConsole: "none",
      ...(signal ? { abortSignal: signal } : {}),
    });
  } catch (error) {
    stoppedAfter(signal, captureTerminationOf(error));
    throw error;
  }
  stoppedAfter(signal, r.termination);
  // The 60 s bound stopped it and its end was not proven: never read the cut
  // capture as a result, and keep the fact for the caller's cleanup.
  if (r.termination?.status === "unconfirmed") {
    throw Object.assign(
      new WorkspaceError(
        `git ${args[0] ?? ""} was stopped at its time bound; its end is unconfirmed`,
      ),
      { termination: r.termination },
    );
  }
  assertCaptureComplete(r);
  return r;
}

/** Capture-time honesty: with --binary a payload-less "Binary files differ"
 * stub should be impossible; if one appears anyway, fail AT CAPTURE with a
 * typed error instead of shipping a patch that cannot apply. */
export function assertNoBinaryStubs(diff: string, label: string): void {
  const stubs = parseUnifiedDiff(diff).files.filter((f) => f.binaryStub);
  if (stubs.length > 0) {
    const names = stubs.map((f) => f.newPath ?? f.oldPath ?? "(unknown)").join(", ");
    throw new WorkspaceError(
      `${label} produced undeliverable binary stub(s) for: ${names}; the work product cannot be applied`,
    );
  }
}
