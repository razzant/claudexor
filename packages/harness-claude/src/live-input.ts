import type { ChildStdin, LiveMessageResult } from "@claudexor/core";
import type { HarnessEvent } from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";
import { isResultFrame, isSuccessResultFrame, userMessageFrame } from "./interactive.js";

type Json = any;

/**
 * Live input into a running Claude Code stream-json session — the native
 * queue fold, recorded on Claude Code 2.1.283 (`--replay-user-messages`):
 *
 * - a user frame `{type:"user", message, parent_tool_use_id:null, uuid}` written
 *   to the live stdin while a tool runs is QUEUED at once
 *   (`{type:"command_lifecycle", command_uuid, state:"queued"}` within ~10 ms) and
 *   CONSUMED inside the same turn right after the current tool batch: the CLI
 *   echoes `{type:"user", isReplay:true, uuid}`, emits `command_lifecycle
 *   state:"started"`, the model acts, `state:"completed"` precedes the result,
 *   and `result.user_message_uuids` lists every consumed uuid;
 * - a frame that arrives while the model composes its FINAL text stays queued
 *   and runs as the NEXT native turn of the same process right after the first
 *   `result` — with stdin still open: a second `system/init`, the echo, a
 *   second `result`, then exit. `closeStdinOn` therefore holds stdin open
 *   while a message is `queued|started` or a run-owned background task is open
 *   (`system/task_started` … `system/task_notification`), and the parser folds
 *   the second turn into the same run (one `started`, cost delta per result);
 * - the initial prompt frame carries its own uuid (`onIo`'s `promptUuid`; the
 *   recorded result lists it, its `completed` follows). Once Claude Code shows
 *   it identifies commands by uuid (a lifecycle frame names the prompt, or a
 *   result names only commands this session never sent: a resumed session's
 *   earlier turn, #536, in either order), only a result naming the prompt or
 *   its own terminal lifecycle state ends it, and stdin stays open until then.
 *   An error result naming no command ends it as any first result did, and so
 *   does the first result of a CLI that never shows such identity. A success
 *   result naming no command does not end a prompt Claude Code identified; the
 *   run's own time limits bound that wait;
 * - a result that names only commands this session never sent, while the prompt
 *   still runs, belongs to that other turn and decides nothing about this run.
 *   Its spend stays on the run; everything else it reports becomes a
 *   `foreign_result` status, never this run's error, answer or context limit.
 *   A result naming the prompt or a live message keeps its meaning, and so does
 *   one naming no command or arriving once the prompt has ended, which may be
 *   this run's own later work.
 *
 * Receipts are typed from the adapter's own state, never from vendor prose
 * (INV-049): `accepted` = the `queued` lifecycle frame for this uuid;
 * `delivered` = the replay echo, `started`, `completed` or the result's
 * `user_message_uuids`; `delivery_unknown` = no `queued` within the acceptance
 * deadline (`response_timeout`; the message write is fire-and-forget, so a
 * dead pipe surfaces this way) or a session closed with the
 * message still unreceipted (`transport_lost`); `rejected` = a
 * `cancelled|discarded|refused` lifecycle state before consumption. A message
 * never cancels or fails the run.
 */
export const CLAUDE_LIVE_ACCEPT_DEADLINE_MS = 2_000;

/** The one consumption receipt; the same code Codex emits for its steer echo. */
export const LIVE_INPUT_DELIVERED = "live_input_delivered";
export const LIVE_INPUT_REFUSED = "live_input_refused";
/** The diagnostic status code of a result that answered another turn. */
export const FOREIGN_RESULT = "foreign_result";

type PendingState = "sent" | "queued" | "started" | "unknown" | "consumed" | "refused";
/** Forward-only lifecycle: an echo that beats `queued` must not be downgraded by it.
 * `unknown` = the acceptance deadline passed (the message may still land; a late
 * echo is still receipted) and it no longer holds stdin open. */
const RANK: Record<PendingState, number> = {
  sent: 0,
  queued: 1,
  started: 2,
  unknown: 2,
  consumed: 3,
  refused: 3,
};

interface Pending {
  state: PendingState;
  settled: boolean;
  settle: (result: LiveMessageResult) => void;
  /** The single `live_input_delivered` status event was emitted. */
  announced: boolean;
}

/** The initial prompt this process answers: the uuid of its stdin frame. */
interface CurrentPrompt {
  uuid: string;
  /** Claude Code identifies commands by uuid here (its lifecycle named the
   * prompt, or a result named only foreign commands), so it will name this one. */
  reported: boolean;
  /** A result named it, its lifecycle reached a terminal state, or an error
   * result named no command at all. */
  ended: boolean;
}

interface LiveSession {
  io: ChildStdin | null;
  pending: Map<string, Pending>;
  resultsSeen: number;
  openBackgroundTasks: Set<string>;
  prompt: CurrentPrompt | null;
}

/** Lifecycle states after which a stdin command runs no more. */
const COMMAND_END_STATES = new Set(["completed", "cancelled", "discarded", "refused"]);

export interface ClaudeLiveInput {
  /**
   * runloop `session.onIo` seam: the live handle after spawn (the initial
   * frames are written by then; `promptUuid` is the uuid of that prompt frame),
   * `null` once stdin closed.
   */
  onIo(io: ChildStdin | null, sessionId: string, promptUuid?: string): void;
  /**
   * Stream observer (runs inside the adapter's parseEvent): correlates the
   * receipts and lifecycle facts of this session and appends the typed
   * receipt/refusal status events to the parser's events. The events of a
   * result that answered another turn come back rebuilt as diagnostics.
   */
  observe(obj: Json, events: HarnessEvent[] | null, sessionId: string): HarnessEvent[] | null;
  /** runloop `session.closeStdinOn`: true only when nothing keeps the session open. */
  closeStdinOn(sessionId: string, obj: Json): boolean;
  /** `HarnessAdapter.message` for this adapter. */
  message(
    sessionId: string,
    input: { messageId: string; text: string },
  ): Promise<LiveMessageResult>;
}

export interface ClaudeLiveInputOptions {
  /** Bound on the `queued` lifecycle frame after the write (tests shorten it). */
  acceptDeadlineMs?: number;
}

function lifecycleUuid(obj: Json): string | null {
  return typeof obj?.command_uuid === "string" ? obj.command_uuid : null;
}

function taskId(obj: Json): string | null {
  return typeof obj?.task_id === "string" ? obj.task_id : null;
}

/** One event of a result that answered another turn: usage stays this run's
 * accounting; the rest is rebuilt as a plain status, so no field of it can be
 * read as this run's failure, answer, work report, retry class or context
 * limit. An error's text is a diagnostic and stays masked (INV-146). */
function foreignResultEvent(event: HarnessEvent, commands: string[]): HarnessEvent {
  if (event.type === "usage") return event;
  return {
    type: "status",
    session_id: event.session_id,
    ts: event.ts,
    text:
      event.type === "error"
        ? redactSecrets(event.error ?? event.text ?? "error result")
        : (event.text ?? event.context?.cause ?? event.type),
    payload: { code: FOREIGN_RESULT, event_type: event.type, user_message_uuids: commands },
  };
}

export function createClaudeLiveInput(options: ClaudeLiveInputOptions = {}): ClaudeLiveInput {
  const acceptDeadlineMs = options.acceptDeadlineMs ?? CLAUDE_LIVE_ACCEPT_DEADLINE_MS;
  const sessions = new Map<string, LiveSession>();

  const advance = (pending: Pending, state: PendingState): boolean => {
    if (RANK[state] <= RANK[pending.state]) return false;
    pending.state = state;
    return true;
  };

  const deliveredEvent = (sessionId: string, messageId: string): HarnessEvent => ({
    type: "status",
    session_id: sessionId,
    ts: nowIso(),
    text: `live message ${messageId} consumed by the running turn`,
    payload: { code: LIVE_INPUT_DELIVERED, message_id: messageId },
  });

  /** Consumption observed (echo / started / completed / result uuid): settle
   * a still-open promise as delivered and announce exactly once. */
  const consumed = (
    session: LiveSession,
    sessionId: string,
    messageId: string,
    state: "started" | "consumed",
    receipts: HarnessEvent[],
  ): void => {
    const pending = session.pending.get(messageId);
    if (!pending || pending.state === "refused") return;
    advance(pending, state);
    pending.settle({ outcome: "delivered" });
    if (pending.announced) return;
    pending.announced = true;
    receipts.push(deliveredEvent(sessionId, messageId));
  };

  const hasPendingTurnWork = (session: LiveSession): boolean => {
    // The prompt is still running: a result that does not name it (a resumed
    // session's earlier turn) is not its own result.
    if (session.prompt?.reported && !session.prompt.ended) return true;
    for (const pending of session.pending.values()) {
      if (pending.state === "sent" || pending.state === "queued" || pending.state === "started")
        return true;
    }
    return false;
  };

  return {
    onIo(io, sessionId, promptUuid) {
      if (io) {
        sessions.set(sessionId, {
          io,
          pending: new Map(),
          resultsSeen: 0,
          openBackgroundTasks: new Set(),
          prompt: promptUuid ? { uuid: promptUuid, reported: false, ended: false } : null,
        });
        return;
      }
      // stdin is closed: nothing can be written any more, and the correlations
      // end with the session — a message still awaiting its `queued` frame may
      // have landed (the CLI drains its queue past EOF), so it is unknown.
      const session = sessions.get(sessionId);
      if (!session) return;
      session.io = null;
      for (const pending of session.pending.values())
        pending.settle({ outcome: "delivery_unknown", reason: "transport_lost" });
      sessions.delete(sessionId);
    },

    observe(obj, events, sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return events;
      const receipts: HarnessEvent[] = [];
      const type = obj?.type;
      if (type === "command_lifecycle") {
        const uuid = lifecycleUuid(obj);
        const pending = uuid ? session.pending.get(uuid) : undefined;
        const state = obj.state;
        const prompt = session.prompt;
        if (prompt && uuid === prompt.uuid) {
          prompt.reported = true;
          if (COMMAND_END_STATES.has(state)) prompt.ended = true;
        }
        if (pending && uuid && pending.state !== "refused") {
          if (state === "queued") {
            if (advance(pending, "queued")) pending.settle({ outcome: "accepted" });
          } else if (state === "started") {
            consumed(session, sessionId, uuid, "started", receipts);
          } else if (state === "completed") {
            consumed(session, sessionId, uuid, "consumed", receipts);
          } else if (
            (state === "cancelled" || state === "discarded" || state === "refused") &&
            !pending.announced
          ) {
            pending.state = "refused";
            // An explicit vendor refusal of THIS submission; a promise already
            // settled as accepted keeps its receipt (the refusal is the status).
            // Once consumption was announced, a later lifecycle refusal is
            // ordering noise: the model already acted on the text.
            pending.settle({ outcome: "rejected", reason: "rpc_refused" });
            receipts.push({
              type: "status",
              session_id: sessionId,
              ts: nowIso(),
              text: `live message ${uuid} ${String(state)} by the running session`,
              payload: { code: LIVE_INPUT_REFUSED, message_id: uuid, state },
            });
          }
        }
      } else if (type === "user" && obj.isReplay === true) {
        // The replay echo of a stdin user frame: a pending uuid is consumed; the
        // initial prompt's echo (or any foreign uuid) is not ours to receipt.
        if (typeof obj.uuid === "string")
          consumed(session, sessionId, obj.uuid, "started", receipts);
      } else if (type === "system" && obj.subtype === "task_started") {
        // A run-owned BACKGROUND task keeps the session open past the result;
        // foreground tools emit the same frame with is_backgrounded:false.
        const id = taskId(obj);
        // Only the CLI's explicit claim holds: task types other than local_bash /
        // local_agent omit the field entirely (monitor, workflow, …) and must
        // never strand a finished run on an open stdin.
        if (id && obj.is_backgrounded === true) session.openBackgroundTasks.add(id);
      } else if (type === "system" && obj.subtype === "task_notification") {
        const id = taskId(obj);
        if (id) session.openBackgroundTasks.delete(id);
      } else if (type === "result") {
        session.resultsSeen += 1;
        const uuids: unknown[] = Array.isArray(obj.user_message_uuids)
          ? obj.user_message_uuids
          : [];
        const named = uuids.filter((uuid): uuid is string => typeof uuid === "string");
        const prompt = session.prompt;
        if (prompt && !prompt.ended) {
          if (named.includes(prompt.uuid)) prompt.ended = true;
          // Only commands this session never sent: another turn's result, so
          // none of them is pending and there is no receipt to add.
          else if (named.length > 0 && !named.some((uuid) => session.pending.has(uuid))) {
            prompt.reported = true;
            return events && events.map((event) => foreignResultEvent(event, named));
          } else if (named.length === 0 && !isSuccessResultFrame(obj)) prompt.ended = true;
        }
        for (const uuid of named) consumed(session, sessionId, uuid, "consumed", receipts);
      }
      if (receipts.length === 0) return events;
      return [...(events ?? []), ...receipts];
    },

    closeStdinOn(sessionId, obj) {
      const session = sessions.get(sessionId);
      if (!session) return isResultFrame(obj);
      if (session.resultsSeen === 0) return false;
      return !hasPendingTurnWork(session) && session.openBackgroundTasks.size === 0;
    },

    message(sessionId, input) {
      const session = sessions.get(sessionId);
      if (!session?.io)
        return Promise.resolve({ outcome: "not_active", reason: "no_live_session" });
      const io = session.io;
      return new Promise<LiveMessageResult>((resolve) => {
        let timer: NodeJS.Timeout | null = null;
        const pending: Pending = {
          state: "sent",
          settled: false,
          announced: false,
          settle: (result) => {
            if (pending.settled) return;
            pending.settled = true;
            if (timer) clearTimeout(timer);
            resolve(result);
          },
        };
        // Registered BEFORE the write: an echo that beats `queued` still correlates.
        session.pending.set(input.messageId, pending);
        timer = setTimeout(() => {
          // No `queued` within the bound: unknown (the CLI may still take it), and
          // the message stops holding stdin; a late echo is still receipted.
          advance(pending, "unknown");
          pending.settle({ outcome: "delivery_unknown", reason: "response_timeout" });
        }, acceptDeadlineMs);
        try {
          io.write(userMessageFrame(input.text, input.messageId));
        } catch {
          pending.settle({ outcome: "delivery_unknown", reason: "transport_lost" });
        }
      });
    },
  };
}
