/**
 * The scheduler side of run-deadline/1: the deadline registry bound to the
 * DaemonServer's commands through a narrow port. The scheduler calls in before
 * a command is committed (`prepare`, then `reserve` at the commit itself),
 * after it was (`admitRecord`), before a promoted next message is committed
 * (`prepareSuccessor`), before a queued job starts (`mustNotStart`), at every
 * terminal (`close`), at retention (`forgetAll`), at startup (`startup`) and
 * for `claudexor.runDeadline`.
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
import type { DeadlineRecord } from "./run-deadline-record.js";
import {
  RUN_DEADLINE_EXPIRED,
  deadlineProblem,
  requestedDeadline,
  type DeadlinePoint,
  type DeadlineSpec,
} from "./run-deadline-problems.js";
import { RunDeadlines, type RunDeadlinesOptions } from "./run-deadlines.js";

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
export { RUN_DEADLINE_EXPIRED };

export interface DeadlineSchedulerPort {
  /** Cancel a queued job exactly as a Stop does, with this terminal patch. */
  cancel(id: string, patch: Partial<JobRecord>): void;
  /** Cancel a preparing or running job with reason `run_deadline_expired`. */
  abort(id: string): void;
}

export interface DeadlineSchedulerHooks {
  commands: CommandBackend;
  onTurnEnqueueFailed?: (turnId: string, problem: TurnEnqueueProblemValue) => void;
}

/** What a stop by the deadline records on a job that never bound a run. */
const EXPIRED_TERMINAL = {
  error: "run deadline passed before the run started",
  errorCode: RUN_DEADLINE_EXPIRED,
  errorStatus: 409,
  errorRetryable: false,
} as const satisfies Partial<JobRecord>;

type Prepared = { ok: true } | { error: unknown };

export class SchedulerDeadlines extends RunDeadlines {
  private readonly prepared = new Map<string, Prepared>();

  constructor(
    options: RunDeadlineOptions | undefined,
    private readonly hooks: DeadlineSchedulerHooks,
    private readonly port: DeadlineSchedulerPort,
  ) {
    super({ ...options });
  }

  /** One job id or run id → its job id, through the indexed scalar read when the store has one. */
  private jobIdOf(idOrRunId: string): string | null {
    const queries = this.hooks.commands.queries;
    if (queries.observationRecords)
      return queries.observationRecords([idOrRunId])[0]?.jobId ?? null;
    return (
      commandStoreForId(this.hooks.commands, idOrRunId)?.get(idOrRunId)?.id ??
      queries.getByRunId(idOrRunId)?.id ??
      null
    );
  }

  /**
   * The deadline a request's job will hold, resolved from records only.
   * Own: `deadline.at`, converted now (refused when past, or where run-deadline/1
   * is not declared). Delegate child: its parent's current deadline caps it.
   * Continuation (`continueFrom`): a LIVE predecessor's deadline caps its own;
   * without its own it takes the predecessor's (the one it ended under), from
   * that record and never converted again. An authority already spent (reached,
   * claimed, of another boot) refuses before acceptance (`refuse`), or makes the
   * engine-started successor expire at once (`expire`).
   */
  private specFor(params: unknown, onSpent: "refuse" | "expire"): DeadlineSpec | null {
    const requested = requestedDeadline(params);
    if (requested && !this.declared())
      throw deadlineProblem(
        "run-deadline/1 is not declared on this engine and host; nothing was accepted",
        "run_deadline_unsupported",
      );
    let own: DeadlinePoint | null = requested ? this.toPoint(requested.at) : null;
    let successorOf: string | null = null;
    const spent = (message: string, record: DeadlineRecord, predecessor: boolean) => {
      if (onSpent === "refuse") throw deadlineProblem(message, "run_deadline_passed");
      // Engine-started: accepted, then it expires before it starts.
      own = { at: this.governing(record)?.at ?? new Date().toISOString(), target: this.hostNow() };
      successorOf = predecessor ? record.jobId : null;
    };
    const parentRunId = delegatedParentOf(params);
    const parentJobId = parentRunId ? this.jobIdOf(parentRunId) : null;
    const parent = parentJobId ? this.recordOf(parentJobId) : null;
    if (parent && this.spent(parent))
      spent("the Delegate parent's deadline has passed; nothing was accepted", parent, false);
    const from = (params as { continueFrom?: unknown } | null)?.continueFrom;
    const predecessorId = typeof from === "string" ? this.jobIdOf(from) : null;
    const predecessor = predecessorId ? this.recordOf(predecessorId) : null;
    if (predecessor) {
      const bound = this.governing(predecessor);
      const live = predecessor.state === "armed";
      if (live && !this.spent(predecessor)) {
        if (bound && (!own || bound.target < own.target)) {
          own = { at: bound.at, target: bound.target };
          successorOf = predecessor.jobId;
        }
      } else if (!requested) {
        // A terminal predecessor: the deadline it ended under, while still ahead.
        const ahead =
          predecessor.state === "closed" &&
          bound !== null &&
          this.sameClock(predecessor) &&
          this.hostNow() < bound.target;
        if (ahead) {
          own = { at: bound!.at, target: bound!.target };
          successorOf = predecessor.jobId;
        } else
          spent(
            "the predecessor's deadline has passed; give the continuation its own deadline",
            predecessor,
            true,
          );
      }
      // An explicit deadline after a terminal predecessor is fresh authority: it stands.
    }
    if (!own && !parent) return null;
    return { own, successorOf, parentJobId: parent ? parentJobId : null };
  }

  /**
   * Before the commit, asynchronously: resolve the request's deadline and
   * write its record under the job id the commit will use. A refusal is kept
   * for `reserve` (the commit decides replays first).
   */
  async prepare(jobId: string, params: unknown): Promise<void> {
    try {
      const spec = this.specFor(params, "refuse");
      if (spec) await this.stage(jobId, spec);
      this.prepared.set(jobId, { ok: true });
    } catch (error) {
      this.prepared.set(jobId, { error });
    }
  }

  /**
   * Immediately before the commit, synchronously: a prepared refusal refuses
   * (nothing is accepted). A request that holds a deadline but was not
   * prepared refuses as retryable.
   */
  reserve(jobId: string, params: unknown): void {
    const prepared = this.prepared.get(jobId);
    this.prepared.delete(jobId);
    if (prepared && "error" in prepared) throw prepared.error;
    if (prepared) return;
    if (this.specFor(params, "refuse"))
      throw deadlineProblem(
        "the deadline record was not prepared; retry the request",
        "run_deadline_record_unavailable",
        503,
        true,
      );
  }

  /** The commit did not create this job (replay or failure): drop its staged record. */
  release(jobId: string): void {
    this.prepared.delete(jobId);
    this.unstage(jobId);
  }

  /**
   * Before a promoted next message is committed under `jobId`: its record,
   * from its predecessor's (it expires at once when that authority is spent).
   * Throws when the record cannot be written: the message stays held.
   */
  async prepareSuccessor(jobId: string, params: unknown): Promise<void> {
    const spec = this.specFor(params, "expire");
    if (spec) await this.stage(jobId, spec);
  }

  /** Register a committed job's staged record. Never throws. */
  admitRecord(record: JobRecord): JobRecord {
    this.admit(record.id);
    return record;
  }

  /**
   * Daemon startup, before product requests are served: prove the boundary
   * (the capability waits for it) and reconcile every record of an earlier
   * generation, reading the retained jobs' states in one indexed query.
   */
  async startup(): Promise<void> {
    await this.proveBoundary();
    await this.reconcile((jobIds) => {
      const queries = this.hooks.commands.queries;
      const states = new Map<string, string>();
      if (queries.observationRecords) {
        for (const row of queries.observationRecords(jobIds)) states.set(row.jobId, row.state);
        return states;
      }
      for (const id of jobIds) {
        const record = commandStoreForId(this.hooks.commands, id)?.get(id);
        if (record) states.set(id, record.state);
      }
      return states;
    });
  }

  scope(jobId: string): DeadlineScope {
    return { attach: (marker) => this.attachScope(jobId, marker) };
  }

  forgetAll(ids: Iterable<string>): void {
    for (const id of ids) this.forget(id);
  }

  /**
   * The terminal fields of a job its deadline stopped before it bound a run
   * (preparation): the same typed expiry a queued job gets.
   */
  unboundExpiry(signal: AbortSignal, record: JobRecord): Partial<JobRecord> {
    return !record.runId && signal.reason === RUN_DEADLINE_EXPIRED ? EXPIRED_TERMINAL : {};
  }

  /** The same, as the typed throw a preparation that stopped is settled with. */
  unboundExpiryError(signal: AbortSignal, record: JobRecord): Error | null {
    return !record.runId && signal.reason === RUN_DEADLINE_EXPIRED
      ? deadlineProblem(EXPIRED_TERMINAL.error, RUN_DEADLINE_EXPIRED, 409, false)
      : null;
  }

  /**
   * A queued job never starts: it ends through the same cancellation a Stop
   * takes (queue, Delegate admission, a held next message), with its typed
   * reason recorded on the command and on a thread turn that has no run. A
   * preparing or running job is cancelled with reason `run_deadline_expired`.
   */
  protected override expired(id: string): void {
    const queries = this.hooks.commands.queries;
    const state =
      queries.observationRecords?.([id])[0]?.state ??
      commandStoreForId(this.hooks.commands, id)?.get(id)?.state;
    if (!state || isTerminalLifecycle(state as JobRecord["state"])) return;
    if (state !== "queued") return this.port.abort(id);
    const rec = commandStoreForId(this.hooks.commands, id)?.get(id);
    this.port.cancel(id, EXPIRED_TERMINAL);
    const turnId = (rec?.params as { turnId?: unknown } | null)?.turnId;
    if (typeof turnId === "string" && turnId && this.hooks.onTurnEnqueueFailed) {
      try {
        this.hooks.onTurnEnqueueFailed(
          turnId,
          TurnEnqueueProblem.parse({
            message: EXPIRED_TERMINAL.error,
            code: RUN_DEADLINE_EXPIRED,
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
    const jobId = id ? this.jobIdOf(id) : null;
    if (!jobId) throw deadlineProblem("No such run", "run_not_found", 404);
    if (request?.action === "read") {
      const snapshot = await this.read(jobId);
      if (!snapshot) throw deadlineProblem("Run has no deadline", "run_deadline_absent", 404);
      return snapshot;
    }
    if (request?.action !== "set")
      throw deadlineProblem("Expected a read or set request", "run_deadline_invalid", 400);
    const { action: _action, ...body } = request as Record<string, unknown>;
    return this.set(jobId, body, { delegated: this.recordOf(jobId)?.parentJobId != null });
  }
}
