/**
 * The scheduler side of run-deadline/1: the deadline registry bound to the
 * DaemonServer's commands through a narrow port. The scheduler calls in when
 * a command is about to be committed (`reserve`), when it was (`admitRecord`),
 * before a queued job starts (`expireIfDue`), at every terminal (`close`), at
 * retention (`forgetAll`) and for `claudexor.runDeadline`.
 */
import {
  TurnEnqueueProblem,
  delegatedParentOf,
  isTerminalLifecycle,
  type RunDeadlineSnapshot,
  type TurnEnqueueProblem as TurnEnqueueProblemValue,
} from "@claudexor/schema";
import type { CommandBackend } from "./command-authority.js";
import { commandStoreForId } from "./command-authority.js";
import type { JobRecord } from "./job-record.js";
import {
  RunDeadlines,
  deadlineProblem,
  requestedDeadline,
  type DeadlinePoint,
  type RunDeadlinesOptions,
} from "./run-deadlines.js";

/**
 * run-deadline/1 hand-off a runner gets in its RunContext: give each scope
 * marker of the run (the thread worktree preparation's, then the run's) BEFORE
 * the first process that carries it. A no-op for a run without a deadline; it
 * throws when the warden cannot be started or the deadline already passed
 * (nothing may be launched then).
 */
export interface DeadlineScope {
  attach(marker: string): Promise<void>;
}

export type RunDeadlineOptions = Omit<RunDeadlinesOptions, "onExpire">;

export interface DeadlineSchedulerPort {
  /** Cancel a queued job exactly as a Stop does, with this terminal patch. */
  cancel(id: string, patch: Partial<JobRecord>): void;
  /** Cancel a preparing or running job through the hard wall-clock path. */
  abort(id: string): void;
}

export interface DeadlineSchedulerHooks {
  commands: CommandBackend;
  onTurnEnqueueFailed?: (turnId: string, problem: TurnEnqueueProblemValue) => void;
}

const EXPIRED_MESSAGE = "run deadline passed before the run started";

export class SchedulerDeadlines extends RunDeadlines {
  private readonly pending = new Map<string, DeadlinePoint | null>();

  constructor(
    options: RunDeadlineOptions | undefined,
    private readonly hooks: DeadlineSchedulerHooks,
    private readonly port: DeadlineSchedulerPort,
  ) {
    super({ ...options });
  }

  private record(idOrRunId: string): JobRecord | undefined {
    return (
      commandStoreForId(this.hooks.commands, idOrRunId)?.get(idOrRunId) ??
      this.hooks.commands.queries.getByRunId(idOrRunId) ??
      undefined
    );
  }

  /**
   * A continuation's deadline (`continueFrom`): its own capped by a LIVE
   * predecessor's; without its own, the predecessor's, live or as it ended.
   * No continuation of a deadline run goes on without one after the
   * controller left. Null when neither has one.
   */
  private successorPoint(own: DeadlinePoint | null, params: unknown): DeadlinePoint | null {
    const from = (params as { continueFrom?: unknown } | null)?.continueFrom;
    const predecessor = typeof from === "string" ? this.record(from) : undefined;
    if (!predecessor) return own;
    const held = this.pointOf(predecessor.id);
    if (held?.live) return own && own.target < held.point.target ? own : held.point;
    if (own) return own;
    if (held) return held.point;
    const ended = this.durableSnapshot(predecessor.id, {
      params: predecessor.params,
      expired: predecessor.errorCode === "run_deadline_expired",
    });
    return ended ? this.lenientPoint(ended.at) : null;
  }

  /**
   * Immediately before the command is committed, synchronously: convert the
   * request's deadline once, refusing one already past (nothing is accepted).
   * A continuation without its own deadline whose inherited one has passed is
   * refused the same way.
   */
  reserve(jobId: string, request: unknown): void {
    const requested = requestedDeadline(request);
    const own = requested ? this.toPoint(requested.at) : null;
    const point = this.successorPoint(own, request);
    if (point && point !== own && point.target <= this.clock.hostNow())
      throw deadlineProblem(
        `the inherited deadline ${point.at} has passed; give the continuation its own deadline`,
        "run_deadline_passed",
      );
    if (point) this.pending.set(jobId, point);
  }

  /** The commit did not create this job (replay or failure): drop its reservation. */
  release(jobId: string): void {
    this.pending.delete(jobId);
  }

  /**
   * Register an accepted job: the deadline reserved before its commit, a
   * Delegate parent's, or, for a successor the engine itself started (a
   * deferred next message), its predecessor's. Never throws: an inherited
   * deadline that already passed expires the successor before it starts.
   */
  admitRecord(record: JobRecord): JobRecord {
    const reserved = this.pending.get(record.id) ?? null;
    this.pending.delete(record.id);
    const parentRunId = delegatedParentOf(record.params);
    const parentJobId = parentRunId ? (this.record(parentRunId)?.id ?? null) : null;
    let point = reserved;
    if (!point) {
      try {
        point = this.successorPoint(null, record.params);
      } catch {
        point = null;
      }
    }
    this.admit(record.id, point, parentJobId);
    return record;
  }

  /** Daemon startup, once commands are served: prove the boundary (the
   * capability waits for it) and drop finished wardens' files of jobs no
   * longer retained. */
  async startup(): Promise<void> {
    await this.prepare();
    this.sweep((jobId) => this.record(jobId) !== undefined);
  }

  scope(jobId: string): DeadlineScope {
    return { attach: (marker) => this.attachScope(jobId, marker) };
  }

  forgetAll(ids: Iterable<string>): void {
    for (const id of ids) this.forget(id);
  }

  /**
   * A queued job never starts: it ends through the same cancellation a Stop
   * takes (queue, Delegate admission, a held next message), with its typed
   * reason recorded on the command and on a thread turn that has no run. A
   * preparing or running job is cancelled through the hard wall-clock path.
   */
  protected override expired(id: string): void {
    const rec = this.record(id);
    if (!rec || isTerminalLifecycle(rec.state)) return;
    if (rec.state !== "queued") return this.port.abort(id);
    this.port.cancel(id, {
      error: EXPIRED_MESSAGE,
      errorCode: "run_deadline_expired",
      errorRetryable: false,
    });
    const turnId = (rec.params as { turnId?: unknown } | null)?.turnId;
    if (typeof turnId === "string" && turnId && this.hooks.onTurnEnqueueFailed) {
      try {
        this.hooks.onTurnEnqueueFailed(
          turnId,
          TurnEnqueueProblem.parse({
            message: EXPIRED_MESSAGE,
            code: "run_deadline_expired",
            retryable: false,
            required_actions: ["Start the turn again with a new deadline."],
            context: {},
          }),
        );
      } catch {
        /* observer failure must not corrupt terminal bookkeeping */
      }
    }
  }

  /** `claudexor.runDeadline`: read or set one job's deadline, by job id or run id. */
  async rpc(
    params: { id?: unknown; request?: unknown } | null | undefined,
  ): Promise<RunDeadlineSnapshot> {
    const id = typeof params?.id === "string" ? params.id : "";
    const request = params?.request as { action?: unknown } | undefined;
    const rec = id ? this.record(id) : undefined;
    if (!rec) throw deadlineProblem("No such run", "run_not_found", 404);
    const live = !isTerminalLifecycle(rec.state);
    const durable = () =>
      this.durableSnapshot(rec.id, {
        params: rec.params,
        expired: rec.errorCode === "run_deadline_expired",
      });
    if (request?.action === "read") {
      const snapshot = this.snapshot(rec.id) ?? durable();
      if (!snapshot) throw deadlineProblem("Run has no deadline", "run_deadline_absent", 404);
      return snapshot;
    }
    if (request?.action !== "set")
      throw deadlineProblem("Expected a read or set request", "run_deadline_invalid", 400);
    if (!this.has(rec.id) && (live || !durable()))
      throw deadlineProblem("Run has no deadline", "run_deadline_absent", 404);
    const { action: _action, ...body } = request as Record<string, unknown>;
    return this.set(rec.id, body, { live, delegated: delegatedParentOf(rec.params) !== null });
  }
}
