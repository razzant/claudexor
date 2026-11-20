/**
 * Scheduler-owned registry of server-enforced run deadlines (run-deadline/1).
 *
 * - A deadline is accepted as an absolute wall-clock instant and converted ONCE
 *   to the monotonic clock at that moment; every timer and the warden compare
 *   monotonic readings, so a wall-clock step never moves a stop.
 * - It holds from acceptance: queued, preparing and running.
 * - A Delegate child's effective deadline is the earlier of its own and its
 *   parent's CURRENT effective deadline; changing the parent re-arms the child.
 * - Before the run's first launch the runner hands its scope marker here; the
 *   registry writes the warden state file and starts the warden
 *   (`run-deadline-warden.ts`), which ends the scope at the deadline even if
 *   the daemon is gone. Every change rewrites the file atomically.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  RUN_DEADLINE_CAPABILITY,
  type ControlCapability,
  RunDeadlineSetRequest,
  RunDeadlineStart,
  type RunDeadlineSnapshot,
  type RunDeadlineState,
} from "@claudexor/schema";
import {
  RUN_DEADLINE_STOP_GRACE_SEC,
  readWardenOutcome,
  readWardenState,
  removeWardenFiles,
  spawnWarden,
  writeJsonAtomic,
  type WardenState,
} from "./run-deadline-warden.js";

/**
 * The capabilities this host proves. run-deadline/1 is declared only on Linux:
 * there the warden's marker census reads every same-uid process environment
 * (`/proc/<pid>/environ`), so a reap that settles is complete. On macOS SIP
 * hides the environment of Apple platform binaries, so a system binary started
 * in the background by a shell that already exited cannot be ruled out
 * (`DARWIN_COMPLETENESS_LIMIT`); Windows has no environment census. The warden
 * still runs there, but the stop invariant is not proven, so it is not declared.
 */
export function runDeadlineCapabilities(
  platform: string = process.platform,
  stopGraceSec: number = RUN_DEADLINE_STOP_GRACE_SEC,
): ControlCapability[] {
  return platform === "linux" ? [{ name: RUN_DEADLINE_CAPABILITY, stopGraceSec }] : [];
}

export interface RunDeadlineClock {
  /** Wall clock, ms since the epoch (injectable: a test steps it backwards). */
  wallNow(): number;
  /** Host monotonic clock, ns. Must be the same clock the warden reads. */
  monoNow(): bigint;
}

export const systemDeadlineClock: RunDeadlineClock = {
  wallNow: () => Date.now(),
  monoNow: () => process.hrtime.bigint(),
};

export function deadlineProblem(
  message: string,
  code: string,
  status = 409,
  retryable = false,
): Error & { code: string; status: number; retryable: boolean } {
  return Object.assign(new Error(message), { code, status, retryable });
}

interface Point {
  at: string;
  mono: bigint;
}

interface Entry {
  jobId: string;
  own: Point | null;
  revision: number;
  parentJobId: string | null;
  children: Set<string>;
  state: RunDeadlineState;
  timer?: ReturnType<typeof setTimeout>;
  statePath?: string;
  marker?: string;
}

export interface RunDeadlinesOptions {
  /** Directory of warden state files; absent disables the warden (in-process timers only). */
  dir?: string;
  clock?: RunDeadlineClock;
  stopGraceSec?: number;
  spawnWarden?: (statePath: string) => Promise<{ pid: number }>;
  /** The effective deadline passed: the scheduler ends the job (queued or running). */
  onExpire?: (jobId: string) => void;
}

/** Parse an optional `deadline` from a run request; undefined when absent. */
export function requestedDeadline(params: unknown): RunDeadlineStart | undefined {
  if (!params || typeof params !== "object") return undefined;
  const raw = (params as { deadline?: unknown }).deadline;
  return raw === undefined ? undefined : RunDeadlineStart.parse(raw);
}

export class RunDeadlines {
  private readonly entries = new Map<string, Entry>();
  private readonly clock: RunDeadlineClock;
  readonly stopGraceSec: number;

  constructor(private readonly opts: RunDeadlinesOptions) {
    this.clock = opts.clock ?? systemDeadlineClock;
    this.stopGraceSec = opts.stopGraceSec ?? RUN_DEADLINE_STOP_GRACE_SEC;
    if (opts.dir) mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  }

  has(jobId: string): boolean {
    return this.entries.has(jobId);
  }

  /** Convert an absolute instant now; refuse one that is not in the future. */
  private point(at: string): Point {
    const wall = Date.parse(at);
    const now = this.clock.wallNow();
    if (!Number.isFinite(wall))
      throw deadlineProblem("deadline.at is not a valid instant", "run_deadline_invalid", 400);
    if (wall <= now)
      throw deadlineProblem(
        `deadline.at ${at} is not after the server time ${new Date(now).toISOString()}`,
        "run_deadline_passed",
      );
    return {
      at: new Date(wall).toISOString(),
      mono: this.clock.monoNow() + BigInt(wall - now) * 1_000_000n,
    };
  }

  /** The refusal a start must answer before anything is accepted; null when fine. */
  assertStartable(params: unknown): void {
    const requested = requestedDeadline(params);
    if (requested) this.point(requested.at);
  }

  /**
   * Register an accepted job. `own` comes from its request; `parentJobId` names
   * a Delegate parent that has a deadline (its effective deadline then caps the
   * child). Nothing is registered when neither exists.
   */
  admit(jobId: string, params: unknown, parentJobId: string | null): void {
    if (this.entries.has(jobId)) return;
    const requested = requestedDeadline(params);
    const parent = parentJobId ? this.entries.get(parentJobId) : undefined;
    if (!requested && !parent) return;
    const entry: Entry = {
      jobId,
      own: requested ? this.point(requested.at) : null,
      revision: 0,
      parentJobId: parent ? parentJobId : null,
      children: new Set(),
      state: "armed",
    };
    this.entries.set(jobId, entry);
    parent?.children.add(jobId);
    this.arm(entry);
  }

  /** The effective deadline: the earlier of the own one and every ancestor's. */
  private effective(entry: Entry): { point: Point; from: string | null } {
    let best: { point: Point; from: string | null } | null = entry.own
      ? { point: entry.own, from: null }
      : null;
    let parentId = entry.parentJobId;
    const seen = new Set([entry.jobId]);
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = this.entries.get(parentId);
      if (!parent) break;
      if (parent.own && (!best || parent.own.mono < best.point.mono))
        best = { point: parent.own, from: parentId };
      parentId = parent.parentJobId;
    }
    if (!best) throw new Error(`run deadline for ${entry.jobId} has no source`);
    return best;
  }

  snapshot(jobId: string): RunDeadlineSnapshot | null {
    const entry = this.entries.get(jobId);
    if (!entry) return null;
    const { point, from } = this.effective(entry);
    return {
      at: point.at,
      revision: entry.revision,
      serverNow: new Date(this.clock.wallNow()).toISOString(),
      state: entry.state,
      stopGraceSec: this.stopGraceSec,
      inheritedFrom: from,
    };
  }

  /**
   * A durable read for a job this daemon no longer holds in memory (a previous
   * generation's run): its warden state file, if one was written.
   */
  durableSnapshot(jobId: string): RunDeadlineSnapshot | null {
    if (!this.opts.dir) return null;
    const path = this.statePath(jobId);
    const state = readWardenState(path);
    if (!state || state === "unreadable") return null;
    return {
      at: state.at,
      revision: state.revision,
      serverNow: new Date(this.clock.wallNow()).toISOString(),
      // A previous generation's run that the daemon did not close keeps its
      // warden; once the deadline passed, that warden is what ended it.
      state:
        !state.closed &&
        (readWardenOutcome(path) !== null || this.clock.monoNow() >= BigInt(state.monoTargetNs))
          ? "expired"
          : "closed",
      stopGraceSec: this.stopGraceSec,
      inheritedFrom: null,
    };
  }

  /** Replace the job's own deadline. `live` is false for a terminal job. */
  set(
    jobId: string,
    raw: unknown,
    opts: { live: boolean; delegated: boolean },
  ): RunDeadlineSnapshot {
    const request = RunDeadlineSetRequest.parse(raw);
    const entry = this.entries.get(jobId);
    if (!opts.live || !entry || entry.state !== "armed")
      throw deadlineProblem("Run is terminal; its deadline is closed", "run_deadline_closed");
    if (opts.delegated)
      throw deadlineProblem(
        "A Delegate child's deadline follows its parent; change the parent",
        "delegated_deadline_forbidden",
        403,
      );
    if (request.expectedRevision !== entry.revision)
      throw deadlineProblem(
        `Deadline revision changed (expected ${request.expectedRevision}, current ${entry.revision}); read before retrying`,
        "run_deadline_revision_conflict",
      );
    entry.own = this.point(request.at);
    entry.revision += 1;
    this.rearmTree(entry);
    return this.snapshot(jobId)!;
  }

  /**
   * Before the run's first launch: record the scope and start the warden.
   * Throws when the warden cannot be started — the run must not launch
   * without the enforcement it promised.
   */
  async attachScope(jobId: string, marker: string): Promise<void> {
    const entry = this.entries.get(jobId);
    if (!entry || !this.opts.dir) return;
    if (entry.state !== "armed")
      throw deadlineProblem("Run deadline already passed", "run_deadline_expired");
    entry.marker = marker;
    entry.statePath = this.statePath(jobId);
    this.writeState(entry);
    await (this.opts.spawnWarden ?? spawnWarden)(entry.statePath);
  }

  /**
   * The job reached a terminal other than its deadline: stop the timer and
   * release the warden (the run's own barrier already ended its scope). An
   * expired job keeps its warden: it still ends whatever the cancel left.
   */
  close(jobId: string): void {
    const entry = this.entries.get(jobId);
    if (!entry || entry.state !== "armed") return;
    entry.state = "closed";
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    if (entry.statePath) {
      try {
        this.writeState(entry, true);
      } catch {
        /* a warden that cannot read `closed` still ends an already-ended scope */
      }
    }
  }

  /** Retention: forget a pruned job and its files. */
  forget(jobId: string): void {
    const entry = this.entries.get(jobId);
    if (entry?.timer) clearTimeout(entry.timer);
    if (entry?.parentJobId) this.entries.get(entry.parentJobId)?.children.delete(jobId);
    this.entries.delete(jobId);
    if (!this.opts.dir) return;
    // Never pull the file from under a warden that may still have to act: only
    // a closed scope or one the warden already reaped is released.
    const path = this.statePath(jobId);
    const state = readWardenState(path);
    if (state && state !== "unreadable" && (state.closed || readWardenOutcome(path)))
      removeWardenFiles(path);
  }

  dispose(): void {
    for (const entry of this.entries.values()) if (entry.timer) clearTimeout(entry.timer);
  }

  private statePath(jobId: string): string {
    return join(this.opts.dir!, `${jobId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
  }

  private writeState(entry: Entry, closed = false): void {
    if (!entry.statePath) return;
    const { point } = this.effective(entry);
    writeJsonAtomic(entry.statePath, {
      version: 1,
      jobId: entry.jobId,
      marker: entry.marker ?? null,
      at: point.at,
      monoTargetNs: point.mono.toString(),
      revision: entry.revision,
      closed,
    } satisfies WardenState);
  }

  private rearmTree(entry: Entry): void {
    const stack = [entry];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (seen.has(next.jobId)) continue;
      seen.add(next.jobId);
      if (next.state === "armed") {
        this.arm(next);
        if (next.statePath) this.writeState(next);
      }
      for (const child of next.children) {
        const value = this.entries.get(child);
        if (value) stack.push(value);
      }
    }
  }

  private arm(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    if (entry.state !== "armed") return;
    const { point } = this.effective(entry);
    const remainingNs = point.mono - this.clock.monoNow();
    if (remainingNs <= 0n) {
      this.expire(entry);
      return;
    }
    // setTimeout runs on the event loop's monotonic clock; re-check on fire.
    const ms = Number(remainingNs / 1_000_000n) + 1;
    entry.timer = setTimeout(() => this.arm(entry), Math.min(ms, 2_147_000_000));
    entry.timer.unref?.();
  }

  private expire(entry: Entry): void {
    if (entry.state !== "armed") return;
    entry.state = "expired";
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    this.expired(entry.jobId);
  }

  /** The effective deadline passed (the scheduler subclass ends the job). */
  protected expired(jobId: string): void {
    this.opts.onExpire?.(jobId);
  }
}
