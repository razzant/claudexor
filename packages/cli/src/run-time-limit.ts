import { RunTimeLimit, type RunContext } from "@claudexor/daemon";
import { appendRunAuditEvent } from "@claudexor/control-api";
import type { RunTimeLimitSnapshot, TimeLimitMode } from "@claudexor/schema";

export function createRunTimeLimit(
  params: { maxSeconds?: number; timeLimitMode?: TimeLimitMode },
  ctx: RunContext,
) {
  let info: { runId: string; taskId: string; runDir: string } | undefined;
  let pending: { action: string; state: RunTimeLimitSnapshot } | undefined;
  const record = (action: string, state: RunTimeLimitSnapshot) => {
    if (!info) {
      pending = { action, state };
      return;
    }
    appendRunAuditEvent({ id: ctx.jobId, state: "running", ...info }, "control.applied", {
      control: { kind: "time_limit", action },
      timeLimit: state,
      message:
        action === "reached" && state.mode === "soft"
          ? "Soft time limit reached; work continues. The controller may extend, disable, or stop the run."
          : `Run time limit ${action} (${state.mode})`,
    });
  };
  const timer = new RunTimeLimit({
    seconds: params.maxSeconds,
    mode: params.timeLimitMode,
    onChange: record,
  });
  return {
    signal: AbortSignal.any([ctx.signal, timer.signal]),
    started(value: NonNullable<typeof info>) {
      info = value;
      ctx.registerTimeLimit?.(timer);
      if (pending) {
        record(pending.action, pending.state);
        pending = undefined;
      }
    },
    dispose() {
      timer.dispose();
    },
  };
}
