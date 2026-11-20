/**
 * Scheduler-owned registry of server-enforced run deadlines (run-deadline/1).
 *
 * Ownership (INV-144, see ARCHITECTURE "Daemon lifecycle"):
 * - The accepted command holds revision 0: `params.deadline.at`, durable with
 *   the command itself. Each later revision is written durably to the run's
 *   state file (`daemon/run-deadlines/<job>.json`) BEFORE it is confirmed, and
 *   that file is also what the run's warden obeys.
 * - The daemon converts an absolute instant ONCE, when it accepts it, to the
 *   host clock (`run-deadline-clock.ts`: CLOCK_BOOTTIME on Linux), so neither a
 *   wall-clock step nor a host suspend postpones a stop.
 * - It holds from acceptance: queued, preparing and running. The daemon's own
 *   timer ends the job (a queued one never starts; a running one is cancelled);
 *   the warden (`run-deadline-warden.ts`), started before the run's first
 *   process, ends the run's processes even while the daemon is dead.
 * - A Delegate child's effective deadline is the earlier of its own and its
 *   parent's CURRENT one: the child's warden reads the parent's state file, so
 *   one durable write of the parent moves every dependent warden at once.
 * - A run that reached a terminal keeps the effective deadline it ended under
 *   (`frozen`): a later parent change or the parent's removal never moves it.
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  RUN_DEADLINE_CAPABILITY,
  type ControlCapability,
  RunDeadlineSetRequest,
  RunDeadlineStart,
  type RunDeadlineSnapshot,
  type RunDeadlineState,
} from "@claudexor/schema";
import { registerScopeCgroup, unregisterScopeCgroup } from "@claudexor/core";
import { hostClock, type HostClockKind } from "./run-deadline-clock.js";
import {
  createRunCgroup,
  probeCgroupBoundary,
  type DeadlineBoundary,
} from "./run-deadline-cgroup.js";
import {
  RUN_DEADLINE_STOP_GRACE_SEC,
  effectiveTarget,
  readWardenOutcome,
  readWardenState,
  removeWardenFiles,
  spawnWarden,
  wardenDonePath,
  wardenReadyPath,
  writeJsonAtomicAsync,
  type WardenState,
} from "./run-deadline-warden.js";

export interface RunDeadlineClock {
  /** Wall clock, ms since the epoch (injectable: a test steps it backwards). */
  wallNow(): number;
  /** Host clock, ns: the same clock every warden reads (`kind`). */
  hostNow(): bigint;
  kind: HostClockKind;
  bootId(): string | null;
}

export function systemDeadlineClock(
  platform: NodeJS.Platform = process.platform,
): RunDeadlineClock {
  const clock = hostClock(platform);
  return { wallNow: () => Date.now(), hostNow: clock.now, kind: clock.kind, bootId: clock.bootId };
}

export function deadlineProblem(
  message: string,
  code: string,
  status = 409,
  retryable = false,
): Error & { code: string; status: number; retryable: boolean } {
  return Object.assign(new Error(message), { code, status, retryable });
}

/** An absolute deadline converted once to the host clock. */
export interface DeadlinePoint {
  at: string;
  target: bigint;
}

interface Entry {
  jobId: string;
  own: DeadlinePoint | null;
  revision: number;
  parentJobId: string | null;
  children: Set<string>;
  state: RunDeadlineState;
  /** The effective deadline fixed at the terminal (or at expiry). */
  frozen: (DeadlinePoint & { from: string | null }) | null;
  /** The parent's effective deadline when last seen (used if the parent is forgotten). */
  lastParent: (DeadlinePoint & { from: string }) | null;
  timer?: ReturnType<typeof setTimeout>;
  markers: string[];
  /** The state file exists (written by a set or the warden hand-off). */
  durable: boolean;
  wardenStarted: boolean;
  cgroup: string | null;
  /** Serializes this run's durable writes and hand-offs. */
  chain: Promise<unknown>;
}

export interface RunDeadlinesOptions {
  /** Directory of state files; absent: in-process timers only, no warden. */
  dir?: string;
  /** The run-scope index the warden reads recorded process groups from. */
  runScopesPath?: string;
  clock?: RunDeadlineClock;
  stopGraceSec?: number;
  spawnWarden?: (statePath: string) => Promise<{ pid: number }>;
  /** Boundary probe (default: the delegated cgroup v2 probe on Linux). */
  probeBoundary?: () => Promise<DeadlineBoundary>;
  platform?: NodeJS.Platform;
  /** The effective deadline passed: the scheduler ends the job (queued or running). */
  onExpire?: (jobId: string) => void;
}

/** Parse an optional `deadline` from a run request; undefined when absent. */
export function requestedDeadline(params: unknown): RunDeadlineStart | undefined {
  if (!params || typeof params !== "object") return undefined;
  const raw = (params as { deadline?: unknown }).deadline;
  return raw === undefined ? undefined : RunDeadlineStart.parse(raw);
}

/** The longest single timer wait: a suspended host is re-checked at least this often. */
const MAX_TIMER_MS = 1_000;

export class RunDeadlines {
  private readonly entries = new Map<string, Entry>();
  protected readonly clock: RunDeadlineClock;
  readonly stopGraceSec: number;
  private readonly platform: NodeJS.Platform;
  private boundary: DeadlineBoundary | null = null;
  private boundaryProbe: Promise<DeadlineBoundary> | null = null;

  constructor(private readonly opts: RunDeadlinesOptions) {
    this.platform = opts.platform ?? process.platform;
    this.clock = opts.clock ?? systemDeadlineClock(this.platform);
    this.stopGraceSec = opts.stopGraceSec ?? RUN_DEADLINE_STOP_GRACE_SEC;
    if (opts.dir) mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  }

  /** Prove the boundary once (Linux): needed before the capability is declared. */
  prepare(): Promise<DeadlineBoundary> {
    this.boundaryProbe ??= (this.opts.probeBoundary ?? (() => probeCgroupBoundary(this.platform)))()
      .catch((error: unknown) => ({ kind: "marker" as const, reason: String(error) }))
      .then((boundary) => (this.boundary = boundary));
    return this.boundaryProbe;
  }

  /**
   * The capability this host proves: Linux only, once the boundary probe has
   * finished and a warden can run (a state directory exists). The boundary
   * names how the run's processes are delimited.
   */
  capabilities(): ControlCapability[] {
    if (this.platform !== "linux" || !this.opts.dir || !this.boundary) return [];
    return [
      {
        name: RUN_DEADLINE_CAPABILITY,
        stopGraceSec: this.stopGraceSec,
        boundary: this.boundary.kind,
      },
    ];
  }

  has(jobId: string): boolean {
    return this.entries.has(jobId);
  }

  /** Convert an absolute instant now; refuse one that is not in the future. */
  toPoint(at: string): DeadlinePoint {
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
      target: this.clock.hostNow() + BigInt(wall - now) * 1_000_000n,
    };
  }

  /** A held run's effective deadline and whether the run is still live (armed). */
  pointOf(jobId: string): { point: DeadlinePoint; live: boolean } | null {
    const entry = this.entries.get(jobId);
    const point = entry ? this.effective(entry) : null;
    return entry && point ? { point, live: entry.state === "armed" } : null;
  }

  /** An instant converted without refusing one already past (it then expires). */
  protected lenientPoint(at: string): DeadlinePoint {
    const wall = Date.parse(at);
    return {
      at: new Date(wall).toISOString(),
      target: this.clock.hostNow() + BigInt(wall - this.clock.wallNow()) * 1_000_000n,
    };
  }

  /**
   * Register an accepted job. Never throws: the instant was checked before the
   * command was committed (`toPoint`), and one that passed since expires here
   * through the ordinary path. `parentJobId` names a Delegate parent whose
   * effective deadline also caps the child.
   */
  admit(jobId: string, own: DeadlinePoint | null, parentJobId: string | null): void {
    if (this.entries.has(jobId)) return;
    const parent = parentJobId ? this.entries.get(parentJobId) : undefined;
    if (!own && !parent) return;
    const entry: Entry = {
      jobId,
      own,
      revision: 0,
      parentJobId: parent ? parentJobId : null,
      children: new Set(),
      state: "armed",
      frozen: null,
      lastParent: null,
      markers: [],
      durable: false,
      wardenStarted: false,
      cgroup: null,
      chain: Promise.resolve(),
    };
    this.entries.set(jobId, entry);
    parent?.children.add(jobId);
    this.arm(entry);
  }

  /** Expire now when the effective deadline already passed; true when it did (or had). */
  expireIfDue(jobId: string): boolean {
    const entry = this.entries.get(jobId);
    if (!entry) return false;
    if (entry.state === "armed" && this.due(entry)) this.expire(entry);
    return entry.state === "expired";
  }

  private effective(entry: Entry): (DeadlinePoint & { from: string | null }) | null {
    if (entry.frozen) return entry.frozen;
    let best: (DeadlinePoint & { from: string | null }) | null = entry.own
      ? { ...entry.own, from: null }
      : null;
    let parentId = entry.parentJobId;
    const seen = new Set([entry.jobId]);
    let parentBest: (DeadlinePoint & { from: string }) | null = null;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = this.entries.get(parentId);
      if (!parent) break;
      const point = parent.frozen ?? parent.own;
      if (point && (!parentBest || point.target < parentBest.target))
        parentBest = { at: point.at, target: point.target, from: parentId };
      if (parent.frozen) break;
      parentId = parent.parentJobId;
    }
    if (parentBest) entry.lastParent = parentBest;
    const inherited = parentBest ?? entry.lastParent;
    if (inherited && (!best || inherited.target < best.target)) best = inherited;
    return best;
  }

  private due(entry: Entry): boolean {
    const point = this.effective(entry);
    return point !== null && this.clock.hostNow() >= point.target;
  }

  snapshot(jobId: string): RunDeadlineSnapshot | null {
    const entry = this.entries.get(jobId);
    if (!entry) return null;
    if (entry.state === "armed" && this.due(entry)) this.expire(entry);
    const point = this.effective(entry);
    if (!point) return null;
    return {
      at: point.at,
      revision: entry.revision,
      serverNow: new Date(this.clock.wallNow()).toISOString(),
      state: entry.state,
      stopGraceSec: this.stopGraceSec,
      inheritedFrom: point.from,
    };
  }

  /**
   * The deadline of a job this daemon holds no entry for (a previous
   * generation's, or one pruned from memory): its state file when one was
   * written (a later revision, or a warden hand-off), else revision 0 from the
   * accepted request. `expired` tells whether the job ended by its deadline.
   */
  durableSnapshot(
    jobId: string,
    accepted: { params: unknown; expired: boolean },
  ): RunDeadlineSnapshot | null {
    const state = this.opts.dir ? readWardenState(this.statePath(jobId)) : null;
    const serverNow = new Date(this.clock.wallNow()).toISOString();
    if (state && state !== "unreadable") {
      const point = state.frozen ?? state.own ?? state.inherited;
      if (!point) return null;
      const sameBoot = state.bootId === this.clock.bootId() && state.clock === this.clock.kind;
      const target = sameBoot ? effectiveTarget(state, this.opts.dir!) : null;
      const reached =
        readWardenOutcome(this.statePath(jobId)) !== null ||
        (target !== null
          ? this.clock.hostNow() >= target
          : Date.parse(point.at) <= this.clock.wallNow());
      return {
        at: point.at,
        revision: state.revision,
        serverNow,
        state: accepted.expired || (reached && !state.released) ? "expired" : "closed",
        stopGraceSec: this.stopGraceSec,
        inheritedFrom:
          state.frozen?.inheritedFrom ?? (state.own ? null : (state.inherited?.from ?? null)),
      };
    }
    const requested = requestedDeadline(accepted.params);
    if (!requested) return null;
    return {
      at: new Date(Date.parse(requested.at)).toISOString(),
      revision: 0,
      serverNow,
      state: accepted.expired ? "expired" : "closed",
      stopGraceSec: this.stopGraceSec,
      inheritedFrom: null,
    };
  }

  /**
   * Replace the job's own deadline. The new revision is written durably first
   * (the file every dependent warden reads) and confirmed only after that.
   * An effective deadline that already passed expires the run and refuses.
   */
  set(
    jobId: string,
    raw: unknown,
    opts: { live: boolean; delegated: boolean },
  ): Promise<RunDeadlineSnapshot> {
    const request = RunDeadlineSetRequest.parse(raw);
    const entry = this.entries.get(jobId);
    if (!opts.live || !entry)
      return Promise.reject(
        deadlineProblem("Run is terminal; its deadline is closed", "run_deadline_closed"),
      );
    return this.serialized(entry, async () => {
      if (entry.state === "armed" && this.due(entry)) this.expire(entry);
      if (entry.state === "expired")
        throw deadlineProblem("Run deadline already passed", "run_deadline_expired");
      if (entry.state !== "armed")
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
      const next = this.toPoint(request.at);
      if (this.opts.dir) {
        await this.writeState(entry, { own: next, revision: entry.revision + 1 });
        entry.durable = true;
      }
      if (entry.state !== "armed")
        throw deadlineProblem("Run is terminal; its deadline is closed", "run_deadline_closed");
      entry.own = next;
      entry.revision += 1;
      this.rearmTree(entry);
      return this.snapshot(jobId)!;
    });
  }

  /**
   * Hand a scope marker of the run to its warden BEFORE the first process that
   * carries it (preparation first, then the run): the first hand-off starts the
   * warden, later ones add markers. On a cgroup boundary the marker is bound to
   * the run's cgroup, so every launch carrying it enters that cgroup. Throws when
   * the warden cannot be started or the deadline passed meanwhile: then nothing
   * may be launched.
   */
  attachScope(jobId: string, marker: string): Promise<void> {
    const entry = this.entries.get(jobId);
    if (!entry || !this.opts.dir) return Promise.resolve();
    return this.serialized(entry, async () => {
      this.refuseIfDue(entry);
      if (this.boundary?.kind === "cgroup") {
        entry.cgroup ??= await createRunCgroup(this.boundary.runsDir, jobId);
        registerScopeCgroup(marker, join(entry.cgroup, "cgroup.procs"));
      }
      if (!entry.markers.includes(marker)) entry.markers.push(marker);
      await this.writeState(entry);
      entry.durable = true;
      if (!entry.wardenStarted) {
        await (this.opts.spawnWarden ?? spawnWarden)(this.statePath(jobId));
        entry.wardenStarted = true;
      }
      this.refuseIfDue(entry);
    });
  }

  private refuseIfDue(entry: Entry): void {
    if (entry.state === "armed" && this.due(entry)) this.expire(entry);
    if (entry.state !== "armed")
      throw deadlineProblem("Run deadline already passed", "run_deadline_expired");
  }

  /**
   * The job reached a terminal other than its deadline: stop the timer, fix the
   * effective deadline and tell the warden the run ended (it leaves once the
   * group is confirmed empty, else it stays to the deadline). An expired job's
   * warden is told the same; it is already enforcing.
   */
  close(jobId: string): void {
    const entry = this.entries.get(jobId);
    if (!entry || entry.state === "closed") return;
    if (entry.state === "armed") {
      entry.state = "closed";
      entry.frozen = this.effective(entry);
    }
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    for (const marker of entry.markers) unregisterScopeCgroup(marker);
    if (entry.durable)
      void this.serialized(entry, () => this.writeState(entry, { released: true })).catch(() => {});
  }

  /**
   * Retention forgot the job. Its state file goes with it unless a warden may
   * still act on it (started and not yet done); the startup sweep removes those
   * once their warden finished.
   */
  forget(jobId: string): void {
    const entry = this.entries.get(jobId);
    if (entry?.timer) clearTimeout(entry.timer);
    if (entry?.parentJobId) this.entries.get(entry.parentJobId)?.children.delete(jobId);
    for (const marker of entry?.markers ?? []) unregisterScopeCgroup(marker);
    this.entries.delete(jobId);
    if (!this.opts.dir) return;
    const path = this.statePath(jobId);
    if (!existsSync(wardenReadyPath(path)) || existsSync(wardenDonePath(path)))
      removeWardenFiles(path);
  }

  /**
   * Startup: drop the files of finished wardens whose job is no longer
   * retained, and every runtime file of a previous boot (no warden survives a
   * reboot). Durable records of retained jobs stay.
   */
  sweep(retained: (jobId: string) => boolean): void {
    if (!this.opts.dir) return;
    let names: string[];
    try {
      names = readdirSync(this.opts.dir).filter(
        (name) => name.endsWith(".json") && !name.includes(".json."),
      );
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(this.opts.dir, name);
      const state = readWardenState(path);
      const jobId = state && state !== "unreadable" ? state.jobId : name.slice(0, -5);
      const otherBoot =
        state &&
        state !== "unreadable" &&
        state.bootId !== null &&
        state.bootId !== this.clock.bootId();
      const wardenGone =
        !existsSync(wardenReadyPath(path)) || existsSync(wardenDonePath(path)) || otherBoot;
      if (wardenGone && !retained(jobId)) removeWardenFiles(path);
    }
  }

  dispose(): void {
    for (const entry of this.entries.values()) if (entry.timer) clearTimeout(entry.timer);
  }

  private statePath(jobId: string): string {
    return join(this.opts.dir!, `${jobId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
  }

  private serialized<T>(entry: Entry, work: () => Promise<T>): Promise<T> {
    const next = entry.chain.then(work, work);
    entry.chain = next.catch(() => {});
    return next;
  }

  private writeState(
    entry: Entry,
    patch: { own?: DeadlinePoint; revision?: number; released?: boolean } = {},
  ): Promise<void> {
    const own = patch.own ?? entry.own;
    const point = (value: DeadlinePoint) => ({ at: value.at, targetNs: value.target.toString() });
    this.effective(entry); // refreshes `lastParent`
    const parentPoint = entry.parentJobId ? entry.lastParent : null;
    const state: WardenState = {
      version: 2,
      jobId: entry.jobId,
      clock: this.clock.kind,
      bootId: this.clock.bootId(),
      own: own ? point(own) : null,
      revision: patch.revision ?? entry.revision,
      parent: entry.parentJobId
        ? `${entry.parentJobId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`
        : null,
      inherited: parentPoint ? { ...point(parentPoint), from: parentPoint.from } : null,
      frozen: entry.frozen ? { ...point(entry.frozen), inheritedFrom: entry.frozen.from } : null,
      markers: [...entry.markers],
      cgroup: entry.cgroup,
      runScopes: this.opts.runScopesPath ?? null,
      released: patch.released ?? entry.state !== "armed",
    };
    return writeJsonAtomicAsync(this.statePath(entry.jobId), state);
  }

  private rearmTree(entry: Entry): void {
    const stack = [entry];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (seen.has(next.jobId)) continue;
      seen.add(next.jobId);
      this.arm(next);
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
    const point = this.effective(entry);
    if (!point) return;
    const remainingNs = point.target - this.clock.hostNow();
    if (remainingNs <= 0n) {
      this.expire(entry);
      return;
    }
    // Event-loop timers run on the monotonic clock, which stops while the host
    // sleeps: re-read the host clock at least every second.
    const ms = Math.min(Number(remainingNs / 1_000_000n) + 1, MAX_TIMER_MS);
    entry.timer = setTimeout(() => this.arm(entry), ms);
    entry.timer.unref?.();
  }

  private expire(entry: Entry): void {
    if (entry.state !== "armed") return;
    entry.frozen = this.effective(entry);
    entry.state = "expired";
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    if (entry.durable) void this.serialized(entry, () => this.writeState(entry)).catch(() => {});
    this.expired(entry.jobId);
  }

  /** The effective deadline passed (the scheduler subclass ends the job). */
  protected expired(jobId: string): void {
    this.opts.onExpire?.(jobId);
  }
}
