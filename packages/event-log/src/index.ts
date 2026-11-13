import type { RunEvent, RunEventType } from "@claudexor/schema";
import { RunEvent as RunEventSchema } from "@claudexor/schema";
import { existsSync, statSync, truncateSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { appendLine, nowIso, orderedAppender } from "@claudexor/util";
import { lastSeqInFile, readEventFile, terminalEventInFile, withUnlanded } from "./event-file.js";
import { activeEventLogs, terminalTypeOf } from "./live-writers.js";
import type {
  EventLogOptions,
  PreparedTerminalEvent,
  TerminalPersistenceHook,
  TerminalRunEventType,
  TerminalStagingHook,
} from "./types.js";
export { RETAINED_OUTPUT_PATH, retainedOutput, writeRetainedOutput } from "./retained-output.js";
export { lastSeqInFile } from "./event-file.js";
export {
  appendRunEvent,
  appendRunEventLanded,
  emitBestEffort,
  lastRunEventSeq,
  liveRunEventSeq,
  readRunEvents,
} from "./live-writers.js";

export type {
  EventLogOptions,
  PreparedTerminalEvent,
  TerminalPersistenceHook,
  TerminalRunEventType,
  TerminalStagingHook,
} from "./types.js";

/** Who awaits an event's landing: resolved with the event, or given its failure. */
type Landing = { resolve(event: RunEvent): void; reject(error: unknown): void };

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
  /** Absolute, as the live-writer registry and the ordered appender key it. */
  private readonly path: string;
  private nextSeq: number;
  private deferTerminalEvents = false;
  private deferredTerminal: { type: RunEventType; payload: Record<string, unknown> } | null = null;
  private terminalCommittedFlag = false;
  private terminalCommitInProgress = false;
  private terminalWriterPoisoned = false;
  private terminalPersistence?: TerminalPersistenceHook;
  private terminalStaging?: TerminalStagingHook;
  /** A terminal is being committed through `emitTerminal`; ordinary events may append. */
  private terminalStaged = false;
  private prepareOutput?: (type: TerminalRunEventType, payload: Record<string, unknown>) => void;
  private beforeTerminal?: (
    type: TerminalRunEventType,
    payload: Record<string, unknown>,
  ) => PreparedTerminalEvent | void;
  /** Queued mode: stamped events whose lines have not landed, in seq order.
   * Null when lines are written inline. */
  private readonly unlanded: RunEvent[] | null;
  /** Queued mode: the highest seq whose line has landed. */
  private landedSeq: number;
  /** `dispose` was called while lines were in flight; it completes when they land. */
  private disposeWhenLanded = false;

  constructor(
    path: string,
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
    options: EventLogOptions = {},
  ) {
    this.path = resolve(path);
    // The live owner is checked before the tail is read: a live queued writer's
    // file may still be missing lines it has stamped.
    const live = activeEventLogs.get(this.path);
    if (live && !live.releaseRecoveredTerminalFence()) {
      throw new Error("an active EventLog already owns this event path");
    }
    this.nextSeq = lastSeqInFile(this.path) + 1;
    this.landedSeq = this.nextSeq - 1;
    this.unlanded = options.queued ? [] : null;
    this.terminalCommittedFlag = terminalEventInFile(this.path);
    if (!this.terminalCommittedFlag) activeEventLogs.set(this.path, this);
  }

  /**
   * Unregister this log as the live writer for its path. Out-of-band
   * appenders fall back to file-tail stamping afterwards, which is safe once
   * the owning run is terminal (nobody else holds an in-memory counter). With
   * lines still in flight, the log stays registered until the last one lands
   * or is lost, so nobody stamps from a file that is still short. A poisoned
   * writer stays registered as the path's fence until recovery releases it.
   */
  dispose(): void {
    if (this.terminalWriterPoisoned && !this.terminalCommittedFlag) return;
    if (this.unlanded?.length) {
      this.disposeWhenLanded = true;
      return;
    }
    if (activeEventLogs.get(this.path) === this) activeEventLogs.delete(this.path);
  }

  /** Hold the one terminal event while a Delegate parent drains children.
   * Non-terminal events (notably aggregate budget.cash) continue to append and
   * therefore remain ordered before the eventual final event. The hold stays
   * until a terminal commits; only `emitTerminal` commits a held terminal. */
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

  /** Highest seq whose line this writer has appended (queued mode: landed):
   * its in-memory counter, no file read. */
  lastSeq(): number {
    return this.unlanded ? this.landedSeq : this.nextSeq - 1;
  }

  /** Append a typed run event. Validates against the schema before writing. */
  emit(type: RunEventType, payload: Record<string, unknown> = {}, publish = true): RunEvent {
    return this.emitEvent(type, payload, publish);
  }

  /**
   * `emit`, settled once the event's line has landed and its `onPersist`
   * accepted it. A queued log's write or `onPersist` failure rejects this
   * await alone: it is not held for the log's next emit, and the log stays
   * usable. An inline log has settled by the time this returns.
   */
  emitLanded(
    type: Exclude<RunEventType, TerminalRunEventType>,
    payload: Record<string, unknown> = {},
    publish = true,
  ): Promise<RunEvent> {
    return new Promise((resolve, reject) => {
      if (this.unlanded) this.emitEvent(type, payload, publish, { resolve, reject });
      else resolve(this.emitEvent(type, payload, publish));
    });
  }

  /** @internal An emit made aside (`appendRunEvent`, `appendRunEventLanded`,
   * `emitBestEffort`): it leaves a failure held for the run's own lines to them,
   * and its own failure goes to `landing` alone, never held for the run (#704). */
  emitAside(
    type: Exclude<RunEventType, TerminalRunEventType>,
    payload: Record<string, unknown>,
    landing: Landing,
  ): RunEvent {
    const event = this.emitEvent(type, payload, true, { ...landing, aside: true });
    if (!this.unlanded) landing.resolve(event);
    return event;
  }

  private emitEvent(
    type: RunEventType,
    payload: Record<string, unknown>,
    publish: boolean,
    landing?: Landing & { aside?: boolean },
  ): RunEvent {
    this.assertEmittable();
    const terminalType = terminalTypeOf(type);
    if (terminalType && this.terminalStaged) {
      throw new Error("run terminal event commit is already in progress");
    }
    // A queued line's failure that nobody awaited is reported here, once, to
    // the run's own producers.
    if (this.unlanded && !landing?.aside) orderedAppender.throwHeld(this.path);
    if (this.deferTerminalEvents && terminalType) {
      if (this.deferredTerminal) throw new Error("run terminal event was emitted more than once");
      this.deferredTerminal = { type, payload };
      return this.stamp(type, payload);
    }
    if (terminalType) return this.commitNow(terminalType, payload, publish);
    const event = this.stamp(type, payload);
    if (this.unlanded) {
      orderedAppender.append(this.path, `${JSON.stringify(event)}\n`, {
        landed: () => this.landed(event, publish),
        lost: () => this.lost(),
        ...(landing
          ? {
              aside: landing.aside === true,
              waiter: { resolve: () => landing.resolve(event), reject: landing.reject },
            }
          : {}),
      });
      this.nextSeq += 1;
      this.unlanded.push(event);
      return event;
    }
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

  /** A queued line landed: it counts, `onPersist` takes it, then `onPublish`
   * (an `onPersist` throw is this landing's failure and skips `onPublish`). */
  private landed(event: RunEvent, publish: boolean): void {
    this.unlanded!.shift();
    this.landedSeq = event.seq ?? this.landedSeq;
    try {
      this.onPersist?.(event);
      try {
        if (publish) this.onPublish?.(event);
      } catch {
        /* best-effort live observer */
      }
    } finally {
      this.releaseWhenLanded();
    }
  }

  /** A queued line did not reach the file whole: its write failed first, and
   * every later line fails with it. The counter continues after the last line
   * that landed, so a seq on disk is never reused, and these consume none. */
  private lost(): void {
    this.unlanded!.shift();
    if (this.unlanded!.length === 0) this.nextSeq = this.landedSeq + 1;
    this.releaseWhenLanded();
  }

  private releaseWhenLanded(): void {
    if (!this.disposeWhenLanded || this.unlanded!.length > 0) return;
    this.disposeWhenLanded = false;
    this.dispose();
  }

  /**
   * The terminal commit, with its durable bytes staged first when a staging
   * hook is set. The terminal is prepared synchronously (canonical type,
   * receipt and outcome frozen), the staging hook writes its bytes off the
   * request thread, and the unchanged synchronous commit adopts them. While
   * this runs another terminal is refused as in progress, and an ordinary
   * event (an audit, a live-message receipt) appends before the terminal,
   * which then takes the next seq and keeps the time its verdict was prepared.
   * A staging failure leaves the writes to the commit. This commits a held
   * terminal too; it never holds one.
   *
   * A queued log first settles every ordered append under its run directory,
   * prepares its output, settles again, and only then freezes the rollback
   * boundary and prepares the terminal; after staging it settles until its own
   * queue is empty. An inline log without a staging hook commits before this
   * function first yields.
   */
  async emitTerminal(
    type: TerminalRunEventType,
    payload: Record<string, unknown> = {},
    publish = true,
  ): Promise<RunEvent> {
    const stage = this.terminalStaging;
    const queued = this.unlanded;
    this.assertEmittable();
    if (this.terminalStaged) throw new Error("run terminal event commit is already in progress");
    if (!stage && !queued) return this.commitNow(type, payload, publish);
    // Raised before the first await, so no callback during it commits a terminal.
    this.terminalStaged = true;
    try {
      // Each wait ends in the synchronous step it guards, so a line emitted while
      // a barrier settled is awaited too, never landing after the terminal
      // (#704). Only this log's queue is rechecked: a side journal appended after
      // the last barrier may still be in flight at the commit (no reader needs it).
      if (queued)
        do await this.runSettled();
        while (queued.length > 0);
      this.prepareOutput?.(type, payload);
      if (queued)
        do await this.runSettled();
        while (queued.length > 0);
      const terminal = this.prepareTerminal(type, payload);
      this.terminalCommitInProgress = false;
      if (stage) {
        try {
          await stage(terminal.event, terminal.prepared?.telemetry ?? null);
        } catch {
          // Whatever was not staged, the synchronous commit writes itself.
        }
      }
      if (queued) {
        try {
          do await this.runSettled();
          while (queued.length > 0);
        } catch (error) {
          this.rollbackTerminal(this.fileBytes(), terminal.prepared, error);
        }
      }
      this.terminalStaged = false;
      return this.commitTerminal(terminal, publish);
    } finally {
      this.terminalStaged = false;
    }
  }

  /** Commit the terminal held by `deferTerminal()` through `emitTerminal`, so
   * its bytes are staged first when a staging hook is set. The hold stays, and
   * so does the terminal until it commits: a commit that throws leaves it
   * pending for the flush that follows (#704). */
  async commitDeferredTerminal(): Promise<RunEvent | null> {
    const pending = this.deferredTerminal;
    return pending
      ? this.emitTerminal(pending.type as TerminalRunEventType, pending.payload)
      : null;
  }

  /** The barrier of every ordered append under the run directory made before
   * this call. Rejects with a failure nobody awaited. */
  private runSettled(): Promise<void> {
    return orderedAppender.settledUnder(dirname(this.path));
  }

  /** The synchronous terminal commit. A queued log refuses it while a line is in
   * flight, since the terminal line would land ahead of it (a programming-error
   * fence: every queued run commits its terminal through `emitTerminal`). */
  private commitNow(
    terminalType: TerminalRunEventType,
    payload: Record<string, unknown>,
    publish: boolean,
  ): RunEvent {
    this.assertNothingInFlight();
    // Derived output may announce its file before the terminal sequence/receipt
    // is frozen. Deferred terminals reach this only when they are flushed.
    this.prepareOutput?.(terminalType, payload);
    this.assertNothingInFlight();
    return this.commitTerminal(this.prepareTerminal(terminalType, payload), publish);
  }

  private assertNothingInFlight(): void {
    if (!this.unlanded?.length) return;
    throw Object.assign(
      new Error(
        "a queued event log commits a terminal synchronously only with no writes in flight",
      ),
      { code: "terminal_writes_in_flight" },
    );
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

  /** Freeze a terminal: its event and receipt. The fence stays up until the
   * commit; a failed preparation rolls back and rethrows. */
  private prepareTerminal(
    terminalType: TerminalRunEventType,
    payload: Record<string, unknown>,
  ): PreparedTerminal {
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
    this.landedSeq = event.seq ?? this.landedSeq;
    // The durable journal, canonical prepared receipt, and per-run event are
    // now one committed terminal unit. Only now may observers see it.
    this.terminalCommittedFlag = true;
    this.deferredTerminal = null;
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

  /** No queued byte lies past the cut: `emitTerminal` freezes `previousBytes`
   * and commits only after a settle, and rolls a failed settle back at the
   * current size; `commitNow` refuses a queued log with lines in flight.
   * Landed bytes past the cut are truncated. */
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

  /** Read and parse all events (skipping malformed lines, which are surfaced
   * separately), followed by those stamped and not yet landed. */
  readAll(): { events: RunEvent[]; malformed: number } {
    return withUnlanded(readEventFile(this.path), this.unlanded ?? []);
  }
}
