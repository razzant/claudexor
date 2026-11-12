/**
 * Recorded execution facts of one run's event log, shared by every
 * continuation reader: which harness starts were accepted (not refused by a
 * mismatched identity handshake), which continued try's receipt belongs to
 * which start, which attempt carries the latest work and how complete a
 * native session's history is. A start and its receipt are joined on the
 * attempt, the process session id and event order, never on the vendor's
 * native id alone or on a later start. Directory names and capsule mtimes
 * are not execution facts.
 */
import { RunContinuityReceipt, type RunEvent } from "@claudexor/schema";

export interface RecordedStart {
  index: number;
  attemptId: string;
  sessionId: string | null;
  nativeSessionId: string | null;
}

export interface RecordedReceipt {
  index: number;
  attemptId: string;
  sessionId: string | null;
  receipt: RunContinuityReceipt;
}

export interface RunExecutionFacts {
  /** Attempts with harness events, in first-event order. */
  attempts: string[];
  /** Attempts that recorded agent progress (a tool call or result, an edit, reasoning
   * text) or a typed final answer. */
  progressed: Set<string>;
  /** Starts not refused by their own identity handshake, in event order. */
  accepted: RecordedStart[];
  receipts: RecordedReceipt[];
  /** The run recorded work of its own in its events: a tool call or edit, or
   * output its retained-output projection keeps (assistant text, a captured file). */
  recordedWork: boolean;
  /** The receipt the continued try of this start settled with, when any. */
  receiptOf(start: RecordedStart): RecordedReceipt | null;
}

/**
 * The same facts accumulated event by event, so a bounded event fold (run
 * detail's) can keep them between reads and add only appended events.
 */
export interface ExecutionFold {
  attempts: string[];
  progressed: Set<string>;
  starts: RecordedStart[];
  receipts: RecordedReceipt[];
  recordedWork: boolean;
  /** A terminal row was seen: retained output ends there. */
  ended: boolean;
  /** Position of the next event. */
  next: number;
}

const TOOL_PROGRESS = new Set(["tool_call", "tool_result", "file_change", "patch_produced"]);
const TERMINAL_ROWS = new Set(["run.completed", "run.failed", "run.blocked"]);

export function emptyExecutionFold(): ExecutionFold {
  return {
    attempts: [],
    progressed: new Set(),
    starts: [],
    receipts: [],
    recordedWork: false,
    ended: false,
    next: 0,
  };
}

/** A copy a later event can extend without changing `fold`. */
export function copyExecutionFold(fold: ExecutionFold): ExecutionFold {
  return {
    ...fold,
    attempts: [...fold.attempts],
    progressed: new Set(fold.progressed),
    starts: [...fold.starts],
    receipts: [...fold.receipts],
  };
}

/** Output the retained-output projection keeps (`retainedOutput`): a captured
 * produced file or non-empty assistant text that is not an auth-switch notice. */
function retainsOutput(type: unknown, payload: Record<string, unknown>): boolean {
  if (type === "output.ready") {
    const [root, attempt, directory, ...relative] = String(payload["path"] ?? "").split("/");
    return (
      payload["kind"] === "artifact" &&
      root === "attempts" &&
      !!attempt &&
      directory === "produced" &&
      !!relative.join("/")
    );
  }
  const nested = payload["payload"] as Record<string, unknown> | null | undefined;
  return (
    type === "harness.event" &&
    payload["type"] === "message" &&
    nested?.["auth_switched"] !== true &&
    typeof payload["text"] === "string" &&
    payload["text"].trim() !== ""
  );
}

export function addExecutionEvent(
  fold: ExecutionFold,
  event: { type?: unknown; payload?: unknown },
): void {
  const index = fold.next++;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  if (TERMINAL_ROWS.has(String(event.type))) fold.ended = true;
  if (!fold.ended && retainsOutput(event.type, payload)) fold.recordedWork = true;
  const attemptId = typeof payload["attempt_id"] === "string" ? payload["attempt_id"] : null;
  const sessionId = typeof payload["session_id"] === "string" ? payload["session_id"] : null;
  if (attemptId === null) return;
  if (event.type === "run.continuity") {
    const receipt = RunContinuityReceipt.safeParse(payload["receipt"]).data;
    if (receipt) fold.receipts.push({ index, attemptId, sessionId, receipt });
    return;
  }
  if (event.type !== "harness.event") return;
  if (!fold.attempts.includes(attemptId)) fold.attempts.push(attemptId);
  const type = String(payload["type"]);
  if (type === "tool_call" || type === "file_change") fold.recordedWork = true;
  // The controller's own "acted" facts: agent progress or a typed final answer
  // (a crashed try's narration is evidence, not progress).
  const text = typeof payload["text"] === "string" ? payload["text"].trim() : "";
  if (
    TOOL_PROGRESS.has(type) ||
    (type === "thinking" && text) ||
    (type === "message" && text && payload["final"] === true)
  )
    fold.progressed.add(attemptId);
  if (type !== "started") return;
  const nested = payload["payload"] as Record<string, unknown> | null | undefined;
  const native = nested?.["native_session_id"];
  fold.starts.push({
    index,
    attemptId,
    sessionId,
    nativeSessionId: typeof native === "string" && native ? native : null,
  });
}

export function executionFactsOf(fold: ExecutionFold): RunExecutionFacts {
  const { attempts, progressed, receipts, recordedWork } = fold;
  const receiptOf = (start: RecordedStart): RecordedReceipt | null =>
    start.sessionId === null
      ? null
      : (receipts.find(
          (entry) =>
            entry.index > start.index &&
            entry.attemptId === start.attemptId &&
            entry.sessionId === start.sessionId,
        ) ?? null);
  const accepted = fold.starts.filter(
    (start) => !receiptOf(start)?.receipt.identityCheck.startsWith("mismatch"),
  );
  return { attempts, progressed, accepted, receipts, recordedWork, receiptOf };
}

export function runExecutionFacts(events: readonly RunEvent[]): RunExecutionFacts {
  const fold = emptyExecutionFold();
  for (const event of events) addExecutionEvent(fold, event);
  return executionFactsOf(fold);
}

/**
 * Attempts of the run whose recorded work the held session never received:
 * every attempt but its own, except those a packet of this run briefed it
 * with. Only a successor's attempt is so briefed (its first try's receipt is
 * a packet), and a successor runs a single candidate whose attempts follow one
 * another (admission), so every attempt recorded before it was in that packet.
 * Event timing never decides lineage: another candidate of a concurrent run
 * stays uncovered, separate evidence.
 */
export function uncoveredAttempts(facts: RunExecutionFacts, heldAttemptId: string): string[] {
  const at = facts.attempts.indexOf(heldAttemptId);
  if (at < 0) return [];
  const briefed = facts.receipts.some(
    ({ attemptId, receipt }) =>
      attemptId === heldAttemptId && receipt.tryIndex === 0 && receipt.carrier === "packet",
  );
  return facts.attempts.filter((_, i) => i !== at && !(briefed && i < at));
}

/**
 * The attempt whose session carries the run's latest work: the newest accepted
 * start of an attempt that made progress, else the newest accepted start. A
 * later attempt that never started, or started and did nothing, cannot evict it.
 */
export function carryingAttempt(facts: RunExecutionFacts): string | null {
  const started = facts.accepted.map((start) => start.attemptId);
  return started.findLast((id) => facts.progressed.has(id)) ?? started.at(-1) ?? null;
}

/** A continued try that started was handed its notice and caller text. */
export function continuedTryStarted(facts: RunExecutionFacts, firstTryOnly = false): boolean {
  return facts.accepted.some((start) => {
    const settled = facts.receiptOf(start)?.receipt;
    return settled !== undefined && (!firstTryOnly || settled.tryIndex === 0);
  });
}

/**
 * History quality of the native session `held` names, from this run's
 * records: the receipt of the try that first started it (packet-born is
 * partial; a native resume keeps that receipt's memory), the receipt of a
 * seeded native first try that never started, or full for the first
 * attempt's own session of a run that continues nothing. Anything else is
 * unknown, never a guessed full or partial.
 */
export function recordedSessionMemory(
  facts: RunExecutionFacts,
  held: { attemptId: string; nativeSessionId: string },
  continuesEarlierRun: boolean,
): RunContinuityReceipt["memory"] {
  const born = facts.accepted.find((start) => start.nativeSessionId === held.nativeSessionId);
  const receipt = born
    ? facts.receiptOf(born)?.receipt
    : facts.receipts.find(
        (entry) =>
          entry.attemptId === held.attemptId &&
          entry.receipt.tryIndex === 0 &&
          (entry.receipt.carrier === "native" || entry.receipt.carrier === "native_moved"),
      )?.receipt;
  if (receipt) return receipt.carrier === "packet" ? "partial" : receipt.memory;
  return born && !continuesEarlierRun && born.attemptId === facts.attempts[0] ? "full" : "unknown";
}
