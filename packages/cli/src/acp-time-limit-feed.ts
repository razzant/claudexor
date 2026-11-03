import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { COMMAND_OUTCOME_REFINED } from "@claudexor/schema";
import { controlApiFetch, type ControlApiAddress } from "./live.js";

/**
 * The stored harness events ACP streams: tool activity, i.e. calls, results and
 * #546 completion refinements (X1). Narration and thinking stay out: the turn's
 * answer reaches the client once, when the turn ends.
 */
function acpToolActivity(row: unknown): boolean {
  const event = row as { type?: unknown; payload?: Record<string, any> } | null;
  const kind = event?.payload?.["type"];
  return (
    event?.type === "harness.event" &&
    (kind === "tool_call" ||
      kind === "tool_result" ||
      (kind === "status" && event.payload?.["payload"]?.["code"] === COMMAND_OUTCOME_REFINED))
  );
}

/** One stored run event, or null for a line that is not JSON; such a row is not forwarded. */
function storedRow(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/** Replay the engine's timer notices and the run's tool activity to ACP, from the
 * run's own event stream, without inventing ACP-local timer or tool state. */
export class AcpTimeLimitFeed {
  private readonly abort = new AbortController();
  private task: Promise<void> | undefined;

  constructor(
    private readonly addr: ControlApiAddress,
    private readonly emit: (event: unknown) => void,
  ) {}

  start(runId: string): void {
    if (this.task) return;
    this.task = this.consume(runId).catch(() => {
      if (!this.abort.signal.aborted) this.warn();
    });
  }

  async close(drain: boolean): Promise<void> {
    if (!this.task) return;
    if (drain) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const complete = await Promise.race([
          this.task.then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), 2_000);
          }),
        ]);
        if (!complete) this.warn();
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    this.abort.abort();
    await this.task;
  }

  private warn(): void {
    this.emit({
      type: "surface.warning",
      payload: {
        message:
          "Live tool and time-limit updates unavailable; inspect the run's events with claudexor follow.",
      },
    });
  }

  private async consume(runId: string): Promise<void> {
    const response = await controlApiFetch(this.addr, `/runs/${encodeURIComponent(runId)}/events`, {
      headers: { Accept: "text/event-stream" },
      signal: this.abort.signal,
    });
    if (!response.ok || !response.body) throw new Error("Run events unavailable");
    const stream = Readable.fromWeb(response.body as never);
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    const stop = () => {
      // Destroying the HTTP body alone does not release readline's pending next().
      lines.close();
      stream.destroy();
    };
    this.abort.signal.addEventListener("abort", stop, { once: true });
    let type = "",
      data = "";
    try {
      if (this.abort.signal.aborted) return;
      for await (const line of lines) {
        if (line === "") {
          if (type === "end") return;
          if (type === "control.applied" && data) {
            const event = JSON.parse(data);
            if (event.type === "control.applied" && event.payload?.control?.kind === "time_limit")
              this.emit(event);
          } else if (type === "harness.event" && data) {
            const row = storedRow(data);
            if (acpToolActivity(row)) this.emit(row);
          }
          type = "";
          data = "";
        } else if (line.startsWith("event:")) type = line.slice(6).trim();
        else if (type === "control.applied" && line.startsWith("data:")) {
          data += `${line.slice(5).trimStart()}\n`;
          if (data.length > 32_000) throw new Error("Timer event too large");
        } else if (type === "harness.event" && line.startsWith("data:"))
          // The Control API writes each stored row as one line, so a frame holds
          // exactly one row: nothing accumulates across lines.
          data = line.slice(5).trimStart();
      }
      if (!this.abort.signal.aborted) throw new Error("Run events disconnected");
    } finally {
      this.abort.signal.removeEventListener("abort", stop);
      lines.close();
      stream.destroy();
    }
  }
}
