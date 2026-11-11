import {
  MCP_RUN_WAIT_EVENT_BYTES,
  MCP_RUN_WAIT_RESULT_BYTES,
  RunEvent,
  type McpRunWaitInput,
  type McpRunWaitResult,
} from "@claudexor/schema";
import { CliError, controlProblemError } from "./cli-error.js";
import { controlApiFetch, type ControlApiAddress } from "./live.js";

/** How one subscription ended; the caller maps it to a wake reason with snapshot facts. */
export type ObservationStop = "ended" | "limit" | "ready" | "timeout" | "aborted" | "disconnected";

export type Observation = Pick<
  McpRunWaitResult,
  "events" | "nextSeq" | "eventOmission" | "oversizedEvent"
> & {
  /** The returned page includes an `interaction.requested` event. */
  questionRequested: boolean;
  stop: ObservationStop;
};

export interface ObservationPlan {
  /** Last seq at the initial snapshot: every event up to it is already available. */
  fence: number;
  /** False for a zero wait: end at the fence instead of waiting for new events. */
  live: boolean;
  /** Bound of the whole event stage. */
  deadlineMs: number;
}

const streamId = (id: string): number => (/^\d+$/.test(id) ? Number(id) : NaN);

/**
 * One bounded subscription to the existing replay owner. Already available
 * events are read first, regardless of pending questions; a live wait then
 * continues by mode. No reconnect, status poll, or cursor advance over an
 * event that was not returned.
 */
export async function observeRunEvents(
  addr: ControlApiAddress,
  input: McpRunWaitInput,
  plan: ObservationPlan,
  hostSignal?: AbortSignal,
): Promise<Observation> {
  const result: Observation = {
    events: [],
    nextSeq: input.afterSeq,
    eventOmission: null,
    oversizedEvent: null,
    questionRequested: false,
    stop: "disconnected",
  };
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const stop = () => {
    controller.abort();
    // Cancel releases a pending read even on transports which do not wire fetch's signal.
    void reader?.cancel().catch(() => {});
  };
  const onAbort = () => {
    result.stop = "aborted";
    stop();
  };
  const timer = setTimeout(() => {
    result.stop = "timeout";
    stop();
  }, plan.deadlineMs);
  hostSignal?.addEventListener("abort", onAbort, { once: true });
  if (hostSignal?.aborted) onAbort();
  let eventBytes = 2; // JSON array delimiters
  let buffer = "";
  let data: string[] = [];
  let id = "";
  let name = "message";
  let frameBytes = 0;
  // Everything available at the fence has been returned.
  const replayed = () => result.nextSeq >= plan.fence;
  const omit = (
    reason: NonNullable<Observation["eventOmission"]>,
    oversized: Observation["oversizedEvent"] = null,
  ): true => {
    result.eventOmission = reason;
    result.oversizedEvent = oversized;
    result.stop = "limit";
    return true;
  };
  /** A frame larger than the stream cap: name its stream id when it has one. */
  const overflow = (): true => {
    const seq = streamId(id);
    if (!plan.live && seq > plan.fence) {
      result.stop = "ready";
      return true;
    }
    return omit(
      "oversized_frame",
      Number.isSafeInteger(seq) && seq > result.nextSeq ? { seq, type: name } : null,
    );
  };
  const dispatch = (): boolean => {
    if (name === "end") {
      result.stop = "ended";
      // The stream ends only for a terminal run. Ending with nothing after the
      // cursor below the fence means it cannot serve the rest (such as a torn
      // last line); say so rather than leave a fence no read can reach.
      if (result.events.length === 0 && result.nextSeq < plan.fence)
        result.eventOmission = "stream_ended";
      return true;
    }
    if (data.length === 0) return false;
    const seq = streamId(id);
    if (!Number.isSafeInteger(seq) || seq <= 0) return omit("invalid_event");
    if (seq <= result.nextSeq) return false;
    if (!plan.live && seq > plan.fence) {
      result.stop = "ready";
      return true;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data.join("\n"));
    } catch {
      return omit("invalid_event");
    }
    const parsed = RunEvent.safeParse(raw);
    if (!parsed.success || (parsed.data.seq !== undefined && parsed.data.seq !== seq))
      return omit("invalid_event");
    const item = { seq, event: parsed.data };
    const itemBytes = Buffer.byteLength(JSON.stringify(item));
    const bytes = itemBytes + (result.events.length ? 1 : 0);
    if (eventBytes + bytes > MCP_RUN_WAIT_EVENT_BYTES) {
      // An event no page can hold is named for claudexor_run_event_read.
      const alone = 2 + itemBytes > MCP_RUN_WAIT_EVENT_BYTES;
      return omit("byte_limit", alone ? { seq, type: parsed.data.type } : null);
    }
    result.events.push(item);
    result.nextSeq = seq;
    eventBytes += bytes;
    if (parsed.data.type === "interaction.requested") result.questionRequested = true;
    return result.events.length >= input.maxEvents ? omit("event_limit") : false;
  };
  /** Mode rules, applied once a received chunk is drained. */
  const ready = (): boolean => {
    if (!replayed()) return false;
    if (!plan.live) return true;
    if (input.wake === "event") return result.events.length > 0;
    return result.questionRequested;
  };
  try {
    if (controller.signal.aborted) return result;
    const response = await controlApiFetch(
      addr,
      `/runs/${encodeURIComponent(input.runId)}/events`,
      {
        method: "GET",
        headers: { Accept: "text/event-stream", "Last-Event-ID": String(input.afterSeq) },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw controlProblemError(
        response.status,
        await response.json().catch(() => ({})),
        `run event stream failed (HTTP ${response.status})`,
      );
    }
    if (!response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
      await response.body?.cancel();
      omit("invalid_event");
      return result;
    }
    reader = response.body.getReader();
    if (controller.signal.aborted) return result;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (;;) {
      const chunk = await reader.read();
      if (controller.signal.aborted) return result;
      if (chunk.done) {
        result.stop = "disconnected";
        return result;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        frameBytes += Buffer.byteLength(line) + 1;
        if (frameBytes > MCP_RUN_WAIT_RESULT_BYTES) {
          overflow();
          return result;
        }
        if (line === "") {
          if (dispatch()) return result;
          data = [];
          id = "";
          name = "message";
          frameBytes = 0;
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "data") data.push(value);
          else if (field === "id") id = value;
          else if (field === "event") name = value;
        }
      }
      if (frameBytes + Buffer.byteLength(buffer) > MCP_RUN_WAIT_RESULT_BYTES) {
        overflow();
        return result;
      }
      if (ready()) {
        result.stop = "ready";
        return result;
      }
    }
  } catch (error) {
    if (controller.signal.aborted) return result;
    // A typed HTTP refusal must remain a refusal (not a successful empty read).
    if (error instanceof CliError) throw error;
    return { ...result, stop: "disconnected" };
  } finally {
    clearTimeout(timer);
    hostSignal?.removeEventListener("abort", onAbort);
    controller.abort();
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
