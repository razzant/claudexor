import type { ControlProblem, ModelFailureEvidence } from "@claudexor/schema";
import {
  errorClassName,
  responseEventType,
  responseRequestId,
  transportErrorCode,
} from "./response-diagnostics.js";

/** The slice of a model or image result this capture annotates. */
interface CapturedResult {
  outcome: string;
  problem: ControlProblem | null;
  failureEvidence?: ModelFailureEvidence;
}

/** One response reader's evidence, carried only by its existing private result. */
export class ResponseFailureCapture {
  stage = "fetch";
  receivedBytes = 0;
  eventCount = 0;
  lastEventType: string | null = null;
  terminalStatus: string | null = null;
  bodyComplete = false;
  private readonly chunks: Buffer[] = [];
  private errors: ModelFailureEvidence["errors"] = [];
  private causeCycle = false;
  private requestId: string | null = null;
  private readonly now: () => number;
  private responseStartedAtMs: number | null = null;
  private firstChunkAtMs: number | null = null;
  private lastChunkAtMs: number | null = null;
  private lastEventAtMs: number | null = null;
  private largestSilenceMs = 0;

  constructor(
    private readonly enabled = false,
    now: () => number = () => globalThis.performance?.now() ?? Date.now(),
  ) {
    this.now = now;
  }

  response(response: Response): void {
    this.responseStartedAtMs = this.now();
    this.requestId = responseRequestId(response.headers);
  }

  receive(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    const receivedAt = this.now();
    if (this.firstChunkAtMs === null) this.firstChunkAtMs = receivedAt;
    if (this.lastChunkAtMs !== null) {
      this.largestSilenceMs = Math.max(this.largestSilenceMs, receivedAt - this.lastChunkAtMs);
    }
    this.lastChunkAtMs = receivedAt;
    this.receivedBytes += chunk.byteLength;
    if (this.enabled) this.chunks.push(Buffer.from(chunk));
  }

  event(type: unknown): void {
    this.eventCount += 1;
    this.lastEventType = responseEventType(type);
    this.lastEventAtMs = this.now();
  }

  caught(error: unknown): void {
    const seen = new Set<object>();
    this.errors = [];
    this.causeCycle = false;
    const visit = (error: unknown): void => {
      const value =
        error !== null && typeof error === "object" ? (error as Record<string, unknown>) : null;
      if (value && seen.has(value)) {
        this.causeCycle = true;
        return;
      }
      if (value) seen.add(value);
      this.errors.push({
        name: typeof value?.name === "string" ? value.name : null,
        message: typeof value?.message === "string" ? value.message : String(error),
        stack: typeof value?.stack === "string" ? value.stack : null,
        code:
          typeof value?.code === "string" ||
          (typeof value?.code === "number" && Number.isFinite(value.code))
            ? value.code
            : null,
      });
      if (value && "cause" in value) visit(value.cause);
      if (error instanceof AggregateError) for (const member of error.errors) visit(member);
      if (value) seen.delete(value);
    };
    visit(error);
  }

  finish<T extends CapturedResult>(result: T): T {
    if (result.outcome === "completed" && result.problem === null) return result;
    const errorName = errorClassName(this.errors[0]?.name);
    let errorCode: string | number | null = null;
    for (const { code } of this.errors) {
      errorCode = typeof code === "string" ? transportErrorCode(code) : code;
      if (errorCode !== null) break;
    }
    const finishedAtMs = this.now();
    const trailingSilenceMs =
      this.lastChunkAtMs === null ? null : Math.max(0, finishedAtMs - this.lastChunkAtMs);
    const timing = {
      ...(this.responseStartedAtMs !== null && this.firstChunkAtMs !== null
        ? { timeToFirstChunkMs: Math.max(0, this.firstChunkAtMs - this.responseStartedAtMs) }
        : {}),
      ...(this.lastChunkAtMs !== null
        ? { silenceMs: Math.max(0, finishedAtMs - this.lastChunkAtMs) }
        : {}),
      ...(this.responseStartedAtMs !== null && this.lastChunkAtMs !== null
        ? { lastChunkAfterResponseMs: Math.max(0, this.lastChunkAtMs - this.responseStartedAtMs) }
        : {}),
      ...(trailingSilenceMs !== null
        ? { largestSilenceMs: Math.max(this.largestSilenceMs, trailingSilenceMs) }
        : {}),
      ...(this.responseStartedAtMs !== null && this.lastEventAtMs !== null
        ? {
            lastEventAfterResponseMs: Math.max(0, this.lastEventAtMs - this.responseStartedAtMs),
            eventSilenceMs: Math.max(0, finishedAtMs - this.lastEventAtMs),
          }
        : {}),
    };
    if (result.problem)
      result.problem = {
        ...result.problem,
        context: {
          ...result.problem.context,
          stage: this.stage,
          receivedBytes: this.receivedBytes,
          eventCount: this.eventCount,
          lastEventType: this.lastEventType,
          terminalStatus: this.terminalStatus,
          ...(this.requestId ? { requestId: this.requestId } : {}),
          ...(errorName ? { errorName } : {}),
          ...(errorCode != null ? { errorCode } : {}),
          ...timing,
        },
      };
    if (this.enabled)
      result.failureEvidence = {
        bodyBase64: Buffer.concat(this.chunks).toString("base64"),
        receivedBytes: this.receivedBytes,
        bodyComplete: this.bodyComplete,
        stage: this.stage,
        errors: this.errors,
        causeCycle: this.causeCycle,
      };
    return result;
  }

  /** HTTP refusal status stays authoritative even if its body reader fails. */
  async readRefusal(response: Response): Promise<unknown> {
    this.response(response);
    this.stage = "read";
    const chunks: Buffer[] = [];
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      if (!response.body) return null;
      reader = response.body.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          this.bodyComplete = true;
          break;
        }
        this.receive(chunk.value);
        chunks.push(Buffer.from(chunk.value));
      }
      this.stage = "decode";
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      this.stage = "json";
      return JSON.parse(raw);
    } catch (error) {
      this.caught(error);
      return null;
    } finally {
      if (reader) {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
  }
}
