import type { RunEvent, RunEventType, RunTelemetry } from "@claudexor/schema";

/* The event log's public types (moved from index.ts unchanged). */

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

export interface EventLogOptions {
  /**
   * Queue each line on the ordered appender instead of writing it inline: `emit`
   * returns once the line is queued, and the line's `onPersist` and `onPublish`
   * run when it lands. The terminal commits through `emitTerminal`.
   */
  queued?: boolean;
}
