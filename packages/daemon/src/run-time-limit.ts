import {
  RunTimeLimitRequest,
  type RunTimeLimitSnapshot,
  type TimeLimitMode,
} from "@claudexor/schema";

const MAX_MS = 604_800_000;
export function timeLimitProblem(
  message: string,
  code = "time_limit_conflict",
  status = 409,
): Error {
  return Object.assign(new Error(message), { code, status, retryable: false });
}

/** One stable cancellation signal per run; changing the clock never replaces a worker. */
export class RunTimeLimit {
  private readonly abort = new AbortController();
  readonly signal: AbortSignal = this.abort.signal;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private revision = 0;
  private mode: TimeLimitMode;
  private deadline: number | null = null;
  private reached: number | null = null;
  private closed = false;

  constructor(
    private readonly options: {
      seconds?: number;
      mode?: TimeLimitMode;
      onChange?: (
        action: "set" | "extend" | "disable" | "reached",
        state: RunTimeLimitSnapshot,
      ) => void;
    } = {},
  ) {
    this.mode = options.mode ?? (options.seconds === undefined ? "soft" : "hard");
    if (options.seconds !== undefined) {
      const value = RunTimeLimitRequest.parse({
        action: "set",
        seconds: options.seconds,
        mode: this.mode,
        expectedRevision: 0,
      });
      if (value.action === "set") this.deadline = Date.now() + value.seconds * 1000;
      this.arm();
    }
  }

  snapshot(): RunTimeLimitSnapshot {
    return {
      revision: this.revision,
      mode: this.mode,
      state: this.closed
        ? "closed"
        : this.deadline === null
          ? "disabled"
          : this.reached === null
            ? "armed"
            : "reached",
      deadlineAt: this.deadline === null ? null : new Date(this.deadline).toISOString(),
      reachedAt: this.reached === null ? null : new Date(this.reached).toISOString(),
    };
  }

  control(raw: unknown): RunTimeLimitSnapshot {
    const input = RunTimeLimitRequest.parse(raw);
    // A delayed event loop must not let a caller resurrect an expired hard limit.
    if (
      !this.closed &&
      this.deadline !== null &&
      this.reached === null &&
      Date.now() >= this.deadline
    )
      this.expire();
    if (input.action === "read") return this.snapshot();
    if (this.closed || this.signal.aborted)
      throw timeLimitProblem("The run timer is closed or hard-expired");
    if (input.expectedRevision !== this.revision)
      throw timeLimitProblem(
        `Timer revision changed (expected ${input.expectedRevision}, current ${this.revision}); read before retrying`,
        "time_limit_revision_conflict",
      );
    const now = Date.now();
    if (input.action === "disable") {
      this.deadline = null;
    } else {
      if (input.action === "extend" && this.deadline === null)
        throw timeLimitProblem("Cannot extend a disabled timer; use set", "time_limit_disabled");
      const next =
        input.action === "set"
          ? now + input.seconds * 1000
          : Math.max(now, this.deadline!) + input.seconds * 1000;
      if (next - now > MAX_MS)
        throw timeLimitProblem(
          "Timer must remain within seven days from now",
          "time_limit_invalid",
          400,
        );
      this.deadline = next;
      if (input.action === "set" && input.mode !== undefined) this.mode = input.mode;
    }
    this.reached = null;
    this.revision += 1;
    this.arm();
    this.emit(input.action);
    return this.snapshot();
  }

  dispose(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed || this.deadline === null) return;
    const revision = this.revision;
    this.timer = setTimeout(
      () => {
        if (!this.closed && this.revision === revision) this.expire();
      },
      Math.max(1, this.deadline - Date.now()),
    );
    this.timer.unref?.();
  }

  private expire(): void {
    if (this.closed || this.reached !== null) return;
    this.reached = Date.now();
    this.revision += 1;
    if (this.mode === "hard") this.abort.abort("wall_clock_exceeded");
    this.emit("reached");
  }

  private emit(action: "set" | "extend" | "disable" | "reached"): void {
    try {
      this.options.onChange?.(action, this.snapshot());
    } catch {
      /* Observers cannot cancel a soft run or suppress a hard deadline. */
    }
  }
}
