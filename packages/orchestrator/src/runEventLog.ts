import { EventLog } from "@claudexor/event-log";
import type { RunEvent } from "@claudexor/schema";

interface RunEventLogInput {
  threadId?: string;
  onEventPersist?: (event: RunEvent) => void;
  onEvent?: (event: RunEvent) => void;
}

/** Keep durable-journal and live-observer callback ordering identical at every run entry point. */
export function createRunEventLog(
  eventsPath: string,
  runId: string,
  taskId: string,
  input: RunEventLogInput,
): EventLog {
  return new EventLog(
    eventsPath,
    runId,
    taskId,
    input.onEventPersist,
    input.threadId,
    input.onEvent,
  );
}

/**
 * Everything after EventLog construction and before `run.created` persists is
 * still pre-announce: a ledger or durable-sink refusal must escape without the
 * terminal safety net. Release live-writer ownership across that whole window
 * so a failed startup cannot strand the run path behind the duplicate-owner
 * fence.
 */
export function prepareRunAnnouncement<T>(log: EventLog, prepare: () => T): T {
  try {
    return prepare();
  } catch (error) {
    log.dispose();
    throw error;
  }
}
