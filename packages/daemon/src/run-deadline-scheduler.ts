/**
 * The scheduler side of run-deadline/1: the deadline registry bound to the
 * DaemonServer's queue, records and controllers through a narrow port, so the
 * scheduler itself only calls in at acceptance, terminal, retention and the
 * `claudexor.runDeadline` RPC.
 */
import { delegatedParentOf, isTerminalLifecycle } from "@claudexor/schema";
import { nowIso } from "@claudexor/util";
import type { CommandBackend } from "./command-authority.js";
import { findAcceptedCommand } from "./command-rpc.js";
import type { DelegationAdmissionAuthority } from "./delegation-admission.js";
import type { JobRecord } from "./job-record.js";
import { RunDeadlines, deadlineProblem, type RunDeadlinesOptions } from "./run-deadlines.js";

/**
 * run-deadline/1 hand-off a runner gets in its RunContext: give the run's scope
 * marker BEFORE its first launch. A no-op for a run without a deadline; it
 * throws when the warden that enforces the deadline cannot be started (the run
 * must not launch then).
 */
export interface DeadlineScope {
  attach(marker: string): Promise<void>;
}

export type RunDeadlineOptions = Omit<RunDeadlinesOptions, "onExpire">;

export interface DeadlineSchedulerPort {
  commands: CommandBackend;
  delegation?: DelegationAdmissionAuthority;
  getRecord(id: string): JobRecord | undefined;
  update(record: JobRecord, patch: Partial<JobRecord>): void;
  /** Take a queued job out of admission for good. */
  dequeue(id: string): void;
  /** Cancel a preparing/running job through the hard wall-clock path. */
  abort(id: string): void;
}

export class SchedulerDeadlines extends RunDeadlines {
  constructor(
    options: RunDeadlineOptions | undefined,
    private readonly port: DeadlineSchedulerPort,
  ) {
    super({ ...options });
  }

  /** A deadline already past refuses before acceptance; an exact replay keeps its handle. */
  checkStart(params: { request?: unknown } | null | undefined): void {
    if (!findAcceptedCommand(this.port.commands, params)) this.assertStartable(params?.request);
  }

  /** Register an accepted job's deadline (own, or inherited from a Delegate parent). */
  admitRecord(record: JobRecord): JobRecord {
    const parentRunId = delegatedParentOf(record.params);
    const parentJobId = parentRunId
      ? (this.port.commands.queries.getByRunId(parentRunId)?.id ?? null)
      : null;
    this.admit(record.id, record.params, parentJobId);
    return record;
  }

  scope(jobId: string): DeadlineScope {
    return { attach: (marker) => this.attachScope(jobId, marker) };
  }

  forgetAll(ids: Iterable<string>): void {
    for (const id of ids) this.forget(id);
  }

  /** A queued job never starts; a preparing or running one is cancelled. */
  protected override expired(id: string): void {
    const rec = this.port.getRecord(id);
    if (!rec || isTerminalLifecycle(rec.state)) return;
    if (rec.state !== "queued") return this.port.abort(id);
    this.port.dequeue(id);
    this.port.update(rec, {
      state: "cancelled",
      finishedAt: nowIso(),
      error: "run deadline passed before the run started",
      errorCode: "run_deadline_expired",
      errorRetryable: false,
    });
    const delegatedFrom = delegatedParentOf(rec.params);
    if (delegatedFrom) this.port.delegation?.cancelAcceptedChild(delegatedFrom, rec.id);
  }

  /** `claudexor.runDeadline`: read or set one job's deadline. */
  rpc(params: { id?: unknown; request?: unknown } | null | undefined): unknown {
    const id = typeof params?.id === "string" ? params.id : "";
    const request = params?.request as { action?: unknown } | undefined;
    const rec = id ? this.port.getRecord(id) : undefined;
    if (!rec) throw deadlineProblem("No such run", "run_not_found", 404);
    const live = !isTerminalLifecycle(rec.state);
    if (request?.action === "read") {
      const snapshot = this.snapshot(rec.id) ?? this.durableSnapshot(rec.id);
      if (!snapshot) throw deadlineProblem("Run has no deadline", "run_deadline_absent", 404);
      return snapshot;
    }
    if (request?.action !== "set")
      throw deadlineProblem("Expected a read or set request", "run_deadline_invalid", 400);
    if (!this.has(rec.id) && live)
      throw deadlineProblem("Run has no deadline", "run_deadline_absent", 404);
    const { action: _action, ...body } = request as Record<string, unknown>;
    return this.set(rec.id, body, { live, delegated: delegatedParentOf(rec.params) !== null });
  }
}
