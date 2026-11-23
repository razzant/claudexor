/**
 * Scheduler-owned registry of server-enforced run deadlines (run-deadline/1):
 * the transitions and timers over the durable records (`run-deadline-store.ts`).
 *
 * Four invariants hold by construction (ARCHITECTURE "Run deadlines"):
 * 1. Publication. The live record file is replaced by a new revision only when
 *    it was decided, on the host clock, before both the deadline it replaces
 *    and the one it asks for, with no terminal and no claim: that check is the
 *    last step before the rename. Otherwise the deadline that won is claimed
 *    first and the previous record stays.
 * 2. Confirmation. A set answers success only after its commit (the prior's
 *    removal) is durable. A commit that became visible but whose flush failed
 *    answers `run_deadline_outcome_unknown`: GET tells what is in force.
 * 3. Terminal. `close()` takes the terminal's facts the moment it arrives (its
 *    time, a claim, a won deadline, the governing bound with the parent's cap)
 *    and they alone decide closed or expired and the frozen deadline; a set not
 *    committed when the terminal arrives is refused.
 * 4. In force. Until its commit a change moves no deadline for anyone: the
 *    prior (written before the change can be seen, removed only by its commit
 *    or the next durable write) is the record in force for every reader, the
 *    warden included; after it, a claim floors the new one. A deadline that won
 *    aborts the job before any write is awaited, so no failed or pending write
 *    postpones it. A terminal's frozen deadline is what every reader sees of an
 *    ended job at once, and an extension commits only once its ended Delegate
 *    descendants' frozen deadlines are durable, so nothing raises them.
 * Every transition of one job runs on that job's chain, in order.
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
import {
  deadlineExpired,
  deadlineProblem,
  outcomeUnknown,
  recordUnavailable,
  type DeadlinePoint,
} from "./run-deadline-problems.js";
import {
  createRunCgroup,
  probeCgroupBoundary,
  type DeadlineBoundary,
} from "./run-deadline-cgroup.js";
import {
  priorPath,
  recordFileName,
  writeRecord,
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
type Verdict = "closed" | "expired" | "passed" | null;

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
      won: false,
      wardenStarted: false,
      chain: Promise.resolve(),
    };
    this.entries.set(jobId, entry);
    this.byFile.set(recordFileName(jobId), entry);
    if (record.parentJobId) this.entries.get(record.parentJobId)?.children.add(jobId);
    this.arm(entry);
  }

  /**
   * Before a queued job starts: true when it must not start NOW (its deadline
   * was reached or claimed by the record as last confirmed). The job stays
   * queued: its pending transitions settle on its chain first, and it either
   * expires (and leaves the queue) or, renewed meanwhile, is offered again.
   */
  mustNotStart(jobId: string): boolean {
    const entry = this.entries.get(jobId);
    if (!entry) return false;
    if (!entry.won && entry.record.state === "armed" && !this.due(entry) && !this.claimed(jobId))
      return false;
    void this.expireWhenDue(entry).then(() => {
      if (!entry.won && entry.record.state === "armed" && !entry.closing) this.resumed(jobId);
    });
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
   * Replace the job's own deadline: a two-phase commit (the record module doc).
   * 1. The candidate is staged and the record in force is kept durable beside
   *    it (`.prior`, every reader's floor) before anything can be seen.
   * 2. Last check, then the rename (invariant 1): no terminal, no claim, the
   *    clock before both the replaced and the requested deadline.
   * 3. After the flush, the commit check (no terminal, no claim, the clock
   *    before the replaced deadline plus the warden's head start) and, in the
   *    same synchronous step, the commit: the prior is removed. A terminal is
   *    taken either before that step (it wins, the set is refused) or after it
   *    (it ends the run under the new revision).
   * 4. Confirmed once that removal is durable (invariant 2); a removal that is
   *    visible but not durable answers outcome unknown, GET tells.
   * Refusals before the commit leave the previous record in force, durably
   * (its prior stays until the next durable write): a terminal first
   * (`run_deadline_closed`), a deadline that won (`run_deadline_expired`, then
   * claimed and the run stopped), a requested instant reached
   * (`run_deadline_passed`), a failed write, or an ended Delegate descendant
   * whose frozen deadline cannot be made durable before an extension (503).
   */
  set(jobId: string, raw: unknown, opts: { delegated: boolean }): Promise<RunDeadlineSnapshot> {
    const request = RunDeadlineSetRequest.parse(raw);
    const entry = this.entries.get(jobId);
    if (!entry) return Promise.reject(this.terminalRefusal(this.recordOf(jobId)));
    return this.serialized(entry, async () => {
      await this.enforceIfDue(entry);
      const refused = this.refusal(entry);
      if (refused) throw refused;
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
      const tmp = await this.prepareChange(entry, previous, candidate);
      const before = this.verdict(entry, replaced, next, 0n);
      if (before) {
        // The prior stays: the record file may be an earlier change that never
        // committed, and only the prior keeps the record in force there.
        await this.io.discard(tmp).catch(() => {});
        if (before === "closed") throw this.refusal(entry)!;
        if (before === "passed")
          throw deadlineProblem(
            "deadline.at was reached before the change could be made; nothing changed",
            "run_deadline_passed",
          );
        await this.enforce(entry);
        throw deadlineExpired("Run deadline was reached before the new one was decided");
      }
      try {
        await this.io.publish(tmp, entry.path);
      } catch (error) {
        await this.io.discard(tmp).catch(() => {}); // the prior stays (as above)
        throw recordUnavailable(error);
      }
      try {
        await this.io.flush(dirname(entry.path));
        // An extension raises its Delegate descendants' caps: one that already
        // ended keeps the deadline it ended under only once that is durable.
        if (!replaced || next.target > replaced.target)
          while (this.endedPending(entry)) await this.settleEnded(entry);
      } catch (error) {
        // Not committed: the prior keeps the previous record in force.
        throw recordUnavailable(error);
      }
      // From here to the commit nothing is awaited: no terminal can come between.
      const after = this.verdict(entry, replaced, next, this.headStartNs);
      // The terminal arrived first and wins: the prior is the record it froze.
      if (after === "closed") throw this.refusal(entry)!;
      if (after) return this.lostRace(entry, previous, candidate, replaced, next);
      try {
        this.io.remove(priorPath(entry.path));
      } catch (error) {
        throw recordUnavailable(error); // not committed: the prior still stands
      }
      entry.record = candidate; // committed, in the same synchronous step as its check
      this.arm(entry);
      try {
        await this.io.flush(dirname(entry.path));
      } catch (error) {
        this.refreshTree(entry);
        throw outcomeUnknown(
          "the new deadline is in effect but could not be made durable; read it again before relying on it",
          error,
        );
      }
      if (entry.closing) {
        // The terminal arrived after the commit: its own facts answer (a claim
        // it saw, or its time at the new deadline, make it expired).
        if (this.terminalRecord(entry).state === "expired") throw deadlineExpired();
      } else if (this.claimed(jobId)) {
        // A warden that read the prior before the commit claimed it: the run stops.
        return this.lostRace(entry, previous, candidate, replaced, next);
      }
      this.refreshTree(entry);
      return this.snapshotOfEntry(entry);
    });
  }

  /**
   * Phase 1 of a set: the candidate staged (nothing visible) and the record in
   * force kept durable beside it. A failure refuses with nothing changed.
   */
  private async prepareChange(
    entry: Entry,
    previous: DeadlineRecord,
    candidate: DeadlineRecord,
  ): Promise<string> {
    let tmp: string;
    try {
      tmp = await this.io.stage(entry.path, candidate);
    } catch (error) {
      throw recordUnavailable(error);
    }
    try {
      await writeRecord(priorPath(entry.path), previous, this.io);
    } catch (error) {
      await this.io.discard(tmp).catch(() => {});
      throw recordUnavailable(error);
    }
    return tmp;
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
   * The job reached its terminal (invariant 3): its facts are taken now — the
   * time, a claim, a won deadline, and the governing bound with its parent's
   * cap — and the write that follows on the chain uses them alone.
   */
  close(jobId: string): void {
    const entry = this.entries.get(jobId);
    if (!entry || entry.closing) return;
    const state = entry.record.state;
    entry.terminal = {
      at: this.clock.hostNow(),
      claimed: this.claimed(jobId),
      won: entry.won || state === "enforcing" || state === "expired",
      bound: this.governing(entry.record),
    };
    entry.closing = true;
    this.stopTimer(entry);
    // A terminal at or after its deadline that nothing claimed yet is expired:
    // the claim makes that durable even if the record write below fails.
    const { terminal } = entry;
    if (!terminal.won && !terminal.claimed && this.terminalRecord(entry).state === "expired")
      this.claimFloor(entry, entry.record.revision, terminal.bound);
    for (const marker of entry.record.markers) unregisterScopeCgroup(marker);
    void this.serialized(entry, async () => {
      if (entry.record.state === "closed" || entry.record.state === "expired") return;
      await this.commit(entry, this.terminalRecord(entry), "keep");
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

  /** A queued job held by `mustNotStart` was renewed meanwhile: offer it again. */
  protected resumed(_jobId: string): void {
    /* the scheduler subclass re-drains its queue */
  }

  /**
   * The verdict on a set at one moment: a terminal that arrived wins; a won or
   * claimed deadline, or the clock at the replaced deadline (plus `slack`),
   * means the replaced deadline won; the clock at the requested instant (plus
   * `slack`) means it passed.
   */
  private verdict(
    entry: Entry,
    replaced: Bound | null,
    next: DeadlinePoint,
    slack: bigint,
  ): Verdict {
    if (entry.closing) return "closed";
    if (entry.won || this.claimed(entry.jobId)) return "expired";
    const now = this.clock.hostNow();
    if (replaced && now >= replaced.target + slack) return "expired";
    return now >= next.target + slack ? "passed" : null;
  }

  /**
   * The earlier of the two deadlines won while the change was in flight (its
   * clock passed it plus the head start, or a warden claimed it). The record
   * whose deadline is that earlier one — the candidate of a shortening, the
   * previous one of an extension — is in force as enforcing, claimed, and the
   * job is aborted; the write that records it is best effort, because the prior
   * (before the commit) or the claim (after it) already holds that deadline
   * durably for the warden.
   */
  private async lostRace(
    entry: Entry,
    previous: DeadlineRecord,
    candidate: DeadlineRecord,
    replaced: Bound | null,
    next: DeadlinePoint,
  ): Promise<never> {
    const shortened = !replaced || next.target <= replaced.target;
    entry.record = shortened ? candidate : previous;
    entry.won = true;
    this.stopTimer(entry);
    this.claimFloor(entry, entry.record.revision, this.governing(entry.record));
    // A shortening that won is in force on disk too: its prior goes (an
    // extension's stays, it holds the previous record that won).
    if (shortened) this.dropPrior(entry);
    this.stopJob(entry);
    await this.commit(entry, { ...entry.record, state: "enforcing" }, "keep");
    throw deadlineExpired("Run deadline was reached while the new one was being written");
  }

  /** The run's scope launches nothing more: its deadline won (reached, claimed or stopping). */
  private fenced(entry: Entry): boolean {
    if (entry.won || entry.record.state === "enforcing" || entry.record.state === "expired")
      return true;
    if (!this.claimed(entry.jobId) && !this.due(entry)) return false;
    // Seen here first: the job is aborted now, before the refused launch's
    // failure can settle it as an ordinary error; the record follows on its chain.
    if (this.win(entry))
      void this.serialized(entry, () =>
        this.commit(entry, { ...entry.record, state: "enforcing" }, "keep"),
      ).catch(() => {});
    return true;
  }

  private due(entry: Entry): boolean {
    const bound = this.governing(entry.record);
    return bound !== null && this.clock.hostNow() >= bound.target;
  }

  /** On the chain: a claim of the warden, or a reached deadline, starts the stop. */
  private async enforceIfDue(entry: Entry): Promise<void> {
    if (entry.won || entry.record.state !== "armed" || entry.closing) return;
    if (this.claimed(entry.jobId) || this.due(entry)) await this.enforce(entry);
  }

  private async refuseUnlessArmed(entry: Entry): Promise<void> {
    await this.enforceIfDue(entry);
    const refused = this.refusal(entry);
    if (refused) throw refused;
  }

  /**
   * Why no change is made now, or null while the deadline is armed and the run
   * live. A terminal answers from its own facts (a deadline that won before it
   * outranks the stop it caused); otherwise a won deadline is expired.
   */
  private refusal(entry: Entry): Error | null {
    if (entry.terminal)
      return this.terminalRecord(entry).state === "expired"
        ? deadlineExpired()
        : this.closedRefusal();
    if (entry.won) return deadlineExpired();
    return entry.record.state === "armed" ? null : this.terminalRefusal(entry.record);
  }

  /** The deadline won: in memory and claimed at once, the job aborted, then recorded. */
  private async enforce(entry: Entry): Promise<void> {
    if (!this.win(entry)) return;
    await this.commit(entry, { ...entry.record, state: "enforcing" }, "keep");
  }

  /**
   * The synchronous part of a won deadline (invariant 4): the terminal and the
   * launch fence see it at once, the claim is written, and the job is aborted
   * before any write is awaited. False when it already won or ended.
   */
  private win(entry: Entry): boolean {
    if (entry.won || entry.record.state !== "armed" || entry.closing) return false;
    entry.won = true;
    this.stopTimer(entry);
    this.claimFloor(entry, entry.record.revision, this.governing(entry.record));
    this.stopJob(entry);
    return true;
  }

  /** End the job (the scheduler subclass); its failure is reported, never thrown. */
  private stopJob(entry: Entry): void {
    try {
      this.expired(entry.jobId);
    } catch (error) {
      this.opts.onFault?.(`run-deadline stop of ${entry.jobId}`, error);
    }
  }

  private expireWhenDue(entry: Entry): Promise<void> {
    return this.serialized(entry, async () => {
      await this.enforceIfDue(entry);
      if (!entry.won && entry.record.state === "armed" && !entry.closing) this.arm(entry);
    }).catch((error: unknown) =>
      this.opts.onFault?.(`run-deadline expiry of ${entry.jobId}`, error),
    );
  }

  /**
   * After a change of a record's deadline: every held descendant's fallback copy
   * of its parent's deadline is rewritten (on its own chain), so a parent record
   * that later cannot be read never raises it; timers re-arm.
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
    if (entry.won || entry.record.state !== "armed" || entry.closing || this.disposed) return;
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
