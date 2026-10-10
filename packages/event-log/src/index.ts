import type { RunEvent, RunEventType } from "@claudexor/schema";
import { RunEvent as RunEventSchema } from "@claudexor/schema";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  statSync,
  truncateSync,
  unlinkSync,
} from "node:fs";
import { appendLine, nowIso, readTextSafe, redactSecrets } from "@claudexor/util";
export { RETAINED_OUTPUT_PATH, retainedOutput, writeRetainedOutput } from "./retained-output.js";

export type TerminalRunEventType = Extract<
  RunEventType,
  "run.completed" | "run.failed" | "run.blocked"
>;

export interface PreparedTerminalEvent {
  type: TerminalRunEventType;
  payload: Record<string, unknown>;
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

  flushDeferredTerminal(): RunEvent | null {
    const pending = this.deferredTerminal;
    this.deferredTerminal = null;
    this.deferTerminalEvents = false;
    return pending ? this.emit(pending.type, pending.payload) : null;
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

  /** Highest seq this writer has appended: its in-memory counter, no file read. */
  lastSeq(): number {
    return this.nextSeq - 1;
  }

  /** Append a typed run event. Validates against the schema before writing. */
  emit(type: RunEventType, payload: Record<string, unknown> = {}, publish = true): RunEvent {
    if (this.terminalCommittedFlag) {
      throw new Error("run terminal event is already committed");
    }
    if (this.terminalWriterPoisoned) {
      throw new Error("run terminal writer is poisoned after an incomplete rollback");
    }
    if (this.terminalCommitInProgress) {
      throw new Error("run terminal event commit is already in progress");
    }
    const terminalType: TerminalRunEventType | null =
      type === "run.completed" || type === "run.failed" || type === "run.blocked" ? type : null;
    const terminal = terminalType !== null;
    if (this.deferTerminalEvents && terminal) {
      if (this.deferredTerminal) throw new Error("run terminal event was emitted more than once");
      this.deferredTerminal = { type, payload };
      return RunEventSchema.parse({
        seq: this.nextSeq,
        ts: nowIso(),
        run_id: this.runId,
        task_id: this.taskId,
        ...(this.threadId ? { thread_id: this.threadId } : {}),
        type,
        payload: redactEventValue(payload),
      });
    }
    // Derived output may announce its file before the terminal sequence/receipt
    // is frozen. Deferred terminals reach this only when they are flushed.
    if (terminalType) this.prepareOutput?.(terminalType, payload);
    let prepared: PreparedTerminalEvent | void = undefined;
    let event = RunEventSchema.parse({
      seq: this.nextSeq,
      ts: nowIso(),
      run_id: this.runId,
      task_id: this.taskId,
      ...(this.threadId ? { thread_id: this.threadId } : {}),
      type,
      payload: redactEventValue(payload),
    });
    // Snapshot before terminal preparation: the hook may materialize sibling
    // artifacts, but the event file rollback boundary is the pre-hook state.
    const previousBytes = existsSync(this.path) ? statSync(this.path).size : null;
    if (terminal) {
      // Fence every re-entrant emit before the preparation hook, append, and
      // durable sink form one terminal commit. The fence is released only by
      // a complete rollback or after the terminal fully commits.
      this.terminalCommitInProgress = true;
      // Validate the exact redacted event before terminal preparation can
      // materialize a receipt for it. Keep the hook registered until the event
      // itself is durable so an append failure can retry the entire commit.
      try {
        prepared = this.beforeTerminal?.(terminalType, event.payload);
        // Terminal preparation may canonicalize facts after consulting immutable
        // artifacts. Commit the corresponding event type and payload as one
        // validated unit so the receipt, durable event, and live publication
        // cannot disagree.
        event = RunEventSchema.parse(
          prepared
            ? {
                ...event,
                type: prepared.type,
                payload: redactEventValue(prepared.payload),
              }
            : event,
        );
      } catch (error) {
        this.rollbackTerminal(previousBytes, prepared, error);
      }
    }
    if (terminal) {
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
    } else {
      appendLine(this.path, JSON.stringify(event));
      this.nextSeq += 1;
      this.onPersist?.(event);
      try {
        if (publish) this.onPublish?.(event);
      } catch {
        /* best-effort live observer */
      }
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

/** Shared reader for live terminal preparation and selected interrupted-run recovery. */
export function readRunEvents(path: string): { events: RunEvent[]; malformed: number } {
  const text = readTextSafe(path);
  if (text === null) return { events: [], malformed: 0 };
  const events: RunEvent[] = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(RunEventSchema.parse(JSON.parse(trimmed)));
    } catch {
      malformed += 1;
    }
  }
  return { events, malformed };
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
    payload: redactEventValue(payload),
  });
  appendLine(path, JSON.stringify(event));
  return event;
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

/** How much of a log's end `lastSeqInFile` reads before it scans the whole file. */
const LAST_SEQ_TAIL_BYTES = 64 * 1024;

/**
 * Highest `seq` already present in an events.jsonl file (0 for missing/empty).
 * Legacy lines without seq count by position so a continued log never reuses
 * a line number an SSE replayer may have already served as a fallback id.
 *
 * Seqs only grow within a log (its writer is the one owner and continues from
 * the tail when reopened), so the last line carries the highest one. When the
 * last 64 KiB hold that whole line and it carries a numeric seq, the tail
 * answers; a legacy or torn last line (valued by its position), a last line
 * longer than the window, or a read failure takes the full scan.
 */
export function lastSeqInFile(path: string): number {
  try {
    return lastSeqFromTail(path) ?? lastSeqByScan(path);
  } catch {
    return lastSeqByScan(path);
  }
}

/** The last non-blank line's numeric seq, or null when only a scan can tell. */
function lastSeqFromTail(path: string): number | null {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - LAST_SEQ_TAIL_BYTES);
    const window = Buffer.alloc(size - start);
    let end = readSync(fd, window, 0, window.length, start);
    for (;;) {
      const newline = end > 0 ? window.lastIndexOf(0x0a, end - 1) : -1;
      // Without a newline in the window the line may begin before it.
      if (newline < 0 && start > 0) return null;
      const line = window.toString("utf8", newline + 1, end).trim();
      if (line) return finiteSeq(line);
      if (newline < 0) return 0;
      end = newline;
    }
  } finally {
    closeSync(fd);
  }
}

function finiteSeq(line: string): number | null {
  try {
    const seq = (JSON.parse(line) as { seq?: unknown }).seq;
    return typeof seq === "number" && Number.isFinite(seq) ? seq : null;
  } catch {
    return null;
  }
}

function lastSeqByScan(path: string): number {
  const text = readTextSafe(path);
  if (text === null) return 0;
  let last = 0;
  let lineNo = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    lineNo += 1;
    try {
      const parsed = JSON.parse(trimmed) as { seq?: unknown };
      const seq =
        typeof parsed.seq === "number" && Number.isFinite(parsed.seq) ? parsed.seq : lineNo;
      if (seq > last) last = seq;
    } catch {
      if (lineNo > last) last = lineNo;
    }
  }
  return last;
}

function terminalEventInFile(path: string): boolean {
  const text = readTextSafe(path);
  if (text === null) return false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = RunEventSchema.parse(JSON.parse(trimmed));
      if (
        event.type === "run.completed" ||
        event.type === "run.failed" ||
        event.type === "run.blocked"
      ) {
        return true;
      }
    } catch {
      /* malformed evidence cannot establish a terminal fence */
    }
  }
  return false;
}

function redactEventValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactEventValue);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactEventValue(child);
  }
  return out;
}
