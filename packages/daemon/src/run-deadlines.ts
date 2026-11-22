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
 *   A set is decided before anything is visible; once the terminal arrived it
 *   is refused, and from the terminal on only the terminal's own facts decide.
 * - The daemon's timer ends the job (a queued one never starts, a running one
 *   is cancelled with `run_deadline_expired`); the warden ends the run's
 *   processes even while the daemon is dead. A deadline that won is claimed
 *   durably first, so no failed write can postpone it, and from then on the
 *   run's scope launches nothing (`registerScopeFence`).
 * - A Delegate child is capped by its parent's CURRENT deadline; a terminal
 *   keeps the one the run ended under (`frozen`), while its survivors stay
 *   capped by the parent's current one. Every confirmed parent change is
 *   copied into its descendants' records (`inherited`), and a record another
 *   record still depends on is never removed before that dependent is done.
 */
import { dirname, join } from "node:path";
import {
  RUN_DEADLINE_CAPABILITY,
  type ControlCapability,
  RunDeadlineSetRequest,
  type RunDeadlineSnapshot,
} from "@claudexor/schema";
import {
  registerScopeCgroup,
  registerScopeFence,
  unregisterScopeCgroup,
  unregisterScopeFence,
} from "@claudexor/core";
import { deadlineExpired, deadlineProblem, recordUnavailable } from "./run-deadline-problems.js";
import {
  createRunCgroup,
  probeCgroupBoundary,
  type DeadlineBoundary,
} from "./run-deadline-cgroup.js";
import {
  frozenOf,
  readClaim,
  recordFileName,
  type Bound,
  type DeadlineRecord,
} from "./run-deadline-record.js";
import { WARDEN_HEAD_START_MS, spawnWarden } from "./run-deadline-warden.js";
import {
  RunDeadlineStore,
  pointState,
  sameInherited,
  type Entry,
  type RunDeadlinesOptions,
} from "./run-deadline-store.js";

export type { RunDeadlinesOptions } from "./run-deadline-store.js";

const MAX_TIMER_MS = 1_000;

export class RunDeadlines extends RunDeadlineStore {
  private readonly platform: NodeJS.Platform;
  private readonly headStartNs: bigint;
  private boundary: DeadlineBoundary | null = null;
  private boundaryProbe: Promise<DeadlineBoundary> | null = null;
  /** The daemon stopped: no timer is armed again. */
  private disposed = false;

  constructor(opts: RunDeadlinesOptions) {
    super(opts);
    this.platform = opts.platform ?? process.platform;
    this.headStartNs = BigInt(Math.round((opts.headStartMs ?? WARDEN_HEAD_START_MS) * 1e6));
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
    if (entry.record.state === "armed" && !this.due(entry) && !this.claimed(jobId)) return false;
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

  /**
   * Replace the job's own deadline. Decided BEFORE anything is visible: a
   * terminal that arrived first refuses (`run_deadline_closed`), a reached or
   * claimed deadline refuses (`run_deadline_expired`), and in both cases the
   * record is untouched. Then the new revision is published, and confirmed only
   * if no warden can have acted on the replaced one (the record module doc);
   * otherwise the replaced deadline is claimed, restored as `enforcing`, and
   * the set refused. A failure before the publication changed nothing (503).
   */
  set(jobId: string, raw: unknown, opts: { delegated: boolean }): Promise<RunDeadlineSnapshot> {
    const request = RunDeadlineSetRequest.parse(raw);
    const entry = this.entries.get(jobId);
    if (!entry) return Promise.reject(this.terminalRefusal(this.recordOf(jobId)));
    return this.serialized(entry, async () => {
      await this.enforceIfDue(entry);
      // A deadline that won outranks the terminal its stop then caused.
      if (entry.record.state !== "armed") throw this.terminalRefusal(entry.record);
      if (entry.closing) throw this.closedRefusal();
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
      const candidate: DeadlineRecord = {
        ...previous,
        own: pointState(next),
        successorOf: null,
        revision: previous.revision + 1,
        inherited: this.freshCap(previous),
      };
      let tmp: string;
      try {
        tmp = await this.io.stage(entry.path, candidate);
      } catch (error) {
        throw recordUnavailable(error);
      }
      // The decision, with nothing visible yet.
      const refusal = entry.closing
        ? "closed"
        : this.claimed(jobId) || (replaced !== null && this.clock.hostNow() >= replaced.target)
          ? "expired"
          : null;
      if (refusal) {
        await this.io.discard(tmp).catch(() => {});
        if (refusal === "closed") throw this.closedRefusal();
        await this.enforce(entry);
        throw deadlineExpired("Run deadline was reached before the new one was decided");
      }
      try {
        await this.io.publish(tmp, entry.path);
      } catch (error) {
        await this.io.discard(tmp).catch(() => {});
        throw recordUnavailable(error);
      }
      // Visible from here: the cache follows the disk.
      entry.record = candidate;
      try {
        await this.io.flush(dirname(entry.path));
      } catch (error) {
        this.opts.onFault?.(`run-deadline record of ${jobId} published, not flushed`, error);
      }
      if (replaced && this.mayHaveWon(entry, previous.revision, replaced)) {
        await this.reinstate(entry, previous, replaced);
        throw deadlineExpired("Run deadline was reached while the new one was being written");
      }
      this.refreshTree(entry);
      return this.snapshotOfEntry(entry);
    });
  }

  /**
   * Hand a scope marker of the run to its warden BEFORE the first process that
   * carries it (preparation first, then the run): the first hand-off starts the
   * warden, later ones add markers. On a cgroup boundary the marker is bound to
   * the run's cgroup, so every launch carrying it enters that cgroup; from the
   * deadline on it launches nothing. Throws when the warden cannot be started or
   * the deadline was reached: then nothing may be launched.
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
      registerScopeFence(marker, () => this.fenced(entry));
      const markers = entry.record.markers.includes(marker)
        ? entry.record.markers
        : [...entry.record.markers, marker];
      try {
        await this.commit(
          entry,
          { ...entry.record, markers, cgroup, inherited: this.freshCap(entry.record) },
          "refuse",
        );
        if (!entry.wardenStarted) {
          await (this.opts.spawnWarden ?? spawnWarden)(entry.path);
          entry.wardenStarted = true;
        }
        await this.refuseUnlessArmed(entry);
      } catch (error) {
        unregisterScopeCgroup(marker);
        if (!entry.record.markers.includes(marker)) unregisterScopeFence(marker);
        throw error;
      }
    });
  }

  /**
   * The job reached its terminal: fix the deadline it ended under and tell
   * the warden (it leaves once the boundary is confirmed empty, else it stays
   * to the deadline). The terminal's own facts, taken now, decide: at or after
   * the deadline, or once the deadline was claimed or began its stop, it is
   * `expired`; before it, `closed`. A set not yet decided is refused.
   */
  close(jobId: string): void {
    const entry = this.entries.get(jobId);
    if (!entry || entry.closing) return;
    entry.closing = true;
    entry.terminal = { at: this.clock.hostNow(), claimed: this.claimed(jobId) };
    this.stopTimer(entry);
    for (const marker of entry.record.markers) unregisterScopeCgroup(marker);
    void this.serialized(entry, async () => {
      const record = entry.record;
      if (record.state === "closed" || record.state === "expired") return;
      const bound = this.governing(record);
      const terminal = entry.terminal!;
      const won =
        record.state === "enforcing" ||
        terminal.claimed ||
        (bound !== null && terminal.at >= bound.target);
      await this.commit(
        entry,
        { ...record, state: won ? "expired" : "closed", frozen: bound ? frozenOf(bound) : null },
        "keep",
      );
    }).catch(() => {});
  }

  /** Stop every timer and let pending record writes land (a clean stop leaves them durable). */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const entry of this.entries.values()) this.stopTimer(entry);
    await Promise.all([...this.entries.values()].map((entry) => entry.chain));
    // This registry's launch fences and cgroup bindings end with it.
    for (const entry of this.entries.values())
      for (const marker of entry.record.markers) {
        unregisterScopeFence(marker);
        unregisterScopeCgroup(marker);
      }
  }

  /** The run's scope launches nothing more: its deadline won (reached, claimed or stopping). */
  private fenced(entry: Entry): boolean {
    if (entry.record.state === "enforcing" || entry.record.state === "expired") return true;
    if (this.claimed(entry.jobId)) return true;
    const bound = this.governing(entry.record);
    return bound !== null && this.clock.hostNow() >= bound.target;
  }

  /**
   * After a publication: could a warden have acted on the replaced revision
   * before it? Only if the clock passed the replaced deadline plus the head
   * start, or a claim of that revision (or an earlier one) exists.
   */
  private mayHaveWon(entry: Entry, revision: number, replaced: Bound): boolean {
    if (this.clock.hostNow() >= replaced.target + this.headStartNs) return true;
    const claim = this.opts.dir ? readClaim(entry.path) : null;
    return claim !== null && (claim.revision === null || claim.revision <= revision);
  }

  /** The replaced deadline won after the new one was published: claim it, then restore it. */
  private async reinstate(entry: Entry, previous: DeadlineRecord, replaced: Bound): Promise<void> {
    this.claimFloor(entry, previous.revision, replaced);
    await this.commit(entry, { ...previous, state: "enforcing" }, "adopt");
    this.stopTimer(entry);
    if (!entry.closing) this.expired(entry.jobId);
  }

  private due(entry: Entry): boolean {
    const bound = this.governing(entry.record);
    return bound !== null && this.clock.hostNow() >= bound.target;
  }

  /** On the chain: a claim of the warden, or a reached deadline, starts the stop. */
  private async enforceIfDue(entry: Entry): Promise<void> {
    if (entry.record.state !== "armed" || entry.closing) return;
    if (this.claimed(entry.jobId) || this.due(entry)) await this.enforce(entry);
  }

  private async refuseUnlessArmed(entry: Entry): Promise<void> {
    await this.enforceIfDue(entry);
    if (entry.record.state !== "armed") throw this.terminalRefusal(entry.record);
    if (entry.closing) throw this.closedRefusal();
  }

  /** The deadline won: claimed durably first (whatever the record write does), then recorded. */
  private async enforce(entry: Entry): Promise<void> {
    if (entry.record.state !== "armed" || entry.closing) return;
    this.stopTimer(entry);
    this.claimFloor(entry, entry.record.revision, this.governing(entry.record));
    await this.commit(entry, { ...entry.record, state: "enforcing" }, "keep");
    this.expired(entry.jobId);
  }

  private expireWhenDue(entry: Entry): Promise<void> {
    return this.serialized(entry, async () => {
      await this.enforceIfDue(entry);
      if (entry.record.state === "armed" && !entry.closing) this.arm(entry);
    }).catch((error: unknown) =>
      this.opts.onFault?.(`run-deadline expiry of ${entry.jobId}`, error),
    );
  }

  /**
   * After a confirmed change of a record's deadline: every held descendant's
   * fallback copy of its parent's deadline is rewritten (on its own chain), so
   * a parent record that later cannot be read never raises it; timers re-arm.
   */
  private refreshTree(entry: Entry): void {
    const order: Entry[] = [];
    const seen = new Set<string>();
    const stack = [entry];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (seen.has(next.jobId)) continue;
      seen.add(next.jobId);
      order.push(next);
      for (const child of next.children) {
        const value = this.entries.get(child);
        if (value) stack.push(value);
      }
    }
    this.arm(entry);
    // Each on its own chain, not awaited: the parent's answer does not wait on a
    // child's transitions (its warden reads the parent's record directly).
    for (const descendant of order.slice(1)) {
      const refresh = async () => {
        const inherited = this.freshCap(descendant.record);
        if (!sameInherited(inherited, descendant.record.inherited))
          await this.commit(descendant, { ...descendant.record, inherited }, "adopt");
        this.arm(descendant);
      };
      void this.serialized(descendant, refresh).catch((error: unknown) =>
        this.opts.onFault?.(`run-deadline inheritance of ${descendant.jobId}`, error),
      );
    }
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
