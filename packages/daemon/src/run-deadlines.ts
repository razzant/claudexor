/**
 * Scheduler-owned registry of server-enforced run deadlines (run-deadline/1).
 *
 * Ownership (INV-144, see ARCHITECTURE "Daemon lifecycle"):
 * - Each job with a deadline has ONE durable record (`run-deadline-record.ts`),
 *   staged before its command is committed and replaced durably before any
 *   change is confirmed; this registry caches the records of the jobs it
 *   holds, with their timers. Every answer is a projection of a record.
 * - An instant is converted ONCE, at acceptance, to the host clock; an
 *   inherited deadline is copied from the parent's or predecessor's record.
 * - Every transition of one job (acceptance, set, scopes, deadline, terminal)
 *   runs on that job's chain, in order; a set and the warden's one transition,
 *   its enforcement claim, are ordered by the host clock (record module doc).
 * - The daemon's timer ends the job (a queued one never starts, a running one
 *   is cancelled with `run_deadline_expired`); the warden ends the run's
 *   processes even while the daemon is dead.
 * - A Delegate child is capped by its parent's CURRENT deadline; a terminal
 *   keeps the one the run ended under (`frozen`), while its survivors stay
 *   capped by the parent's current one.
 */
import { existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  RUN_DEADLINE_CAPABILITY,
  type ControlCapability,
  RunDeadlineSetRequest,
  type RunDeadlineSnapshot,
} from "@claudexor/schema";
import { registerScopeCgroup, unregisterScopeCgroup } from "@claudexor/core";
import { systemDeadlineClock, type RunDeadlineClock } from "./run-deadline-clock.js";
import {
  convertInstant,
  deadlineExpired,
  deadlineProblem,
  recordUnavailable,
  type DeadlinePoint,
  type DeadlineSpec,
} from "./run-deadline-problems.js";
import { reconcileRecords } from "./run-deadline-reconcile.js";
import {
  createRunCgroup,
  probeCgroupBoundary,
  type DeadlineBoundary,
} from "./run-deadline-cgroup.js";
import {
  RECORD_VERSION,
  claimPath,
  enforcementClaimed,
  frozenOf,
  governingBound,
  readRecord,
  readWardenOutcome,
  recordFileName,
  removeRecordFiles,
  snapshotOf,
  wardenDonePath,
  wardenReadyPath,
  writeRecord,
  type Bound,
  type DeadlineRecord,
  type RecordReader,
} from "./run-deadline-record.js";
import { RUN_DEADLINE_STOP_GRACE_SEC, spawnWarden } from "./run-deadline-warden.js";

interface Entry {
  jobId: string;
  path: string;
  record: DeadlineRecord;
  children: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
  /** The job reached its terminal: no timer is armed again. */
  closing: boolean;
  wardenStarted: boolean;
  /** Serializes this job's transitions. */
  chain: Promise<unknown>;
}

export interface RunDeadlinesOptions {
  /** Directory of the durable records; without it no deadline is accepted. */
  dir?: string;
  /** The run-scope index the warden reads recorded process groups from. */
  runScopesPath?: string;
  clock?: RunDeadlineClock;
  stopGraceSec?: number;
  spawnWarden?: (recordPath: string) => Promise<{ pid: number }>;
  /** Boundary probe (default: the delegated cgroup v2 probe on Linux). */
  probeBoundary?: () => Promise<DeadlineBoundary>;
  /** The platform the capability is decided for (default: this host's). */
  platform?: NodeJS.Platform;
  /** The governing deadline passed: the scheduler ends the job (queued or running). */
  onExpire?: (jobId: string) => void;
  /** A durable write the daemon could not make, after it already decided. */
  onFault?: (message: string, error: unknown) => void;
}

/** The longest single timer wait: a suspended host is re-checked at least this often. */
const MAX_TIMER_MS = 1_000;
const pointState = (point: DeadlinePoint) => ({ at: point.at, targetNs: point.target.toString() });
const pointOf = (bound: Bound): DeadlinePoint => ({ at: bound.at, target: bound.target });

export class RunDeadlines {
  private readonly entries = new Map<string, Entry>();
  private readonly byFile = new Map<string, Entry>();
  private readonly staged = new Map<string, DeadlineRecord>();
  protected readonly clock: RunDeadlineClock;
  readonly stopGraceSec: number;
  private readonly platform: NodeJS.Platform;
  private boundary: DeadlineBoundary | null = null;
  private boundaryProbe: Promise<DeadlineBoundary> | null = null;
  /** The daemon stopped: no timer is armed again. */
  private disposed = false;
  /** Records by file name: the cache for jobs held here, else the disk. */
  protected readonly reader: RecordReader;

  constructor(private readonly opts: RunDeadlinesOptions) {
    this.platform = opts.platform ?? process.platform;
    this.clock = opts.clock ?? systemDeadlineClock();
    this.stopGraceSec = opts.stopGraceSec ?? RUN_DEADLINE_STOP_GRACE_SEC;
    if (opts.dir) mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
    this.reader = (file) =>
      this.byFile.get(file)?.record ?? (opts.dir ? readRecord(join(opts.dir, file)) : null);
  }

  /** Prove the boundary once (Linux): needed before the capability is declared. */
  proveBoundary(): Promise<DeadlineBoundary> {
    this.boundaryProbe ??= (this.opts.probeBoundary ?? (() => probeCgroupBoundary(this.platform)))()
      .catch((error: unknown) => ({ kind: "marker" as const, reason: String(error) }))
      .then((boundary) => (this.boundary = boundary));
    return this.boundaryProbe;
  }

  /**
   * The capability this host proves: Linux only, once the boundary probe has
   * finished and records can be kept (a state directory exists). The boundary
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

  /** run-deadline/1 is declared here: only then is an explicit deadline accepted. */
  declared(): boolean {
    return this.capabilities().length > 0;
  }

  has(jobId: string): boolean {
    return this.entries.has(jobId);
  }

  /** Convert an absolute instant now; refuse one that is not in the future. */
  toPoint(at: string): DeadlinePoint {
    return convertInstant(at, this.clock);
  }

  /** A job's record: the cached one, else the durable one; null when it has none. */
  recordOf(jobId: string): DeadlineRecord | null {
    const cached = this.entries.get(jobId)?.record;
    if (cached) return cached;
    if (!this.opts.dir) return null;
    const read = readRecord(this.path(jobId));
    return read && read !== "unreadable" ? read : null;
  }

  /** The deadline that governs a record's processes now, on this host's clock. */
  governing(record: DeadlineRecord): Bound | null {
    return governingBound(record, this.reader);
  }

  /** The record's targets mean something on this host's clock (same boot and clock). */
  sameClock(record: DeadlineRecord): boolean {
    return record.bootId === this.clock.bootId() && record.clock === this.clock.kind;
  }

  /** The record lost its authority: its deadline was reached, claimed or is not on this clock. */
  spent(record: DeadlineRecord): boolean {
    if (record.state !== "armed" || enforcementClaimed(this.path(record.jobId))) return true;
    if (!this.sameClock(record)) return true;
    const bound = this.governing(record);
    return bound !== null && this.clock.hostNow() >= bound.target;
  }

  hostNow(): bigint {
    return this.clock.hostNow();
  }

  /**
   * Write the record of a job about to be committed (before the command
   * exists: a client is answered only after both). False when the spec holds
   * no deadline. A Delegate parent's current deadline caps the child.
   */
  async stage(jobId: string, spec: DeadlineSpec): Promise<boolean> {
    if (!this.opts.dir)
      throw deadlineProblem(
        "this engine keeps no run-deadline/1 records",
        "run_deadline_unsupported",
      );
    const parent = spec.parentJobId ? this.recordOf(spec.parentJobId) : null;
    const cap = parent ? this.governing(parent) : null;
    if (!spec.own && !cap) return false;
    const record: DeadlineRecord = {
      version: RECORD_VERSION,
      jobId,
      clock: this.clock.kind,
      bootId: this.clock.bootId(),
      state: "armed",
      revision: 0,
      own: spec.own ? pointState(spec.own) : null,
      successorOf: spec.own ? spec.successorOf : null,
      parent: parent && cap ? recordFileName(parent.jobId) : null,
      parentJobId: parent && cap ? parent.jobId : null,
      inherited:
        parent && cap ? { ...pointState(cap), from: cap.inheritedFrom ?? parent.jobId } : null,
      frozen: null,
      markers: [],
      cgroup: null,
      runScopes: this.opts.runScopesPath ?? null,
    };
    try {
      await writeRecord(this.path(jobId), record);
    } catch (error) {
      throw recordUnavailable(error);
    }
    this.staged.set(jobId, record);
    return true;
  }

  /** A staged job was not committed (a replay won, or the commit failed): its record goes. */
  unstage(jobId: string): void {
    if (!this.staged.delete(jobId) || !this.opts.dir) return;
    const path = this.path(jobId);
    void Promise.all([path, claimPath(path)].map((file) => rm(file, { force: true }))).catch(
      () => {},
    );
  }

  /** The command of a staged job was committed: hold its record and arm it. Never throws. */
  admit(jobId: string): void {
    const record = this.staged.get(jobId);
    if (!record || this.entries.has(jobId)) return;
    this.staged.delete(jobId);
    const entry: Entry = {
      jobId,
      path: this.path(jobId),
      record,
      children: new Set(),
      closing: false,
      wardenStarted: false,
      chain: Promise.resolve(),
    };
    this.entries.set(jobId, entry);
    this.byFile.set(recordFileName(jobId), entry);
    if (record.parentJobId) this.entries.get(record.parentJobId)?.children.add(jobId);
    this.arm(entry);
  }

  /**
   * Before a queued job starts: true when it must not (its deadline was
   * reached, claimed or it is no longer armed). Its expiry follows on its chain.
   */
  mustNotStart(jobId: string): boolean {
    const entry = this.entries.get(jobId);
    if (!entry) return false;
    if (entry.record.state === "armed" && !this.due(entry) && !enforcementClaimed(entry.path))
      return false;
    void this.expireWhenDue(entry);
    return true;
  }

  /** The job's deadline as every answer reports it, after its pending transitions. */
  read(jobId: string): Promise<RunDeadlineSnapshot | null> {
    const entry = this.entries.get(jobId);
    if (!entry) return Promise.resolve(this.durableSnapshot(jobId));
    return this.serialized(entry, async () => {
      await this.enforceIfDue(entry);
      return this.snapshotOfEntry(entry);
    });
  }

  /** A record this daemon holds no entry for (an earlier generation's, or forgotten). */
  durableSnapshot(jobId: string): RunDeadlineSnapshot | null {
    const record = this.recordOf(jobId);
    if (!record) return null;
    const path = this.path(jobId);
    return snapshotOf(record, {
      read: this.reader,
      claimed: enforcementClaimed(path),
      outcome: readWardenOutcome(path),
      serverNow: new Date(this.clock.wallNow()).toISOString(),
      stopGraceSec: this.stopGraceSec,
    });
  }

  /**
   * Replace the job's own deadline. The new revision is published durably and
   * confirmed only if the clock is still before the deadline it replaced;
   * otherwise that deadline won while it was being published, and the replaced
   * revision is restored as `enforcing`.
   */
  set(jobId: string, raw: unknown, opts: { delegated: boolean }): Promise<RunDeadlineSnapshot> {
    const request = RunDeadlineSetRequest.parse(raw);
    const entry = this.entries.get(jobId);
    if (!entry) return Promise.reject(this.terminalRefusal(this.recordOf(jobId)));
    return this.serialized(entry, async () => {
      await this.enforceIfDue(entry);
      if (entry.record.state !== "armed") throw this.terminalRefusal(entry.record);
      if (opts.delegated)
        throw deadlineProblem(
          "A Delegate child's deadline follows its parent; change the parent",
          "delegated_deadline_forbidden",
          403,
        );
      if (request.expectedRevision !== entry.record.revision)
        throw deadlineProblem(
          `Deadline revision changed (expected ${request.expectedRevision}, current ${entry.record.revision}); read before retrying`,
          "run_deadline_revision_conflict",
        );
      const next = this.toPoint(request.at);
      const previous = entry.record;
      const replaced = this.governing(previous);
      await this.commit(
        entry,
        {
          ...previous,
          own: pointState(next),
          successorOf: null,
          revision: previous.revision + 1,
          inherited: this.freshCap(previous),
        },
        { strict: true },
      );
      if (replaced && this.clock.hostNow() >= replaced.target) {
        // The replaced deadline was reached during the publication: it won.
        await this.commit(entry, { ...previous, state: "enforcing" }, { strict: false });
        this.stopTimer(entry);
        this.expired(jobId);
        throw deadlineExpired("Run deadline was reached while the new one was being written");
      }
      this.rearmTree(entry);
      return this.snapshotOfEntry(entry);
    });
  }

  /**
   * Hand a scope marker of the run to its warden BEFORE the first process that
   * carries it (preparation first, then the run): the first hand-off starts the
   * warden, later ones add markers. On a cgroup boundary the marker is bound to
   * the run's cgroup, so every launch carrying it enters that cgroup. Throws when
   * the warden cannot be started or the deadline was reached: then nothing may
   * be launched.
   */
  attachScope(jobId: string, marker: string): Promise<void> {
    const entry = this.entries.get(jobId);
    if (!entry) return Promise.resolve();
    return this.serialized(entry, async () => {
      await this.refuseUnlessArmed(entry);
      let cgroup = entry.record.cgroup;
      if (this.boundary?.kind === "cgroup") {
        cgroup ??= await createRunCgroup(this.boundary.runsDir, jobId);
        registerScopeCgroup(marker, join(cgroup, "cgroup.procs"));
      }
      const markers = entry.record.markers.includes(marker)
        ? entry.record.markers
        : [...entry.record.markers, marker];
      try {
        await this.commit(
          entry,
          { ...entry.record, markers, cgroup, inherited: this.freshCap(entry.record) },
          { strict: true },
        );
        if (!entry.wardenStarted) {
          await (this.opts.spawnWarden ?? spawnWarden)(entry.path);
          entry.wardenStarted = true;
        }
        await this.refuseUnlessArmed(entry);
      } catch (error) {
        unregisterScopeCgroup(marker);
        throw error;
      }
    });
  }

  /**
   * The job reached its terminal: fix the deadline it ended under and tell
   * the warden (it leaves once the boundary is confirmed empty, else it stays
   * to the deadline). At or after the deadline, or once the deadline began its
   * stop, the terminal is `expired`; before it, `closed`.
   */
  close(jobId: string): void {
    const entry = this.entries.get(jobId);
    if (!entry || entry.closing) return;
    const at = this.clock.hostNow();
    entry.closing = true;
    this.stopTimer(entry);
    for (const marker of entry.record.markers) unregisterScopeCgroup(marker);
    void this.serialized(entry, async () => {
      const record = entry.record;
      if (record.state === "closed" || record.state === "expired") return;
      const bound = this.governing(record);
      const won =
        record.state === "enforcing" ||
        enforcementClaimed(entry.path) ||
        (bound !== null && at >= bound.target);
      await this.commit(
        entry,
        { ...record, state: won ? "expired" : "closed", frozen: bound ? frozenOf(bound) : null },
        { strict: false },
      );
    }).catch(() => {});
  }

  /**
   * Retention forgot the job. Its files go with it unless a warden may still
   * act on them (started and not yet done); the startup sweep removes those
   * once their warden finished.
   */
  forget(jobId: string): void {
    const entry = this.entries.get(jobId);
    this.staged.delete(jobId);
    if (entry) {
      this.stopTimer(entry);
      if (entry.record.parentJobId)
        this.entries.get(entry.record.parentJobId)?.children.delete(jobId);
      for (const marker of entry.record.markers) unregisterScopeCgroup(marker);
      this.entries.delete(jobId);
      this.byFile.delete(recordFileName(jobId));
    }
    if (!this.opts.dir) return;
    const path = this.path(jobId);
    if (!existsSync(wardenReadyPath(path)) || existsSync(wardenDonePath(path)))
      removeRecordFiles(path);
  }

  /**
   * Startup, before any product request is served: the records of an earlier
   * generation reach their terminal state (`run-deadline-reconcile.ts`).
   */
  reconcile(states: (jobIds: string[]) => Map<string, string>): Promise<void> {
    if (!this.opts.dir) return Promise.resolve();
    return reconcileRecords({
      dir: this.opts.dir,
      clock: this.clock,
      held: (jobId) => this.entries.has(jobId),
      governing: (record) => this.governing(record),
      states,
      onFault: this.opts.onFault,
    });
  }

  /** Stop every timer and let pending record writes land (a clean stop leaves them durable). */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const entry of this.entries.values()) this.stopTimer(entry);
    await Promise.all([...this.entries.values()].map((entry) => entry.chain));
  }

  protected path(jobId: string): string {
    return join(this.opts.dir!, recordFileName(jobId));
  }

  private snapshotOfEntry(entry: Entry): RunDeadlineSnapshot {
    return snapshotOf(entry.record, {
      read: this.reader,
      claimed: enforcementClaimed(entry.path),
      outcome: readWardenOutcome(entry.path),
      serverNow: new Date(this.clock.wallNow()).toISOString(),
      stopGraceSec: this.stopGraceSec,
    })!;
  }

  private terminalRefusal(record: DeadlineRecord | null): Error {
    if (!record) return deadlineProblem("Run has no deadline", "run_deadline_absent", 404);
    return record.state === "enforcing" || record.state === "expired"
      ? deadlineExpired()
      : deadlineProblem("Run is terminal; its deadline is closed", "run_deadline_closed");
  }

  /** The parent's current deadline for the fallback copy in this record. */
  private freshCap(record: DeadlineRecord): DeadlineRecord["inherited"] {
    if (!record.parent) return record.inherited;
    const parent = this.reader(record.parent);
    const cap = parent && parent !== "unreadable" ? this.governing(parent) : null;
    return cap
      ? { ...pointState(pointOf(cap)), from: cap.inheritedFrom ?? record.parentJobId! }
      : record.inherited;
  }

  private due(entry: Entry): boolean {
    const bound = this.governing(entry.record);
    return bound !== null && this.clock.hostNow() >= bound.target;
  }

  private serialized<T>(entry: Entry, work: () => Promise<T>): Promise<T> {
    const next = entry.chain.then(work, work);
    entry.chain = next.catch(() => {});
    return next;
  }

  /**
   * Replace the cached record durably. strict: a failed write is not
   * adopted (the cache is re-read from disk) and refuses, typed; otherwise the
   * decision stands in memory and the fault is reported.
   */
  private async commit(
    entry: Entry,
    next: DeadlineRecord,
    opts: { strict: boolean },
  ): Promise<void> {
    try {
      await writeRecord(entry.path, next);
    } catch (error) {
      if (!opts.strict) {
        entry.record = next;
        this.opts.onFault?.(`run-deadline record of ${entry.jobId} not written`, error);
        return;
      }
      const disk = readRecord(entry.path);
      if (disk && disk !== "unreadable") entry.record = disk;
      throw recordUnavailable(error);
    }
    entry.record = next;
  }

  /** On the chain: a claim of the warden, or a reached deadline, starts the stop. */
  private async enforceIfDue(entry: Entry): Promise<void> {
    if (entry.record.state !== "armed") return;
    if (enforcementClaimed(entry.path) || this.due(entry)) await this.enforce(entry);
  }

  private async refuseUnlessArmed(entry: Entry): Promise<void> {
    await this.enforceIfDue(entry);
    if (entry.record.state !== "armed") throw this.terminalRefusal(entry.record);
  }

  private async enforce(entry: Entry): Promise<void> {
    if (entry.record.state !== "armed") return;
    this.stopTimer(entry);
    await this.commit(entry, { ...entry.record, state: "enforcing" }, { strict: false });
    if (!entry.closing) this.expired(entry.jobId);
  }

  private expireWhenDue(entry: Entry): Promise<void> {
    return this.serialized(entry, async () => {
      await this.enforceIfDue(entry);
      if (entry.record.state === "armed" && !entry.closing) this.arm(entry);
    }).catch((error: unknown) =>
      this.opts.onFault?.(`run-deadline expiry of ${entry.jobId}`, error),
    );
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

  private stopTimer(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
  }

  private arm(entry: Entry): void {
    this.stopTimer(entry);
    if (entry.record.state !== "armed" || entry.closing || this.disposed) return;
    const bound = this.governing(entry.record);
    if (!bound) return;
    const remainingNs = bound.target - this.clock.hostNow();
    if (remainingNs <= 0n) {
      void this.expireWhenDue(entry);
      return;
    }
    // Event-loop timers run on the monotonic clock, which stops while the host
    // sleeps: re-read the host clock at least every second.
    const ms = Math.min(Number(remainingNs / 1_000_000n) + 1, MAX_TIMER_MS);
    entry.timer = setTimeout(() => this.arm(entry), ms);
    entry.timer.unref?.();
  }

  /** The governing deadline passed (the scheduler subclass ends the job). */
  protected expired(jobId: string): void {
    this.opts.onExpire?.(jobId);
  }
}
