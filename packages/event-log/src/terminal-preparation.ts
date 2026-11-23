import { existsSync, statSync, truncateSync, unlinkSync } from "node:fs";
import { RunEvent, type FinalMessagesOutcome } from "@claudexor/schema";
import type { PreparedTerminalEvent, TerminalStagingHook } from "./types.js";

export interface PreparedTerminal {
  event: RunEvent;
  prepared: PreparedTerminalEvent | void;
  /** The event file's size before preparation: the rollback boundary. */
  previousBytes: number | null;
}

export function assertNoPendingEventWrites(unlanded: readonly RunEvent[] | null): void {
  if (!unlanded?.length) return;
  throw Object.assign(
    new Error("a queued event log commits a terminal synchronously only with no writes in flight"),
    { code: "terminal_writes_in_flight" },
  );
}

export async function stageTerminal(
  stage: TerminalStagingHook,
  terminal: PreparedTerminal,
): Promise<void> {
  try {
    await stage(terminal.event, terminal.prepared?.telemetry ?? null);
  } catch {
    // The synchronous commit writes any bytes that could not be staged.
  }
}

/** Ordinary events may land or be lost while the frozen terminal is staged. */
export function terminalEventForCommit(
  event: RunEvent,
  seq: number,
  revised: FinalMessagesOutcome | undefined,
): RunEvent {
  if (event.seq === seq && !revised) return event;
  const payload = revised ? { ...event.payload, final_messages: revised } : event.payload;
  return RunEvent.parse({ ...event, seq, payload });
}

export function eventFileBytes(path: string): number | null {
  return existsSync(path) ? statSync(path).size : null;
}

/** Undo both sides of preparation, even if restoring the event file fails. */
export function undoTerminalPreparation(
  path: string,
  previousBytes: number | null,
  prepared: PreparedTerminalEvent | void,
): unknown[] {
  const errors: unknown[] = [];
  try {
    if (previousBytes === null) {
      if (existsSync(path)) unlinkSync(path);
    } else if (existsSync(path) && statSync(path).size !== previousBytes) {
      truncateSync(path, previousBytes);
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    prepared?.rollback?.();
  } catch (error) {
    errors.push(error);
  }
  return errors;
}
