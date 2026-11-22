/**
 * The durable side of the run-deadline/1 registry (`run-deadlines.ts` holds
 * the transitions and timers): the records of the jobs this daemon holds or
 * stages, read through one cache (`reader`, claims included), every durable
 * replace (`commit`, through the injectable `RecordIo`), the enforcement claim
 * the daemon makes (`claimFloor`), the projections every answer is (`snapshot`),
 * and the one removal rule (`forget`, `sweep`, startup `reconcile`): a record
 * goes only once nothing may act on it.
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RunDeadlineSnapshot } from "@claudexor/schema";
import { unregisterScopeCgroup, unregisterScopeFence, type RunScopeEntry } from "@claudexor/core";
import { systemDeadlineClock, type RunDeadlineClock } from "./run-deadline-clock.js";
import {
  convertInstant,
  deadlineExpired,
  deadlineProblem,
  recordUnavailable,
  type DeadlinePoint,
  type DeadlineSpec,
} from "./run-deadline-problems.js";
import { reconcileRecords, sweepRecords } from "./run-deadline-reconcile.js";
import type { DeadlineBoundary } from "./run-deadline-cgroup.js";
import {
  RECORD_VERSION,
  fileRecordIo,
  frozenOf,
  governingBound,
  isRecordFileName,
  priorPath,
  readClaim,
  readPrior,
  readRecord,
  readRecordInForce,
  readWardenOutcome,
  recordFileName,
  removeRecordFiles,
  snapshotOf,
  writeRecord,
  type Bound,
  type DeadlineRecord,
  type RecordIo,
  type RecordReader,
} from "./run-deadline-record.js";
import { RUN_DEADLINE_STOP_GRACE_SEC } from "./run-deadline-warden.js";

export interface Entry {
  jobId: string;
  path: string;
  /** The last confirmed record (or one in effect whose durability is unknown). */
  record: DeadlineRecord;
  children: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
  /** The job reached its terminal: no timer is armed again, no set is confirmed. */
  closing: boolean;
  /** The terminal's own facts, taken the moment it arrived: they alone decide
   * closed or expired and the deadline it ended under (its parent's cap included). */
  terminal?: { at: bigint; claimed: boolean; won: boolean; bound: Bound | null };
  /** The deadline won (claimed, the job aborted): no set is decided, nothing launches. */
  won: boolean;
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
  /** The record file operations (default: the file system; the fault test injects). */
  io?: RecordIo;
  /** The warden's head start (default `WARDEN_HEAD_START_MS`); a confirmation must beat it. */
  headStartMs?: number;
  /** The governing deadline passed: the scheduler ends the job (queued or running). */
  onExpire?: (jobId: string) => void;
  /** A durable write the daemon could not make, after it already decided. */
  onFault?: (message: string, error: unknown) => void;
}

export const pointState = (point: DeadlinePoint) => ({
  at: point.at,
  targetNs: point.target.toString(),
});
export const pointOf = (bound: Bound): DeadlinePoint => ({ at: bound.at, target: bound.target });
export const sameInherited = (a: DeadlineRecord["inherited"], b: DeadlineRecord["inherited"]) =>
  a?.targetNs === b?.targetNs && a?.from === b?.from && a?.at === b?.at;

export abstract class RunDeadlineStore {
  protected readonly entries = new Map<string, Entry>();
  protected readonly byFile = new Map<string, Entry>();
  protected readonly staged = new Map<string, DeadlineRecord>();
  /** Record files whose job was forgotten but that a warden or a dependent may still need. */
  protected readonly orphans = new Set<string>();
  /** Terminal records startup decided for an earlier generation (by file), even
   * when the write failed: this generation's answers read the decision. */
  protected readonly settled = new Map<string, DeadlineRecord>();
  protected readonly clock: RunDeadlineClock;
  readonly stopGraceSec: number;
  protected readonly io: RecordIo;
  /** Records by file name (the cache for jobs held here, else the disk), with their claims. */
  protected readonly reader: RecordReader;

  constructor(protected readonly opts: RunDeadlinesOptions) {
    this.clock = opts.clock ?? systemDeadlineClock();
    this.stopGraceSec = opts.stopGraceSec ?? RUN_DEADLINE_STOP_GRACE_SEC;
    this.io = opts.io ?? fileRecordIo;
    if (opts.dir) mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
    this.reader = Object.assign(
      (file: string) =>
        this.byFile.get(file)?.record ??
        this.stagedByFile(file) ??
        this.settled.get(file) ??
        (opts.dir ? readRecord(join(opts.dir, file)) : null),
      {
        claim: (file: string) => (opts.dir ? readClaim(join(opts.dir, file)) : null),
        // A record held here is cached as the record in force: no prior applies.
        prior: (file: string) =>
          opts.dir && !this.byFile.has(file) && !this.stagedByFile(file)
            ? readPrior(join(opts.dir, file))
            : null,
      },
    );
  }

  has(jobId: string): boolean {
    return this.entries.has(jobId);
  }

  /** Convert an absolute instant now; refuse one that is not in the future. */
  toPoint(at: string): DeadlinePoint {
    return convertInstant(at, this.clock);
  }

  /**
   * A job's record: the cached one, else the durable one; null when it has none.
   * A record that exists but cannot be read is a storage failure (503,
   * retryable), never an absent deadline: nothing falls open on an I/O error.
   */
  recordOf(jobId: string): DeadlineRecord | null {
    const cached =
      this.entries.get(jobId)?.record ??
      this.staged.get(jobId) ??
      this.settled.get(recordFileName(jobId));
    if (cached) return cached;
    if (!this.opts.dir) return null;
    const read = readRecordInForce(this.path(jobId));
    if (read === "unreadable")
      throw recordUnavailable(new Error(`the deadline record of ${jobId} cannot be read`));
    return read;
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
    if (record.state !== "armed" || this.claimed(record.jobId)) return true;
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
    // Held before the write: a parent's removal sweep sees the dependent at once.
    this.staged.set(jobId, record);
    try {
      await writeRecord(this.path(jobId), record, this.io);
    } catch (error) {
      this.staged.delete(jobId);
      try {
        removeRecordFiles(this.path(jobId), this.io);
      } catch {
        /* nothing was accepted; the startup sweep removes an unretained record */
      }
      throw recordUnavailable(error);
    }
    return true;
  }

  /** A staged job was not committed (a replay won, or the commit failed): its record goes. */
  unstage(jobId: string): void {
    if (!this.staged.delete(jobId) || !this.opts.dir) return;
    try {
      removeRecordFiles(this.path(jobId), this.io);
    } catch {
      /* the startup sweep removes a record of an unretained job */
    }
  }

  /** The staged record of a job not yet committed (null when it holds none). */
  stagedRecord(jobId: string): DeadlineRecord | null {
    return this.staged.get(jobId) ?? null;
  }

  /**
   * The deadline as it stands, without any transition: no pending change is
   * awaited and a due deadline is not enforced here (the timer and the warden
   * do that). What a read-only lookup and the receipts project.
   */
  peek(jobId: string): RunDeadlineSnapshot | null {
    const entry = this.entries.get(jobId);
    return entry ? this.snapshotOfEntry(entry) : this.durableSnapshot(jobId);
  }

  /**
   * A run-scope row of one of this registry's runs was settled and retired from
   * the index: its recorded groups and descendants stay in the record, so the
   * warden can still prove them gone after a normal terminal.
   */
  keepRetiredScope(row: RunScopeEntry): void {
    for (const entry of this.entries.values()) {
      if (!entry.record.markers.includes(row.marker)) continue;
      void this.serialized(entry, async () => {
        const scopes = [...(entry.record.scopes ?? []).filter((s) => s.marker !== row.marker), row];
        await this.commit(entry, { ...entry.record, scopes }, "keep");
      }).catch(() => {});
      return;
    }
  }

  /** A record this daemon holds no entry for (an earlier generation's, or forgotten). */
  durableSnapshot(jobId: string): RunDeadlineSnapshot | null {
    const record = this.recordOf(jobId);
    if (!record) return null;
    const path = this.path(jobId);
    return snapshotOf(record, {
      read: this.reader,
      claimed: existsSync(`${path}.enforcing`),
      outcome: readWardenOutcome(path),
      serverNow: new Date(this.clock.wallNow()).toISOString(),
      stopGraceSec: this.stopGraceSec,
    });
  }

  /**
   * Retention forgot the job. Its files go once nothing needs them any more:
   * neither its own warden (started, not yet done) nor a record that names it
   * as its Delegate parent and may still act on it. Until then it is an orphan,
   * removed by a later sweep (the next retention pass, or startup).
   */
  forget(jobId: string): void {
    this.drop(jobId);
    this.sweep();
  }

  forgetAll(ids: Iterable<string>): void {
    for (const id of ids) this.drop(id);
    this.sweep();
  }

  /**
   * Startup, before any product request is served: the records of an earlier
   * generation reach their terminal state, then those of jobs no longer
   * retained go when nothing needs them (`run-deadline-reconcile.ts`).
   */
  async reconcile(states: (jobIds: string[]) => Map<string, string>): Promise<void> {
    if (!this.opts.dir) return;
    const removable = await reconcileRecords({
      dir: this.opts.dir,
      clock: this.clock,
      held: (jobId) => this.entries.has(jobId) || this.staged.has(jobId),
      governing: (record) => this.governing(record),
      states,
      io: this.io,
      onFault: this.opts.onFault,
      decided: (name, record) => this.settled.set(name, record),
    });
    for (const name of removable) this.orphans.add(name);
    this.sweep();
  }

  protected path(jobId: string): string {
    return join(this.opts.dir!, recordFileName(jobId));
  }

  protected stagedByFile(file: string): DeadlineRecord | undefined {
    for (const record of this.staged.values())
      if (recordFileName(record.jobId) === file) return record;
    return undefined;
  }

  protected claimed(jobId: string): boolean {
    return this.opts.dir ? existsSync(`${this.path(jobId)}.enforcing`) : false;
  }

  /** The durable fact that `bound` won, before any stop or restoring write. True
   * when a claim stands afterwards (written now, or already there). */
  protected claimFloor(entry: Entry, revision: number, bound: Bound | null): boolean {
    if (!bound) return false;
    try {
      this.io.claim(entry.path, {
        revision,
        at: bound.at,
        targetNs: bound.target.toString(),
        by: "daemon",
      });
      return true;
    } catch (error) {
      this.opts.onFault?.(`run-deadline claim of ${entry.jobId} not written`, error);
      return this.claimed(entry.jobId);
    }
  }

  protected closedRefusal(): Error {
    return deadlineProblem("Run is terminal; its deadline is closed", "run_deadline_closed");
  }

  protected snapshotOfEntry(entry: Entry): RunDeadlineSnapshot {
    let record = entry.record;
    // A terminal that arrived before its write landed: report what it writes.
    if (entry.terminal && (record.state === "armed" || record.state === "enforcing"))
      record = this.terminalRecord(entry);
    else if (entry.won && record.state === "armed") record = { ...record, state: "enforcing" };
    return snapshotOf(record, {
      read: this.reader,
      claimed: this.claimed(entry.jobId),
      outcome: readWardenOutcome(entry.path),
      serverNow: new Date(this.clock.wallNow()).toISOString(),
      stopGraceSec: this.stopGraceSec,
    })!;
  }

  /** The record the terminal writes, from its captured facts alone. */
  protected terminalRecord(entry: Entry): DeadlineRecord {
    const terminal = entry.terminal!;
    const expired =
      terminal.won ||
      terminal.claimed ||
      (terminal.bound !== null && terminal.at >= terminal.bound.target);
    return {
      ...entry.record,
      state: expired ? "expired" : "closed",
      frozen: terminal.bound ? frozenOf(terminal.bound) : null,
    };
  }

  protected terminalRefusal(record: DeadlineRecord | null): Error {
    if (!record) return deadlineProblem("Run has no deadline", "run_deadline_absent", 404);
    return record.state === "enforcing" || record.state === "expired"
      ? deadlineExpired()
      : this.closedRefusal();
  }

  /** The parent's current deadline for the fallback copy in this record. */
  protected freshCap(record: DeadlineRecord): DeadlineRecord["inherited"] {
    if (!record.parent) return record.inherited;
    const parent = this.reader(record.parent);
    const cap = parent && parent !== "unreadable" ? this.governing(parent) : null;
    return cap
      ? { ...pointState(pointOf(cap)), from: cap.inheritedFrom ?? record.parentJobId! }
      : record.inherited;
  }

  protected serialized<T>(entry: Entry, work: () => Promise<T>): Promise<T> {
    const next = entry.chain.then(work, work);
    entry.chain = next.catch(() => {});
    return next;
  }

  /**
   * Replace the cached record durably. On a failed write:
   * - refuse: the cache follows what is in force on disk and the change is refused, typed;
   * - adopt: the cache follows what is in force on disk, the fault is reported;
   * - keep: the decision stands in memory (a terminal), the fault is reported.
   * Once written, the record file is the record in force: a prior left by a
   * change that did not commit goes (best effort; it names an older revision
   * or this one, so a prior left over only ever makes the deadline earlier).
   */
  protected async commit(
    entry: Entry,
    next: DeadlineRecord,
    onFailure: "refuse" | "adopt" | "keep",
  ): Promise<boolean> {
    try {
      await writeRecord(entry.path, next, this.io);
    } catch (error) {
      if (onFailure === "keep") entry.record = next;
      else {
        const disk = readRecordInForce(entry.path);
        if (disk && disk !== "unreadable") entry.record = disk;
      }
      if (onFailure === "refuse") throw recordUnavailable(error);
      this.opts.onFault?.(`run-deadline record of ${entry.jobId} not written`, error);
      return false;
    }
    entry.record = next;
    this.dropPrior(entry);
    return true;
  }

  /** Remove the prior beside a record when there is one (best effort, reported). */
  protected dropPrior(entry: Entry): void {
    if (!existsSync(priorPath(entry.path))) return;
    try {
      this.io.remove(priorPath(entry.path));
    } catch (error) {
      this.opts.onFault?.(`run-deadline prior of ${entry.jobId} not removed`, error);
    }
  }

  /** Forget a job in memory; its files join the orphans the next sweep removes. */
  protected drop(jobId: string): void {
    const entry = this.entries.get(jobId);
    this.staged.delete(jobId);
    if (entry) {
      this.stopTimer(entry);
      if (entry.record.parentJobId)
        this.entries.get(entry.record.parentJobId)?.children.delete(jobId);
      for (const marker of entry.record.markers) {
        unregisterScopeCgroup(marker);
        unregisterScopeFence(marker);
      }
      this.entries.delete(jobId);
      this.byFile.delete(recordFileName(jobId));
    }
    this.settled.delete(recordFileName(jobId));
    if (this.opts.dir) this.orphans.add(recordFileName(jobId));
  }

  /** Remove the orphans nothing needs any more (see `forget`). */
  protected sweep(): void {
    if (!this.opts.dir || this.orphans.size === 0) return;
    let names: string[];
    try {
      names = readdirSync(this.opts.dir).filter(isRecordFileName);
    } catch {
      return;
    }
    const removed = sweepRecords({
      dir: this.opts.dir,
      clock: this.clock,
      candidates: [...this.orphans],
      present: names,
      // Held and staged records depend on their parents while they exist.
      holds: (name) => this.byFile.has(name) || this.stagedByFile(name) !== undefined,
      parentOf: (name) =>
        this.byFile.get(name)?.record.parent ??
        this.stagedByFile(name)?.parent ??
        ((record) => (record && record !== "unreadable" ? record.parent : null))(
          readRecord(join(this.opts.dir!, name)),
        ),
      io: this.io,
    });
    for (const name of removed) this.orphans.delete(name);
    for (const name of [...this.orphans])
      if (!existsSync(join(this.opts.dir, name)) && !this.byFile.has(name))
        this.orphans.delete(name);
  }

  protected stopTimer(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
  }
}
