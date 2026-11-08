import { z } from "zod/v3";
import { DeferredMessageProjection } from "./deferred-message.js";
import { ControlPendingInteraction, ControlRunState } from "./control.js";
import { RunEvent } from "./events.js";

export const MCP_RUN_WAIT_EVENT_BYTES = 65_536;
export const MCP_RUN_WAIT_INTERACTION_BYTES = 32_768;
export const MCP_RUN_WAIT_RESULT_BYTES = 131_072;

const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const McpRunWaitInput = z
  .object({
    runId: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .describe("Run id, or the job id of an accepted launch that may still be queued."),
    afterSeq: sequence
      .default(0)
      .describe(
        "Last durable event seq already consumed (the previous nextSeq), never snapshotSeq.",
      ),
    waitMs: z
      .number()
      .int()
      .min(0)
      .max(50_000)
      .default(25_000)
      .describe(
        "Bound of the event stage. Zero never waits for new events: it returns the bounded page already available at the snapshot fence, read within a separate 5s budget. Daemon discovery and each snapshot read have their own 5s budgets, so one call can take up to waitMs plus about 15s.",
      ),
    maxEvents: z.number().int().min(1).max(200).default(50),
    wake: z
      .enum(["batch", "event"])
      .default("batch")
      .describe(
        "batch (default): collect events until the page fills, it includes a question event (interaction.requested, also one written before the wait), the run ends, or waitMs elapses. event: return as soon as any event is available. A pending question whose event is not in the page is reported in both modes but never ends a wait by itself.",
      ),
  })
  .strict();
export type McpRunWaitInput = z.infer<typeof McpRunWaitInput>;

export const McpRunWaitResult = z
  .object({
    deferredMessage: DeferredMessageProjection.nullable()
      .optional()
      .describe(
        "Snapshot only: terminal wakeReason refers to the predecessor, never proves draft resolution.",
      ),
    runId: z
      .string()
      .describe("Canonical run id; a queued job id converges to its run id once the run binds."),
    status: ControlRunState,
    snapshotSeq: sequence.describe(
      "Last event seq at the latest snapshot: a fence, not a cursor. nextSeq below it means events are already written; eventOmission stream_ended reports when the stream cannot serve them.",
    ),
    snapshotPhase: z.enum(["before_wait", "after_wait"]),
    snapshotProblem: z
      .enum(["snapshot_unavailable"])
      .nullable()
      .describe(
        "A failed final read leaves the explicitly labelled initial snapshot, never invented current state.",
      ),
    nextSeq: sequence.describe(
      "Last returned event seq, or afterSeq when none was returned. It never advances over an unreturned event.",
    ),
    events: z
      .array(z.object({ seq: sequence, event: RunEvent }).strict())
      .max(200)
      .describe(
        "Ordered new events, at most 65536 UTF-8 JSON bytes including envelopes. Legacy events retain their body and use the stream id as seq.",
      ),
    eventOmission: z
      .enum(["event_limit", "byte_limit", "oversized_frame", "invalid_event", "stream_ended"])
      .nullable()
      .describe(
        "Why the page stopped early: event_limit or byte_limit (more events may follow; resume with nextSeq), oversized_frame (the next frame exceeds the 131072-byte stream frame cap), invalid_event (the next frame failed validation and is never skipped), stream_ended (the stream, which ends only for a terminal run, served nothing after nextSeq although snapshotSeq is higher, such as a last line left unterminated by a crash; nothing was skipped, and the same call returns the same page until the log changes, so stop there). Null means no limit was reached, not that replay is exhausted.",
      ),
    oversizedEvent: z
      .object({
        seq: sequence.describe("Durable seq of the next unread event."),
        type: z.string().describe("Event type the daemon stream names for it."),
      })
      .strict()
      .nullable()
      .describe(
        "The next unread event after nextSeq cannot fit one page. Read its exact bytes in parts with claudexor_run_event_read, then resume with afterSeq set to its seq. Null otherwise.",
      ),
    pendingInteractions: z
      .array(ControlPendingInteraction)
      .describe(
        "Current snapshot's pending questions, bounded to 32768 UTF-8 JSON bytes; claudexor_run_interactions returns complete bodies. They never hold back events.",
      ),
    pendingInteractionCount: sequence,
    omittedInteractions: sequence,
    wakeReason: z
      .enum(["events", "interactions", "terminal", "timeout", "aborted", "disconnected"])
      .describe(
        "Why this observation returned, by precedence: aborted (this read was cancelled; the worker continues), terminal (the run is terminal; events may still follow nextSeq unless eventOmission is stream_ended), interactions (this page includes a question event, or oversizedEvent is a question too large for any page; claudexor_run_interactions returns it complete), events (event mode, a completed zero-wait page, or a page, even an empty one, stopped by event_limit, byte_limit, oversized_frame or invalid_event), timeout (waitMs elapsed, possibly with a partial batch), disconnected (the stream ended early; never completion).",
      ),
  })
  .strict()
  .describe(
    "Read-only run observation, at most 131072 UTF-8 JSON bytes: at most two snapshot reads and one stream subscription, no automatic reconnect or worker cancellation. Events already available at the snapshot fence are returned before any wait, whether or not a question is pending. Resume with nextSeq.",
  );
export type McpRunWaitResult = z.infer<typeof McpRunWaitResult>;
