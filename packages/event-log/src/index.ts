import type { RunEvent, RunEventType, RunTelemetry } from "@claudexor/schema";
import { RunEvent as RunEventSchema } from "@claudexor/schema";
import { existsSync, statSync, truncateSync, unlinkSync } from "node:fs";
import { appendLine, nowIso } from "@claudexor/util";
import { lastSeqInFile, readRunEvents, terminalEventInFile } from "./event-file.js";
export { RETAINED_OUTPUT_PATH, retainedOutput, writeRetainedOutput } from "./retained-output.js";
export { lastSeqInFile, readRunEvents } from "./event-file.js";

export type TerminalRunEventType = Extract<
  RunEventType,
  "run.completed" | "run.failed" | "run.blocked"
>;

export interface PreparedTerminalEvent {
  type: TerminalRunEventType;
  payload: Record<string, unknown>;
  /** Prepared in memory by the receipt owner; a SQL terminal sink writes it. */
  telemetry?: RunTelemetry | null;
  /**
   * Publish the prepared receipt's canonical commit marker after the durable
   * journal accepts the terminal, but before file-tail/live observers can see
   * the per-run terminal event.
   */
  commit?: () => void;
  /**
   * Undo preparation/commit side effects when no durable journal authority was
   * established. The callback must be idempotent.
   */
  rollback?: () => void;
}

/** A synchronous replacement for terminal persistence and file finalization.
 * A throw means no authority committed; pending means it committed and repair
 * remains owed. The event log never repeats the sink's file writes. */
export type TerminalPersistenceHook = (
  event: RunEvent,
  telemetry: RunTelemetry | null,
) => { state: "materialized" } | { state: "pending"; error: unknown };

/** Writes a prepared terminal's durable bytes off the request thread before
 * its synchronous commit, which then adopts them; anything not staged the
 * commit writes itself. */
export type TerminalStagingHook = (
  event: RunEvent,
  telemetry: RunTelemetry | null,
) => Promise<void>;

interface PreparedTerminal {
  event: RunEvent;
  prepared: PreparedTerminalEvent | void;
  /** The event file's size before preparation: the rollback boundary. */
  previousBytes: number | null;
}

/**
 * Append-only JSONL event log for a single run. Terminal output and human
 * summaries are projections; this file is the canonical event stream.
 *
 * Every emitted event carries a monotonic per-run `seq` stamped here — the
 * durable cursor for SSE resume (Last-Event-ID) and snapshot fencing
 * (detail.lastSeq). The counter initializes from the existing file tail so a
 * re-opened log (or an out-of-band appender like the control-api audit
 * writer) continues the sequence instead of restarting it.
 */
export class EventLog {
  private nextSeq: number;
  private deferTerminalEvents = false;
  private deferredTerminal: { type: RunEventType; payload: Record<string, unknown> } | null = null;
  private terminalCommittedFlag = false;
  private terminalCommitInProgress = false;
  private terminalWriterPoisoned = false;
  private terminalPersistence?: TerminalPersistenceHook;
  private terminalStaging?: TerminalStagingHook;
  /** A prepared terminal's bytes are being staged; ordinary events may append. */
  private terminalStaged = false;
  private prepareOutput?: (type: TerminalRunEventType, payload: Record<string, unknown>) => void;
  private beforeTerminal?: (
    type: TerminalRunEventType,
    payload: Record<string, unknown>,
  ) => PreparedTerminalEvent | void;

  constructor(
    private readonly path: string,
    private readonly runId: string,
    private readonly taskId: string,
    /**
     * Durable in-process authority. Non-terminal events reach it after their
     * per-run append; terminal events reach it first so crash recovery can
     * reconstruct the canonical receipt and per-run tail from the journal.
     */
    private readonly onPersist?: (event: RunEvent) => void,
    /**
     * Thread this run is a turn of, when any. Stamped on every event so the
     * global event multiplex can route live progress to a chat surface without
     * a reverse job lookup.
     */
    private readonly threadId?: string,
    /** Best-effort live observer, invoked only after terminal finalization. */
    private readonly onPublish?: (event: RunEvent) => void,
  ) {
    this.nextSeq = lastSeqInFile(path) + 1;
    this.terminalCommittedFlag = terminalEventInFile(path);
    if (!this.terminalCommittedFlag) {
      if (activeEventLogs.has(path)) {
        throw new Error("an active EventLog already owns this event path");
      }
      activeEventLogs.set(path, this);
    }
  }

  /**
   * Unregister this log as the live writer for its path. Out-of-band
   * appenders fall back to file-tail stamping afterwards, which is safe once
   * the owning run is terminal (nobody else holds an in-memory counter).
   */
  dispose(): void {
    if (activeEventLogs.get(this.path) === this) activeEventLogs.delete(this.path);
  }

  /** Hold the one terminal event while a Delegate parent drains children.
   * Non-terminal events (notably aggregate budget.cash) continue to append and
   * therefore remain ordered before the eventual final event. */
  deferTerminal(): void {
    this.deferTerminalEvents = true;
  }

  clearDeferredTerminal(): void {
    this.deferredTerminal = null;
  }

  /** The terminal held by `deferTerminal()` and not yet flushed, if any (a copy). */
  deferredTerminalPending(): { type: RunEventType; payload: Record<string, unknown> } | null {
    return this.deferredTerminal ? { ...this.deferredTerminal } : null;
  }

  /**
   * Register the engine's once-only terminal preparation hook. It builds the
   * canonical receipt in memory before the durable authority accepts the
   * terminal; commit runs afterward and before file-tail/live observers.
   */
  setBeforeTerminal(
    hook: (
      type: TerminalRunEventType,
      payload: Record<string, unknown>,
    ) => PreparedTerminalEvent | void,
    prepareOutput?: (type: TerminalRunEventType, payload: Record<string, unknown>) => void,
  ): void {
    this.beforeTerminal = hook;
    this.prepareOutput = prepareOutput;
  }

  /** Whether this writer has durably committed its exactly-once terminal. */
  terminalCommitted(): boolean {
    return this.terminalCommittedFlag;
  }

  setTerminalPersistence(hook: TerminalPersistenceHook): void {
    this.terminalPersistence = hook;
  }

  /** Stage a terminal's durable bytes off the request thread before its commit
   * (`emitTerminal`, `commitDeferredTerminal`). */
  setTerminalStaging(hook: TerminalStagingHook): void {
    this.terminalStaging = hook;
  }

  /** Highest seq this writer has appended: its in-memory counter, no file read. */
  lastSeq(): number {
    return this.nextSeq - 1;
  }

  /** Append a typed run event. Validates against the schema before writing. */
  emit(type: RunEventType, payload: Record<string, unknown> = {}, publish = true): RunEvent {
    this.assertEmittable();
    const terminalType: TerminalRunEventType | null =
      type === "run.completed" || type === "run.failed" || type === "run.blocked" ? type : null;
    if (terminalType && this.terminalStaged) {
      throw new Error("run terminal event commit is already in progress");
    }
    if (this.deferTerminalEvents && terminalType) {
      if (this.deferredTerminal) throw new Error("run terminal event was emitted more than once");
      this.deferredTerminal = { type, payload };
      return this.stamp(type, payload);
    }
    if (terminalType)
      return this.commitTerminal(this.prepareTerminal(terminalType, payload), publish);
    const event = this.stamp(type, payload);
    appendLine(this.path, JSON.stringify(event));
    this.nextSeq += 1;
    this.onPersist?.(event);
    try {
      if (publish) this.onPublish?.(event);
    } catch {
      /* best-effort live observer */
    }
    return event;
  }

  /**
   * The terminal commit with its durable bytes staged first. The terminal is
   * prepared synchronously (canonical type, receipt and outcome frozen), the
   * staging hook writes its bytes off the request thread, and the unchanged
   * synchronous commit adopts them. While staging awaits, another terminal is
   * refused as in progress and an ordinary event (an audit, a live-message
   * receipt) appends before the terminal, which then takes the next seq and
   * keeps the time its verdict was prepared. A staging failure leaves the
   * writes to the commit. Without a hook, or while terminals are held, this is
   * `emit`, committed before this function first yields.
   */
  async emitTerminal(
    type: TerminalRunEventType,
    payload: Record<string, unknown> = {},
    publish = true,
  ): Promise<RunEvent> {
    const stage = this.terminalStaging;
    if (!stage || this.deferTerminalEvents) return this.emit(type, payload, publish);
    this.assertEmittable();
    if (this.terminalStaged) throw new Error("run terminal event commit is already in progress");
    const terminal = this.prepareTerminal(type, payload);
    this.terminalCommitInProgress = false;
    this.terminalStaged = true;
    try {
      await stage(terminal.event, terminal.prepared?.telemetry ?? null);
    } catch {
      // Whatever was not staged, the synchronous commit writes itself.
    } finally {
      this.terminalStaged = false;
    }
    return this.commitTerminal(terminal, publish);
  }

  /** Commit the terminal held by `deferTerminal()` through `emitTerminal`, so
   * its bytes are staged first when a staging hook is set. */
  async commitDeferredTerminal(): Promise<RunEvent | null> {
    const pending = this.deferredTerminal;
    this.deferredTerminal = null;
    this.deferTerminalEvents = false;
    return pending
      ? this.emitTerminal(pending.type as TerminalRunEventType, pending.payload)
      : null;
  }

  private assertEmittable(): void {
    if (this.terminalCommittedFlag) {
      throw new Error("run terminal event is already committed");
    }
    if (this.terminalWriterPoisoned) {
      throw new Error("run terminal writer is poisoned after an incomplete rollback");
    }
    if (this.terminalCommitInProgress) {
      throw new Error("run terminal event commit is already in progress");
    }
  }

  private stamp(type: RunEventType, payload: Record<string, unknown>): RunEvent {
    return RunEventSchema.parse({
      seq: this.nextSeq,
      ts: nowIso(),
      run_id: this.runId,
      task_id: this.taskId,
      ...(this.threadId ? { thread_id: this.threadId } : {}),
      type,
      payload: payload,
    });
  }

  private fileBytes(): number | null {
    return existsSync(this.path) ? statSync(this.path).size : null;
  }

  /** Freeze a terminal: its derived output, event and receipt. The fence stays
   * up until the commit; a failed preparation rolls back and rethrows. */
  private prepareTerminal(
    terminalType: TerminalRunEventType,
    payload: Record<string, unknown>,
  ): PreparedTerminal {
    // Derived output may announce its file before the terminal sequence/receipt
    // is frozen. Deferred terminals reach this only when they are flushed.
    this.prepareOutput?.(terminalType, payload);
    let prepared: PreparedTerminalEvent | void = undefined;
    let event = this.stamp(terminalType, payload);
    // Snapshot before terminal preparation: the hook may materialize sibling
    // artifacts, but the event file rollback boundary is the pre-hook state.
    const previousBytes = this.fileBytes();
    // Fence every re-entrant emit before the preparation hook, append, and
    // durable sink form one terminal commit. The fence is released only by
    // a complete rollback or after the terminal fully commits.
    this.terminalCommitInProgress = true;
    // Validate the exact event before terminal preparation can
    // materialize a receipt for it. Keep the hook registered until the event
    // itself is durable so an append failure can retry the entire commit.
    try {
      prepared = this.beforeTerminal?.(terminalType, event.payload);
      // Terminal preparation may canonicalize facts after consulting immutable
      // artifacts. Commit the corresponding event type and payload as one
      // validated unit so the receipt, durable event, and live publication
      // cannot disagree.
      event = RunEventSchema.parse(
        prepared ? { ...event, type: prepared.type, payload: prepared.payload } : event,
      );
    } catch (error) {
      this.rollbackTerminal(previousBytes, prepared, error);
    }
    return { event, prepared, previousBytes };
  }

  private commitTerminal(terminal: PreparedTerminal, publish: boolean): RunEvent {
    const { prepared } = terminal;
    // Ordinary events appended while staging awaited precede the terminal.
    const moved = terminal.event.seq !== this.nextSeq;
    const event = moved
      ? RunEventSchema.parse({ ...terminal.event, seq: this.nextSeq })
      : terminal.event;
    const previousBytes = moved ? this.fileBytes() : terminal.previousBytes;
    this.terminalCommitInProgress = true;
    if (this.terminalPersistence) {
      let persisted: ReturnType<TerminalPersistenceHook>;
      try {
        persisted = this.terminalPersistence(event, prepared?.telemetry ?? null);
      } catch (error) {
        this.rollbackTerminal(previousBytes, prepared, error);
      }
      if (persisted.state === "pending") this.poisonAfterDurableCommit(persisted.error);
    } else {
      let durableAuthorityCommitted = false;
      try {
        this.onPersist?.(event);
        durableAuthorityCommitted = this.onPersist !== undefined;
      } catch (error) {
        this.rollbackTerminal(previousBytes, prepared, error);
      }
      try {
        prepared?.commit?.();
      } catch (error) {
        if (durableAuthorityCommitted) this.poisonAfterDurableCommit(error);
        this.rollbackTerminal(previousBytes, prepared, error);
      }
      try {
        appendLine(this.path, JSON.stringify(event));
      } catch (error) {
        if (durableAuthorityCommitted) this.poisonAfterDurableCommit(error);
        this.rollbackTerminal(previousBytes, prepared, error);
      }
    }
    this.nextSeq += 1;
    // The durable journal, canonical prepared receipt, and per-run event are
    // now one committed terminal unit. Only now may observers see it.
    this.terminalCommittedFlag = true;
    this.terminalCommitInProgress = false;
    this.beforeTerminal = undefined;
    this.dispose();
    try {
      if (publish) this.onPublish?.(event);
    } catch {
      /* durable replay remains authoritative */
    }
    return event;
  }

  private poisonAfterDurableCommit(originalError: unknown): never {
    this.terminalWriterPoisoned = true;
    this.terminalCommitInProgress = false;
    this.beforeTerminal = undefined;
    // CommandStore repairs the per-run tail synchronously from the accepted
    // journal terminal. Release the strong live-writer reference once that
    // repair becomes visible; appendRunEvent also performs this check inline.
    setImmediate(() => {
      this.releaseRecoveredTerminalFence();
    }).unref?.();
    throw Object.assign(
      new AggregateError(
        [originalError],
        "durable terminal authority committed but local finalization failed; restart required",
      ),
      {
        code: "terminal_recovery_required",
        status: 503,
        retryable: false,
      },
    );
  }

  /** @internal Release a poisoned live owner once journal recovery repairs its tail. */
  releaseRecoveredTerminalFence(): boolean {
    if (!this.terminalWriterPoisoned || !terminalEventInFile(this.path)) return false;
    this.terminalCommittedFlag = true;
    this.dispose();
    return true;
  }

  private rollbackTerminal(
    previousBytes: number | null,
    prepared: PreparedTerminalEvent | void,
    originalError: unknown,
  ): never {
    const rollbackErrors: unknown[] = [];
    try {
      if (previousBytes === null) {
        if (existsSync(this.path)) unlinkSync(this.path);
      } else if (existsSync(this.path) && statSync(this.path).size !== previousBytes) {
        truncateSync(this.path, previousBytes);
      }
    } catch (error) {
      rollbackErrors.push(error);
    }
    try {
      prepared?.rollback?.();
    } catch (error) {
      rollbackErrors.push(error);
    }
    if (rollbackErrors.length > 0) {
      // A partial rollback means neither retry nor an out-of-band append can
      // safely infer the terminal boundary. Keep this live writer registered
      // as an explicit poison fence until the owning process fails closed.
      this.terminalWriterPoisoned = true;
      this.terminalCommitInProgress = false;
      throw new AggregateError(
        [originalError, ...rollbackErrors],
        "terminal event commit failed and rollback was incomplete",
      );
    }
    this.terminalCommitInProgress = false;
    throw originalError;
  }

  /** Read and parse all events (skipping malformed lines, which are surfaced separately). */
  readAll(): { events: RunEvent[]; malformed: number } {
    return readRunEvents(this.path);
  }
}

/**
 * Live writers by events.jsonl path (one daemon process hosts the
 * orchestrator AND the control API). While a run is active its EventLog owns
 * the in-memory seq counter; any other same-process appender stamping from
 * the file tail would duplicate ids the moment the live counter is ahead.
 */
const activeEventLogs = new Map<string, EventLog>();

/**
 * Append an out-of-band event (e.g. a control-api audit record) into a run's
 * canonical log WITHOUT corrupting the seq space: routes through the live
 * EventLog when the run is still active (same counter, same onEmit sink), and
 * falls back to file-tail stamping for terminal runs.
 */
export function appendRunEvent(
  path: string,
  runId: string,
  taskId: string,
  type: RunEventType,
  payload: Record<string, unknown> = {},
): RunEvent {
  const live = activeEventLogs.get(path);
  if (live && !live.releaseRecoveredTerminalFence()) return live.emit(type, payload);
  const terminal = type === "run.completed" || type === "run.failed" || type === "run.blocked";
  if (terminal && terminalEventInFile(path)) {
    throw new Error("run terminal event is already committed");
  }
  const event = RunEventSchema.parse({
    seq: lastSeqInFile(path) + 1,
    ts: nowIso(),
    run_id: runId,
    task_id: taskId,
    type,
    payload: payload,
  });
  appendLine(path, JSON.stringify(event));
  return event;
}

/**
 * A registered live writer's authoritative in-memory cursor, or null when no
 * live writer owns this path. This never reads files or initiates recovery;
 * a poisoned writer keeps its conservative counter until recovery releases it.
 */
export function liveRunEventSeq(path: string): number | null {
  return activeEventLogs.get(path)?.lastSeq() ?? null;
}

/**
 * The run's highest event `seq` for snapshot fencing. A live writer answers from
 * its in-memory counter (the one seq owner; its file holds exactly the events up
 * to that seq); any other log answers from its file through `lastSeqInFile`.
 */
export function lastRunEventSeq(path: string): number {
  const live = activeEventLogs.get(path);
  return live && !live.releaseRecoveredTerminalFence() ? live.lastSeq() : lastSeqInFile(path);
}
